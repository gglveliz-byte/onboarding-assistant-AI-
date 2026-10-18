/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-render.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — compositor por lotes)
 * @proposito
 *   Compositor por fotograma del fondo vivo de constelación: proyecta los nodos con rotaciones
 *   in situ (senos/cosenos precalculados por escultura, sin asignaciones por nodo), aplica la
 *   transformación de pantalla de la etapa (el Cerebro deriva a la zona derecha del hero, libre
 *   de texto), ordena por profundidad con conteo por rodajas (sin `sort`) y agrupa los
 *   microtriángulos en lotes cromáticos cuantizados para reducir miles de llamadas `stroke()`
 *   a unas pocas centenas por fotograma. Estado y glifos viven en módulos gemelos.
 *
 * @resumen_contenido
 *   - `ConstellationScene`: parámetros por fotograma (contexto, viewport, tiempo, scroll, nodos, glifos, puntero).
 *   - `renderConstellationFrame(scene, state)`: pinta el fotograma completo (glifos + las tres esculturas).
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (constantes, `lerp`/`smootherstep` y tipos).
 *   - `./dala-constellation-render-state` (estado persistente y cuantización por lote).
 *   - `./dala-constellation-ambient` (`drawAmbientGlyphs`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (capa de presentación pura: no accede a datos).
 */

import {
  BRAIN_COMPACT_OFFSET_FACTOR,
  BRAIN_COMPACT_OFFSET_Y_FACTOR,
  BRAIN_COMPACT_SCALE,
  BRAIN_SCREEN_TRANSFORM,
  BRAIN_SIDE_SHIFT_MIN_WIDTH,
  BRAIN_TO_NETWORK_RANGE,
  CANVAS_BACKGROUND,
  NETWORK_TO_WORLD_RANGE,
  PERSPECTIVE_FOV,
  lerp,
  smoothstep,
  type BackdropGlyph,
  type BackdropNode,
  type PointerState,
} from './dala-constellation-geometry';
import { ALPHA_STEPS, DEPTH_SLICES, type ConstellationRenderState } from './dala-constellation-render-state';
import { drawAmbientGlyphs } from './dala-constellation-ambient';

/** Grosores de trazo cuantizados por lote (reposo y realce de borde cortical/costa). */
const THIN_LINE_WIDTH = 1.18;
const THICK_LINE_WIDTH = 1.45;
/** Semiancho aproximado de la silueta cerebral en unidades de mundo (recorte lateral seguro). */
const BRAIN_WORLD_HALF_WIDTH = 300;
/** Margen de seguridad en píxeles contra el borde derecho del viewport. */
const SCREEN_EDGE_MARGIN = 14;

/** Parámetros de un fotograma; el resto del estado vive en `ConstellationRenderState`. */
export interface ConstellationScene {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly time: number;
  readonly scroll: number;
  readonly nodes: readonly BackdropNode[];
  readonly glyphs: readonly BackdropGlyph[];
  readonly pointer: PointerState;
}

/** Pinta el fotograma completo: limpia el lienzo, dibuja glifos, proyecta y traza por lotes. */
export function renderConstellationFrame(scene: ConstellationScene, state: ConstellationRenderState): void {
  const { ctx, width, height, time, scroll, nodes, glyphs, pointer } = scene;

  const tBrainToNetwork = smoothstep(BRAIN_TO_NETWORK_RANGE[0], BRAIN_TO_NETWORK_RANGE[1], scroll);
  const tNetworkToWorld = smoothstep(NETWORK_TO_WORLD_RANGE[0], NETWORK_TO_WORLD_RANGE[1], scroll);
  const wBrain = 1 - tBrainToNetwork;
  const wNetwork = tBrainToNetwork * (1 - tNetworkToWorld);
  const wWorld = tNetworkToWorld;

  const baseScale = Math.max(0.56, Math.min(1.22, Math.min(width, height) / 720));
  const fov = PERSPECTIVE_FOV;
  const cx = width * 0.5;
  const cy = height * 0.5;

  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  drawAmbientGlyphs(ctx, glyphs, width, height, time, cx, cy, fov, baseScale);

  // Rotación continua inducida por scroll: respuesta fluida inmediata desde el primer píxel
  const scrollOrbitY = scroll * 0.88;
  const scrollTiltX = scroll * 0.30;

  // Rotaciones por escultura: senos y cosenos una sola vez por fotograma (antes: 6 por nodo).
  const brainRotY = Math.sin(time * 0.38) * 0.14 + pointer.smoothX * 0.28 + scrollOrbitY * 0.45;
  const brainRotX = Math.cos(time * 0.28) * 0.05 - pointer.smoothY * 0.18 + scrollTiltX * 0.35;
  const brainCosY = Math.cos(brainRotY);
  const brainSinY = Math.sin(brainRotY);
  const brainCosX = Math.cos(brainRotX);
  const brainSinX = Math.sin(brainRotX);

  const networkRotY = Math.sin(time * 0.22) * 0.14 + pointer.smoothX * 0.38 + scrollOrbitY * 0.55;
  const networkRotX = 0.10 - pointer.smoothY * 0.18 + scrollTiltX * 0.35;
  const networkCosY = Math.cos(networkRotY);
  const networkSinY = Math.sin(networkRotY);
  const networkCosX = Math.cos(networkRotX);
  const networkSinX = Math.sin(networkRotX);

  const worldRotY = -0.52 + time * 0.32 + pointer.smoothX * 0.55 + scrollOrbitY * 0.85;
  const worldRotX = 0.16 - pointer.smoothY * 0.28 + scrollTiltX * 0.45;
  const worldCosY = Math.cos(worldRotY);
  const worldSinY = Math.sin(worldRotY);
  const worldOrbitalCosY = Math.cos(-worldRotY * 1.35);
  const worldOrbitalSinY = Math.sin(-worldRotY * 1.35);
  const worldCosX = Math.cos(worldRotX);
  const worldSinX = Math.sin(worldRotX);
  const worldCosZ = Math.cos(0.06);
  const worldSinZ = Math.sin(0.06);

  // Deriva lateral del Cerebro hacia la zona derecha del hero (círculo libre de titular).
  const sideShiftActive = width >= BRAIN_SIDE_SHIFT_MIN_WIDTH;
  const brainStageScale = sideShiftActive ? BRAIN_SCREEN_TRANSFORM.scale : BRAIN_COMPACT_SCALE;
  const brainHalfWidth = BRAIN_WORLD_HALF_WIDTH * baseScale * brainStageScale;
  const maxOffsetX = Math.max(0, width - cx - brainHalfWidth - SCREEN_EDGE_MARGIN);
  const brainStageOffsetX = sideShiftActive
    ? Math.min(BRAIN_SCREEN_TRANSFORM.offsetX * width, maxOffsetX)
    : BRAIN_COMPACT_OFFSET_FACTOR * width;
  const brainStageOffsetY = sideShiftActive
    ? BRAIN_SCREEN_TRANSFORM.offsetY * height
    : BRAIN_COMPACT_OFFSET_Y_FACTOR * height;
  const networkStageOffsetX = sideShiftActive ? Math.min(0.245 * width, maxOffsetX) : 0;
  const networkStageOffsetY = sideShiftActive ? 0.035 * height : 0;
  const networkStageScale = 1.26;
  const stageScale = wBrain * brainStageScale + wNetwork * networkStageScale + wWorld * 1.0;
  const stageOffsetX = wBrain * brainStageOffsetX + wNetwork * networkStageOffsetX;
  const stageOffsetY = wBrain * brainStageOffsetY + wNetwork * networkStageOffsetY;

  // Torsión espiral orgánica muy suave para morphing laminar sin giros violentos
  const morphMotion = Math.sin(tBrainToNetwork * Math.PI) * (1 - tNetworkToWorld) + Math.sin(tNetworkToWorld * Math.PI);
  const twistAmp = morphMotion > 0.01 ? morphMotion * 0.16 : 0;
  for (let lane = 0; lane < 4; lane += 1) {
    const twistAngle = twistAmp * (0.6 + lane * 0.14);
    state.twistCos[lane] = Math.cos(twistAngle);
    state.twistSin[lane] = Math.sin(twistAngle);
  }
  const buffer = state.buffer;
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const item = buffer[i];
    if (node === undefined || item === undefined) {
      continue;
    }

    // Etapa 1 — Cerebro: pulso neural y rotación Y→X (el giro Z es nulo en esta escultura).
    let bx = node.bx;
    let by = node.by;
    let bz = node.bz;
    if (wBrain > 0.001) {
      const neuralPulse = 1 + 0.014 * Math.sin(time * 2.8 - bx * 0.018 + node.phase);
      const px = bx * neuralPulse;
      const py = by * neuralPulse;
      const pz = bz * neuralPulse;
      const x1 = px * brainCosY + pz * brainSinY;
      const z1 = pz * brainCosY - px * brainSinY;
      const y2 = py * brainCosX - z1 * brainSinX;
      const z2 = z1 * brainCosX + py * brainSinX;
      bx = x1;
      by = y2;
      bz = z2;
    }

    // Etapa 2 — Red de nodos: rotación Y→X de la malla completa (sin giro fino por partícula).
    let nx = node.nx;
    let ny = node.ny;
    let nz = node.nz;
    if (wNetwork > 0.001) {
      const x1 = nx * networkCosY + nz * networkSinY;
      const z1 = nz * networkCosY - nx * networkSinY;
      const y2 = ny * networkCosX - z1 * networkSinX;
      const z2 = z1 * networkCosX + ny * networkSinX;
      nx = x1;
      ny = y2;
      nz = z2;
    }

    // Etapa 3 — Planeta Tierra: rotación planetaria global (el anillo orbital gira sobre su eje).
    let wx = node.wx;
    let wy = node.wy;
    let wz = node.wz;
    if (wWorld > 0.001) {
      const cosY = node.isOrbital ? worldOrbitalCosY : worldCosY;
      const sinY = node.isOrbital ? worldOrbitalSinY : worldSinY;
      const x1 = wx * cosY + wz * sinY;
      const z1 = wz * cosY - wx * sinY;
      const y2 = wy * worldCosX - z1 * worldSinX;
      const z2 = z1 * worldCosX + wy * worldSinX;
      wx = x1 * worldCosZ - y2 * worldSinZ;
      wy = y2 * worldCosZ + x1 * worldSinZ;
      wz = z2;
    }

    // Morphing puro por pesos de scroll entre las tres posiciones precalculadas.
    let x = lerp(bx, nx, tBrainToNetwork);
    let y = lerp(by, ny, tBrainToNetwork);
    let z = lerp(bz, nz, tBrainToNetwork);
    x = lerp(x, wx, tNetworkToWorld);
    y = lerp(y, wy, tNetworkToWorld);
    z = lerp(z, wz, tNetworkToWorld);

    if (twistAmp > 0) {
      const lane = i & 3;
      const twistCos = state.twistCos[lane] ?? 1;
      const twistSin = state.twistSin[lane] ?? 0;
      const twistedX = x * twistCos - z * twistSin;
      const twistedZ = z * twistCos + x * twistSin;
      x = twistedX;
      z = twistedZ;
    }

    x *= baseScale * stageScale;
    y *= baseScale * stageScale;
    z *= baseScale;

    const depthScale = fov / Math.max(160, fov - z);
    let sx = cx + x * depthScale + stageOffsetX;
    let sy = cy + y * depthScale + stageOffsetY;

    // Repulsión elástica suave al pasar el cursor (sobre la posición dibujada).
    if (pointer.active) {
      const rdx = sx - pointer.x;
      const rdy = sy - pointer.y;
      const distanceSquared = rdx * rdx + rdy * rdy;
      if (distanceSquared < 14400 && distanceSquared > 1) {
        const distance = Math.sqrt(distanceSquared);
        const push = ((120 - distance) / 120) * 20;
        sx += (rdx / distance) * push;
        sy += (rdy / distance) * push;
      }
    }

    node.rotZ += node.vRotZ;
    node.rotX += node.vRotX;

    // Transición cromática continua por pesos de etapa: el color dominante fluye con el morphing
    let colorId: number;
    if (wBrain >= wNetwork && wBrain >= wWorld) {
      colorId = state.brainColorIds[i] ?? 0;
    } else if (wNetwork >= wWorld) {
      colorId = state.networkColorIds[i] ?? 0;
    } else {
      colorId = state.worldColorIds[i] ?? 0;
    }

    const normDepth = Math.max(0, Math.min(1, (z + 290 * baseScale) / (580 * baseScale)));
    let alpha = 0.25 + normDepth * 0.73;
    if (!sideShiftActive && wBrain > 0.05) {
      alpha *= 0.55;
    }

    // En la Tierra, atenuar el hemisferio trasero y realzar las costas frontales.
    if (wWorld > 0.2) {
      if (z < -15 * baseScale) {
        alpha *= lerp(1, 0.15, wWorld);
      } else if (node.isCoastline) {
        alpha = Math.min(0.98, alpha + 0.2 * wWorld);
      }
      if (node.isOceanGrid) {
        alpha *= lerp(1, 0.32, wWorld);
      }
    }

    // En el Cerebro, realzar el borde cortical y las cisuras anatómicas.
    if (wBrain > 0.2 && node.isRim) {
      alpha = Math.min(0.98, alpha + 0.22 * wBrain);
    }

    // En la Red Neuronal viva, realzar somas neuronales y axones sinápticos con impulsos activos
    let axonSpark = 0;
    if (wNetwork > 0.1) {
      if (node.isNetworkHub) {
        const hubPulse = 0.5 + 0.5 * Math.sin(time * 2.8 + node.phase);
        alpha = Math.min(0.98, (0.70 + 0.28 * hubPulse) * wNetwork + alpha * (1 - wNetwork));
      } else if (node.isNetworkEdge) {
        const wave = Math.sin(time * 4.8 - node.phase);
        axonSpark = Math.pow(Math.max(0, wave), 3.5);
        alpha = Math.min(0.95, (0.48 + 0.46 * axonSpark) * wNetwork + alpha * (1 - wNetwork));
      } else {
        // Polvo ambiental estelar muy sutil para dar aire y máxima limpieza a la silueta
        alpha = Math.min(0.22, 0.14 * wNetwork + alpha * 0.25 * (1 - wNetwork));
      }
    }

    item.sx = sx;
    item.sy = sy;
    item.z = z;
    const sizeMultiplier = node.isNetworkHub
      ? 0.75
      : node.isNetworkEdge
        ? 0.12 + axonSpark * 0.4
        : -0.32;
    item.r = node.size * depthScale * baseScale * (1 + wNetwork * sizeMultiplier) * stageScale;
    item.cosZ = Math.cos(node.rotZ);
    item.sinZ = Math.sin(node.rotZ);
    item.squash = 0.42 + 0.58 * Math.abs(Math.cos(node.rotX));
    item.colorId = colorId;
    item.alphaLevel = Math.max(0, Math.min(ALPHA_STEPS, Math.round(alpha * ALPHA_STEPS)));
    item.widthId = (node.isRim && wBrain > 0.3) || (node.isCoastline && wWorld > 0.3) || (node.isNetworkHub && wNetwork > 0.3) ? 1 : 0;

    if (z < zMin) {
      zMin = z;
    }
    if (z > zMax) {
      zMax = z;
    }
  }

  // Orden por profundidad sin comparaciones: conteo por rodajas (de atrás hacia adelante).
  const sliceOf = state.sliceOf;
  const sliceStart = state.sliceStart;
  const sliceCursor = state.sliceCursor;
  const depthOrder = state.depthOrder;
  sliceStart.fill(0);

  const span = zMax - zMin;
  const invSpan = span > 1e-6 ? DEPTH_SLICES / span : 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const item = buffer[i];
    if (item === undefined) {
      continue;
    }
    let slice = Math.floor((item.z - zMin) * invSpan);
    if (slice < 0) {
      slice = 0;
    } else if (slice >= DEPTH_SLICES) {
      slice = DEPTH_SLICES - 1;
    }
    sliceOf[i] = slice;
    sliceStart[slice + 1] = (sliceStart[slice + 1] ?? 0) + 1;
  }
  for (let slice = 0; slice < DEPTH_SLICES; slice += 1) {
    sliceStart[slice + 1] = (sliceStart[slice + 1] ?? 0) + (sliceStart[slice] ?? 0);
    sliceCursor[slice] = sliceStart[slice] ?? 0;
  }
  for (let i = 0; i < buffer.length; i += 1) {
    const slice = sliceOf[i] ?? 0;
    const cursor = sliceCursor[slice] ?? 0;
    depthOrder[cursor] = i;
    sliceCursor[slice] = cursor + 1;
  }

  // Trazo vectorial agrupado: lote cromático por rodaja de profundidad.
  const buckets = state.buckets;
  const usedKeys = state.usedBucketKeys;
  const pool = state.bucketPool;
  const colorTable = state.colorTable;

  for (let slice = 0; slice < DEPTH_SLICES; slice += 1) {
    usedKeys.length = 0;
    const sliceEnd = sliceStart[slice + 1] ?? 0;

    for (let k = sliceStart[slice] ?? 0; k < sliceEnd; k += 1) {
      const item = buffer[depthOrder[k] ?? 0];
      if (item === undefined || item.alphaLevel === 0) {
        continue;
      }
      if (item.sx < -15 || item.sx > width + 15 || item.sy < -15 || item.sy > height + 15) {
        continue;
      }

      const key = (item.colorId << 5) | (item.alphaLevel << 1) | item.widthId;
      let points = buckets[key];
      if (points === undefined || points === null) {
        points = pool.pop() ?? [];
        buckets[key] = points;
        usedKeys.push(key);
      }

      const cos = item.cosZ;
      const sin = item.sinZ;
      const radius = item.r;
      const squash = item.squash;
      const rSin = radius * sin;
      const rCos = radius * cos;
      const halfSpan = 0.5 * radius * squash;
      const xSpan = 0.866 * radius;
      points.push(
        item.sx + rSin,
        item.sy - rCos,
        item.sx + xSpan * cos - halfSpan * sin,
        item.sy + xSpan * sin + halfSpan * cos,
        item.sx - xSpan * cos - halfSpan * sin,
        item.sy - xSpan * sin + halfSpan * cos
      );
    }

    for (let u = 0; u < usedKeys.length; u += 1) {
      const key = usedKeys[u];
      if (key === undefined) {
        continue;
      }
      const points = buckets[key];
      if (points === undefined || points === null) {
        continue;
      }
      const color = colorTable[key >> 5];
      if (color !== undefined) {
        ctx.strokeStyle = color;
      }
      ctx.globalAlpha = ((key >> 1) & ALPHA_STEPS) / ALPHA_STEPS;
      ctx.lineWidth = (key & 1) === 1 ? THICK_LINE_WIDTH : THIN_LINE_WIDTH;
      ctx.beginPath();
      for (let p = 0; p < points.length; p += 6) {
        ctx.moveTo(points[p] ?? 0, points[p + 1] ?? 0);
        ctx.lineTo(points[p + 2] ?? 0, points[p + 3] ?? 0);
        ctx.lineTo(points[p + 4] ?? 0, points[p + 5] ?? 0);
        ctx.closePath();
      }
      ctx.stroke();

      buckets[key] = null;
      points.length = 0;
      pool.push(points);
    }
  }

  ctx.globalAlpha = 1;
}
