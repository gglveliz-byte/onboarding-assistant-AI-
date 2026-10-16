/**
 * @archivo migrations/006_seed_pricing_matrix_and_legal_documents.sql
 * @modulo 04-billing-and-whop & 01-identity-and-rbac (Datos Semilla de Produccion)
 * @proposito
 *   Puebla de forma idempotente (`ON CONFLICT DO UPDATE`) la matriz base de planes
 *   comerciales de Whop (Pago por Uso Puro y planes mensuales de $5, $10, $30 y $50 USD
 *   con su escalafon de descuentos por volumen a partir de $50 USD) y los 5 documentos
 *   legales obligatorios versionados con su respectivo hash criptografico SHA-256.
 *
 * @resumen_contenido
 *   - Seed de `pricing_plans_config`: `PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50` y `CUSTOM_ENTERPRISE`.
 *   - Seed de `legal_documents`: Version `v1.0.0` de `TOS_B2B`, `PRIVACY_POLICY`,
 *     `DPA_ENTERPRISE`, `AI_VOICE_AUP` y `END_USER_VOICE_CONSENT`.
 *
 * @dependencias_internas
 *   - Requiere las migraciones `001` a `005`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `legal_documents`.
 */

BEGIN;

-- =============================================================================
-- 1. SEED DE MATRIZ GLOBAL DE PRECIOS WHOP Y ESCALAFON DE VOLUMEN ($50+)
-- =============================================================================
INSERT INTO pricing_plans_config (
    plan_code,
    whop_plan_id,
    display_name,
    monthly_fixed_price_usd,
    included_minutes,
    base_overage_rate_per_minute_usd,
    overage_allowed,
    volume_discount_eligible,
    volume_discount_tiers_json,
    is_active
) VALUES
(
    'PAYG',
    'whop_plan_payg_usage_only',
    'Pago por Uso Puro (Pay-As-You-Go)',
    0.00,
    0.0000,
    0.200000,
    TRUE,
    FALSE,
    '[]'::jsonb,
    TRUE
),
(
    'PLAN_5',
    'whop_plan_starter_5usd',
    'Plan Starter $5 USD / mes',
    5.00,
    25.0000,
    0.200000,
    TRUE,
    FALSE,
    '[]'::jsonb,
    TRUE
),
(
    'PLAN_10',
    'whop_plan_growth_10usd',
    'Plan Growth $10 USD / mes',
    10.00,
    55.0000,
    0.181800,
    TRUE,
    FALSE,
    '[]'::jsonb,
    TRUE
),
(
    'PLAN_30',
    'whop_plan_pro_30usd',
    'Plan Pro $30 USD / mes',
    30.00,
    180.0000,
    0.166700,
    TRUE,
    FALSE,
    '[]'::jsonb,
    TRUE
),
(
    'PLAN_50',
    'whop_plan_scale_50usd_volume',
    'Plan Scale & Masivo $50 USD / mes (Descuento por Volumen Activo)',
    50.00,
    350.0000,
    0.142800,
    TRUE,
    TRUE,
    '[
      {"tier": 1, "min_overage_minutes": 0, "max_overage_minutes": 1000, "discount_pct": 10.0},
      {"tier": 2, "min_overage_minutes": 1000.000001, "max_overage_minutes": 5000, "discount_pct": 20.0},
      {"tier": 3, "min_overage_minutes": 5000.000001, "max_overage_minutes": 25000, "discount_pct": 35.0},
      {"tier": 4, "min_overage_minutes": 25000.000001, "max_overage_minutes": null, "discount_pct": 50.0}
    ]'::jsonb,
    TRUE
),
(
    'CUSTOM_ENTERPRISE',
    'whop_plan_custom_enterprise_override',
    'Plan Corporativo Personalizado (Override SuperAdmin)',
    0.00,
    0.0000,
    0.120000,
    TRUE,
    TRUE,
    '[
      {"tier": 1, "min_overage_minutes": 0, "max_overage_minutes": null, "discount_pct": 50.0}
    ]'::jsonb,
    TRUE
)
ON CONFLICT (plan_code) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    monthly_fixed_price_usd = EXCLUDED.monthly_fixed_price_usd,
    included_minutes = EXCLUDED.included_minutes,
    base_overage_rate_per_minute_usd = EXCLUDED.base_overage_rate_per_minute_usd,
    overage_allowed = EXCLUDED.overage_allowed,
    volume_discount_eligible = EXCLUDED.volume_discount_eligible,
    volume_discount_tiers_json = EXCLUDED.volume_discount_tiers_json,
    updated_at = NOW();

-- =============================================================================
-- 2. SEED DE INSTRUMENTOS LEGALES VERSIONADOS (TOS, PRIVACIDAD, DPA, AUP, VOZ)
-- =============================================================================
INSERT INTO legal_documents (
    doc_type,
    version_tag,
    title,
    content_markdown,
    content_sha256,
    is_mandatory,
    is_active
) VALUES
(
    'TOS_B2B',
    'v1.0.0',
    'Terminos y Condiciones Maestro del Servicio SaaS B2B',
    'Al registrar una organizacion y utilizar el SDK y Gateway de Voz Realtime, el Cliente B2B acepta el modelo de facturacion a traves de Whop, la responsabilidad sobre los dominios autorizados y las reglas de uso de los modelos Qwen3.8-Omni-Flash-Realtime y Gemini 3.8 Live.',
    encode(digest('TOS_B2B_v1.0.0_CANONICAL', 'sha256'), 'hex'),
    TRUE,
    TRUE
),
(
    'PRIVACY_POLICY',
    'v1.0.0',
    'Politica de Privacidad y Retencion Cero de Audio Crudo',
    'La plataforma procesa los flujos de audio PCM16 exclusivamente en memoria volatil (Ring Buffers) para inferencia en vivo y aplica un filtro automatico en el DOM que bloquea el acceso a campos de contrasena y tarjetas bancarias.',
    encode(digest('PRIVACY_POLICY_v1.0.0_CANONICAL', 'sha256'), 'hex'),
    TRUE,
    TRUE
),
(
    'DPA_ENTERPRISE',
    'v1.0.0',
    'Acuerdo de Procesamiento de Datos (DPA - GDPR / CCPA / SOC2)',
    'Acuerdo vinculante entre el Responsable del Tratamiento (Cliente B2B) y el Encargado del Tratamiento (Plataforma SaaS), garantizando aislamiento estricto multi-tenant mediante Row-Level Security (RLS) y derecho al borrado criptografico.',
    encode(digest('DPA_ENTERPRISE_v1.0.0_CANONICAL', 'sha256'), 'hex'),
    TRUE,
    TRUE
),
(
    'AI_VOICE_AUP',
    'v1.0.0',
    'Politica de Uso Aceptable de Asistentes de Voz IA y Ejecucion DOM',
    'Queda estrictamente prohibido configurar el System Prompt o el Mapa Funcional RAG para capturar credenciales sensibles, suplantar identidades o ejecutar acciones no autorizadas en aplicaciones de terceros.',
    encode(digest('AI_VOICE_AUP_v1.0.0_CANONICAL', 'sha256'), 'hex'),
    TRUE,
    TRUE
),
(
    'END_USER_VOICE_CONSENT',
    'v1.0.0',
    'Aviso de Consentimiento de Asistente de Voz Interactivo para Usuario Final',
    'Al activar el microfono, usted autoriza que el asistente de inteligencia artificial en tiempo real escuche sus instrucciones de voz y ejecute acciones guiadas (clicks y escritura) sobre esta interfaz para completar su proceso paso a paso.',
    encode(digest('END_USER_VOICE_CONSENT_v1.0.0_CANONICAL', 'sha256'), 'hex'),
    TRUE,
    TRUE
)
ON CONFLICT (doc_type, version_tag) DO UPDATE SET
    title = EXCLUDED.title,
    content_markdown = EXCLUDED.content_markdown,
    content_sha256 = EXCLUDED.content_sha256,
    is_mandatory = EXCLUDED.is_mandatory,
    is_active = EXCLUDED.is_active;

COMMIT;
