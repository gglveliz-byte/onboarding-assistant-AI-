/**
 * @archivo apps/web/src/components/landing/hero/BioluminescentVoiceDomSphere.tsx
 * @modulo 12. Landing Publica Comercial: Hero (Subagente B - Reducción de Escala y Elegancia)
 * @proposito
 *   Esfera Acústica Bioluminiscente del hero sobre Canvas 2D a 60 FPS: recalibrada con radio
 *   base y empaquetado armónicos para altura compacta de 320px - 380px sin desborde ni pixelado.
 *   Proyecta las 420 partículas (tamaño 1.3px - 5.1px y alfa según z, glow radial en sprites
 *   pre-renderizados 64x64 con suavizado de alta calidad, cero `shadowBlur`), traza los 4 vectores
 *   cinéticos punteados hacia las anclas `[data-oa-id]`, agrupa sinapsis capilares en 2 paths
 *   consolidados (purplePaths y tealPaths con umbral maxDistance adaptado al radio) para 60 FPS
 *   estables, rotula etiquetas técnicas solo cuando ancho >= 440px y gestiona touch-action: pan-y
 *   con pointerleave/pointercancel para evitar congelamientos táctiles.
 * @resumen_contenido
 *   - `BioluminescentVoiceDomSphereProps`: `className`, `energyLevel` (espectro externo
 *     0..1; sin él, respiración idle) y `active` (eleva glow y velocidad de deriva).
 *   - `merge`, `hexToRgba` y `createGlowSprite`: utilidades de clases y sprites de glow radial 64x64.
 *   - `drawAnchorFlows`, `drawParticles`, `drawLabels` y `paintScene`: fotograma completo.
 *   - `drawSynapses`: trazado de alta frecuencia con 2 llamadas `stroke()` mediante Path2D.
 *   - `BioluminescentVoiceDomSphere()`: rAF con delta real, `devicePixelRatio` limitado a
 *     2, `ResizeObserver`, listeners `pointerleave`/`pointercancel`, pausa por
 *     `IntersectionObserver` y `visibilitychange`, y limpieza total al desmontar.
 * @dependencias_internas
 *   - `./useAcousticSpherePhysics` (física, handle y `resolveDomAnchorPositions`).
 * @dependencias_externas
 *   - Solo `react`. Cero librerías 3D: Canvas 2D puro.
 * @tablas_bd_o_redis
 *   - Ninguna (presentación pura en el navegador).
 */

'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import {
  resolveDomAnchorPositions,
  useAcousticSpherePhysics,
  type AcousticAnchorFlow,
  type AcousticParticleState,
  type AcousticSpherePhysicsHandle,
  type SphereAnchor,
} from './useAcousticSpherePhysics';

/** Lienzo primario del hero (Lagoon Mist Canvas), fotograma nominal y delta maximo. */
const CANVAS_BACKGROUND = '#F2FBF9';
const NOMINAL_FRAME_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = 64;
/** `devicePixelRatio` limitado a 2 para no quemar GPU en pantallas de densidad 3x. */
const MAX_DEVICE_PIXEL_RATIO = 2;
/** Etiquetas tecnicas: Matter 500 a 11px, tinta #23534F al 70% y 3 nodos rotulados. */
const LABEL_FONT = '500 11px Matter, Inter, "DM Sans", ui-sans-serif, system-ui, sans-serif';
const LABEL_COLOR = 'rgba(35, 83, 79, 0.7)';
const LABEL_NODE_LIMIT = 3;
/** Vectores cineticos: trazo capilar teal, cabeza orquidea y guionado [5, 7]. */
const FLOW_LINE_COLOR = 'rgba(0, 130, 124, 0.3)';
const FLOW_HEAD_COLOR = 'rgba(122, 40, 203, 0.75)';
const FLOW_ANCHOR_COLOR = 'rgba(0, 130, 124, 0.6)';
/** Sprite de glow radial pre-renderizado por tinte (nucleo nitido + halo suave). */
const GLOW_SPRITE_SIZE = 64;

/** Propiedades de la esfera acustica interactiva del hero comercial. */
export interface BioluminescentVoiceDomSphereProps {
  readonly className?: string;
  readonly energyLevel?: number;
  readonly active?: boolean;
}

/** Une fragmentos de clase descartando los ausentes o vacios. */
function merge(...fragments: ReadonlyArray<string | undefined>): string {
  return fragments.filter((fragment): fragment is string => typeof fragment === 'string' && fragment.length > 0).join(' ');
}

/** Convierte `#RRGGBB` a `rgba(...)`; si el hex es invalido cae al teal bioluminiscente. */
function hexToRgba(hex: string, alpha: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) return `rgba(0, 130, 124, ${alpha})`;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Pre-renderiza el glow radial suave de un tinte con tres paradas de gradiente. */
function createGlowSprite(tint: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = GLOW_SPRITE_SIZE;
  sprite.height = GLOW_SPRITE_SIZE;
  const ctx = sprite.getContext('2d');
  if (ctx === null) return sprite;
  const half = GLOW_SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, hexToRgba(tint, 1));
  gradient.addColorStop(0.22, hexToRgba(tint, 0.6));
  gradient.addColorStop(1, hexToRgba(tint, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
  return sprite;
}

/** Traza los 4 vectores cineticos: curva punteada, cabeza viva y punto de ancla. */
function drawAnchorFlows(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  anchors: readonly SphereAnchor[],
  flows: readonly AcousticAnchorFlow[],
): void {
  const centerX = width / 2;
  const centerY = height / 2;
  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index];
    const anchor = anchors[index];
    if (flow === undefined || anchor === undefined) continue;
    const targetX = anchor.xNorm * width;
    const targetY = anchor.yNorm * height;
    const deltaX = targetX - centerX;
    const deltaY = targetY - centerY;
    const distance = Math.hypot(deltaX, deltaY) || 1;
    const bend = distance * (0.1 + flow.offsetJitter * 0.16);
    const controlX = centerX + deltaX * 0.5 - (deltaY / distance) * bend;
    const controlY = centerY + deltaY * 0.5 + (deltaX / distance) * bend;
    ctx.strokeStyle = FLOW_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -flow.progress * 20;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.quadraticCurveTo(controlX, controlY, targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    const inverse = 1 - flow.progress;
    const headX = centerX + 2 * inverse * flow.progress * (controlX - centerX) + flow.progress * flow.progress * (targetX - centerX);
    const headY = centerY + 2 * inverse * flow.progress * (controlY - centerY) + flow.progress * flow.progress * (targetY - centerY);
    ctx.globalAlpha = Math.sin(Math.PI * flow.progress);
    ctx.fillStyle = FLOW_HEAD_COLOR;
    ctx.beginPath();
    ctx.arc(headX, headY, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = anchor.isResolved ? 0.85 : 0.45;
    ctx.fillStyle = FLOW_ANCHOR_COLOR;
    ctx.beginPath();
    ctx.arc(targetX, targetY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Pinta la nube con `drawImage` de sprites: tamano y alfa crecen con la profundidad. */
function drawParticles(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: readonly AcousticParticleState[],
  sprites: ReadonlyMap<string, HTMLCanvasElement>,
  sphereRadius: number,
  active: boolean,
): void {
  const centerX = width / 2;
  const centerY = height / 2;
  const glowScale = active ? 1.18 : 1;
  for (const particle of particles) {
    const sprite = sprites.get(particle.tint);
    if (sprite === undefined) continue;
    const screenX = centerX + particle.x * sphereRadius;
    const screenY = centerY + particle.y * sphereRadius;
    if (screenX < -20 || screenX > width + 20 || screenY < -20 || screenY > height + 20) continue;
    const depth = (particle.z + 1) / 2;
    const radius = (1.3 + 3.8 * depth) * particle.weight * glowScale;
    ctx.globalAlpha = Math.min(1, (0.18 + 0.52 * depth) * particle.weight * glowScale);
    ctx.drawImage(sprite, screenX - radius, screenY - radius, radius * 2, radius * 2);
  }
  ctx.globalAlpha = 1;
}

/** Pinta 3 etiquetas con coordenadas en vivo `(x: 0.64, y: 0.28)` junto a su nodo si width >= 440px. */
function drawLabels(ctx: CanvasRenderingContext2D, width: number, height: number, anchors: readonly SphereAnchor[]): void {
  if (width < 440) return;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = LABEL_COLOR;
  const visibleNodes = Math.min(LABEL_NODE_LIMIT, anchors.length);
  for (let index = 0; index < visibleNodes; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined) continue;
    const text = `[data-oa-id="${anchor.id}"] · (x: ${anchor.xNorm.toFixed(2)}, y: ${anchor.yNorm.toFixed(2)})`;
    const textWidth = ctx.measureText(text).width;
    let labelX = anchor.xNorm * width + 12;
    if (labelX + textWidth > width - 10) labelX = anchor.xNorm * width - 12 - textWidth;
    labelX = Math.min(Math.max(labelX, 10), Math.max(10, width - textWidth - 10));
    ctx.fillText(text, labelX, Math.min(Math.max(anchor.yNorm * height - 10, 16), Math.max(16, height - 12)));
  }
}

/** Dibuja sinapsis bioluminiscentes reactivas entre nodos cercanos agrupadas en 2 paths para 60 FPS estables. */
function drawSynapses(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: readonly AcousticParticleState[],
  sphereRadius: number,
  scrollProgress: number,
): void {
  if (scrollProgress > 0.35) return;
  const brainWeight = Math.max(0, 1 - scrollProgress / 0.35);
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.min(30, sphereRadius * 0.24);
  const step = 4;

  const purplePaths = new Path2D();
  const tealPaths = new Path2D();
  let hasPurple = false;
  let hasTeal = false;

  for (let i = 0; i < particles.length; i += step) {
    const p1 = particles[i];
    if (p1 === undefined) continue;
    const x1 = centerX + p1.x * sphereRadius;
    const y1 = centerY + p1.y * sphereRadius;
    if (x1 < 0 || x1 > width || y1 < 0 || y1 > height) continue;

    for (let j = i + 1; j < Math.min(i + 14, particles.length); j += 1) {
      const p2 = particles[j];
      if (p2 === undefined) continue;
      const x2 = centerX + p2.x * sphereRadius;
      const y2 = centerY + p2.y * sphereRadius;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.hypot(dx, dy);
      if (dist < maxDistance) {
        if (j % 3 === 0) {
          purplePaths.moveTo(x1, y1);
          purplePaths.lineTo(x2, y2);
          hasPurple = true;
        } else {
          tealPaths.moveTo(x1, y1);
          tealPaths.lineTo(x2, y2);
          hasTeal = true;
        }
      }
    }
  }

  ctx.lineWidth = 0.75;
  const alpha = Math.min(0.35, 0.4 * brainWeight);
  if (hasPurple) {
    ctx.strokeStyle = `rgba(122, 40, 203, ${alpha})`;
    ctx.stroke(purplePaths);
  }
  if (hasTeal) {
    ctx.strokeStyle = `rgba(0, 184, 176, ${alpha})`;
    ctx.stroke(tealPaths);
  }
}

/** Pinta un fotograma completo: fondo, aura central, vectores, sinapsis, particulas y etiquetas. */
function paintScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sphere: AcousticSpherePhysicsHandle,
  sprites: ReadonlyMap<string, HTMLCanvasElement>,
  anchors: readonly SphereAnchor[],
  active: boolean,
): void {
  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const sphereRadius = Math.min(width, height) * 0.35 * (0.88 + 0.12 * sphere.energy);
  const auraRadius = sphereRadius * 1.25;
  const aura = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, auraRadius);
  aura.addColorStop(0, active ? 'rgba(0, 184, 176, 0.14)' : 'rgba(0, 184, 176, 0.08)');
  aura.addColorStop(1, 'rgba(242, 251, 249, 0)');
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, width, height);
  drawAnchorFlows(ctx, width, height, anchors, sphere.anchorFlows);
  drawSynapses(ctx, width, height, sphere.particles, sphereRadius, sphere.scrollProgress);
  drawParticles(ctx, width, height, sphere.particles, sprites, sphereRadius, active);
  drawLabels(ctx, width, height, anchors);
}

/**
 * Esfera acustica del hero: lienzo a pantalla completa de su contenedor, paralaje de
 * cursor via `pointermove`, reset al salir con `pointerleave`/`pointercancel`, soporte
 * táctil no bloqueante con `touch-action: pan-y` y pausa fuera del viewport o con pestana oculta.
 */
export function BioluminescentVoiceDomSphere(props: BioluminescentVoiceDomSphereProps): ReactElement {
  const { className, energyLevel, active = false } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const sphere = useAcousticSpherePhysics(energyLevel === undefined ? undefined : { energyLevel });

  useEffect(() => {
    activeRef.current = active;
    sphere.setActive(active);
  }, [sphere, active]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const sprites = new Map<string, HTMLCanvasElement>();
    for (const particle of sphere.particles) {
      if (!sprites.has(particle.tint)) sprites.set(particle.tint, createGlowSprite(particle.tint));
    }
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;
    let width = 1;
    let height = 1;
    let rafId = 0;
    let lastTime = 0;
    let visible = true;

    const paint = (anchors: readonly SphereAnchor[]) => {
      paintScene(ctx, width, height, sphere, sprites, anchors, activeRef.current);
    };
    const paintStatic = () => {
      sphere.step(NOMINAL_FRAME_MS);
      paint(resolveDomAnchorPositions());
    };
    const resizeCanvas = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    };

    const frame = (timeMs: number) => {
      rafId = 0;
      const delta = lastTime === 0 ? NOMINAL_FRAME_MS : Math.min(timeMs - lastTime, MAX_FRAME_DELTA_MS);
      lastTime = timeMs;
      sphere.step(delta);
      paint(sphere.anchors);
      rafId = requestAnimationFrame(frame);
    };
    const start = () => {
      if (rafId !== 0 || reducedMotion || !visible || document.hidden) return;
      lastTime = 0;
      rafId = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      sphere.setCursorTarget(event.clientX / (window.innerWidth || 1), event.clientY / (window.innerHeight || 1));
    };
    const onPointerReset = () => {
      sphere.setCursorTarget(0.5, 0.5);
    };
    const onScroll = () => {
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const ratio = Math.min(1, Math.max(0, window.scrollY / maxScroll));
      sphere.setScrollProgress(ratio);
    };
    const onVisibilityChange = () => { if (document.hidden) stop(); else start(); };
    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) { stop(); paintStatic(); } else start();
    };

    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
      if (reducedMotion) paint(resolveDomAnchorPositions());
      else if (rafId === 0) paint(sphere.anchors);
    });

    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible) start();
      else stop();
    }, { threshold: 0.02 });

    resizeCanvas();
    if (reducedMotion) paintStatic();
    onScroll();
    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerReset);
    container.addEventListener('pointercancel', onPointerReset);
    container.addEventListener('pointerup', onPointerReset);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    motionQuery.addEventListener('change', onMotionPreferenceChange);
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerReset);
      container.removeEventListener('pointercancel', onPointerReset);
      container.removeEventListener('pointerup', onPointerReset);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      motionQuery.removeEventListener('change', onMotionPreferenceChange);
    };
  }, [sphere]);

  return (
    <div
      ref={containerRef}
      className={merge('relative w-full h-full touch-pan-y', className)}
      style={{ touchAction: 'pan-y' }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full touch-pan-y"
        style={{ touchAction: 'pan-y' }}
        aria-hidden="true"
      />
    </div>
  );
}
