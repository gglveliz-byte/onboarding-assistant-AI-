-- =============================================================================
-- MIGRACION 013: PRECIO BRUTO REAL DE LA PASARELA E IDENTIFICADORES VIVOS
-- =============================================================================
-- @archivo migrations/013_whop_gross_price_and_live_plan_flag.sql
-- @modulo 04-billing-and-whop / 06-superadmin-governance
-- @proposito
--   La matriz de precios guardaba UN solo importe (`monthly_fixed_price_usd`), usado a la vez como
--   precio de lista y como importe cobrado en la pasarela. Con la comision de Whop trasladada al
--   cliente esa identidad se rompe: el cliente paga un BRUTO, la pasarela descuenta su comision y a
--   la empresa le liquida un NETO. Si el asiento contable registrara el bruto como saldo acreditable,
--   la organizacion recibiria saldo que la empresa nunca cobro.
--
--   Esta migracion separa ambas magnitudes y prepara `whop_plan_id` para recibir los identificadores
--   REALES de la pasarela (prefijo `plan_`). Hasta ahora esa columna contenia marcadores de desarro
--   (`whop_plan_starter_5usd`, `whop_plan_payg`) que ninguna pasarela reconoce, y por eso ningun
--   checkout pudo completarse jamas.
--
-- @resumen_contenido
--   1. Columna `whop_gross_price_usd`: importe efectivamente cobrado al cliente, el que declara el
--      webhook `payment.succeeded`. Nulo mientras el plan no este aprovisionado en la pasarela.
--   2. Columna `whop_recurring_period_days`: periodicidad del ciclo (30 para mensual); nula en los
--      planes de pago por uso, que no tienen cargo recurrente.
--   3. Columna `whop_plan_is_live`: el identificador corresponde a un plan real de la pasarela, lo que
--      permite al checkout rechazar explicitamente planes sin aprovisionar en lugar de enviar un
--      `plan_id` inventado y recibir un error opaco de la pasarela.
--   4. Se re-etiquetan con el prefijo `PENDING:` los marcadores legacy de `whop_plan_id`, para que el
--      estado sin aprovisionar sea visible en una consulta y no se confunda con un identificador real.
--   5. Concesion de permisos del rol de aplicacion `oa_app` sobre la tabla alterada.
--
-- @dependencias_internas
--   - Requiere la migracion 004 (creacion de `pricing_plans_config`) y la 012 (`plan_code` a VARCHAR).
--
-- @tablas_bd_o_redis
--   - PostgreSQL: `pricing_plans_config` (ALTER TABLE y UPDATE del catalogo).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. PRECIO BRUTO COBRADO AL CLIENTE
--    Importe que figura en `payment.succeeded.total`. NO debe confundirse con
--    `monthly_fixed_price_usd`, que es el NETO que liquida en el panel de la empresa.
-- -----------------------------------------------------------------------------
ALTER TABLE pricing_plans_config
    ADD COLUMN IF NOT EXISTS whop_gross_price_usd NUMERIC(12,2)
        CHECK (whop_gross_price_usd IS NULL OR whop_gross_price_usd >= 0);

COMMENT ON COLUMN pricing_plans_config.whop_gross_price_usd IS
    'Importe bruto cobrado al cliente con la comision de la pasarela ya trasladada. NULL = plan sin aprovisionar.';

-- -----------------------------------------------------------------------------
-- 2. PERIODICIDAD DEL CARGO RECURRENT
--    30 dias para los planes mensuales. Nula en pago por uso y en el plan corporativo,
--    que se activan con un metodo de pago guardado y no con un cargo ciclico.
-- -----------------------------------------------------------------------------
ALTER TABLE pricing_plans_config
    ADD COLUMN IF NOT EXISTS whop_recurring_period_days INTEGER
        CHECK (whop_recurring_period_days IS NULL OR whop_recurring_period_days > 0);

COMMENT ON COLUMN pricing_plans_config.whop_recurring_period_days IS
    'Dias entre cargos recurrentes (30 = mensual). NULL para planes sin cargo ciclico.';

-- -----------------------------------------------------------------------------
-- 3. MARCA DE PLAN APROVISIONADO EN LA PASARELA
-- -----------------------------------------------------------------------------
ALTER TABLE pricing_plans_config
    ADD COLUMN IF NOT EXISTS whop_plan_is_live BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pricing_plans_config.whop_plan_is_live IS
    'TRUE cuando whop_plan_id es un plan real de la pasarela; el checkout rechaza los FALSE.';

-- -----------------------------------------------------------------------------
-- 4. RE-ETIQUETADO DE LOS MARCADORES LEGACY
--    Un identificador real siempre empieza por `plan_`. Todo lo demas es un marcador de desarro y se
--    normaliza con el prefijo `PENDING:` para que sea evidente en cualquier consulta de gobierno.
-- -----------------------------------------------------------------------------
UPDATE pricing_plans_config
SET whop_plan_id = 'PENDING:' || whop_plan_id,
    whop_plan_is_live = FALSE
WHERE whop_plan_id NOT LIKE 'plan\_%'
  AND whop_plan_id NOT LIKE 'PENDING:%';

-- Los planes de precio fijo mensual declaran su ciclo de 30 dias.
UPDATE pricing_plans_config
SET whop_recurring_period_days = 30
WHERE monthly_fixed_price_usd > 0
  AND whop_recurring_period_days IS NULL;

-- -----------------------------------------------------------------------------
-- 5. PERMISOS DEL ROL DE APLICACION
--    La columna nueva se escribe por el gobierno de la plataforma y se lee por el checkout.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON pricing_plans_config TO oa_app;

-- -----------------------------------------------------------------------------
-- 6. DIAGNOSTICO DE CIERRE
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_total        INTEGER;
    v_live         INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total FROM pricing_plans_config;
    SELECT COUNT(*) INTO v_live FROM pricing_plans_config WHERE whop_plan_is_live = TRUE;
    RAISE NOTICE 'Migracion 013: % planes en catalogo, % aprovisionados en la pasarela.', v_total, v_live;
    IF v_live = 0 THEN
        RAISE NOTICE 'NINGUN plan esta aprovisionado aun: ejecute npm run whop:provision antes de abrir cobros.';
    END IF;
END $$;

COMMIT;
