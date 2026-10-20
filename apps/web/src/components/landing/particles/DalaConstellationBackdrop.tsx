/**
 * @archivo apps/web/src/components/landing/particles/DalaConstellationBackdrop.tsx
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — lienzo vivo)
 * @proposito
 *   Fondo decorativo de pantalla completa de la Landing Comercial: lienzo fijo tras el contenido
 *   que dibuja ~3.000 microtriángulos wireframe (1.500 en móvil) en tres esculturas 3D que mutan
 *   con el scroll real de la página (0 → Cerebro anatómico anclado a la zona derecha del hero,
 *   0.5 → Red de nodos y conectores, 1 → Planeta Tierra cartográfico), con glifos ambientales de
 *   polvo estelar, paralaje de cursor con repulsión elástica y pintura por lotes cromáticos.
 *   Sin botones ni indicadores: el morphing lo gobierna exclusivamente el scroll del documento.
 *
 * @resumen_contenido
 *   - `DalaConstellationBackdropProps`: `className` opcional para composición.
 *   - `DalaConstellationBackdrop`: monta el canvas `fixed inset-0 z-0` (aria-hidden, sensor-ciego)
 *     sobre el lienzo `#f2fbf9` del portal Auros Light; delega la pintura en el compositor por
 *     lotes (`dala-constellation-render`) y aquí viven el ciclo de vida, el DPR acotado por
 *     presupuesto de píxeles, el gobernador de cadencia adaptativo (fotogramas alternos cuando
 *     la máquina sufre), el suavizado exponencial por tiempo del scroll, la velocidad elástica
 *     y `prefers-reduced-motion` (fotograma estático redibujado con scroll).
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (densidades, presupuesto de píxeles y tipos).
 *   - `./dala-constellation-sculptures` (`buildConstellation`).
 *   - `./dala-constellation-render` (compositor por fotograma).
 *   - `./dala-constellation-render-state` (estado persistente del compositor).
 *
 * @dependencias_externas
 *   - `react` (`useEffect`, `useRef`, tipo `ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (capa de presentación pura: no accede a datos).
 */

'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import {
  COMPACT_GLYPH_COUNT,
  COMPACT_NODE_COUNT,
  COMPACT_VIEWPORT_BREAKPOINT,
  DESKTOP_GLYPH_COUNT,
  DESKTOP_NODE_COUNT,
  MAX_CANVAS_PIXELS,
  MAX_DEVICE_PIXEL_RATIO,
  MIN_DEVICE_PIXEL_RATIO,
  STATIC_MOTION_TIME,
  type PointerState,
} from './dala-constellation-geometry';
import { buildConstellation } from './dala-constellation-sculptures';
import { renderConstellationFrame } from './dala-constellation-render';
import { createConstellationRenderState } from './dala-constellation-render-state';

/** Umbrales del gobernador de cadencia (ms de coste de pintura por fotograma: 18ms da margen para 60/120 Hz). */
const STRIDE_UPGRADE_COST_MS = 18;
const STRIDE_DOWNGRADE_COST_MS = 10;
/** Fotogramas entre reevaluaciones del gobernador de cadencia. */
const STRIDE_DECISION_WINDOW = 45;
/** Constantes de tiempo (segundos) del suavizado exponencial: respuesta instantánea sin lag gomoso. */
const SCROLL_SMOOTHING_TAU = 0.035;
const SCROLL_VELOCITY_TAU = 0.08;
const POINTER_SMOOTHING_TAU = 0.12;

export interface DalaConstellationBackdropProps {
  /** Clases adicionales del lienzo (por defecto cubre el viewport por completo). */
  readonly className?: string;
}

/**
 * Fondo vivo de constelación Dala: canvas fijo tras el contenido de la landing cuyo morphing
 * (Cerebro → Red de nodos → Planeta Tierra) lo gobierna la posición de scroll del documento.
 *
 * @param props - `className` opcional para composición con utilidades externas.
 * @returns Lienzo decorativo `fixed inset-0 z-0` con `aria-hidden` y `pointer-events-none`.
 */
export function DalaConstellationBackdrop({ className = '' }: DalaConstellationBackdropProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext('2d', { alpha: false });
    if (context === null) {
      return;
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isCompactViewport = window.innerWidth < COMPACT_VIEWPORT_BREAKPOINT;
    const { nodes, glyphs } = buildConstellation(
      isCompactViewport ? COMPACT_NODE_COUNT : DESKTOP_NODE_COUNT,
      isCompactViewport ? COMPACT_GLYPH_COUNT : DESKTOP_GLYPH_COUNT
    );
    const renderState = createConstellationRenderState(nodes);

    let width = Math.max(1, window.innerWidth);
    let height = Math.max(1, window.innerHeight);
    let maxScroll = 1;
    let targetScroll = 0;
    let currentScroll = 0;
    let scrollVelocity = 0;
    let lastFrameMs = 0;
    let animationFrameId: number | null = null;
    let staticDrawHandle: number | null = null;
    let isPageVisible = document.hidden === false;

    // Gobernador de cadencia: si pintar el fondo se encarece, se pinta en fotogramas alternos
    // (30 fps estables) hasta que la máquina vuelva a tener holgura.
    let frameStride = 1;
    let frameTick = 0;
    let framesSinceDecision = 0;
    let smoothedRenderCostMs = 6;

    const pointer: PointerState = {
      x: width * 0.5,
      y: height * 0.5,
      normX: 0,
      normY: 0,
      smoothX: 0,
      smoothY: 0,
      active: false,
    };

    const recomputeScrollRange = (): void => {
      maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    };

    const applyCanvasSize = (): void => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      // DPR acotado por presupuesto de píxeles: en pantallas retina/4K el área pintada se mantiene sana.
      const budgetRatio = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
      const dpr = Math.max(
        MIN_DEVICE_PIXEL_RATIO,
        Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO, budgetRatio)
      );
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      recomputeScrollRange();
    };

    const readScrollTarget = (): void => {
      targetScroll = Math.max(0, Math.min(1, window.scrollY / maxScroll));
    };

    /** Pinta un fotograma y devuelve su coste en milisegundos (insumo del gobernador). */
    const paintFrame = (time: number): number => {
      const startedAt = performance.now();
      renderConstellationFrame(
        { ctx: context, width, height, time, scroll: currentScroll, scrollVelocity, nodes, glyphs, pointer },
        renderState
      );
      return performance.now() - startedAt;
    };

    /** Fotograma estático (modo movimiento reducido): solo se redibuja cuando hay scroll o resize. */
    const scheduleStaticFrame = (): void => {
      if (staticDrawHandle !== null) {
        return;
      }
      staticDrawHandle = window.requestAnimationFrame(() => {
        staticDrawHandle = null;
        readScrollTarget();
        currentScroll = targetScroll;
        paintFrame(STATIC_MOTION_TIME);
      });
    };

    applyCanvasSize();
    readScrollTarget();
    currentScroll = targetScroll;

    const motionStartTime = performance.now();

    const animate = (now: number): void => {
      animationFrameId = window.requestAnimationFrame(animate);
      if (!isPageVisible) {
        lastFrameMs = now;
        return;
      }
      // Suavizado exponencial por tiempo: 60 Hz y 120 Hz se sienten idénticos y el morphing
      // arranca con el primer gesto del scroll (sin zona muerta).
      const deltaSeconds = lastFrameMs === 0 ? 1 / 60 : Math.min(0.05, Math.max(0.001, (now - lastFrameMs) / 1000));
      lastFrameMs = now;

      readScrollTarget();
      const previousScroll = currentScroll;
      const scrollAlpha = 1 - Math.exp(-deltaSeconds / SCROLL_SMOOTHING_TAU);
      currentScroll += (targetScroll - currentScroll) * scrollAlpha;
      if (Math.abs(targetScroll - currentScroll) < 0.0005) {
        currentScroll = targetScroll;
      }

      // Velocidad de scroll suavizada: alimenta la deriva elástica del compositor.
      const instantVelocity = (currentScroll - previousScroll) / deltaSeconds;
      scrollVelocity += (instantVelocity - scrollVelocity) * (1 - Math.exp(-deltaSeconds / SCROLL_VELOCITY_TAU));

      const pointerAlpha = 1 - Math.exp(-deltaSeconds / POINTER_SMOOTHING_TAU);
      pointer.smoothX += (pointer.normX - pointer.smoothX) * pointerAlpha;
      pointer.smoothY += (pointer.normY - pointer.smoothY) * pointerAlpha;

      frameTick += 1;
      if (frameStride > 1 && frameTick % frameStride !== 0) {
        return;
      }

      const costMs = paintFrame((now - motionStartTime) * 0.001);
      smoothedRenderCostMs += (costMs - smoothedRenderCostMs) * 0.1;
      framesSinceDecision += 1;
      if (framesSinceDecision >= STRIDE_DECISION_WINDOW) {
        framesSinceDecision = 0;
        if (frameStride === 1 && smoothedRenderCostMs > STRIDE_UPGRADE_COST_MS) {
          frameStride = 2;
        } else if (frameStride === 2 && smoothedRenderCostMs < STRIDE_DOWNGRADE_COST_MS) {
          frameStride = 1;
        }
      }
    };

    if (prefersReducedMotion) {
      window.addEventListener('scroll', scheduleStaticFrame, { passive: true });
      paintFrame(STATIC_MOTION_TIME);
    } else {
      // Listener pasivo de scroll para capturar el valor más reciente antes del paint
      window.addEventListener('scroll', readScrollTarget, { passive: true });
      paintFrame(0);
      animationFrameId = window.requestAnimationFrame(animate);
    }

    const handleResize = (): void => {
      applyCanvasSize();
      if (prefersReducedMotion) {
        scheduleStaticFrame();
      }
    };

    const handlePointerMove = (event: PointerEvent): void => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.normX = (event.clientX / Math.max(1, width)) * 2 - 1;
      pointer.normY = (event.clientY / Math.max(1, height)) * 2 - 1;
      pointer.active = true;
    };

    const handlePointerLeave = (): void => {
      pointer.active = false;
      pointer.normX = 0;
      pointer.normY = 0;
    };

    const handleVisibilityChange = (): void => {
      isPageVisible = document.hidden === false;
      if (isPageVisible && prefersReducedMotion) {
        scheduleStaticFrame();
      }
    };

    // La altura útil de la página puede cambiar (fuentes, contenido diferido): re-medir el rango.
    const scrollRangeObserver = new ResizeObserver(recomputeScrollRange);
    scrollRangeObserver.observe(document.documentElement);

    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      if (staticDrawHandle !== null) {
        window.cancelAnimationFrame(staticDrawHandle);
      }
      scrollRangeObserver.disconnect();
      window.removeEventListener('scroll', scheduleStaticFrame);
      window.removeEventListener('scroll', readScrollTarget);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-purpose="landing-constellation-backdrop"
      style={{ willChange: 'transform', transform: 'translateZ(0)' }}
      className={`pointer-events-none fixed inset-0 z-0 h-full w-full select-none ${className}`.trim()}
    />
  );
}
