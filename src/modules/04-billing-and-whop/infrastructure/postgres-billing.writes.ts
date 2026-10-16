/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/postgres-billing.writes.ts
 * @modulo 04-billing-and-whop (Operaciones de Escritura de la Facturacion)
 * @proposito
 *   Agrupa las tres mutaciones del modulo de cobros: aplicar el nuevo periodo y saldos de una
 *   suscripcion, crear la suscripcion de forma idempotente y registrar el asiento inmutable del
 *   libro mayor. Se separan del repositorio de lectura para que cada archivo conserve una unica
 *   responsabilidad, y reciben el pool por inyeccion para que ninguna de las dos partes cree su
 *   propia conexion ni pueda saltarse el contexto RLS.
 *
 * @resumen_contenido
 *   - Clase `BillingWriteOperations`:
 *       * `applyPeriodUpdate()`: Actualiza periodo y saldos de la suscripcion.
 *       * `ensureSubscriptionExists()`: Alta idempotente de la suscripcion.
 *       * `appendImmutableLedgerEntry()`: Asiento inmutable del libro mayor.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`src/shared/infrastructure/database/rls-pool.ts`) inyectado por el repositorio.
 *   - Sentencias (`./billing-sql.statements.ts`) y puerto (`./billing-repository.port.ts`).
 *   - `NotFoundError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Cliente nativo, consumido a traves del pool con contexto RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (Bajo RLS activo y candado append-only).
 */

import { NotFoundError } from '../../../shared/kernel/result-and-errors';
import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { LedgerAppendInput, SubscriptionPeriodUpdate } from './billing-repository.port';
import { INSERT_LEDGER_ENTRY_SQL, INSERT_SUBSCRIPTION_SQL, UPDATE_SUBSCRIPTION_PERIOD_SQL } from './billing-sql.statements';

/**
 * Operaciones de escritura del repositorio de facturacion.
 * Todas las sentencias son parametrizadas y se ejecutan dentro de una transaccion con contexto RLS.
 */
export class BillingWriteOperations {
  private readonly pool: RlsDatabasePool;

  /**
   * @param pool - Pool de PostgreSQL con contexto RLS ya configurado.
   */
  public constructor(pool: RlsDatabasePool) {
    this.pool = pool;
  }

  /**
   * Aplica una actualizacion de periodo y saldos sobre la suscripcion, REUTILIZANDO la conexion que
   * ya posee el bloqueo pesimista. Escribir sobre otra conexion del pool quedaria esperando el mismo
   * candado que la primera transaccion retiene, produciendo un autobloqueo permanente.
   *
   * @param client - Conexion transaccional que ya posee el bloqueo `FOR UPDATE` de la suscripcion.
   * @param organizationId - Organizacion cuya suscripcion se actualiza.
   * @param update - Campos de periodo y saldos a persistir.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  public async applyPeriodUpdateOnLockedClient(
    client: PoolClient,
    organizationId: string,
    update: SubscriptionPeriodUpdate
  ): Promise<void> {
    const result = await client.query(UPDATE_SUBSCRIPTION_PERIOD_SQL, [
      organizationId,
      update.planCode,
      update.status,
      update.periodIncludedMinutesQuota,
      update.periodIncludedMinutesRemaining,
      update.periodOverageMinutesUsed,
      update.currentPeriodOverageBilledUsd,
      update.creditBalanceUsd,
      update.currentPeriodStartIso ?? null,
      update.currentPeriodEndIso ?? null,
      update.externalMembershipId ?? null,
      update.lastExternalEventId ?? null,
    ]);

    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
    }
  }

  /**
   * Registra el asiento inmutable del libro mayor REUTILIZANDO la conexion bloqueada.
   *
   * @param client - Conexion transaccional que ya posee el bloqueo de la suscripcion.
   * @param entry - Asiento a registrar.
   * @returns Identificador del asiento creado.
   */
  public async appendImmutableLedgerEntryOnLockedClient(
    client: PoolClient,
    entry: LedgerAppendInput
  ): Promise<{ readonly ledgerEntryId: string }> {
    const result = await client.query<{ id: string }>(INSERT_LEDGER_ENTRY_SQL, [
      entry.organizationId,
      entry.projectId ?? null,
      entry.voiceSessionId ?? null,
      entry.subscriptionId,
      entry.externalEventId,
      entry.externalPaymentId,
      entry.entryType,
      entry.minutesDelta,
      entry.unitRateUsd,
      entry.discountAppliedPercent,
      entry.amountUsdDelta,
      entry.includedMinutesBalanceAfter,
      entry.creditBalanceUsdAfter,
      JSON.stringify(entry.metadataJson),
    ]);

    const createdRow = result.rows[0];
    if (createdRow === undefined) {
      throw new Error('ASIENTO_NO_CONFIRMADO: PostgreSQL no devolvio el identificador del asiento contable insertado.');
    }
    return { ledgerEntryId: createdRow.id };
  }

  /**
   * Crea la suscripcion de una organizacion si aun no existe.
   * Un webhook de invalidacion puede llegar antes que el de activacion, por lo que siempre hay que
   * garantizar una fila sobre la que aplicar el bloqueo pesimista.
   *
   * @param organizationId - Organizacion propietaria.
   * @param update - Estado inicial con el que se crea la suscripcion.
   */
  public async ensureSubscriptionExists(organizationId: string, update: SubscriptionPeriodUpdate): Promise<void> {
    await this.pool.runInTenantTransaction({ organizationId }, async (client) => {
      await client.query(INSERT_SUBSCRIPTION_SQL, [
        organizationId,
        update.planCode,
        update.status,
        update.externalMembershipId ?? null,
        update.periodIncludedMinutesQuota,
        update.periodIncludedMinutesRemaining,
        update.periodOverageMinutesUsed,
        update.currentPeriodOverageBilledUsd,
        update.creditBalanceUsd,
        update.lastExternalEventId ?? null,
      ]);
    });
  }

  /**
   * Registra un asiento inmutable en el libro mayor contable.
   *
   * @param entry - Asiento a registrar.
   * @returns Identificador del asiento creado.
   * @throws Error cuando ya existe un asiento para el mismo evento externo, garantia impuesta por el
   *   indice unico de `external_whop_event_id`.
   */
  public async appendImmutableLedgerEntry(entry: LedgerAppendInput): Promise<{ readonly ledgerEntryId: string }> {
    return this.pool.runInTenantTransaction({ organizationId: entry.organizationId }, async (client) => {
      const result = await client.query<{ id: string }>(INSERT_LEDGER_ENTRY_SQL, [
        entry.organizationId,
        entry.subscriptionId,
        entry.externalEventId,
        entry.externalPaymentId,
        entry.entryType,
        entry.minutesDelta,
        entry.unitRateUsd,
        entry.discountAppliedPercent,
        entry.amountUsdDelta,
        entry.includedMinutesBalanceAfter,
        entry.creditBalanceUsdAfter,
        JSON.stringify(entry.metadataJson),
      ]);

      const createdRow = result.rows[0];
      if (createdRow === undefined) {
        throw new Error('ASIENTO_NO_CONFIRMADO: PostgreSQL no devolvio el identificador del asiento contable insertado.');
      }
      return { ledgerEntryId: createdRow.id };
    });
  }
}

