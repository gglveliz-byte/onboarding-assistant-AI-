/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/identity-row.mapper.ts
 * @modulo 01-identity-and-rbac (Mapeadores de Filas SQL y DTOs de Persistencia)
 * @proposito
 *   Transforma registros en crudo de PostgreSQL (snake_case) a entidades inmutables de
 *   dominio en camelCase (`UserEntity`, `OrganizationEntity`, `MembershipEntity` y
 *   `AuthSessionEntity`). Desacopla la estructura física de la base de datos del modelo
 *   de dominio y evita exceder el límite de 500 líneas en el repositorio.
 *
 * @resumen_contenido
 *   - Interfaces DTO: `CreateUserData`, `CreateOrganizationData`, `CreateAuthSessionData`.
 *   - Clase `IdentityRowMapper`:
 *       * `mapUserRow()`: Convierte fila de `users` a `UserEntity`.
 *       * `mapOrgRow()`: Convierte fila de `organizations` a `OrganizationEntity`.
 *       * `mapMembershipRow()`: Convierte fila de `memberships` a `MembershipEntity`.
 *       * `mapAuthSessionRow()`: Convierte fila de `auth_sessions` a `AuthSessionEntity`.
 *
 * @dependencias_internas
 *   - Entidades de dominio (`../domain/identity.entities.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Funciones puras de transformacion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users`, `organizations`, `memberships`, `auth_sessions`.
 */

import type {
  AuthSessionEntity,
  MembershipEntity,
  OrganizationEntity,
  OrganizationStatus,
  RbacRole,
  UserEntity,
} from '../domain/identity.entities';

/** Datos necesarios para crear un nuevo usuario. */
export interface CreateUserData {
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string | null;
  readonly tokenVersion?: number;
  readonly isPlatformSuperadmin?: boolean;
  readonly otpSha256?: string | null;
  readonly otpExpiresAt?: Date | null;
}

/** Datos necesarios para crear una nueva organizacion. */
export interface CreateOrganizationData {
  readonly name: string;
  readonly slug: string;
  readonly enforceMfa?: boolean;
  readonly enforceSso?: boolean;
  readonly ssoEmailDomain?: string | null;
  readonly dpaSignedAt?: Date | null;
  readonly dpaClickwrapIp?: string | null;
}

/** Datos para registrar una nueva sesion de autenticacion. */
export interface CreateAuthSessionData {
  readonly userId: string;
  readonly organizationId?: string | null;
  readonly tokenFamilyId: string;
  readonly refreshTokenSha256: string;
  readonly parentTokenSha256?: string | null;
  readonly tokenVersionSnapshot: number;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly expiresAt: Date;
}

/**
 * Mapeador estatico para convertir filas crudas de PostgreSQL a entidades de dominio.
 */
export class IdentityRowMapper {
  /**
   * Mapea una fila SQL de la tabla `users` a `UserEntity`.
   *
   * @param row - Registro crudo devuelto por el driver pg.
   * @returns Entidad de dominio UserEntity.
   */
  public static mapUserRow(row: Record<string, unknown>): UserEntity {
    return {
      id: String(row['id']),
      email: String(row['email']),
      fullName: String(row['full_name']),
      passwordHash: row['password_hash'] ? String(row['password_hash']) : null,
      tokenVersion: Number(row['token_version']),
      isPlatformSuperadmin: Boolean(row['is_platform_superadmin']),
      emailVerifiedAt: row['email_verified_at'] ? new Date(String(row['email_verified_at'])) : null,
      emailVerificationOtpSha256: row['email_verification_otp_sha256'] ? String(row['email_verification_otp_sha256']) : null,
      emailVerificationExpiresAt: row['email_verification_expires_at'] ? new Date(String(row['email_verification_expires_at'])) : null,
      mfaTotpEnabled: Boolean(row['mfa_totp_enabled']),
      mfaTotpSecretEnc: row['mfa_totp_secret_enc'] ? (row['mfa_totp_secret_enc'] as Buffer) : null,
      mfaWebauthnEnabled: Boolean(row['mfa_webauthn_enabled']),
      mfaWebauthnCredentialsJson: row['mfa_webauthn_credentials_json'],
      oauthGoogleSub: row['oauth_google_sub'] ? String(row['oauth_google_sub']) : null,
      oauthGithubId: row['oauth_github_id'] ? String(row['oauth_github_id']) : null,
      oauthMicrosoftOid: row['oauth_microsoft_oid'] ? String(row['oauth_microsoft_oid']) : null,
      failedLoginAttempts: Number(row['failed_login_attempts']),
      lockedUntil: row['locked_until'] ? new Date(String(row['locked_until'])) : null,
      lastLoginAt: row['last_login_at'] ? new Date(String(row['last_login_at'])) : null,
      lastLoginIp: row['last_login_ip'] ? String(row['last_login_ip']) : null,
      createdAt: new Date(String(row['created_at'])),
      updatedAt: new Date(String(row['updated_at'])),
    };
  }

  /**
   * Mapea una fila SQL de la tabla `organizations` a `OrganizationEntity`.
   *
   * @param row - Registro crudo devuelto por el driver pg.
   * @returns Entidad de dominio OrganizationEntity.
   */
  public static mapOrgRow(row: Record<string, unknown>): OrganizationEntity {
    return {
      id: String(row['id']),
      name: String(row['name']),
      slug: String(row['slug']),
      status: String(row['status']) as OrganizationStatus,
      enforceMfa: Boolean(row['enforce_mfa']),
      enforceSso: Boolean(row['enforce_sso']),
      ssoIdpMetadataXml: row['sso_idp_metadata_xml'] ? String(row['sso_idp_metadata_xml']) : null,
      ssoIdpEntrypointUrl: row['sso_idp_entrypoint_url'] ? String(row['sso_idp_entrypoint_url']) : null,
      ssoIdpX509Cert: row['sso_idp_x509_cert'] ? String(row['sso_idp_x509_cert']) : null,
      ssoEmailDomain: row['sso_email_domain'] ? String(row['sso_email_domain']) : null,
      optInSessionTranscripts: Boolean(row['opt_in_session_transcripts']),
      dpaSignedAt: row['dpa_signed_at'] ? new Date(String(row['dpa_signed_at'])) : null,
      dpaClickwrapIp: row['dpa_clickwrap_ip'] ? String(row['dpa_clickwrap_ip']) : null,
      suspendedReason: row['suspended_reason'] ? String(row['suspended_reason']) : null,
      suspendedAt: row['suspended_at'] ? new Date(String(row['suspended_at'])) : null,
      suspendedByUserId: row['suspended_by_user_id'] ? String(row['suspended_by_user_id']) : null,
      createdAt: new Date(String(row['created_at'])),
      updatedAt: new Date(String(row['updated_at'])),
    };
  }

  /**
   * Mapea una fila SQL de la tabla `memberships` a `MembershipEntity`.
   *
   * @param row - Registro crudo devuelto por el driver pg.
   * @returns Entidad de dominio MembershipEntity.
   */
  public static mapMembershipRow(row: Record<string, unknown>): MembershipEntity {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      userId: String(row['user_id']),
      role: String(row['role']) as RbacRole,
      invitedByUserId: row['invited_by_user_id'] ? String(row['invited_by_user_id']) : null,
      invitationTokenSha256: row['invitation_token_sha256'] ? String(row['invitation_token_sha256']) : null,
      invitationExpiresAt: row['invitation_expires_at'] ? new Date(String(row['invitation_expires_at'])) : null,
      invitationAcceptedAt: row['invitation_accepted_at'] ? new Date(String(row['invitation_accepted_at'])) : null,
      isActive: Boolean(row['is_active']),
      createdAt: new Date(String(row['created_at'])),
      updatedAt: new Date(String(row['updated_at'])),
    };
  }

  /**
   * Mapea una fila SQL de la tabla `auth_sessions` a `AuthSessionEntity`.
   *
   * @param row - Registro crudo devuelto por el driver pg.
   * @returns Entidad de dominio AuthSessionEntity.
   */
  public static mapAuthSessionRow(row: Record<string, unknown>): AuthSessionEntity {
    return {
      id: String(row['id']),
      userId: String(row['user_id']),
      organizationId: row['organization_id'] ? String(row['organization_id']) : null,
      tokenFamilyId: String(row['token_family_id']),
      refreshTokenSha256: String(row['refresh_token_sha256']),
      parentTokenSha256: row['parent_token_sha256'] ? String(row['parent_token_sha256']) : null,
      tokenVersionSnapshot: Number(row['token_version_snapshot']),
      ipAddress: String(row['ip_address']),
      userAgent: String(row['user_agent']),
      consumedAt: row['consumed_at'] ? new Date(String(row['consumed_at'])) : null,
      revokedAt: row['revoked_at'] ? new Date(String(row['revoked_at'])) : null,
      revocationReason: row['revocation_reason'] ? String(row['revocation_reason']) : null,
      expiresAt: new Date(String(row['expires_at'])),
      createdAt: new Date(String(row['created_at'])),
    };
  }
}
