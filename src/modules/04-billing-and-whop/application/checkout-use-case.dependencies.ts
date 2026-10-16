/**
 * @archivo src/modules/04-billing-and-whop/application/checkout-use-case.dependencies.ts
 * @modulo 04-billing-and-whop (Contrato Compartido de Dependencias de los Casos de Uso de Cobro)
 * @proposito
 *   Declara las dependencias que comparten los dos casos de uso del modulo: la pasarela firmada, el
 *   repositorio con bloqueo pesimista, el cliente Redis para la idempotencia y el verificador del
 *   acuerdo de procesamiento de datos. Se a isla en su propio archivo para que ambos casos de uso lo
 *   importen sin crear una dependencia circular entre ellos.
 *
 * @resumen_contenido
 *   - Constantes `WEBHOOK_IDEMPOTENCY_TTL_SECONDS`, `CHECKOUT_LINK_TTL_SECONDS` y `ZERO_FIXED6`.
 *   - Interface `DpaVerifierPort`: Verificacion del acuerdo de procesamiento de datos.
 *   - Interface `CheckoutUseCaseDependencies`: Dependencias compartidas por los dos casos de uso.
 *
 * @dependencias_internas
 *   - `WhopApiAndHmacAdapter` (`../infrastructure/whop-api-and-hmac.adapter.ts`).
 *   - `BillingRepositoryPort` (`../infrastructure/postgres-billing.repository.ts`).
 *   - `RedisClusterClient` (`src/shared/infrastructure/redis/redis-cluster.client.ts`).
 *   - `Fixed6String` (`src/shared/kernel/decimal.util.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Contrato puro de inyeccion de dependencias).
 *
 * @tablas_bd_o_redis
 *   - Redis: `whop:webhook:evt:<id>` (Marca de idempotencia con la vigencia declarada aqui).
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (Acceso a traves del repositorio).
 */

import type { Fixed6String } from '../../../shared/kernel/decimal.util';
import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import type { BillingRepositoryPort } from '../infrastructure/postgres-billing.repository';
import type { WhopApiAndHmacAdapter } from '../infrastructure/whop-api-and-hmac.adapter';

/** Vigencia de la marca de idempotencia de un webhook, en segundos (48 horas). */
export const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 172800;

/** Vigencia del enlace de pago firmado, en segundos (15 minutos). */
export const CHECKOUT_LINK_TTL_SECONDS = 900;

/** Valor decimal de 6 cifras que representa la ausencia de movimiento. */
export const ZERO_FIXED6: Fixed6String = '0.000000';

/** Verificador del acuerdo de procesamiento de datos de una organizacion. */
export interface DpaVerifierPort {
  /**
   * Comprueba que la organizacion tenga firmado el acuerdo vigente.
   *
   * @param organizationId - Organizacion a verificar.
   * @returns Resultado de la verificacion con la fecha de firma o el motivo del rechazo.
   */
  isDpaSigned(
    organizationId: string
  ): Promise<{ readonly signed: true; readonly signedAtIso: string } | { readonly signed: false; readonly reason: string }>;
}

/** Dependencias compartidas por los casos de uso del modulo de cobros. */
export interface CheckoutUseCaseDependencies {
  /** Adaptador de la pasarela: firma de metadatos y verificacion de webhooks. */
  readonly gateway: WhopApiAndHmacAdapter;
  /** Repositorio transaccional con bloqueo pesimista. */
  readonly billingRepository: BillingRepositoryPort;
  /** Cliente Redis para la idempotencia de eventos. */
  readonly redisClient: RedisClusterClient;
  /** Verificador del acuerdo de procesamiento de datos de la organizacion. */
  readonly dpaVerifier: DpaVerifierPort;
}
