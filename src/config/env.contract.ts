/**
 * @archivo src/config/env.contract.ts
 * @modulo 00-foundations (Contrato Tipado y Catalogos Cerrados de Configuracion de Entorno)
 * @proposito
 *   Define los catalogos cerrados del sistema (roles de Node Pool, entornos de ejecucion y
 *   niveles de log), el tipo inmutable `AppEnvironment` que consume toda la plataforma y la
 *   lista de claves cuyo valor jamas puede registrarse en logs. Es el contrato publico que
 *   los otros 71 archivos del backend importan para tipar la configuracion.
 *
 * @resumen_contenido
 *   - Constantes `NODE_POOL_ROLES`, `LOG_LEVELS`, `NODE_ENVIRONMENTS` y `SECRET_ENVIRONMENT_KEYS`.
 *   - Constante `CONNECTION_IDENTITY_ENVIRONMENT_KEYS`: las dos identidades de conexion a PostgreSQL
 *     (`DATABASE_URL` de la aplicacion y `DATABASE_OWNER_URL` del propietario) y la regla de
 *     precedencia entorno-sobre-archivo que las gobierna.
 *   - Tipos derivados `NodePoolRole`, `LogLevel`, `NodeEnvironment` y `VoiceProviderPreference`.
 *   - Tipo `AppEnvironment`: Configuracion de entorno validada, normalizada e inmutable.
 *   - Tipo `EnvironmentKey`: Union literal de todas las variables declaradas por el esquema.
 *
 * @dependencias_internas
 *   - Esquema refinado (`./env.zod-schema.ts`) del que se infiere el tipo `AppEnvironment`.
 *
 * @dependencias_externas
 *   - `zod` (Inferencia de tipos a partir del esquema refinado, sin costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Contrato puramente de tipos y constantes).
 */

import type { z } from 'zod';
import type { refinedEnvironmentSchema } from './env.zod-schema';

/** Roles oficiales de los 3 Node Pools del monolito modular. */
export const NODE_POOL_ROLES = ['API_CONTROL_PLANE', 'VOICE_REALTIME_GATEWAY', 'VISUAL_TRAINER_ORCHESTRATOR'] as const;

/** Niveles de log admitidos por el logger estructurado. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Entornos de ejecucion admitidos. */
export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

/**
 * Variables de entorno que declaran la IDENTIDAD DE CONEXION a PostgreSQL.
 *
 * `DATABASE_URL` es la identidad de la APLICACION —su rol no debe poder omitir las politicas RLS— y
 * `DATABASE_OWNER_URL` la del PROPIETARIO, reservada a migraciones y tareas administrativas. Se
 * declaran como catalogo cerrado porque el cargador de `.env` y la auditoria de identidad de
 * conexion (`env.connection-identity.ts`) deben vigilar exactamente el mismo conjunto de claves.
 *
 * Precedencia (doce factores, deliberada y NO reversible): el entorno del proceso SIEMPRE gana al
 * archivo `.env`. Esa regla es correcta en produccion, pero convierte a una variable heredada —por
 * ejemplo un `DATABASE_URL` exportado en la sesion con el rol propietario— en un sustituto silencioso
 * de la identidad declarada. El cargador registra esas sustituciones y esta auditoria las evalua para
 * que el cambio de identidad no pueda pasar inadvertido.
 */
export const CONNECTION_IDENTITY_ENVIRONMENT_KEYS = ['DATABASE_URL', 'DATABASE_OWNER_URL'] as const;

/** Variable de entorno que declara la identidad de conexion de la aplicacion. */
export type ConnectionIdentityEnvironmentKey = (typeof CONNECTION_IDENTITY_ENVIRONMENT_KEYS)[number];

/** Variables de entorno cuyo valor NUNCA debe aparecer en logs, errores ni reportes. */
export const SECRET_ENVIRONMENT_KEYS: readonly string[] = [
  'DATABASE_URL',
  'REDIS_CLUSTER_URLS',
  'WHOP_API_KEY',
  'WHOP_WEBHOOK_SECRET',
  'INTERNAL_CHECKOUT_HMAC_SECRET',
  'QWEN_API_KEY',
  'GEMINI_API_KEY',
  'JWT_EDDSA_PRIVATE_KEY_PEM',
  'JWT_EDDSA_PUBLIC_KEY_PEM',
];

/** Rol del Node Pool que ejecuta el proceso actual. */
export type NodePoolRole = (typeof NODE_POOL_ROLES)[number];

/** Nivel de verbosidad del logger estructurado. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Entorno de ejecucion del proceso. */
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Preferencia del motor de voz que atiende la primera conexion de una sesion. */
export type VoiceProviderPreference = 'QWEN' | 'GEMINI';

/** Contrato tipado e inmutable de la configuracion de entorno ya validada y normalizada. */
export type AppEnvironment = Readonly<z.infer<typeof refinedEnvironmentSchema>>;

/** Union literal con los nombres de todas las variables de entorno declaradas por el esquema. */
export type EnvironmentKey = keyof AppEnvironment;
