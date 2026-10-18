/**
 * @archivo apps/web/src/components/landing/pricing/WhopPlanComparisonCards.tsx
 * @modulo apps/web/src/components/landing/pricing (Carrusel Compacto de Tarjetas Comparativas de Planes)
 * @proposito
 *   Presenta la comparativa de los cinco planes (PAYG, Starter $5, Growth $10, Pro $30 y Enterprise Scale $50)
 *   en un formato de "cuadraditos pequeñitos" ultra-compacto y responsivo:
 *   - Visualización horizontal con snap suave y controles circulares de flechas.
 *   - Tarjetas de plan condensadas con tipografía nítida para ver múltiples planes a la vez.
 *   - Conexión dinámica con cálculo de totales y enlaces de alta.
 *
 * @resumen_contenido
 *   - `WhopPlanComparisonCardsProps`: cotizaciones (`PlanQuote`), minutos mensuales y estados de carga.
 *   - Tarjeta condensada con precio, minutos incluidos, tarifa excedente y total proyectado.
 *   - Tarjeta Enterprise Scale destacada con badge y fondo con acento violeta sutil.
 *
 * @dependencias_internas
 *   - `./useWhopPricingCalculator` (`PlanQuote`, `buildRegistrationHref`, `formatUsd`).
 *
 * @dependencias_externas
 *   - `react` (`useRef`, `useState`, `type ReactElement`, `type UIEvent`).
 */

'use client';

import { useRef, useState, type ReactElement, type UIEvent } from 'react';
import type { PlanQuote } from './useWhopPricingCalculator';
import { buildRegistrationHref, formatUsd } from './useWhopPricingCalculator';

/** Formateador es-MX de conteos de minutos (miles con punto). */
const ES_MX_INTEGER_FORMATTER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** Formateador de tarifas por minuto en USD con hasta 4 decimales. */
const USD_RATE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Formatea conteos de minutos sin decimales. */
function formatMinutesEsMx(minutes: number): string {
  return ES_MX_INTEGER_FORMATTER.format(Math.max(0, Math.round(minutes)));
}

/** Formatea una tarifa conservando la precisión del descuento. */
function formatUsdRate(rate: number): string {
  return USD_RATE_FORMATTER.format(rate);
}

/** Compone la tarifa efectiva con el sello de descuento si aplica. */
function describeEffectiveRate(quote: PlanQuote): ReactElement | string {
  const rate = formatUsdRate(quote.effectiveRatePerMinuteUsd);
  if (quote.appliedDiscountPercentage > 0) {
    return (
      <span>
        {rate} <span className="text-teal-600 font-bold ml-0.5">−{quote.appliedDiscountPercentage}%</span>
      </span>
    );
  }
  return rate;
}

/** Redacta la nota de descuento por volumen del plan elegible. */
function describeVolumeNote(quote: PlanQuote): string | null {
  if (!quote.volumeDiscountEligible) {
    return null;
  }
  if (quote.appliedDiscountPercentage > 0) {
    return `Descuento: ${quote.appliedDiscountPercentage}% sobre ${formatMinutesEsMx(quote.overageMinutes)} min extra.`;
  }
  return 'Activa descuento a partir de 1,000 min extra.';
}

export interface WhopPlanComparisonCardsProps {
  readonly quotes: readonly PlanQuote[];
  readonly monthlyMinutes: number;
  readonly isLoading?: boolean;
  readonly isDegraded?: boolean;
}

export function WhopPlanComparisonCards({
  quotes,
  monthlyMinutes,
  isLoading = false,
  isDegraded = false,
}: WhopPlanComparisonCardsProps): ReactElement {
  const [activeIndex, setActiveIndex] = useState(0);
  const carouselRef = useRef<HTMLDivElement | null>(null);

  const scrollAmount = 215;

  const handlePrev = (): void => {
    if (carouselRef.current) {
      carouselRef.current.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
    }
  };

  const handleNext = (): void => {
    if (carouselRef.current) {
      carouselRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const container = event.currentTarget;
    const card = container.firstElementChild as HTMLElement | null;
    const cardWidth = (card?.getBoundingClientRect().width ?? 200) + 12;
    const index = Math.min(quotes.length - 1, Math.max(0, Math.round(container.scrollLeft / cardWidth)));
    if (index !== activeIndex) {
      setActiveIndex(index);
    }
  };

  const handleDotClick = (index: number): void => {
    setActiveIndex(index);
    const container = carouselRef.current;
    if (container) {
      const targetChild = container.children[index] as HTMLElement | undefined;
      targetChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };

  return (
    <section className="relative flex flex-col justify-between h-full" data-purpose="plans-carousel-section">
      {/* Barra de cabecera compacta con flechas interactivas */}
      <div className="flex items-center justify-between mb-2 px-1">
        <p className="text-[11px] text-[#4d727a] italic">
          {isLoading
            ? 'Sincronizando tarifas...'
            : isDegraded
            ? 'Precios con respaldo operativo.'
            : 'Planes disponibles por minuto'}
        </p>
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            aria-label="Anterior"
            onClick={handlePrev}
            className="w-6 h-6 rounded-full border border-[#b2dcd5] bg-white hover:bg-gray-100 flex items-center justify-center text-[#0f2f38] shadow-xs transition active:scale-90 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Siguiente"
            onClick={handleNext}
            className="w-6 h-6 rounded-full border border-[#b2dcd5] bg-white hover:bg-gray-100 flex items-center justify-center text-[#0f2f38] shadow-xs transition active:scale-90 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Pista deslizable con "cuadraditos pequeñitos" */}
      <div
        ref={carouselRef}
        onScroll={handleScroll}
        className="flex gap-2.5 overflow-x-auto no-scrollbar scroll-smooth snap-x snap-mandatory py-1 px-1"
        data-purpose="plans-carousel-track"
      >
        {quotes.map((quote) => {
          const isPayg = quote.planCode === 'PAYG';
          const isRecommended = quote.isRecommended;
          const volumeNote = describeVolumeNote(quote);

          return (
            <article
              key={quote.planCode}
              data-purpose={isRecommended ? 'pricing-card-recommended' : 'pricing-card'}
              className={`min-w-[155px] sm:min-w-[200px] max-w-[210px] snap-start flex-shrink-0 rounded-xl p-3 flex flex-col justify-between transition-all ${
                isRecommended
                  ? 'bg-white border-2 border-[#7b4df2] ring-2 ring-purple-100/70 shadow-sm relative'
                  : 'bg-white/90 border border-[#bce2dc] shadow-xs'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-1 mb-1">
                  <h3 className="text-xs font-bold text-[#0f2f38] truncate">{quote.displayName}</h3>
                  {isRecommended && (
                    <span className="inline-block border border-[#8fe0d5] bg-[#edf8f6] text-[#0d5c58] text-[8px] font-bold px-1.5 py-0.2 rounded uppercase shrink-0">
                      Top
                    </span>
                  )}
                </div>

                <div className="my-1.5">
                  <span className="text-xl font-extrabold text-[#0f2f38]">
                    {isPayg
                      ? formatUsdRate(quote.effectiveRatePerMinuteUsd)
                      : formatUsd(quote.monthlyFixedPriceUsd)}
                  </span>
                  <span className="text-[9px] uppercase font-bold text-gray-400 tracking-wider inline-block ml-1">
                    {isPayg ? '/ min' : '/ mes'}
                  </span>
                </div>

                <div className="space-y-1 text-[10px] border-t border-gray-100 pt-1.5">
                  <div className="flex justify-between items-center text-[#41626a]">
                    <span className="text-[9px] uppercase font-semibold text-gray-500">Minutos</span>
                    <span className="font-bold text-[#0f2f38]">
                      {isPayg ? 'Por uso' : `${formatMinutesEsMx(quote.includedMinutes)} min`}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[#41626a]">
                    <span className="text-[9px] uppercase font-semibold text-gray-500">Extra</span>
                    <span className="font-bold text-[#0f2f38]">{describeEffectiveRate(quote)}</span>
                  </div>
                  <div className="flex justify-between items-center text-[#41626a] pt-1 border-t border-slate-100">
                    <span className="text-[9px] uppercase font-bold text-gray-600">Total est.</span>
                    <span className="font-extrabold text-[#0f2f38] text-xs">
                      {formatUsd(quote.estimatedMonthlyTotalUsd)}
                    </span>
                  </div>
                </div>

                {volumeNote && (
                  <div className="mt-2 p-1.5 bg-[#f6fcfb] border border-[#d2ece7] rounded text-[9px] text-[#41626a] leading-tight">
                    {volumeNote}
                  </div>
                )}
              </div>

              <div className="mt-3 pt-1">
                <a
                  href={buildRegistrationHref(quote.planCode, monthlyMinutes)}
                  className={`w-full py-1.5 px-2 block text-center text-[11px] font-semibold transition active:scale-[0.98] cursor-pointer ${
                    isRecommended
                      ? 'bg-[#7b4df2] hover:bg-[#6a3be0] text-white rounded-lg shadow-xs'
                      : 'border border-[#c4e6e1] rounded-lg text-[#0f2f38] hover:bg-white bg-white/70'
                  }`}
                >
                  {isPayg ? 'Comenzar' : 'Suscribirse'}
                </a>
              </div>
            </article>
          );
        })}
      </div>

      {/* Paginación con micro-dots en pantallas reducidas */}
      <div
        className="flex md:hidden justify-center items-center gap-1 mt-2"
        data-purpose="carousel-pagination"
        role="tablist"
        aria-label="Indicadores de planes"
      >
        {quotes.map((quote, idx) => (
          <button
            key={quote.planCode}
            type="button"
            onClick={() => handleDotClick(idx)}
            className="w-4 h-4 flex items-center justify-center p-0.5 bg-transparent border-0 cursor-pointer"
            aria-label={`Ver plan ${quote.displayName}`}
            aria-selected={activeIndex === idx}
            role="tab"
          >
            <span
              className={`rounded-full transition-all duration-300 ${
                activeIndex === idx ? 'w-2 h-2 bg-[#7b4df2]' : 'w-1.5 h-1.5 bg-slate-300'
              }`}
            />
          </button>
        ))}
      </div>
    </section>
  );
}
