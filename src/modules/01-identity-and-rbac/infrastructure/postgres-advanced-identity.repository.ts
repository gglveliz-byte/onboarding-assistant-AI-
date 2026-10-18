/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/postgres-advanced-identity.repository.ts
 * @modulo 01-identity-and-rbac (Repositorio PostgreSQL para MFA, Legal, Reset Tokens e Invitaciones)
 * @proposito
 *   Implementa el acceso a datos especializado para la segunda fase del modulo de identidad (01-B):
 *   codigos de recuperacion MFA hasheados con SHA-256, solicitudes Break-Glass de Owner,
 *   credenciales WebAuthn FIDO2, tokens de reinicio de contrasena efimeros, invitaciones de
 *   organizacion y aceptaciones inmutables de instrumentos legales (ToS, DPA, Privacidad).
 *
 * @resumen_contenido
 *   - Clase `PostgresAdvancedIdentityRepository`:
 *       * Gestion de codigos de respaldo MFA (creacion por lote, verificacion y consumo atomico).
 *       * Gestion de solicitudes Break-Glass (creacion, verificacion de reto, aprobacion y enfriamiento 24h).
 *       * Persistencia de tokens de restablecimiento de contrasena (`password_reset_tokens`).
 *       * Actualizacion de contrasenas seguras Argon2id.
 *       * Resolucion de organizaciones por dominio SSO SAML (`organizations.sso_email_domain`).
 *       * Persistencia y resolucion de invitaciones a organizaciones (`memberships`).
 *       * Verificacion de aceptaciones legales obligatorias y firma de DPA.
 *       * Portabilidad de datos GDPR.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts).
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `OrganizationEntity` (../domain/identity.entities.ts).
 *   - `IdentityRowMapper` (./identity-row.mapper.ts).
 *   - `IdentityAdvancedRowMapper`, DTOs (`./identity-advanced-row.mapper.ts`).
 *
 * @dependencias_externas
 *   - `pg` (`PoolClient`).
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import type { OrganizationEntity } from '../domain/identity.entities';
import { IdentityRowMapper } from './identity-row.mapper';
import {
  type BreakGlassRequestRecord,
  IdentityAdvancedRowMapper,
  type LegalDocumentRecord,
  type MembershipInvitationRecord,
} from './identity-advanced-row.mapper';

interface AdvancedRlsContext {
  readonly userId?: string | undefined;
  readonly orgId?: string | undefined;
  readonly isSuperAdmin?: boolean | undefined;
}

/**
 * Repositorio especializado para flujos avanzados de identidad, MFA, recuperacion y legal.
 */
export class PostgresAdvancedIdentityRepository {
  public constructor(private readonly rlsPool: RlsDatabasePool) {}

  /**
   * Ejecuta una operacion garantizando contexto RLS de sesion, organizacion o superadmin.
   */
  private async executeWithRls<T>(
    client: PoolClient | undefined,
    rls: AdvancedRlsContext | undefined,
    fn: (c: PoolClient) => Promise<T>
  ): Promise<T> {
    const applyRls = async (c: PoolClient): Promise<void> => {
      if (rls?.isSuperAdmin) {
        await c.query("SELECT set_config('app.is_superadmin', 'true', true)");
      } else {
        if (rls?.userId) await c.query("SELECT set_config('app.current_user_id', $1, true)", [rls.userId]);
        if (rls?.orgId) await c.query("SELECT set_config('app.current_org_id', $1, true)", [rls.orgId]);
      }
    };

    if (client) {
      if (rls) await applyRls(client);
      return await fn(client);
    }
    return await this.rlsPool.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        if (rls) await applyRls(c);
        const res = await fn(c);
        await c.query('COMMIT');
        return res;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Ejecuta una consulta parametrizada usando el cliente provisto o uno adquirido del pool.
   */
  private async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
    client?: PoolClient,
    rls?: AdvancedRlsContext
  ): Promise<T[]> {
    return this.executeWithRls(client, rls, async (c) => {
      const res = await c.query(sql, params as unknown[]);
      return res.rows as T[];
    });
  }

  /**
   * Ejecuta un bloque dentro de una transaccion atomica (BEGIN/COMMIT/ROLLBACK) para
   * encadenar sentencias sin ventanas de carrera (consumo single-use, reseteo de MFA).
   *
   * @param work - Funcion que recibe el cliente transaccional y produce el resultado.
   * @returns Resultado producido por la funcion de trabajo.
   */
  public async runInAtomicTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.rlsPool.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  /**
   * Almacena 10 codigos de respaldo MFA hasheados con SHA-256 para un usuario.
   */
  public async saveMfaRecoveryCodes(
    userId: string,
    hashedCodes: ReadonlyArray<{ saltHex: string; sha256Hex: string }>,
    client?: PoolClient
  ): Promise<void> {
    await this.executeWithRls(client, { userId }, async (c) => {
      await c.query('DELETE FROM user_mfa_recovery_codes WHERE user_id = $1', [userId]);
      for (const item of hashedCodes) {
        await c.query(
          `INSERT INTO user_mfa_recovery_codes (user_id, code_salt_hex, code_sha256) VALUES ($1, $2, $3)`,
          [userId, item.saltHex, item.sha256Hex]
        );
      }
    });
  }

  /**
   * Verifica y consume un codigo de recuperacion MFA en tiempo constante.
   */
  public async verifyAndConsumeRecoveryCode(
    userId: string,
    plainCode: string,
    ipAddress: string,
    client?: PoolClient
  ): Promise<boolean> {
    return this.executeWithRls(client, { userId }, async (c) => {
      const rows = await this.query<{ id: string; code_salt_hex: string; code_sha256: string }>(
        'SELECT id, code_salt_hex, code_sha256 FROM user_mfa_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL',
        [userId],
        c,
        { userId }
      );
      for (const row of rows) {
        const candidateHash = CryptoUtils.sha256Hex(`${row.code_salt_hex}:${plainCode.trim().toUpperCase()}`);
        if (CryptoUtils.timingSafeEqualHex(candidateHash, row.code_sha256)) {
          await c.query('UPDATE user_mfa_recovery_codes SET consumed_at = NOW(), consumed_ip = $1 WHERE id = $2', [ipAddress, row.id]);
          return true;
        }
      }
      return false;
    });
  }

  public async countRemainingRecoveryCodes(userId: string, client?: PoolClient): Promise<number> {
    const rows = await this.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM user_mfa_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
      client,
      { userId }
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Desactiva por completo el segundo factor de un usuario (C1-41): limpia secreto TOTP,
   * credenciales WebAuthn y codigos de respaldo. Debe invocarse en `runInAtomicTransaction`.
   *
   * @param userId - Usuario cuyo factor queda desactivado.
   * @param client - Cliente transaccional del flujo de reseteo.
   */
  public async deactivateUserMfaCompletely(userId: string, client?: PoolClient): Promise<void> {
    await this.query(
      `UPDATE users SET mfa_totp_enabled = FALSE, mfa_totp_secret_enc = NULL, mfa_webauthn_enabled = FALSE, mfa_webauthn_credentials_json = '[]'::jsonb, updated_at = NOW() WHERE id = $1`,
      [userId],
      client,
      { userId }
    );
    await this.query(`DELETE FROM user_mfa_recovery_codes WHERE user_id = $1`, [userId], client, { userId });
  }

  /**
   * Crea una solicitud Break-Glass para recuperacion de Owner unico.
   */
  public async createBreakGlassRequest(
    data: { organizationId: string; userId: string; dnsTxtVerificationToken: string; requestIp: string },
    client?: PoolClient
  ): Promise<BreakGlassRequestRecord> {
    const sql = "INSERT INTO mfa_break_glass_requests (organization_id, user_id, dns_txt_verification_token, request_ip, status) VALUES ($1, $2, $3, $4, 'PENDING_DNS_OR_WHOP_CHALLENGE') RETURNING *";
    const rows = await this.query(sql, [data.organizationId, data.userId, data.dnsTxtVerificationToken, data.requestIp], client, { userId: data.userId, orgId: data.organizationId });
    return IdentityAdvancedRowMapper.mapBreakGlassRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Busca la solicitud Break-Glass activa para una organizacion y usuario.
   */
  public async findActiveBreakGlassRequest(
    organizationId: string,
    userId: string,
    client?: PoolClient
  ): Promise<BreakGlassRequestRecord | null> {
    const rows = await this.query(
      `SELECT * FROM mfa_break_glass_requests
       WHERE organization_id = $1 AND user_id = $2
         AND status IN ('PENDING_DNS_OR_WHOP_CHALLENGE', 'COOLING_OFF_24H', 'PENDING_SUPERADMIN_APPROVAL')
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId, userId],
      client,
      { userId, orgId: organizationId }
    );
    if (rows.length === 0 || !rows[0]) return null;
    return IdentityAdvancedRowMapper.mapBreakGlassRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Marca el reto DNS o Whop de una solicitud Break-Glass como superado y arranca el enfriamiento de 24h.
   */
  public async markBreakGlassChallengeVerified(requestId: string, whopReceiptId?: string, client?: PoolClient): Promise<void> {
    const sql = "UPDATE mfa_break_glass_requests SET status = 'COOLING_OFF_24H', challenge_verified_at = NOW(), cooling_off_ends_at = NOW() + INTERVAL '24 hours', whop_last_receipt_id_verified = COALESCE($2, whop_last_receipt_id_verified) WHERE id = $1";
    await this.query(sql, [requestId, whopReceiptId ?? null], client, { isSuperAdmin: true });
  }

  /**
   * Registra un token efimero de restablecimiento de contrasena (TTL 15m).
   */
  public async createPasswordResetToken(
    userId: string, tokenSha256: string, requestIp: string, userAgent: string | undefined, expiresAt: Date, client?: PoolClient
  ): Promise<void> {
    const sql = 'INSERT INTO password_reset_tokens (user_id, token_sha256, request_ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)';
    await this.query(sql, [userId, tokenSha256, requestIp, userAgent ?? null, expiresAt], client, { userId });
  }

  /**
   * Busca y valida un token de restablecimiento de contrasena no usado ni expirado.
   *
   * Primitiva de lectura: el flujo de confirmacion debe usar `consumePasswordResetTokenAtomically`
   * dentro de `runInAtomicTransaction`, pues leer y marcar por separado permite doble consumo.
   */
  public async findValidPasswordResetToken(
    tokenSha256: string,
    client?: PoolClient
  ): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
    const rows = await this.query<{ id: string; user_id: string; expires_at: Date }>(
      `SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [tokenSha256],
      client,
      { isSuperAdmin: true }
    );
    if (rows.length === 0 || !rows[0]) return null;
    return { id: rows[0].id, userId: rows[0].user_id, expiresAt: rows[0].expires_at };
  }

  /**
   * Marca un token de recuperacion como consumido.
   *
   * Primitiva de escritura: el flujo de confirmacion debe usar `consumePasswordResetTokenAtomically`
   * dentro de `runInAtomicTransaction`, pues marcar por separado de la lectura permite doble consumo.
   */
  public async markPasswordResetTokenUsed(tokenId: string, client?: PoolClient): Promise<void> {
    await this.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [tokenId], client);
  }

  /**
   * Consume de forma atomica un token valido (C1-41): un unico UPDATE condicional marca y
   * proyecta, de modo que ante confirmaciones concurrentes solo una obtiene fila. Debe
   * invocarse en `runInAtomicTransaction` junto con el cambio de contrasena y la revocacion.
   *
   * @param tokenSha256 - Resumen SHA-256 en hex del token presentado.
   * @param client - Cliente transaccional del flujo de confirmacion.
   * @returns Registro consumido o null si es invalido, expirado o ya usado.
   */
  public async consumePasswordResetTokenAtomically(
    tokenSha256: string,
    client?: PoolClient
  ): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
    const rows = await this.query<{ id: string; user_id: string; expires_at: Date }>(
      `UPDATE password_reset_tokens SET used_at = NOW()
        WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING id, user_id, expires_at`,
      [tokenSha256],
      client,
      { isSuperAdmin: true }
    );
    if (rows.length === 0 || !rows[0]) return null;
    return { id: rows[0].id, userId: rows[0].user_id, expiresAt: rows[0].expires_at };
  }

  /**
   * Actualiza el hash de contrasena de un usuario tras un restablecimiento validado.
   */
  public async updateUserPasswordHash(userId: string, passwordHash: string, client?: PoolClient): Promise<void> {
    await this.query(
      `UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [userId, passwordHash],
      client,
      { userId }
    );
  }

  /**
   * Busca una organizacion por su dominio de correo corporativo para SSO SAML.
   */
  public async findOrganizationBySsoDomain(domain: string, client?: PoolClient): Promise<OrganizationEntity | null> {
    const rows = await this.query(
      `SELECT * FROM organizations WHERE sso_email_domain = $1 LIMIT 1`,
      [domain.trim().toLowerCase()],
      client,
      { isSuperAdmin: true }
    );
    if (rows.length === 0 || !rows[0]) return null;
    return IdentityRowMapper.mapOrgRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Crea una invitacion a la organizacion para un nuevo miembro.
   */
  public async createOrganizationInvitation(
    data: { organizationId: string; userId: string; role: string; invitedByUserId: string; invitationTokenSha256: string; invitationExpiresAt: Date },
    client?: PoolClient
  ): Promise<MembershipInvitationRecord> {
    const sql = 'INSERT INTO memberships (organization_id, user_id, role, invited_by_user_id, invitation_token_sha256, invitation_expires_at, is_active) VALUES ($1, $2, $3, $4, $5, $6, FALSE) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id, invitation_token_sha256 = EXCLUDED.invitation_token_sha256, invitation_expires_at = EXCLUDED.invitation_expires_at, invitation_accepted_at = NULL, is_active = FALSE RETURNING *';
    const rows = await this.query(sql, [data.organizationId, data.userId, data.role, data.invitedByUserId, data.invitationTokenSha256, data.invitationExpiresAt], client, { orgId: data.organizationId, isSuperAdmin: true });
    return IdentityAdvancedRowMapper.mapMembershipRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Busca una invitacion valida por su hash SHA-256.
   */
  public async findInvitationByTokenSha256(tokenSha256: string, client?: PoolClient): Promise<MembershipInvitationRecord | null> {
    const rows = await this.query(
      `SELECT * FROM memberships 
       WHERE invitation_token_sha256 = $1 AND invitation_accepted_at IS NULL 
         AND (invitation_expires_at IS NULL OR invitation_expires_at > NOW()) LIMIT 1`,
      [tokenSha256],
      client,
      { isSuperAdmin: true }
    );
    if (rows.length === 0 || !rows[0]) return null;
    return IdentityAdvancedRowMapper.mapMembershipRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Activa la membresia del destinatario sin reescribir jamas el titular.
   * Solo marca la fila si el aceptante es el destinatario original
   * (`WHERE id = $1 AND user_id = $2`): un aceptante ajeno no apropia nada.
   */
  public async acceptOrganizationInvitation(invitationId: string, acceptingUserId: string, client?: PoolClient): Promise<void> {
    await this.query(
      `UPDATE memberships SET invitation_accepted_at = NOW(), is_active = TRUE WHERE id = $1 AND user_id = $2`,
      [invitationId, acceptingUserId],
      client,
      { userId: acceptingUserId }
    );
  }

  /**
   * Obtiene todos los documentos legales activos y obligatorios.
   */
  public async findActiveMandatoryLegalDocuments(client?: PoolClient): Promise<readonly LegalDocumentRecord[]> {
    const rows = await this.query(`SELECT * FROM legal_documents WHERE is_active = TRUE AND is_mandatory = TRUE ORDER BY doc_type ASC`, [], client);
    return rows.map((r) => IdentityAdvancedRowMapper.mapLegalDocRow(r as Record<string, unknown>));
  }

  /**
   * Busca un documento legal por su identificador para derivar el sello en servidor.
   *
   * @param legalDocumentId - Identificador del documento a resolver desde el catalogo.
   * @param client - Cliente transaccional opcional.
   * @returns Registro del catalogo o `null` cuando el identificador es desconocido.
   */
  public async findLegalDocumentById(legalDocumentId: string, client?: PoolClient): Promise<LegalDocumentRecord | null> {
    const rows = await this.query(`SELECT * FROM legal_documents WHERE id = $1 LIMIT 1`, [legalDocumentId], client);
    if (rows.length === 0 || !rows[0]) return null;
    return IdentityAdvancedRowMapper.mapLegalDocRow(rows[0] as Record<string, unknown>);
  }

  /**
   * Encuentra que documentos obligatorios no han sido aceptados por el usuario.
   */
  public async findMissingLegalAcceptances(
    userId: string,
    organizationId: string,
    mandatoryDocs: ReadonlyArray<{ id: string; sha256: string; docType: string }>,
    client?: PoolClient
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const doc of mandatoryDocs) {
      const rows = await this.query(
        `SELECT id FROM user_legal_acceptances 
         WHERE user_id = $1 AND legal_document_id = $2 AND organization_id = $3 
           AND document_sha256_snapshot = $4 LIMIT 1`,
        [userId, doc.id, organizationId, doc.sha256],
        client,
        { userId, orgId: organizationId }
      );
      if (rows.length === 0) {
        missing.push(doc.docType);
      }
    }
    return missing;
  }

  /**
   * Registra la aceptacion formal de un instrumento legal por un usuario y tenant.
   */
  public async recordLegalAcceptance(
    data: { userId: string; organizationId: string | null; legalDocumentId: string; documentSha256Snapshot: string; ipAddress: string; userAgent: string },
    client?: PoolClient
  ): Promise<void> {
    const sql = 'INSERT INTO user_legal_acceptances (user_id, organization_id, legal_document_id, document_sha256_snapshot, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, legal_document_id, organization_id) DO UPDATE SET document_sha256_snapshot = EXCLUDED.document_sha256_snapshot, ip_address = EXCLUDED.ip_address, user_agent = EXCLUDED.user_agent, accepted_at = NOW()';
    await this.query(sql, [data.userId, data.organizationId, data.legalDocumentId, data.documentSha256Snapshot, data.ipAddress, data.userAgent], client, { userId: data.userId, orgId: data.organizationId ?? undefined });
  }

  /**
   * Registra la firma del DPA empresarial a nivel de organizacion.
   */
  public async signDpaForOrganization(organizationId: string, ipAddress: string, client?: PoolClient): Promise<void> {
    await this.query(
      `UPDATE organizations SET dpa_signed_at = NOW(), dpa_clickwrap_ip = $2 WHERE id = $1`,
      [organizationId, ipAddress],
      client,
      { orgId: organizationId }
    );
  }

  /**
   * Lista los miembros de una organizacion para operaciones en lote.
   */
  public async findOrganizationMembers(organizationId: string, client?: PoolClient): Promise<ReadonlyArray<{ userId: string; role: string }>> {
    const rows = await this.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM memberships WHERE organization_id = $1 AND is_active = TRUE`,
      [organizationId],
      client,
      { orgId: organizationId }
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
  }

  /**
   * Recopila el expediente completo de datos de un usuario para cumplimiento GDPR.
   */
  public async exportGdprUserData(userId: string, client?: PoolClient): Promise<Record<string, unknown>> {
    return this.executeWithRls(client, { userId }, async (c) => {
      const userRes = await c.query('SELECT id, email, full_name, created_at FROM users WHERE id = $1', [userId]);
      const membershipsRes = await c.query(
        'SELECT m.role, m.is_active, m.created_at, o.name AS organization_name, o.slug AS organization_slug FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1',
        [userId]
      );
      const legalRes = await c.query(
        'SELECT a.document_sha256_snapshot, a.accepted_at, a.ip_address, d.doc_type, d.version_tag, d.title FROM user_legal_acceptances a JOIN legal_documents d ON d.id = a.legal_document_id WHERE a.user_id = $1',
        [userId]
      );
      return { profile: userRes.rows[0] ?? null, memberships: membershipsRes.rows, legalAcceptances: legalRes.rows, exportedAt: new Date().toISOString() };
    });
  }
}
