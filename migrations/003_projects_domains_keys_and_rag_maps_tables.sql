/**
 * @archivo migrations/003_projects_domains_keys_and_rag_maps_tables.sql
 * @modulo 02-projects-and-keys & 03-visual-trainer-and-rag
 * @proposito
 *   Define las tablas fisicas para la gestion de proyectos, lista blanca de dominios
 *   autorizados para el Handshake del SDK (`allowed_domains`), ciclo de vida de API Keys
 *   hasheadas con SHA-256 (`pk_live_` / `sk_live_`), sesiones del navegador efimero de
 *   entrenamiento visual con blindaje Anti-SSRF, versiones inmutables del Mapa Funcional
 *   RAG (`SHA-256`) y elementos DOM indexados con coordenadas responsive y `pgvector`.
 *
 * @resumen_contenido
 *   - Tabla `projects`: Configuracion de voz, modelos IA, System Prompt y flujo de pasos.
 *   - Tabla `api_keys`: Claves publicas y secretas (SHA-256) con rotacion y ventana de gracia.
 *   - Tabla `allowed_domains`: Origenes CORS/SDK permitidos por proyecto.
 *   - Tabla `training_browser_sessions`: Registro de sesiones Chromium efimeras y DNS Pinning.
 *   - Tabla `functional_maps`: Mapas RAG inmutables con JSON canonico RFC 8785 y SHA-256.
 *   - Tabla `map_elements`: Nodos DOM con Titulo, Descripcion, Accion (Click/Type/Ambos),
 *     selectores estables, bounding boxes (Desktop/Tablet/Mobile) y `vector(1536)`.
 *   - Tabla `prompt_versions`: Historial versionado de System Prompts y pasos por proyecto.
 *
 * @dependencias_internas
 *   - Requiere `001_extensions_enums_and_rls_functions.sql` y `002_identity_sessions_mfa_and_legal_tables.sql`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`, `training_browser_sessions`,
 *     `functional_maps`, `map_elements`, `prompt_versions`.
 */

BEGIN;

-- =============================================================================
-- 1. TABLA: projects (Proyectos dentro de una Organizacion + Estudio del Prompt)
-- =============================================================================
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(140) NOT NULL,
    slug CITEXT NOT NULL,
    environment api_key_env_enum NOT NULL DEFAULT 'LIVE',
    primary_voice_model ai_voice_model_enum NOT NULL DEFAULT 'GEMINI_3_8_LIVE',
    fallback_voice_model ai_voice_model_enum NOT NULL DEFAULT 'QWEN_3_8_OMNI_FLASH_REALTIME',
    voice_persona_code VARCHAR(64) NOT NULL DEFAULT 'aura-es-neutral',
    speech_speed NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (speech_speed BETWEEN 0.50 AND 2.00),
    vad_barge_in_sensitivity VARCHAR(16) NOT NULL DEFAULT 'BALANCED' CHECK (vad_barge_in_sensitivity IN ('LOW', 'BALANCED', 'HIGH')),
    model_temperature NUMERIC(3,2) NOT NULL DEFAULT 0.20 CHECK (model_temperature BETWEEN 0.00 AND 1.00),
    system_prompt TEXT NOT NULL DEFAULT 'Eres el asistente tecnico interactivo de la plataforma. Guia al usuario paso a paso.',
    onboarding_steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    strict_step_enforcement BOOLEAN NOT NULL DEFAULT TRUE,
    ask_confirmation_before_submit BOOLEAN NOT NULL DEFAULT TRUE,
    active_functional_map_id UUID,
    active_prompt_version_number INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug),
    CONSTRAINT chk_project_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(organization_id);

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 2. TABLA: api_keys (Claves Publicas del SDK y Secretas de Backend con SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    key_type api_key_type_enum NOT NULL,
    environment api_key_env_enum NOT NULL DEFAULT 'LIVE',
    key_prefix VARCHAR(24) NOT NULL,
    last_four CHAR(4) NOT NULL,
    key_hash CHAR(64) NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    rotated_from_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    grace_period_ends_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    last_used_ip INET,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org_project ON api_keys(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- =============================================================================
-- 3. TABLA: allowed_domains (Origenes Autorizados para el Handshake del SDK)
-- =============================================================================
CREATE TABLE IF NOT EXISTS allowed_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin_pattern CITEXT NOT NULL,
    allow_localhost_dev BOOLEAN NOT NULL DEFAULT FALSE,
    dns_verification_token VARCHAR(120),
    dns_verified_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, origin_pattern)
);

CREATE INDEX IF NOT EXISTS idx_allowed_domains_project_active ON allowed_domains(project_id, origin_pattern) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_allowed_domains_org_id ON allowed_domains(organization_id);

-- =============================================================================
-- 4. TABLA: training_browser_sessions (Sesiones Efimeras Chromium + Escudo Anti-SSRF)
-- =============================================================================
CREATE TABLE IF NOT EXISTS training_browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_channel VARCHAR(24) NOT NULL DEFAULT 'WEB_DASHBOARD' CHECK (source_channel IN ('WEB_DASHBOARD', 'CLI_TUNNEL')),
    target_url TEXT NOT NULL,
    pinned_public_ip INET,
    status training_session_status_enum NOT NULL DEFAULT 'PROVISIONING_CONTAINER',
    ephemeral_container_id VARCHAR(128),
    active_viewport VARCHAR(16) NOT NULL DEFAULT 'desktop' CHECK (active_viewport IN ('desktop', 'tablet', 'mobile')),
    ssrf_blocked_attempts_count INTEGER NOT NULL DEFAULT 0,
    last_ssrf_blocked_url TEXT,
    hard_ttl_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
    destroyed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_org_project ON training_browser_sessions(organization_id, project_id);

DROP TRIGGER IF EXISTS trg_training_sessions_updated_at ON training_browser_sessions;
CREATE TRIGGER trg_training_sessions_updated_at
    BEFORE UPDATE ON training_browser_sessions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 5. TABLA: functional_maps (Versiones Inmutables del Mapa Funcional RAG SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS functional_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    version_label VARCHAR(120),
    source_mode VARCHAR(32) NOT NULL DEFAULT 'VISUAL_TRAINER' CHECK (source_mode IN ('VISUAL_TRAINER', 'JSON_CODE_EDITOR', 'CLI_PUSH')),
    canonical_map_json JSONB NOT NULL,
    content_sha256_hash CHAR(64) NOT NULL,
    total_elements_count INTEGER NOT NULL DEFAULT 0 CHECK (total_elements_count >= 0),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, version_number),
    UNIQUE (project_id, content_sha256_hash)
);

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS fk_projects_active_functional_map;
ALTER TABLE projects
    ADD CONSTRAINT fk_projects_active_functional_map
    FOREIGN KEY (active_functional_map_id) REFERENCES functional_maps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_functional_maps_project_active ON functional_maps(project_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_functional_maps_org_id ON functional_maps(organization_id);

-- =============================================================================
-- 6. TABLA: map_elements (Elementos DOM Indexados, Selectores y Coordenadas Responsive)
-- =============================================================================
CREATE TABLE IF NOT EXISTS map_elements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    functional_map_id UUID NOT NULL REFERENCES functional_maps(id) ON DELETE CASCADE,
    element_key VARCHAR(120) NOT NULL,
    url_route_pattern VARCHAR(512) NOT NULL DEFAULT '/',
    title VARCHAR(200) NOT NULL,
    functional_description TEXT NOT NULL,
    is_actionable BOOLEAN NOT NULL DEFAULT FALSE,
    action_type dom_action_type_enum NOT NULL DEFAULT 'NONE',
    step_order_hint INTEGER,
    primary_selector TEXT NOT NULL,
    accessibility_selector TEXT,
    structural_css_selector TEXT,
    xpath_fallback TEXT,
    selector_stability_score SMALLINT NOT NULL DEFAULT 100 CHECK (selector_stability_score BETWEEN 0 AND 100),
    desktop_bbox_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    tablet_bbox_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    mobile_bbox_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    element_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    semantic_embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (functional_map_id, element_key),
    CONSTRAINT chk_actionable_consistency CHECK (
        (is_actionable = FALSE AND action_type = 'NONE') OR
        (is_actionable = TRUE AND action_type IN ('CLICK', 'TYPE', 'BOTH'))
    )
);

CREATE INDEX IF NOT EXISTS idx_map_elements_map_route ON map_elements(functional_map_id, url_route_pattern);
CREATE INDEX IF NOT EXISTS idx_map_elements_org_project ON map_elements(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_map_elements_embedding_hnsw ON map_elements USING hnsw (semantic_embedding vector_cosine_ops);

DROP TRIGGER IF EXISTS trg_map_elements_updated_at ON map_elements;
CREATE TRIGGER trg_map_elements_updated_at
    BEFORE UPDATE ON map_elements
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 7. TABLA: prompt_versions (Versionado Inmutable del Estudio del Prompt)
-- =============================================================================
CREATE TABLE IF NOT EXISTS prompt_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    system_prompt TEXT NOT NULL,
    onboarding_steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    primary_voice_model ai_voice_model_enum NOT NULL,
    fallback_voice_model ai_voice_model_enum NOT NULL,
    model_temperature NUMERIC(3,2) NOT NULL DEFAULT 0.20,
    strict_step_enforcement BOOLEAN NOT NULL DEFAULT TRUE,
    ask_confirmation_before_submit BOOLEAN NOT NULL DEFAULT TRUE,
    updated_via_channel VARCHAR(24) NOT NULL DEFAULT 'DASHBOARD_UI' CHECK (updated_via_channel IN ('DASHBOARD_UI', 'REST_API')),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_org_project ON prompt_versions(organization_id, project_id, version_number DESC);

COMMIT;
