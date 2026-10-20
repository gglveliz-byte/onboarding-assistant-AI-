/**
 * @archivo src/modules/07-public-commercial-and-sandbox/infrastructure/public-demo-session.reader.ts
 * @modulo 07-public-commercial-and-sandbox (Lectura de Sesiones y Tokens de Demostracion Publica)
 * @proposito
 *   Expone la lectura NO destructiva de los descriptores efimeros de la demostracion publica
 *   (`oa:demo:*`) para que el borde que atiende el socket de voz pueda validar una apertura antes de
 *   consumir su token de un solo uso. El descriptor lo escribe `CreatePublicLiveDemoSessionUseCase`
 *   con claves literales; este lector replica exactamente las mismas claves sobre la misma instancia
 *   de Redis porque una discrepancia de prefijo aqui invalidaria todas las demostraciones.
 *
 * @resumen_contenido
 *   - Interface `PublicDemoSessionRecord`: forma del descriptor persistido por el Módulo 07.
 *   - Constantes `PUBLIC_DEMO_SESSION_KEY_PREFIX` y `PUBLIC_DEMO_TOKEN_KEY_PREFIX`.
 *   - Funciones `readPublicDemoSessionById()` y `readPublicDemoToken()`: lecturas tolerantes a fallos.
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (`../../../shared/infrastructure/redis/redis-cluster.client`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:demo:session:<sessionId>` y `oa:demo:token:<ephemeralToken>` (TTL =
 *     `maxDurationSeconds` + 30, con
 *     `isDemo: true`, `ephemeralToken`, `maxDurationSeconds` y `expiresAtIso`).
 */

import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';

/** Descriptor efimero de una sesion de demostracion publica persistido en Redis. */
export interface PublicDemoSessionRecord {
  /** Identificador efimero de la sesion (`demo_<token>`). */
  readonly sessionId: string;
  /** Direccion IP del visitante, registrada solo para el control de frecuencia por IP. */
  readonly clientIp: string;
  /** Hash SHA-256 de la IP, usado como sujeto del limitador. */
  readonly clientIpHash: string;
  /** Modelo de voz preferido declarado por el visitante. */
  readonly voiceModel: string;
  /** Token efimero de un solo uso que la URL del socket entrega como `nonce`. */
  readonly ephemeralToken: string;
  /** Duracion maxima declarada de la demostracion, en segundos. */
  readonly maxDurationSeconds: number;
  /** Instante de caducidad del descriptor, en formato ISO 8601. */
  readonly expiresAtIso: string;
  /** Marca que distingue el descriptor de demostracion de cualquier otro estado de Redis. */
  readonly isDemo: true;
}

/** Prefijo literal de las claves de sesion de demostracion (le espeja al emisor del Modulo 07). */
export const PUBLIC_DEMO_SESSION_KEY_PREFIX = 'oa:demo:session:';

/** Prefijo literal de las claves de token de demostracion (le espeja al emisor del Modulo 07). */
export const PUBLIC_DEMO_TOKEN_KEY_PREFIX = 'oa:demo:token:';

/**
 * Lee el descriptor de una sesion de demostracion por su identificador, sin consumir la clave.
 *
 * @param redisClient - Cliente unico de Redis de la plataforma.
 * @param sessionId - Identificador efimero de la sesion.
 * @returns Descriptor vigente, o `null` cuando no existe o Redis no responde (rechazo en falso).
 */
export async function readPublicDemoSessionById(
  redisClient: RedisClusterClient,
  sessionId: string
): Promise<PublicDemoSessionRecord | null> {
  if (sessionId.length === 0) {
    return null;
  }
  try {
    return await redisClient.json.getJson<PublicDemoSessionRecord>(
      `${PUBLIC_DEMO_SESSION_KEY_PREFIX}${sessionId}`
    );
  } catch {
    // Fail-closed: sin Redis no hay forma de validar la sesion anonima y la conexion se rechaza.
    return null;
  }
}

/**
 * Lee el descriptor asociado a un token efimero de demostracion, sin consumirlo.
 * El consumo atomico de un solo uso ocurre despues, en el handshake del gateway de voz.
 *
 * @param redisClient - Cliente unico de Redis de la plataforma.
 * @param ephemeralToken - Token efimero emitido por el Modulo 07.
 * @returns Descriptor vigente, o `null` cuando no existe o Redis no responde.
 */
export async function readPublicDemoToken(
  redisClient: RedisClusterClient,
  ephemeralToken: string
): Promise<PublicDemoSessionRecord | null> {
  if (ephemeralToken.length === 0) {
    return null;
  }
  try {
    return await redisClient.json.getJson<PublicDemoSessionRecord>(
      `${PUBLIC_DEMO_TOKEN_KEY_PREFIX}${ephemeralToken}`
    );
  } catch {
    return null;
  }
}
