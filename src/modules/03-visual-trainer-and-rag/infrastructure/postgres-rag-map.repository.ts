/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/postgres-rag-map.repository.ts
 * @modulo 03-visual-trainer-and-rag (Persistencia PostgreSQL RLS y Cache Redis de Mapas RAG)
 * @proposito
 *   Implementa el almacenamiento transaccional con Row Level Security (RLS) para versiones
 *   inmutables de Mapas Funcionales, elementos del DOM responsive indexados y versiones del
 *   System Prompt. Sincroniza ademas en Redis los indices de rutas y metadatos para consultas
 *   sub-milisegundo durante las sesiones de voz en tiempo real.
 *
 * @resumen_contenido
 *   - Clase `PostgresRagMapRepository`: CRUD de mapas inmutables, elementos y prompt versions.
 *   - Sincronizacion y precalentamiento atomico en Redis (`rag_map:proj:<id>:meta` y `routes`).
 *   - Soporte de conmutacion y rollback de version activa en tiempo constante (<50ms).
 *
 * @dependencias_internas
 *   - `pg`: PoolClient para transacciones con contexto RLS.
 *   - `@shared/infrastructure/redis/redis-cluster.client.ts`: Cliente Redis oficial.
 *   - `@shared/infrastructure/redis/redis-key-namespaces.ts`: Nombres unicos de claves.
 *   - `./rag-map-row.mapper.ts`: Mapeadores puros de filas SQL a entidades.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`, `prompt_versions`, `projects`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

import type { PoolClient } from 'pg';
import { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '@shared/infrastructure/redis/redis-key-namespaces';
import {
  FunctionalMapEntity,
  MapElementEntity,
  MapElementInput,
  MapSourceMode,
  PromptVersionEntity,
  UpdateAssistantPromptInput,
} from '../domain/rag-map.entities';
import {
  FunctionalMapRow,
  MapElementRow,
  PromptVersionRow,
  mapFunctionalMapRow,
  mapMapElementRow,
  mapPromptVersionRow,
} from './rag-map-row.mapper';

/**
 * Repositorio especializado para el Modulo 03 (Mapas RAG, Elementos y Prompt Studio).
 */
import { RagMapRedisStore } from './rag-map-redis.store';

export class PostgresRagMapRepository {
  private readonly redisStore: RagMapRedisStore;

  public constructor(redisClient: RedisClusterClient, redisPrefix: string = 'oa') {
    this.redisStore = new RagMapRedisStore(redisClient, redisPrefix);
  }

  // ===========================================================================
  // 1. MAPAS FUNCIONALES INMUTABLES (functional_maps)
  // ===========================================================================

  /**
   * Obtiene la version maxima actual de mapa para un proyecto.
   */
  public async getNextMapVersionNumber(client: PoolClient, projectId: string): Promise<number> {
    const query = 'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM functional_maps WHERE project_id = $1;';
    const { rows } = await client.query<{ next_ver: string | number }>(query, [projectId]);
    const row = rows[0];
    return row ? Number(row.next_ver) : 1;
  }

  /**
   * Inserta un nuevo mapa funcional inmutable con su hash SHA-256 de contenido.
   */
  public async createFunctionalMap(
    client: PoolClient,
    input: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly versionNumber: number;
      readonly versionLabel?: string | undefined;
      readonly sourceMode: MapSourceMode;
      readonly canonicalMapJson: Record<string, unknown>;
      readonly contentSha256Hash: string;
      readonly totalElementsCount: number;
      readonly publishedByUserId?: string | undefined;
    }
  ): Promise<FunctionalMapEntity> {
    const query = `
      INSERT INTO functional_maps (
        organization_id, project_id, version_number, version_label,
        source_mode, canonical_map_json, content_sha256_hash,
        total_elements_count, is_active, published_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)
      RETURNING *;
    `;
    const params = [
      input.organizationId,
      input.projectId,
      input.versionNumber,
      input.versionLabel ?? null,
      input.sourceMode,
      JSON.stringify(input.canonicalMapJson),
      input.contentSha256Hash,
      input.totalElementsCount,
      input.publishedByUserId ?? null,
    ];
    const { rows } = await client.query<FunctionalMapRow>(query, params);
    const row = rows[0];
    if (!row) throw new Error('No se pudo insertar el mapa funcional');
    return mapFunctionalMapRow(row);
  }

  /**
   * Obtiene el mapa funcional activo de un proyecto.
   */
  public async getActiveMapByProject(client: PoolClient, projectId: string): Promise<FunctionalMapEntity | null> {
    const query = 'SELECT * FROM functional_maps WHERE project_id = $1 AND is_active = TRUE LIMIT 1;';
    const { rows } = await client.query<FunctionalMapRow>(query, [projectId]);
    const row = rows[0];
    return row ? mapFunctionalMapRow(row) : null;
  }

  /**
   * Busca un mapa por su hash SHA-256 dentro de un proyecto para evitar duplicaciones.
   */
  public async getMapByContentHash(
    client: PoolClient,
    projectId: string,
    contentSha256Hash: string
  ): Promise<FunctionalMapEntity | null> {
    const query = 'SELECT * FROM functional_maps WHERE project_id = $1 AND content_sha256_hash = $2 LIMIT 1;';
    const { rows } = await client.query<FunctionalMapRow>(query, [projectId, contentSha256Hash]);
    const row = rows[0];
    return row ? mapFunctionalMapRow(row) : null;
  }

  /**
   * Obtiene un mapa por su identificador UUID.
   */
  public async getMapById(client: PoolClient, mapId: string): Promise<FunctionalMapEntity | null> {
    const query = 'SELECT * FROM functional_maps WHERE id = $1 LIMIT 1;';
    const { rows } = await client.query<FunctionalMapRow>(query, [mapId]);
    const row = rows[0];
    return row ? mapFunctionalMapRow(row) : null;
  }

  /**
   * Obtiene un mapa por numero de version de un proyecto.
   */
  public async getMapByVersion(
    client: PoolClient,
    projectId: string,
    versionNumber: number
  ): Promise<FunctionalMapEntity | null> {
    const query = 'SELECT * FROM functional_maps WHERE project_id = $1 AND version_number = $2 LIMIT 1;';
    const { rows } = await client.query<FunctionalMapRow>(query, [projectId, versionNumber]);
    const row = rows[0];
    return row ? mapFunctionalMapRow(row) : null;
  }

  /**
   * Lista todas las versiones de mapa de un proyecto ordenadas descendentemente.
   */
  public async listMapsByProject(client: PoolClient, projectId: string): Promise<readonly FunctionalMapEntity[]> {
    const query = 'SELECT * FROM functional_maps WHERE project_id = $1 ORDER BY version_number DESC;';
    const { rows } = await client.query<FunctionalMapRow>(query, [projectId]);
    return rows.map((r) => mapFunctionalMapRow(r));
  }

  /**
   * Conmuta atómicamente el mapa activo de un proyecto desactivando las demas versiones.
   */
  public async setActiveMap(client: PoolClient, projectId: string, targetMapId: string): Promise<void> {
    await client.query('UPDATE functional_maps SET is_active = FALSE WHERE project_id = $1;', [projectId]);
    await client.query('UPDATE functional_maps SET is_active = TRUE WHERE id = $1 AND project_id = $2;', [
      targetMapId,
      projectId,
    ]);
    await client.query('UPDATE projects SET active_functional_map_id = $1, updated_at = NOW() WHERE id = $2;', [
      targetMapId,
      projectId,
    ]);
  }

  // ===========================================================================
  // 2. ELEMENTOS DEL DOM FUNCIONAL (map_elements)
  // ===========================================================================

  /**
   * Inserta un lote de elementos asociados a un mapa funcional.
   */
  public async insertMapElements(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    functionalMapId: string,
    elements: readonly MapElementInput[]
  ): Promise<readonly MapElementEntity[]> {
    if (elements.length === 0) {
      return [];
    }

    const valueRows: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const el of elements) {
      valueRows.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      params.push(
        organizationId,
        projectId,
        functionalMapId,
        el.elementKey,
        el.urlRoutePattern ?? '/',
        el.title,
        el.functionalDescription,
        el.isActionable ?? false,
        el.actionType ?? 'NONE',
        el.stepOrderHint ?? null,
        el.primarySelector,
        el.accessibilitySelector ?? null,
        el.structuralCssSelector ?? null,
        el.xpathFallback ?? null,
        el.selectorStabilityScore ?? 100,
        JSON.stringify(el.desktopBbox ?? {}),
        JSON.stringify(el.tabletBbox ?? {}),
        JSON.stringify(el.mobileBbox ?? {}),
        JSON.stringify(el.elementMetadata ?? {})
      );
    }

    const query = `
      INSERT INTO map_elements (
        organization_id, project_id, functional_map_id,
        element_key, url_route_pattern, title, functional_description,
        is_actionable, action_type, step_order_hint,
        primary_selector, accessibility_selector, structural_css_selector,
        xpath_fallback, selector_stability_score,
        desktop_bbox_json, tablet_bbox_json, mobile_bbox_json,
        element_metadata_json
      ) VALUES ${valueRows.join(',\n')}
      RETURNING *;
    `;

    const { rows } = await client.query<MapElementRow>(query, params);
    return rows.map((r) => mapMapElementRow(r));
  }

  /**
   * Lista todos los elementos de un mapa funcional.
   */
  public async listElementsByMap(client: PoolClient, functionalMapId: string): Promise<readonly MapElementEntity[]> {
    const query = 'SELECT * FROM map_elements WHERE functional_map_id = $1 ORDER BY step_order_hint ASC, created_at ASC;';
    const { rows } = await client.query<MapElementRow>(query, [functionalMapId]);
    return rows.map((r) => mapMapElementRow(r));
  }

  /**
   * Lista los elementos de una ruta especifica dentro de un mapa funcional.
   */
  public async listElementsByRoute(
    client: PoolClient,
    functionalMapId: string,
    routePattern: string
  ): Promise<readonly MapElementEntity[]> {
    const query = `
      SELECT * FROM map_elements
      WHERE functional_map_id = $1 AND (url_route_pattern = $2 OR url_route_pattern = '*')
      ORDER BY step_order_hint ASC, created_at ASC;
    `;
    const { rows } = await client.query<MapElementRow>(query, [functionalMapId, routePattern]);
    return rows.map((r) => mapMapElementRow(r));
  }

  // ===========================================================================
  // 3. ESTUDIO DEL PROMPT Y VERSIONES (prompt_versions)
  // ===========================================================================

  /**
   * Obtiene la siguiente version de prompt para un proyecto.
   */
  public async getNextPromptVersionNumber(client: PoolClient, projectId: string): Promise<number> {
    const query = 'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM prompt_versions WHERE project_id = $1;';
    const { rows } = await client.query<{ next_ver: string | number }>(query, [projectId]);
    const row = rows[0];
    return row ? Number(row.next_ver) : 1;
  }

  /**
   * Crea una nueva version inmutable del System Prompt y actualiza la configuracion del proyecto.
   */
  public async createPromptVersion(
    client: PoolClient,
    input: UpdateAssistantPromptInput,
    versionNumber: number
  ): Promise<PromptVersionEntity> {
    const query = `
      INSERT INTO prompt_versions (
        organization_id, project_id, version_number,
        system_prompt, onboarding_steps_json,
        primary_voice_model, fallback_voice_model,
        model_temperature, strict_step_enforcement,
        ask_confirmation_before_submit, updated_via_channel,
        created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;
    const params = [
      input.organizationId,
      input.projectId,
      versionNumber,
      input.systemPrompt,
      JSON.stringify(input.onboardingStepsJson ?? []),
      input.primaryVoiceModel ?? 'GEMINI_3_8_LIVE',
      input.fallbackVoiceModel ?? 'QWEN_3_8_OMNI_FLASH_REALTIME',
      input.modelTemperature ?? 0.2,
      input.strictStepEnforcement ?? true,
      input.askConfirmationBeforeSubmit ?? true,
      input.updatedViaChannel ?? 'DASHBOARD_UI',
      input.createdByUserId ?? null,
    ];
    const { rows } = await client.query<PromptVersionRow>(query, params);
    const row = rows[0];
    if (!row) throw new Error('No se pudo crear la version del prompt');

    // Actualiza el proyecto con la configuracion activa
    await client.query(
      `
      UPDATE projects SET
        system_prompt = $1,
        onboarding_steps_json = $2,
        primary_voice_model = $3,
        fallback_voice_model = $4,
        model_temperature = $5,
        strict_step_enforcement = $6,
        ask_confirmation_before_submit = $7,
        active_prompt_version_number = $8,
        updated_at = NOW()
      WHERE id = $9;
    `,
      [
        input.systemPrompt,
        JSON.stringify(input.onboardingStepsJson ?? []),
        input.primaryVoiceModel ?? 'GEMINI_3_8_LIVE',
        input.fallbackVoiceModel ?? 'QWEN_3_8_OMNI_FLASH_REALTIME',
        input.modelTemperature ?? 0.2,
        input.strictStepEnforcement ?? true,
        input.askConfirmationBeforeSubmit ?? true,
        versionNumber,
        input.projectId,
      ]
    );

    return mapPromptVersionRow(row);
  }

  /**
   * Obtiene la version de prompt mas reciente de un proyecto.
   */
  public async getLatestPromptVersion(client: PoolClient, projectId: string): Promise<PromptVersionEntity | null> {
    const query = 'SELECT * FROM prompt_versions WHERE project_id = $1 ORDER BY version_number DESC LIMIT 1;';
    const { rows } = await client.query<PromptVersionRow>(query, [projectId]);
    const row = rows[0];
    return row ? mapPromptVersionRow(row) : null;
  }

  // ===========================================================================
  // 4. CACHE DE REDIS (rag_map:org:<orgId>:proj:<projId>:meta y routes) (C1-46)
  // ===========================================================================

  /**
   * Precalienta en Redis los metadatos y el mapa agrupado por rutas, segmentado por organizacion.
   */
  public async warmUpMapCacheInRedis(
    organizationId: string,
    projectId: string,
    metadata: {
      readonly functionalMapId: string;
      readonly versionNumber: number;
      readonly canonicalSha256: string;
      readonly routes: readonly string[];
      readonly totalElementsCount: number;
      readonly publishedAtIso: string;
    },
    elementsByRoute: Record<string, readonly MapElementEntity[]>
  ): Promise<void> {
    await this.redisStore.warmUpMapCacheInRedis(organizationId, projectId, metadata, elementsByRoute);
  }

  /**
   * Obtiene los metadatos del mapa activo desde Redis con aislamiento por organizacion.
   */
  public async getCachedMapMeta(
    organizationId: string,
    projectId: string
  ): Promise<{
    readonly functionalMapId: string;
    readonly versionNumber: number;
    readonly canonicalSha256: string;
    readonly routes: readonly string[];
    readonly totalElementsCount: number;
    readonly publishedAtIso: string;
  } | null> {
    return this.redisStore.getCachedMapMeta(organizationId, projectId);
  }

  /**
   * Obtiene los elementos indexados por ruta desde Redis con revalidacion estricta Zod y aislamiento por organizacion.
   */
  public async getCachedRouteElements(
    organizationId: string,
    projectId: string,
    route: string
  ): Promise<readonly MapElementEntity[] | null> {
    return this.redisStore.getCachedRouteElements(organizationId, projectId, route);
  }

  /**
   * Invalida la cache de un proyecto en Redis para una organizacion.
   */
  public async invalidateMapCache(organizationId: string, projectId: string): Promise<void> {
    await this.redisStore.invalidateMapCache(organizationId, projectId);
  }
}
