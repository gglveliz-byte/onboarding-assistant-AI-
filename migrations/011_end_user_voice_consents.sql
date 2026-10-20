-- =============================================================================
-- MIGRACION 011: CONSENTIMIENTO DE VOZ DE USUARIOS FINALES (EVIDENCIA B2B)
-- =============================================================================
-- @archivo migrations/011_end_user_voice_consents.sql
-- @modulo 01-identity-and-rbac / 02-projects-and-keys (Legal y API de clientes)
-- @proposito
--   Crea la tabla `end_user_voice_consents`, evidencia auditable de que el cliente B2B
--   obtuvo el consentimiento de voz de cada usuario final antes de activar el micrófono.
--   El owner acepta el instrumento `END_USER_VOICE_CONSENT` en el alta como compromiso
--   B2B; su sistema certifica después cada consentimiento individual mediante
--   `POST /api/v1/public/end-user-consents`, autenticado con una clave `sk_live_...`.
--
-- @resumen_contenido
--   - Tabla `end_user_voice_consents` con evidencia versionada (SHA-256 del documento).
--   - Unicidad por organización, proyecto, usuario final y documento (upsert idempotente).
--   - Índices de consulta por organización/usuario final y por proyecto/fecha.
--   - RLS FORCE con aislamiento por organización y escape de SuperAdmin.
--   - Trigger `updated_at` y privilegios para el rol de aplicación `oa_app`.
--
-- @dependencias_internas
--   - `migrations/001_extensions_enums_and_rls_functions.sql` (`gen_random_uuid()`,
--     `trigger_set_updated_at()`, `app_current_org_id()`, `app_is_superadmin()`).
--   - `migrations/002_identity_sessions_mfa_and_legal_tables.sql` (`legal_documents`).
--   - `migrations/003_projects_domains_keys_and_rag_maps_tables.sql` (`projects`, `api_keys`).
--   - `migrations/005_row_level_security_policies_and_indexes.sql` (patrón de políticas).
--   - `migrations/007_application_role_without_bypassrls_and_identity_rls.sql` (`oa_app`).
--
-- @tablas_bd_o_redis
--   - PostgreSQL: `end_user_voice_consents` (nueva tabla append/upsert con RLS).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLA: end_user_voice_consents (Evidencia de consentimiento de voz)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS end_user_voice_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    external_end_user_id VARCHAR(255) NOT NULL,
    legal_document_id UUID NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
    document_version_tag VARCHAR(32) NOT NULL,
    document_sha256_snapshot CHAR(64) NOT NULL,
    consent_granted BOOLEAN NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    client_ip_hash CHAR(64),
    user_agent TEXT,
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_end_user_voice_consents_identity
        UNIQUE (organization_id, project_id, external_end_user_id, legal_document_id),
    CONSTRAINT chk_end_user_voice_consents_external_id
        CHECK (char_length(btrim(external_end_user_id)) BETWEEN 1 AND 255)
);

COMMENT ON TABLE end_user_voice_consents IS
    'Evidencia auditable del consentimiento de voz que el cliente B2B obtuvo de cada usuario final.';
COMMENT ON COLUMN end_user_voice_consents.external_end_user_id IS
    'Identificador pseudónimo del usuario final en el sistema del cliente B2B.';
COMMENT ON COLUMN end_user_voice_consents.client_ip_hash IS
    'SHA-256 hexadecimal de la IP de origen; nunca se almacena la IP en claro.';
COMMENT ON COLUMN end_user_voice_consents.evidence_json IS
    'Evidencia adicional aportada por el cliente (origen, texto mostrado, metadatos); máximo 8 KB validado en aplicación.';

-- -----------------------------------------------------------------------------
-- 2. ÍNDICES DE CONSULTA Y AUDITORÍA
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_end_user_voice_consents_org_user
    ON end_user_voice_consents(organization_id, external_end_user_id);

CREATE INDEX IF NOT EXISTS idx_end_user_voice_consents_project_granted
    ON end_user_voice_consents(project_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS idx_end_user_voice_consents_document
    ON end_user_voice_consents(legal_document_id);

-- -----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY: AISLAMIENTO ESTRICTO POR ORGANIZACIÓN
-- -----------------------------------------------------------------------------
ALTER TABLE end_user_voice_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_user_voice_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_end_user_voice_consents_isolation ON end_user_voice_consents;
CREATE POLICY rls_end_user_voice_consents_isolation ON end_user_voice_consents
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- El rol de aplicación solo necesita leer, insertar y actualizar la evidencia.
-- La eliminación queda reservada al propietario del esquema (borrado GDPR controlado).
GRANT SELECT, INSERT, UPDATE ON end_user_voice_consents TO oa_app;

-- -----------------------------------------------------------------------------
-- 4. TRIGGER DE ACTUALIZACIÓN AUTOMÁTICA DE `updated_at`
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_end_user_voice_consents_updated_at ON end_user_voice_consents;
CREATE TRIGGER trg_end_user_voice_consents_updated_at
    BEFORE UPDATE ON end_user_voice_consents
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
