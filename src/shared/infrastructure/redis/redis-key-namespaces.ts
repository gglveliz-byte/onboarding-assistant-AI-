/**
 * @archivo src/shared/infrastructure/redis/redis-key-namespaces.ts
 * @modulo 00-kernel (Contrato Unico de Claves, Canales y Streams de Redis)
 * @proposito
 *   Declara en un solo lugar TODOS los namespaces de Redis de la plataforma. Prohibido escribir
 *   una clave literal (`"auth:user_tv:" + id`) dentro de un modulo de negocio: cualquier clave
 *   debe construirse con las funciones de este archivo. Esta concentracion evita colisiones de
 *   nombres entre modulos construidos por agentes distintos, permite auditar que claves existen
 *   y hace posible cambiar el prefijo global sin tocar un solo caso de uso.
 *
 * @resumen_contenido
 *   - Constantes `REDIS_KEY_SEPARATOR` y `DEFAULT_KEY_PREFIX`.
 *   - Tipo `TokenBucketPolicyCode` con las 8 politicas de cuota preconfiguradas.
 *   - Objeto `RedisKeys`: Constructores tipados de cada clave de la arquitectura.
 *   - Objeto `RedisChannels`: Canales de Pub/Sub para eventos entre nodos.
 *   - Objeto `RedisStreams`: Claves de Streams para el registro duradero de eventos.
 *
 * @dependencias_internas
 *   - Ninguna (Contrato puro de cadenas: sin dependencias de ejecucion).
 *
 * @dependencias_externas
 *   - Ninguna (Cero dependencias; se importa desde cualquier capa).
 *
 * @tablas_bd_o_redis
 *   - Redis: define el nombre exacto de cada clave, canal y stream del sistema.
 */

/** Separador oficial de los segmentos de una clave de Redis. */
export const REDIS_KEY_SEPARATOR = ':';

/** Prefijo por omision de todas las claves de la plataforma. */
export const DEFAULT_KEY_PREFIX = 'oa';

/**
 * Codigos de las 8 politicas de cuota preconfiguradas del sistema.
 * Cada codigo identifica una combinacion de capacidad y velocidad de recarga.
 */
export type TokenBucketPolicyCode =
  | 'AUTH_BY_IP'
  | 'AUTH_FAILURES_BY_ACCOUNT'
  | 'DASHBOARD_JWT'
  | 'SDK_HANDSHAKE_BY_IP'
  | 'SDK_HANDSHAKE_GLOBAL_BY_PROJECT'
  | 'SECRET_KEY'
  | 'VISUAL_TRAINER'
  | 'WS_CONTROL';

/**
 * Aplica el prefijo global a una clave ya compuesta.
 *
 * @param prefix - Prefijo global configurado en el entorno.
 * @param key - Clave sin prefijo.
 * @returns Clave final con prefijo aplicado.
 */
function withPrefix(prefix: string, key: string): string {
  return `${prefix}${REDIS_KEY_SEPARATOR}${key}`;
}

/** Constructores tipados de todas las claves de Redis de la plataforma. */
export const RedisKeys = Object.freeze({
  /**
   * Version de token vigente de un usuario, usada para la revocacion instantanea de sesiones.
   *
   * @param prefix - Prefijo global de claves.
   * @param userId - Identificador del usuario.
   * @returns Clave `auth:user_tv:<user_id>`.
   */
  authUserTokenVersion: (prefix: string, userId: string): string => withPrefix(prefix, `auth:user_tv:${userId}`),

  /**
   * Indice de validacion de una clave de API por su digest SHA-256.
   *
   * @param prefix - Prefijo global de claves.
   * @param sha256Hash - Digest SHA-256 hexadecimal de la clave cruda.
   * @returns Clave `apikey:sha256:<hash>`.
   */
  apiKeyBySha256: (prefix: string, sha256Hash: string): string => withPrefix(prefix, `apikey:sha256:${sha256Hash}`),

  /**
   * Lista cacheada de origenes autorizados de un proyecto.
   *
   * @param prefix - Prefijo global de claves.
   * @param projectId - Identificador del proyecto.
   * @returns Clave `proj:<id>:allowed_domains`.
   */
  projectAllowedDomains: (prefix: string, projectId: string): string => withPrefix(prefix, `proj:${projectId}:allowed_domains`),

  /**
   * Clave de API cacheada, **segmentada por organizacion propietaria**.
   *
   * La segmentacion por organizacion es obligatoria, no una preferencia de estilo. La variante sin
   * organizacion (`apiKeyBySha256`) es una clave **global**, y una lectura desde una cache global
   * **no pasa por la seguridad a nivel de fila**: si dos organizaciones tuvieran entradas accesibles
   * bajo el mismo resumen, la cache devolveria la de la otra. Incluir la organizacion en la clave
   * hace que el aislamiento multi-tenant siga vigente incluso cuando la respuesta viene de Redis.
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Organizacion propietaria de la clave.
   * @param sha256Hash - Resumen SHA-256 de la clave.
   * @returns Clave `apikey:org:<id>:sha256:<hash>`.
   */
  apiKeyBySha256ForOrganization: (prefix: string, organizationId: string, sha256Hash: string): string =>
    withPrefix(prefix, `apikey:org:${organizationId}:sha256:${sha256Hash}`),

  /**
   * Metadatos del Mapa Funcional RAG activo de un proyecto, segmentado por organizacion (C1-46).
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Organizacion propietaria del proyecto.
   * @param projectId - Identificador del proyecto.
   * @returns Clave `rag_map:org:<orgId>:proj:<projId>:meta`.
   */
  ragMapMetaForOrganization: (prefix: string, organizationId: string, projectId: string): string =>
    withPrefix(prefix, `rag_map:org:${organizationId}:proj:${projectId}:meta`),

  /**
   * Indice de rutas del Mapa Funcional RAG activo de un proyecto, segmentado por organizacion (C1-46).
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Organizacion propietaria del proyecto.
   * @param projectId - Identificador del proyecto.
   * @returns Clave `rag_map:org:${organizationId}:proj:${projectId}:routes`.
   */
  ragMapRoutesForOrganization: (prefix: string, organizationId: string, projectId: string): string =>
    withPrefix(prefix, `rag_map:org:${organizationId}:proj:${projectId}:routes`),

  /**
   * Metadatos del Mapa Funcional RAG activo de un proyecto (variante historica global).
   *
   * @param prefix - Prefijo global de claves.
   * @param projectId - Identificador del proyecto.
   * @returns Clave `rag_map:proj:<id>:meta`.
   */
  ragMapMeta: (prefix: string, projectId: string): string => withPrefix(prefix, `rag_map:proj:${projectId}:meta`),

  /**
   * Indice de rutas del Mapa Funcional RAG activo de un proyecto (variante historica global).
   *
   * @param prefix - Prefijo global de claves.
   * @param projectId - Identificador del proyecto.
   * @returns Clave `rag_map:proj:<id>:routes`.
   */
  ragMapRoutes: (prefix: string, projectId: string): string => withPrefix(prefix, `rag_map:proj:${projectId}:routes`),

  /**
   * Nonce efimero de un solo uso para el handshake del SDK.
   *
   * @param prefix - Prefijo global de claves.
   * @param nonceId - Identificador unico del nonce (`jti`).
   * @returns Clave `sdk_handshake:nonce:<jti>`.
   */
  sdkHandshakeNonce: (prefix: string, nonceId: string): string => withPrefix(prefix, `sdk_handshake:nonce:${nonceId}`),

  /**
   * Estado serializado de una sesion de voz en tiempo real.
   *
   * @param prefix - Prefijo global de claves.
   * @param voiceSessionId - Identificador de la sesion de voz.
   * @returns Clave `voice_session:state:<id>`.
   */
  voiceSessionState: (prefix: string, voiceSessionId: string): string => withPrefix(prefix, `voice_session:state:${voiceSessionId}`),

  /**
   * Conjunto de sesiones de voz activas de una organizacion.
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Identificador de la organizacion.
   * @returns Clave `org:<id>:active_sessions`.
   */
  organizationActiveSessions: (prefix: string, organizationId: string): string =>
    withPrefix(prefix, `org:${organizationId}:active_sessions`),

  /**
   * Marca de idempotencia de un evento de webhook ya procesado.
   *
   * @param prefix - Prefijo global de claves.
   * @param externalEventId - Identificador del evento emitido por el proveedor de cobros.
   * @returns Clave `whop:webhook:evt:<id>`.
   */
  webhookEventSeen: (prefix: string, externalEventId: string): string => withPrefix(prefix, `whop:webhook:evt:${externalEventId}`),

  /**
   * Marca de idempotencia de un checkout emitido por el backend.
   *
   * @param prefix - Prefijo global de claves.
   * @param checkoutId - Identificador interno del checkout.
   * @returns Clave `checkout:issued:<id>`.
   */
  checkoutIssued: (prefix: string, checkoutId: string): string => withPrefix(prefix, `checkout:issued:${checkoutId}`),

  /**
   * Estado de facturacion en cache de una organizacion.
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Identificador de la organizacion.
   * @returns Clave `org:<id>:billing`.
   */
  organizationBilling: (prefix: string, organizationId: string): string => withPrefix(prefix, `org:${organizationId}:billing`),

  /**
   * Clave del Token Bucket de una politica y un sujeto concretos.
   *
   * @param prefix - Prefijo global de claves.
   * @param policyCode - Codigo de la politica de cuota aplicada.
   * @param subject - Sujeto de la cuota (IP, cuenta, proyecto o sesion).
   * @returns Clave `rl:tb:<politica>:<sujeto>`.
   */
  rateLimitBucket: (prefix: string, policyCode: TokenBucketPolicyCode, subject: string): string =>
    withPrefix(prefix, `rl:tb:${policyCode.toLowerCase()}:${subject}`),

  /**
   * Bloqueo distribuido de corta duracion para operaciones criticas.
   *
   * @param prefix - Prefijo global de claves.
   * @param resource - Recurso protegido por el bloqueo.
   * @returns Clave `lock:<recurso>`.
   */
  distributedLock: (prefix: string, resource: string): string => withPrefix(prefix, `lock:${resource}`),
});

/** Canales de Pub/Sub usados para propagar eventos entre los 3 Node Pools. */
export const RedisChannels = Object.freeze({
  /**
   * Canal global de eventos de dominio publicados por cualquier modulo.
   *
   * @param prefix - Prefijo global de claves.
   * @returns Canal `events:global`.
   */
  globalEvents: (prefix: string): string => withPrefix(prefix, 'events:global'),

  /**
   * Canal de ordenes de gobierno (suspension de tenant, cambio de motor de voz).
   *
   * @param prefix - Prefijo global de claves.
   * @returns Canal `governance:commands`.
   */
  governanceCommands: (prefix: string): string => withPrefix(prefix, 'governance:commands'),

  /**
   * Canal de terminacion inmediata de las sesiones de voz de una organizacion.
   *
   * @param prefix - Prefijo global de claves.
   * @param organizationId - Identificador de la organizacion afectada.
   * @returns Canal `terminate:org:<id>`.
   */
  terminateOrganizationSessions: (prefix: string, organizationId: string): string =>
    withPrefix(prefix, `terminate:org:${organizationId}`),
});

/** Claves de Streams usadas para conservar de forma duradera los eventos globales. */
export const RedisStreams = Object.freeze({
  /**
   * Stream duradero con el historial de eventos de dominio.
   *
   * @param prefix - Prefijo global de claves.
   * @returns Stream `events:stream`.
   */
  domainEvents: (prefix: string): string => withPrefix(prefix, 'events:stream'),
});
