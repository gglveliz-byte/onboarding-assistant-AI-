/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/rag-map-redis.store.ts
 * @modulo 03-visual-trainer-and-rag (Almacen Redis Segmentado por Tenant para Mapas RAG)
 * @proposito
 *   Centraliza la persistencia y recuperacion en Redis de metadatos de mapas funcionales e
 *   indices de rutas con aislamiento estricto multi-tenant (C1-46).
 *   - Segmenta todas las claves por organizacion (`rag_map:org:<orgId>:proj:<projId>:*`).
 *   - Aplica revalidacion de esquema estricta con Zod (`cachedRouteMapSchema`) a los datos
 *     deserializados para impedir que caches envenenadas inyecten contenido al motor de voz.
 *   - Pega las consultas de resolucion de ruta a <2ms con proteccion total contra fugas de inquilino.
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `RedisKeys` (@shared/infrastructure/redis/redis-key-namespaces.ts).
 *   - `cachedRouteMapSchema`, `MapElementEntity` (../domain/rag-map.entities.ts).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:rag_map:org:<orgId>:proj:<projId>:meta`, `oa:rag_map:org:<orgId>:proj:<projId>:routes`.
 */

import { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../../shared/infrastructure/redis/redis-key-namespaces';
import {
  cachedRouteMapSchema,
  MapElementEntity,
} from '../domain/rag-map.entities';

/** Metadatos del mapa funcional serializados en cache. */
export interface CachedMapMetadata {
  readonly functionalMapId: string;
  readonly versionNumber: number;
  readonly canonicalSha256: string;
  readonly routes: readonly string[];
  readonly totalElementsCount: number;
  readonly publishedAtIso: string;
}

/**
 * Almacen en Redis para el cacheado veloz de mapas funcionales segmentados por inquilino.
 */
export class RagMapRedisStore {
  public constructor(
    private readonly redisClient: RedisClusterClient,
    private readonly redisPrefix: string = 'oa'
  ) {}

  /**
   * Precalienta en Redis los metadatos y el mapa agrupado por rutas, segmentado por organizacion.
   */
  public async warmUpMapCacheInRedis(
    organizationId: string,
    projectId: string,
    metadata: CachedMapMetadata,
    elementsByRoute: Record<string, readonly MapElementEntity[]>
  ): Promise<void> {
    const metaKey = RedisKeys.ragMapMetaForOrganization(this.redisPrefix, organizationId, projectId);
    const routesKey = RedisKeys.ragMapRoutesForOrganization(this.redisPrefix, organizationId, projectId);

    // 1. Guardar metadatos (TTL 24 horas)
    await this.redisClient.json.setJson(metaKey, metadata, 86400);

    // 2. Guardar rutas agrupadas en un mapa JSON para resolucion en <2ms
    await this.redisClient.json.setJson(routesKey, elementsByRoute, 86400);
  }

  /**
   * Obtiene los metadatos del mapa activo desde Redis con segmentacion por tenant.
   */
  public async getCachedMapMeta(
    organizationId: string,
    projectId: string
  ): Promise<CachedMapMetadata | null> {
    const metaKey = RedisKeys.ragMapMetaForOrganization(this.redisPrefix, organizationId, projectId);
    return this.redisClient.json.getJson<CachedMapMetadata>(metaKey);
  }

  /**
   * Obtiene los elementos indexados por ruta desde Redis con revalidacion estricta de esquema (C1-46).
   *
   * @param organizationId - Organizacion propietaria del proyecto.
   * @param projectId - Identificador unico del proyecto.
   * @param route - Ruta normalizada de la interfaz web.
   * @returns Lista de elementos validados o null si hay fallo de cache o esquema corrupto.
   */
  public async getCachedRouteElements(
    organizationId: string,
    projectId: string,
    route: string
  ): Promise<readonly MapElementEntity[] | null> {
    try {
      const routesKey = RedisKeys.ragMapRoutesForOrganization(this.redisPrefix, organizationId, projectId);
      const raw = await this.redisClient.json.getJson<unknown>(routesKey);
      if (!raw || typeof raw !== 'object') {
        return null;
      }

      // Revalidacion estricta con esquema Zod: rechaza contenido corrupto o envenenado (C1-46)
      const parseResult = cachedRouteMapSchema.safeParse(raw);
      if (!parseResult.success) {
        // Cache envenenada o incompatible: se elimina de inmediato y se fuerza recarga desde PostgreSQL
        await this.redisClient.keys.remove(routesKey);
        return null;
      }

      const allRoutes = parseResult.data;
      const specific = allRoutes[route] ?? [];
      const wildcard = allRoutes['*'] ?? [];
      const combined = [...specific, ...wildcard];

      // Verificacion adicional de aislamiento: ningun elemento de otra org/proyecto puede coexistir
      for (const el of combined) {
        if (el.organizationId !== organizationId || el.projectId !== projectId) {
          await this.redisClient.keys.remove(routesKey);
          return null;
        }
      }

      return combined.length > 0 ? (combined as readonly MapElementEntity[]) : null;
    } catch {
      // Degradacion silenciosa ante indisponibilidad de Redis
      return null;
    }
  }

  /**
   * Invalida la cache de un proyecto en Redis para una organizacion especifica.
   */
  public async invalidateMapCache(organizationId: string, projectId: string): Promise<void> {
    const metaKey = RedisKeys.ragMapMetaForOrganization(this.redisPrefix, organizationId, projectId);
    const routesKey = RedisKeys.ragMapRoutesForOrganization(this.redisPrefix, organizationId, projectId);
    await this.redisClient.keys.remove(metaKey);
    await this.redisClient.keys.remove(routesKey);
  }
}
