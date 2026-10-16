/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/billing-row.mappers.ts
 * @modulo 04-billing-and-whop (Mapeadores de Filas SQL a Entidades de Facturacion)
 * @proposito
 *   Traduce las filas crudas que devuelve PostgreSQL —con columnas `snake_case` y valores `NUMERIC`
 *   entregados como cadenas— a las entidades tipadas del dominio en `camelCase`. Concentra esta
 *   traduccion para que el repositorio quede dedicado a las consultas y para que todo importe pase
 *   por `DecimalMath`: un solo punto donde se garantiza la precision de 6 decimales y se impide que
 *   un `NUMERIC` se convierta accidentalmente en un numero de coma flotante.
 *
 * @resumen_contenido
 *   - Interfaces de fila cruda: `PlanRow`, `SubscriptionRow`, `OverrideRow`.
 *   - Constante `SUBSCRIPTION_COLUMNS`: Proyeccion explicita de columnas de la suscripcion.
 *   - Funcion `mapPlanRow()`: Fila de plan a `PricingPlanConfig`.
 *   - Funcion `mapSubscriptionRow()`: Fila de suscripcion a `WhopSubscriptionState`.
 *   - Funcion `mapOverrideRow()`: Fila de override a `OrganizationPricingOverride`.
 *   - Funcion `parseVolumeTiers()`: Interpretacion defensiva de la columna JSONB de tramos.
 *
 * @dependencias_internas
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`) para normalizar importes y minutos.
 *   - Tipos del dominio (`../domain/billing-whop.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Mapeadores puros: no abren conexiones ni ejecutan consultas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `whop_subscriptions` y `organization_pricing_overrides`.
 */

import { DecimalMath, type Fixed6String } from '../../../shared/kernel/decimal.util';
import type {
  BillingPlanCode,
  LedgerEntryType,
  OrganizationPricingOverride,
  PricingPlanConfig,
  VolumeDiscountTier,
  WhopSubscriptionState,
  WhopSubscriptionStatus,
} from '../domain/billing-whop.types';
import type { LedgerHistoryEntry } from './billing-repository.port';

/** Fila cruda del catalogo de planes. */
export interface PlanRow {
  readonly plan_code: string;
  readonly whop_plan_id: string;
  readonly display_name: string;
  readonly monthly_fixed_price_usd: string;
  readonly included_minutes: string;
  readonly base_overage_rate_per_minute_usd: string;
  readonly overage_allowed: boolean;
  readonly volume_discount_eligible: boolean;
  readonly volume_discount_tiers_json: unknown;
}

/** Fila cruda de la suscripcion. */
export interface SubscriptionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly plan_code: string;
  readonly status: string;
  readonly whop_membership_id: string | null;
  readonly current_period_start: Date;
  readonly current_period_end: Date;
  readonly period_included_minutes_quota: string;
  readonly period_included_minutes_remaining: string;
  readonly period_overage_minutes_used: string;
  readonly current_period_overage_billed_usd: string;
  readonly credit_balance_usd: string;
  readonly hard_spend_cap_usd: string | null;
  readonly auto_topup_enabled: boolean;
  readonly last_whop_webhook_event_id: string | null;
}

/** Fila cruda del override de precios. */
export interface OverrideRow {
  readonly custom_rate_per_minute_usd: string | null;
  readonly manual_discount_percentage: string;
  readonly force_volume_discount_tiers: boolean;
  readonly custom_volume_tiers_json: unknown;
  readonly override_notes: string;
  readonly effective_from: Date;
  readonly effective_until: Date | null;
}

/** Proyeccion explicita de columnas de la suscripcion, evitando `SELECT *`. */
export const SUBSCRIPTION_COLUMNS = `id, organization_id, plan_code, status, whop_membership_id, current_period_start,
  current_period_end, period_included_minutes_quota, period_included_minutes_remaining,
  period_overage_minutes_used, current_period_overage_billed_usd, credit_balance_usd,
  hard_spend_cap_usd, auto_topup_enabled, last_whop_webhook_event_id`;

/**
 * Convierte un valor crudo de una columna JSONB a la representacion decimal de 6 cifras.
 *
 * @param rawValue - Valor crudo (numero o cadena).
 * @returns Cadena decimal normalizada, o `null` cuando el valor es nulo o invalido.
 */
function toFixed6String(rawValue: unknown): Fixed6String | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return DecimalMath.fromNumber(rawValue);
  }
  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    try {
      return DecimalMath.formatFixed6(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Interpreta la columna JSONB de tramos de descuento por volumen.
 *
 * @param rawTiers - Valor crudo de la columna JSONB.
 * @returns Tramos validos y normalizados; los elementos con forma invalida se descartan.
 */
export function parseVolumeTiers(rawTiers: unknown): readonly VolumeDiscountTier[] {
  if (!Array.isArray(rawTiers)) {
    return [];
  }

  const tiers: VolumeDiscountTier[] = [];
  for (const rawTier of rawTiers) {
    if (typeof rawTier !== 'object' || rawTier === null) {
      continue;
    }
    const record = rawTier as Record<string, unknown>;
    const tierNumber = typeof record['tier'] === 'number' ? record['tier'] : Number(record['tier']);
    if (!Number.isInteger(tierNumber)) {
      continue;
    }

    tiers.push(
      Object.freeze({
        tier: tierNumber,
        minOveragesMinutes: toFixed6String(record['min_overage_minutes']) ?? '0.000000',
        maxOveragesMinutes: toFixed6String(record['max_overage_minutes']),
        discountPercent: toFixed6String(record['discount_pct']) ?? '0.000000',
      })
    );
  }

  return Object.freeze(tiers.sort((left, right) => left.tier - right.tier));
}

/** Fila cruda del libro mayor contable. */
export interface LedgerRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly voice_session_id: string | null;
  readonly entry_type: string;
  readonly minutes_delta: string;
  readonly unit_rate_usd: string;
  readonly discount_applied_pct: string;
  readonly amount_usd_delta: string;
  readonly included_minutes_balance_after: string;
  readonly credit_balance_usd_after: string;
  readonly created_at: Date;
}

/** Fila cruda de los totales consolidados del libro mayor en un periodo. */
export interface PeriodTotalsRow {
  readonly total_minutes_delta: string;
  readonly total_amount_usd_delta: string;
  readonly consumed_minutes: string;
}

/**
 * Convierte una fila cruda del libro mayor a su entidad de dominio.
 * Se normalizan los porcentajes a 6 decimales aunque la columna los almacene con 2: asi todo el
 * modulo compara y compone descuentos en la misma escala y sin perdida.
 *
 * @param row - Fila cruda devuelta por el driver.
 * @returns Asiento normalizado con su marca temporal en formato ISO 8601.
 */
export function mapLedgerRow(row: LedgerRow): LedgerHistoryEntry {
  return Object.freeze({
    ledgerEntryId: row.id,
    projectId: row.project_id,
    voiceSessionId: row.voice_session_id,
    entryType: row.entry_type as LedgerEntryType,
    minutesDelta: DecimalMath.formatFixed6(row.minutes_delta, 'minutos del asiento'),
    unitRateUsd: DecimalMath.formatFixed6(row.unit_rate_usd, 'tarifa del asiento'),
    discountAppliedPercent: DecimalMath.formatFixed6(row.discount_applied_pct, 'descuento del asiento'),
    amountUsdDelta: DecimalMath.formatFixed6(row.amount_usd_delta, 'importe del asiento'),
    includedMinutesBalanceAfter: DecimalMath.formatFixed6(row.included_minutes_balance_after, 'saldo de minutos'),
    creditBalanceUsdAfter: DecimalMath.formatFixed6(row.credit_balance_usd_after, 'saldo de credito'),
    createdAtIso: row.created_at.toISOString(),
  });
}

/**
 * Convierte una fila cruda del catalogo de planes a su entidad de dominio.
 *
 * @param row - Fila cruda devuelta por el driver.
 * @returns Plan normalizado con sus importes a 6 decimales.
 */
export function mapPlanRow(row: PlanRow): PricingPlanConfig {
  return Object.freeze({
    planCode: row.plan_code as BillingPlanCode,
    externalPlanId: row.whop_plan_id,
    displayName: row.display_name,
    monthlyFixedPriceUsd: DecimalMath.formatFixed6(row.monthly_fixed_price_usd, 'cuota mensual'),
    includedMinutes: DecimalMath.formatFixed6(row.included_minutes, 'minutos incluidos'),
    baseOverageRatePerMinuteUsd: DecimalMath.formatFixed6(row.base_overage_rate_per_minute_usd, 'tarifa base'),
    overageAllowed: row.overage_allowed,
    volumeDiscountEligible: row.volume_discount_eligible,
    volumeDiscountTiers: parseVolumeTiers(row.volume_discount_tiers_json),
  });
}

/**
 * Convierte una fila cruda de suscripcion a su entidad de dominio.
 *
 * @param row - Fila cruda devuelta por el driver.
 * @returns Estado tipado con los importes normalizados a 6 decimales.
 */
export function mapSubscriptionRow(row: SubscriptionRow): WhopSubscriptionState {
  return Object.freeze({
    subscriptionId: row.id,
    organizationId: row.organization_id,
    planCode: row.plan_code as BillingPlanCode,
    status: row.status as WhopSubscriptionStatus,
    externalMembershipId: row.whop_membership_id,
    currentPeriodStartIso: row.current_period_start.toISOString(),
    currentPeriodEndIso: row.current_period_end.toISOString(),
    periodIncludedMinutesQuota: DecimalMath.formatFixed6(row.period_included_minutes_quota, 'cuota de minutos'),
    periodIncludedMinutesRemaining: DecimalMath.formatFixed6(row.period_included_minutes_remaining, 'minutos restantes'),
    periodOverageMinutesUsed: DecimalMath.formatFixed6(row.period_overage_minutes_used, 'minutos de exceso'),
    currentPeriodOverageBilledUsd: DecimalMath.formatFixed6(row.current_period_overage_billed_usd, 'exceso facturado'),
    creditBalanceUsd: DecimalMath.formatFixed6(row.credit_balance_usd, 'saldo de credito'),
    hardSpendCapUsd: row.hard_spend_cap_usd === null ? null : DecimalMath.formatFixed6(row.hard_spend_cap_usd, 'tope de gasto'),
    autoTopUpEnabled: row.auto_topup_enabled,
    lastExternalEventId: row.last_whop_webhook_event_id,
  });
}

/**
 * Convierte una fila cruda de override de precios a su entidad de dominio.
 *
 * @param row - Fila cruda devuelta por el driver.
 * @returns Override normalizado con sus porcentajes a 6 decimales.
 */
export function mapOverrideRow(row: OverrideRow): OrganizationPricingOverride {
  return Object.freeze({
    customRatePerMinuteUsd:
      row.custom_rate_per_minute_usd === null ? null : DecimalMath.formatFixed6(row.custom_rate_per_minute_usd, 'tarifa personalizada'),
    manualDiscountPercentage: DecimalMath.formatFixed6(row.manual_discount_percentage, 'descuento manual'),
    forceVolumeDiscountTiers: row.force_volume_discount_tiers,
    customVolumeTiers: row.custom_volume_tiers_json === null ? null : parseVolumeTiers(row.custom_volume_tiers_json),
    overrideNotes: row.override_notes,
    effectiveFromIso: row.effective_from.toISOString(),
    effectiveUntilIso: row.effective_until === null ? null : row.effective_until.toISOString(),
  });
}
