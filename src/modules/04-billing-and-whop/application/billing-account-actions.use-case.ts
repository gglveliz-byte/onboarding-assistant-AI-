/**
 * @archivo src/modules/04-billing-and-whop/application/billing-account-actions.use-case.ts
 * @modulo 04-billing-and-whop (Tope de Gasto y Portal de Autogestion del Cliente)
 * @proposito
 *   Expone las dos operaciones de cuenta que el frente de facturacion necesitaba y el backend no
 *   publicaba: fijar el tope de gasto duro del periodo y abrir el portal de autogestion de la pasarela.
 *
 *   El tope de gasto es la UNICA proteccion real contra un desbordamiento de consumo: el motor de
 *   deduccion corta la sesion cuando `current_period_overage_billed_usd` lo alcanza, de modo que un
 *   valor nulo en un plan de suscripcion admite deuda ilimitada. Sin endpoint, el cliente no podia
 *   ponerle coto a su propia factura.
 *
 *   El portal no se construye concatenando URLs: la pasarela no publica un endpoint propio de portal,
 *   el enlace legitimo es el campo `manage_url` de la membresia, unico por comprador y protegido por
 *   inicio de sesion. Por eso primero se lee la suscripcion, se toma su `whop_membership_id` y se
 *   consulta el estado remoto autoritativo.
 *
 * @resumen_contenido
 *   - Interface `SpendCapUpdateResult`: Tope aplicado y efecto sobre la operatividad.
 *   - Interface `CustomerPortalResult`: Enlace de autogestion y estado de la membresia.
 *   - Clase `BillingAccountActionsUseCase`:
 *       * `updateHardSpendCap()`: escritura transaccional del tope con RLS.
 *       * `openCustomerPortal()`: resuelve la membresia y devuelve su `manage_url`.
 *       * `reconcileSubscription()`: confronta el estado local contra la pasarela.
 *   - Fabrica `createBillingAccountActionsUseCase()`.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`src/shared/infrastructure/database/rls-pool.ts`).
 *   - `BillingRepositoryPort` y `WhopApiAndHmacAdapter` (infraestructura del modulo).
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`).
 *
 * @dependencias_externas
 *   - `@whop/sdk` a traves del adaptador inyectado.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` (UPDATE de `hard_spend_cap_usd` bajo RLS).
 */

import type { PoolClient } from 'pg';
import { DecimalMath, type Fixed6String } from '../../../shared/kernel/decimal.util';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { BillingRepositoryPort } from '../infrastructure/postgres-billing.repository';
import type { WhopApiAndHmacAdapter } from '../infrastructure/whop-api-and-hmac.adapter';

/** Tope de gasto duro maximo admisible, en USD. Cota de sentido comun contra un valor mal escrito. */
const MAX_SPEND_CAP_USD: Fixed6String = '1000000.000000';

/** Resultado de aplicar un tope de gasto. */
export interface SpendCapUpdateResult {
  /** Organizacion afectada. */
  readonly organizationId: string;
  /** Tope aplicado en USD, o `null` cuando se desactiva el limite. */
  readonly hardSpendCapUsd: Fixed6String | null;
  /** Importe ya facturado por exceso en el periodo vigente. */
  readonly currentPeriodOverageBilledUsd: Fixed6String;
  /** Indica si el tope aplicado ya esta siendo superado con el consumo acumulado. */
  readonly capAlreadyExceeded: boolean;
}

/** Resultado de solicitar el portal de autogestion. */
export interface CustomerPortalResult {
  /** Enlace de autogestion entregado por la pasarela. */
  readonly portalUrl: string;
  /** Identificador de la membresia en la pasarela. */
  readonly membershipId: string;
  /** Estado declarado por la pasarela para esa membresia. */
  readonly remoteStatus: string;
}

/** Resultado de la conciliacion entre el estado local y el de la pasarela. */
export interface ReconciliationResult {
  /** Organizacion conciliada. */
  readonly organizationId: string;
  /** Estado local de la suscripcion. */
  readonly localStatus: string;
  /** Estado declarado por la pasarela; `null` cuando no hay membresia que consultar. */
  readonly remoteStatus: string | null;
  /** `true` cuando ambos estados coinciden en otorgar o negar el acceso. */
  readonly consistent: boolean;
  /** Descripcion legible de la discrepancia encontrada. */
  readonly detail: string;
}

/**
 * Caso de uso de operaciones de cuenta: tope de gasto, portal y conciliacion.
 */
export class BillingAccountActionsUseCase {
  private readonly pool: RlsDatabasePool;
  private readonly repository: BillingRepositoryPort;
  private readonly gateway: WhopApiAndHmacAdapter;

  /**
   * @param pool - Pool con contexto RLS de inquilino.
   * @param repository - Repositorio de facturacion del modulo.
   * @param gateway - Adaptador de la pasarela para consultas autoritativas.
   */
  public constructor(pool: RlsDatabasePool, repository: BillingRepositoryPort, gateway: WhopApiAndHmacAdapter) {
    this.pool = pool;
    this.repository = repository;
    this.gateway = gateway;
  }

  /**
   * Fija o desactiva el tope de gasto duro del periodo de una organizacion.
   *
   * Un tope `null` desactiva el limite, y eso SOLO es admisible en pago por uso: en un plan de
   * suscripcion sin tope la deduccion admite deuda ilimitada durante el periodo.
   *
   * @param organizationId - Organizacion titular de la suscripcion.
   * @param userId - Usuario que opera, para el contexto RLS.
   * @param requestedCapUsd - Tope en USD, o `null` para desactivarlo.
   * @returns Tope aplicado y situacion del consumo acumulado.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion.
   * @throws ValidationError cuando el tope declarado es negativo o desmesurado.
   */
  public async updateHardSpendCap(
    organizationId: string,
    userId: string,
    requestedCapUsd: Fixed6String | null
  ): Promise<SpendCapUpdateResult> {
    if (requestedCapUsd !== null) {
      const normalized = DecimalMath.formatFixed6(requestedCapUsd, 'tope de gasto');
      if (DecimalMath.compareFixed6(normalized, '0.000000') < 0) {
        throw new ValidationError('El tope de gasto no puede ser negativo.');
      }
      if (DecimalMath.compareFixed6(normalized, MAX_SPEND_CAP_USD) > 0) {
        throw new ValidationError(`El tope de gasto no puede superar ${MAX_SPEND_CAP_USD} USD.`);
      }
      requestedCapUsd = normalized;
    }

    const subscription = await this.repository.findSubscription(organizationId);
    if (subscription === null) {
      throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
    }

    await this.pool.runInTenantTransaction({ organizationId, userId }, async (client: PoolClient) => {
      await client.query(
        `UPDATE whop_subscriptions SET hard_spend_cap_usd = $2, updated_at = NOW() WHERE organization_id = $1`,
        [organizationId, requestedCapUsd]
      );
    });

    return {
      organizationId,
      hardSpendCapUsd: requestedCapUsd,
      currentPeriodOverageBilledUsd: subscription.currentPeriodOverageBilledUsd,
      capAlreadyExceeded:
        requestedCapUsd !== null &&
        DecimalMath.compareFixed6(subscription.currentPeriodOverageBilledUsd, requestedCapUsd) >= 0,
    };
  }

  /**
   * Resuelve el enlace de autogestion que la pasarela asigna a la membresia de la organizacion.
   *
   * @param organizationId - Organidad titular.
   * @returns Portal de autogestion con el estado remoto de la membresia.
   * @throws NotFoundError cuando la organizacion no tiene membresia registrada en la pasarela.
   */
  public async openCustomerPortal(organizationId: string): Promise<CustomerPortalResult> {
    const subscription = await this.repository.findSubscription(organizationId);
    if (subscription === null || subscription.externalMembershipId === null) {
      throw new NotFoundError(
        `No existe membresia en la pasarela para la organizacion ${organizationId}. El portal aparece tras el primer pago confirmado.`
      );
    }

    const remoteStatus = await this.gateway.fetchMembershipStatus(subscription.externalMembershipId);
    if (remoteStatus.manageUrl === null || remoteStatus.manageUrl.length === 0) {
      throw new NotFoundError(`La pasarela no expone portal de gestion para la membresia ${subscription.externalMembershipId}.`);
    }

    return {
      portalUrl: remoteStatus.manageUrl,
      membershipId: remoteStatus.membershipId,
      remoteStatus: remoteStatus.status,
    };
  }

  /**
   * Confronta el estado local de una suscripcion con el autoritativo de la pasarela.
   *
   * Es la red de seguridad del webhook perdido: si una entrega no llego, el saldo local queda
   * desincronizado y nada lo avisa. Esta lectura lo detecta y lo reporta para accion manual o para el
   * job periodico de conciliacion.
   *
   * @param organizationId - Organizacion a conciliar.
   * @throws ForbiddenError cuando la organizacion no tiene suscripcion que conciliar.
   * @returns Diagnostico de conciliacion.
   */
  public async reconcileSubscription(organizationId: string): Promise<ReconciliationResult> {
    const subscription = await this.repository.findSubscription(organizationId);
    if (subscription === null) {
      throw new ForbiddenError(`La organizacion ${organizationId} no tiene suscripcion registrada.`);
    }

    if (subscription.externalMembershipId === null) {
      return {
        organizationId,
        localStatus: subscription.status,
        remoteStatus: null,
        consistent: subscription.status === 'PAST_DUE_OR_INVALID',
        detail: 'Sin membresia en la pasarela: no hay estado remoto con el que comparar.',
      };
    }

    const remote = await this.gateway.fetchMembershipStatus(subscription.externalMembershipId);
    const localGrantsAccess = subscription.status === 'ACTIVE' || subscription.status === 'TRIALING';
    const consistent = localGrantsAccess === remote.isValid;

    return {
      organizationId,
      localStatus: subscription.status,
      remoteStatus: remote.status,
      consistent,
      detail: consistent
        ? 'El estado local coincide con el de la pasarela.'
        : `Discrepancia: local concede acceso=${String(localGrantsAccess)} pero la pasarela declara "${remote.status}".`,
    };
  }
}

/**
 * Ensambla el caso de uso de operaciones de cuenta.
 *
 * @param pool - Pool con contexto RLS.
 * @param repository - Repositorio de facturacion.
 * @param gateway - Adaptador de la pasarela.
 * @returns Caso de uso listo para registrar.
 */
export function createBillingAccountActionsUseCase(
  pool: RlsDatabasePool,
  repository: BillingRepositoryPort,
  gateway: WhopApiAndHmacAdapter
): BillingAccountActionsUseCase {
  return new BillingAccountActionsUseCase(pool, repository, gateway);
}
