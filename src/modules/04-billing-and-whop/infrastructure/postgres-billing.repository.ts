/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository.ts
 * @modulo 04-billing-and-whop (Repositorio Transaccional de Facturacion con RLS y Bloqueo Pesimista)
 * @proposito
 *   Implementa el contrato de persistencia de la facturacion. Las lecturas, el bloqueo pesimista y
 *   la comprobacion de solvencia viven aqui; las tres mutaciones se delegan en
 *   `BillingWriteOperations`, que recibe el mismo pool con contexto RLS. `withLockedSubscription()`
 *   adquiere `SELECT ... FOR UPDATE` sobre la suscripcion: es la unica forma de impedir que dos
 *   webhooks concurrentes lean el mismo saldo y lo modifiquen dos veces.
 *
 * @resumen_contenido
 *   - Clase `PostgresBillingRepository`: implementacion de `BillingRepositoryPort`.
 *   - Funcion `createBillingRepositoryFromEnv()`: Construccion desde el contrato de entorno.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`src/shared/infrastructure/database/rls-pool.ts`) para RLS y `FOR UPDATE`.
 *   - Mapeadores (`./billing-row.mappers.ts`), sentencias (`./billing-sql.statements.ts`).
 *   - `BillingWriteOperations` (`./postgres-billing.writes.ts`) para las mutaciones.
 *   - `canSubscriptionStartNewSessions` (`../domain/billing-whop.entities.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Cliente nativo, consumido a traves del pool con contexto RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `pricing_plans_config` y
 *     `organization_pricing_overrides` (todas con politicas RLS activas).
 */

import { getEnvConfig } from '../../../config/env.schema';
import { DecimalMath } from '../../../shared/kernel/decimal.util';
import { NotFoundError } from '../../../shared/kernel/result-and-errors';
import { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import { canSubscriptionStartNewSessions } from '../domain/billing-whop.entities';
import type { PoolClient } from 'pg';
import type { BillingPlanCode, OrganizationPricingOverride, PricingPlanConfig, WhopSubscriptionState } from '../domain/billing-whop.types';
import {
  mapLedgerRow,
  mapOverrideRow,
  mapPlanRow,
  mapSubscriptionRow,
  type LedgerRow,
  type OverrideRow,
  type PeriodTotalsRow,
  type PlanRow,
  type SubscriptionRow,
} from './billing-row.mappers';
import type {
  BillingRepositoryPort,
  LedgerAppendInput,
  LedgerHistoryEntry,
  LedgerHistoryPage,
  LedgerPeriodTotals,
  SubscriptionPeriodUpdate,
} from './billing-repository.port';
import {
  SELECT_ACTIVE_OVERRIDE_SQL,
  SELECT_ACTIVE_PLANS_SQL,
  SELECT_LEDGER_EXPORT_SQL,
  SELECT_LEDGER_PAGE_SQL,
  SELECT_LEDGER_PERIOD_TOTALS_SQL,
  SELECT_SUBSCRIPTION_BY_MEMBERSHIP_SQL,
  SELECT_SUBSCRIPTION_SQL,
} from './billing-sql.statements';
import { BillingWriteOperations } from './postgres-billing.writes';

// El contrato y sus tipos se reexportan desde aqui para que los casos de uso tengan un unico punto
// de importacion del modulo de persistencia.
export type {
  BillingRepositoryPort,
  LedgerAppendInput,
  LedgerHistoryEntry,
  LedgerHistoryPage,
  LedgerPeriodTotals,
  SubscriptionPeriodUpdate,
} from './billing-repository.port';

/** Valor decimal de 6 cifras que representa la ausencia de movimiento. */
const ZERO_FIXED6 = '0.000000';

/** Numero maximo de asientos que puede devolver una pagina del historial contable. */
const MAX_LEDGER_PAGE_SIZE = 200;

/**
 * Repositorio transaccional de facturacion.
 * Toda mutacion de saldo se ejecuta dentro del bloqueo pesimista de la suscripcion.
 */
export class PostgresBillingRepository implements BillingRepositoryPort {
  private readonly pool: RlsDatabasePool;
  private readonly writes: BillingWriteOperations;

  /**
   * @param pool - Pool de PostgreSQL con contexto RLS ya configurado.
   */
  public constructor(pool: RlsDatabasePool) {
    this.pool = pool;
    this.writes = new BillingWriteOperations(pool);
  }

  /**
   * Recupera el catalogo completo de planes de precios.
   *
   * @param client - Conexion ya abierta por el llamador. Cuando llega, la lectura viaja por ella en
   *   lugar de tomar otra del pool mientras el llamador sigue reteniendo la suya.
   * @returns Planes vigentes indexados por codigo.
   */
  public async getPlanCatalog(client?: PoolClient): Promise<Readonly<Record<BillingPlanCode, PricingPlanConfig>>> {
    const leerPlanes = async (activo: PoolClient): Promise<PlanRow[]> => {
      const result = await activo.query<PlanRow>(SELECT_ACTIVE_PLANS_SQL);
      return result.rows;
    };
    const rows = client === undefined ? await this.pool.withClient(leerPlanes) : await leerPlanes(client);

    const catalog: Partial<Record<BillingPlanCode, PricingPlanConfig>> = {};
    for (const row of rows) {
      catalog[row.plan_code as BillingPlanCode] = mapPlanRow(row);
    }
    return Object.freeze(catalog) as Readonly<Record<BillingPlanCode, PricingPlanConfig>>;
  }

  /**
   * Recupera el override de precios vigente de una organizacion.
   *
   * @param organizationId - Organizacion consultada.
   * @param client - Conexion ya abierta por el llamador, cuando este retiene una transaccion.
   * @returns Override vigente, o `null` cuando no existe o esta fuera de vigencia.
   */
  public async getActivePricingOverride(organizationId: string, client?: PoolClient): Promise<OrganizationPricingOverride | null> {
    const leerOverride = async (activo: PoolClient): Promise<OrganizationPricingOverride | null> => {
      const result = await activo.query<OverrideRow>(SELECT_ACTIVE_OVERRIDE_SQL, [organizationId]);
      const row = result.rows[0];
      return row === undefined ? null : mapOverrideRow(row);
    };

    if (client !== undefined) {
      return leerOverride(client);
    }
    return this.pool.runInTenantTransaction({ organizationId }, leerOverride);
  }

  /**
   * Recupera la suscripcion de una organizacion sin adquirir bloqueo.
   *
   * @param organizationId - Organizacion consultada.
   * @param callerClient - Conexion ya abierta por el llamador, cuando este retiene una transaccion.
   *   Reutilizarla evita una segunda conexion del pool y conserva el contexto de inquilino ya fijado.
   * @returns Estado de la suscripcion, o `null` cuando no existe.
   */
  public async findSubscription(organizationId: string, callerClient?: PoolClient): Promise<WhopSubscriptionState | null> {
    const leerSuscripcion = async (client: PoolClient): Promise<WhopSubscriptionState | null> => {
      const result = await client.query<SubscriptionRow>(SELECT_SUBSCRIPTION_SQL, [organizationId]);
      const row = result.rows[0];
      return row === undefined ? null : mapSubscriptionRow(row);
    };

    if (callerClient !== undefined) {
      return leerSuscripcion(callerClient);
    }
    return this.pool.runInTenantTransaction({ organizationId }, leerSuscripcion);
  }

  /**
   * Bloquea la suscripcion con `SELECT ... FOR UPDATE` sobre la conexion del llamador.
   *
   * @param client - Conexion transaccional del llamador, con su contexto de inquilino ya fijado.
   * @param organizationId - Organizacion cuya suscripcion se bloquea.
   * @returns Estado bloqueado de la suscripcion.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  public async lockSubscriptionOnClient(client: PoolClient, organizationId: string): Promise<WhopSubscriptionState> {
    const result = await client.query<SubscriptionRow>(`${SELECT_SUBSCRIPTION_SQL} FOR UPDATE`, [organizationId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
    }
    return mapSubscriptionRow(row);
  }

  /**
   * Recupera la suscripcion por el identificador de membresia de la pasarela.
   * La busqueda usa privilegio de gobierno porque un webhook puede llegar antes de que exista
   * contexto de tenant resoluble para la organizacion.
   *
   * @param externalMembershipId - Identificador de la membresia.
   * @returns Estado de la suscripcion, o `null` cuando no existe.
   */
  public async findSubscriptionByMembershipId(externalMembershipId: string): Promise<WhopSubscriptionState | null> {
    return this.pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      try {
        const result = await client.query<SubscriptionRow>(SELECT_SUBSCRIPTION_BY_MEMBERSHIP_SQL, [externalMembershipId]);
        await client.query('COMMIT');
        const row = result.rows[0];
        return row === undefined ? null : mapSubscriptionRow(row);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Ejecuta una operacion bajo bloqueo pesimista exclusivo de la suscripcion.
   *
   * @param organizationId - Organizacion cuya suscripcion se bloquea.
   * @param work - Operacion que recibe el estado bloqueado y produce un resultado.
   * @returns Resultado producido por la operacion.
   */
  public async withLockedSubscription<T>(
    organizationId: string,
    work: (client: PoolClient, lockedSubscription: WhopSubscriptionState) => Promise<T>
  ): Promise<T> {
    return this.pool.runWithPessimisticOrgLock(organizationId, async (client, lockedRow) =>
      work(
        client,
        mapSubscriptionRow({
          id: lockedRow.id,
          organization_id: lockedRow.organization_id,
          plan_code: lockedRow.plan_code,
          status: lockedRow.status,
          whop_membership_id: lockedRow.whop_membership_id,
          current_period_start: lockedRow.current_period_start,
          current_period_end: lockedRow.current_period_end,
          period_included_minutes_quota: lockedRow.period_included_minutes_quota,
          period_included_minutes_remaining: lockedRow.period_included_minutes_remaining,
          period_overage_minutes_used: lockedRow.period_overage_minutes_used,
          current_period_overage_billed_usd: lockedRow.current_period_overage_billed_usd,
          credit_balance_usd: lockedRow.credit_balance_usd,
          hard_spend_cap_usd: lockedRow.hard_spend_cap_usd,
          auto_topup_enabled: lockedRow.auto_topup_enabled,
          last_whop_webhook_event_id: lockedRow.last_whop_webhook_event_id,
        })
      )
    );
  }

  /**
   * Aplica una actualizacion de periodo y saldos sobre la suscripcion.
   *
   * @param organizationId - Organizacion cuya suscripcion se actualiza.
   * @param update - Campos de periodo y saldos a persistir.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  public async applyPeriodUpdateOnLockedClient(client: PoolClient, organizationId: string, update: SubscriptionPeriodUpdate): Promise<void> {
    await this.writes.applyPeriodUpdateOnLockedClient(client, organizationId, update);
  }

  /**
   * Crea la suscripcion de una organizacion si aun no existe.
   *
   * @param organizationId - Organizacion propietaria.
   * @param update - Estado inicial con el que se crea la suscripcion.
   */
  public async ensureSubscriptionExists(organizationId: string, update: SubscriptionPeriodUpdate): Promise<void> {
    await this.writes.ensureSubscriptionExists(organizationId, update);
  }

  /**
   * Registra un asiento inmutable en el libro mayor contable.
   *
   * @param entry - Asiento a registrar.
   * @returns Identificador del asiento creado.
   * @throws Error cuando ya existe un asiento para el mismo evento externo.
   */
  public async appendImmutableLedgerEntryOnLockedClient(
    client: PoolClient,
    entry: LedgerAppendInput
  ): Promise<{ readonly ledgerEntryId: string }> {
    return this.writes.appendImmutableLedgerEntryOnLockedClient(client, entry);
  }

  /**
   * Comprueba si una organizacion puede iniciar nuevas sesiones de voz segun su suscripcion.
   *
   * @param organizationId - Organizacion consultada.
   * @returns `true` cuando puede iniciar sesiones; `false` cuando no existe suscripcion.
   */
  public async canOrganizationOperate(organizationId: string): Promise<boolean> {
    const subscription = await this.findSubscription(organizationId);
    return subscription === null ? false : canSubscriptionStartNewSessions(subscription);
  }

  /**
   * Recupera una pagina del historial contable de una organizacion.
   * La paginacion es por clave sobre `created_at`: un asiento nuevo durante la navegacion no
   * duplica ni omite filas, a diferencia de un desplazamiento numerico.
   *
   * @param organizationId - Organizacion consultada.
   * @param cursorIso - Marca temporal de continuacion; `null` para la primera pagina.
   * @param pageSize - Numero maximo de asientos a devolver.
   * @returns Pagina de asientos con su clave de continuacion.
   */
  public async readLedgerPage(organizationId: string, cursorIso: string | null, pageSize: number): Promise<LedgerHistoryPage> {
    const boundedPageSize = Math.min(Math.max(Math.trunc(pageSize), 1), MAX_LEDGER_PAGE_SIZE);
    return this.pool.runInTenantTransaction({ organizationId }, async (client) => {
      const result = await client.query<LedgerRow>(SELECT_LEDGER_PAGE_SQL, [organizationId, cursorIso, boundedPageSize]);
      const entries = result.rows.map(mapLedgerRow);
      const lastEntry = entries[entries.length - 1];
      return {
        entries,
        nextCursorIso: lastEntry === undefined ? null : lastEntry.createdAtIso,
        hasMore: entries.length === boundedPageSize,
      };
    });
  }

  /**
   * Consolida los minutos y dolares movidos en el periodo vigente.
   *
   * @param organizationId - Organizacion consultada.
   * @param periodStartIso - Inicio de la ventana del periodo, en formato ISO 8601.
   * @returns Totales del periodo.
   */
  public async readLedgerPeriodTotals(organizationId: string, periodStartIso: string): Promise<LedgerPeriodTotals> {
    return this.pool.runInTenantTransaction({ organizationId }, async (client) => {
      const result = await client.query<PeriodTotalsRow>(SELECT_LEDGER_PERIOD_TOTALS_SQL, [organizationId, periodStartIso]);
      const row = result.rows[0];
      return {
        totalMinutesDelta: DecimalMath.formatFixed6(row?.total_minutes_delta ?? ZERO_FIXED6, 'minutos del periodo'),
        totalAmountUsdDelta: DecimalMath.formatFixed6(row?.total_amount_usd_delta ?? ZERO_FIXED6, 'importe del periodo'),
        consumedMinutes: DecimalMath.formatFixed6(row?.consumed_minutes ?? ZERO_FIXED6, 'minutos consumidos'),
      };
    });
  }

  /**
   * Recupera todos los asientos de un rango temporal para la exportacion contable.
   *
   * @param organizationId - Organizacion consultada.
   * @param rangeStartIso - Inicio del rango, en formato ISO 8601.
   * @param rangeEndIso - Fin del rango, en formato ISO 8601.
   * @returns Asientos del rango ordenados cronologicamente.
   */
  public async exportLedgerEntries(
    organizationId: string,
    rangeStartIso: string,
    rangeEndIso: string
  ): Promise<readonly LedgerHistoryEntry[]> {
    return this.pool.runInTenantTransaction({ organizationId }, async (client) => {
      const result = await client.query<LedgerRow>(SELECT_LEDGER_EXPORT_SQL, [organizationId, rangeStartIso, rangeEndIso]);
      return result.rows.map(mapLedgerRow);
    });
  }
}

/**
 * Construye el repositorio de facturacion a partir del contrato de entorno ya validado.
 *
 * @param pool - Pool con contexto RLS; se construye uno nuevo cuando no se inyecta.
 * @returns Repositorio listo para los casos de uso de cobro.
 */
export function createBillingRepositoryFromEnv(pool?: RlsDatabasePool): PostgresBillingRepository {
  const environment = getEnvConfig();
  const resolvedPool = pool ?? new RlsDatabasePool({ connectionString: environment.DATABASE_URL, maxConnections: environment.DATABASE_POOL_MAX });
  return new PostgresBillingRepository(resolvedPool);
}


