/**
 * @archivo apps/web/src/components/auth-legal/auth-api-client.ts
 * @modulo apps/web (Cliente Único del Área de Autenticación y Cumplimiento Legal)
 * @proposito
 *   Centraliza toda la comunicación HTTP del área de autenticación B2B contra el plano de
 *   control: un único `authApiFetch()` con Bearer opcional sobre memoria RAM, parseo
 *   defensivo de respuestas, extracción uniforme de códigos de error, cabecera `Retry-After`
 *   y bloqueos temporales de cuenta. Incluye las utilidades puras de sesión: decodificación
 *   del payload del token (sin verificar firma — la verificación real es del servidor),
 *   vencimiento del token, entropía de contraseña, perfil de sesión y espejo de permisos.
 *
 * @resumen_contenido
 *   - Interfaces: `BackendPublicUser`, `BackendPublicOrganization`, `AuthSessionUserProfile`,
 *     `AuthApiResult<T>` y `AuthApiFetchInit` (contratos públicos del área auth).
 *   - `authApiFetch()`: fetch JSON con Bearer opcional y tolerancia a cuerpos no válidos.
 *   - `readApiBaseUrl()`: base relativa por defecto (despliegue same-origin válido).
 *   - `decodeJwtPayloadUnsafe()` / `readTokenExpiryEpochMs()`: lectura del `exp` del token.
 *   - `estimatePasswordEntropyBits()`: medidor de fuerza para el registro (umbral 70 bits).
 *   - `buildSessionProfile()`: perfil de sesión con los permisos del rol activo.
 *   - `ROLE_PERMISSIONS_MIRROR`: espejo de presentación del catálogo RBAC del servidor.
 *
 * @dependencias_internas
 *   - Ninguna (módulo hoja del área auth). Consumido por `useAuthSessionContext.tsx`, la
 *     página de registro y los subagentes 2.3 (login/MFA) y 2.4 (recuperación de cuenta).
 *
 * @dependencias_externas
 *   - Ninguna: solo APIs de plataforma (`fetch`, `atob` con respaldo global, `JSON`, `Math`).
 *
 * @notas
 *   - El token JAMÁS se persiste: vive exclusivamente en memoria (RAM) del cliente; el
 *     espejo de permisos es solo gating de UI y la autoridad de seguridad es el servidor.
 */

/** Proyección pública de usuario (lista blanca explícita del backend, sin material sensible). */
export interface BackendPublicUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly emailVerified: boolean;
  readonly mfaTotpEnabled: boolean;
  readonly mfaWebauthnEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

/** Proyección pública de organización que viaja al cliente tras registro, login o renovación. */
export interface BackendPublicOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

/** Perfil de sesión en memoria RAM: identidad, organización, rol, segundo factor y permisos. */
export interface AuthSessionUserProfile {
  readonly userId: string;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly mfaSatisfied: boolean;
  readonly permissions: readonly string[];
}

/** Resultado uniforme: nunca lanza por errores HTTP (red caída = `status: 0`). */
export interface AuthApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryAfterSeconds: number | null;
  readonly lockedUntilIso: string | null;
}

/** Parámetros de `authApiFetch`: método, cuerpo JSON, Bearer (solo memoria) y credenciales. */
export interface AuthApiFetchInit {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly credentialsMode?: 'same-origin' | 'include';
}

/** Determina si un valor desconocido es un registro JSON indexable (ni arreglo ni `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Devuelve la primera cadena no vacía de la lista de candidatos, o `null` si no hay ninguna. */
function readFirstStringValue(candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Lee la base de la API desde el entorno público del despliegue; se accede por índice porque
 * la compilación estricta activa `noPropertyAccessFromIndexSignature` (base relativa por defecto).
 *
 * @returns Base de URL configurada, o cadena vacía para despliegues same-origin.
 */
export function readApiBaseUrl(): string {
  if (typeof process === 'undefined') {
    return '';
  }
  return process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';
}

/** Parsea el cuerpo JSON de una respuesta sin lanzar: cuerpo vacío o inválido devuelve `null`. */
async function readJsonPayloadSafely(response: Response): Promise<unknown> {
  try {
    const rawText = await response.text();
    if (rawText.length === 0) {
      return null;
    }
    const parsedPayload: unknown = JSON.parse(rawText);
    return parsedPayload;
  } catch {
    return null;
  }
}

/**
 * Extrae `errorCode`/`errorMessage` de los cuerpos de error del plano de control, que pueden
 * llegar como `{ code, message }`, `{ errorCode, message }` o `{ error: { code, message } }`.
 */
function extractErrorInformation(payload: unknown): {
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
} {
  if (!isRecord(payload)) {
    return { errorCode: null, errorMessage: null };
  }
  const nestedError = payload['error'];
  const nestedRecord = isRecord(nestedError) ? nestedError : null;
  const nestedCode = nestedRecord === null ? null : nestedRecord['code'];
  const nestedMessage = nestedRecord === null ? null : nestedRecord['message'];
  const errorCode = readFirstStringValue([payload['code'], payload['errorCode'], nestedCode]);
  const errorMessage = readFirstStringValue([payload['message'], payload['errorMessage'], nestedMessage]);
  return { errorCode, errorMessage };
}

/**
 * Extrae el instante ISO de desbloqueo (`lockedUntil`), presente en `details.lockedUntil` o
 * en `error.details.lockedUntil` para las respuestas de error anidadas del middleware.
 */
function extractLockedUntilIso(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const nestedError = payload['error'];
  const nestedDetails = isRecord(nestedError) ? nestedError['details'] : null;
  for (const container of [payload['details'], nestedDetails]) {
    if (!isRecord(container)) {
      continue;
    }
    const lockedUntil = container['lockedUntil'];
    if (typeof lockedUntil === 'string' && lockedUntil.length > 0) {
      return lockedUntil;
    }
  }
  return null;
}

/** Interpreta `Retry-After` como segundos restantes; `null` si falta o no es entero válido. */
function readRetryAfterSeconds(headers: Headers): number | null {
  const rawHeader = headers.get('retry-after');
  const parsedSeconds = rawHeader === null ? Number.NaN : Number.parseInt(rawHeader.trim(), 10);
  return Number.isFinite(parsedSeconds) && parsedSeconds >= 0 ? parsedSeconds : null;
}

/**
 * Ejecuta una llamada HTTP del área auth con JSON, Bearer opcional y resultado uniforme:
 * `Content-Type`/`Accept` JSON, `Authorization: Bearer` si hay token, `credentials` según
 * `credentialsMode` (por defecto `'same-origin'`) y jamás lanza por errores HTTP.
 *
 * @param path - Ruta relativa del plano de control (por ejemplo `/api/v1/auth/login`).
 * @param init - Método, cuerpo JSON, token y modo de credenciales.
 * @returns Resultado con `data` en el éxito y con código/mensaje/espera/bloqueo en el fallo.
 */
export async function authApiFetch<T>(path: string, init?: AuthApiFetchInit): Promise<AuthApiResult<T>> {
  const method = init?.method ?? 'GET';
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (init?.accessToken !== undefined && init.accessToken.length > 0) {
    requestHeaders['Authorization'] = `Bearer ${init.accessToken}`;
  }
  const serializedBody = init?.body === undefined ? null : JSON.stringify(init.body);

  let response: Response;
  try {
    response = await fetch(`${readApiBaseUrl()}${path}`, {
      method,
      headers: requestHeaders,
      credentials: init?.credentialsMode ?? 'same-origin',
      ...(serializedBody === null ? {} : { body: serializedBody }),
    });
  } catch {
    return {
      ok: false, status: 0, data: null,
      errorCode: 'NETWORK_UNAVAILABLE',
      errorMessage: 'No fue posible contactar al servidor. Revisa tu conexión e inténtalo de nuevo.',
      retryAfterSeconds: null, lockedUntilIso: null,
    };
  }

  const payload = await readJsonPayloadSafely(response);
  const retryAfterSeconds = readRetryAfterSeconds(response.headers);

  if (response.status >= 200 && response.status <= 299) {
    const successData = payload === null || payload === undefined ? null : (payload as T);
    return { ok: true, status: response.status, data: successData, errorCode: null, errorMessage: null, retryAfterSeconds, lockedUntilIso: null };
  }

  const errorInformation = extractErrorInformation(payload);
  return {
    ok: false, status: response.status, data: null,
    errorCode: errorInformation.errorCode, errorMessage: errorInformation.errorMessage,
    retryAfterSeconds, lockedUntilIso: extractLockedUntilIso(payload),
  };
}

/** Forma mínima del descodificador base64 de Node, obtenida de `globalThis` (sin imports). */
interface NodeLikeBase64Decoder {
  from(input: string, encoding: string): { toString(encoding: string): string };
}

/** Convierte base64 a cadena usando `atob` y, si no existe, el descodificador global de Node. */
function decodeBase64ToString(base64Text: string): string {
  if (typeof atob === 'function') {
    return atob(base64Text);
  }
  const nodeLikeBuffer = (globalThis as unknown as { Buffer?: NodeLikeBase64Decoder }).Buffer;
  if (nodeLikeBuffer !== undefined) {
    return nodeLikeBuffer.from(base64Text, 'base64').toString('utf-8');
  }
  throw new Error('La decodificación base64 no está disponible en este entorno.');
}

/**
 * Decodifica el payload de un token JWT SIN verificar la firma (la verificación criptográfica
 * es del servidor): normaliza base64url, rellena el acolchado y devuelve `null` ante cualquier
 * entrada inválida.
 *
 * @param token - Token compacto (`header.payload.signature`).
 * @returns Registro JSON del payload, o `null` si no es decodificable.
 */
export function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) {
    return null;
  }
  const base64Text = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64Text.length % 4)) % 4;
  const paddedBase64Text = base64Text + '='.repeat(paddingLength);
  try {
    const decodedJsonText = decodeBase64ToString(paddedBase64Text);
    const parsedPayload: unknown = JSON.parse(decodedJsonText);
    return isRecord(parsedPayload) ? parsedPayload : null;
  } catch {
    return null;
  }
}

/**
 * Lee el vencimiento (`exp`) del token y lo convierte a milisegundos de época.
 *
 * @param token - Token compacto del que se desea conocer la caducidad.
 * @returns Marca de vencimiento en milisegundos, o `null` si no es legible.
 */
export function readTokenExpiryEpochMs(token: string): number | null {
  const payload = decodeJwtPayloadUnsafe(token);
  if (payload === null) {
    return null;
  }
  const expirySeconds = payload['exp'];
  if (typeof expirySeconds !== 'number' || !Number.isFinite(expirySeconds)) {
    return null;
  }
  return expirySeconds * 1000;
}

/** Tamaños de alfabeto y clases de carácter del estimador de entropía de contraseña. */
const LOWER_CASE_POOL_SIZE = 26;
const UPPER_CASE_POOL_SIZE = 26;
const DIGIT_POOL_SIZE = 10;
const SYMBOL_POOL_SIZE = 32;
const OTHER_CHARACTER_POOL_SIZE = 128;
const LOWER_CASE_PATTERN = /[a-z]/;
const UPPER_CASE_PATTERN = /[A-Z]/;
const DIGIT_PATTERN = /[0-9]/;
const ASCII_SYMBOL_PATTERN = /[!-/:-@\[-\x60{-~]/;
const OTHER_CHARACTER_PATTERN = /[^a-zA-Z0-9!-/:-@\[-\x60{-~]/;

/**
 * Estima la entropía en bits como `longitud × log2(alfabeto)`, ampliando el alfabeto por cada
 * categoría presente: minúsculas (26), mayúsculas (26), dígitos (10), símbolos ASCII (32) y
 * otros caracteres (128).
 *
 * @param password - Contraseña en claro (nunca sale del navegador: solo se mide).
 * @returns Bits de entropía estimados; `0` para la cadena vacía.
 */
export function estimatePasswordEntropyBits(password: string): number {
  if (password.length === 0) {
    return 0;
  }
  let poolSize = 0;
  if (LOWER_CASE_PATTERN.test(password)) {
    poolSize += LOWER_CASE_POOL_SIZE;
  }
  if (UPPER_CASE_PATTERN.test(password)) {
    poolSize += UPPER_CASE_POOL_SIZE;
  }
  if (DIGIT_PATTERN.test(password)) {
    poolSize += DIGIT_POOL_SIZE;
  }
  if (ASCII_SYMBOL_PATTERN.test(password)) {
    poolSize += SYMBOL_POOL_SIZE;
  }
  if (OTHER_CHARACTER_PATTERN.test(password)) {
    poolSize += OTHER_CHARACTER_POOL_SIZE;
  }
  return password.length * Math.log2(poolSize);
}

/**
 * Construye el perfil de sesión en memoria a partir de las proyecciones públicas, el rol y
 * la satisfacción del segundo factor (permisos desde el espejo del rol; lista vacía si es
 * desconocido).
 *
 * @param args - Usuario y organización públicos, rol activo y estado del segundo factor.
 * @returns Perfil de sesión listo para el `AuthSessionProvider` (solo memoria RAM).
 */
export function buildSessionProfile(args: {
  readonly user: BackendPublicUser;
  readonly organization: BackendPublicOrganization | null;
  readonly role: string;
  readonly mfaSatisfied: boolean;
}): AuthSessionUserProfile {
  return {
    userId: args.user.id,
    orgId: args.organization === null ? '' : args.organization.id,
    orgSlug: args.organization === null ? '' : args.organization.slug,
    email: args.user.email,
    fullName: args.user.fullName,
    role: args.role,
    mfaSatisfied: args.mfaSatisfied,
    permissions: ROLE_PERMISSIONS_MIRROR[args.role] ?? [],
  };
}

/** Permisos de gobierno de plataforma, exclusivos del rol SuperAdmin (no los posee OWNER). */
const GOVERNANCE_ADMINISTRATION_PERMISSIONS: readonly string[] = [
  'admin:govern_tenants', 'admin:manage_pricing', 'admin:override_discount',
];

/** Réplica del catálogo de permisos del rol `SUPERADMIN` (los 31 permisos granulares). */
const SUPERADMIN_PERMISSION_MIRROR: readonly string[] = Object.freeze([
  // Organización
  'org:read', 'org:update', 'org:delete',
  // Miembros y gobernanza interna
  'member:read', 'member:invite', 'member:update_role', 'member:remove',
  // Proyectos y entornos
  'project:create', 'project:read', 'project:update', 'project:delete',
  // Claves de API criptográficas
  'apikey:create', 'apikey:read', 'apikey:rotate', 'apikey:revoke',
  // Dominios permitidos
  'domain:create', 'domain:read', 'domain:delete',
  // Entrenamiento visual y mapa RAG
  'trainer:launch', 'trainer:publish_map', 'trainer:read_map', 'trainer:edit_prompt',
  // Facturación y suscripciones
  'billing:read', 'billing:manage_sub', 'billing:export_invoice',
  // Sesiones de voz y telemetría
  'voice:session_read', 'voice:session_kill',
  // Auditoría forense
  'audit:read',
  // Gobierno de plataforma (exclusivo SuperAdmin)
  'admin:govern_tenants', 'admin:manage_pricing', 'admin:override_discount',
]);

/** Réplica del rol `OWNER`: idéntico a SuperAdmin salvo los permisos de gobierno. */
const OWNER_PERMISSION_MIRROR: readonly string[] = Object.freeze(
  SUPERADMIN_PERMISSION_MIRROR.filter(
    (permissionCode) => !GOVERNANCE_ADMINISTRATION_PERMISSIONS.includes(permissionCode),
  ),
);

/** Réplica del rol `DEVELOPER` (16 permisos de construcción y entrenamiento). */
const DEVELOPER_PERMISSION_MIRROR: readonly string[] = Object.freeze([
  'org:read', 'member:read',
  'project:create', 'project:read', 'project:update',
  'apikey:create', 'apikey:read', 'apikey:rotate',
  'domain:create', 'domain:read',
  'trainer:launch', 'trainer:publish_map', 'trainer:read_map', 'trainer:edit_prompt',
  'voice:session_read',
]);

/** Réplica del rol `BILLING` (facturación y lectura básica). */
const BILLING_PERMISSION_MIRROR: readonly string[] = Object.freeze([
  'org:read', 'member:read',
  'billing:read', 'billing:manage_sub', 'billing:export_invoice',
]);

/** Réplica del rol `VIEWER` (solo lectura). */
const VIEWER_PERMISSION_MIRROR: readonly string[] = Object.freeze([
  'org:read', 'member:read',
  'project:read', 'apikey:read', 'domain:read',
  'trainer:read_map', 'billing:read', 'voice:session_read',
]);

/** Tabla interna congelada que relaciona cada rol con su réplica de permisos. */
const ROLE_PERMISSIONS_TABLE: Record<string, readonly string[]> = {
  SUPERADMIN: SUPERADMIN_PERMISSION_MIRROR,
  OWNER: OWNER_PERMISSION_MIRROR,
  DEVELOPER: DEVELOPER_PERMISSION_MIRROR,
  BILLING: BILLING_PERMISSION_MIRROR,
  VIEWER: VIEWER_PERMISSION_MIRROR,
};

/**
 * Espejo de presentación para gating de UI; la autoridad de seguridad es siempre el servidor.
 *
 * Réplica del catálogo `ROLE_PERMISSIONS_MAP` del backend: si el catálogo del servidor cambia,
 * este espejo debe actualizarse en el mismo despliegue. Solo decide qué se muestra u oculta;
 * toda operación real vuelve a autorizarse en el plano de control con el token y sus scopes.
 */
export const ROLE_PERMISSIONS_MIRROR: Readonly<Record<string, readonly string[]>> =
  Object.freeze(ROLE_PERMISSIONS_TABLE);

