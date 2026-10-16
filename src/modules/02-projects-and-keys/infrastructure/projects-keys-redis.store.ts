/**
 * @archivo src/modules/02-projects-and-keys/infrastructure/projects-keys-redis.store.ts
 * @modulo 02-projects-and-keys (Almacen Redis para Claves de API, Dominios y Nonces del SDK)
 * @proposito
 *   Centraliza la persistencia efimera en Redis para el contrato de proyectos y claves de API:
 *   - Cache de claves de API activas (`oa:apikey:sha256:<hash>`) para resolucion sub-milisegundo.
 *   - Conjunto indexado de dominios autorizados (`oa:proj:<id>:allowed_domains`).
 *   - Nonces criptograficos de un solo uso para el handshake del SDK (`oa:sdk_handshake:nonce:<jti>`).
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `RedisKeys` (@shared/infrastructure/redis/redis-key-namespaces.ts).
 *   - `ApiKeyEntity`, `AllowedDomainEntity` (../domain/projects-keys.entities.ts).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:apikey:sha256:<hash>`, `oa:proj:<id>:allowed_domains`, `oa:sdk_handshake:nonce:<jti>`.
 */

import { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../../shared/infrastructure/redis/redis-key-namespaces';
import type { ApiKeyEntity, AllowedDomainEntity } from '../domain/projects-keys.entities';

/** Almacen en Redis de claves, dominios autorizados y nonces del handshake SDK. */
export class ProjectsKeysRedisStore {
  /** Almacen en memoria volatil de degradacion para nonces cuando Redis esta inaccesible (C1-60). */
  private readonly fallbackNonces = new Map<string, { readonly payload: string; readonly expiresAt: number }>();

  public constructor(
    private readonly redisClient: RedisClusterClient,
    private readonly redisPrefix: string = 'oa'
  ) {}

  /**
   * Almacena una clave de API en cache para resolucion sub-milisegundo.
   *
   * La clave de cache incluye la **organizacion propietaria**: una cache global no pasa por la
   * seguridad a nivel de fila, de modo que segmentarla es lo que mantiene vigente el aislamiento
   * multi-tenant cuando la respuesta se sirve desde Redis en lugar de PostgreSQL.
   */
  public async cacheApiKey(key: ApiKeyEntity): Promise<void> {
    try {
      const cacheKey = RedisKeys.apiKeyBySha256ForOrganization(this.redisPrefix, key.organizationId, key.keyHash);
      await this.redisClient.json.setJson(cacheKey, key, 3600);
    } catch {
      // Degradacion silenciosa: si Redis esta caido, las claves se resuelven en PostgreSQL
    }
  }

  /**
   * Obtiene una clave de API desde cache deserializando fechas.
   *
   * @param keyHash - Resumen SHA-256 de la clave.
   * @param organizationId - Organizacion propietaria resuelta de forma autoritativa. Es obligatoria
   *   porque la cache esta segmentada por organizacion y, ademas, permite **comprobar** que la entrada
   *   devuelta le pertenece: si no coincidiera, se descarta en lugar de servirse.
   */
  public async getCachedApiKey(keyHash: string, organizationId: string): Promise<ApiKeyEntity | null> {
    try {
      const cacheKey = RedisKeys.apiKeyBySha256ForOrganization(this.redisPrefix, organizationId, keyHash);
      const cached = await this.redisClient.json.getJson<ApiKeyEntity>(cacheKey);
      if (!cached) {
        return null;
      }
      if (cached.organizationId !== organizationId) {
        // Defensa en profundidad: aunque la clave de cache ya segmenta por organizacion, una entrada
        // manipulada o migrada desde el formato global anterior no debe servirse nunca.
        return null;
      }
      return {
        ...cached,
        createdAt: new Date(cached.createdAt),
        gracePeriodEndsAt: cached.gracePeriodEndsAt ? new Date(cached.gracePeriodEndsAt) : null,
        expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
        revokedAt: cached.revokedAt ? new Date(cached.revokedAt) : null,
        lastUsedAt: cached.lastUsedAt ? new Date(cached.lastUsedAt) : null,
      };
    } catch {
      // Si Redis esta caido, se degrada a PostgreSQL retornando null (C1-60)
      return null;
    }
  }

  /** Elimina una clave de API de la cache de Redis ante revocacion. */
  public async removeCachedApiKey(keyHash: string): Promise<void> {
    try {
      const cacheKey = RedisKeys.apiKeyBySha256(this.redisPrefix, keyHash);
      await this.redisClient.keys.remove(cacheKey);
    } catch {
      // Degradacion silenciosa ante fallo de Redis
    }
  }

  /** Sincroniza la lista de dominios permitidos de un proyecto en Redis. */
  public async syncProjectDomains(projectId: string, domains: readonly AllowedDomainEntity[]): Promise<void> {
    try {
      const setKey = RedisKeys.projectAllowedDomains(this.redisPrefix, projectId);
      await this.redisClient.keys.remove(setKey);
      for (const d of domains) {
        const serial = JSON.stringify({ pattern: d.originPattern, allowLocalhost: d.allowLocalhostDev });
        await this.redisClient.counters.addToSet(setKey, serial, 86400);
      }
    } catch {
      // Degradacion silenciosa ante caida de Redis
    }
  }

  /** Obtiene la lista cacheada de dominios de un proyecto desde Redis. */
  public async getCachedProjectDomains(
    projectId: string
  ): Promise<readonly { pattern: string; allowLocalhost: boolean }[] | null> {
    try {
      const setKey = RedisKeys.projectAllowedDomains(this.redisPrefix, projectId);
      const members = await this.redisClient.counters.listSet(setKey);
      if (members.length === 0) {
        return null;
      }
      return members.map((m) => JSON.parse(m) as { pattern: string; allowLocalhost: boolean });
    } catch {
      // Si Redis esta caido, retorna null para degradar la lectura a PostgreSQL de inmediato (C1-60)
      return null;
    }
  }

  /** Guarda un nonce de handshake de un solo uso en Redis con TTL de 60 segundos. */
  public async storeHandshakeNonce(nonceId: string, payload: string, ttlSeconds: number = 60): Promise<boolean> {
    try {
      const key = RedisKeys.sdkHandshakeNonce(this.redisPrefix, nonceId);
      const ok = await this.redisClient.keys.setIfAbsent(key, payload, ttlSeconds);
      if (ok) {
        return true;
      }
    } catch {
      // Si Redis falla, se persiste en el mapa en memoria de degradacion
    }
    this.cleanExpiredNonces();
    this.fallbackNonces.set(nonceId, { payload, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  /**
   * Consume de forma atomica un nonce de handshake: lee su valor y lo borra en una sola operacion.
   *
   * Utiliza un script Lua ejecutado en Redis para garantizar que dos peticiones concurrentes
   * sobre el mismo identificador de nonce jamas reciban el payload simultaneamente (C1-01).
   */
  public async consumeHandshakeNonce(nonceId: string): Promise<string | null> {
    try {
      const key = RedisKeys.sdkHandshakeNonce(this.redisPrefix, nonceId);
      const LUA_ATOMIC_GETDEL = `
        local val = redis.call('GET', KEYS[1])
        if val then
          redis.call('DEL', KEYS[1])
        end
        return val
      `;
      const val = await this.redisClient.runScript(LUA_ATOMIC_GETDEL, [key], []);
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
    } catch {
      // Si Redis falla o esta inaccesible, se consulta el almacen en memoria
    }
    this.cleanExpiredNonces();
    const entry = this.fallbackNonces.get(nonceId);
    if (!entry) {
      return null;
    }
    this.fallbackNonces.delete(nonceId);
    if (Date.now() > entry.expiresAt) {
      return null;
    }
    return entry.payload;
  }

  /** Limpia entradas expiradas del almacen en memoria volatil. */
  private cleanExpiredNonces(): void {
    const now = Date.now();
    for (const [key, entry] of this.fallbackNonces.entries()) {
      if (now > entry.expiresAt) {
        this.fallbackNonces.delete(key);
      }
    }
  }
}
