/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/voice-session-row-mapping.ts
 * @modulo 05-voice-realtime-gateway (Tipado Derivado del Esquema, Proyecciones y Mapeo de Filas)
 * @proposito
 *   Concentra todo lo que el repositorio de sesiones de voz necesita saber del esquema PostgreSQL:
 *   los estados validos de `action_events.execution_status` y de `voice_sessions.status`, las listas
 *   EXACTAS de columnas que se proyectan en cada consulta y la traduccion de fila cruda a entidad de
 *   dominio. Los tipos NO se vuelven a enumerar a mano: se derivan del DDL leido por
 *   `database-enum-source.ts`, que es el mismo texto que se aplica a la base. Reenumerar a mano fue
 *   la causa raiz del defecto C1-27, donde el repositorio aceptaba cuatro estados de resultado de
 *   accion mientras el tipo de la base tiene seis.
 *
 * @resumen_contenido
 *   - Tipo `ActionExecutionStatus` derivado de `action_execution_status_enum` de la migracion 001.
 *   - Tipos `VoiceSessionStatusFromDb` y `ActionExecutionStatusInput` con su traduccion de alias.
 *   - Constantes `VOICE_SESSION_COLUMNS`, `ACTION_EVENT_COLUMNS` y `SESSION_STATE_TTL_SECONDS`.
 *   - Funciones `resolveActionExecutionStatus()` y `resolveLegacyActionExecutionStatus()`.
 *   - Funciones `mapVoiceSessionRow()` y `mapActionEventRow()`.
 *
 * @dependencias_internas
 *   - `readSqlEnumValues()`, `readSqlTableColumns()` (`../../../modules/03-visual-trainer-and-rag/infrastructure/database-enum-source.ts`).
 *   - `VoiceSessionEntity`, `ActionEventEntity` (`../domain/voice-session-and-tools.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Mapeo puro, sin acceso a base de datos ni a Redis).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions`, `action_events` (Solo se derivan sus columnas del DDL).
 *   - Redis: `voice_session:state:<id>` (La caducidad declarada se define aqui).
 */

import {
  readSqlEnumValues,
  readSqlTableColumns,
} from '../../03-visual-trainer-and-rag/infrastructure/database-enum-source';
import type {
  ActionEventEntity,
  AiVoiceModelType,
  PhysicalVoiceToolName,
  VoiceSessionEntity,
} from '../domain/voice-session-and-tools.types';

/** Archivo que declara los tipos enumerados del modelo de dominio. */
export const ENUM_DECLARATION_MIGRATION = '001_extensions_enums_and_rls_functions.sql';

/** Archivo que declara las tablas de sesiones de voz y eventos de accion. */
export const VOICE_TABLES_MIGRATION = '004_whop_billing_voice_sessions_and_audit_tables.sql';

/** Nombre del tipo de la base que gobierna el estado de una sesion de voz. */
export const VOICE_SESSION_STATUS_ENUM_NAME = 'voice_session_status_enum';

/** Nombre del tipo de la base que gobierna el resultado de una accion fisica del DOM. */
export const ACTION_EXECUTION_STATUS_ENUM_NAME = 'action_execution_status_enum';

/**
 * Estados validos de `action_events.execution_status`, tomados del tipo de la base.
 * Escribir cualquier otro valor en esa columna falla en ejecucion aunque el codigo compile.
 */
export const ACTION_EXECUTION_STATUSES = Object.freeze(
  readSqlEnumValues(ENUM_DECLARATION_MIGRATION, ACTION_EXECUTION_STATUS_ENUM_NAME)
);

/** Valores con los que la columna `status` de `voice_sessions` puede escribirse. */
export const VOICE_SESSION_STATUSES = Object.freeze(
  readSqlEnumValues(ENUM_DECLARATION_MIGRATION, VOICE_SESSION_STATUS_ENUM_NAME)
);

/** Estado de ejecucion de una accion fisica, derivado del tipo enumerado de PostgreSQL. */
export type ActionExecutionStatus = (typeof ACTION_EXECUTION_STATUSES)[number];

/** Estado del ciclo de vida de una sesion de voz, derivado del tipo enumerado de PostgreSQL. */
export type VoiceSessionStatusFromDb = (typeof VOICE_SESSION_STATUSES)[number];

/**
 * Alias heredados que el codigo de aplicacion sigue emitiendo y que la base NO admite.
 * El caso vivo es `FAILED_CLIENT_TIMEOUT`: el despachador de herramientas lo devuelve como su
 * estado final y la columna solo conoce `TIMEOUT`. La equivalencia se toma del propio enum de la
 * base, nunca de una cadena escrita a mano, de modo que traducir el alias no puede desviarse del
 * esquema; y el alias queda declarado en este unico lugar.
 */
export const ACTION_EXECUTION_STATUS_LEGACY_ALIASES: Readonly<Record<string, ActionExecutionStatus>> = Object.freeze({
  FAILED_CLIENT_TIMEOUT: ACTION_EXECUTION_STATUSES[5] as ActionExecutionStatus,
});

/** Alias heredado del estado final de una accion que el navegador nunca confirmo. */
export type LegacyActionExecutionStatus = keyof typeof ACTION_EXECUTION_STATUS_LEGACY_ALIASES;

/** Estados de accion que el dominio puede producir: los de la base mas sus alias heredados. */
export type ActionExecutionStatusInput = ActionExecutionStatus | LegacyActionExecutionStatus;

/** Estados de accion que el codigo de aplicacion puede producir, en una lista verificable. */
export const ACTION_EXECUTION_STATUS_INPUTS: readonly ActionExecutionStatusInput[] = Object.freeze([
  ...(ACTION_EXECUTION_STATUSES as readonly ActionExecutionStatusInput[]),
  ...(Object.keys(ACTION_EXECUTION_STATUS_LEGACY_ALIASES) as LegacyActionExecutionStatus[]),
]);

/**
 * Indica si un estado de sesion cierra definitivamente la sesion de voz.
 * Se comprueba contra la lista derivada de la base, no contra una enumeracion escrita a mano: un
 * estado nuevo del esquema que no se declare aqui deja de liberar la sesion activa en Redis y la
 * suite de pruebas lo detecta.
 */
export const VOICE_SESSION_TERMINAL_STATUSES: readonly VoiceSessionStatusFromDb[] = Object.freeze([
  'COMPLETED_NORMAL',
  'TERMINATED_BARGE_IN_LIMIT',
  'TERMINATED_INSUFFICIENT_FUNDS',
  'TERMINATED_TENANT_SUSPENDED',
  'FAILED_PROVIDER_ERROR',
]);

/**
 * Caducidad declarada de la clave de estado efimero de una sesion en Redis.
 * Un valor de `0` en el cliente significa SIN CADUCIDAD: la clave quedaria permanente y el estado
 * de una sesion muerta sobreviviria indefinidamente al proceso que lo escribio.
 */
export const SESSION_STATE_TTL_SECONDS = 3600;

/**
 * Traduce un estado de accion emitido por la aplicacion al valor que admite la columna.
 *
 * @param status - Estado emitido por el caso de uso, que puede ser un alias heredado.
 * @returns El valor exacto del tipo enumerado de PostgreSQL.
 */
export function resolveActionExecutionStatus(status: ActionExecutionStatusInput): ActionExecutionStatus {
  const legacyEquivalent = ACTION_EXECUTION_STATUS_LEGACY_ALIASES[status];
  return legacyEquivalent ?? (status as ActionExecutionStatus);
}

/**
 * Determina si una sesion de voz queda cerrada con el estado indicado.
 *
 * @param status - Estado final de la sesion.
 * @returns `true` cuando la sesion debe salir del conjunto de sesiones activas.
 */
export function isTerminalVoiceSessionStatus(status: VoiceSessionStatusFromDb): boolean {
  return VOICE_SESSION_TERMINAL_STATUSES.includes(status);
}

/**
 * Proyecta el estado crudo de la columna `execution_status` sobre un estado valido del dominio.
 * Una fila con un valor desconocido (por ejemplo escrita antes de ampliar el enum) no debe
 * propagarse como si fuera valido: se degrada al estado inicial `DISPATCHED`, que es el que la
 * columna declara por omision.
 *
 * @param rawStatus - Valor crudo de la columna.
 * @returns Estado valido, con los alias heredados ya traducidos.
 */
export function resolveLegacyActionExecutionStatus(rawStatus: unknown): ActionExecutionStatus {
  const text = String(rawStatus);
  const candidate = ACTION_EXECUTION_STATUS_LEGACY_ALIASES[text] ?? (text as ActionExecutionStatus);
  return ACTION_EXECUTION_STATUSES.includes(candidate) ? candidate : 'DISPATCHED';
}

/** Columnas proyectadas de `voice_sessions`, en el orden que consume `mapVoiceSessionRow()`. */
export const VOICE_SESSION_COLUMNS: readonly string[] = Object.freeze(
  readSqlTableColumns(VOICE_TABLES_MIGRATION, 'voice_sessions')
);

/** Columnas proyectadas de `action_events`, en el orden que consume `mapActionEventRow()`. */
export const ACTION_EVENT_COLUMNS: readonly string[] = Object.freeze(
  readSqlTableColumns(VOICE_TABLES_MIGRATION, 'action_events')
);

/**
 * Compone la lista de proyeccion explicita de una tabla para una sentencia SQL.
 * La convencion del proyecto prohibe `SELECT *`: la lista derivada del DDL garantiza que la
 * proyeccion y el mapeador no se desincronicen cuando el esquema cambie.
 *
 * @param columns - Columnas derivadas de la tabla.
 * @returns Fragmento SQL con las columnas separadas por coma.
 */
export function toProjectionList(columns: readonly string[]): string {
  return columns.join(', ');
}

/**
 * Mapea una fila cruda de `voice_sessions` a la entidad tipada de dominio.
 *
 * @param row - Fila tal como la devuelve `pg`.
 * @returns Entidad inmutable de la sesion de voz.
 */
export function mapVoiceSessionRow(row: Record<string, unknown>): VoiceSessionEntity {
  return Object.freeze({
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    projectId: String(row['project_id']),
    functionalMapId: String(row['functional_map_id']),
    apiKeyId: row['api_key_id'] ? String(row['api_key_id']) : null,
    externalEndUserId: row['external_end_user_id'] ? String(row['external_end_user_id']) : null,
    originDomain: String(row['origin_domain']),
    aiModelUsed: String(row['ai_model_used']) as AiVoiceModelType,
    status: String(row['status']) as VoiceSessionEntity['status'],
    endUserConsentVerified: Boolean(row['end_user_consent_verified']),
    currentStepIndex: Number(row['current_step_index']),
    totalStepsCompleted: Number(row['total_steps_completed']),
    bargeInCount: Number(row['barge_in_count']),
    totalToolCallsCount: Number(row['total_tool_calls_count']),
    durationSeconds: Number(row['duration_seconds'] ?? 0),
    billedMinutes: String(row['billed_minutes'] ?? '0.000000'),
    totalBilledCostUsd: String(row['total_billed_cost_usd'] ?? '0.000000'),
    clientIpHash: String(row['client_ip_hash']),
    userAgent: row['user_agent'] ? String(row['user_agent']) : null,
    deviceViewportType: String(row['device_viewport_type'] ?? 'desktop') as 'desktop' | 'tablet' | 'mobile',
    startedAt: new Date(String(row['started_at'])),
    endedAt: row['ended_at'] ? new Date(String(row['ended_at'])) : null,
    terminationReason: row['termination_reason'] ? String(row['termination_reason']) : null,
    createdAt: new Date(String(row['created_at'])),
  });
}

/**
 * Mapea una fila cruda de `action_events` a la entidad tipada de dominio.
 *
 * @param row - Fila tal como la devuelve `pg`.
 * @returns Entidad inmutable del evento de accion.
 */
export function mapActionEventRow(row: Record<string, unknown>): ActionEventEntity {
  return Object.freeze({
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    projectId: String(row['project_id']),
    voiceSessionId: String(row['voice_session_id']),
    mapElementId: row['map_element_id'] ? String(row['map_element_id']) : null,
    providerToolCallId: String(row['provider_tool_call_id']),
    toolName: String(row['tool_name']) as PhysicalVoiceToolName,
    routePathAtExecution: String(row['route_path_at_execution']),
    selectorUsed: String(row['selector_used']),
    actionPayloadRedactedJson: parseRedactedPayload(row['action_payload_redacted_json']),
    executionStatus: resolveLegacyActionExecutionStatus(row['execution_status']) as ActionEventEntity['executionStatus'],
    // Se comprueba contra indefinido ADEMAS de contra nulo: una proyeccion que omita la columna
    // (o un driver que la entregue ausente) no debe producir `NaN`, que se propagaria como una
    // latencia falsa hasta la telemetria y la haria inutilizable.
    executionLatencyMs: row['execution_latency_ms'] != null ? Number(row['execution_latency_ms']) : null,
    errorCode: row['error_code'] ? String(row['error_code']) : null,
    dispatchedAt: new Date(String(row['dispatched_at'])),
    acknowledgedAt: row['acknowledged_at'] ? new Date(String(row['acknowledged_at'])) : null,
  });
}

/**
 * Interpreta la carga util depurada de una accion, aceptando el objeto ya deserializado o su texto.
 *
 * @param rawPayload - Valor crudo de la columna `action_payload_redacted_json`.
 * @returns Objeto de la accion, o un objeto vacio cuando el contenido no es interpretable.
 */
function parseRedactedPayload(rawPayload: unknown): Record<string, unknown> {
  if (typeof rawPayload === 'object' && rawPayload !== null) {
    return rawPayload as Record<string, unknown>;
  }
  if (typeof rawPayload === 'string') {
    try {
      return JSON.parse(rawPayload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
