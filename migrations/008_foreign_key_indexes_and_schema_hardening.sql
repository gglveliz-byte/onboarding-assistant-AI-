/**
 * @archivo migrations/008_foreign_key_indexes_and_schema_hardening.sql
 * @modulo 00-database-core (Endurecimiento de Esquema, Indices Compuestos y Claves Foraneas)
 * @proposito
 *   Resuelve de forma definitiva los cuellos de botella de rendimiento y consistencia de
 *   esquema identificados en la auditoria adversarial del backend:
 *   - [C1-54]: Indice optimo `(created_at DESC, id DESC)` para la cadena de auditoria SHA-256.
 *   - [C1-56]: Indices `(organization_id, created_at ASC, id ASC)` y `(organization_id, created_at)`
 *     para acelerar el libro mayor contable y consultas de periodos de facturacion.
 *   - [C1-61 / C2-04]: Indices compuestos y de ordenacion para listados de claves de API,
 *     dominios autorizados, proyectos, sesiones de voz activas y organizaciones.
 *   - [C1-62]: Indices de cobertura sobre las 28 claves foraneas ausentes en migraciones 002-004.
 *   - [C2-03]: Endurecimiento de integridad referencial en tablas inmutables (`usage_ledger` y
 *     `audit_logs`) reemplazando `ON DELETE CASCADE` y `SET NULL` por `ON DELETE RESTRICT`
 *     para impedir que el borrado de entidades padre rompa el candado append-only.
 *
 * @dependencias_internas
 *   - Requiere las migraciones 001 a 007 previamente aplicadas.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs`, `usage_ledger`, `api_keys`, `allowed_domains`, `projects`,
 *     `voice_sessions`, `organizations`, `users`, `memberships`, `auth_sessions`,
 *     `mfa_break_glass_requests`, `user_legal_acceptances`, `training_browser_sessions`,
 *     `functional_maps`, `map_elements`, `prompt_versions`, `pricing_plans_config`,
 *     `organization_pricing_overrides`, `action_events`.
 */

BEGIN;

-- =============================================================================
-- 1. INDICES CRITICOS DE RENDIMIENTO: CADENA DE AUDITORIA Y LIBRO MAYOR (C1-54, C1-56)
-- =============================================================================

-- C1-54: Busqueda inmediata del eslabon previo SHA-256 (elimina Seq Scan en cada append)
CREATE INDEX IF NOT EXISTS idx_audit_logs_chain
    ON audit_logs(created_at DESC, id DESC);

-- C1-56: Paginacion ascendente determinista y acumulado por periodo del libro contable
CREATE INDEX IF NOT EXISTS idx_usage_ledger_org_created_id
    ON usage_ledger(organization_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_org_period
    ON usage_ledger(organization_id, created_at);

-- =============================================================================
-- 2. INDICES COMPUESTOS Y DE ORDENACION PARA LISTADOS DE CONTROL PLANE (C1-61, C2-04)
-- =============================================================================

-- C1-61: Listado de claves de API ordenadas por fecha reciente dentro de un proyecto
CREATE INDEX IF NOT EXISTS idx_api_keys_project_created
    ON api_keys(project_id, created_at DESC);

-- C1-61: Listado de dominios autorizados ordenados por fecha dentro de un proyecto
CREATE INDEX IF NOT EXISTS idx_allowed_domains_project_created
    ON allowed_domains(project_id, created_at DESC);

-- C1-61: Listado de proyectos ordenados por fecha dentro de una organizacion
CREATE INDEX IF NOT EXISTS idx_projects_org_created
    ON projects(organization_id, created_at DESC);

-- C2-04: Filtro de sesiones de voz activas o en streaming por organizacion
CREATE INDEX IF NOT EXISTS idx_voice_sessions_org_status
    ON voice_sessions(organization_id, status);

-- C2-04: Listado global paginado de organizaciones ordenado por fecha de creacion
CREATE INDEX IF NOT EXISTS idx_organizations_created_at_desc
    ON organizations(created_at DESC);

-- =============================================================================
-- 3. COBERTURA DE INDICES SOBRE LAS 28 CLAVES FORANEAS AUSENTES (C1-62)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_action_events_map_element_id
    ON action_events(map_element_id);

CREATE INDEX IF NOT EXISTS idx_action_events_project_id
    ON action_events(project_id);

CREATE INDEX IF NOT EXISTS idx_allowed_domains_created_by_user_id
    ON allowed_domains(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_created_by_user_id
    ON api_keys(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id
    ON api_keys(project_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_by_user_id
    ON api_keys(revoked_by_user_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_rotated_from_key_id
    ON api_keys(rotated_from_key_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_api_key_id
    ON audit_logs(actor_api_key_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id
    ON auth_sessions(organization_id);

CREATE INDEX IF NOT EXISTS idx_functional_maps_published_by_user_id
    ON functional_maps(published_by_user_id);

CREATE INDEX IF NOT EXISTS idx_map_elements_project_id
    ON map_elements(project_id);

CREATE INDEX IF NOT EXISTS idx_memberships_invited_by_user_id
    ON memberships(invited_by_user_id);

CREATE INDEX IF NOT EXISTS idx_mfa_break_glass_requests_approved_by_superadmin_id
    ON mfa_break_glass_requests(approved_by_superadmin_id);

CREATE INDEX IF NOT EXISTS idx_mfa_break_glass_requests_user_id
    ON mfa_break_glass_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_organization_pricing_overrides_created_by_superadmin_id
    ON organization_pricing_overrides(created_by_superadmin_id);

CREATE INDEX IF NOT EXISTS idx_organizations_suspended_by_user_id
    ON organizations(suspended_by_user_id);

CREATE INDEX IF NOT EXISTS idx_pricing_plans_config_updated_by_superadmin_id
    ON pricing_plans_config(updated_by_superadmin_id);

CREATE INDEX IF NOT EXISTS idx_projects_active_functional_map_id
    ON projects(active_functional_map_id);

CREATE INDEX IF NOT EXISTS idx_projects_created_by_user_id
    ON projects(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_created_by_user_id
    ON prompt_versions(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_training_browser_sessions_project_id
    ON training_browser_sessions(project_id);

CREATE INDEX IF NOT EXISTS idx_training_browser_sessions_started_by_user_id
    ON training_browser_sessions(started_by_user_id);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_project_id
    ON usage_ledger(project_id);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_whop_subscription_id
    ON usage_ledger(whop_subscription_id);

CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_legal_document_id
    ON user_legal_acceptances(legal_document_id);

CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_organization_id
    ON user_legal_acceptances(organization_id);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_api_key_id
    ON voice_sessions(api_key_id);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_functional_map_id
    ON voice_sessions(functional_map_id);

-- =============================================================================
-- 4. ENDURECIMIENTO DE CLAVES FORANEAS EN TABLAS INMUTABLES (C2-03)
-- =============================================================================

-- usage_ledger: los asientos contables son inmutables por ley y trigger;
-- no pueden ser borrados ni actualizados en cascada ante borrado fisico de entidades.
ALTER TABLE usage_ledger
    DROP CONSTRAINT IF EXISTS usage_ledger_organization_id_fkey,
    ADD CONSTRAINT usage_ledger_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE usage_ledger
    DROP CONSTRAINT IF EXISTS usage_ledger_project_id_fkey,
    ADD CONSTRAINT usage_ledger_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

ALTER TABLE usage_ledger
    DROP CONSTRAINT IF EXISTS usage_ledger_voice_session_id_fkey,
    ADD CONSTRAINT usage_ledger_voice_session_id_fkey
        FOREIGN KEY (voice_session_id) REFERENCES voice_sessions(id) ON DELETE RESTRICT;

ALTER TABLE usage_ledger
    DROP CONSTRAINT IF EXISTS usage_ledger_whop_subscription_id_fkey,
    ADD CONSTRAINT usage_ledger_whop_subscription_id_fkey
        FOREIGN KEY (whop_subscription_id) REFERENCES whop_subscriptions(id) ON DELETE RESTRICT;

-- audit_logs: las bitacoras de seguridad encadenadas SHA-256 no admiten borrado en cascada
ALTER TABLE audit_logs
    DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey,
    ADD CONSTRAINT audit_logs_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE audit_logs
    DROP CONSTRAINT IF EXISTS audit_logs_actor_user_id_fkey,
    ADD CONSTRAINT audit_logs_actor_user_id_fkey
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE audit_logs
    DROP CONSTRAINT IF EXISTS audit_logs_actor_api_key_id_fkey,
    ADD CONSTRAINT audit_logs_actor_api_key_id_fkey
        FOREIGN KEY (actor_api_key_id) REFERENCES api_keys(id) ON DELETE RESTRICT;

COMMIT;
