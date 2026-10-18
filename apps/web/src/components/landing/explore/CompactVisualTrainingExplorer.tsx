/**
 * @archivo apps/web/src/components/landing/explore/CompactVisualTrainingExplorer.tsx
 * @modulo 12. Landing Publica Comercial: Exploracion del producto
 * @proposito
 *   Explorador compacto interactivo (< lg) de la seccion "Entrenamiento Visual &
 *   Memoria RAG": panel superior de detalle dinamico con barra de acento degradada
 *   y boton de cierre, tres pastillas funcionales a la izquierda (navegacion real,
 *   memoria RAG y guardrails), el grafo molecular compacto al centro y tres
 *   metricas de produccion a la derecha (barge-in, aislamiento y motores duales).
 *   Cada nodo o metrica se puede tocar para actualizar el panel con revelado breve
 *   (`oa-quick-fade`), marcando la pastilla activa con `aria-pressed`, borde
 *   violeta y punto pulsante (`oa-chip-pulse`), y restaurando el panel con un
 *   boton explicito de recuperacion accesible.
 * @resumen_contenido
 *   - `VisualTrainingDetailKey` + `VisualTrainingDetail`: contrato del contenido.
 *   - `VISUAL_TRAINING_DETAILS`: contenido congelado del panel (7 lecturas reales:
 *     navegacion, doble lectura RAG, guardrails, grafo, barge-in, aislamiento y
 *     motores duales, sin fuga de infraestructura).
 *   - `COMPACT_LEFT_CHIPS` + `COMPACT_RIGHT_CHIPS`: pastillas interactivas con
 *     acentos de la paleta Auros Light (#8052FF, #15846E, #43E7DB, #72B7FF).
 *   - `renderChip()`: pastilla reutilizable con titular, meta y punto de estado.
 *   - `CompactVisualTrainingExplorer()`: grilla `[1fr_auto_1fr]` con figura
 *     central (grafo + leyenda) y CTA oscuro hacia el alta de cuenta.
 * @dependencias_internas
 *   - `./VisualTrainingMolecularGraph` (`CompactMolecularGraph`).
 * @dependencias_externas
 *   - `react` ('use client', useState, useCallback y tipo ReactElement).
 * @tablas_bd_o_redis
 *   - Ninguna (componente de presentacion interactiva pura).
 */

'use client';

import { useCallback, useState, type ReactElement } from 'react';
import { CompactMolecularGraph } from './VisualTrainingMolecularGraph';

/** Claves de las siete lecturas interactivas del explorador compacto. */
export type VisualTrainingDetailKey =
  | 'nav_real'
  | 'memoria_doble'
  | 'prompt_guardrails'
  | 'grafo_core'
  | 'kpi_bargein'
  | 'kpi_seguridad'
  | 'kpi_motores';

/** Lectura del panel: badge, subetiqueta, titular y descripcion comercial real. */
export interface VisualTrainingDetail {
  readonly badge: string;
  readonly sub: string;
  readonly title: string;
  readonly description: string;
}

/** Contenido congelado de las siete lecturas (cero fuga de infraestructura). */
export const VISUAL_TRAINING_DETAILS: Readonly<Record<VisualTrainingDetailKey, VisualTrainingDetail>> = {
  nav_real: {
    badge: 'NAVEGACIÓN AUTÓNOMA',
    sub: 'APRENDIZAJE REAL',
    title: 'Aprendizaje por navegación real',
    description:
      'El asistente aprende tu interfaz navegándola de verdad: cada elemento queda etiquetado por función, no por capturas estáticas ni aproximaciones visuales.',
  },
  memoria_doble: {
    badge: 'MEMORIA RAG SHA-256',
    sub: 'DOBLE CAPA',
    title: 'Una memoria, dos lecturas',
    description:
      'Cada mapa funcional vive en dos capas —visual para humanos y JSON canónico sellado con SHA-256 para ejecución determinista sin alucinaciones.',
  },
  prompt_guardrails: {
    badge: 'ESTUDIO DEL PROMPT',
    sub: 'GUARDRAILS',
    title: 'Del recorrido a la instrucción',
    description:
      'Convierte un recorrido real en instrucciones claras con pasos funcionales exactos y guardrails de seguridad activos, sin necesidad de escribir código.',
  },
  grafo_core: {
    badge: 'MOTOR GRAFO RAG',
    sub: 'TOPOLOGÍA MOLECULAR',
    title: 'Red molecular indexada',
    description:
      'Documentos, vistas y acciones conectados en un grafo semántico protegido por hashes inmutables, con la acción precisa siempre a un paso de voz.',
  },
  kpi_bargein: {
    badge: 'LATENCIA ULTRA-BAJA',
    sub: 'TIEMPO REAL',
    title: 'Barge-in instantáneo <45ms',
    description:
      'El asistente detiene el sintetizador al instante exacto en que el usuario habla o interrumpe, garantizando conversación natural fluida sin tropiezos.',
  },
  kpi_seguridad: {
    badge: 'CRIPTOGRAFÍA ACTIVA',
    sub: 'GARANTÍA 100%',
    title: '100% Aislamiento estricto',
    description:
      'Espacios de datos separados criptográficamente por organización con sellado SHA-256 e inmutabilidad garantizada contra cualquier alteración.',
  },
  kpi_motores: {
    badge: 'DUAL AI ACTIVO',
    sub: 'RELEVO HÍBRIDO',
    title: '2 Motores con relevo inteligente',
    description:
      'Alternancia automatizada entre "Voz Ultra-Rápida" para fluidez cotidiana y "Voz Ultra-Precisa" para ejecuciones críticas y comandos complejos.',
  },
};

/** Pastilla interactiva: clave, etiquetas, acentos y meta inferior. */
interface CompactStoryChip {
  readonly key: VisualTrainingDetailKey;
  readonly eyebrow: string;
  readonly eyebrowClassName: string;
  readonly title: string;
  readonly titleClassName: string;
  readonly meta: string;
  readonly dotClassName: string;
}

/** Columna izquierda: navegacion real, memoria RAG y guardrails. */
const COMPACT_LEFT_CHIPS: readonly CompactStoryChip[] = [
  {
    key: 'nav_real',
    eyebrow: 'Navegación',
    eyebrowClassName: 'text-[#15846E]',
    title: 'Aprendizaje Real',
    titleClassName: 'text-[10px] font-semibold leading-tight',
    meta: 'Por función',
    dotClassName: 'bg-[#15846E]',
  },
  {
    key: 'memoria_doble',
    eyebrow: 'Memoria',
    eyebrowClassName: 'text-[#8052FF]',
    title: '2 Lecturas RAG',
    titleClassName: 'text-[10px] font-semibold leading-tight',
    meta: 'Visual + JSON',
    dotClassName: 'bg-[#8052FF]',
  },
  {
    key: 'prompt_guardrails',
    eyebrow: 'Guardrails',
    eyebrowClassName: 'text-[#547B76]',
    title: 'Recorrido Guiado',
    titleClassName: 'text-[10px] font-semibold leading-tight',
    meta: 'Sin código',
    dotClassName: 'bg-[#769792]',
  },
];

/** Columna derecha: barge-in, aislamiento estricto y motores duales. */
const COMPACT_RIGHT_CHIPS: readonly CompactStoryChip[] = [
  {
    key: 'kpi_bargein',
    eyebrow: 'Barge-in',
    eyebrowClassName: 'text-[#8052FF]',
    title: '<45ms',
    titleClassName: 'text-[13px] font-extrabold leading-none',
    meta: 'Latencia nula',
    dotClassName: 'bg-[#8052FF]',
  },
  {
    key: 'kpi_seguridad',
    eyebrow: 'Aislamiento',
    eyebrowClassName: 'text-[#15846E]',
    title: '100%',
    titleClassName: 'text-[13px] font-extrabold leading-none',
    meta: 'Org & Cripto',
    dotClassName: 'bg-[#43E7DB]',
  },
  {
    key: 'kpi_motores',
    eyebrow: 'Motores',
    eyebrowClassName: 'text-[#245954]',
    title: '2 AI',
    titleClassName: 'text-[13px] font-extrabold leading-none',
    meta: 'Rápido + Preciso',
    dotClassName: 'bg-[#72B7FF]',
  },
];

/**
 * Pastilla interactiva reutilizable: etiqueta con punto de estado, titular y meta.
 * La pastilla activa se resalta con borde violeta y punto pulsante accesible.
 */
function renderChip(
  chip: CompactStoryChip,
  activeKey: VisualTrainingDetailKey,
  onSelect: (key: VisualTrainingDetailKey) => void,
): ReactElement {
  const isActive = chip.key === activeKey;
  return (
    <button
      key={chip.key}
      type="button"
      aria-pressed={isActive}
      onClick={() => onSelect(chip.key)}
      className={`w-full cursor-pointer rounded-[6px] border p-1.5 text-left transition-all active:scale-95 ${
        isActive ? 'scale-[1.02] border-[#8052FF] bg-white' : 'border-[#C5E8E1] bg-white/95'
      }`}
    >
      <span className="mb-0.5 flex items-center justify-between">
        <span className={`font-mono text-[8px] font-bold uppercase tracking-tight ${chip.eyebrowClassName}`}>
          {chip.eyebrow}
        </span>
        <span className={`h-1.5 w-1.5 rounded-full ${chip.dotClassName} ${isActive ? 'oa-chip-pulse' : ''}`} />
      </span>
      <span className={`block text-[#062D2A] ${chip.titleClassName}`}>{chip.title}</span>
      <span className="mt-0.5 block font-mono text-[8.5px] text-[#769792]">{chip.meta}</span>
    </button>
  );
}

/**
 * Explorador compacto de la seccion de entrenamiento visual: panel dinamico,
 * tres pastillas por flanco, grafo molecular central y CTA de alta de cuenta.
 */
export function CompactVisualTrainingExplorer(): ReactElement {
  const [activeKey, setActiveKey] = useState<VisualTrainingDetailKey>('memoria_doble');
  const [isDetailVisible, setIsDetailVisible] = useState(true);

  const handleSelect = useCallback((key: VisualTrainingDetailKey): void => {
    setActiveKey(key);
    setIsDetailVisible(true);
  }, []);

  const activeDetail = VISUAL_TRAINING_DETAILS[activeKey];

  return (
    <div className="mx-auto w-full max-w-md">
      <section
        aria-label="Explorador interactivo del mapa funcional RAG"
        className="relative rounded-xl sm:rounded-2xl border border-[#bfe2dd] bg-white p-3 sm:p-4 shadow-glass"
      >
        {/* Panel dinamico de detalle con barra de acento degradada */}
        <div
          aria-live="polite"
          className="relative mb-2 overflow-hidden rounded-xl border border-[#8052FF]/20 bg-[#f6fcfa] p-2.5"
          id="oa-visual-training-detail"
        >
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#15846E] to-[#8052FF]" />
          {isDetailVisible ? (
            <div key={activeKey} className="oa-quick-fade flex items-start justify-between gap-2 pl-1.5">
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="rounded border border-[#C5E8E1] bg-[#EAF7F4] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-[#15846E]">
                    {activeDetail.badge}
                  </span>
                  <span className="font-mono text-[9px] text-[#769792]">{activeDetail.sub}</span>
                </div>
                <h3 className="text-[13px] font-bold leading-tight text-[#062D2A]">{activeDetail.title}</h3>
                <p className="text-[10.5px] leading-relaxed text-[#245954]">{activeDetail.description}</p>
              </div>
              <button
                type="button"
                aria-label="Ocultar detalle"
                onClick={() => setIsDetailVisible(false)}
                className="shrink-0 cursor-pointer p-0.5 text-[#769792] transition-colors hover:text-[#062D2A]"
              >
                <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                </svg>
              </button>
            </div>
          ) : (
            <div className="pl-1.5">
              <button
                type="button"
                onClick={() => setIsDetailVisible(true)}
                className="w-full cursor-pointer rounded-[6px] border border-dashed border-[#C5E8E1] bg-white px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[#8052FF]"
              >
                Mostrar detalle
              </button>
            </div>
          )}
        </div>

        {/* Grilla de tres columnas: pastillas, grafo y metricas */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 sm:gap-2">
          <div className="flex flex-col gap-1.5">
            {COMPACT_LEFT_CHIPS.map((chip) => renderChip(chip, activeKey, handleSelect))}
          </div>

          <figure className="m-0 flex flex-col items-center justify-center">
            <button
              type="button"
              aria-label="Ver detalle del grafo molecular RAG"
              aria-pressed={activeKey === 'grafo_core'}
              onClick={() => handleSelect('grafo_core')}
              className={`relative flex h-[124px] w-[124px] cursor-pointer items-center justify-center rounded-xl border bg-white/90 p-1.5 transition-transform active:scale-95 sm:h-[142px] sm:w-[142px] ${
                activeKey === 'grafo_core' ? 'border-[#8052FF]' : 'border-[#C5E8E1]'
              }`}
            >
              <CompactMolecularGraph />
            </button>
            <figcaption className="mt-1.5 max-w-[212px] px-1 text-center font-mono text-[9px] leading-tight text-[#547B76] sm:max-w-[240px]">
              Grafo molecular del mapa RAG: documentos, vistas y acciones de tu producto conectados entre sí y
              sellados con SHA-256, con la acción correcta siempre a un paso de voz.
            </figcaption>
          </figure>

          <div className="flex flex-col gap-1.5">
            {COMPACT_RIGHT_CHIPS.map((chip) => renderChip(chip, activeKey, handleSelect))}
          </div>
        </div>

        {/* Barra de pista tactil */}
        <div className="flex items-center justify-between px-1 pt-2">
          <div className="flex items-center gap-1.5">
            <span className="oa-live-dot" />
            <span className="font-mono text-[9px] font-semibold text-[#062D2A]">MAPA FUNCIONAL INTERACTIVO</span>
          </div>
          <span className="font-mono text-[8.5px] text-[#769792]">TOCA CUALQUIER NODO O MÉTRICA</span>
        </div>

        {/* CTA integrado dentro de la tarjeta */}
        <div className="pt-3">
          <a
            href="/auth/register"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#08252d] px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 active:scale-[0.99]"
          >
            <span>Entrenar mi producto</span>
            <svg aria-hidden="true" className="h-3.5 w-3.5 text-[#43E7DB]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
            </svg>
          </a>
        </div>
      </section>
    </div>
  );
}
