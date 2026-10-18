/**
 * @archivo apps/web/src/components/landing/explore/RagDomMolecularGraphSection.tsx
 * @modulo 12. Landing Publica Comercial: Exploracion del producto
 * @proposito
 *   Seccion "Entrenamiento Visual & Memoria RAG" de la landing: encabezado
 *   editorial (kicker turquesa, titular con remate serifado en cursiva y
 *   subtitulo), rejilla de escritorio (lg:) de 12 columnas con las tres tarjetas
 *   del entrenamiento visual —puntero overlay sin capturas, memoria RAG con doble
 *   representacion sellada y estudio del prompt— frente al grafo molecular RAG en
 *   SVG, y explorador compacto interactivo (< lg) con panel de detalle dinamico.
 *   Cromatica Auros Light: lienzo #F2FAF8 con velo radial #EAF7F4, tarjetas
 *   #FFFFFF, bordes #C5E8E1, titulares #062D2A, cuerpos #245954 y acentos
 *   turquesa #43E7DB, violeta #8052FF y teal #15846E.
 * @resumen_contenido
 *   - `RagPillarCard` + `RAG_PILLAR_CARDS`: contenido literal inmutable de las 3
 *     tarjetas de exploracion (tono `lift` = tarjeta destacada con badge violeta).
 *   - `renderDesktopPillar()`: tarjeta estatica de escritorio con estado activo.
 *   - `RagDomMolecularGraphSection()`: cabecera + rejilla 5/7 de escritorio y
 *     montaje del explorador compacto en movil/tablet.
 * @dependencias_internas
 *   - `./VisualTrainingMolecularGraph` (`DesktopMolecularGraph`).
 *   - `./CompactVisualTrainingExplorer` (explorador interactivo < lg).
 *   - `../primitives/AurosPrimitives` (UppercaseTrackedKicker).
 * @dependencias_externas
 *   - Solo `react` (tipo `ReactElement`).
 * @tablas_bd_o_redis
 *   - Ninguna (componente servidor de presentacion pura: cero hooks directos).
 */

import type { ReactElement } from 'react';
import { UppercaseTrackedKicker } from '../primitives/AurosPrimitives';
import { CompactVisualTrainingExplorer } from './CompactVisualTrainingExplorer';
import { DesktopMolecularGraph } from './VisualTrainingMolecularGraph';

/** Tarjeta del entrenamiento visual: kicker, titular, parrafo y tono de superficie. */
export interface RagPillarCard {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly tone: 'kelp' | 'lift';
}

/** Contenido congelado de las 3 tarjetas de exploracion (cero fuga de infraestructura). */
export const RAG_PILLAR_CARDS: readonly RagPillarCard[] = [
  {
    kicker: 'PUNTERO OVERLAY · SIN CAPTURAS DE PANTALLA',
    title: 'Aprendizaje por navegación real',
    body: 'El asistente aprende tu interfaz navegándola de verdad: cada elemento queda etiquetado por función, no por fotos.',
    tone: 'kelp',
  },
  {
    kicker: 'MEMORIA RAG SHA-256 · DOBLE REPRESENTACIÓN',
    title: 'Una memoria, dos lecturas',
    body: 'Cada mapa funcional vive en dos capas —visual para tus desarrolladores y JSON canónico e inmutable para la máquina— selladas con SHA-256.',
    tone: 'lift',
  },
  {
    kicker: 'ESTUDIO DEL PROMPT · PASO A PASO',
    title: 'Del recorrido real a la instrucción',
    body: 'Convierte un recorrido real en instrucciones claras, extrae cada paso y añade guardrails sin escribir código.',
    tone: 'kelp',
  },
];

/**
 * Tarjeta estatica de escritorio: la tarjeta de tono `lift` se destaca como
 * estado activo con doble borde violeta, superficie blanca y badge de acento.
 */
function renderDesktopPillar(card: RagPillarCard): ReactElement {
  const isHighlighted = card.tone === 'lift';
  return (
    <article
      key={card.kicker}
      className={
        isHighlighted
          ? 'rounded-xl border-2 border-[#8052FF]/25 bg-white p-4'
          : 'group rounded-xl border border-[#C5E8E1] bg-white/60 p-4 transition-colors hover:bg-white'
      }
    >
      <div className="mb-1 inline-block">
        <span
          className={
            isHighlighted
              ? 'rounded-full bg-[#8052FF]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#8052FF]'
              : 'text-[10px] font-bold uppercase tracking-wider text-[#547B76]'
          }
        >
          {card.kicker}
        </span>
      </div>
      <h3
        className={`mb-1 text-[14px] font-semibold tracking-tight text-[#062D2A] ${
          isHighlighted ? '' : 'transition-colors group-hover:text-[#8052FF]'
        }`}
      >
        {card.title}
      </h3>
      <p className="text-[12.5px] leading-relaxed text-[#245954]">{card.body}</p>
    </article>
  );
}

/**
 * Seccion de exploracion: encabezado editorial comun, tres tarjetas frente al
 * grafo molecular RAG en escritorio y explorador compacto interactivo en movil.
 */
export function RagDomMolecularGraphSection(): ReactElement {
  return (
    <section
      aria-labelledby="oa-explore-title"
      className="bg-[radial-gradient(circle_at_20%_30%,rgba(234,247,244,0.35)_0%,rgba(242,250,248,0.08)_50%,transparent_100%)] px-4 py-5 sm:px-8 sm:py-10 lg:px-12"
    >
      <div className="mx-auto max-w-[1240px]">
        {/* Encabezado editorial de la seccion */}
        <div className="mb-3 max-w-2xl sm:mb-9">
          <UppercaseTrackedKicker className="!text-[10px] !font-bold !tracking-[0.18em] !text-[#15846E]">
            ENTRENAMIENTO VISUAL & MEMORIA RAG
          </UppercaseTrackedKicker>
          <h2
            className="mt-2 text-[22px] font-bold leading-[1.22] tracking-tight text-[#062D2A] sm:text-[27px] md:text-[30px] lg:text-[32px]"
            id="oa-explore-title"
          >
            Memoria de navegación viva,{' '}
            <span className="font-display font-normal italic">sellada con SHA-256.</span>
          </h2>
          <p className="mt-2 sm:mt-3 max-w-2xl text-[13px] sm:text-[14px] leading-relaxed text-[#245954]">
            El asistente aprende tu interfaz navegándola de verdad: cada vista y acción queda indexada en un mapa
            funcional con doble lectura humana y JSON canónico.
          </p>
        </div>

        {/* Rejilla de escritorio: tarjetas (5 columnas) frente al grafo (7 columnas) */}
        <div className="hidden items-center gap-8 lg:grid lg:grid-cols-12">
          <div className="flex flex-col gap-3 lg:col-span-5">{RAG_PILLAR_CARDS.map(renderDesktopPillar)}</div>
          <div className="flex flex-col items-center justify-center lg:col-span-7 lg:pl-4">
            <figure className="m-0 w-full">
              <DesktopMolecularGraph />
              <figcaption className="mx-auto mt-2 max-w-sm text-center text-[11px] leading-relaxed text-[#547B76]">
                Grafo molecular del mapa RAG: documentos, vistas y acciones de tu producto conectados entre sí y
                sellados con SHA-256, con la acción correcta siempre a un paso de voz.
              </figcaption>
            </figure>
          </div>
        </div>

        {/* Explorador compacto interactivo para movil y tablet (< lg) */}
        <div className="lg:hidden">
          <CompactVisualTrainingExplorer />
        </div>
      </div>
    </section>
  );
}
