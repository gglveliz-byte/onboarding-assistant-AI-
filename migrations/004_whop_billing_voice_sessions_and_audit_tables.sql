/**
 * @archivo migrations/004_whop_billing_voice_sessions_and_audit_tables.sql
 * @modulo 04-billing-and-whop, 05-voice-realtime-gateway & 06-superadmin-governance
 * @proposito
 *   Crea las tablas fisicas del motor financiero integrado con Whop (planes de $5 a $50,
 *   pago por uso puro, descuentos por volumen escalonados y overrides manuales del
 *   SuperAdmin), la billetera transaccional preparada para bloqueo pesimista
 *   (`SELECT ... FOR UPDATE`), el libro mayor contable inmutable (`usage_ledger`),
 *   el registro de sesiones de voz y acciones fisicas DOM (`action_events`), y la
 *   bitacora global de auditoria encadenada con SHA-256 (`audit_logs`).
 *
 * @resumen_contenido
 *   - Tabla `pricing_plans_config`: Matriz global Whop y tramos de descuento por volumen.
 *   - Tabla `organization_pricing_overrides`: Tarifas y descuentos especiales por cliente.
 *   - Tabla `whop_subscriptions`: Estado de suscripcion, minutos restantes y saldo USD.
 *   - Tabla `voice_sessions`: Telemetria de sesiones Qwen3.8-Omni / Gemini 3.8 Live.
 *   - Tabla `usage_ledger`: Libro mayor contable append-only de minutos y pagos Whop.
 *   - Tabla `action_events`: Registro de ejecucion de `click_element` y `type_text`.
 *   - Tabla `audit_logs`: Bitacora de seguridad append-only con hash encadenado SHA-256.
 *   - Funcion `trigger_compute_audit_log_sha256()`: Calcula automaticamente el eslabon SHA-256.
 *
 * @dependencias_internas
 *   - Requiere las migraciones `001`, `002` y `003`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `organization_pricing_overrides`,
 *     `whop_subscriptions`, `voice_sessions`, `usage_ledger`, `action_events`, `audit_logs`.
 */

BEGIN;

-- =============================================================================
-- 1. TABLA: pricing_plans_config (Matriz Global de Precios Whop y Volumen)
-- =============================================================================
CREATE TABLE IF NOT EXISTS pricing_plans_config (
    plan_code billing_plan_code_enum PRIMARY KEY,
    whop_plan_id VARCHAR(120) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    monthly_fixed_price_usd NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (monthly_fixed_price_usd >= 0),
    included_minutes NUMERIC(14,4) NOT NULL DEFAULT 0.0000 CHECK (included_minutes >= 0),
    base_overage_rate_per_minute_usd NUMERIC(12,6) NOT NULL DEFAULT 0.200000 CHECK (base_overage_rate_per_minute_usd >= 0),
    overage_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    volume_discount_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    volume_discount_tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by_superadmin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 2. TABLA: organization_pricing_overrides (Tarifas y Descuentos Manuales SuperAdmin)
-- =============================================================================
CREATE TABLE IF NOT EXISTS organization_pricing_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    custom_rate_per_minute_usd NUMERIC(12,6) CHECK (custom_rate_per_minute_usd IS NULL OR custom_rate_per_minute_usd >= 0),
    manual_discount_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (manual_discount_percentage BETWEEN 0.00 AND 100.00),
    force_volume_discount_tiers BOOLEAN NOT NULL DEFAULT FALSE,
    custom_volume_tiers_json JSONB,
    override_notes TEXT NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    created_by_superadmin_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_pricing_overrides_org ON organization_pricing_overrides(organization_id);

DROP TRIGGER IF EXISTS trg_org_pricing_overrides_updated_at ON organization_pricing_overrides;
CREATE TRIGGER trg_org_pricing_overrides_updated_at
    BEFORE UPDATE ON organization_pricing_overrides
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 3. TABLA: whop_subscriptions (Suscripcion, Cupo de Minutos y Saldo por Tenant)
-- =============================================================================
CREATE TABLE IF NOT EXISTS whop_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code billing_plan_code_enum NOT NULL DEFAULT 'PAYG',
    status whop_sub_status_enum NOT NULL DEFAULT 'ACTIVE',
    whop_membership_id VARCHAR(140) UNIQUE,
    whop_user_id VARCHAR(140),
    whop_company_id VARCHAR(140),
    whop_plan_id VARCHAR(140),
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 month'),
    period_included_minutes_quota NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (period_included_minutes_quota >= 0),
    period_included_minutes_remaining NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (period_included_minutes_remaining >= 0),
    period_overage_minutes_used NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (period_overage_minutes_used >= 0),
    current_period_overage_billed_usd NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (current_period_overage_billed_usd >= 0),
    credit_balance_usd NUMERIC(18,6) NOT NULL DEFAULT 0.000000,
    hard_spend_cap_usd NUMERIC(18,2) CHECK (hard_spend_cap_usd IS NULL OR hard_spend_cap_usd >= 0),
    auto_topup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_whop_webhook_event_id VARCHAR(160),
    last_whop_webhook_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whop_subscriptions_org_id ON whop_subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_whop_subscriptions_membership ON whop_subscriptions(whop_membership_id);

DROP TRIGGER IF EXISTS trg_whop_subscriptions_updated_at ON whop_subscriptions;
CREATE TRIGGER trg_whop_subscriptions_updated_at
    BEFORE UPDATE ON whop_subscriptions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- 4. TABLA: voice_sessions (Sesiones de Voz en Tiempo Real Qwen3.8 / Gemini 3.8)
-- =============================================================================
CREATE TABLE IF NOT EXISTS voice_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    functional_map_id UUID NOT NULL REFERENCES functional_maps(id) ON DELETE RESTRICT,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    external_end_user_id VARCHAR(255),
    origin_domain VARCHAR(255) NOT NULL,
    ai_model_used ai_voice_model_enum NOT NULL,
    status voice_session_status_enum NOT NULL DEFAULT 'HANDSHAKE_ISSUED',
    end_user_consent_verified BOOLEAN NOT NULL DEFAULT TRUE,
    current_step_index INTEGER NOT NULL DEFAULT 1 CHECK (current_step_index >= 1),
    total_steps_completed INTEGER NOT NULL DEFAULT 0 CHECK (total_steps_completed >= 0),
    barge_in_count INTEGER NOT NULL DEFAULT 0 CHECK (barge_in_count >= 0),
    total_tool_calls_count INTEGER NOT NULL DEFAULT 0 CHECK (total_tool_calls_count >= 0),
    duration_seconds NUMERIC(14,3) NOT NULL DEFAULT 0.000 CHECK (duration_seconds >= 0),
    billed_minutes NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (billed_minutes >= 0),
    total_billed_cost_usd NUMERIC(18,6) NOT NULL DEFAULT 0.000000 CHECK (total_billed_cost_usd >= 0),
    client_ip_hash CHAR(64) NOT NULL,
    user_agent TEXT,
    device_viewport_type VARCHAR(24) NOT NULL DEFAULT 'desktop' CHECK (device_viewport_type IN ('desktop', 'tablet', 'mobile')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    termination_reason VARCHAR(160),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_org_started ON voice_sessions(organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_project_status ON voice_sessions(project_id, status);

-- =============================================================================
-- 5. TABLA: usage_ledger (Libro Mayor Contable Inmutable Append-Only)
-- =============================================================================
CREATE TABLE IF NOT EXISTS usage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    voice_session_id UUID REFERENCES voice_sessions(id) ON DELETE SET NULL,
    whop_subscription_id UUID REFERENCES whop_subscriptions(id) ON DELETE SET NULL,
    external_whop_event_id VARCHAR(160) UNIQUE,
    whop_payment_id VARCHAR(160),
    entry_type ledger_entry_type_enum NOT NULL,
    minutes_delta NUMERIC(18,6) NOT NULL DEFAULT 0.000000,
    unit_rate_usd NUMERIC(12,6) NOT NULL DEFAULT 0.000000,
    discount_applied_pct NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    amount_usd_delta NUMERIC(18,6) NOT NULL DEFAULT 0.000000,
    included_minutes_balance_after NUMERIC(18,6) NOT NULL,
    credit_balance_usd_after NUMERIC(18,6) NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_org_created ON usage_ledger(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_session ON usage_ledger(voice_session_id);

-- =============================================================================
-- 6. TABLA: action_events (Telemetria de Ejecucion de click_element y type_text)
-- =============================================================================
CREATE TABLE IF NOT EXISTS action_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    voice_session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    map_element_id UUID REFERENCES map_elements(id) ON DELETE SET NULL,
    provider_tool_call_id VARCHAR(140) NOT NULL,
    tool_name VARCHAR(32) NOT NULL CHECK (tool_name IN ('click_element', 'type_text', 'advance_onboarding_step')),
    route_path_at_execution VARCHAR(512) NOT NULL,
    selector_used TEXT NOT NULL,
    action_payload_redacted_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    execution_status action_execution_status_enum NOT NULL DEFAULT 'DISPATCHED',
    execution_latency_ms INTEGER CHECK (execution_latency_ms IS NULL OR execution_latency_ms >= 0),
    error_code VARCHAR(120),
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_action_events_session ON action_events(voice_session_id, dispatched_at ASC);
CREATE INDEX IF NOT EXISTS idx_action_events_org_created ON action_events(organization_id, dispatched_at DESC);

-- =============================================================================
-- 7. TABLA: audit_logs (Bitacora de Auditoria Append-Only con Cadena SHA-256)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    actor_role rbac_role_enum,
    event_category VARCHAR(64) NOT NULL,
    event_action VARCHAR(120) NOT NULL,
    severity VARCHAR(24) NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARN', 'CRITICAL_SECURITY')),
    target_resource_type VARCHAR(64),
    target_resource_id VARCHAR(140),
    ip_address INET,
    user_agent TEXT,
    before_state_json JSONB,
    after_state_json JSONB,
    prev_record_sha256 CHAR(64),
    record_sha256 CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity_created ON audit_logs(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id, created_at DESC);

/**
 * Calcula automaticamente el hash SHA-256 del registro de auditoria encadenandolo
 * con el ultimo `record_sha256` insertado si el llamador no lo proveyo.
 */
CREATE OR REPLACE FUNCTION trigger_compute_audit_log_sha256() RETURNS TRIGGER AS $$
DECLARE
    v_last_hash CHAR(64);
    v_payload TEXT;
BEGIN
    IF NEW.prev_record_sha256 IS NULL THEN
        SELECT record_sha256 INTO v_last_hash
        FROM audit_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
        NEW.prev_record_sha256 := COALESCE(v_last_hash, repeat('0', 64));
    END IF;

    v_payload := COALESCE(NEW.prev_record_sha256, '') || '|' ||
                 COALESCE(NEW.organization_id::TEXT, 'GLOBAL') || '|' ||
                 COALESCE(NEW.actor_user_id::TEXT, 'SYSTEM') || '|' ||
                 NEW.event_category || '|' ||
                 NEW.event_action || '|' ||
                 NEW.severity || '|' ||
                 COALESCE(NEW.target_resource_id, '') || '|' ||
                 NEW.created_at::TEXT;

    NEW.record_sha256 := encode(digest(v_payload, 'sha256'), 'hex');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_chain_sha256 ON audit_logs;
CREATE TRIGGER trg_audit_logs_chain_sha256
    BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION trigger_compute_audit_log_sha256();

COMMIT;
