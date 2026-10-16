/**
 * @archivo src/modules/04-billing-and-whop/billing-whop.port-adapter.ts
 * @modulo 04-billing-and-whop (Adaptador del Puerto de Facturacion para el Nucleo)
 * @proposito
 *   Implementa el puerto oficial `IBillingWhopPort` que consumen el gateway de voz (Modulo 05) y la
 *   consola de gobierno (Modulo 06). Concentra la unica ruta autorizada de deduccion de minutos y
 *   de consulta de solvencia, y traduce cualquier error interno al contrato de fallo normalizado del
 *   nucleo. Se mantiene separado del manifiesto porque el adaptador es consumido por otros modulos y
 *   debe poder importarse sin arrastrar el registro de rutas HTTP.
 *
 * @resumen_contenido
 *   - Clase `BillingWhopPortAdapter`: Implementa `IBillingWhopPort`.
 *   - Funcion `toPortFailure()`: Traduccion de errores al contrato del nucleo.
 *
 * @dependencias_internas
 *   - `IBillingWhopPort`, `SolvencySnapshot`, `BillingDeductionResult` y `PortFailure`
 *     (`src/shared/ports/billing-voice-admin.ports.ts` y `src/shared/ports/core-modules.ports.ts`).
 *   - `PostgresBillingRepository` (`./infrastructure/postgres-billing.repository.ts`).
 *   - Casos de uso de deduccion y de consultas del panel.
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (El acceso a datos ocurre a traves del repositorio y el pool inyectados).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (Bajo RLS y bloqueo pesimista).
 *   - PostgreSQL: `voice_sessions` (Lectura del proyecto propietario para la trazabilidad contable).
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '../../shared/infrastructure/database/rls-pool';
import { DecimalMath } from '../../shared/kernel/decimal.util';
import { toAppError, ValidationError } from '../../shared/kernel/result-and-errors';
import type { BillingDeductionResult, IBillingWhopPort, SolvencySnapshot } from '../../shared/ports/billing-voice-admin.ports';
import type { PortFailure } from '../../shared/ports/core-modules.ports';
import type { LedgerAppendInput } from './infrastructure/billing-repository.port';
import type { PostgresBillingRepository } from './infrastructure/postgres-billing.repository';
import type { BillingDashboardQueriesUseCase } from './application/billing-dashboard-queries.use-case';
import type { DeductSessionMinutesUseCase } from './application/deduct-session-minutes.use-case';
import { ZERO_FIXED6 } from './application/checkout-use-case.dependencies';

/** Tipo de asiento con el que se registra un otorgamiento de minutos desde la consola de gobierno. */
const PROMOTIONAL_LEDGER_ENTRY_TYPE = 'CREDIT_SUPERADMIN_GRANT';

/**
 * Adaptador oficial del puerto `IBillingWhopPort` del nucleo.
 * Toda deduccion pasa por aqui y se ejecuta dentro del bloqueo pesimista de la suscripcion.
 */
export class BillingWhopPortAdapter implements IBillingWhopPort {
  private readonly repository: PostgresBillingRepository;
  private readonly pool: RlsDatabasePool;
  private readonly deductUseCase: DeductSessionMinutesUseCase;
  private readonly dashboardQueries: BillingDashboardQueriesUseCase;

  /**
   * @param repository - Repositorio transaccional de facturacion.
   * @param pool - Pool con contexto RLS, usado para resolver la trazabilidad de la sesion de voz.
   * @param deductUseCase - Caso de uso de deduccion bajo bloqueo pesimista.
   * @param dashboardQueries - Caso de uso de consultas del panel de consumo.
   */
  public constructor(
    repository: PostgresBillingRepository,
    pool: RlsDatabasePool,
    deductUseCase: DeductSessionMinutesUseCase,
    dashboardQueries: BillingDashboardQueriesUseCase
  ) {
    this.repository = repository;
    this.pool = pool;
    this.deductUseCase = deductUseCase;
    this.dashboardQueries = dashboardQueries;
  }

  /**
   * Verifica si una organizacion puede iniciar o continuar una sesion de voz.
   *
   * @param organizationId - Organizacion evaluada.
   * @returns Instantanea de solvencia con la tarifa efectiva, o fallo normalizado.
   */
  public async checkOrganizationSolvency(
    organizationId: string
  ): Promise<{ readonly ok: true; readonly snapshot: SolvencySnapshot } | PortFailure> {
    try {
      const snapshot = await this.dashboardQueries.getConsumptionSnapshot(organizationId);
      return {
        ok: true,
        snapshot: {
          availableMinutes: snapshot.includedMinutesRemaining,
          creditBalanceUsd: snapshot.creditBalanceUsd,
          effectiveRatePerMinuteUsd: snapshot.effectiveRatePerMinuteUsd,
          planCode: snapshot.planCode,
          canStartSession: snapshot.canStartSession,
          blockedReason: snapshot.blockedReason,
        },
      };
    } catch (error) {
      return toPortFailure(error);
    }
  }

  /**
   * Deduce de forma atomica los segundos consumidos por una sesion de voz.
   *
   * @param organizationId - Organizacion que consume.
   * @param voiceSessionId - Sesion de voz que reporta el consumo.
   * @param elapsedSeconds - Segundos transcurridos desde el ultimo pulso de facturacion.
   * @returns Desglose de la deduccion con la bandera de corte, o fallo normalizado.
   */
  public async deductVoiceSessionSlice(
    organizationId: string,
    voiceSessionId: string,
    elapsedSeconds: number,
    callerClient?: PoolClient
  ): Promise<{ readonly ok: true; readonly deduction: BillingDeductionResult } | PortFailure> {
    try {
      // La suscripcion se lee SOBRE LA CONEXION DEL LLAMADOR cuando existe: abrir una propia aqui
      // tomaba una segunda conexion del pool mientras el llamador retenia la primera, que es
      // exactamente el anidamiento que agota el pool con unas pocas sesiones concurrentes.
      const subscription = await this.repository.findSubscription(organizationId, callerClient);
      if (subscription === null) {
        return {
          ok: false,
          code: 'RESOURCE_NOT_FOUND',
          reason: 'La organizacion no tiene suscripcion registrada.',
          retryable: false,
        };
      }

      const result = await this.deductUseCase.execute({
        organizationId,
        // El proyecto se resuelve **con la conexion del llamador** cuando esta disponible. Abrir una
        // conexion propia aqui tomaba una segunda del pool mientras el llamador retenia la primera
        // dentro de su transaccion: con el maximo configurado, unas pocas sesiones concurrentes agotan
        // el pool y la peticion espera hasta el limite de conexion. Es la misma clase de defecto que ya
        // provoco un auto-bloqueo de cinco minutos en este proyecto.
        projectId: await this.resolveProjectId(voiceSessionId, callerClient),
        voiceSessionId,
        elapsedSeconds,
        // La deduccion viaja dentro de la transaccion del llamador y adquiere el bloqueo pesimista
        // sobre esa misma conexion (con su contexto de inquilino ya fijado), en lugar de abrir una
        // tercera conexion mientras las otras siguen retenidas. Sin llamador, la deduccion abre su
        // propia transaccion bloqueada como siempre.
        ...(callerClient === undefined
          ? {}
          : { lockedClient: callerClient, lockedSubscription: subscription }),
      });

      return {
        ok: true,
        deduction: {
          coveredMinutes: result.coveredMinutes,
          overageMinutes: result.overageMinutes,
          overageCostUsd: result.overageCostUsd,
          remainingIncludedMinutes: result.remainingIncludedMinutes,
          remainingCreditUsd: result.remainingCreditUsd,
          shouldTerminateSession: result.shouldTerminateSession,
          ledgerEntryId: result.ledgerEntryId,
        },
      };
    } catch (error) {
      return toPortFailure(error);
    }
  }

  /**
   * Otorga minutos promocionales o de compensacion, registrando el asiento correspondiente.
   * El otorgamiento se aplica bajo el mismo bloqueo pesimista que un consumo, de modo que no pueda
   * competir con una deduccion concurrente y perderse.
   *
   * @param organizationId - Organizacion beneficiada.
   * @param minutesToGrant - Minutos a otorgar, en formato decimal fijo de 6 decimales.
   * @param reason - Motivo del otorgamiento, obligatorio para la auditoria.
   * @param grantedBySuperAdminId - Operador de gobierno que autoriza la entrega.
   * @returns Saldo resultante, o fallo normalizado.
   */
  public async grantPromotionalMinutes(
    organizationId: string,
    minutesToGrant: string,
    reason: string,
    grantedBySuperAdminId: string
  ): Promise<{ readonly ok: true; readonly remainingIncludedMinutes: string; readonly ledgerEntryId: string } | PortFailure> {
    if (reason.trim().length === 0) {
      return {
        ok: false,
        code: 'RESOURCE_NOT_FOUND',
        reason: 'El motivo del otorgamiento es obligatorio para la auditoria.',
        retryable: false,
      };
    }

    try {
      return await this.repository.withLockedSubscription(organizationId, async (client, lockedSubscription) => {
        const grantedMinutes = normalizeGrantedMinutes(minutesToGrant);
        const newBalance = DecimalMath.sumFixed6([lockedSubscription.periodIncludedMinutesRemaining, grantedMinutes]);

        await this.repository.applyPeriodUpdateOnLockedClient(client, organizationId, {
          planCode: lockedSubscription.planCode,
          status: lockedSubscription.status,
          periodIncludedMinutesQuota: lockedSubscription.periodIncludedMinutesQuota,
          periodIncludedMinutesRemaining: newBalance,
          periodOverageMinutesUsed: lockedSubscription.periodOverageMinutesUsed,
          currentPeriodOverageBilledUsd: lockedSubscription.currentPeriodOverageBilledUsd,
          creditBalanceUsd: lockedSubscription.creditBalanceUsd,
        });

        const entry: LedgerAppendInput = {
          organizationId,
          subscriptionId: lockedSubscription.subscriptionId,
          externalEventId: null,
          externalPaymentId: null,
          entryType: PROMOTIONAL_LEDGER_ENTRY_TYPE,
          minutesDelta: grantedMinutes,
          unitRateUsd: ZERO_FIXED6,
          discountAppliedPercent: ZERO_FIXED6,
          amountUsdDelta: ZERO_FIXED6,
          includedMinutesBalanceAfter: newBalance,
          creditBalanceUsdAfter: lockedSubscription.creditBalanceUsd,
          metadataJson: { reason, grantedBySuperAdminId },
        };
        const created = await this.repository.appendImmutableLedgerEntryOnLockedClient(client, entry);

        return { ok: true as const, remainingIncludedMinutes: newBalance, ledgerEntryId: created.ledgerEntryId };
      });
    } catch (error) {
      return toPortFailure(error);
    }
  }

  /**
   * Resuelve el proyecto propietario de una sesion de voz, para la trazabilidad del asiento.
   * Una sesion inexistente no impide el cobro: el consumo ya ocurrio y renunciar a facturarlo seria
   * una perdida real, por lo que el asiento se registra con proyecto vacio.
   *
   * `voice_sessions` tiene aislamiento por organizacion, de modo que la lectura **exige** el contexto
   * de inquilino que el llamador ya fijo: sin el, la consulta devolveria cero filas.
   *
   * @param voiceSessionId - Identificador de la sesion de voz.
   * @param callerClient - Conexion del llamador, cuando ya tiene una abierta. Reutilizarla evita tomar
   *   una segunda conexion del pool mientras la primera sigue retenida, y ademas **conserva el contexto
   *   de inquilino** que el llamador ya fijo.
   * @returns Identificador del proyecto, o cadena vacia cuando no se puede resolver.
   */
  private async resolveProjectId(voiceSessionId: string, callerClient?: PoolClient): Promise<string> {
    const consultar = async (client: PoolClient): Promise<string> => {
      const result = await client.query<{ project_id: string }>(
        `SELECT project_id FROM voice_sessions WHERE id = $1 LIMIT 1`,
        [voiceSessionId]
      );
      return result.rows[0]?.project_id ?? '';
    };

    if (callerClient !== undefined) {
      return consultar(callerClient);
    }
    return this.pool.withClient(consultar);
  }
}

/**
 * Valida y normaliza los minutos a otorgar.
 *
 * @param minutesToGrant - Minutos declarados por el operador.
 * @returns Minutos normalizados a 6 decimales.
 * @throws ValidationError cuando el valor esta vacio, no es decimal o no es positivo.
 */
function normalizeGrantedMinutes(minutesToGrant: string): string {
  const trimmed = minutesToGrant.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Los minutos a otorgar son obligatorios.');
  }
  if (trimmed.startsWith('-')) {
    throw new ValidationError('El otorgamiento de minutos debe ser una cantidad positiva.');
  }
  return DecimalMath.formatFixed6(trimmed, 'minutos otorgados');
}

/**
 * Traduce cualquier error capturado al contrato de fallo normalizado del nucleo.
 * La distincion es deliberada: un recurso inexistente o una entrada invalida no son reintentables,
 * mientras que un fallo de persistencia si lo es porque la operacion no llego a comprometerse.
 *
 * @param error - Error capturado durante la operacion.
 * @returns Fallo normalizado listo para el consumidor del puerto.
 */
export function toPortFailure(error: unknown): PortFailure {
  const appError = toAppError(error);
  const isResourceMissing = appError.code === 'NOT_FOUND';
  const isClientFault =
    appError.code === 'VALIDATION_FAILED' ||
    appError.code === 'UNAUTHORIZED' ||
    appError.code === 'FORBIDDEN' ||
    appError.code === 'INSUFFICIENT_FUNDS' ||
    appError.code === 'DPA_NOT_SIGNED';

  // El codigo del nucleo es deliberadamente generico para no revelar a un tercero si un recurso
  // existe o si la organizacion simplemente no tiene fondos.
  const code = isResourceMissing || isClientFault ? 'RESOURCE_NOT_FOUND' : 'PERSISTENCE_UNAVAILABLE';
  const reason = isResourceMissing || isClientFault
    ? appError.message
    : `No se pudo completar la operacion de cobro: ${appError.message}`;

  return { ok: false, code, reason, retryable: !isResourceMissing && !isClientFault };
}



