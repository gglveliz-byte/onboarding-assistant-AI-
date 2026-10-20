/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository.ts
 * @modulo 01-identity-and-rbac (Repositorio PostgreSQL de Identidad, Sesiones y Membresias)
 * @proposito
 *   Implementa el acceso a datos para usuarios, organizaciones, membresias y sesiones
 *   en PostgreSQL, garantizando consultas parametrizadas contra inyecciones SQL y
 *   sincronizacion atomica del `token_version` en Redis. Soporta ejecucion en cliente
 *   autonomo del pool o dentro de una transaccion multi-tenant existente (`PoolClient`).
 *
 * @resumen_contenido
 *   - Clase `PostgresIdentityRepository`:
 *       * Busqueda y creacion de `UserEntity` y `OrganizationEntity`.
 *       * Gestion de intentos fallidos y bloqueo temporal de cuentas.
 *       * Incremento atomico de `token_version` y refresco en Redis.
 *       * Ciclo de vida de Refresh Tokens (`auth_sessions`) y familias de tokens.
 *       * Verificacion de aceptacion de instrumentos legales obligatorios.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `RedisKeys` (src/shared/infrastructure/redis/redis-key-namespaces.ts).
 *   - Entidades de dominio (`../domain/identity.entities.ts`).
 *   - `IdentityRowMapper`, DTOs (`./identity-row.mapper.ts`).
 *
 * @dependencias_externas
 *   - `pg` (`PoolClient`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `memberships`, `auth_sessions`, `legal_documents`, `user_legal_acceptances`.
 *   - Redis: `auth:user_tv:<user_id>`.
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '@shared/infrastructure/redis/redis-key-namespaces';
import { NotFoundError } from '@shared/kernel/result-and-errors';
import type {
  AuthSessionEntity,
  MembershipEntity,
  OrganizationEntity,
  PendingMandatoryLegalDocument,
  RbacRole,
  UserEntity,
} from '../domain/identity.entities';
import {
  type CreateAuthSessionData,
  type CreateOrganizationData,
  type CreateUserData,
  IdentityRowMapper,
} from './identity-row.mapper';

/**
 * Repositorio de infraestructura para la persistencia del plano de identidad y sesiones.
 */
export class PostgresIdentityRepository {
  public constructor(
    private readonly rlsPool: RlsDatabasePool,
    private readonly redis: RedisClusterClient
  ) {}

  /**
   * Ejecuta una operacion de base de datos bajo contexto de sesion o superadmin local.
   */
  private async executeWithContext<T>(
    c: PoolClient | undefined,
    setup: (client: PoolClient) => Promise<void>,
    action: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    if (c) {
      await setup(c);
      return await action(c);
    }
    return await this.rlsPool.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setup(client);
        const res = await action(client);
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Busca un usuario por su correo electronico normalizado (tipo CITEXT).
   */
  public async findUserByEmail(email: string, client?: PoolClient): Promise<UserEntity | null> {
    const query = 'SELECT * FROM users WHERE email = $1 LIMIT 1';
    const params = [email.trim().toLowerCase()];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapUserRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Busca un usuario por su identificador UUID.
   */
  public async findUserById(id: string, client?: PoolClient): Promise<UserEntity | null> {
    const query = 'SELECT * FROM users WHERE id = $1 LIMIT 1';
    const params = [id];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [id]).then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapUserRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Inserta un nuevo usuario en la tabla `users`.
   */
  public async createUser(data: CreateUserData, client?: PoolClient): Promise<UserEntity> {
    const query = `
      INSERT INTO users (
        email, full_name, password_hash, token_version, is_platform_superadmin,
        email_verification_otp_sha256, email_verification_expires_at, phone_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [
      data.email.trim().toLowerCase(),
      data.fullName.trim(),
      data.passwordHash,
      data.tokenVersion ?? 1,
      data.isPlatformSuperadmin ?? false,
      data.otpSha256 ?? null,
      data.otpExpiresAt ?? null,
      data.phoneNumber ?? null,
    ];

    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    const user = IdentityRowMapper.mapUserRow(result.rows[0] as Record<string, unknown>);
    await this.redis.json.setText(RedisKeys.authUserTokenVersion('oa', user.id), String(user.tokenVersion));
    return user;
  }

  /**
   * Registra un intento fallido de autenticacion y aplica bloqueo de 15m si supera 5 fallos.
   */
  public async recordFailedLoginAttempt(
    userId: string,
    currentAttempts: number,
    client?: PoolClient
  ): Promise<{ attempts: number; lockedUntil: Date | null }> {
    const nextAttempts = currentAttempts + 1;
    const shouldLock = nextAttempts >= 5;
    const lockedUntil = shouldLock ? new Date(Date.now() + 15 * 60 * 1000) : null;

    const query = `
      UPDATE users
      SET failed_login_attempts = $1, locked_until = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING failed_login_attempts, locked_until
    `;
    const params = [nextAttempts, lockedUntil, userId];

    await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query(query, params)
    );

    return { attempts: nextAttempts, lockedUntil };
  }

  /**
   * Restablece los intentos fallidos a 0 tras una autenticacion exitosa y actualiza IP de login.
   */
  public async resetFailedLoginAttempts(userId: string, ip: string, client?: PoolClient): Promise<void> {
    const query = `
      UPDATE users
      SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = $1::inet, updated_at = NOW()
      WHERE id = $2
    `;
    const params = [ip, userId];
    await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query(query, params)
    );
  }

  /**
   * Incrementa atomicamente el `token_version` del usuario en PostgreSQL y lo replica en Redis.
   * Fija explicitamente el contexto RLS de usuario (o utiliza el cliente provisto) para
   * garantizar que la politica rls_users_tenant_isolation permita la actualizacion de la fila.
   *
   * @param userId - Identificador del usuario.
   * @param client - Cliente de conexion transaccional opcional.
   * @returns Version del token resultante ya persistida en base de datos y replicada en Redis.
   */
  public async incrementTokenVersion(userId: string, client?: PoolClient): Promise<number> {
    const query = `
      UPDATE users
      SET token_version = token_version + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING token_version
    `;

    const res = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query<{ token_version: number }>(query, [userId])
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundError(`Usuario con id ${userId} no encontrado para incremento de version.`);
    }
    const newVersion = row.token_version;
    await this.redis.json.setText(RedisKeys.authUserTokenVersion('oa', userId), String(newVersion));
    return newVersion;
  }

  /**
   * Busca una organizacion por su slug.
   */
  public async findOrganizationBySlug(slug: string, client?: PoolClient): Promise<OrganizationEntity | null> {
    const query = 'SELECT * FROM organizations WHERE slug = $1 LIMIT 1';
    const params = [slug.trim().toLowerCase()];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapOrgRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Busca una organizacion por su UUID.
   */
  public async findOrganizationById(id: string, client?: PoolClient): Promise<OrganizationEntity | null> {
    const query = 'SELECT * FROM organizations WHERE id = $1 LIMIT 1';
    const params = [id];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapOrgRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Inserta una nueva organizacion B2B.
   */
  public async createOrganization(data: CreateOrganizationData, client?: PoolClient): Promise<OrganizationEntity> {
    const query = `
      INSERT INTO organizations (
        name, slug, enforce_mfa, enforce_sso, sso_email_domain, dpa_signed_at, dpa_clickwrap_ip, phone_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [
      data.name.trim(),
      data.slug.trim().toLowerCase(),
      data.enforceMfa ?? false,
      data.enforceSso ?? false,
      data.ssoEmailDomain ? data.ssoEmailDomain.trim().toLowerCase() : null,
      data.dpaSignedAt ?? null,
      data.dpaClickwrapIp ?? null,
      data.phoneNumber ?? null,
    ];

    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    return IdentityRowMapper.mapOrgRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Inserta una membresia de usuario en una organizacion.
   */
  public async createMembership(
    data: { organizationId: string; userId: string; role: RbacRole; isActive?: boolean },
    client?: PoolClient
  ): Promise<MembershipEntity> {
    const query = `
      INSERT INTO memberships (organization_id, user_id, role, is_active)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active, updated_at = NOW()
      RETURNING *
    `;
    const params = [data.organizationId, data.userId, data.role, data.isActive ?? true];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    return IdentityRowMapper.mapMembershipRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Busca la membresia de un usuario dentro de una organizacion.
   */
  public async findMembership(organizationId: string, userId: string, client?: PoolClient): Promise<MembershipEntity | null> {
    const query = 'SELECT * FROM memberships WHERE organization_id = $1 AND user_id = $2 AND is_active = TRUE LIMIT 1';
    const params = [organizationId, userId];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [userId, organizationId]).then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapMembershipRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Lista todas las membresias activas de un usuario.
   */
  public async findUserActiveMemberships(userId: string, client?: PoolClient): Promise<readonly MembershipEntity[]> {
    const query = 'SELECT * FROM memberships WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at ASC';
    const params = [userId];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query(query, params)
    );

    return result.rows.map((rowRecord) => IdentityRowMapper.mapMembershipRow(rowRecord as Record<string, unknown>));
  }

  /**
   * Registra una nueva sesion en `auth_sessions`.
   */
  public async createAuthSession(data: CreateAuthSessionData, client?: PoolClient): Promise<AuthSessionEntity> {
    const query = `
      INSERT INTO auth_sessions (
        user_id, organization_id, token_family_id, refresh_token_sha256,
        parent_token_sha256, token_version_snapshot, ip_address, user_agent, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9)
      RETURNING *
    `;
    const params = [
      data.userId,
      data.organizationId ?? null,
      data.tokenFamilyId,
      data.refreshTokenSha256,
      data.parentTokenSha256 ?? null,
      data.tokenVersionSnapshot,
      data.ipAddress,
      data.userAgent,
      data.expiresAt,
    ];

    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [data.userId]).then(() => {}),
      (c) => c.query(query, params)
    );

    return IdentityRowMapper.mapAuthSessionRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Busca una sesion por el hash SHA-256 de su Refresh Token.
   */
  public async findSessionByTokenHash(refreshTokenSha256: string, client?: PoolClient): Promise<AuthSessionEntity | null> {
    const query = 'SELECT * FROM auth_sessions WHERE refresh_token_sha256 = $1 LIMIT 1';
    const params = [refreshTokenSha256];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return IdentityRowMapper.mapAuthSessionRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Marca una sesion como consumida en el momento actual.
   */
  public async consumeSession(sessionId: string, client?: PoolClient): Promise<void> {
    const query = 'UPDATE auth_sessions SET consumed_at = NOW() WHERE id = $1';
    const params = [sessionId];
    await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );
  }

  /**
   * Revoca todas las sesiones de una familia de tokens por deteccion de reuso/robo.
   */
  public async revokeTokenFamily(tokenFamilyId: string, reason: string, client?: PoolClient): Promise<void> {
    const query = `
      UPDATE auth_sessions
      SET revoked_at = NOW(), revocation_reason = $1
      WHERE token_family_id = $2 AND revoked_at IS NULL
    `;
    const params = [reason, tokenFamilyId];
    await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.is_superadmin', 'true', true)").then(() => {}),
      (c) => c.query(query, params)
    );
  }

  /**
   * Revoca todas las sesiones activas de un usuario.
   */
  public async revokeAllUserSessions(userId: string, reason: string, client?: PoolClient): Promise<number> {
    const query = `
      UPDATE auth_sessions
      SET revoked_at = NOW(), revocation_reason = $1
      WHERE user_id = $2 AND revoked_at IS NULL
    `;
    const params = [reason, userId];
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query(query, params)
    );

    return result.rowCount ?? 0;
  }

  /**
   * Lista los documentos obligatorios vigentes que el usuario aun no ha aceptado para su tenant.
   * La evidencia previa sin organizacion (`organization_id IS NULL`) tambien satisface el gate.
   */
  public async findPendingMandatoryLegalDocs(
    userId: string,
    organizationId?: string | null,
    client?: PoolClient
  ): Promise<ReadonlyArray<PendingMandatoryLegalDocument>> {
    const query = `
      SELECT d.id, d.doc_type, d.title, d.version_tag
      FROM legal_documents d
      WHERE d.is_mandatory = TRUE AND d.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM user_legal_acceptances a
          WHERE a.user_id = $1 AND a.legal_document_id = d.id
            AND (a.organization_id = $2 OR a.organization_id IS NULL)
        )
      ORDER BY d.doc_type
    `;
    const result = await this.executeWithContext(
      client,
      (c) => c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]).then(() => {}),
      (c) => c.query<{ id: string; doc_type: string; title: string; version_tag: string }>(query, [userId, organizationId ?? null])
    );
    return result.rows.map((row) => ({
      id: row.id,
      docType: row.doc_type,
      title: row.title,
      versionTag: row.version_tag,
    }));
  }

  /**
   * Comprueba si el usuario y organizacion tienen todos los documentos legales obligatorios aceptados.
   */
  public async hasAcceptedMandatoryLegalDocs(userId: string, organizationId?: string | null, client?: PoolClient): Promise<boolean> {
    const pendingDocs = await this.findPendingMandatoryLegalDocs(userId, organizationId, client);
    return pendingDocs.length === 0;
  }
}
