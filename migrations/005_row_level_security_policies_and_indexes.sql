/**
 * @archivo migrations/005_row_level_security_policies_and_indexes.sql
 * @modulo 00-database-security (Aislamiento Multi-Tenant RLS y Candados Inmutables)
 * @proposito
 *   Activa de forma obligatoria Row-Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`)
 *   sobre todas las tablas multi-tenant del sistema, garantizando que ninguna consulta
 *   SQL pueda leer ni modificar registros de otra organizacion (`organization_id`),
 *   salvo cuando se ejecute bajo contexto verificado de SuperAdmin (`app_is_superadmin()`).
 *   Ademas, instala los triggers de proteccion append-only sobre `usage_ledger` y `audit_logs`.
 *
 * @resumen_contenido
 *   - Activacion `ENABLE` y `FORCE ROW LEVEL SECURITY` en 16 tablas multi-tenant.
 *   - Politicas de aislamiento por `organization_id = app_current_org_id()`.
 *   - Politicas de lectura global para tablas de referencia (`legal_documents`, `pricing_plans_config`).
 *   - Triggers `trg_usage_ledger_immutable` y `trg_audit_logs_immutable` contra UPDATE/DELETE.
 *
 * @dependencias_internas
 *   - Requiere las migraciones `001`, `002`, `003` y `004`.
 *
 * @tablas_bd_o_redis
 *   - Todas las tablas de negocio multi-tenant en PostgreSQL.
 */

BEGIN;

-- =============================================================================
-- 1. ACTIVACION ESTRICTA DE ROW-LEVEL SECURITY (ENABLE + FORCE)
-- =============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE mfa_break_glass_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_break_glass_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE user_legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_legal_acceptances FORCE ROW LEVEL SECURITY;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

ALTER TABLE allowed_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_domains FORCE ROW LEVEL SECURITY;

ALTER TABLE training_browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_browser_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE functional_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE functional_maps FORCE ROW LEVEL SECURITY;

ALTER TABLE map_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_elements FORCE ROW LEVEL SECURITY;

ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE organization_pricing_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_pricing_overrides FORCE ROW LEVEL SECURITY;

ALTER TABLE whop_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whop_subscriptions FORCE ROW LEVEL SECURITY;

ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger FORCE ROW LEVEL SECURITY;

ALTER TABLE action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_events FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- 2. POLITICAS DE AISLAMIENTO MULTI-TENANT POR ORGANIZATION_ID
-- =============================================================================

-- 2.1. organizations
DROP POLICY IF EXISTS rls_organizations_isolation ON organizations;
CREATE POLICY rls_organizations_isolation ON organizations
    USING (id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (id = app_current_org_id() OR app_is_superadmin());

-- 2.2. memberships
DROP POLICY IF EXISTS rls_memberships_isolation ON memberships;
CREATE POLICY rls_memberships_isolation ON memberships
    USING (organization_id = app_current_org_id() OR user_id = app_current_user_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.3. mfa_break_glass_requests
DROP POLICY IF EXISTS rls_break_glass_isolation ON mfa_break_glass_requests;
CREATE POLICY rls_break_glass_isolation ON mfa_break_glass_requests
    USING (organization_id = app_current_org_id() OR user_id = app_current_user_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR user_id = app_current_user_id() OR app_is_superadmin());

-- 2.4. user_legal_acceptances
DROP POLICY IF EXISTS rls_legal_acceptances_isolation ON user_legal_acceptances;
CREATE POLICY rls_legal_acceptances_isolation ON user_legal_acceptances
    USING (organization_id = app_current_org_id() OR user_id = app_current_user_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR user_id = app_current_user_id() OR app_is_superadmin());

-- 2.5. projects
DROP POLICY IF EXISTS rls_projects_isolation ON projects;
CREATE POLICY rls_projects_isolation ON projects
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.6. api_keys
DROP POLICY IF EXISTS rls_api_keys_isolation ON api_keys;
CREATE POLICY rls_api_keys_isolation ON api_keys
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.7. allowed_domains
DROP POLICY IF EXISTS rls_allowed_domains_isolation ON allowed_domains;
CREATE POLICY rls_allowed_domains_isolation ON allowed_domains
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.8. training_browser_sessions
DROP POLICY IF EXISTS rls_training_sessions_isolation ON training_browser_sessions;
CREATE POLICY rls_training_sessions_isolation ON training_browser_sessions
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.9. functional_maps
DROP POLICY IF EXISTS rls_functional_maps_isolation ON functional_maps;
CREATE POLICY rls_functional_maps_isolation ON functional_maps
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.10. map_elements
DROP POLICY IF EXISTS rls_map_elements_isolation ON map_elements;
CREATE POLICY rls_map_elements_isolation ON map_elements
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.11. prompt_versions
DROP POLICY IF EXISTS rls_prompt_versions_isolation ON prompt_versions;
CREATE POLICY rls_prompt_versions_isolation ON prompt_versions
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.12. organization_pricing_overrides (Lectura para el propio tenant; escritura exclusiva SuperAdmin)
DROP POLICY IF EXISTS rls_pricing_overrides_select ON organization_pricing_overrides;
CREATE POLICY rls_pricing_overrides_select ON organization_pricing_overrides
    FOR SELECT
    USING (organization_id = app_current_org_id() OR app_is_superadmin());

DROP POLICY IF EXISTS rls_pricing_overrides_write ON organization_pricing_overrides;
CREATE POLICY rls_pricing_overrides_write ON organization_pricing_overrides
    FOR ALL
    USING (app_is_superadmin())
    WITH CHECK (app_is_superadmin());

-- 2.13. whop_subscriptions
DROP POLICY IF EXISTS rls_whop_subscriptions_isolation ON whop_subscriptions;
CREATE POLICY rls_whop_subscriptions_isolation ON whop_subscriptions
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.14. voice_sessions
DROP POLICY IF EXISTS rls_voice_sessions_isolation ON voice_sessions;
CREATE POLICY rls_voice_sessions_isolation ON voice_sessions
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.15. usage_ledger
DROP POLICY IF EXISTS rls_usage_ledger_isolation ON usage_ledger;
CREATE POLICY rls_usage_ledger_isolation ON usage_ledger
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.16. action_events
DROP POLICY IF EXISTS rls_action_events_isolation ON action_events;
CREATE POLICY rls_action_events_isolation ON action_events
    USING (organization_id = app_current_org_id() OR app_is_superadmin())
    WITH CHECK (organization_id = app_current_org_id() OR app_is_superadmin());

-- 2.17. audit_logs
DROP POLICY IF EXISTS rls_audit_logs_select ON audit_logs;
CREATE POLICY rls_audit_logs_select ON audit_logs
    FOR SELECT
    USING (organization_id = app_current_org_id() OR app_is_superadmin());

DROP POLICY IF EXISTS rls_audit_logs_insert ON audit_logs;
CREATE POLICY rls_audit_logs_insert ON audit_logs
    FOR INSERT
    WITH CHECK (organization_id = app_current_org_id() OR organization_id IS NULL OR app_is_superadmin());

-- =============================================================================
-- 3. CANDADOS DE INMUTABILIDAD APPEND-ONLY (PROHIBIDO UPDATE / DELETE)
-- =============================================================================
DROP TRIGGER IF EXISTS trg_usage_ledger_immutable ON usage_ledger;
CREATE TRIGGER trg_usage_ledger_immutable
    BEFORE UPDATE OR DELETE ON usage_ledger
    FOR EACH ROW EXECUTE FUNCTION trigger_prevent_immutable_mutation();

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION trigger_prevent_immutable_mutation();

COMMIT;
