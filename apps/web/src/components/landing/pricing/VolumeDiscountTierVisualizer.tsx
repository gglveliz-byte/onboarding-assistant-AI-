/**
 * @archivo apps/web/src/components/landing/pricing/VolumeDiscountTierVisualizer.tsx
 * @modulo apps/web/src/components/landing/pricing (Visualizador Compacto de Descuentos por Volumen)
 * @proposito
 *   Muestra de forma ultra-compacta los tramos de descuento por volumen (10%, 20%, 35%, 50%)
 *   con micro-regla turquesa, badge de tramo activo y cálculo de distancia hacia el siguiente umbral.
 *
 * @resumen_contenido
 *   - `VolumeDiscountTierVisualizerProps`: tramos (`VolumeTierView`) y excedente proyectado.
 *   - Cabecera compacta con estado del descuento y etiqueta de porcentaje activo.
 *   - Micro-regla con tag flotante de minutos extra.
 *   - Filas de tramos horizontales en tamaño reducido para visualización en una sola pantalla.
 *
 * @dependencias_internas
 *   - `./useWhopPricingCalculator` (`VolumeTierView`).
 *
 * @dependencias_externas
 *   - `react` (`type ReactElement`).
 */

'use client';

import type { ReactElement } from 'react';
import type { VolumeTierView } from './useWhopPricingCalculator';

/** Props del visualizador de tramos por volumen. */
export interface VolumeDiscountTierVisualizerProps {
  readonly tiers: readonly VolumeTierView[];
  readonly currentOverageMinutes: number;
}

/** Formateador es-MX de conteos de minutos (miles con punto). */
const ES_MX_INTEGER_FORMATTER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** Formatea un conteo de minutos en es-MX, sin decimales y jamás negativo. */
function formatMinutesEsMx(minutes: number): string {
  return ES_MX_INTEGER_FORMATTER.format(Math.max(0, Math.round(minutes)));
}

/** Acota el porcentaje de la regla para que el marcador no desborde. */
function clampRailPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 2;
  }
  return Math.min(98, Math.max(2, percent));
}

/** Redacta el estado del descuento: tramo aplicado y distancia al siguiente umbral. */
function describeVolumeState(tiers: readonly VolumeTierView[], overageMinutes: number): string {
  const activeTier = tiers.find((tier) => tier.isActive) ?? null;
  const nextTier = tiers.find((tier) => tier.minMinutes > overageMinutes) ?? null;
  if (activeTier !== null && nextTier !== null) {
    const remaining = formatMinutesEsMx(nextTier.minMinutes - overageMinutes);
    return `Aplicando ${activeTier.discountPercentage}% sobre extra; faltan ${remaining} min para ${nextTier.discountPercentage}%.`;
  }
  if (activeTier !== null) {
    return `Aplicando ${activeTier.discountPercentage}% sobre extra (tramo máximo alcanzado).`;
  }
  if (nextTier !== null) {
    const remaining = formatMinutesEsMx(nextTier.minMinutes - overageMinutes);
    return `Sin descuento aún: faltan ${remaining} min para activar ${nextTier.discountPercentage}%.`;
  }
  return 'Tramos sincronizados con tarifas vigentes.';
}

/** Visualizador de tramos de descuento por volumen con diseño ultra-compacto. */
export function VolumeDiscountTierVisualizer({
  tiers,
  currentOverageMinutes,
}: VolumeDiscountTierVisualizerProps): ReactElement {
  const activeTier = tiers.find((tier) => tier.isActive) ?? null;
  const scaleMaxMinutes = Math.max(
    1,
    tiers.reduce((maxMinutes, tier) => Math.max(maxMinutes, Number(tier?.minMinutes ?? 0)), 0),
  );
  const markerPercent = clampRailPercent((currentOverageMinutes / scaleMaxMinutes) * 100);

  return (
    <div className="flex flex-col gap-1.5" data-purpose="volume-discount-block">
      {/* Cabecera compacta */}
      <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
        <div>
          <span className="font-bold tracking-wider text-[#4d727a] uppercase block text-[9px]">
            DESCUENTO POR VOLUMEN ESCALONADO
          </span>
          <p className="text-[#4d727a] text-[10px] leading-tight">
            {describeVolumeState(tiers, currentOverageMinutes)}
          </p>
        </div>
        <span className="inline-block border border-[#badfd9] bg-[#eef8f6] text-[#0d5c58] text-[9px] font-bold px-2 py-0.5 rounded shrink-0">
          {activeTier === null ? 'SIN DESCUENTO' : `ACTIVO: ${activeTier.discountPercentage}%`}
        </span>
      </div>

      {tiers.length > 0 && (
        <div className="mt-1">
          {/* Tag flotante y micro-regla */}
          <div className="flex items-center justify-between text-[9px] mb-0.5">
            <span className="border border-[#70cfc2] text-[#0d5c58] bg-white font-semibold px-1.5 py-0.5 rounded shadow-xs">
              {formatMinutesEsMx(currentOverageMinutes)} MIN EXTRA
            </span>
          </div>

          <div className="relative w-full h-[2px] bg-[#c1e6e0] my-2">
            <div
              className="absolute left-0 top-0 h-full bg-[#12b5a5] rounded-full transition-all duration-300"
              style={{ width: `${markerPercent}%` }}
            />
            <div
              className="absolute -top-1 w-2 h-2 rounded-full bg-[#12b5a5] shadow-xs transition-all duration-300"
              style={{ left: `calc(${markerPercent}% - 4px)` }}
            />
            <div className="absolute right-0 -top-1 w-2 h-2 rounded-full bg-[#9ed5cc]" />
          </div>

          {/* Fila compacta de tramos en 4 columnas */}
          <div className="grid grid-cols-4 gap-1.5 text-[10px] mt-2" role="list">
            {tiers.map((tier, index) => {
              const minMinutes = Number(tier?.minMinutes ?? 0);
              const isActive = tier.isActive;

              return (
                <div
                  key={`tier-${minMinutes}-${index}`}
                  className={`rounded-lg p-1.5 flex flex-col items-center justify-center text-center transition-colors ${
                    isActive
                      ? 'border border-[#7b4df2] bg-[#f5f3ff] text-[#0f2f38] shadow-xs'
                      : 'border border-[#cdeae4] bg-white/60 text-[#0f2f38]'
                  }`}
                  role="listitem"
                >
                  <div className="flex items-center gap-1">
                    <span className="font-extrabold text-xs">{tier.discountPercentage}%</span>
                    {isActive && (
                      <span className="text-[7px] uppercase font-bold text-[#7b4df2] bg-white border border-[#b9bcf7] px-1 rounded">
                        ON
                      </span>
                    )}
                  </div>
                  <span className="text-gray-500 font-medium text-[9px] whitespace-nowrap mt-0.5">
                    +{formatMinutesEsMx(minMinutes)}m
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
