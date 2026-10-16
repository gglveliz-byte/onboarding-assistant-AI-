/**
 * @archivo src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository.ts
 * @modulo 02-projects-and-keys (Persistencia PostgreSQL RLS y Cache Redis)
 * @proposito
 *   Implementa el almacenamiento transaccional con Row Level Security (RLS) para proyectos,
 *   claves de API (hasheadas con SHA-256) y listas de origenes permitidos del SDK. Sincroniza
 *   ademas en Redis los indices de validacion rapida (`oa:apikey:sha256:<hash>`) y el conjunto
 *   de origenes autorizados (`oa:proj:<id>:allowed_domains`).
 *
 * @resumen_contenido
 *   - Clase `PostgresProjectsKeysRepository`: CRUD con RLS y sincronizacion atomica de cache.
 *   - Manejo de ventanas de gracia para rotacion de claves y nonces efimeros de handshake.
 *
 * @dependencias_internas
 *   - `pg`: PoolClient para transacciones con contexto de sesion RLS.
 *   - `@shared/infrastructure/redis/redis-cluster.client.ts`: Cliente Redis oficial.
 *   - `@shared/infrastructure/redis/redis-key-namespaces.ts`: Nombres unicos de claves.
 *   - `./projects-keys-row.mapper.ts`: Mapeadores puros de filas SQL a entidades.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`.
 *   - Redis: `oa:apikey:sha256:<hash>`, `oa:proj:<id>:allowed_domains`, `oa:sdk_handshake:nonce:<jti>`.
 */

import type { PoolClient } from 'pg';
import { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import {
  AllowedDomainEntity,
  ApiKeyEntity,
  CreateAllowedDomainInput,
  CreateApiKeyInput,
  CreateProjectInput,
  ProjectEntity,
  UpdateProjectInput,
} from '../domain/projects-keys.entities';
import {
  ApiKeyRow,
  AllowedDomainRow,
  ProjectRow,
  mapApiKeyRow,
  mapAllowedDomainRow,
  mapProjectRow,
} from './projects-keys-row.mapper';
import { ProjectsKeysRedisStore } from './projects-keys-redis.store';

/**
 * Repositorio especializado para el Modulo 02 (Proyectos y Claves de API).
 */
export class PostgresProjectsKeysRepository {
  private readonly redisStore: ProjectsKeysRedisStore;

  public constructor(redisClient: RedisClusterClient, redisPrefix: string = 'oa') {
    this.redisStore = new ProjectsKeysRedisStore(redisClient, redisPrefix);
  }

  // ===========================================================================
  // 1. GESTION DE PROYECTOS (projects)
  // ===========================================================================

  /**
   * Crea un nuevo proyecto en base de datos.
   */
  public async createProject(client: PoolClient, input: CreateProjectInput): Promise<ProjectEntity> {
    const query = `
      INSERT INTO projects (
        organization_id, name, slug, environment, primary_voice_model,
        fallback_voice_model, voice_persona_code, speech_speed, vad_barge_in_sensitivity,
        model_temperature, system_prompt, onboarding_steps_json,
        strict_step_enforcement, ask_confirmation_before_submit, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *;
    `;
    const params = [
      input.organizationId, input.name, input.slug.toLowerCase().trim(),
      input.environment ?? 'LIVE', input.primaryVoiceModel ?? 'GEMINI_3_8_LIVE',
      input.fallbackVoiceModel ?? 'QWEN_3_8_OMNI_FLASH_REALTIME', input.voicePersonaCode ?? 'aura-es-neutral',
      input.speechSpeed ?? 1.0, input.vadBargeInSensitivity ?? 'BALANCED',
      input.modelTemperature ?? 0.2, input.systemPrompt ?? 'Eres el asistente tecnico interactivo. Guia paso a paso.',
      JSON.stringify(input.onboardingStepsJson ?? []),
      input.strictStepEnforcement ?? true, input.askConfirmationBeforeSubmit ?? true,
      input.createdByUserId ?? null,
    ];
    const { rows } = await client.query<ProjectRow>(query, params);
    const row = rows[0];
    if (!row) throw new Error('No se pudo insertar el proyecto');
    return mapProjectRow(row);
  }

  /**
   * Obtiene un proyecto por su identificador UUID.
   */
  public async getProjectById(client: PoolClient, projectId: string): Promise<ProjectEntity | null> {
    const query = 'SELECT * FROM projects WHERE id = $1 LIMIT 1;';
    const { rows } = await client.query<ProjectRow>(query, [projectId]);
    const row = rows[0];
    return row ? mapProjectRow(row) : null;
  }

  /**
   * Obtiene un proyecto por su slug dentro de una organizacion.
   */
  public async getProjectBySlug(
    client: PoolClient,
    organizationId: string,
    slug: string
  ): Promise<ProjectEntity | null> {
    const query = 'SELECT * FROM projects WHERE organization_id = $1 AND slug = $2 LIMIT 1;';
    const { rows } = await client.query<ProjectRow>(query, [organizationId, slug.toLowerCase().trim()]);
    const row = rows[0];
    return row ? mapProjectRow(row) : null;
  }

  /**
   * Lista todos los proyectos de una organizacion.
   * Lista proyectos de una organizacion con soporte de paginacion (C1-61).
   */
  public async listProjectsByOrg(
    client: PoolClient,
    organizationId: string,
    pagination: { limit?: number; offset?: number } = {}
  ): Promise<readonly ProjectEntity[]> {
    const limit = Math.min(Math.max(pagination.limit ?? 100, 1), 500);
    const offset = Math.max(pagination.offset ?? 0, 0);
    const query = 'SELECT * FROM projects WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;';
    const { rows } = await client.query<ProjectRow>(query, [organizationId, limit, offset]);
    return rows.map((r) => mapProjectRow(r));
  }

  /**
   * Actualiza la configuracion operativa de un proyecto.
   */
  public async updateProject(
    client: PoolClient,
    projectId: string,
    input: UpdateProjectInput
  ): Promise<ProjectEntity | null> {
    const fields: string[] = [];
    const values: unknown[] = [projectId];
    let idx = 2;

    if (input.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.primaryVoiceModel !== undefined) {
      fields.push(`primary_voice_model = $${idx++}`);
      values.push(input.primaryVoiceModel);
    }
    if (input.fallbackVoiceModel !== undefined) {
      fields.push(`fallback_voice_model = $${idx++}`);
      values.push(input.fallbackVoiceModel);
    }
    if (input.voicePersonaCode !== undefined) {
      fields.push(`voice_persona_code = $${idx++}`);
      values.push(input.voicePersonaCode);
    }
    if (input.speechSpeed !== undefined) {
      fields.push(`speech_speed = $${idx++}`);
      values.push(input.speechSpeed);
    }
    if (input.vadBargeInSensitivity !== undefined) {
      fields.push(`vad_barge_in_sensitivity = $${idx++}`);
      values.push(input.vadBargeInSensitivity);
    }
    if (input.modelTemperature !== undefined) {
      fields.push(`model_temperature = $${idx++}`);
      values.push(input.modelTemperature);
    }
    if (input.systemPrompt !== undefined) {
      fields.push(`system_prompt = $${idx++}`);
      values.push(input.systemPrompt);
    }
    if (input.onboardingStepsJson !== undefined) {
      fields.push(`onboarding_steps_json = $${idx++}`);
      values.push(JSON.stringify(input.onboardingStepsJson));
    }
    if (input.strictStepEnforcement !== undefined) {
      fields.push(`strict_step_enforcement = $${idx++}`);
      values.push(input.strictStepEnforcement);
    }
    if (input.askConfirmationBeforeSubmit !== undefined) {
      fields.push(`ask_confirmation_before_submit = $${idx++}`);
      values.push(input.askConfirmationBeforeSubmit);
    }
    if (input.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(input.isActive);
    }

    if (fields.length === 0) {
      return this.getProjectById(client, projectId);
    }

    const query = `UPDATE projects SET ${fields.join(', ')} WHERE id = $1 RETURNING *;`;
    const { rows } = await client.query<ProjectRow>(query, values);
    const row = rows[0];
    return row ? mapProjectRow(row) : null;
  }

  // ===========================================================================
  // 2. GESTION DE CLAVES DE API (api_keys)
  // ===========================================================================

  /**
   * Inserta una nueva clave de API (almacenando exclusivamente su hash SHA-256).
   */
  public async createApiKey(
    client: PoolClient,
    input: CreateApiKeyInput,
    keyHash: string,
    keyPrefix: string,
    lastFour: string
  ): Promise<ApiKeyEntity> {
    const query = `
      INSERT INTO api_keys (
        organization_id, project_id, name, key_type, environment,
        key_prefix, last_four, key_hash, scopes, expires_at, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;
    `;
    const params = [
      input.organizationId, input.projectId, input.name, input.keyType, input.environment,
      keyPrefix, lastFour, keyHash, input.scopes ?? [], input.expiresAt ?? null, input.createdByUserId ?? null,
    ];
    const { rows } = await client.query<ApiKeyRow>(query, params);
    const row = rows[0];
    if (!row) throw new Error('No se pudo insertar la clave de API');
    const entity = mapApiKeyRow(row);
    await this.cacheApiKey(entity);
    return entity;
  }

  /**
   * Resuelve la **organizacion propietaria** de una clave a partir de su resumen SHA-256.
   *
   * Existe para romper una dependencia circular: la politica de aislamiento de `api_keys` exige
   * conocer la organizacion para poder leer la fila, y la organizacion solo se conoce tras leerla. Con
   * el rol de aplicacion —sin privilegio de omision de politicas— la consulta directa devolvia **cero
   * filas**, de modo que toda validacion de clave respondia «clave inexistente» y el sistema solo
   * funcionaba conectado con un rol privilegiado, es decir con el aislamiento multi-tenant apagado.
   *
   * Se apoya en una funcion de confianza del motor cuya superficie es minima: recibe **unicamente el
   * resumen** —nunca la clave en claro— y devuelve solo la organizacion, el proyecto y la marca de
   * revocacion. No expone el resumen almacenado ni los permisos concedidos.
   *
   * @param client - Cliente de base de datos, que puede estar **sin contexto de inquilino**: es
   *   precisamente el proposito de esta resolucion, que ocurre antes de conocer la organizacion.
   * @param keyHash - Resumen SHA-256 de la clave presentada.
   * @returns Organizacion y proyecto propietarios, o `null` cuando el resumen no corresponde a
   *   ninguna clave.
   */
  public async resolveApiKeyOwnerByHash(
    client: PoolClient,
    keyHash: string
  ): Promise<{ readonly organizationId: string; readonly projectId: string } | null> {
    const query = 'SELECT organization_id, project_id FROM app_resolve_api_key_by_hash($1);';
    const { rows } = await client.query<{ organization_id: string; project_id: string }>(query, [keyHash]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { organizationId: row.organization_id, projectId: row.project_id };
  }

  /**
   * Busca una clave de API por su resumen, **siempre dentro de una organizacion conocida**.
   *
   * La organizacion es un parametro obligatorio y no opcional: sin ella, la consulta a PostgreSQL no
   * devolveria ninguna fila bajo el rol de aplicacion, y la cache —que es global por naturaleza— no
   * pasaria por el aislamiento. Exigirla hace que el aislamiento multi-tenant siga vigente tanto en la
   * lectura a la base de datos como en la respuesta servida desde Redis.
   *
   * @param client - Cliente con el contexto de la organizacion ya establecido.
   * @param keyHash - Resumen SHA-256 de la clave.
   * @param organizationId - Organizacion propietaria, resuelta de forma autoritativa.
   * @returns La clave con su proyecto, o `null` cuando no existe en esa organizacion.
   */
  public async getApiKeyByHash(
    client: PoolClient,
    keyHash: string,
    organizationId: string
  ): Promise<ApiKeyEntity | null> {
    const cached = await this.redisStore.getCachedApiKey(keyHash, organizationId);
    if (cached) {
      return cached;
    }

    const query = 'SELECT * FROM api_keys WHERE key_hash = $1 AND organization_id = $2 LIMIT 1;';
    const { rows } = await client.query<ApiKeyRow>(query, [keyHash, organizationId]);
    const row = rows[0];
    if (!row) return null;
    const entity = mapApiKeyRow(row);
    await this.cacheApiKey(entity);
    return entity;
  }

  /**
   * Lista claves asociadas a un proyecto con soporte de paginacion (C1-61).
   */
  public async listApiKeysByProject(
    client: PoolClient,
    projectId: string,
    pagination: { limit?: number; offset?: number } = {}
  ): Promise<readonly ApiKeyEntity[]> {
    const limit = Math.min(Math.max(pagination.limit ?? 100, 1), 500);
    const offset = Math.max(pagination.offset ?? 0, 0);
    const query = 'SELECT * FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;';
    const { rows } = await client.query<ApiKeyRow>(query, [projectId, limit, offset]);
    return rows.map((r) => mapApiKeyRow(r));
  }

  /**
   * Rota una clave de API: inserta la nueva y asigna `grace_period_ends_at` a la previa.
   */
  public async rotateApiKey(
    client: PoolClient,
    oldKeyId: string,
    newInput: CreateApiKeyInput,
    newKeyHash: string,
    newKeyPrefix: string,
    newLastFour: string,
    gracePeriodEndsAt: Date
  ): Promise<{ readonly oldKey: ApiKeyEntity; readonly newKey: ApiKeyEntity }> {
    // 1. Actualiza la clave anterior
    const updateOldQuery = 'UPDATE api_keys SET grace_period_ends_at = $1 WHERE id = $2 RETURNING *;';
    const oldRes = await client.query<ApiKeyRow>(updateOldQuery, [gracePeriodEndsAt, oldKeyId]);
    const oldRow = oldRes.rows[0];
    if (!oldRow) throw new Error(`Clave original no encontrada para rotacion: ${oldKeyId}`);
    const updatedOldKey = mapApiKeyRow(oldRow);
    await this.cacheApiKey(updatedOldKey);

    // 2. Inserta la clave nueva referenciando a la anterior
    const insertNewQuery = `
      INSERT INTO api_keys (
        organization_id, project_id, name, key_type, environment,
        key_prefix, last_four, key_hash, scopes, rotated_from_key_id, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;
    `;
    const newRes = await client.query<ApiKeyRow>(insertNewQuery, [
      newInput.organizationId, newInput.projectId, newInput.name, newInput.keyType, newInput.environment,
      newKeyPrefix, newLastFour, newKeyHash, newInput.scopes ?? [], oldKeyId, newInput.createdByUserId ?? null,
    ]);
    const newRow = newRes.rows[0];
    if (!newRow) throw new Error('No se pudo generar la nueva clave rotada');
    const createdNewKey = mapApiKeyRow(newRow);
    await this.cacheApiKey(createdNewKey);

    return { oldKey: updatedOldKey, newKey: createdNewKey };
  }

  /**
   * Revoca inmediatamente una clave de API en BD y elimina su entrada en Redis.
   */
  public async revokeApiKey(client: PoolClient, keyId: string, revokedByUserId?: string): Promise<boolean> {
    const query = `
      UPDATE api_keys
      SET revoked_at = NOW(), revoked_by_user_id = $1
      WHERE id = $2 AND revoked_at IS NULL
      RETURNING key_hash;
    `;
    const { rows } = await client.query<{ key_hash: string }>(query, [revokedByUserId ?? null, keyId]);
    const row = rows[0];
    if (!row) {
      return false;
    }
    await this.redisStore.removeCachedApiKey(row.key_hash);
    return true;
  }

  // ===========================================================================
  // 3. GESTION DE DOMINIOS PERMITIDOS (allowed_domains)
  // ===========================================================================

  /**
   * Registra un nuevo patron de origen en la lista blanca del proyecto.
   */
  public async createAllowedDomain(client: PoolClient, input: CreateAllowedDomainInput): Promise<AllowedDomainEntity> {
    const query = `
      INSERT INTO allowed_domains (
        organization_id, project_id, origin_pattern, allow_localhost_dev, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (project_id, origin_pattern) DO UPDATE
      SET is_active = TRUE, allow_localhost_dev = EXCLUDED.allow_localhost_dev
      RETURNING *;
    `;
    const params = [
      input.organizationId,
      input.projectId,
      input.originPattern.trim().toLowerCase(),
      input.allowLocalhostDev ?? false,
      input.createdByUserId ?? null,
    ];
    const { rows } = await client.query<AllowedDomainRow>(query, params);
    const row = rows[0];
    if (!row) {
      throw new Error('No se pudo registrar el dominio permitido');
    }
    const entity = mapAllowedDomainRow(row);
    await this.syncProjectDomainsInRedis(client, input.projectId);
    return entity;
  }

  /**
   * Lista dominios permitidos de un proyecto con soporte de paginacion (C1-61).
   */
  public async listAllowedDomainsByProject(
    client: PoolClient,
    projectId: string,
    pagination: { limit?: number; offset?: number } = {}
  ): Promise<readonly AllowedDomainEntity[]> {
    const limit = Math.min(Math.max(pagination.limit ?? 100, 1), 500);
    const offset = Math.max(pagination.offset ?? 0, 0);
    const query = 'SELECT * FROM allowed_domains WHERE project_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT $2 OFFSET $3;';
    const { rows } = await client.query<AllowedDomainRow>(query, [projectId, limit, offset]);
    return rows.map((r) => mapAllowedDomainRow(r));
  }

  /**
   * Elimina un origen permitido del proyecto.
   */
  public async deleteAllowedDomain(client: PoolClient, domainId: string, projectId: string): Promise<boolean> {
    const query = 'DELETE FROM allowed_domains WHERE id = $1 AND project_id = $2 RETURNING id;';
    const { rowCount } = await client.query(query, [domainId, projectId]);
    if ((rowCount ?? 0) > 0) {
      await this.syncProjectDomainsInRedis(client, projectId);
      return true;
    }
    return false;
  }

  // ===========================================================================
  // 4. CACHE DE REDIS Y NONCES DEL SDK HANDSHAKE (Delegados a ProjectsKeysRedisStore)
  // ===========================================================================

  /**
   * Almacena una clave de API en cache para resolucion sub-milisegundo.
   */
  public async cacheApiKey(key: ApiKeyEntity): Promise<void> {
    await this.redisStore.cacheApiKey(key);
  }

  /**
   * Sincroniza la lista de dominios autorizados de un proyecto en un conjunto de Redis.
   */
  public async syncProjectDomainsInRedis(client: PoolClient, projectId: string): Promise<void> {
    const domains = await this.listAllowedDomainsByProject(client, projectId, { limit: 500 });
    await this.redisStore.syncProjectDomains(projectId, domains);
  }

  /**
   * Obtiene la lista cacheada de dominios de un proyecto desde Redis.
   */
  public async getCachedProjectDomains(
    projectId: string
  ): Promise<readonly { pattern: string; allowLocalhost: boolean }[] | null> {
    return this.redisStore.getCachedProjectDomains(projectId);
  }

  /**
   * Guarda un nonce de handshake de un solo uso en Redis con TTL de 60 segundos.
   */
  public async storeHandshakeNonce(nonceId: string, payload: string, ttlSeconds: number = 60): Promise<boolean> {
    return this.redisStore.storeHandshakeNonce(nonceId, payload, ttlSeconds);
  }

  /**
   * Consume de forma atomica un nonce de handshake: lee su valor y lo borra de inmediato.
   */
  public async consumeHandshakeNonce(nonceId: string): Promise<string | null> {
    return this.redisStore.consumeHandshakeNonce(nonceId);
  }
}
