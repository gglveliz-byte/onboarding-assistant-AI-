/**
 * @archivo apps/web/src/lib/api-client/http-client.ts
 * @modulo apps/web/src/lib/api-client (cliente HTTP resiliente del frente web)
 * @proposito
 *   Único cliente HTTP del frente web contra el plano de control: adjunta el token de acceso
 *   solo desde memoria RAM, transporta la cookie HttpOnly `__Host-oa_rt`, normaliza el sobre
 *   de error del backend, despacha los eventos globales de negocio y renueva la sesión de
 *   forma silenciosa y single-flight ante un 401 reanudando la cola de peticiones en vuelo.
 *
 * @resumen_contenido
 *   - Estado de sesión: `setAccessToken()` / `getAccessToken()` (RAM volátil, sin persistencia).
 *   - `BackendRequestOptions`: método, cuerpo JSON, cabeceras, aborto y banderas de control.
 *   - `BackendHttpError`: error tipado (código público, estado, severidad y detalles).
 *   - `backendFetch()`: petición JSON con sobre tipado, eventos y refresh 401 single-flight.
 *   - Eventos globales: legal, tenant suspendido, fondos insuficientes, límite y sesión expirada.
 *
 * @dependencias_internas
 *   - `./backend-contracts.types` (tipos del plano de control y `HTTP_CLIENT_EVENT_NAMES`).
 *
 * @dependencias_externas
 *   - Ninguna: solo APIs de plataforma (`fetch`, `Promise`, `JSON`, `CustomEvent`, `window`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna directa: el aislamiento RLS y las claves Redis se aplican en el servidor.
 */

import type {
  AuditSeverity, AuthRefreshSuccessDto, BackendErrorCode, BackendErrorEnvelope, HttpClientEventName,
} from './backend-contracts.types';
import { HTTP_CLIENT_EVENT_NAMES } from './backend-contracts.types';

/** Clave para preservar el token en la sesion de la pestana activa. */
const SESSION_TOKEN_STORAGE_KEY = 'oa_access_token';

/** Clave para preservar el slug de la organización en la sesión de la pestaña activa. */
const SESSION_ORG_SLUG_STORAGE_KEY = 'oa_org_slug';

/** Token de acceso vigente en RAM volátil del módulo. */
let accessTokenInRam: string | null = null;

/** Guarda o limpia el token de acceso tras login, registro, refresco o cierre de sesión. */
export function setAccessToken(token: string | null): void {
  accessTokenInRam = token;
  if (typeof window !== 'undefined') {
    try {
      if (token !== null && token.length > 0) {
        window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
      } else {
        window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      }
    } catch {
      /* sessionStorage restringido por politica del navegador */
    }
  }
}

/** Devuelve el token de acceso en memoria o rehidratado desde la sesión activa de la pestaña. */
export function getAccessToken(): string | null {
  if (accessTokenInRam !== null && accessTokenInRam.length > 0) {
    return accessTokenInRam;
  }
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
      if (stored !== null && stored.length > 0) {
        accessTokenInRam = stored;
        return stored;
      }
    } catch {
      /* sessionStorage no disponible */
    }
  }
  return null;
}

/**
 * Guarda el slug de la organización tras autenticarse para que las rutas de entrada del
 * dashboard (`/dashboard`, `/dashboard/org/[orgSlug]`) puedan reconstruir el destino real.
 */
export function setSessionOrgSlug(slug: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (slug !== null && slug.length > 0) {
      window.sessionStorage.setItem(SESSION_ORG_SLUG_STORAGE_KEY, slug);
    } else {
      window.sessionStorage.removeItem(SESSION_ORG_SLUG_STORAGE_KEY);
    }
  } catch {
    /* sessionStorage restringido por política del navegador */
  }
}

/** Devuelve el slug de organización persistido en la pestaña activa (`null` si no hay). */
export function getSessionOrgSlug(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = window.sessionStorage.getItem(SESSION_ORG_SLUG_STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Opciones de `backendFetch`: método, cuerpo JSON, cabeceras, aborto y banderas de control. */
export interface BackendRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly anonymous?: boolean;
  readonly noRefreshRetry?: boolean;
}

/** Error normalizado del backend: código público, estado HTTP, severidad y detalles. */
export class BackendHttpError extends Error {
  readonly code: BackendErrorCode;
  readonly httpStatus: number;
  readonly auditSeverity: AuditSeverity;
  readonly details: Readonly<Record<string, unknown>>;

  /** Construye el error: mensaje del sobre o sintetizado, código, estado, severidad y detalles. */
  constructor(
    message: string, code: BackendErrorCode, httpStatus: number,
    auditSeverity: AuditSeverity, details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'BackendHttpError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.auditSeverity = auditSeverity;
    this.details = details;
  }
}

/**
 * Base del plano de control desde el entorno público del despliegue (acceso por índice:
 * la compilación estricta activa `noPropertyAccessFromIndexSignature`). Vacío = mismo origen.
 */
const API_BASE_URL: string =
  typeof process === 'undefined' ? '' : (process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '');

/** Ruta del endpoint de refresco silencioso de sesión del plano de control. */
const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';

/** Mensaje genérico cuando el servidor no entrega un sobre de error válido. */
const GENERIC_ERROR_MESSAGE = 'No fue posible completar la solicitud. Inténtalo de nuevo en unos instantes.';

/** Mensaje de indisponibilidad de red cuando `fetch` no logra contactar al servidor. */
const NETWORK_ERROR_MESSAGE = 'No fue posible contactar el servidor. Revisa tu conexión e inténtalo de nuevo.';

/** Espejo de los 16 códigos públicos del backend para validar sobres de error. */
const BACKEND_ERROR_CODES: readonly string[] = [
  'UNAUTHORIZED', 'TOKEN_VERSION_REVOKED', 'FORBIDDEN', 'VALIDATION_FAILED',
  'NOT_FOUND', 'CONFLICT', 'TENANT_SUSPENDED', 'LEGAL_CONSENT_OUTDATED',
  'DPA_NOT_SIGNED', 'ORIGIN_NOT_ALLOWED', 'SSRF_BLOCKED_IP', 'INSUFFICIENT_FUNDS',
  'RATE_LIMIT_EXCEEDED', 'PROVIDER_UNAVAILABLE', 'INTERNAL_ERROR',
  'INSUFFICIENT_PERMISSIONS',
];

/** Espejo de estado HTTP → código público sintetizado cuando no hay sobre válido. */
const SYNTHETIC_CODE_BY_STATUS: Readonly<Record<number, BackendErrorCode>> = {
  400: 'VALIDATION_FAILED', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMIT_EXCEEDED',
};

/** Determina si un valor desconocido es un registro JSON indexable (sin arreglos ni `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida que una cadena pertenezca al catálogo público de códigos de error. */
function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === 'string' && BACKEND_ERROR_CODES.includes(value);
}

/** Valida que una cadena sea una severidad de auditoría conocida. */
function isAuditSeverity(value: unknown): value is AuditSeverity {
  return value === 'INFO' || value === 'WARN' || value === 'CRITICAL_SECURITY';
}

/**
 * Valida el sobre de error del backend de forma TOLERANTE.
 *
 * El plano de control responde dos envoltorios: el completo (`code`, `message`, `httpStatus`,
 * `wsCloseCode`, `auditSeverity`, `details`) y uno reducido en las capas de borde
 * (`{ error: { code, message } }`). Antes se exigía la forma completa, así que TODO error se
 * descartaba y se sustituía por un mensaje genérico: se perdían el código de negocio (por
 * ejemplo `DPA_NOT_SIGNED` o `LEGAL_CONSENT_OUTDATED`) y nunca se emitían los eventos globales.
 * Ahora basta con `code` y `message`; el resto se deriva del estado HTTP de la respuesta.
 */
function isBackendErrorEnvelope(value: unknown): value is BackendErrorEnvelope {
  if (!isRecord(value) || !isRecord(value['error'])) {
    return false;
  }
  const errorPayload = value['error'];
  return (
    isBackendErrorCode(errorPayload['code'])
    && typeof errorPayload['message'] === 'string'
  );
}

/** Sintetiza el código público por estado HTTP (>=500 y desconocidos → INTERNAL_ERROR). */
function synthesizeErrorCode(httpStatus: number): BackendErrorCode {
  return httpStatus >= 500 ? 'INTERNAL_ERROR' : (SYNTHETIC_CODE_BY_STATUS[httpStatus] ?? 'INTERNAL_ERROR');
}

/** Despacha un evento global en la ventana solo cuando existe un entorno DOM real. */
function emitHttpEvent(eventName: HttpClientEventName, detail: Readonly<Record<string, unknown>>): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

/** Mapa código público de error → evento global consumido por los portales del frente. */
const EVENT_NAME_BY_ERROR_CODE: Partial<Record<BackendErrorCode, HttpClientEventName>> = {
  LEGAL_CONSENT_OUTDATED: HTTP_CLIENT_EVENT_NAMES.LEGAL_CONSENT_OUTDATED,
  TENANT_SUSPENDED: HTTP_CLIENT_EVENT_NAMES.TENANT_SUSPENDED,
  INSUFFICIENT_FUNDS: HTTP_CLIENT_EVENT_NAMES.INSUFFICIENT_FUNDS,
  RATE_LIMIT_EXCEEDED: HTTP_CLIENT_EVENT_NAMES.RATE_LIMITED,
};

/** Emite, antes de lanzar, el evento de negocio correspondiente al código del fallo. */
function emitFailureEvent(failure: BackendHttpError, path: string): void {
  const eventName = EVENT_NAME_BY_ERROR_CODE[failure.code];
  if (eventName !== undefined) {
    emitHttpEvent(eventName, {
      path, code: failure.code, message: failure.message,
      httpStatus: failure.httpStatus, auditSeverity: failure.auditSeverity, details: failure.details,
    });
  }
}

/** Resume el fallo del refresco en un detalle plano apto para el evento de sesión expirada. */
function describeFailureDetail(caughtFailure: unknown): Readonly<Record<string, unknown>> {
  if (caughtFailure instanceof BackendHttpError) {
    return {
      code: caughtFailure.code, message: caughtFailure.message, httpStatus: caughtFailure.httpStatus,
      auditSeverity: caughtFailure.auditSeverity, details: caughtFailure.details,
    };
  }
  if (caughtFailure instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: caughtFailure.message, httpStatus: 0 };
  }
  return { code: 'INTERNAL_ERROR', message: 'Fallo desconocido durante el refresco.', httpStatus: 0 };
}

/**
 * Envía la petición con `credentials: 'include'` (cookie HttpOnly `__Host-oa_rt`),
 * `Content-Type` solo cuando hay cuerpo y Bearer solo si hay token en RAM (salvo anónimo).
 * Un fallo de red no abortado se convierte en `BackendHttpError`; el aborto se propaga.
 */
async function sendRequest(path: string, options: BackendRequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const serializedBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const requestHeaders: Record<string, string> = { ...(options.headers ?? {}) };
  if (serializedBody !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  const token = options.anonymous === true ? null : getAccessToken();
  if (token !== null) {
    requestHeaders['Authorization'] = `Bearer ${token}`;
  }
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      method, credentials: 'include', headers: requestHeaders,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
  } catch (caughtFailure) {
    if (caughtFailure instanceof Error && caughtFailure.name === 'AbortError') {
      throw caughtFailure;
    }
    throw new BackendHttpError(
      NETWORK_ERROR_MESSAGE, 'INTERNAL_ERROR', 0, 'INFO',
      { path, cause: caughtFailure instanceof Error ? caughtFailure.message : 'UNKNOWN_CAUSE' },
    );
  }
}

/** Lee el cuerpo JSON del éxito; 204 o cuerpo vacío devuelven `undefined` como `T`. */
async function readSuccessBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const rawBody = await response.text();
  return rawBody.length === 0 ? (undefined as T) : (JSON.parse(rawBody) as T);
}

/**
 * Construye el error tipado desde la respuesta fallida.
 * Acepta el sobre reducido del borde (`{ error: { code, message } }`) y completa los campos
 * ausentes con el estado HTTP y una severidad informativa, de modo que el mensaje y el código
 * de negocio del backend llegan intactos a la interfaz.
 */
async function buildFailure(response: Response, path: string): Promise<BackendHttpError> {
  const rawBody = await response.text();
  let parsedPayload: unknown = null;
  try {
    parsedPayload = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
  } catch {
    parsedPayload = null;
  }
  if (isBackendErrorEnvelope(parsedPayload)) {
    const envelopeError = parsedPayload.error;
    return new BackendHttpError(
      envelopeError.message,
      envelopeError.code,
      typeof envelopeError.httpStatus === 'number' ? envelopeError.httpStatus : response.status,
      isAuditSeverity(envelopeError.auditSeverity) ? envelopeError.auditSeverity : 'INFO',
      isRecord(envelopeError.details) ? envelopeError.details : { path },
    );
  }
  return new BackendHttpError(
    GENERIC_ERROR_MESSAGE, synthesizeErrorCode(response.status), response.status,
    'INFO', { path, source: 'SYNTHESIZED_ENVELOPE' },
  );
}

/*
 * NOTA DE INTEGRACIÓN (PENDIENTE_DE_IA2, registrada en el Ledger Live): la cookie HttpOnly
 * `__Host-oa_rt` aún no es leída por `POST /api/v1/auth/refresh` (IA #2). Este cliente ya
 * envía `credentials: 'include'` y cuerpo vacío `{}`, y reanudará la sesión al leerla el backend.
 */

/** Promesa de refresco compartida a nivel de módulo: garantiza single-flight de la cola. */
let refreshInFlight: Promise<AuthRefreshSuccessDto> | null = null;

/** Ejecuta el refresco reutilizando la promesa en vuelo compartida por los 401 concurrentes. */
async function performSilentRefresh(): Promise<AuthRefreshSuccessDto> {
  if (refreshInFlight === null) {
    refreshInFlight = backendFetch<AuthRefreshSuccessDto>(AUTH_REFRESH_PATH, {
      method: 'POST', body: {}, anonymous: true, noRefreshRetry: true,
    }).finally(() => {
      refreshInFlight = null;
    });
  }
  return await refreshInFlight;
}

/**
 * Ejecuta una petición JSON contra el plano de control y devuelve el cuerpo tipado `T`.
 * Ante 401 realiza un refresco silencioso single-flight y reintenta UNA sola vez; si el
 * refresco falla, limpia el token, emite SESSION_EXPIRED y relanza el 401 original.
 */
export async function backendFetch<T>(path: string, options: BackendRequestOptions = {}): Promise<T> {
  const response = await sendRequest(path, options);
  if (response.ok) {
    return await readSuccessBody<T>(response);
  }
  const failure = await buildFailure(response, path);
  emitFailureEvent(failure, path);
  const canAttemptRefresh = failure.code === 'UNAUTHORIZED'
    && options.noRefreshRetry !== true && path !== AUTH_REFRESH_PATH;
  if (!canAttemptRefresh) {
    throw failure;
  }
  let refreshedSession: AuthRefreshSuccessDto;
  try {
    refreshedSession = await performSilentRefresh();
  } catch (refreshFailure) {
    setAccessToken(null);
    emitHttpEvent(HTTP_CLIENT_EVENT_NAMES.SESSION_EXPIRED, {
      path,
      failure: describeFailureDetail(refreshFailure),
    });
    throw failure;
  }
  setAccessToken(refreshedSession.accessToken);
  return await backendFetch<T>(path, { ...options, noRefreshRetry: true });
}
