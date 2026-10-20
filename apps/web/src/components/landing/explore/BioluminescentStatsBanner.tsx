/**
 * @archivo apps/web/src/components/landing/explore/BioluminescentStatsBanner.tsx
 * @modulo 12. Landing Publica Comercial: Exploracion del producto
 * @proposito
 *   Banner "Arquitectura de alto rendimiento en produccion" de la landing: panel
 *   blanco con borde #C5E8E1 y radio de 16px sobre lienzo #F2FAF8, micro-cabecera
 *   con punto violeta #8052FF y kicker #245954, y tres metricas de produccion
 *   (latencia de barge-in, aislamiento estricto por organizacion y motor dual de
 *   voz) con punto de acento, cifra grande en negrita #062D2A y descripcion
 *   #245954, separadas por divisores capilares #D7EBE6 solo en escritorio.
 * @resumen_contenido
 *   - `ProductionStat` + `PRODUCTION_STATS`: cifra y sublabel comercial literal de
 *     cada metrica (barge-in, aislamiento y motor dual de voz).
 *   - `renderProductionStat()`: metrica con punto de acento y divisores de columna.
 *   - `BioluminescentStatsBanner()`: seccion-panel blanca con las tres metricas.
 * @dependencias_internas
 *   - `../primitives/AurosPrimitives` (UppercaseTrackedKicker).
 * @dependencias_externas
 *   - Solo `react` (tipo `ReactElement`). Sin iconotecas ni datos remotos.
 * @tablas_bd_o_redis
 *   - Ninguna (componente servidor de presentacion pura: cero hooks).
 */

import type { ReactElement } from 'react';
import { UppercaseTrackedKicker } from '../primitives/AurosPrimitives';

/** Metrica de produccion: identificador, cifra gigante y sublabel comercial literal. */
export interface ProductionStat {
  readonly id: string;
  readonly figure: string;
  readonly sublabel: string;
}

/** Las 3 metricas congeladas del banner (solo lenguaje de valor, sin proveedores). */
export const PRODUCTION_STATS: readonly ProductionStat[] = [
  {
    id: 'barge-in',
    figure: '<45ms',
    sublabel: 'Latencia de barge-in: el asistente se detiene al instante cuando el usuario interrumpe.',
  },
  {
    id: 'aislamiento-organizacion',
    figure: '100%',
    sublabel: 'Aislamiento estricto por organización y memoria RAG verificada con SHA-256.',
  },
  {
    id: 'motor-dual',
    figure: '2 Motores',
    sublabel: 'Dual AI con relevo automático entre "Voz Ultra-Rápida" y "Voz Ultra-Precisa".',
  },
];

/** Puntos de acento por columna: violeta, teal y ambar de instrumentacion. */
const STAT_ACCENT_COLORS: readonly string[] = ['#8052FF', '#00A89D', '#D97706'];

/**
 * Metrica individual: punto de acento alineado con la cifra, cifra grande en
 * #062D2A y descripcion #245954; las columnas 2 y 3 llevan divisor capilar.
 */
function renderProductionStat(stat: ProductionStat, index: number): ReactElement {
  const dividerClassName =
    index === 0
      ? ''
      : 'border-t border-[#D7EBE6] pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 lg:pl-12';
  return (
    <article key={stat.id} className={dividerClassName}>
      <div className="mb-1 flex items-baseline gap-2">
        <span
          className="h-2 w-2 self-center rounded-full shrink-0"
          style={{ backgroundColor: STAT_ACCENT_COLORS[index] ?? '#8052FF' }}
        />
        <span className="text-2xl sm:text-3xl lg:text-[42px] font-bold leading-none tracking-tight text-[#062D2A]">
          {stat.figure}
        </span>
      </div>
      <p className="mt-0.5 sm:mt-1 max-w-[280px] text-[12px] sm:text-[13px] leading-relaxed text-[#245954]">{stat.sublabel}</p>
    </article>
  );
}

/**
 * Banner de alto rendimiento: micro-cabecera de instrumentacion y tres columnas
 * con cifras de produccion sobre panel blanco de radio 16px.
 */
export function BioluminescentStatsBanner(): ReactElement {
  return (
    <div className="px-4 pt-1 pb-3 sm:px-6 sm:pt-2 sm:pb-4 lg:px-8 w-full">
      <div className="mx-auto max-w-7xl w-full">
        <section
          aria-label="Arquitectura de alto rendimiento en producción"
          className="w-full rounded-2xl border border-[#C5E8E1] bg-white p-4 sm:p-8 lg:p-10 shadow-glass"
        >
          <div className="mb-3 sm:mb-8 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#8052FF]" />
            <UppercaseTrackedKicker className="!text-[10px] sm:!text-[11px] !font-bold !tracking-[0.16em] sm:!tracking-[0.2em] !text-[#245954]">
              ALTO RENDIMIENTO EN PRODUCCIÓN
            </UppercaseTrackedKicker>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 sm:gap-8 lg:gap-12">
            {PRODUCTION_STATS.map(renderProductionStat)}
          </div>
        </section>
      </div>
    </div>
  );
}
