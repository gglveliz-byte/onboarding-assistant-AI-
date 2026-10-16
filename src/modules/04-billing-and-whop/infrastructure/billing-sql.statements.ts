/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/billing-sql.statements.ts
 * @modulo 04-billing-and-whop (Sentencias SQL Parametrizadas del Modulo de Facturacion)
 * @proposito
 *   Concentra las sentencias SQL del modulo de cobros. Se separan del repositorio para que la
 *   revision de seguridad pueda auditar en un solo archivo que toda consulta es parametrizada
 *   (`$1`, `$2`, ...) y que ninguna interpola valores de usuario. Ademas documenta en un unico lugar
 *   los `CAST` explicitos a los tipos enumerados de PostgreSQL, que son imprescindibles para no
 *   depender de inferencias implicitas del motor.
 *
 * @resumen_contenido
 *   - Constantes `SELECT_ACTIVE_PLANS_SQL`, `SELECT_ACTIVE_OVERRIDE_SQL` y `SELECT_SUBSCRIPTION_SQL`.
 *   - Constantes `SELECT_SUBSCRIPTION_BY_MEMBERSHIP_SQL` y `UPDATE_SUBSCRIPTION_PERIOD_SQL`.
 *   - Constantes `INSERT_SUBSCRIPTION_SQL` e `INSERT_LEDGER_ENTRY_SQL`.
 *
 * @dependencias_internas
 *   - `SUBSCRIPTION_COLUMNS` (`./billing-row.mappers.ts`) para la proyeccion explicita de columnas.
 *
 * @dependencias_externas
 *   - Ninguna (Sentencias como texto: se ejecutan siempre con parametros enlazados).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `organization_pricing_overrides`, `whop_subscriptions`
 *     y `usage_ledger` (todas con politicas RLS activas).
 */

import { SUBSCRIPTION_COLUMNS } from './billing-row.mappers';

/** Catalogo de planes activos, ordenado del mas economico al mas caro. */
export const SELECT_ACTIVE_PLANS_SQL = `SELECT plan_code, whop_plan_id, display_name, monthly_fixed_price_usd, included_minutes,
         base_overage_rate_per_minute_usd, overage_allowed, volume_discount_eligible, volume_discount_tiers_json
    FROM pricing_plans_config
   WHERE is_active = TRUE
   ORDER BY monthly_fixed_price_usd ASC`;

/** Override de precios vigente de una organizacion, acotado por su ventana de vigencia. */
export const SELECT_ACTIVE_OVERRIDE_SQL = `SELECT custom_rate_per_minute_usd, manual_discount_percentage, force_volume_discount_tiers,
         custom_volume_tiers_json, override_notes, effective_from, effective_until
    FROM organization_pricing_overrides
   WHERE organization_id = $1
     AND effective_from <= NOW()
     AND (effective_until IS NULL OR effective_until > NOW())
   LIMIT 1`;

/** Suscripcion de una organizacion, por su identificador de tenant. */
export const SELECT_SUBSCRIPTION_SQL = `SELECT ${SUBSCRIPTION_COLUMNS} FROM whop_subscriptions WHERE organization_id = $1`;

/** Suscripcion localizada por el identificador de membresia de la pasarela. */
export const SELECT_SUBSCRIPTION_BY_MEMBERSHIP_SQL = `SELECT ${SUBSCRIPTION_COLUMNS} FROM whop_subscriptions WHERE whop_membership_id = $1`;

/**
 * Actualizacion de periodo y saldos de la suscripcion.
 * Los campos opcionales usan `COALESCE` para conservar el valor previo cuando llegan nulos, y el
 * instante del ultimo webhook solo se sella cuando efectivamente se aplica un evento.
 */
export const UPDATE_SUBSCRIPTION_PERIOD_SQL = `UPDATE whop_subscriptions
      SET plan_code = $2::billing_plan_code_enum,
          status = $3::whop_sub_status_enum,
          period_included_minutes_quota = $4::numeric,
          period_included_minutes_remaining = $5::numeric,
          period_overage_minutes_used = $6::numeric,
          current_period_overage_billed_usd = $7::numeric,
          credit_balance_usd = $8::numeric,
          current_period_start = COALESCE($9::timestamptz, current_period_start),
          current_period_end = COALESCE($10::timestamptz, current_period_end),
          whop_membership_id = COALESCE($11, whop_membership_id),
          last_whop_webhook_event_id = COALESCE($12, last_whop_webhook_event_id),
          last_whop_webhook_at = CASE WHEN $12 IS NULL THEN last_whop_webhook_at ELSE NOW() END,
          updated_at = NOW()
    WHERE organization_id = $1`;

/**
 * Alta idempotente de la suscripcion de una organizacion.
 * `ON CONFLICT DO NOTHING` permite invocarla siempre antes de bloquear la fila: un webhook de
 * invalidacion puede llegar antes que el de activacion y necesita una fila sobre la que operar.
 */
export const INSERT_SUBSCRIPTION_SQL = `INSERT INTO whop_subscriptions (organization_id, plan_code, status, whop_membership_id,
      period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
      current_period_overage_billed_usd, credit_balance_usd, last_whop_webhook_event_id)
   VALUES ($1, $2::billing_plan_code_enum, $3::whop_sub_status_enum, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10)
   ON CONFLICT (organization_id) DO NOTHING`;

/**
 * Asiento inmutable del libro mayor contable.
 * El indice unico de `external_whop_event_id` es la garantia de idempotencia contable: un segundo
 * intento con el mismo evento falla y el caso de uso lo traduce a un conflicto controlado.
 * Las columnas `project_id` y `voice_session_id` son la trazabilidad de un consumo de voz: permiten
 * auditar que cada minuto cobrado corresponde a una sesion real y a un proyecto concreto.
 */
export const INSERT_LEDGER_ENTRY_SQL = `INSERT INTO usage_ledger (organization_id, project_id, voice_session_id, whop_subscription_id,
      external_whop_event_id, whop_payment_id, entry_type, minutes_delta, unit_rate_usd, discount_applied_pct,
      amount_usd_delta, included_minutes_balance_after, credit_balance_usd_after, metadata_json)
   VALUES ($1, $2, $3, $4, $5, $6, $7::ledger_entry_type_enum, $8::numeric, $9::numeric, $10::numeric,
           $11::numeric, $12::numeric, $13::numeric, $14::jsonb)
   RETURNING id`;

/**
 * Historial paginado del libro mayor de una organizacion, ordenado del asiento mas reciente al mas
 * antiguo. La paginacion es por clave (`created_at`, `id`) y no por desplazamiento, de modo que un
 * asiento nuevo durante la navegacion no duplique ni omita filas.
 */
export const SELECT_LEDGER_PAGE_SQL = `SELECT id, project_id, voice_session_id, entry_type, minutes_delta, unit_rate_usd,
         discount_applied_pct, amount_usd_delta, included_minutes_balance_after, credit_balance_usd_after,
         metadata_json, created_at
    FROM usage_ledger
   WHERE organization_id = $1
     AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
   ORDER BY created_at DESC, id DESC
   LIMIT $3`;

/**
 * Minutos y dolares consumidos por la organizacion dentro de la ventana del periodo vigente.
 * Alimenta el panel de consumo y el calculo del tramo de descuento por volumen activo.
 */
export const SELECT_LEDGER_PERIOD_TOTALS_SQL = `SELECT COALESCE(SUM(minutes_delta), 0)::TEXT AS total_minutes_delta,
         COALESCE(SUM(amount_usd_delta), 0)::TEXT AS total_amount_usd_delta,
         COALESCE(SUM(CASE WHEN entry_type = 'VOICE_MINUTE_DEDUCTION' THEN -minutes_delta ELSE 0 END), 0)::TEXT AS consumed_minutes
    FROM usage_ledger
   WHERE organization_id = $1
     AND created_at >= $2::timestamptz`;

/**
 * Exportacion contable completa de un periodo, sin paginacion.
 * Se ordena de forma ascendente porque un archivo contable se lee como un extracto cronologico.
 */
export const SELECT_LEDGER_EXPORT_SQL = `SELECT id, project_id, voice_session_id, entry_type, minutes_delta, unit_rate_usd,
         discount_applied_pct, amount_usd_delta, included_minutes_balance_after, credit_balance_usd_after, created_at
    FROM usage_ledger
   WHERE organization_id = $1
     AND created_at >= $2::timestamptz
     AND created_at < $3::timestamptz
   ORDER BY created_at ASC, id ASC`;
