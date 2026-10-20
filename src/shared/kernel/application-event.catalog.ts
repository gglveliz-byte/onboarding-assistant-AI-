/**
 * @archivo src/shared/kernel/application-event.catalog.ts
 * @modulo 00-kernel (Catalogo Tipado de Eventos de Aplicacion del Sistema)
 * @proposito
 *   Declara el mapa `nombre de evento -> carga util` que da tipado estricto a todo el bus de
 *   eventos. Sin este catalogo, publicar un evento es enviar un objeto anonimo que nadie puede
 *   validar; con el, el compilador garantiza que quien publica `organization.suspended` entrega
 *   exactamente los campos que quien lo consume espera leer. Cualquier modulo que necesite un
 *   evento nuevo lo declara aqui, nunca inventa una cadena suelta en su propio archivo.
 *
 * @resumen_contenido
 *   - Interface `ApplicationEventMap`: Mapa canonico `nombre -> carga util` de todos los eventos.
 *   - Tipo `ApplicationEventName`: Union literal con los nombres validos.
 *   - Interface `ApplicationEventEnvelope<T>`: Sobre con metadatos de trazabilidad y origen.
 *   - Funcion `buildEventEnvelope()`: Fabrica de sobres con identificador unico y marca temporal.
 *
 * @dependencias_internas
 *   - `generateCsprngToken` (`./crypto-primitives.util.ts`) para el identificador del evento.
 *
 * @dependencias_externas
 *   - Ninguna (Catalogo puro de tipos y una fabrica sin dependencias externas).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:events:global` y `oa:events:stream` (Transporte de los eventos declarados aqui).
 *   - PostgreSQL: `audit_logs` (Consume eventos de gobierno y seguridad para su bitacora).
 */

import { generateCsprngToken } from './crypto-primitives.util';

/** Mapa canonico de nombres de evento a la carga util que transportan. */
export interface ApplicationEventMap {
  /** Una organizacion fue suspendida por el gobierno de la plataforma. */
  'organization.suspended': {
    readonly organizationId: string;
    readonly reason: string;
    readonly suspendedByUserId: string;
    readonly suspendedAtIso: string;
  };
  /** Una organizacion fue reactivada por el gobierno de la plataforma. */
  'organization.reactivated': {
    readonly organizationId: string;
    readonly reactivatedByUserId: string;
    readonly reactivatedAtIso: string;
  };
  /** Una organizacion fue eliminada definitivamente por el gobierno de la plataforma. */
  'organization.deleted': {
    readonly organizationId: string;
    readonly deletedByUserId: string;
    readonly deletedAtIso: string;
    readonly mode: 'HARD_DELETED' | 'SOFT_DELETED_TOMBSTONE';
  };
  /** Se ordeno cerrar de inmediato todas las sesiones de voz de una organizacion. */
  'voice.terminate_all_org_sessions': {
    readonly organizationId: string;
    readonly reason: string;
    readonly requestedByUserId: string;
  };
  /** Se publico una nueva version inmutable del Mapa Funcional de un proyecto. */
  'rag_map.published': {
    readonly organizationId: string;
    readonly projectId: string;
    readonly functionalMapId: string;
    readonly versionNumber: number;
    readonly canonicalSha256: string;
  };
  /** Se confirmo un pago y debe otorgarse el saldo correspondiente del periodo. */
  'billing.payment_succeeded': {
    readonly organizationId: string;
    readonly whopSubscriptionId: string;
    readonly externalEventId: string;
    readonly grantedMinutes: string;
  };
  /** El saldo de una organizacion se agoto y su sesion de voz fue cortada. */
  'billing.funds_exhausted': {
    readonly organizationId: string;
    readonly voiceSessionId: string;
    readonly remainingMinutes: string;
  };
  /** Se detecto el reuso de un refresh token: familia comprometida. */
  'security.refresh_token_reuse_detected': {
    readonly userId: string;
    readonly organizationId: string;
    readonly tokenFamilyId: string;
    readonly detectedAtIso: string;
  };
  /** El escudo Anti-SSRF bloqueo un destino prohibido durante el entrenamiento visual. */
  'security.ssrf_attempt_blocked': {
    readonly organizationId: string;
    readonly projectId: string;
    readonly hostname: string;
    readonly resolvedIp: string;
    readonly blockedReason: string;
  };
}

/** Union literal con todos los nombres de evento validos del sistema. */
export type ApplicationEventName = keyof ApplicationEventMap;

/** Sobre con metadatos de trazabilidad que envuelve toda carga util publicada. */
export interface ApplicationEventEnvelope<TName extends ApplicationEventName = ApplicationEventName> {
  /** Identificador unico del evento, usado para deduplicacion en los consumidores. */
  readonly eventId: string;
  /** Nombre canonico del evento. */
  readonly eventName: TName;
  /** Carga util tipada del evento. */
  readonly payload: ApplicationEventMap[TName];
  /** Organizacion de origen, cuando el evento pertenece a un tenant concreto. */
  readonly organizationId: string | null;
  /** Identificador de correlacion de la solicitud que origino el evento. */
  readonly correlationId: string | null;
  /** Marca temporal de emision en formato ISO 8601 con zona horaria. */
  readonly occurredAtIso: string;
  /** Node Pool que emitio el evento (`API_CONTROL_PLANE`, `VOICE_REALTIME_GATEWAY`, etc.). */
  readonly emittedByPool: string;
}

/**
 * Construye el sobre de un evento con identificador unico y marca temporal.
 *
 * @param eventName - Nombre canonico del evento.
 * @param payload - Carga util tipada correspondiente al nombre.
 * @param context - Organizacion, correlacion y Node Pool emisor del evento.
 * @returns Sobre listo para publicar en memoria, Pub/Sub o Streams.
 */
export function buildEventEnvelope<TName extends ApplicationEventName>(
  eventName: TName,
  payload: ApplicationEventMap[TName],
  context: { readonly organizationId?: string; readonly correlationId?: string; readonly emittedByPool?: string } = {}
): ApplicationEventEnvelope<TName> {
  return {
    eventId: `evt_${generateCsprngToken(16)}`,
    eventName,
    payload,
    organizationId: context.organizationId ?? null,
    correlationId: context.correlationId ?? null,
    occurredAtIso: new Date().toISOString(),
    emittedByPool: context.emittedByPool ?? 'API_CONTROL_PLANE',
  };
}
