/**
 * @archivo apps/web/src/components/landing/pricing/InteractivePricingCalculator.tsx
 * @modulo apps/web/src/components/landing/pricing (Calculadora Comercial Ultra-Compacta de Precios)
 * @proposito
 *   Sección interactiva de precios y calculadora de la landing comercial:
 *   - Diseño ultra-compacto ("cuadraditos pequeñitos") en formato split lado a lado (2 columnas en escritorio)
 *     para que la calculadora, la regla de volumen y los 5 planes comparativos entren simultáneamente
 *     a la vista sin requerir scroll vertical.
 *   - Titular ceñido y armónico con acento editorial ("Tu operación crece y el precio por minuto baja").
 *   - Controles deslizantes turquesa reactivos conectados con `useWhopPricingCalculator`.
 *
 * @resumen_contenido
 *   - Columna izquierda: Sliders de usuarios guiados y minutos, proyección mensual y tramos de descuento.
 *   - Columna derecha: Carrusel de los 5 planes comparativos con navegación rápida y tarjetas condensadas.
 *
 * @dependencias_internas
 *   - `./useWhopPricingCalculator` (`useWhopPricingCalculator`).
 *   - `./VolumeDiscountTierVisualizer` (`VolumeDiscountTierVisualizer`).
 *   - `./WhopPlanComparisonCards` (`WhopPlanComparisonCards`).
 *
 * @dependencias_externas
 *   - `react` (`type ReactElement`).
 */

'use client';

import type { ReactElement } from 'react';
import { VolumeDiscountTierVisualizer } from './VolumeDiscountTierVisualizer';
import { WhopPlanComparisonCards } from './WhopPlanComparisonCards';
import { useWhopPricingCalculator } from './useWhopPricingCalculator';

/** Formateador es-MX de enteros (miles con punto, sin decimales). */
const ES_MX_INTEGER_FORMATTER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** Formatea un entero en es-MX (miles con punto) para cifras de la calculadora. */
function formatIntegerEsMx(value: number): string {
  return ES_MX_INTEGER_FORMATTER.format(Math.max(0, Math.round(value)));
}

export function InteractivePricingCalculator(): ReactElement {
  const {
    isLoading,
    isDegraded,
    quotes,
    guidedUsers,
    minutesPerUser,
    monthlyMinutes,
    volumeTiers,
    setGuidedUsers,
    setMinutesPerUser,
  } = useWhopPricingCalculator();

  // El visualizador sigue el excedente del plan tope elegible (PLAN_50)
  const volumeEligibleQuote =
    quotes.find((quote) => quote.planCode === 'PLAN_50' && quote.volumeDiscountEligible) ??
    quotes.find((quote) => quote.volumeDiscountEligible);
  const currentOverageMinutes = volumeEligibleQuote?.overageMinutes ?? 0;

  return (
    <section
      id="precios"
      className="scroll-mt-16 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-6 w-full"
      aria-labelledby="oa-pricing-title"
      data-purpose="compact-pricing-section"
    >
      <style>{`
        /* Micro-sliders interactivos turquesa */
        .oa-compact-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          background: transparent;
          cursor: pointer;
        }
        .oa-compact-slider::-webkit-slider-runnable-track {
          background: #cceee9;
          height: 3px;
          border-radius: 9999px;
        }
        .oa-compact-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: #12b5a5;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
          margin-top: -5px;
          transition: transform 120ms ease;
        }
        .oa-compact-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }
        .oa-compact-slider::-moz-range-track {
          background: #cceee9;
          height: 3px;
          border-radius: 9999px;
        }
        .oa-compact-slider::-moz-range-thumb {
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: #12b5a5;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        }
      `}</style>

      {/* Cabecera Ultra-Compacta (ocupa mínimo espacio vertical) */}
      <div className="mb-3">
        <div className="inline-block text-[10px] font-bold tracking-widest text-[#0d5c58] uppercase mb-0.5">
          PRECIOS TRANSPARENTES, FACTURACIÓN POR MINUTO
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
          <h2
            id="oa-pricing-title"
            className="text-xl sm:text-2xl font-bold tracking-tight text-[#0f2f38] leading-tight"
          >
            Tu operación crece y el precio por minuto{' '}
            <span className="font-serif italic font-normal text-[#0f2f38]">baja</span>.
          </h2>
          <p className="text-[#41626a] text-xs max-w-md leading-snug">
            Ajusta los sliders y compara el costo mensual de cada plan en tiempo real.
          </p>
        </div>
      </div>

      {/* Rejilla Lado a Lado: Calculadora (Izq) + Cuadraditos de Planes (Der) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
        {/* Columna Izquierda: Calculadora y Tramos */}
        <div
          className="lg:col-span-5 bg-white/80 border border-[#bce2dc] rounded-xl p-3 sm:p-4 shadow-xs flex flex-col justify-between"
          data-purpose="pricing-calculator"
        >
          {/* Sliders de Entrada */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-2">
            {/* Slider 1: Usuarios guiados */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="oa-slider-users"
                  className="text-[9px] font-bold tracking-wider text-[#4d727a] uppercase cursor-pointer"
                >
                  USUARIOS
                </label>
                <output htmlFor="oa-slider-users" className="text-base font-bold text-[#0f2f38]">
                  {formatIntegerEsMx(guidedUsers)}
                </output>
              </div>
              <input
                id="oa-slider-users"
                className="oa-compact-slider"
                type="range"
                min={1}
                max={500}
                step={1}
                value={guidedUsers}
                onChange={(e) => setGuidedUsers(Number.parseInt(e.target.value, 10))}
                aria-label="Usuarios guiados por mes"
              />
              <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
                <span>1</span>
                <span>500</span>
              </div>
            </div>

            {/* Slider 2: Minutos por usuario */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="oa-slider-minutes"
                  className="text-[9px] font-bold tracking-wider text-[#4d727a] uppercase cursor-pointer"
                >
                  MIN / USUARIO
                </label>
                <output htmlFor="oa-slider-minutes" className="text-base font-bold text-[#0f2f38]">
                  {formatIntegerEsMx(minutesPerUser)}
                </output>
              </div>
              <input
                id="oa-slider-minutes"
                className="oa-compact-slider"
                type="range"
                min={5}
                max={2000}
                step={5}
                value={minutesPerUser}
                onChange={(e) => setMinutesPerUser(Number.parseInt(e.target.value, 10))}
                aria-label="Minutos por usuario al mes"
              />
              <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
                <span>5</span>
                <span>2.000</span>
              </div>
            </div>
          </div>

          {/* Franja de Proyección Mensual */}
          <div className="border border-[#c6e9e4] rounded-lg py-1 px-2.5 flex items-center justify-between bg-white/60 mb-2">
            <span className="text-[9px] font-bold tracking-wider text-[#4d727a] uppercase">
              PROYECCIÓN TOTAL
            </span>
            <span className="text-sm sm:text-base font-extrabold text-[#0f2f38]">
              {formatIntegerEsMx(monthlyMinutes)} min/mes
            </span>
          </div>

          {/* Descuento por Volumen Escalonado */}
          <VolumeDiscountTierVisualizer
            tiers={volumeTiers}
            currentOverageMinutes={currentOverageMinutes}
          />
        </div>

        {/* Columna Derecha: Cuadraditos de Planes Comparativos */}
        <div
          className="lg:col-span-7 bg-white/80 border border-[#bce2dc] rounded-xl p-3 sm:p-3.5 shadow-xs flex flex-col justify-between overflow-hidden"
          data-purpose="plans-showcase"
        >
          <WhopPlanComparisonCards
            quotes={quotes}
            monthlyMinutes={monthlyMinutes}
            isLoading={isLoading}
            isDegraded={isDegraded}
          />
        </div>
      </div>
    </section>
  );
}
