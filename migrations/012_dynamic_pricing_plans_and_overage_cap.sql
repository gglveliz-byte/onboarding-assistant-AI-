-- =============================================================================
-- MIGRACION 012: PLANES DE PRECIOS DINAMICOS Y TOPE CERRADO SIN EXCEDENTES
-- =============================================================================
-- @archivo migrations/012_dynamic_pricing_plans_and_overage_cap.sql
-- @modulo 06-superadmin-governance / 05-billing-and-subscriptions
-- @proposito
--   Convierte el campo plan_code de enum restrictivo a VARCHAR(60) en las tablas
--   pricing_plans_config y whop_subscriptions para permitir al SuperAdmin crear,
--   editar y eliminar planes libremente.
--   Asegura que los planes fijos mensuales tengan overage_allowed = FALSE por defecto,
--   garantizando bolsas cerradas de minutos sin cobros sorpresas de sobreconsumo.
-- =============================================================================

-- 1. Convertir columna plan_code en pricing_plans_config a VARCHAR(60)
ALTER TABLE pricing_plans_config
    ALTER COLUMN plan_code TYPE VARCHAR(60) USING plan_code::text;

-- 2. Convertir columna plan_code en whop_subscriptions a VARCHAR(60)
ALTER TABLE whop_subscriptions
    ALTER COLUMN plan_code TYPE VARCHAR(60) USING plan_code::text;

-- 3. Establecer tope cerrado (sin sobreconsumo automatico) en planes fijos mensuales
UPDATE pricing_plans_config
SET overage_allowed = FALSE
WHERE plan_code <> 'PAYG';

-- 4. Asegurar que los privilegios se mantengan para oa_app
GRANT SELECT, INSERT, UPDATE, DELETE ON pricing_plans_config TO oa_app;
