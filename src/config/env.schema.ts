/**
 * @archivo src/config/env.schema.ts
 * @modulo 00-foundations (Punto Unico de Validacion y Acceso a la Configuracion de Entorno)
 * @proposito
 *   Es la UNICA puerta autorizada de lectura de variables de entorno del backend. Ninguna
 *   clase, caso de uso, adaptador o entrypoint puede consultar `process.env` directamente:
 *   todos deben consumir `getEnvConfig()`. La validacion es estricta y falla cerrado, de modo
 *   que el proceso aborta con un listado en espanol de los incumplimientos exactos en lugar de
 *   arrancar con credenciales incompletas, debiles o inseguras.
 *
 * @resumen_contenido
 *   - Funcion `getEnvConfig()`: Validacion perezosa y memoizada del entorno del proceso.
 *   - Funcion `resetEnvConfigCache()`: Invalida la memoria de validacion (pruebas y reinicios).
 *   - Funcion `isProductionRuntime()`: Indica si el proceso corre en produccion.
 *   - Funcion `describeConnectionIdentity()`: Hallazgos de identidad de conexion del entorno resuelto.
 *   - Funcion `summarizeEnvConfig()`: Radiografia segura que nunca expone valores secretos.
 *   - Re-exportaciones: catalogos, tipos de contrato, cargador `.env` y esquemas Zod.
 *
 * @dependencias_internas
 *   - `loadDotEnvFile()` y `getShadowedEnvironmentDeclarations()` (`./env.dotenv-loader.ts`).
 *   - `refinedEnvironmentSchema` (`./env.zod-schema.ts`) para validar y normalizar.
 *   - `buildConnectionIdentityFindings()` (`./env.connection-identity.ts`) para la auditoria de
 *     identidad de conexion: aviso imposible de silenciar y negativa a arrancar en produccion.
 *   - Catalogos y tipos (`./env.contract.ts`) re-exportados como contrato publico del modulo.
 *
 * @dependencias_externas
 *   - `zod` (Consumido indirectamente a traves del esquema refinado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: expone la configuracion de conexion validada (`DATABASE_URL`, pool y timeouts).
 *   - Redis: expone la lista normalizada de nodos (`REDIS_CLUSTER_URLS`) y su prefijo de claves.
 */

import {
  assertNoBlockingConnectionIdentityFinding,
  buildConnectionIdentityFindings,
  emitConnectionIdentityAlert,
  parseConnectionRoleIdentity,
  type ConnectionIdentityFinding,
} from './env.connection-identity';
import { getShadowedEnvironmentDeclarations, loadDotEnvFile } from './env.dotenv-loader';
import { LOG_LEVELS, NODE_ENVIRONMENTS, NODE_POOL_ROLES, SECRET_ENVIRONMENT_KEYS, type AppEnvironment } from './env.contract';
import { DECLARED_ENVIRONMENT_KEYS, refinedEnvironmentSchema } from './env.zod-schema';

export { loadDotEnvFile, hasEnvironmentValue, getShadowedEnvironmentDeclarations } from './env.dotenv-loader';
export {
  buildConnectionIdentityFindings,
  formatConnectionIdentityBanner,
  parseConnectionRoleIdentity,
  type ConnectionIdentityFinding,
  type ConnectionIdentityFindingCode,
  type ConnectionIdentitySeverity,
  type ConnectionRoleIdentity,
} from './env.connection-identity';
export {
  CONNECTION_IDENTITY_ENVIRONMENT_KEYS,
  LOG_LEVELS,
  NODE_ENVIRONMENTS,
  NODE_POOL_ROLES,
  SECRET_ENVIRONMENT_KEYS,
  type AppEnvironment,
  type ConnectionIdentityEnvironmentKey,
  type EnvironmentKey,
  type LogLevel,
  type NodeEnvironment,
  type NodePoolRole,
  type VoiceProviderPreference,
} from './env.contract';
export {
  DECLARED_ENVIRONMENT_KEYS,
  absoluteUrlSchema,
  booleanFromEnvironmentSchema,
  decodePemKey,
  dnsResolverAddressSchema,
  isValidPemKey,
  networkPortSchema,
  rawEnvironmentSchema,
  redisNodeUrlSchema,
  refinedEnvironmentSchema,
  strongSecretSchema,
  webSocketUrlSchema,
} from './env.zod-schema';

/** Marcador textual con el que se enmascaran los valores sensibles en la radiografia. */
const REDACTION_PLACEHOLDER = '***REDACTADO***';

/** Prefijo comun de los valores enmascarados de la radiografia de entorno. */
const REDACTION_PREFIX = `${REDACTION_PLACEHOLDER}: `;

/** Memoria perezosa de la configuracion validada (una sola validacion por proceso). */
let cachedEnvironment: AppEnvironment | undefined;

/**
 * Valida el entorno del proceso y devuelve la configuracion tipada e inmutable.
 * Si alguna variable falta o es invalida, lanza un error con el listado completo de
 * incumplimientos en espanol y el proceso debe abortar sin continuar su arranque.
 *
 * Antes de devolver la configuracion audita la identidad de conexion a PostgreSQL: si el entorno
 * heredado sustituyo la identidad declarada en el archivo, o si la identidad de la aplicacion es la
 * del propietario declarado, el aviso se escribe en la salida de error estandar (imposible de
 * silenciar con el nivel de log) y en produccion el arranque se aborta con
 * `IDENTIDAD_CONEXION_BLOQUEANTE`. Es la unica forma de que la desactivacion silenciosa de las
 * politicas RLS deje de ser invisible para el propio sistema.
 *
 * @returns Configuracion de entorno inmutable y tipada.
 */
export function getEnvConfig(): AppEnvironment {
  if (cachedEnvironment !== undefined) {
    return cachedEnvironment;
  }

  loadDotEnvFile();
  const parsed = refinedEnvironmentSchema.safeParse(process.env);

  if (!parsed.success) {
    const detailedIssues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `CONFIGURACION_ENTORNO_INVALIDA: el proceso no puede arrancar con la configuracion actual.\n${detailedIssues}`
    );
  }

  const connectionIdentityFindings = collectConnectionIdentityFindings(parsed.data);
  emitConnectionIdentityAlert(connectionIdentityFindings, parsed.data.NODE_ENV);
  assertNoBlockingConnectionIdentityFinding(connectionIdentityFindings);

  cachedEnvironment = Object.freeze(parsed.data);
  return cachedEnvironment;
}

/**
 * Reune los hallazgos de identidad de conexion de una configuracion ya validada, incorporando el
 * ledger de sustituciones que el cargador de `.env` registro en su ultima lectura.
 *
 * @param environment - Configuracion de entorno validada y normalizada.
 * @returns Hallazgos inmutables, vacios cuando la identidad de conexion es inequivoca y segura.
 */
function collectConnectionIdentityFindings(environment: AppEnvironment): readonly ConnectionIdentityFinding[] {
  return buildConnectionIdentityFindings({
    databaseUrl: environment.DATABASE_URL,
    ownerUrl: environment.DATABASE_OWNER_URL,
    environmentName: environment.NODE_ENV,
    shadowedDeclarations: getShadowedEnvironmentDeclarations(),
  });
}

/**
 * Describe los hallazgos de identidad de conexion del entorno ya resuelto, para diagnostico y para
 * verificacion automatizada: permite exigir desde una prueba que la ambiguedad peligrosa se detecte.
 *
 * @returns Hallazgos inmutables de identidad de conexion del proceso actual.
 */
export function describeConnectionIdentity(): readonly ConnectionIdentityFinding[] {
  return collectConnectionIdentityFindings(getEnvConfig());
}

/**
 * Invalida la memoria de validacion para forzar una nueva lectura del entorno.
 * Se usa exclusivamente en pruebas automatizadas y en reinicios controlados del pool.
 */
export function resetEnvConfigCache(): void {
  cachedEnvironment = undefined;
}

/**
 * Indica si el proceso se ejecuta en el entorno de produccion.
 *
 * @returns `true` cuando `NODE_ENV` vale `production`.
 */
export function isProductionRuntime(): boolean {
  return getEnvConfig().NODE_ENV === 'production';
}

/**
 * Enmascara un valor sensible conservando unicamente su longitud, para permitir
 * diagnosticar presencia y tamano de un secreto sin revelar su contenido.
 *
 * @param value - Valor de configuracion a enmascarar.
 * @returns Cadena enmascarada o la marca `AUSENTE` cuando no hay valor.
 */
function maskSensitiveValue(value: string): string {
  if (value.length === 0) {
    return 'AUSENTE';
  }
  return `${REDACTION_PREFIX}${value.length} caracteres`;
}

/**
 * Genera una radiografia segura de la configuracion para diagnostico y verificacion de
 * arranque: informa presencia, forma y cardinalidad de cada grupo sin revelar secretos.
 *
 * @returns Listado inmutable de cadenas legibles con el estado de cada grupo funcional.
 */
export function summarizeEnvConfig(): readonly string[] {
  const environment = getEnvConfig();
  const eddsaStatus = environment.JWT_EDDSA_PRIVATE_KEY_PEM === undefined ? 'AUSENTE (solo permitido fuera de produccion)' : 'PRESENTE';
  const connectionIdentityFindings = collectConnectionIdentityFindings(environment);
  const applicationRole = parseConnectionRoleIdentity(environment.DATABASE_URL);
  const ownerRole = parseConnectionRoleIdentity(environment.DATABASE_OWNER_URL);
  const applicationRoleLabel = applicationRole === null ? 'no interpretable' : applicationRole.roleName;
  const ownerRoleLabel = ownerRole === null ? 'no declarada' : ownerRole.roleName;
  const connectionIdentityStatus =
    connectionIdentityFindings.length === 0
      ? 'sin hallazgos'
      : `${connectionIdentityFindings.length} hallazgo(s): ${connectionIdentityFindings.map((finding) => finding.code).join(', ')}`;

  return [
    `Entorno: ${environment.NODE_ENV} | Node Pool: ${environment.NODE_POOL_ROLE} | Nivel de log: ${environment.LOG_LEVEL}`,
    `PostgreSQL: ${maskSensitiveValue(environment.DATABASE_URL)} | Pool maximo: ${environment.DATABASE_POOL_MAX} | Timeout sentencia: ${environment.DATABASE_STATEMENT_TIMEOUT_MS}ms`,
    `Identidad de conexion: rol de aplicacion "${applicationRoleLabel}" | rol propietario declarado "${ownerRoleLabel}" | ${connectionIdentityStatus}`,
    `Redis: ${environment.REDIS_CLUSTER_URLS.length} nodo(s) | Prefijo de claves: ${environment.REDIS_KEY_PREFIX} | Timeout: ${environment.REDIS_CONNECT_TIMEOUT_MS}ms`,
    `Identidad: par EdDSA ${eddsaStatus} | Access TTL: ${environment.JWT_ACCESS_TOKEN_TTL_SECONDS}s | Piso Argon2id: ${environment.ARGON2_TIMING_FLOOR_MS}ms`,
    `Cobros: ${maskSensitiveValue(environment.WHOP_API_KEY)} | Tolerancia de firma de webhooks: ${environment.WHOP_WEBHOOK_TOLERANCE_SECONDS}s`,
    `Voz: primario ${environment.VOICE_PROVIDER_PRIMARY} | PCM ${environment.VOICE_PCM_SAMPLE_RATE_HZ}Hz | Barge-in: ${environment.VOICE_BARGE_IN_BUDGET_MS}ms | Failover: ${environment.VOICE_PROVIDER_FAILOVER_BUDGET_MS}ms`,
    `Entrenamiento visual: ${environment.CHROMIUM_DMZ_ENDPOINT} | Resolutores DNS: ${environment.EXTERNAL_DNS_RESOLVERS.join(', ')} | Redes privadas: ${environment.SSRF_ALLOW_PRIVATE_NETWORKS}`,
    `Publico: ${environment.PUBLIC_API_BASE_URL} | Demo maxima: ${environment.PUBLIC_DEMO_SESSION_MAX_SECONDS}s | Origenes CORS: ${environment.CORS_ALLOWED_ORIGINS.length}`,
    `Contrato de entorno: ${DECLARED_ENVIRONMENT_KEYS.length} variables declaradas | ${SECRET_ENVIRONMENT_KEYS.length} marcadas como secretas`,
  ];
}
