/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository.ts
 * @modulo 05-voice-realtime-gateway (Persistencia PostgreSQL RLS y Sincronizacion en Redis de Sesiones de Voz)
 * @proposito
 *   Gestiona el ciclo de vida persistente de las sesiones de voz en tiempo real y la telemetria
 *   de las herramientas ejecutadas en el DOM (`click_element`, `type_text`). Opera bajo
 *   transacciones seguras con Row-Level Security (RLS) y sincroniza el estado en vivo en Redis.
 *   Los estados que puede escribir NO se enumeran aqui: se derivan del tipo enumerado de PostgreSQL
 *   en `voice-session-row-mapping.ts`, porque enumerarlos a mano fue la causa del defecto C1-27
 *   -el repositorio aceptaba cuatro estados de resultado de accion mientras la base tiene seis-.
 *
 * @resumen_contenido
 *   - Clase `PostgresVoiceSessionRepository`: alta, lectura, cambio de estado, contadores y eventos.
 *   - Constantes `INSERT_VOICE_SESSION_SQL`, `SELECT_VOICE_SESSION_SQL` y `UPDATE_VOICE_SESSION_STATUS_SQL`.
 *   - Proyecciones explicitas de columna derivadas del DDL, sin `SELECT *`.
 *   - Caducidad explicita de la clave de estado efimero (`SESSION_STATE_TTL_SECONDS`).
 *
 * @dependencias_internas
 *   - `@shared/infrastructure/redis/redis-cluster.client.ts`: Sincronizacion de estado efimero.
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Estados oficiales de sesion.
 *   - `../domain/voice-session-and-tools.types.ts`: Entidades y tipos de dominio.
 *   - `./voice-session-row-mapping.ts`: Uniones derivadas del esquema, proyecciones y mapeadores.
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion transaccional con contexto RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions`, `action_events`.
 *   - Redis: `voice_session:state:<id>`, `org:<id>:active_sessions`.
 */

import type { PoolClient } from 'pg';
import { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { VoiceSessionStatus } from '@shared/ports/billing-voice-admin.ports';
import {
  ActionEventEntity,
  AiVoiceModelType,
  PhysicalVoiceToolName,
  VoiceSessionEntity,
} from '../domain/voice-session-and-tools.types';
import {
  ACTION_EVENT_COLUMNS,
  ActionExecutionStatusInput,
  SESSION_STATE_TTL_SECONDS,
  VOICE_SESSION_COLUMNS,
  isTerminalVoiceSessionStatus,
  mapActionEventRow as mapActionEventRowFromDb,
  mapVoiceSessionRow as mapVoiceSessionRowFromDb,
  resolveActionExecutionStatus,
  toProjectionList,
} from './voice-session-row-mapping';

/** Datos de insercion para registrar una nueva sesion de voz. */
export interface CreateVoiceSessionData {
  readonly organizationId: string;
  readonly projectId: string;
  readonly functionalMapId: string;
  readonly apiKeyId?: string;
  readonly externalEndUserId?: string;
  readonly originDomain: string;
  readonly aiModelUsed: AiVoiceModelType;
  readonly endUserConsentVerified: boolean;
  readonly clientIpHash: string;
  readonly userAgent?: string;
  readonly deviceViewportType: 'desktop' | 'tablet' | 'mobile';
}

/** Datos de insercion de un evento de accion fisica DOM. */
export interface CreateActionEventData {
  readonly organizationId: string;
  readonly projectId: string;
  readonly voiceSessionId: string;
  readonly mapElementId?: string;
  readonly providerToolCallId: string;
  readonly toolName: PhysicalVoiceToolName;
  readonly routePathAtExecution: string;
  readonly selectorUsed: string;
  readonly actionPayloadRedactedJson: Record<string, unknown>;
}

/** Proyeccion explicita de columnas de `voice_sessions`, derivada del DDL de la migracion. */
const VOICE_SESSION_PROJECTION = toProjectionList(VOICE_SESSION_COLUMNS);

/** Proyeccion explicita de columnas de `action_events`, derivada del DDL de la migracion. */
const ACTION_EVENT_PROJECTION = toProjectionList(ACTION_EVENT_COLUMNS);

/** Alta de una sesion de voz en estado inicial de handshake. */
const INSERT_VOICE_SESSION_SQL = `INSERT INTO voice_sessions (
        organization_id, project_id, functional_map_id, api_key_id,
        external_end_user_id, origin_domain, ai_model_used, status,
        end_user_consent_verified, client_ip_hash, user_agent, device_viewport_type
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'HANDSHAKE_ISSUED', $8, $9, $10, $11
      ) RETURNING ${VOICE_SESSION_PROJECTION};`;

/** Lectura de una sesion de voz por su identificador, acotada por la politica RLS vigente. */
const SELECT_VOICE_SESSION_SQL =
  `SELECT ${VOICE_SESSION_PROJECTION} FROM voice_sessions WHERE id = $1 LIMIT 1;`;

/** Cierre o cambio de estado de una sesion, con su motivo y su duracion acumulada. */
const UPDATE_VOICE_SESSION_STATUS_SQL = `
      UPDATE voice_sessions
      SET status = $1,
          termination_reason = COALESCE($2, termination_reason),
          duration_seconds = COALESCE($3, duration_seconds),
          ended_at = CASE WHEN $4::boolean THEN NOW() ELSE ended_at END
      WHERE id = $5
      RETURNING organization_id;
    `;

/** Alta de la telemetria de una accion fisica ejecutada por una herramienta del motor. */
const INSERT_ACTION_EVENT_SQL = `INSERT INTO action_events (
        organization_id, project_id, voice_session_id, map_element_id,
        provider_tool_call_id, tool_name, route_path_at_execution,
        selector_used, action_payload_redacted_json, execution_status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'DISPATCHED'
      ) RETURNING ${ACTION_EVENT_PROJECTION};`;

/** Acuse del SDK sobre una accion despachada, con su latencia medida y su codigo de error. */
const UPDATE_ACTION_EVENT_STATUS_SQL = `
      UPDATE action_events
      SET execution_status = $1,
          execution_latency_ms = COALESCE($2, execution_latency_ms),
          error_code = COALESCE($3, error_code),
          acknowledged_at = NOW()
      WHERE id = $4;
    `;

/**
 * Normaliza un estado de accion emitido por la aplicacion al valor que admite la columna.
 * El despachador de herramientas emite `FAILED_CLIENT_TIMEOUT`, que NO existe en el tipo de la
 * base: sin esta traduccion la escritura fallaba en ejecucion con un error de valor de enum.
 *
 * @param status - Estado emitido por el caso de uso.
 * @returns Valor exacto del tipo enumerado de PostgreSQL.
 */
function normalizeActionStatus(status: ActionExecutionStatusInput): string {
  return resolveActionExecutionStatus(status);
}

/**
 * Repositorio de base de datos para sesiones de voz y eventos de accion.
 */
export class PostgresVoiceSessionRepository {
  private readonly redisClient?: RedisClusterClient | undefined;

  /**
   * @param redisClient - Cliente Redis para el estado efimero; omitido en los procesos que no
   *   sincronizan estado en vivo (el repositorio funciona entonces solo contra PostgreSQL).
   */
  public constructor(redisClient?: RedisClusterClient | undefined) {
    this.redisClient = redisClient;
  }

  /**
   * Inserta un nuevo registro de sesion de voz en PostgreSQL.
   *
   * @param client - Conexion transaccional que ya posee el contexto RLS del tenant.
   * @param data - Datos de la sesion a registrar.
   * @returns Entidad de la sesion creada.
   * @throws Error cuando la insercion no devuelve fila, porque una sesion sin registro deja la
   *   conversacion sin trazabilidad contable.
   */
  public async createVoiceSession(
    client: PoolClient,
    data: CreateVoiceSessionData
  ): Promise<VoiceSessionEntity> {
    const values = [
      data.organizationId,
      data.projectId,
      data.functionalMapId,
      data.apiKeyId ?? null,
      data.externalEndUserId ?? null,
      data.originDomain,
      data.aiModelUsed,
      data.endUserConsentVerified,
      data.clientIpHash,
      data.userAgent ?? null,
      data.deviceViewportType,
    ];

    const { rows } = await client.query<Record<string, unknown>>(INSERT_VOICE_SESSION_SQL, values);
    const row = rows[0];
    if (!row) {
      throw new Error('Fallo al insertar la sesion de voz en la base de datos');
    }

    const session = mapVoiceSessionRowFromDb(row);

    // Registra la sesion activa en Redis si el cliente esta presente
    if (this.redisClient) {
      const redisKey = this.redisClient.keyNamespaces.organizationActiveSessions(session.organizationId);
      await this.redisClient.counters.addToSet(redisKey, session.id, 86400).catch(() => {});
    }

    return session;
  }

  /**
   * Obtiene una sesion de voz por su identificador unico.
   *
   * @param client - Conexion transaccional que ya posee el contexto RLS del tenant.
   * @param sessionId - Identificador de la sesion consultada.
   * @returns Entidad de la sesion, o `null` cuando no existe o el inquilino no puede verla.
   */
  public async getVoiceSessionById(
    client: PoolClient,
    sessionId: string
  ): Promise<VoiceSessionEntity | null> {
    const { rows } = await client.query<Record<string, unknown>>(SELECT_VOICE_SESSION_SQL, [sessionId]);
    const row = rows[0];
    return row ? mapVoiceSessionRowFromDb(row) : null;
  }

  /**
   * Actualiza el estado y parametros finales de una sesion de voz.
   *
   * @param client - Conexion transaccional que ya posee el contexto RLS del tenant.
   * @param sessionId - Identificador de la sesion.
   * @param status - Estado nuevo de la sesion, tomado del tipo de la base.
   * @param terminationReason - Motivo del cierre, cuando la sesion termina.
   * @param durationSeconds - Duracion acumulada, cuando se conoce.
   */
  public async updateVoiceSessionStatus(
    client: PoolClient,
    sessionId: string,
    status: VoiceSessionStatus,
    terminationReason?: string,
    durationSeconds?: number
  ): Promise<void> {
    const isEnding = isTerminalVoiceSessionStatus(status);

    const { rows } = await client.query<{ organization_id: string }>(UPDATE_VOICE_SESSION_STATUS_SQL, [
      status,
      terminationReason ?? null,
      durationSeconds !== undefined ? durationSeconds : null,
      isEnding,
      sessionId,
    ]);

    // Limpia la sesion del conjunto de sesiones activas en Redis si termino
    if (isEnding && this.redisClient && rows[0]) {
      const orgId = rows[0].organization_id;
      const redisKey = this.redisClient.keyNamespaces.organizationActiveSessions(orgId);
      await this.redisClient.counters.removeFromSet(redisKey, sessionId).catch(() => {});
      await this.redisClient.keys.remove(this.redisClient.keyNamespaces.voiceSessionState(sessionId)).catch(() => {});
    }
  }

  /**
   * Incrementa atomicamente el contador de interrupciones (Barge-In) de la sesion.
   *
   * @param client - Conexion transaccional con contexto RLS.
   * @param sessionId - Sesion cuyo contador se incrementa.
   * @returns Valor del contador tras el incremento, o `0` si la sesion no existe.
   */
  public async incrementBargeInCount(client: PoolClient, sessionId: string): Promise<number> {
    const query = `
      UPDATE voice_sessions
      SET barge_in_count = barge_in_count + 1
      WHERE id = $1
      RETURNING barge_in_count;
    `;
    const { rows } = await client.query<{ barge_in_count: number }>(query, [sessionId]);
    return rows[0]?.barge_in_count ?? 0;
  }

  /**
   * Incrementa atomicamente el contador total de llamadas a herramientas ejecutadas.
   *
   * @param client - Conexion transaccional con contexto RLS.
   * @param sessionId - Sesion cuyo contador se incrementa.
   * @returns Valor del contador tras el incremento, o `0` si la sesion no existe.
   */
  public async incrementToolCallsCount(client: PoolClient, sessionId: string): Promise<number> {
    const query = `
      UPDATE voice_sessions
      SET total_tool_calls_count = total_tool_calls_count + 1
      WHERE id = $1
      RETURNING total_tool_calls_count;
    `;
    const { rows } = await client.query<{ total_tool_calls_count: number }>(query, [sessionId]);
    return rows[0]?.total_tool_calls_count ?? 0;
  }

  /**
   * Inserta un evento de accion fisica (click, escritura o avance) en `action_events`.
   *
   * @param client - Conexion transaccional con contexto RLS.
   * @param data - Datos del evento de accion.
   * @returns Entidad del evento registrado.
   * @throws Error cuando la insercion no devuelve fila.
   */
  public async createActionEvent(
    client: PoolClient,
    data: CreateActionEventData
  ): Promise<ActionEventEntity> {
    const values = [
      data.organizationId,
      data.projectId,
      data.voiceSessionId,
      data.mapElementId ?? null,
      data.providerToolCallId,
      data.toolName,
      data.routePathAtExecution,
      data.selectorUsed,
      JSON.stringify(data.actionPayloadRedactedJson),
    ];

    const { rows } = await client.query<Record<string, unknown>>(INSERT_ACTION_EVENT_SQL, values);
    const row = rows[0];
    if (!row) {
      throw new Error('Fallo al registrar evento de accion en action_events');
    }

    return mapActionEventRowFromDb(row);
  }

  /**
   * Actualiza el estado de ejecucion y la latencia de un evento de accion tras recibir el ACK del SDK.
   *
   * @param client - Conexion transaccional con contexto RLS.
   * @param actionEventId - Evento de accion actualizado.
   * @param status - Estado final emitido por el despachador; los alias heredados se traducen al
   *   valor del enum de PostgreSQL antes de escribir, de modo que ninguno de los seis estados del
   *   tipo de la base pueda fallar en ejecucion.
   * @param latencyMs - Latencia medida entre el envio de la directiva y el acuse.
   * @param errorCode - Codigo de error asociado al fallo, cuando existe.
   */
  public async updateActionEventStatus(
    client: PoolClient,
    actionEventId: string,
    status: ActionExecutionStatusInput,
    latencyMs?: number,
    errorCode?: string
  ): Promise<void> {
    await client.query(UPDATE_ACTION_EVENT_STATUS_SQL, [
      normalizeActionStatus(status),
      latencyMs ?? null,
      errorCode ?? null,
      actionEventId,
    ]);
  }

  /**
   * Guarda o actualiza el estado efimero de la sesion en Redis con su caducidad declarada.
   * La caducidad se pasa de forma EXPLICITA: el valor por omision del cliente es `0`, que significa
   * SIN caducidad, y dejaria la clave de estado de la sesion permanente en el cluster.
   *
   * @param sessionId - Sesion cuyo estado se sincroniza.
   * @param state - Estado serializable de la sesion.
   */
  public async syncSessionStateToRedis(
    sessionId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    if (!this.redisClient) return;

    const key = this.redisClient.keyNamespaces.voiceSessionState(sessionId);
    await this.redisClient.json.setJson(key, state, SESSION_STATE_TTL_SECONDS);
  }
}
