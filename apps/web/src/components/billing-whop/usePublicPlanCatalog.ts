/**
 * @archivo apps/web/src/components/billing-whop/usePublicPlanCatalog.ts
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Lee el catálogo REAL de planes comerciales desde la matriz de precios pública del backend
 *   (`GET /api/v1/public/pricing-matrix`) para que el panel de facturación nunca muestre precios,
 *   minutos incluidos ni tarifas de sobreconsumo escritos a mano. Si la matriz no responde, la
 *   interfaz lo declara y NO inventa cifras: el catálogo queda vacío y se informa del fallo.
 *
 * @resumen_contenido
 *   - `PublicPlanOption`: proyección de un plan para la interfaz (código, nombre, precio, cuota).
 *   - `usePublicPlanCatalog()`: consulta la matriz pública y devuelve planes, estado de carga y error.
 *
 * @dependencias_internas
 *   - `backendFetch` (apps/web/src/lib/api-client/http-client.ts).
 *   - `PublicPricingMatrixDto` (apps/web/src/lib/api-client/backend-contracts.types.ts).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST pública): `pricing_matrix` y tramos de descuento por volumen.
 */

'use client';

import { useEffect, useState } from 'react';
import { backendFetch } from '../../lib/api-client/http-client';
import type { PublicPricingMatrixDto } from '../../lib/api-client/backend-contracts.types';

/** Ruta pública de la matriz de precios (no exige sesión). */
const PRICING_MATRIX_PATH = '/api/v1/public/pricing-matrix';

/** Plan comercial tal y como lo pinta el panel de facturación. */
export interface PublicPlanOption {
  readonly code: string;
  readonly name: string;
  readonly priceUsd: string;
  readonly minutes: string;
  readonly overageRate: string;
  readonly buttonId: string;
}

/** Formatea un importe en USD con dos decimales. */
function formatUsd(raw: string): string {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : raw;
}

/** Formatea una cuota de minutos sin decimales. */
function formatMinutes(raw: string): string {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : raw;
}

/** Convierte un plan de la matriz pública en la proyección de la interfaz. */
function toPlanOption(plan: PublicPricingMatrixDto['plans'][number]): PublicPlanOption {
  const isPayAsYouGo = plan.planCode === 'PAYG';
  const fixedPrice = formatUsd(plan.monthlyFixedPriceUsd);
  return {
    code: plan.planCode,
    name: plan.displayName,
    priceUsd: isPayAsYouGo ? `${formatUsd(plan.baseOverageRatePerMinuteUsd)}/min` : `$${fixedPrice}/mes`,
    minutes: `${formatMinutes(plan.includedMinutes)} min inc.`,
    overageRate: `$${formatUsd(plan.baseOverageRatePerMinuteUsd)}/min`,
    buttonId: `btn_subscribe_${plan.planCode.toLowerCase()}`,
  };
}

/**
 * Hook del catálogo real de planes (matriz de precios pública del backend).
 *
 * @returns Planes disponibles, estado de carga y error; sin datos, la lista queda vacía.
 */
export function usePublicPlanCatalog(): {
  readonly plans: readonly PublicPlanOption[];
  readonly isLoading: boolean;
  readonly error: string | null;
} {
  const [plans, setPlans] = useState<readonly PublicPlanOption[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let isDisposed = false;
    const controller = new AbortController();

    backendFetch<PublicPricingMatrixDto>(PRICING_MATRIX_PATH, {
      anonymous: true,
      signal: controller.signal,
    })
      .then((matrix): void => {
        if (isDisposed) {
          return;
        }
        const list = Array.isArray(matrix.plans) ? matrix.plans : [];
        setPlans(list.map(toPlanOption));
        setError(list.length === 0 ? 'La matriz de precios no devolvió ningún plan disponible.' : null);
        setIsLoading(false);
      })
      .catch((caught: unknown): void => {
        if (isDisposed) {
          return;
        }
        setPlans([]);
        setError(caught instanceof Error
          ? caught.message
          : 'No fue posible consultar la matriz de precios.');
        setIsLoading(false);
      });

    return (): void => {
      isDisposed = true;
      controller.abort();
    };
  }, []);

  return { plans, isLoading, error };
}
