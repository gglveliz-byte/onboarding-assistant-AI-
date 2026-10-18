/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-sculptures.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — esculturas)
 * @proposito
 *   Escultores analíticos de las tres etapas del fondo vivo de constelación y ensamblador único
 *   de los nodos precalculados: (1) Cerebro anatómico 3D con silueta cortical explícita
 *   (cisura de Silvio, surco central de Rolando, lóbulo temporal, cerebelo con folia y tronco
 *   encefálico), (2) Red de nodos y conectores (cinco anillos de concentradores unidos por
 *   cadenas radiales, cuerdas y diagonales largas, más polvo de datos envolvente) y (3) Planeta
 *   Tierra cartográfico (costas de alta densidad, masa continental, retícula oceánica y anillo
 *   orbital de transmisión global). Cada nodo almacena sus tres posiciones simultáneas para que
 *   el morphing por scroll sea una interpolación pura de pesos, sin recalcular geometría.
 *
 * @resumen_contenido
 *   - `buildConstellation(particleCount, glyphCount)`: ensambla nodos de las 3 etapas y glifos ambientales.
 *   - `getCerebralArchBoundary` / `sampleBrainPoint`: silueta cortical + 5 regiones anatómicas.
 *   - `resolveNetworkSample` (en `dala-constellation-network-map`): anillos, cadenas y polvo.
 *   - `sampleWorldPoint`: costas (50 %), continentes (36 %), retícula (9 %) y anillo orbital (5 %).
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (paleta, hash, ruido y tipos de nodo/glifo).
 *   - `./dala-constellation-earth-map` (celdas de costa y continente de la malla 96×48).
 *   - `./dala-constellation-network-map` (concentradores y conectores de la red de nodos).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (módulo puro de presentación: no accede a datos).
 */

import { EARTH_COAST_CELLS, EARTH_LAND_CELLS, EARTH_MAP_COLS, EARTH_MAP_ROWS, type EarthCell } from './dala-constellation-earth-map';
import {
  AMBIENT_PALETTE,
  BACKDROP_COLORS as COLORS,
  hash,
  lerp,
  noise3D,
  type BackdropBuild,
  type BackdropGlyph,
  type BackdropNode,
  type BrainSample,
  type WorldSample,
} from './dala-constellation-geometry';
import { resolveNetworkSample } from './dala-constellation-network-map';

/**
 * Frontera del arco cortical cerebral: recorre el borde superior-lateral del córtex con
 * prominencia frontal, cúpula parietal, polo occipital, superficie orbital aplanada y la
 * escotadura cóncava donde encaja el cerebelo.
 */
function getCerebralArchBoundary(t: number): { x: number; y: number; angle: number } {
  const angle = -Math.PI * 1.12 + t * (Math.PI * 1.38);

  let rx = 252;
  let ry = 186;

  const frontalBulge = Math.exp(-Math.pow((t - 0.18) / 0.14, 2));
  rx += frontalBulge * 28;
  ry += frontalBulge * 12;

  const parietalCrown = Math.exp(-Math.pow((t - 0.54) / 0.18, 2));
  ry += parietalCrown * 28;

  const occipitalPole = Math.exp(-Math.pow((t - 0.86) / 0.11, 2));
  rx += occipitalPole * 30;

  let x = Math.cos(angle) * rx;
  let y = Math.sin(angle) * ry - 26;

  // Superficie orbital frontal aplanada (abajo a la izquierda)
  if (x < -45 && y > 18) {
    y = 18 + (y - 18) * 0.22;
  }
  // Escotadura cóncava inferior derecha donde encaja el cerebelo
  if (x > 65 && y > 22) {
    y = 22 + (y - 22) * 0.25;
  }

  return { x, y, angle };
}

/**
 * Muestreo anatómico del cerebro en 5 regiones por fracción `u`:
 * 20 % contorno cortical + cisuras, 44 % volumen de hemisferios con giros, 18 % lóbulo
 * temporal, 11 % cerebelo con folia y 7 % tronco encefálico (puente y bulbo).
 */
function sampleBrainPoint(i: number, total: number): BrainSample {
  const r1 = hash(i * 1.13 + 0.1);
  const r2 = hash(i * 2.47 + 0.3);
  const r3 = hash(i * 3.89 + 0.7);
  const r4 = hash(i * 5.21 + 0.9);

  const u = i / total;
  const hemiSign = i % 2 === 0 ? 1 : -1;
  let x = 0;
  let y = 0;
  let z = 0;
  let regionColor: string = COLORS.amberRim;
  let isRim = false;

  if (u < 0.2) {
    // 1. Contorno cortical exterior de alta densidad + surcos principales
    isRim = true;
    const sub = u / 0.2;

    if (sub < 0.68) {
      const t = sub / 0.68;
      const pt = getCerebralArchBoundary(t);
      const fold = Math.sin(t * 42) * 3.2;
      x = pt.x + (r1 - 0.5) * 6 + fold;
      y = pt.y + (r2 - 0.5) * 6 + fold * 0.8;
      z = hemiSign * (12 + r3 * 48);
      regionColor = r4 < 0.68 ? COLORS.amberRim : r4 < 0.88 ? COLORS.amberBright : COLORS.violet;
    } else if (sub < 0.86) {
      // Cisura lateral de Silvio (separa el lóbulo temporal)
      const s = (sub - 0.68) / 0.18;
      x = lerp(-128, 72, s) + (r1 - 0.5) * 5;
      y = lerp(24, -14, s) + Math.sin(s * Math.PI * 2) * 5 + (r2 - 0.5) * 4;
      z = hemiSign * (85 + r3 * 45);
      regionColor = r4 < 0.55 ? COLORS.amberRim : COLORS.violetDeep;
    } else {
      // Surco central de Rolando (divide frontal y parietal)
      const s = (sub - 0.86) / 0.14;
      x = lerp(-12, -46, s) + Math.sin(s * Math.PI * 3) * 7;
      y = lerp(-196, 12, s);
      z = hemiSign * (35 + Math.sin(s * Math.PI) * 95);
      regionColor = r4 < 0.6 ? COLORS.violet : COLORS.amberDeep;
    }
  } else if (u < 0.64) {
    // 2. Volumen de los hemisferios cerebrales con circunvoluciones (gyri/sulci)
    const t = (u - 0.2) / 0.44;
    const bound = getCerebralArchBoundary(t);
    const hubX = -15;
    const hubY = 12;

    const radial = 0.22 + Math.pow(r1, 0.58) * 0.78;
    isRim = radial > 0.9;

    x = lerp(hubX, bound.x, radial);
    y = lerp(hubY, bound.y, radial);

    // Hueco de la cisura de Silvio para separar el lóbulo temporal
    if (x > -125 && x < 65 && y > 8) {
      y = Math.min(y, 12 - Math.sin(((x + 125) / 190) * Math.PI) * 14);
    }

    // Cuantización en bandas de circunvoluciones serpenteantes
    const gyrusWave = Math.sin(x * 0.065 + Math.cos(y * 0.055) * 2.2) * Math.cos(y * 0.065 - x * 0.03);
    x += gyrusWave * 8.5;
    y += gyrusWave * 7.5;

    const surfaceEnvelope = Math.sqrt(Math.max(0.08, 1 - Math.pow(radial * 0.92, 2)));
    z = hemiSign * (14 + (0.35 + 0.65 * r2) * 132 * surfaceEnvelope);

    const nColor = noise3D(x * 0.016, y * 0.016, z * 0.016);
    if (x < -75) {
      // Lóbulo frontal: violeta, ámbar y magenta
      regionColor = nColor < 0.36 ? COLORS.violet : nColor < 0.66 ? COLORS.amberRim : nColor < 0.86 ? COLORS.magenta : COLORS.obsidian;
    } else if (x < 75 && y < -10) {
      // Lóbulo parietal / córtex motor y sensorial: turquesa, teal y violeta
      regionColor = nColor < 0.44 ? COLORS.teal : nColor < 0.72 ? COLORS.cyan : nColor < 0.9 ? COLORS.violet : COLORS.obsidian;
    } else {
      // Lóbulo occipital: ámbar dorado y violeta profundo
      regionColor = nColor < 0.5 ? COLORS.amberRim : nColor < 0.8 ? COLORS.violetDeep : COLORS.obsidian;
    }
  } else if (u < 0.82) {
    // 3. Lóbulo temporal: elipse anatómica inclinada con polo redondeado
    const t = (u - 0.64) / 0.18;
    const theta = t * Math.PI * 2;
    const shell = r1 < 0.55 ? 0.9 + r2 * 0.1 : 0.35 + Math.pow(r2, 0.65) * 0.55;
    isRim = shell > 0.88;

    const rx = 112;
    const ry = 46;
    const lx = Math.cos(theta) * rx * shell;
    let ly = Math.sin(theta) * ry * shell;

    ly += Math.sin(lx * 0.08 + r3 * 2.0) * 4.5;

    const tilt = -0.17;
    x = -18 + lx * Math.cos(tilt) - ly * Math.sin(tilt);
    y = 64 + lx * Math.sin(tilt) + ly * Math.cos(tilt);
    z = hemiSign * (42 + (0.3 + 0.7 * r3) * 88 * Math.sqrt(Math.max(0.15, 1 - shell * 0.6)));

    if (isRim || ly > 18) {
      regionColor = r4 < 0.7 ? COLORS.amberRim : r4 < 0.9 ? COLORS.amberBright : COLORS.violet;
    } else {
      regionColor = r4 < 0.45 ? COLORS.violet : r4 < 0.78 ? COLORS.teal : COLORS.indigo;
    }
  } else if (u < 0.93) {
    // 4. Cerebelo bajo el lóbulo occipital con láminas horizontales (folia)
    const t = (u - 0.82) / 0.11;
    const foliaBands = 9;
    const bandIndex = Math.floor(t * foliaBands);
    const bandFrac = t * foliaBands - bandIndex;

    const ny = ((bandIndex + 0.5) / foliaBands) * 2 - 1;
    const maxWidthAtY = Math.sqrt(Math.max(0.05, 1 - ny * ny));
    const nx = (bandFrac * 2 - 1) * maxWidthAtY;

    const shell = Math.hypot(nx, ny);
    isRim = shell > 0.85;

    x = 136 + nx * 76 + Math.sin(ny * 18) * 3;
    y = 78 + ny * 48;
    z = hemiSign * (18 + r2 * 76 * Math.sqrt(Math.max(0.1, 1 - shell * 0.7)));

    regionColor = isRim
      ? r3 < 0.65
        ? COLORS.amberRim
        : COLORS.violet
      : bandIndex % 2 === 0
        ? COLORS.amberDeep
        : r4 < 0.65
          ? COLORS.violetDeep
          : COLORS.obsidian;
  } else {
    // 5. Tronco encefálico: protuberancia (puente) y bulbo raquídeo
    const t = (u - 0.93) / 0.07;
    const angle = r1 * Math.PI * 2;
    const radial = 0.45 + 0.55 * Math.sqrt(r2);
    isRim = radial > 0.88;

    const ponsBulge = Math.exp(-Math.pow((t - 0.28) / 0.22, 2)) * 16;
    const stemRadius = (1 - t * 0.36) * 26 * radial;
    const centerAxisX = 24 + t * 22 - (Math.cos(angle) < 0 ? ponsBulge * -Math.cos(angle) : 0);

    x = centerAxisX + Math.cos(angle) * stemRadius;
    y = 104 + t * 136;
    z = Math.sin(angle) * stemRadius * 0.95;

    regionColor = r3 < 0.45 ? COLORS.violet : r3 < 0.78 ? COLORS.indigo : COLORS.amberDeep;
  }

  return { bx: x, by: y, bz: z, brainColor: regionColor, isRim };
}

/** Celda geográfica segura (la malla siempre tiene costas y continentes). */
function pickEarthCell(cells: readonly EarthCell[], index: number): EarthCell {
  const cell = cells[index % cells.length];
  if (cell === undefined) {
    return { lat: 0, lon: 0, row: 0, col: 0 };
  }
  return cell;
}

/**
 * Muestreo del planeta Tierra por fracción `u`: 50 % costas de alta densidad, 36 % masa
 * continental, 9 % retícula oceánica (paralelos/meridianos) y 5 % anillo orbital inclinado.
 */
function sampleWorldPoint(i: number, total: number): WorldSample {
  const r1 = hash(i * 3.71 + 0.4);
  const r2 = hash(i * 6.19 + 1.9);
  const r3 = hash(i * 8.53 + 4.1);

  const globeRadius = 248;
  const u = i / total;

  let lat = 0;
  let lon = 0;
  let radius = globeRadius;
  let worldColor: string = COLORS.amberRim;
  let isOceanGrid = false;
  let isOrbital = false;
  let isCoastline = false;

  if (u < 0.5) {
    // Costas de los continentes con precisión milimétrica
    isCoastline = true;
    const cell = pickEarthCell(EARTH_COAST_CELLS, i);
    lat = cell.lat + (r1 - 0.5) * (Math.PI / EARTH_MAP_ROWS) * 0.72;
    lon = cell.lon + (r2 - 0.5) * (Math.PI / EARTH_MAP_ROWS) * 0.72;
    radius = globeRadius * 1.012;
    worldColor = r3 < 0.65 ? COLORS.amberRim : r3 < 0.9 ? COLORS.violet : COLORS.amberBright;
  } else if (u < 0.86) {
    // Masa continental interior
    const cell = pickEarthCell(EARTH_LAND_CELLS, i);
    lat = cell.lat + (r1 - 0.5) * (Math.PI / EARTH_MAP_ROWS) * 0.88;
    lon = cell.lon + (r2 - 0.5) * (Math.PI / EARTH_MAP_ROWS) * 0.88;
    radius = globeRadius * 1.004;
    worldColor = r3 < 0.48 ? COLORS.teal : r3 < 0.8 ? COLORS.violet : COLORS.amberDeep;
  } else if (u < 0.95) {
    // Retícula oceánica (paralelos y meridianos geodésicos)
    isOceanGrid = true;
    const gridIdx = i - Math.floor(total * 0.86);
    if (gridIdx % 2 === 0) {
      const parallelIndex = (gridIdx % 9) - 4;
      lat = (parallelIndex / 5) * (Math.PI * 0.44);
      lon = (r1 * 2 - 1) * Math.PI;
    } else {
      const meridianIndex = gridIdx % 24;
      lon = ((meridianIndex / 24) * 2 - 1) * Math.PI;
      lat = (r2 * 2 - 1) * (Math.PI * 0.46);
    }
    radius = globeRadius * 0.992;
    worldColor = COLORS.indigo;
  } else {
    // Anillo orbital ecuatorial inclinado de transmisión global
    isOrbital = true;
    const angle = ((u - 0.95) / 0.05) * Math.PI * 2;
    const ringR = globeRadius * (1.22 + (r1 - 0.5) * 0.04);
    const tilt = 0.34;
    const ringX = Math.cos(angle) * ringR;
    const ringZ = Math.sin(angle) * ringR;
    return {
      wx: ringX,
      wy: ringZ * Math.sin(tilt) + (r2 - 0.5) * 4,
      wz: ringZ * Math.cos(tilt),
      worldColor: r3 < 0.55 ? COLORS.amberBright : COLORS.violet,
      isOceanGrid: false,
      isOrbital: true,
      isCoastline: false,
    };
  }

  const wx = radius * Math.cos(lat) * Math.sin(lon);
  const wy = -radius * Math.sin(lat);
  const wz = radius * Math.cos(lat) * Math.cos(lon);

  return { wx, wy, wz, worldColor, isOceanGrid, isOrbital, isCoastline };
}

/**
 * Ensambla la constelación completa: un nodo por partícula con sus tres posiciones
 * precalculadas (cerebro, red de nodos y Tierra) más cinemática de reposo, y los glifos
 * ambientales flotantes (18 grandes + polvo fino) con deriva y rotación propias.
 */
export function buildConstellation(particleCount: number, glyphCount: number): BackdropBuild {
  const nodes: BackdropNode[] = new Array<BackdropNode>(particleCount);

  for (let i = 0; i < particleCount; i += 1) {
    const brain = sampleBrainPoint(i, particleCount);
    const network = resolveNetworkSample(i);
    const world = sampleWorldPoint(i, particleCount);

    const r1 = hash(i * 1.91);
    const r2 = hash(i * 3.37);
    const r3 = hash(i * 5.83);

    const baseSize = brain.isRim ? 2.9 + r1 * 2.8 : 3.1 + r1 * 3.4;

    nodes[i] = {
      bx: brain.bx,
      by: brain.by,
      bz: brain.bz,
      brainColor: brain.brainColor,
      isRim: brain.isRim,
      nx: network.nx,
      ny: network.ny,
      nz: network.nz,
      networkColor: network.networkColor,
      isNetworkHub: network.isNetworkHub,
      isNetworkEdge: network.isNetworkEdge,
      wx: world.wx,
      wy: world.wy,
      wz: world.wz,
      worldColor: world.worldColor,
      isOceanGrid: world.isOceanGrid,
      isOrbital: world.isOrbital,
      isCoastline: world.isCoastline,
      size: baseSize,
      rotZ: r1 * Math.PI * 2,
      rotX: r2 * Math.PI * 2,
      vRotZ: (r2 - 0.5) * 0.024,
      vRotX: (r3 - 0.5) * 0.022,
      phase: network.isNetworkHub ? network.pulsePhase : r3 * Math.PI * 2,
    };
  }

  const glyphs: BackdropGlyph[] = new Array<BackdropGlyph>(glyphCount);

  for (let j = 0; j < glyphCount; j += 1) {
    const r1 = hash(j * 2.1 + 9.1);
    const r2 = hash(j * 4.3 + 3.7);
    const r3 = hash(j * 6.7 + 1.4);
    const r4 = hash(j * 8.9 + 5.2);

    const isLargeGlyph = j < 18;
    glyphs[j] = {
      x: (r1 - 0.5) * 1900,
      y: (r2 - 0.5) * 1200,
      z: (r3 - 0.5) * 500,
      size: isLargeGlyph ? 15 + r4 * 16 : 4.2 + r4 * 6.0,
      strokeWidth: isLargeGlyph ? 2.0 + r1 * 1.2 : 1.1,
      alpha: isLargeGlyph ? 0.2 : 0.16 + r2 * 0.22,
      color: AMBIENT_PALETTE[j % AMBIENT_PALETTE.length] ?? COLORS.amberRim,
      rotZ: r3 * Math.PI * 2,
      rotX: r4 * Math.PI * 2,
      vRot: (r1 - 0.5) * 0.012,
      speed: 0.2 + r2 * 0.5,
      phase: r3 * Math.PI * 2,
    };
  }

  return { nodes, glyphs };
}
