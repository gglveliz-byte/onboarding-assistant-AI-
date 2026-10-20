/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/whop-reconciliation.sweeper.ts
 * @modulo 04-billing-and-whop (Barrendero de Conciliacion de Suscripciones con la Pasarela)
 * @proposito
 *   El cobro de esta plataforma depende de que el webhook llegue. Si la pasarela no entrega un evento
 *   —porque el endpoint estaba caido, porque el rewrite del frente devolvia 404, o porque la cuenta
 *   cambio de estado mientras el servicio reiniciaba—, la suscripcion local queda desincronizada y
 *   NADA lo avisa: la organizacion puede seguir consumiendo minutos que ya no tiene pagados, o quedar
 *   cortada con saldo vigente a favor.
 *
 *   Este barrendero cierra ese agujero. Periódicamente toma las suscripciones que tienen membresia en
 *   la pasarela y confronta el estado local contra `GET /api/v1/memberships/{id}`, que es la fuente
 *   autoritativa. No corrige el saldo por su cuenta: reporta la discrepancia por el logger estructurado
 *   para que el gobierno de la plataforma actue con criterio, porque reconciliar un cobro sin revision
 *   humana es tan peligroso como perderse el webhook.
 *
 *   El temporizador se marca `unref()` para que la conciliacion nunca impida que el proceso cierre.
 *
 * @resumen_contenido
 *   - Constante `DEFAULT_RECONCILIATION_INTERVAL_MS` y limite de filas por barrido.
 *   - Interface `ReconciliationDiscrepancy`: Discrepancia detectada, apta para log y alerta.
 *   - Interface `ReconciliationSweeper`: Superficie publica (`start`, `stop`, `sweepOnce`).
 *   - Funcion `createWhopReconciliationSweeper()`: Ensamblado sobre el pool y el repositorio.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`src/shared/infrastructure/database/rls-pool.ts`).
 *   - `WhopApiAndHmacAdapter` (`./whop-api-and-hmac.adapter.ts`).
 *
 * @dependencias_externas
 *   - Ninguna ademas del temporizador del runtime.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` (lectura de estado local bajo privilegio de gobierno).
 */

import type { Logger } from 'pino';
import { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import { DEFAULT_KEY_PREFIX, REDIS_KEY_SEPARATOR } from '../../../shared/infrastructure/redis/redis-key-namespaces';
import type { WhopApiAndHmacAdapter } from './whop-api-and-hmac.adapter';

/** Cadencia por omision del barrido: cada 15 minutos. */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 900_000;

/** Maximo de suscripciones conciliadas por barrido, para no abrir una tormenta de llamadas. */
const MAX_SUBSCRIPTIONS_PER_SWEEP = 50;

/** Estados locales que conceden acceso vigente. */
const LOCAL_ACTIVE_STATUSES: readonly string[] = ['ACTIVE', 'TRIALING'];

/** Una discrepancia detectada entre el estado local y el de la pasarela. */
export interface ReconciliationDiscrepancy {
  /** Organizacion afectada. */
  readonly organizationId: string;
  /** Membresia consultada en la pasarela. */
  readonly membershipId: string;
  /** Estado guardado localmente. */
  readonly localStatus: string;
  /** Estado declarado por la pasarela. */
  readonly remoteStatus: string;
  /** `true` cuando la pasarela concede acceso que local esta cortado, o a la inversa. */
  readonly grantsAccessMismatch: boolean;
}

/** Superficie publica del barrendero de conciliacion. */
export interface ReconciliationSweeper {
  /** Arma el temporizador periodico. */
  start(): void;
  /** Detiene el temporizador. */
  stop(): void;
  /** Ejecuta un barrido completo sin candado, para diagnostico manual o pruebas. */
  sweepOnce(): Promise<readonly ReconciliationDiscrepancy[]>;
  /** Ejecuta un barrido respetando el candado de lider. Es el que usa la cadencia periodica. */
  sweepGuarded(): Promise<readonly ReconciliationDiscrepancy[]>;
}

/**
 * Construye el barrendero de conciliacion.
 *
 * @param pool - Pool de base de datos del plano de control.
 * @param gateway - Adaptador de la pasarela, fuente del estado autoritativo.
 * @param logger - Logger estructurado donde se reportan las discrepancias.
 * @param redisClient - Cliente Redis para el candado de lider entre Node Pools.
 * @param instanceId - Identificador del proceso que sostiene el candado.
 * @param intervalMs - Cadencia del barrido periodico.
 * @returns Barrendero listo para arrancar con el plano de control.
 */
export function createWhopReconciliationSweeper(
  pool: RlsDatabasePool,
  gateway: WhopApiAndHmacAdapter,
  logger: Logger,
  redisClient: RedisClusterClient,
  instanceId: string,
  intervalMs: number = DEFAULT_RECONCILIATION_INTERVAL_MS
): ReconciliationSweeper {
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Ventana del candado: la cadencia menos un minuto. Suficiente para cubrir la ronda completa y lo
   * bastante corta para que la siguiente ronda vuelva a ser disputable.
   */
  const LEADER_LOCK_TTL_SECONDS = Math.max(60, Math.floor(intervalMs / 1000) - 60);

  /** Lee las suscripciones que tienen membresia registrada en la pasarela. */
  async function readCandidates(): Promise<readonly { organizationId: string; membershipId: string; status: string }[]> {
    return pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      try {
        const result = await client.query<{ organization_id: string; whop_membership_id: string; status: string }>(
          `SELECT organization_id, whop_membership_id, status
             FROM whop_subscriptions
            WHERE whop_membership_id IS NOT NULL
            ORDER BY updated_at ASC
            LIMIT $1`,
          [MAX_SUBSCRIPTIONS_PER_SWEEP]
        );
        await client.query('COMMIT');
        return result.rows.map((row) => ({
          organizationId: row.organization_id,
          membershipId: row.whop_membership_id,
          status: row.status,
        }));
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  /** Concilia una suscripcion contra el estado autoritativo de la pasarela. */
  async function sweepOnce(): Promise<readonly ReconciliationDiscrepancy[]> {
    const candidates = await readCandidates();
    const discrepancies: ReconciliationDiscrepancy[] = [];

    for (const candidate of candidates) {
      try {
        const remote = await gateway.fetchMembershipStatus(candidate.membershipId);
        const localGrantsAccess = LOCAL_ACTIVE_STATUSES.includes(candidate.status);
        if (localGrantsAccess !== remote.isValid) {
          const discrepancy: ReconciliationDiscrepancy = {
            organizationId: candidate.organizationId,
            membershipId: candidate.membershipId,
            localStatus: candidate.status,
            remoteStatus: remote.status,
            grantsAccessMismatch: true,
          };
          discrepancies.push(discrepancy);
          logger.warn(
            { orgId: candidate.organizationId, membershipId: candidate.membershipId, local: candidate.status, remote: remote.status },
            'CONCILICION_WHOP: el estado local de la suscripcion no coincide con el de la pasarela.'
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Una 404 NO es un fallo transitorio: la pasarela no conoce esa membresia, normalmente porque
        // el identificador viene de una prueba antigua. Confundirla con "la pasarela no responde"
        // oculta deriva real debajo de ruido reintentable y viceversa.
        const isUnknownMembership = /\b404\b|not_found|Membership not found/iu.test(reason);
        if (isUnknownMembership) {
          discrepancies.push({
            organizationId: candidate.organizationId,
            membershipId: candidate.membershipId,
            localStatus: candidate.status,
            remoteStatus: 'not_found',
            grantsAccessMismatch: true,
          });
          logger.warn(
            { orgId: candidate.organizationId, membershipId: candidate.membershipId, local: candidate.status },
            'CONCILICION_WHOP: la suscripcion local apunta a una membresia que no existe en la pasarela.'
          );
        } else {
          // Un fallo de red en una consulta no aborta el barrido ni debe cortarle el servicio a nadie.
          logger.warn(
            { orgId: candidate.organizationId, membershipId: candidate.membershipId, reason },
            'CONCILICION_WHOP: no se pudo consultar la pasarela para esta suscripcion.'
          );
        }
      }
    }

    return discrepancies;
  }

/**
 * Ejecuta un barrido protegido por candado de lider en Redis.
 *
 * Los 3 Node Pools ensamblan el mismo monolito y por tanto registran el mismo manifiesto: sin candado,
 * el API y el gateway de voz barrierian duplicando cada 15 minutos las lecturas a la pasarela. El
 * candado se toma con `SET NX EX` por una ventana apenas menor a la cadencia, de forma que el proceso
 * que gana la ronda trabaja y el que la pierde salta esa vuelta; como los temporizadores de ambos
 * arranques caen casi simultaneos, la ventana cubre la ronda completa y el barrido queda unico.
 *
 * No se libera la clave al terminar a proposito: liberarla dejaria via libre al otro pool para barrer
 * en la misma ronda, que es justamente lo que se evita. La clave caduca sola.
 *
 * @returns Las discrepancias encontradas, o `[]` cuando otro proceso es el lider de la ronda.
 */
async function sweepGuarded(): Promise<readonly ReconciliationDiscrepancy[]> {
  const leaderKey = `${DEFAULT_KEY_PREFIX}${REDIS_KEY_SEPARATOR}billing${REDIS_KEY_SEPARATOR}reconcile${REDIS_KEY_SEPARATOR}leader`;
  const held = await redisClient.keys.setIfAbsent(leaderKey, instanceId, LEADER_LOCK_TTL_SECONDS);
  if (!held) {
    logger.debug({ leaderKey }, 'CONCILICION_WHOP: otro pool es el lider de esta ronda; se omite el barrido.');
    return [];
  }
  return sweepOnce();
}

  return {
    start(): void {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        sweepGuarded().catch((error) => {
          logger.error(
            { reason: error instanceof Error ? error.message : String(error) },
            'CONCILICION_WHOP: el barrido periodico fallo.'
          );
        });
      }, intervalMs);

      // El temporizador no debe sostener el proceso por si solo: el cierre elegante queda asi limpio.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
      logger.info({ intervalMs, maxPerSweep: MAX_SUBSCRIPTIONS_PER_SWEEP }, 'CONCILICION_WHOP: barrendero armado.');
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    sweepOnce,
    sweepGuarded,
  };
}
