/**
 * @archivo apps/web/src/components/landing/live-demo/DemoBioluminescentCursorOverlay.tsx
 * @modulo apps/web/src/components/landing/live-demo (demostración de voz pública de la landing)
 * @proposito
 *   Capa de puntero bioluminiscente que representa visualmente la ejecución física del
 *   asistente: un cursor vectorial con aura bioluminiscente en turquesa (#43E7DB) y violeta
 *   (#8052FF) viaja con transición suave hasta el centro del elemento objetivo, muestra la
 *   etiqueta técnica del ancla y confirma cada acuse con la pastilla `tool.execution.ack (N ms)`
 *   durante ~1.8 s.
 *
 * @resumen_contenido
 *   - `CursorOverlayHandle`: contrato congelado que consume la orquestación (Subagente 3):
 *       * `moveTo()`: viaje a coordenadas normalizadas 0..1 con etiqueta opcional.
 *       * `showAckBadge()`: pastilla de acuse con la latencia redondeada en ms.
 *       * `hide()`: oculta cursor y pastilla.
 *   - `DemoBioluminescentCursorOverlay`: capa `pointer-events-none` absoluta sobre el
 *     escenario (z-20); la visibilidad la gobierna el estado `isVisible`.
 *   - Aura bioluminiscente: gradiente radial en turquesa #43E7DB y violeta #8052FF.
 *   - Respeto de `prefers-reduced-motion`: sin transición de viaje ni pulso del halo.
 *
 * @dependencias_internas
 *   - Keyframes `oa-pulse` de `apps/web/src/styles/landing-auros-light.css` (halo).
 *
 * @dependencias_externas
 *   - Solo `react` (hooks y tipos). Cero librerías externas de animación.
 *
 * @notas
 *   - Los temporizadores de la pastilla se limpian en desmontaje y antes de cada re-disparo,
 *     de modo que dos acuses consecutivos nunca se pisan entre sí.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

/** Contrato congelado del overlay del puntero bioluminiscente. */
export interface CursorOverlayHandle {
  moveTo(xNorm: number, yNorm: number, options?: { readonly label?: string }): void;
  showAckBadge(latencyMs: number): void;
  hide(): void;
}

/** Propiedades de la capa del puntero bioluminiscente. */
export interface DemoBioluminescentCursorOverlayProps {
  readonly onOverlayReady?: (handle: CursorOverlayHandle) => void;
  readonly className?: string;
}

/** Milisegundos visibles de la pastilla de acuse antes de desvanecerse. */
const ACK_BADGE_VISIBLE_MS = 1500;

/** Milisegundos totales de la pastilla de acuse (desvanecido incluido). */
const ACK_BADGE_TOTAL_MS = 1800;

/** Estado de pantalla del cursor: posición normalizada, etiqueta y visibilidad. */
interface CursorScreenState {
  readonly isVisible: boolean;
  readonly xNorm: number;
  readonly yNorm: number;
  readonly label: string | null;
}

/** Estado de la pastilla de acuse: texto exacto y fase de desvanecido. */
interface AckBadgeState {
  readonly text: string;
  readonly isFading: boolean;
}

/** Estado inicial: cursor oculto en una posición central razonable del escenario. */
const CURSOR_INITIAL_STATE: CursorScreenState = { isVisible: false, xNorm: 0.5, yNorm: 0.45, label: null };

/** Limita un valor al rango 0..1. */
function limitar01(valor: number): number {
  return Math.min(1, Math.max(0, valor));
}

/** Escucha `prefers-reduced-motion` en vivo para desactivar el viaje animado. */
function usePrefersReducedMotion(): boolean {
  const [isReduced, setIsReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const actualizar = (): void => setIsReduced(media.matches);
    actualizar();
    media.addEventListener('change', actualizar);
    return () => media.removeEventListener('change', actualizar);
  }, []);
  return isReduced;
}

/** Capa absoluta con el cursor vectorial bioluminiscente y su pastilla de acuse. */
export function DemoBioluminescentCursorOverlay(props: DemoBioluminescentCursorOverlayProps): ReactElement {
  const { onOverlayReady, className } = props;
  const [screen, setScreen] = useState<CursorScreenState>(CURSOR_INITIAL_STATE);
  const [ackBadge, setAckBadge] = useState<AckBadgeState | null>(null);
  const readyCallbackRef = useRef<((handle: CursorOverlayHandle) => void) | undefined>(onOverlayReady);
  const timersRef = useRef<number[]>([]);
  const isReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    readyCallbackRef.current = onOverlayReady;
  }, [onOverlayReady]);

  useEffect(() => {
    /** Cancela todos los temporizadores vivos de la pastilla. */
    const limpiarTemporizadores = (): void => {
      for (const temporizador of timersRef.current) window.clearTimeout(temporizador);
      timersRef.current = [];
    };

    const handle: CursorOverlayHandle = {
      moveTo: (xNorm, yNorm, options): void => {
        setScreen({ isVisible: true, xNorm: limitar01(xNorm), yNorm: limitar01(yNorm), label: options?.label ?? null });
      },
      showAckBadge: (latencyMs): void => {
        limpiarTemporizadores();
        setAckBadge({ text: `tool.execution.ack (${Math.round(latencyMs)} ms)`, isFading: false });
        timersRef.current.push(window.setTimeout(() => {
          setAckBadge((actual) => (actual === null ? null : { ...actual, isFading: true }));
        }, ACK_BADGE_VISIBLE_MS));
        timersRef.current.push(window.setTimeout(() => setAckBadge(null), ACK_BADGE_TOTAL_MS));
      },
      hide: (): void => {
        limpiarTemporizadores();
        setAckBadge(null);
        setScreen((actual) => ({ ...actual, isVisible: false }));
      },
    };

    readyCallbackRef.current?.(handle);
    return limpiarTemporizadores;
  }, []);

  const viajeHaciaLaDerecha = screen.xNorm > 0.48;
  const acuseHaciaAbajo = screen.yNorm < 0.16;

  /** Capa externa: recorta el escenario y jamás captura eventos del visitante. */
  const capaStyle: CSSProperties = { position: 'absolute', inset: 0, zIndex: 20, overflow: 'hidden', pointerEvents: 'none' };
  /** Punto caliente del cursor: ancla 0x0 en porcentaje del contenedor. */
  const puntoStyle: CSSProperties = {
    position: 'absolute',
    left: `${screen.xNorm * 100}%`,
    top: `${screen.yNorm * 100}%`,
    width: 0,
    height: 0,
    opacity: screen.isVisible ? 1 : 0,
    transition: isReducedMotion ? 'opacity 160ms linear' : 'left 480ms cubic-bezier(0.22, 1, 0.36, 1), top 480ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms linear',
  };
  /** Halo bioluminiscente pulsante centrado sobre el punto caliente: aura en turquesa #43E7DB y violeta #8052FF. */
  const haloStyle: CSSProperties = {
    position: 'absolute',
    left: -28,
    top: -28,
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(67, 231, 219, 0.65) 0%, rgba(128, 82, 255, 0.38) 45%, rgba(128, 82, 255, 0) 72%)',
    animation: isReducedMotion ? 'none' : 'oa-pulse 2.4s ease-out infinite',
  };
  /** Flecha vectorial de ~18 px: relleno blanco y trazo de tinta abisal #062D2A. */
  const flechaStyle: CSSProperties = { position: 'absolute', left: 0, top: 0, display: 'block' };
  /** Micro-etiqueta técnica del ancla, flanqueando el cursor. */
  const etiquetaStyle: CSSProperties = {
    position: 'absolute',
    top: 18,
    left: viajeHaciaLaDerecha ? 'auto' : 20,
    right: viajeHaciaLaDerecha ? 20 : 'auto',
    fontSize: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    maxWidth: 'clamp(110px, 30vw, 200px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: '#245954',
    background: '#EAF7F4',
    border: '1px solid #C5E8E1',
    borderRadius: 6,
  };
  /** Pastilla de acuse: aura turquesa y violeta, radio 6 px, desvanecido de 300 ms, separada verticalmente de la etiqueta. */
  const acuseStyle: CSSProperties = {
    position: 'absolute',
    top: acuseHaciaAbajo ? (screen.label !== null ? 48 : 24) : -38,
    left: viajeHaciaLaDerecha ? 'auto' : 14,
    right: viajeHaciaLaDerecha ? 14 : 'auto',
    padding: '3px 9px',
    fontSize: 11,
    whiteSpace: 'nowrap',
    color: '#062D2A',
    background: 'linear-gradient(135deg, rgba(67, 231, 219, 0.22) 0%, rgba(128, 82, 255, 0.22) 100%), #FFFFFF',
    border: '1px solid #43E7DB',
    borderRadius: 6,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    opacity: ackBadge?.isFading === true ? 0 : 1,
    transition: 'opacity 300ms ease',
  };

  const mergedClassName = className === undefined || className.length === 0
    ? 'pointer-events-none absolute inset-0 z-20 overflow-hidden'
    : `pointer-events-none absolute inset-0 z-20 overflow-hidden ${className}`;

  return (
    <div className={mergedClassName} style={capaStyle} aria-hidden="true" role="presentation">
      <div style={puntoStyle}>
        <span style={haloStyle} />
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={flechaStyle} aria-hidden="true" focusable="false">
          <path
            d="M2.2 1.4 L15.6 8.9 L9.4 10.4 L6.6 16.4 Z"
            fill="#FFFFFF"
            stroke="#062D2A"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        {screen.isVisible && screen.label !== null ? (
          <span className="oa-chip" style={etiquetaStyle}>{screen.label}</span>
        ) : null}
        {screen.isVisible && ackBadge !== null ? (
          <span style={acuseStyle}>{ackBadge.text}</span>
        ) : null}
      </div>
    </div>
  );
}
