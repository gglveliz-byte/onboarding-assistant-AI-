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

import { useState, useCallback } from 'react';

export interface VolumeDiscountTierDefinition {
  readonly fromMinute: number;
  readonly toMinute: number | null;
  readonly discountPercentage: number;
  readonly discountedRatePerMinuteUsd?: string;
}

export interface GlobalPricingPlan {
  readonly planCode: 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50';
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
  readonly estimatedCostWithoutDiscountUsd: string;
  readonly estimatedDiscountUsd: string;
  readonly finalBilledAmountUsd: string;
  readonly effectiveAverageRateUsd: string;
}

const DEFAULT_GLOBAL_PLANS: readonly GlobalPricingPlan[] = [
  {
    planCode: 'PAYG',
    whopPlanId: 'whop_plan_payg',
    displayName: 'Pago por Uso (PAYG)',
    monthlyFixedPriceUsd: '0.000000',
    includedMinutes: '0',
    baseOverageRatePerMinuteUsd: '0.150000',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    isActive: true,
  },
  {
    planCode: 'PLAN_5',
    whopPlanId: 'whop_plan_starter_5',
    displayName: 'Desarrollador ($5 USD)',
    monthlyFixedPriceUsd: '5.000000',
    includedMinutes: '25',
    baseOverageRatePerMinuteUsd: '0.120000',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    isActive: true,
  },
  {
    planCode: 'PLAN_10',
    whopPlanId: 'whop_plan_growth_10',
    displayName: 'Crecimiento ($10 USD)',
    monthlyFixedPriceUsd: '10.000000',
    includedMinutes: '60',
    baseOverageRatePerMinuteUsd: '0.110000',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    isActive: true,
  },
  {
    planCode: 'PLAN_30',
    whopPlanId: 'whop_plan_pro_30',
    displayName: 'Pro ($30 USD)',
    monthlyFixedPriceUsd: '30.000000',
    includedMinutes: '220',
    baseOverageRatePerMinuteUsd: '0.095000',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    isActive: true,
  },
  {
    planCode: 'PLAN_50',
    whopPlanId: 'whop_plan_scale_50',
    displayName: 'Escala Empresarial ($50 USD)',
    monthlyFixedPriceUsd: '50.000000',
    includedMinutes: '450',
    baseOverageRatePerMinuteUsd: '0.080000',
    overageAllowed: true,
    volumeDiscountEligible: true,
    volumeDiscountTiers: [
      { fromMinute: 500, toMinute: 999, discountPercentage: 10, discountedRatePerMinuteUsd: '0.072000' },
      { fromMinute: 1000, toMinute: 2499, discountPercentage: 20, discountedRatePerMinuteUsd: '0.064000' },
      { fromMinute: 2500, toMinute: 4999, discountPercentage: 35, discountedRatePerMinuteUsd: '0.052000' },
      { fromMinute: 5000, toMinute: null, discountPercentage: 50, discountedRatePerMinuteUsd: '0.040000' },
    ],
    isActive: true,
  },
];

export interface UseSuperAdminPricingAndOverridesReturn {
  readonly plans: readonly GlobalPricingPlan[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly updateGlobalPricingPlan: (planCode: string, plan: Partial<GlobalPricingPlan>) => Promise<boolean>;
  readonly setTenantOverride: (orgId: string, payload: TenantOverridePayload) => Promise<boolean>;
  readonly removeTenantOverride: (orgId: string) => Promise<boolean>;
  readonly grantPromotionalMinutes: (orgId: string, minutes: number, reason: string) => Promise<boolean>;
  readonly simulateFinancialImpact: (
    totalMinutes: number,
    baseRate: number,
    discountPercentage?: number,
    customRate?: number
  ) => FinancialSimulationResult;
}

/**
 * Hook de operaciones tarifarias para SuperAdmin.
 */
export function useSuperAdminPricingAndOverrides(): UseSuperAdminPricingAndOverridesReturn {
  const [plans, setPlans] = useState<readonly GlobalPricingPlan[]>(DEFAULT_GLOBAL_PLANS);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Actualiza los parámetros de un plan de la matriz global Whop.
   */
  const updateGlobalPricingPlan = useCallback(async (
    planCode: string,
    updatedValues: Partial<GlobalPricingPlan>
  ): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/superadmin/pricing-matrix/${planCode}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whopPlanId: updatedValues.whopPlanId ?? `whop_${planCode.toLowerCase()}`,
          displayName: updatedValues.displayName ?? planCode,
          monthlyFixedPriceUsd: updatedValues.monthlyFixedPriceUsd ?? '0.000000',
          includedMinutes: updatedValues.includedMinutes ?? '0',
          baseOverageRatePerMinuteUsd: updatedValues.baseOverageRatePerMinuteUsd ?? '0.100000',
          overageAllowed: updatedValues.overageAllowed ?? true,
          volumeDiscountEligible: updatedValues.volumeDiscountEligible ?? false,
          volumeDiscountTiersJson: updatedValues.volumeDiscountTiers ?? [],
        }),
      });

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

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
      });
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promotionalMinutesCount: minutes, grantReason: reason }),
      });

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
    customRate?: number
  ): FinancialSimulationResult => {
    const activeRate = typeof customRate === 'number' && customRate > 0 ? customRate : baseRate;
    const undiscounted = totalMinutes * activeRate;
    const discountAmount = undiscounted * (Math.min(100, Math.max(0, discountPercentage)) / 100);
    const finalAmount = Math.max(0, undiscounted - discountAmount);
    const effectiveAvg = totalMinutes > 0 ? finalAmount / totalMinutes : activeRate;

    return {
      estimatedCostWithoutDiscountUsd: undiscounted.toFixed(4),
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
    setTenantOverride,
    removeTenantOverride,
    grantPromotionalMinutes,
    simulateFinancialImpact,
  };
}
