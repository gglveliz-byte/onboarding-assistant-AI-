/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-render.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — compositor por lotes)
 * @proposito
 *   Compositor por fotograma del fondo vivo de constelación: proyecta los nodos con rotaciones
 *   in situ (senos/cosenos por escultura y rotación propia incremental, sin asignaciones ni
 *   trigonometría por nodo), aplica la
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
  fluidMorphStep,
  lerp,
  type BackdropGlyph,
  type BackdropNode,
  type PointerState,
} from './dala-constellation-geometry';
import { ALPHA_STEPS, DEPTH_SLICES, type ConstellationRenderState } from './dala-constellation-render-state';
import { drawAmbientGlyphs } from './dala-constellation-ambient';
import { drawLogoPrismStructure } from './dala-constellation-network-map';

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
  readonly scrollVelocity: number;
  readonly nodes: readonly BackdropNode[];
  readonly glyphs: readonly BackdropGlyph[];
  readonly pointer: PointerState;
}

/** Pinta el fotograma completo: limpia el lienzo, dibuja glifos, proyecta y traza por lotes. */
export function renderConstellationFrame(scene: ConstellationScene, state: ConstellationRenderState): void {
  const { ctx, width, height, time, scroll, nodes, glyphs, pointer } = scene;

  const tBrainToNetwork = fluidMorphStep(BRAIN_TO_NETWORK_RANGE[0], BRAIN_TO_NETWORK_RANGE[1], scroll);
  const tNetworkToWorld = fluidMorphStep(NETWORK_TO_WORLD_RANGE[0], NETWORK_TO_WORLD_RANGE[1], scroll);
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

  // Rotación inducida por scroll + deriva elástica por velocidad: el campo responde al impulso
  // del usuario y se disuelve suavemente al detenerse (sin saltos ni zonas muertas).
  const velocitySway = Math.max(-1.2, Math.min(1.2, scene.scrollVelocity * 0.6));
  const scrollOrbitY = scroll * 0.88 + velocitySway * 0.30;
  const scrollTiltX = scroll * 0.30 + velocitySway * 0.10;

  // Rotaciones por escultura: senos y cosenos una sola vez por fotograma (antes: 6 por nodo).
  const brainRotY = Math.sin(time * 0.38) * 0.14 + pointer.smoothX * 0.28 + scrollOrbitY * 0.45;
  const brainRotX = Math.cos(time * 0.28) * 0.05 - pointer.smoothY * 0.18 + scrollTiltX * 0.35;
  const brainCosY = Math.cos(brainRotY);
  const brainSinY = Math.sin(brainRotY);
  const brainCosX = Math.cos(brainRotX);
  const brainSinX = Math.sin(brainRotX);

  // Rotación frontal del logotipo: respiración sutil y paralaje de cursor sin deformar la figura
  const networkRotY = Math.sin(time * 0.32) * 0.05 + pointer.smoothX * 0.12;
  const networkRotX = Math.cos(time * 0.25) * 0.03 - pointer.smoothY * 0.08;
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
  // El logotipo se posiciona a la derecha y más abajo (0.26*height) para calzar frente a las tarjetas RAG
  const networkStageOffsetX = sideShiftActive ? Math.min(0.235 * width, maxOffsetX) : 0;
  const networkStageOffsetY = sideShiftActive ? 0.26 * height : 0.14 * height;
  const networkStageScale = 1.15;
  const stageScale = wBrain * brainStageScale + wNetwork * networkStageScale + wWorld * 1.0;
  const stageOffsetX = wBrain * brainStageOffsetX + wNetwork * networkStageOffsetX;
  const stageOffsetY = wBrain * brainStageOffsetY + wNetwork * networkStageOffsetY;

  // Estructura vectorial del prisma oficial: facetas vítreas, aristas y nodos bioluminiscentes
  if (wNetwork > 0.05) {
    drawLogoPrismStructure({
      ctx,
      cx,
      cy,
      fov,
      baseScale,
      stageScale: networkStageScale,
      stageOffsetX: networkStageOffsetX,
      stageOffsetY: networkStageOffsetY,
      rotX: networkRotX,
      rotY: networkRotY,
      wNetwork,
    });
  }

  // Torsión espiral orgánica muy suave para morphing laminar sin giros violentos
  const morphMotion = Math.sin(tBrainToNetwork * Math.PI) * (1 - tNetworkToWorld) + Math.sin(tNetworkToWorld * Math.PI);
  const twistAmp = morphMotion > 0.01 ? morphMotion * 0.16 : 0;
  for (let lane = 0; lane < 4; lane += 1) {
    const twistAngle = twistAmp * (0.6 + lane * 0.14);
    state.twistCos[lane] = Math.cos(twistAngle);
    state.twistSin[lane] = Math.sin(twistAngle);
  }
  const buffer = state.buffer;
  // Pulsos neurales por suma de ángulos: trigonometría global una vez por fotograma (no por nodo).
  const pulseSinTime = Math.sin(time * 2.8);
  const pulseCosTime = Math.cos(time * 2.8);
  const axonSinTime = Math.sin(time * 4.8);
  const axonCosTime = Math.cos(time * 4.8);
  const brainPulseCos = state.brainPulseCos;
  const brainPulseSin = state.brainPulseSin;
  const networkPhaseCos = state.networkPhaseCos;
  const networkPhaseSin = state.networkPhaseSin;
  const cosZState = state.cosZ;
  const sinZState = state.sinZ;
  const cosXState = state.cosX;
  const sinXState = state.sinX;
  const stepCosZState = state.stepCosZ;
  const stepSinZState = state.stepSinZ;
  const stepCosXState = state.stepCosX;
  const stepSinXState = state.stepSinX;
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
      // sin(ωt + fase) resuelto con suma de ángulos: cos/sin de fase precalculados por nodo.
      const phaseSin = pulseSinTime * (brainPulseCos[i] ?? 0) + pulseCosTime * (brainPulseSin[i] ?? 0);
      const neuralPulse = 1 + 0.014 * phaseSin;
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

    // Rotación propia incremental por composición (cos/sin + pasos precalculados): cero trigonometría.
    const stepCosZ = stepCosZState[i] ?? 1;
    const stepSinZ = stepSinZState[i] ?? 0;
    const prevCosZ = cosZState[i] ?? 1;
    const prevSinZ = sinZState[i] ?? 0;
    const nextCosZ = prevCosZ * stepCosZ - prevSinZ * stepSinZ;
    const nextSinZ = prevSinZ * stepCosZ + prevCosZ * stepSinZ;
    cosZState[i] = nextCosZ;
    sinZState[i] = nextSinZ;

    const stepCosX = stepCosXState[i] ?? 1;
    const stepSinX = stepSinXState[i] ?? 0;
    const prevCosX = cosXState[i] ?? 1;
    const prevSinX = sinXState[i] ?? 0;
    const nextCosX = prevCosX * stepCosX - prevSinX * stepSinX;
    const nextSinX = prevSinX * stepCosX + prevCosX * stepSinX;
    cosXState[i] = nextCosX;
    sinXState[i] = nextSinX;

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

    // En la escultura del Logotipo (etapa 2), trazo ultra-nítido de aristas y facetas luminosas
    if (wNetwork > 0.05) {
      if (node.isNetworkEdge) {
        // Aristas del prisma hexagonal: trazo denso, continuo y brillante
        alpha = Math.min(0.98, 0.92 * wNetwork + alpha * (1 - wNetwork));
      } else if (node.isNetworkHub) {
        // Facetas y Diamante Central: color vibrante con pulso áureo suave
        const hubWave = pulseSinTime * (networkPhaseCos[i] ?? 0) + pulseCosTime * (networkPhaseSin[i] ?? 0);
        const hubPulse = 0.5 + 0.5 * hubWave;
        alpha = Math.min(0.94, (0.80 + 0.16 * hubPulse) * wNetwork + alpha * (1 - wNetwork));
      }
    }

    item.sx = sx;
    item.sy = sy;
    item.z = z;
    // Tamaño homogéneo y calibrado para que el dibujo se forme con resolución nítida sin deformarse
    const sizeMultiplier = node.isNetworkEdge ? -0.10 : -0.25;
    item.r = node.size * depthScale * baseScale * (1 + wNetwork * sizeMultiplier) * stageScale;
    if (wNetwork > 0.2) {
      const damp = Math.max(0, 1 - wNetwork * 0.85);
      item.cosZ = nextCosZ * damp + (1 - damp);
      item.sinZ = nextSinZ * damp;
      item.squash = 0.42 + 0.58 * (Math.abs(nextCosX) * damp + (1 - damp));
    } else {
      item.cosZ = nextCosZ;
      item.sinZ = nextSinZ;
      item.squash = 0.42 + 0.58 * Math.abs(nextCosX);
    }
    item.colorId = colorId;
    item.alphaLevel = Math.max(0, Math.min(ALPHA_STEPS, Math.round(alpha * ALPHA_STEPS)));
    item.widthId = (node.isRim && wBrain > 0.3) || (node.isCoastline && wWorld > 0.3) || (node.isNetworkEdge && wNetwork > 0.3) ? 1 : 0;

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
