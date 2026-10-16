/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store.ts
 * @modulo 05-voice-realtime-gateway (Persistencia de los Totales Facturados de una Sesion de Voz)
 * @proposito
 *   Escribe en `voice_sessions` los tres unicos campos que el servicio de facturacion posee:
 *   `duration_seconds`, `billed_minutes` y `total_billed_cost_usd`. Se aisla en su propio almacen
 *   en lugar de extender el repositorio general de sesiones para que la responsabilidad quede
 *   separada —la facturacion no debe poder modificar el estado ni el motivo de terminacion de una
 *   sesion— y para que cada escritura sea una sentencia unica y auditable. Todas las consultas son
 *   parametrizadas y exigen la conexion transaccional con contexto RLS.
 *
 * @resumen_contenido
 *   - Constante `UPDATE_SESSION_METERING_SQL`.
 *   - Interface `SessionMeteringTotals`.
 *   - Clase `VoiceSessionMeteringStore`: `persistTotals()` y `readTotals()`.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`src/shared/infrastructure/database/rls-pool.ts`) para las lecturas.
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion transaccional con RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions` (Columnas de duracion y facturacion, bajo RLS activo).
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';

/**
 * Actualizacion de los totales facturados de una sesion.
 * `duration_seconds` se actualiza con `GREATEST` para que un pulso que llegue fuera de orden no
 * reduzca la duracion ya registrada: la duracion de una sesion solo puede crecer.
 */
export const UPDATE_SESSION_METERING_SQL = `UPDATE voice_sessions
      SET duration_seconds = GREATEST(COALESCE(duration_seconds, 0), $2::numeric),
          billed_minutes = $3::numeric,
          total_billed_cost_usd = $4::numeric
    WHERE id = $1`;

/** Consulta de los totales facturados ya persistidos de una sesion. */
export const SELECT_SESSION_METERING_SQL = `SELECT duration_seconds, billed_minutes, total_billed_cost_usd
    FROM voice_sessions
   WHERE id = $1`;

/** Totales facturados de una sesion de voz. */
export interface SessionMeteringTotals {
  /** Segundos totales de conversacion registrados. */
  readonly durationSeconds: number;
  /** Minutos facturados acumulados, en formato decimal de 6 cifras. */
  readonly billedMinutes: string;
  /** Importe facturado acumulado, en USD con 6 decimales. */
  readonly totalBilledUsd: string;
}

/** Fila cruda de los totales de facturacion. */
interface SessionMeteringRow {
  readonly duration_seconds: string | number | null;
  readonly billed_minutes: string | null;
  readonly total_billed_cost_usd: string | null;
}

/**
 * Almacen especializado en los totales facturados de una sesion de voz.
 * No puede modificar el estado ni el motivo de terminacion: su superficie de escritura es minima a
 * proposito, porque el servicio de facturacion no debe poder cerrar una sesion por si mismo.
 */
export class VoiceSessionMeteringStore {
  private readonly pool: RlsDatabasePool;

  /**
   * @param pool - Pool con contexto RLS, usado unicamente para las lecturas.
   */
  public constructor(pool: RlsDatabasePool) {
    this.pool = pool;
  }

  /**
   * Persiste los totales facturados de una sesion sobre la conexion transaccional recibida.
   *
   * @param client - Conexion transaccional que ya posee el contexto del tenant.
   * @param voiceSessionId - Sesion cuyos totales se actualizan.
   * @param durationSeconds - Segundos totales de conversacion.
   * @param billedMinutes - Minutos facturados acumulados.
   * @param totalBilledUsd - Importe facturado acumulado.
   * @throws Error cuando la sesion no existe, porque un total sin sesion es un dato huerfano.
   */
  public async persistTotals(
    client: PoolClient,
    voiceSessionId: string,
    durationSeconds: number,
    billedMinutes: string,
    totalBilledUsd: string
  ): Promise<void> {
    const result = await client.query(UPDATE_SESSION_METERING_SQL, [
      voiceSessionId,
      Math.max(0, Math.floor(durationSeconds)),
      billedMinutes,
      totalBilledUsd,
    ]);

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`No existe la sesion de voz ${voiceSessionId} sobre la que persistir los totales facturados.`);
    }
  }

  /**
   * Lee los totales facturados ya persistidos de una sesion.
   *
   * @param organizationId - Organizacion propietaria, que acota el contexto RLS.
   * @param voiceSessionId - Sesion consultada.
   * @returns Totales persistidos, o `null` cuando la sesion no existe.
   */
  public async readTotals(organizationId: string, voiceSessionId: string): Promise<SessionMeteringTotals | null> {
    return this.pool.runInTenantTransaction({ organizationId }, async (client) => {
      const result = await client.query<SessionMeteringRow>(SELECT_SESSION_METERING_SQL, [voiceSessionId]);
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        durationSeconds: Number(row.duration_seconds ?? 0),
        billedMinutes: String(row.billed_minutes ?? '0.000000'),
        totalBilledUsd: String(row.total_billed_cost_usd ?? '0.000000'),
      };
    });
  }
}

/**
 * Ensambla el almacen de totales facturados de sesiones de voz.
 *
 * @param pool - Pool con contexto RLS.
 * @returns Almacen listo para el servicio de facturacion.
 */
export function createVoiceSessionMeteringStore(pool: RlsDatabasePool): VoiceSessionMeteringStore {
  return new VoiceSessionMeteringStore(pool);
}
