/**
 * @archivo migrations/002_identity_sessions_mfa_and_legal_tables.sql
 * @modulo 01-identity-and-rbac (Identidad B2B/SuperAdmin, Sesiones, MFA y Legal)
 * @proposito
 *   Crea las tablas fisicas correspondientes al plano de identidad multi-tenant,
 *   control de sesiones con Refresh Tokens rotativos, revocacion global mediante
 *   `token_version`, recuperacion de contrasena anti-enumeracion, codigos MFA,
 *   recuperacion Break-Glass de Owners y aceptacion criptografica de documentos legales.
 *
 * @resumen_contenido
 *   - Tabla `organizations`: Tenants B2B, politicas MFA/SSO SAML y firma de DPA.
 *   - Tabla `users`: Usuarios B2B y SuperAdmin, Argon2id, `token_version` y WebAuthn.
 *   - Tabla `auth_sessions`: Familias de Refresh Tokens SHA-256 para deteccion de robo.
 *   - Tabla `password_reset_tokens`: Tokens efimeros hasheados con SHA-256 (TTL 15m).
 *   - Tabla `user_mfa_recovery_codes`: Codigos de respaldo de un solo uso (SHA-256).
 *   - Tabla `mfa_break_glass_requests`: Escalamiento de emergencia para Owner unico.
 *   - Tabla `legal_documents`: Versionado de ToS, Privacidad, DPA, AUP y Consentimiento.
 *   - Tabla `user_legal_acceptances`: Evidencia inmutable de aceptacion por usuario/tenant.
 *   - Tabla `memberships`: Vinculo Usuario <-> Organizacion con rol RBAC e invitaciones.
 *
 * @dependencias_internas
 *   - Requiere `001_extensions_enums_and_rls_functions.sql`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `auth_sessions`, `password_reset_tokens`,
 *     `user_mfa_recovery_codes`, `mfa_break_glass_requests`, `legal_documents`,
 *     `user_legal_acceptances`, `memberships`.
 */

BEGIN;

-- =============================================================================
-- 1. TABLA: organizations (Tenants B2B)
-- =============================================================================
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(160) NOT NULL,
    slug CITEXT NOT NULL UNIQUE,
    status org_status_enum NOT NULL DEFAULT 'ACTIVE',
    enforce_mfa BOOLEAN NOT NULL DEFAULT FALSE,
    enforce_sso BOOLEAN NOT NULL DEFAULT FALSE,
    sso_idp_metadata_xml TEXT,
    sso_idp_entrypoint_url TEXT,
    sso_idp_x509_cert TEXT,
    sso_email_domain CITEXT UNIQUE,
    opt_in_session_transcripts BOOLEAN NOT NULL DEFAULT FALSE,
    dpa_signed_at TIMESTAMPTZ,
    dpa_clickwrap_ip INET,
    suspended_reason TEXT,
    suspended_at TIMESTAMPTZ,
    suspended_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_org_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_organizations_sso_domain ON organizations(sso_email_domain) WHERE sso_email_domain IS NOT NULL;

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 2. TABLA: users (Identidades Globales B2B y Operadores SuperAdmin)
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    full_name VARCHAR(160) NOT NULL,
    password_hash TEXT,
    token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version >= 1),
    is_platform_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
    email_verified_at TIMESTAMPTZ,
    email_verification_otp_sha256 CHAR(64),
    email_verification_expires_at TIMESTAMPTZ,
    mfa_totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_totp_secret_enc BYTEA,
    mfa_webauthn_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_webauthn_credentials_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    oauth_google_sub VARCHAR(255) UNIQUE,
    oauth_github_id VARCHAR(255) UNIQUE,
    oauth_microsoft_oid VARCHAR(255) UNIQUE,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    last_login_ip INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_superadmin_requires_webauthn_or_setup CHECK (
        is_platform_superadmin = FALSE OR password_hash IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_superadmin ON users(is_platform_superadmin) WHERE is_platform_superadmin = TRUE;

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS fk_organizations_suspended_by;
ALTER TABLE organizations
    ADD CONSTRAINT fk_organizations_suspended_by
    FOREIGN KEY (suspended_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 3. TABLA: auth_sessions (Refresh Tokens Rotativos en Cookies HttpOnly Strict)
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    token_family_id UUID NOT NULL,
    refresh_token_sha256 CHAR(64) NOT NULL UNIQUE,
    parent_token_sha256 CHAR(64),
    token_version_snapshot INTEGER NOT NULL,
    ip_address INET NOT NULL,
    user_agent TEXT NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason VARCHAR(120),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_family ON auth_sessions(token_family_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_active_lookup ON auth_sessions(refresh_token_sha256) WHERE revoked_at IS NULL;

-- =============================================================================
-- 4. TABLA: password_reset_tokens (Tokens Efimeros Hasheados con SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_sha256 CHAR(64) NOT NULL UNIQUE,
    request_ip INET NOT NULL,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwd_reset_user_active ON password_reset_tokens(user_id) WHERE used_at IS NULL;

-- =============================================================================
-- 5. TABLA: user_mfa_recovery_codes (10 Codigos de Respaldo Hasheados con SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_salt_hex CHAR(32) NOT NULL,
    code_sha256 CHAR(64) NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_ip INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, code_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_unconsumed ON user_mfa_recovery_codes(user_id) WHERE consumed_at IS NULL;

-- =============================================================================
-- 6. TABLA: mfa_break_glass_requests (Recuperacion de Emergencia para Owner Unico)
-- =============================================================================
CREATE TABLE IF NOT EXISTS mfa_break_glass_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status mfa_recovery_status_enum NOT NULL DEFAULT 'PENDING_DNS_OR_WHOP_CHALLENGE',
    dns_txt_verification_token VARCHAR(120) NOT NULL,
    whop_last_receipt_id_verified VARCHAR(140),
    challenge_verified_at TIMESTAMPTZ,
    cooling_off_ends_at TIMESTAMPTZ,
    approved_by_superadmin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    request_ip INET NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_break_glass_org_status ON mfa_break_glass_requests(organization_id, status);

DROP TRIGGER IF EXISTS trg_mfa_break_glass_updated_at ON mfa_break_glass_requests;
CREATE TRIGGER trg_mfa_break_glass_updated_at
    BEFORE UPDATE ON mfa_break_glass_requests
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 7. TABLA: legal_documents (Instrumentos Legales Versionados con SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS legal_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type legal_doc_type_enum NOT NULL,
    version_tag VARCHAR(32) NOT NULL,
    title VARCHAR(200) NOT NULL,
    content_markdown TEXT NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (doc_type, version_tag)
);

CREATE INDEX IF NOT EXISTS idx_legal_documents_active_type ON legal_documents(doc_type) WHERE is_active = TRUE;

-- =============================================================================
-- 8. TABLA: user_legal_acceptances (Evidencia Inmutable de Aceptacion Legal/DPA)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_legal_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    legal_document_id UUID NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
    document_sha256_snapshot CHAR(64) NOT NULL,
    ip_address INET NOT NULL,
    user_agent TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, legal_document_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user_org ON user_legal_acceptances(user_id, organization_id);

-- =============================================================================
-- 9. TABLA: memberships (Relacion Multi-Tenant Usuarios <-> Organizaciones + RBAC)
-- =============================================================================
CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role rbac_role_enum NOT NULL DEFAULT 'DEVELOPER',
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    invitation_token_sha256 CHAR(64) UNIQUE,
    invitation_expires_at TIMESTAMPTZ,
    invitation_accepted_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id),
    CONSTRAINT chk_no_tenant_superadmin CHECK (role <> 'SUPERADMIN')
);

CREATE INDEX IF NOT EXISTS idx_memberships_org_user ON memberships(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);

DROP TRIGGER IF EXISTS trg_memberships_updated_at ON memberships;
CREATE TRIGGER trg_memberships_updated_at
    BEFORE UPDATE ON memberships
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
