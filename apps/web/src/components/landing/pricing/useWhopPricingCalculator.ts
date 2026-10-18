/**
 * @archivo apps/web/src/components/landing/pricing/useWhopPricingCalculator.ts
 * @modulo 12. Landing Publica Comercial: calculadora de planes en vivo (Subagente 1.8)
 * @proposito
 *   Calcula en el cliente, en espejo exacto de la matematica publica del backend, el costo
 *   mensual estimado de cada plan (pago por uso y suscripciones fijas de $5, $10, $30 y $50
 *   USD) para la proyeccion de usuarios guiados y minutos por usuario, aplicando los tramos
 *   de descuento por volumen del plan elegible y resolviendo el plan recomendado.
 *
 * @resumen_contenido
 *   - `VolumeTierView`: vista inmutable de un tramo (umbral, descuento y actividad actual).
 *   - `PlanQuote`: cotizacion inmutable de un plan para la proyeccion vigente.
 *   - `formatUsd` y `buildRegistrationHref`: presentacion monetaria y enlace de alta.
 *   - `WhopPricingCalculatorHandle`: contrato congelado consumido por los componentes 1.8.
 *   - `useWhopPricingCalculator`: estado de la proyeccion, carga de la matriz publica con
 *     `AbortController`, timeout defensivo de 4000 ms y respaldo canonico marcado como degradado.
 *   - Helpers privados: parseo numerico tolerante, resolucion del tramo aplicado y
 *     comparador del plan recomendado (menor total; desempate por menor precio fijo).
 *
 * @dependencias_internas
 *   - `../../../lib/api-client/http-client` (`backendFetch`).
 *   - `../../../lib/api-client/backend-contracts.types` (`PublicPricingMatrixDto`,
 *     `PublicPricingPlanDto`, `PublicVolumeDiscountTierDto`, `CANONICAL_PUBLIC_PLANS_FALLBACK`
 *     y `PAYG_RATE_PER_MINUTE_USD_FALLBACK`).
 *
 * @dependencias_externas
 *   - `react` (`useCallback`, `useEffect`, `useMemo`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna: consume el endpoint publico de precios (solo lectura).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { backendFetch } from '../../../lib/api-client/http-client';
import type {
  PublicPricingMatrixDto,
  PublicPricingPlanDto,
  PublicVolumeDiscountTierDto,
} from '../../../lib/api-client/backend-contracts.types';
import {
  CANONICAL_PUBLIC_PLANS_FALLBACK,
  PAYG_RATE_PER_MINUTE_USD_FALLBACK,
} from '../../../lib/api-client/backend-contracts.types';

/** Ruta del endpoint publico de la matriz de precios de la plataforma. */
const PRICING_MATRIX_PATH = '/api/v1/public/pricing-matrix';

/** Codigo del plan de pago por uso dentro de la matriz publica. */
const PAYG_PLAN_CODE = 'PAYG';

/** Codigo del plan tope de suscripcion fija, dueno del descuento por volumen. */
const PLAN_50_CODE = 'PLAN_50';

/** Proyeccion inicial de usuarios guiados por mes y limites del control. */
const GUIDED_USERS_DEFAULT = 25;
const GUIDED_USERS_MIN = 1;
const GUIDED_USERS_MAX = 500;

/** Proyeccion inicial de minutos de asistencia por usuario al mes y limites del control. */
const MINUTES_PER_USER_DEFAULT = 60;
const MINUTES_PER_USER_MIN = 5;
const MINUTES_PER_USER_MAX = 2000;

/** Formateador monetario canonico (dolares estadounidenses con dos decimales). */
const USD_FORMATTER = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Tramos congelados del plan tope, usados si la matriz no trae un plan elegible con tramos. */
const CANONICAL_PLAN_50 = CANONICAL_PUBLIC_PLANS_FALLBACK.find((plan) => plan.planCode === PLAN_50_CODE);
const FROZEN_VOLUME_TIERS: readonly PublicVolumeDiscountTierDto[] =
  CANONICAL_PLAN_50?.volumeDiscountTiers ?? [];

/** Tramo de descuento por volumen tal como lo pinta el visualizador de la calculadora. */
export interface VolumeTierView {
  readonly minMinutes: number;
  readonly discountPercentage: number;
  readonly isActive: boolean;
}

/** Cotizacion completa de un plan para la proyeccion mensual vigente. */
export interface PlanQuote {
  readonly planCode: string;
  readonly displayName: string;
  readonly monthlyFixedPriceUsd: number;
  readonly includedMinutes: number;
  readonly overageMinutes: number;
  readonly appliedDiscountPercentage: number;
  readonly effectiveRatePerMinuteUsd: number;
  readonly estimatedMonthlyTotalUsd: number;
  readonly volumeDiscountEligible: boolean;
  readonly isRecommended: boolean;
}

/** Contrato congelado del hook de la calculadora: estado y acciones de la proyeccion. */
export interface WhopPricingCalculatorHandle {
  readonly isLoading: boolean;
  readonly isDegraded: boolean;
  readonly quotes: readonly PlanQuote[];
  readonly guidedUsers: number;
  readonly minutesPerUser: number;
  readonly monthlyMinutes: number;
  readonly recommendedPlanCode: string | null;
  readonly volumeTiers: readonly VolumeTierView[];
  setGuidedUsers(count: number): void;
  setMinutesPerUser(minutes: number): void;
}

/** Formatea un monto en dolares con el locale en-US y el simbolo de la divisa. */
export function formatUsd(amount: number): string {
  return USD_FORMATTER.format(amount);
}

/** Construye el enlace de alta con el plan sugerido y los minutos estimados del mes. */
export function buildRegistrationHref(planCode: string, estimatedMinutes: number): string {
  const roundedMinutes = Math.max(0, Math.round(estimatedMinutes));
  return `/auth/register?plan=${planCode}&estimated_minutes=${roundedMinutes}`;
}

interface RawPlanShape {
  readonly planCode?: string;
  readonly plan_code?: string;
  readonly displayName?: string;
  readonly display_name?: string;
  readonly monthlyFixedPriceUsd?: unknown;
  readonly monthly_fixed_price_usd?: unknown;
  readonly includedMinutes?: unknown;
  readonly included_minutes?: unknown;
  readonly baseOverageRatePerMinuteUsd?: unknown;
  readonly base_overage_rate_per_minute_usd?: unknown;
  readonly overageAllowed?: boolean;
  readonly overage_allowed?: boolean;
  readonly volumeDiscountEligible?: boolean;
  readonly volume_discount_eligible?: boolean;
  readonly volumeDiscountTiers?: readonly PublicVolumeDiscountTierDto[];
  readonly volume_discount_tiers?: readonly PublicVolumeDiscountTierDto[];
}

/** Parsea un decimal del DTO con tolerancia: soporta string o number; si no es finito retorna 0. */
function parseDecimal(rawValue: unknown): number {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : 0;
  }
  if (typeof rawValue === 'string') {
    const parsed = Number.parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Redondea y acota un entero al rango del control, con respaldo si no es finito. */
function clampInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

interface RawTierShape {
  readonly minMinutes?: unknown;
  readonly discountPercentage?: unknown;
  readonly min_overage_minutes?: unknown;
  readonly discount_pct?: unknown;
}

/** Normaliza un tramo de descuento tolerando tanto camelCase como snake_case de backend/DB. */
function normalizeTierDto(raw: unknown): PublicVolumeDiscountTierDto {
  const rawObj = (typeof raw === 'object' && raw !== null ? raw : {}) as RawTierShape;
  const rawMin = rawObj.minMinutes ?? rawObj.min_overage_minutes ?? 0;
  const rawPct = rawObj.discountPercentage ?? rawObj.discount_pct ?? 0;
  const minMinutes = Math.round(typeof rawMin === 'number' ? rawMin : Number(rawMin));
  const discountPercentage = Math.round(typeof rawPct === 'number' ? rawPct : Number(rawPct));
  return {
    minMinutes: Number.isFinite(minMinutes) ? Math.max(0, minMinutes) : 0,
    discountPercentage: Number.isFinite(discountPercentage) ? Math.min(100, Math.max(0, discountPercentage)) : 0,
  };
}

/** Resuelve el tramo aplicable: el de mayor umbral cuyo minimo no exceda el excedente dado. */
function resolveAppliedTier(
  tiers: readonly PublicVolumeDiscountTierDto[],
  overageMinutes: number,
): PublicVolumeDiscountTierDto | null {
  let applied: PublicVolumeDiscountTierDto | null = null;
  for (const raw of tiers) {
    const tier = normalizeTierDto(raw);
    const isReached = tier.minMinutes <= overageMinutes;
    const isHigher = applied === null || tier.minMinutes > applied.minMinutes;
    if (isReached && isHigher) {
      applied = tier;
    }
  }
  return applied;
}

/** Cotiza un plan para la proyeccion: formula espejo de la matriz publica del backend. */
function buildBaseQuote(
  rawPlan: PublicPricingPlanDto,
  monthlyMinutes: number,
  paygRatePerMinuteUsd: number,
): PlanQuote {
  const plan = rawPlan as unknown as RawPlanShape;
  const planCode = plan.planCode ?? plan.plan_code ?? 'UNKNOWN';
  const displayName = plan.displayName ?? plan.display_name ?? planCode;
  const monthlyFixedPriceUsd = parseDecimal(plan.monthlyFixedPriceUsd ?? plan.monthly_fixed_price_usd);
  const includedMinutes = parseDecimal(plan.includedMinutes ?? plan.included_minutes);
  const baseOverageRatePerMinuteUsd = parseDecimal(plan.baseOverageRatePerMinuteUsd ?? plan.base_overage_rate_per_minute_usd);
  const volumeDiscountEligible = plan.volumeDiscountEligible ?? plan.volume_discount_eligible ?? false;
  const volumeDiscountTiers = plan.volumeDiscountTiers ?? plan.volume_discount_tiers ?? [];
  const overageMinutes = Math.max(0, monthlyMinutes - includedMinutes);
  const isPayAsYouGo = planCode === PAYG_PLAN_CODE;
  const appliedDiscountPercentage = !isPayAsYouGo && volumeDiscountEligible
    ? resolveAppliedTier(volumeDiscountTiers, overageMinutes)?.discountPercentage ?? 0
    : 0;
  const effectiveRatePerMinuteUsd = isPayAsYouGo
    ? paygRatePerMinuteUsd
    : baseOverageRatePerMinuteUsd * (1 - appliedDiscountPercentage / 100);
  const estimatedMonthlyTotalUsd = isPayAsYouGo
    ? monthlyMinutes * effectiveRatePerMinuteUsd
    : monthlyFixedPriceUsd + overageMinutes * effectiveRatePerMinuteUsd;
  return {
    planCode,
    displayName,
    monthlyFixedPriceUsd,
    includedMinutes,
    overageMinutes,
    appliedDiscountPercentage,
    effectiveRatePerMinuteUsd,
    estimatedMonthlyTotalUsd,
    volumeDiscountEligible,
    isRecommended: false,
  };
}

/** Decide si una cotizacion desplaza a la mejor actual (menor total; desempate por fijo). */
function isBetterRecommendation(candidate: PlanQuote, current: PlanQuote): boolean {
  if (candidate.estimatedMonthlyTotalUsd !== current.estimatedMonthlyTotalUsd) {
    return candidate.estimatedMonthlyTotalUsd < current.estimatedMonthlyTotalUsd;
  }
  return candidate.monthlyFixedPriceUsd < current.monthlyFixedPriceUsd;
}

/** Hook de la calculadora dinamica de planes con descuento por volumen. */
export function useWhopPricingCalculator(): WhopPricingCalculatorHandle {
  const [plans, setPlans] = useState<readonly PublicPricingPlanDto[]>(CANONICAL_PUBLIC_PLANS_FALLBACK);
  const [paygRateRaw, setPaygRateRaw] = useState<string>(PAYG_RATE_PER_MINUTE_USD_FALLBACK);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isDegraded, setIsDegraded] = useState<boolean>(false);
  const [guidedUsers, setGuidedUsersValue] = useState<number>(GUIDED_USERS_DEFAULT);
  const [minutesPerUser, setMinutesPerUserValue] = useState<number>(MINUTES_PER_USER_DEFAULT);

  useEffect(() => {
    const controller = new AbortController();
    let isDisposed = false;
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    backendFetch<PublicPricingMatrixDto>(PRICING_MATRIX_PATH, {
      anonymous: true,
      signal: controller.signal,
    })
      .then((matrix) => {
        if (isDisposed) {
          return;
        }
        const hasPlans = matrix.plans.length > 0;
        setPlans(hasPlans ? matrix.plans : CANONICAL_PUBLIC_PLANS_FALLBACK);
        setPaygRateRaw(hasPlans ? matrix.payAsYouGoRatePerMinuteUsd : PAYG_RATE_PER_MINUTE_USD_FALLBACK);
        setIsDegraded(matrix.isDegraded || !hasPlans);
        setIsLoading(false);
      })
      .catch((_failure: unknown) => {
        if (isDisposed) {
          return;
        }
        setPlans(CANONICAL_PUBLIC_PLANS_FALLBACK);
        setPaygRateRaw(PAYG_RATE_PER_MINUTE_USD_FALLBACK);
        setIsDegraded(true);
        setIsLoading(false);
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      isDisposed = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  /** Acota la proyeccion de usuarios guiados al rango publico del control. */
  const setGuidedUsers = useCallback((count: number): void => {
    setGuidedUsersValue(clampInteger(count, GUIDED_USERS_MIN, GUIDED_USERS_MAX, GUIDED_USERS_DEFAULT));
  }, []);

  /** Acota la proyeccion de minutos por usuario al rango publico del control. */
  const setMinutesPerUser = useCallback((minutes: number): void => {
    setMinutesPerUserValue(
      clampInteger(minutes, MINUTES_PER_USER_MIN, MINUTES_PER_USER_MAX, MINUTES_PER_USER_DEFAULT),
    );
  }, []);

  const monthlyMinutes = guidedUsers * minutesPerUser;
  const paygRatePerMinuteUsd = parseDecimal(paygRateRaw);

  const activePlans = useMemo(
    () => plans.filter((plan) => plan.isActive),
    [plans],
  );

  const eligiblePlan = useMemo(() => {
    const candidates = activePlans.filter(
      (plan) => plan.volumeDiscountEligible && plan.volumeDiscountTiers.length > 0,
    );
    return candidates.find((plan) => plan.planCode === PLAN_50_CODE) ?? candidates[0] ?? null;
  }, [activePlans]);

  const quotes = useMemo<readonly PlanQuote[]>(() => {
    const baseQuotes = activePlans.map((plan) => buildBaseQuote(plan, monthlyMinutes, paygRatePerMinuteUsd));
    let recommended: PlanQuote | null = null;
    for (const quote of baseQuotes) {
      if (recommended === null || isBetterRecommendation(quote, recommended)) {
        recommended = quote;
      }
    }
    const recommendedCode = recommended?.planCode ?? null;
    return baseQuotes.map((quote) => ({
      ...quote,
      isRecommended: quote.planCode === recommendedCode,
    }));
  }, [activePlans, monthlyMinutes, paygRatePerMinuteUsd]);

  const volumeTiers = useMemo<readonly VolumeTierView[]>(() => {
    const sourceTiers = eligiblePlan === null ? FROZEN_VOLUME_TIERS : eligiblePlan.volumeDiscountTiers;
    const normalizedTiers = sourceTiers.map(normalizeTierDto);
    const sortedTiers = [...normalizedTiers].sort((left, right) => left.minMinutes - right.minMinutes);
    const plan50 = activePlans.find((plan) => plan.planCode === PLAN_50_CODE) ?? eligiblePlan;
    const overageMinutes = plan50 === null
      ? 0
      : Math.max(0, monthlyMinutes - parseDecimal(plan50.includedMinutes));
    const appliedTier = resolveAppliedTier(sortedTiers, overageMinutes);
    return sortedTiers.map((tier) => ({
      minMinutes: tier.minMinutes,
      discountPercentage: tier.discountPercentage,
      isActive: appliedTier !== null && appliedTier.minMinutes === tier.minMinutes,
    }));
  }, [activePlans, eligiblePlan, monthlyMinutes]);

  const recommendedPlanCode = quotes.find((quote) => quote.isRecommended)?.planCode ?? null;

  return {
    isLoading,
    isDegraded,
    quotes,
    guidedUsers,
    minutesPerUser,
    monthlyMinutes,
    recommendedPlanCode,
    volumeTiers,
    setGuidedUsers,
    setMinutesPerUser,
  };
}
