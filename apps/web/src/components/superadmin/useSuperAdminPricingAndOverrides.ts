/**
 * @archivo apps/web/src/components/superadmin/useSuperAdminPricingAndOverrides.ts
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Hook de gestión para la Matriz Global de Precios Whop ($5 a $50 USD/mes + PAYG),
 *   editor de tramos de descuento por volumen y asignación de tarifas a medida
 *   u otorgamiento de minutos de cortesía (`CREDIT_SUPERADMIN_GRANT`).
 *
 * @resumen_contenido
 *   - Tipos de estado: `GlobalPricingPlan`, `TenantOverrideState`, `VolumeDiscountTierDefinition`.
 *   - Hook `useSuperAdminPricingAndOverrides`:
 *       * `updateGlobalPricingPlan()`: Lanza `PUT /api/v1/superadmin/pricing-matrix/:planCode`.
 *       * `setTenantOverride()`: Lanza `POST /api/v1/superadmin/organizations/:orgId/pricing-override`.
 *       * `removeTenantOverride()`: Lanza `DELETE /api/v1/superadmin/organizations/:orgId/pricing-override`.
 *       * `grantPromotionalMinutes()`: Lanza `POST /api/v1/superadmin/organizations/:orgId/grant-promotional-minutes`.
 *       * `simulateFinancialImpact()`: Calculador del impacto financiero para simular facturación estimada.
 *
 * @dependencias_internas
 *   - Endpoints del Módulo 06 (`governance-http.routes.ts`).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useCallback`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `organization_pricing_overrides`, `usage_ledger`.
 */

import { useState, useCallback, useEffect } from 'react';
import { getAccessToken, setAccessToken } from '../../lib/api-client/http-client';

function getSuperAdminHeaders(): Record<string, string> {
  const token = getAccessToken();
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

function handleAuthRejection(setError: (msg: string) => void): void {
  setAccessToken(null);
  setError('Sesión expirada o credenciales insuficientes. Redirigiendo…');
  if (typeof window !== 'undefined') {
    const nextUrl = window.location.pathname + window.location.search;
    window.location.replace(`/internal/superadmin-login?next=${encodeURIComponent(nextUrl)}`);
  }
}

export interface VolumeDiscountTierDefinition {
  readonly fromMinute: number;
  readonly toMinute: number | null;
  readonly discountPercentage: number;
  readonly discountedRatePerMinuteUsd?: string;
}

export interface GlobalPricingPlan {
  readonly planCode: string;
  readonly whopPlanId: string;
  readonly displayName: string;
  readonly monthlyFixedPriceUsd: string;
  readonly includedMinutes: string;
  readonly baseOverageRatePerMinuteUsd: string;
  readonly overageAllowed: boolean;
  readonly volumeDiscountEligible: boolean;
  readonly volumeDiscountTiers: readonly VolumeDiscountTierDefinition[];
  readonly isActive: boolean;
}

/** Calcula la tarifa por minuto resultante de un paquete fijo (precio / minutos). */
export function calculateEffectiveUnitRate(
  monthlyPrice: string | number,
  includedMinutes: string | number
): number {
  const price = typeof monthlyPrice === 'string' ? parseFloat(monthlyPrice) : monthlyPrice;
  const mins = typeof includedMinutes === 'string' ? parseFloat(includedMinutes) : includedMinutes;
  if (!mins || mins <= 0 || isNaN(price) || isNaN(mins)) return 0;
  return price / mins;
}

export interface TenantOverridePayload {
  readonly customRatePerMinuteUsd?: string | null;
  readonly manualDiscountPercentage?: number;
  readonly forceVolumeDiscountTiers?: boolean;
  readonly customVolumeTiersJson?: readonly VolumeDiscountTierDefinition[];
  readonly overrideNotes: string;
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
}

export interface FinancialSimulationResult {
  readonly monthlyFixedPriceUsd: string;
  readonly includedMinutes: number;
  readonly overageMinutes: number;
  readonly overageCostUsd: string;
  readonly estimatedCostWithoutDiscountUsd: string;
  readonly estimatedDiscountUsd: string;
  readonly finalBilledAmountUsd: string;
  readonly effectiveAverageRateUsd: string;
}

/**
 * Matriz de precios de ejemplo: ELIMINADA deliberadamente.
 *
 * Existia una semilla con `whopPlanId` ficticios (`whop_plan_payg`, `whop_plan_starter_5`) y precios
 * que no coincidian con ningun plan real. Al fallar la lectura de la API, el panel la mostraba como
 * si fuera la matriz vigente, y guardarla escribia esos identificadores inventados sobre los reales,
 * rompiendo el checkout de la pasarela. El panel ahora parte vacio y declara el error.
 */

export interface UseSuperAdminPricingAndOverridesReturn {
  readonly plans: readonly GlobalPricingPlan[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly updateGlobalPricingPlan: (planCode: string, plan: Partial<GlobalPricingPlan>) => Promise<boolean>;
  readonly createGlobalPricingPlan: (newPlan: GlobalPricingPlan) => Promise<boolean>;
  readonly deleteGlobalPricingPlan: (planCode: string) => Promise<boolean>;
  readonly setTenantOverride: (orgId: string, payload: TenantOverridePayload) => Promise<boolean>;
  readonly removeTenantOverride: (orgId: string) => Promise<boolean>;
  readonly grantPromotionalMinutes: (orgId: string, minutes: number, reason: string) => Promise<boolean>;
  readonly simulateFinancialImpact: (
    totalMinutes: number,
    baseRate: number,
    discountPercentage?: number,
    customRate?: number,
    monthlyFixedPrice?: number,
    includedMinutes?: number
  ) => FinancialSimulationResult;
}

/**
 * Hook de operaciones tarifarias para SuperAdmin.
 */
export function useSuperAdminPricingAndOverrides(): UseSuperAdminPricingAndOverridesReturn {
  const [plans, setPlans] = useState<readonly GlobalPricingPlan[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /** Carga la matriz de planes configurada en PostgreSQL. */
  const fetchPlans = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/superadmin/pricing-matrix', {
        headers: getSuperAdminHeaders(),
      });
      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return;
      }
      if (!res.ok) {
        setError(`No se pudo leer la matriz de precios de la plataforma (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      const serverPlans = data.plans;
      if (!Array.isArray(serverPlans) || serverPlans.length === 0) {
        setError('La matriz de precios está vacía: no hay planes publicados todavía.');
        return;
      }
      setPlans(
        serverPlans.map((p: Record<string, unknown>) => ({
          planCode: String(p['planCode'] ?? '') as GlobalPricingPlan['planCode'],
          whopPlanId: String(p['whopPlanId'] ?? ''),
          displayName: String(p['displayName'] ?? ''),
          monthlyFixedPriceUsd: String(p['monthlyFixedPriceUsd'] ?? '0.000000'),
          includedMinutes: String(p['includedMinutes'] ?? '0'),
          baseOverageRatePerMinuteUsd: String(p['baseOverageRatePerMinuteUsd'] ?? '0.000000'),
          overageAllowed: Boolean(p['overageAllowed']),
          volumeDiscountEligible: Boolean(p['volumeDiscountEligible']),
          volumeDiscountTiers: Array.isArray(p['volumeDiscountTiersJson']) ? p['volumeDiscountTiersJson'] : [],
          isActive: Boolean(p['isActive']),
        }))
      );
    } catch {
      // Sin semilla falsa: se declara el fallo. Un panel que muestra precios inventados termina
      // escribiéndolos, y gobernar la matriz sobre datos ficticios corrompe el catálogo real.
      setError('El servicio de facturación no respondió. No se muestran precios de ejemplo a propósito.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPlans();
  }, [fetchPlans]);

  /**
   * Actualiza los parámetros de un plan de la matriz global Whop.
   */
  const updateGlobalPricingPlan = useCallback(async (
    planCode: string,
    updatedValues: Partial<GlobalPricingPlan>
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    // El identificador de la pasarela NUNCA se inventa ni se deduce del codigo del plan: un `plan_id`
    // fabricado hace que el checkout falle contra la pasarela. Se reutiliza el que ya esta cargado
    // desde el servidor, y si el plan todavia no esta aprovisionado se aborta la escritura.
    const knownPlan = plans.find((candidate) => candidate.planCode === planCode);
    const resolvedWhopPlanId = (updatedValues.whopPlanId ?? knownPlan?.whopPlanId ?? '').trim();
    if (resolvedWhopPlanId.length === 0 || !/^plan_[A-Za-z0-9]+$/u.test(resolvedWhopPlanId)) {
      setError(
        `El plan ${planCode} no tiene identificador de pasarela. Aprovisionelo con "npm run whop:provision" antes de gobernar su precio.`
      );
      setIsLoading(false);
      return false;
    }

    try {
      const res = await fetch(`/api/v1/superadmin/pricing-matrix/${planCode}`, {
        method: 'PUT',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify({
          whopPlanId: resolvedWhopPlanId,
          displayName: updatedValues.displayName ?? knownPlan?.displayName ?? planCode,
          monthlyFixedPriceUsd: updatedValues.monthlyFixedPriceUsd ?? knownPlan?.monthlyFixedPriceUsd ?? '0.000000',
          includedMinutes: updatedValues.includedMinutes ?? knownPlan?.includedMinutes ?? '0',
          baseOverageRatePerMinuteUsd:
            updatedValues.baseOverageRatePerMinuteUsd ?? knownPlan?.baseOverageRatePerMinuteUsd ?? '0.000000',
          overageAllowed: updatedValues.overageAllowed ?? knownPlan?.overageAllowed ?? false,
          volumeDiscountEligible: updatedValues.volumeDiscountEligible ?? knownPlan?.volumeDiscountEligible ?? false,
          volumeDiscountTiersJson: updatedValues.volumeDiscountTiers ?? knownPlan?.volumeDiscountTiers ?? [],
          isActive: updatedValues.isActive ?? knownPlan?.isActive ?? true,
        }),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al actualizar matriz de precios`);
      }

      setPlans((prev) =>
        prev.map((p) => (p.planCode === planCode ? { ...p, ...updatedValues } : p))
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al guardar plan global';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [plans]);

  /**
   * Crea un nuevo plan en la matriz global de precios Whop.
   */
  const createGlobalPricingPlan = useCallback(async (
    newPlan: GlobalPricingPlan
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/superadmin/pricing-matrix', {
        method: 'POST',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify({
          planCode: newPlan.planCode,
          whopPlanId: newPlan.whopPlanId,
          displayName: newPlan.displayName,
          monthlyFixedPriceUsd: newPlan.monthlyFixedPriceUsd,
          includedMinutes: newPlan.includedMinutes,
          baseOverageRatePerMinuteUsd: newPlan.baseOverageRatePerMinuteUsd,
          overageAllowed: newPlan.overageAllowed,
          volumeDiscountEligible: newPlan.volumeDiscountEligible,
          volumeDiscountTiersJson: newPlan.volumeDiscountTiers,
          isActive: newPlan.isActive,
        }),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al crear plan`);
      }

      setPlans((prev) => [...prev.filter((p) => p.planCode !== newPlan.planCode), newPlan]);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al crear plan';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Elimina un plan de la matriz global de precios.
   */
  const deleteGlobalPricingPlan = useCallback(async (
    planCode: string
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/superadmin/pricing-matrix/${planCode}`, {
        method: 'DELETE',
        headers: getSuperAdminHeaders(),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al eliminar plan`);
      }

      setPlans((prev) => prev.filter((p) => p.planCode !== planCode));
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al eliminar plan';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Asigna tarifas a medida y descuentos por cliente (prioridad absoluta en CalculateEffectiveRateUseCase).
   */
  const setTenantOverride = useCallback(async (
    orgId: string,
    payload: TenantOverridePayload
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/superadmin/organizations/${orgId}/pricing-override`, {
        method: 'POST',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify(payload),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al aplicar override`);
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al fijar override tarifario';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Elimina un override personalizado restableciendo la matriz general.
   */
  const removeTenantOverride = useCallback(async (orgId: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/superadmin/organizations/${orgId}/pricing-override`, {
        method: 'DELETE',
        headers: getSuperAdminHeaders(),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al revocar override`);
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al eliminar override';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Otorga minutos de cortesía con asiento inmutable CREDIT_SUPERADMIN_GRANT.
   */
  const grantPromotionalMinutes = useCallback(async (
    orgId: string,
    minutes: number,
    reason: string
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/superadmin/organizations/${orgId}/grant-promotional-minutes`, {
        method: 'POST',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify({ promotionalMinutesCount: minutes, grantReason: reason }),
      });

      if (res.status === 401 || res.status === 403) {
        handleAuthRejection(setError);
        return false;
      }

      if (!res.ok) {
        throw new Error(`Error ${res.status} al otorgar minutos`);
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al acreditar minutos de cortesía';
      setError(msg);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Simula en cliente el impacto financiero de una tarifa u override propuesto.
   */
  const simulateFinancialImpact = useCallback((
    totalMinutes: number,
    baseRate: number,
    discountPercentage = 0,
    customRate?: number,
    monthlyFixedPrice = 0,
    includedMinutes = 0
  ): FinancialSimulationResult => {
    const activeRate = typeof customRate === 'number' && customRate > 0 ? customRate : baseRate;
    const overageMins = Math.max(0, totalMinutes - includedMinutes);
    const overageCost = overageMins * activeRate;
    const discountAmount = overageCost * (Math.min(100, Math.max(0, discountPercentage)) / 100);
    const netOverageCost = Math.max(0, overageCost - discountAmount);
    const finalAmount = monthlyFixedPrice + netOverageCost;
    const effectiveAvg = totalMinutes > 0 ? finalAmount / totalMinutes : activeRate;

    return {
      monthlyFixedPriceUsd: monthlyFixedPrice.toFixed(4),
      includedMinutes,
      overageMinutes: overageMins,
      overageCostUsd: overageCost.toFixed(4),
      estimatedCostWithoutDiscountUsd: (monthlyFixedPrice + overageCost).toFixed(4),
      estimatedDiscountUsd: discountAmount.toFixed(4),
      finalBilledAmountUsd: finalAmount.toFixed(4),
      effectiveAverageRateUsd: effectiveAvg.toFixed(6),
    };
  }, []);

  return {
    plans,
    isLoading,
    error,
    updateGlobalPricingPlan,
    createGlobalPricingPlan,
    deleteGlobalPricingPlan,
    setTenantOverride,
    removeTenantOverride,
    grantPromotionalMinutes,
    simulateFinancialImpact,
  };
}
