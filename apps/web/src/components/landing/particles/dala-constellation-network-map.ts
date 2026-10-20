/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-network-map.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala — Isotipo Oficial 3D del Logotipo)
 * @proposito
 *   Mapeo analítico y renderizado vectorial 100% exacto del Isotipo Oficial de Onboarding Assistant (Logo.tsx):
 *   Modela el Prisma Neuronal Hexagonal Facetado con su Diamante Central (Saffron Spark)
 *   en proporciones 1:1 directas del SVG vectorial:
 *   - 16 aristas estructurales de trazo continuo y denso que dibujan el contorno y las líneas del prisma.
 *   - Diamante Central en relieve frontal (+16 Z) en oro radiante (#ffb829, #ffe680).
 *   - Facetas Superiores completas en Violeta Electric Iris (#8052ff, #9b72ff).
 *   - Facetas Inferiores completas en Verde Esmeralda Deep Verdant (#15846e, #00b894).
 *   - Facetas Laterales completas en transición (#297775, #6653c7).
 *   - Función `drawLogoPrismStructure`: proyecta y traza la geometría estructural del prisma con
 *     facetas translúcidas de cristal, aristas continuas y nodos de bioluminiscencia en los vértices.
 *
 * @resumen_contenido
 *   - Vértices del prisma escalados a 3.4x del viewBox 100x100 de Logo.tsx (ancho ~260, alto ~300).
 *   - `OFFICIAL_EDGES`: 16 aristas vectoriales oficiales (contorno hexagonal + radios + diamante).
 *   - `OFFICIAL_FACETS`: 14 facetas triangulares del logotipo que cubren la geometría 100% sin huecos.
 *   - `resolveNetworkSample(index)`: resolución determinista O(1) de aristas, diamante y facetas.
 *   - `drawLogoPrismStructure(params)`: dibuja el prisma oficial con facetas vítreas, aristas y nodos.
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (paleta de colores, función hash y tipo `NetworkSample`).
 *
 * @dependencias_externas
 *   - Ninguna (utilidad matemática pura sin efectos secundarios de red).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (módulo puramente matemático de presentación).
 */

import { BACKDROP_COLORS as COLORS, hash, type NetworkSample } from './dala-constellation-geometry';

export interface Point3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// -----------------------------------------------------------------------------
// VÉRTICES EXACTOS DEL LOGOTIPO OFICIAL (Centro en 50,50 de Logo.tsx x 3.4)
// -----------------------------------------------------------------------------

/** 6 Vértices del contorno hexagonal exterior (Logo.tsx: 50,6 | 88,28 | 88,72 | 50,94 | 12,72 | 12,28) */
const P_TOP: Point3D = { x: 0, y: -149.6, z: 0 };
const P_TR: Point3D = { x: 129.2, y: -74.8, z: 8 };
const P_BR: Point3D = { x: 129.2, y: 74.8, z: -8 };
const P_BOTTOM: Point3D = { x: 0, y: 149.6, z: 0 };
const P_BL: Point3D = { x: -129.2, y: 74.8, z: 8 };
const P_TL: Point3D = { x: -129.2, y: -74.8, z: -8 };

/** 4 Vértices del Diamante Central (Logo.tsx: 50,22 | 72,50 | 50,78 | 28,50) con relieve frontal */
const D_TOP: Point3D = { x: 0, y: -95.2, z: 16 };
const D_RIGHT: Point3D = { x: 74.8, y: 0, z: 16 };
const D_BOTTOM: Point3D = { x: 0, y: 95.2, z: 16 };
const D_LEFT: Point3D = { x: -74.8, y: 0, z: 16 };
const D_CORE: Point3D = { x: 0, y: 0, z: 28 }; // Cúspide frontal en relieve del diamante de oro

// -----------------------------------------------------------------------------
// MALLA DE 16 ARISTAS DEL LOGOTIPO (Líneas vectoriales nítidas continuas)
// -----------------------------------------------------------------------------

interface LogoEdge {
  readonly a: Point3D;
  readonly b: Point3D;
  readonly colorA: string;
  readonly colorB: string;
  readonly isDiamond?: boolean;
}

const OFFICIAL_EDGES: readonly LogoEdge[] = [
  // Contorno hexagonal exterior (6 aristas)
  { a: P_TOP, b: P_TR, colorA: '#9b72ff', colorB: COLORS.violet },
  { a: P_TR, b: P_BR, colorA: COLORS.violet, colorB: COLORS.teal },
  { a: P_BR, b: P_BOTTOM, colorA: COLORS.teal, colorB: '#00b894' },
  { a: P_BOTTOM, b: P_BL, colorA: '#00b894', colorB: COLORS.teal },
  { a: P_BL, b: P_TL, colorA: COLORS.teal, colorB: COLORS.violet },
  { a: P_TL, b: P_TOP, colorA: COLORS.violet, colorB: '#9b72ff' },

  // Líneas interiores que conectan vértices exteriores con el diamante (6 aristas)
  { a: P_TOP, b: D_TOP, colorA: '#9b72ff', colorB: COLORS.amberBright },
  { a: P_BOTTOM, b: D_BOTTOM, colorA: '#00b894', colorB: COLORS.amberBright },
  { a: P_TL, b: D_LEFT, colorA: COLORS.violet, colorB: COLORS.amberRim },
  { a: P_BL, b: D_LEFT, colorA: COLORS.teal, colorB: COLORS.amberRim },
  { a: P_TR, b: D_RIGHT, colorA: COLORS.violet, colorB: COLORS.amberBright },
  { a: P_BR, b: D_RIGHT, colorA: COLORS.teal, colorB: COLORS.amberBright },

  // Perímetro del Diamante Central (4 aristas doradas)
  { a: D_TOP, b: D_RIGHT, colorA: COLORS.amberBright, colorB: '#ffe680', isDiamond: true },
  { a: D_RIGHT, b: D_BOTTOM, colorA: '#ffe680', colorB: COLORS.amberBright, isDiamond: true },
  { a: D_BOTTOM, b: D_LEFT, colorA: COLORS.amberBright, colorB: '#ffe680', isDiamond: true },
  { a: D_LEFT, b: D_TOP, colorA: '#ffe680', colorB: COLORS.amberBright, isDiamond: true },
];

// -----------------------------------------------------------------------------
// FACETAS TRIANGULARES EXACTAS DEL LOGOTIPO (14 triángulos que cubren las caras)
// -----------------------------------------------------------------------------

interface LogoFacet {
  readonly v0: Point3D;
  readonly v1: Point3D;
  readonly v2: Point3D;
  readonly color: string;
  readonly isDiamond?: boolean;
}

const OFFICIAL_FACETS: readonly LogoFacet[] = [
  // Diamante Central: 4 triángulos hacia la cúspide frontal D_CORE (Saffron Spark)
  { v0: D_TOP, v1: D_RIGHT, v2: D_CORE, color: '#ffe680', isDiamond: true },
  { v0: D_RIGHT, v1: D_BOTTOM, v2: D_CORE, color: COLORS.amberBright, isDiamond: true },
  { v0: D_BOTTOM, v1: D_LEFT, v2: D_CORE, color: COLORS.amberRim, isDiamond: true },
  { v0: D_LEFT, v1: D_TOP, v2: D_CORE, color: '#ffe680', isDiamond: true },

  // Faceta Superior Derecha (cuadrilátero descompuesto en 2 triángulos)
  { v0: P_TOP, v1: P_TR, v2: D_TOP, color: '#9b72ff' },
  { v0: P_TR, v1: D_RIGHT, v2: D_TOP, color: '#8052ff' },

  // Faceta Superior Izquierda (cuadrilátero descompuesto en 2 triángulos)
  { v0: P_TOP, v1: P_TL, v2: D_TOP, color: '#9b72ff' },
  { v0: P_TL, v1: D_LEFT, v2: D_TOP, color: '#8052ff' },

  // Faceta Inferior Derecha (cuadrilátero descompuesto en 2 triángulos)
  { v0: P_BOTTOM, v1: P_BR, v2: D_BOTTOM, color: '#00b894' },
  { v0: P_BR, v1: D_RIGHT, v2: D_BOTTOM, color: '#15846e' },

  // Faceta Inferior Izquierda (cuadrilátero descompuesto en 2 triángulos)
  { v0: P_BOTTOM, v1: P_BL, v2: D_BOTTOM, color: '#00b894' },
  { v0: P_BL, v1: D_LEFT, v2: D_BOTTOM, color: '#15846e' },

  // Facetas Laterales de Transición Cromática
  { v0: P_TL, v1: D_LEFT, v2: P_BL, color: '#297775' },
  { v0: P_TR, v1: D_RIGHT, v2: P_BR, color: '#6653c7' },
];

// -----------------------------------------------------------------------------
// REPARTO DETERMINISTA DE TODAS LAS PARTÍCULAS
// -----------------------------------------------------------------------------

/** 1. Malla de aristas (16 aristas * 32 puntos = 512 partículas continuas) */
const PARTICLES_PER_EDGE = 32;
const EDGES_END = OFFICIAL_EDGES.length * PARTICLES_PER_EDGE; // 512

/** 2. Diamante central de oro (240 partículas en relieve frontal) */
const DIAMOND_COUNT = 240;
const DIAMOND_END = EDGES_END + DIAMOND_COUNT; // 512 + 240 = 752

/**
 * Resuelve una partícula sobre las 16 aristas oficiales:
 * Trazado denso, equiespaciado y nítido que dibuja el hexágono y el prisma sin cortes.
 */
function sampleEdgeParticle(index: number): NetworkSample {
  const edgeIndex = Math.floor(index / PARTICLES_PER_EDGE);
  const stepInEdge = index % PARTICLES_PER_EDGE;

  const edge = OFFICIAL_EDGES[edgeIndex % OFFICIAL_EDGES.length]!;
  const t = stepInEdge / (PARTICLES_PER_EDGE - 1);

  const nx = edge.a.x + (edge.b.x - edge.a.x) * t;
  const ny = edge.a.y + (edge.b.y - edge.a.y) * t;
  const nz = edge.a.z + (edge.b.z - edge.a.z) * t;

  const color = t < 0.5 ? edge.colorA : edge.colorB;

  return {
    nx,
    ny,
    nz,
    networkColor: color,
    isNetworkHub: edge.isDiamond === true,
    isNetworkEdge: true,
    pulsePhase: t * Math.PI * 2,
  };
}

/**
 * Resuelve una partícula dentro del Diamante Central (Saffron Spark):
 * Puntos dorados densos y armónicos en la pirámide central del logotipo.
 */
function sampleDiamondParticle(index: number): NetworkSample {
  const rel = index - EDGES_END;
  const facetIndex = rel % 4; // 4 triángulos frontales del diamante
  const facet = OFFICIAL_FACETS[facetIndex]!;

  const r1 = hash(index * 2.83 + 1.1);
  const r2 = hash(index * 4.97 + 3.7);
  const sqrtR1 = Math.sqrt(r1);

  const u = 1 - sqrtR1;
  const v = r2 * sqrtR1;
  const w = 1 - u - v;

  const nx = u * facet.v0.x + v * facet.v1.x + w * facet.v2.x;
  const ny = u * facet.v0.y + v * facet.v1.y + w * facet.v2.y;
  const nz = u * facet.v0.z + v * facet.v1.z + w * facet.v2.z;

  const color = r1 < 0.45 ? '#ffe680' : r1 < 0.85 ? COLORS.amberBright : COLORS.amberRim;

  return {
    nx,
    ny,
    nz,
    networkColor: color,
    isNetworkHub: true,
    isNetworkEdge: false,
    pulsePhase: (u + v) * Math.PI * 2,
  };
}

/**
 * Resuelve una partícula sobre las facetas coloreadas del prisma:
 * Distribución baricéntrica homogénea sobre las caras triangulares violetas y esmeraldas.
 */
function sampleFacetParticle(index: number): NetworkSample {
  const rel = index - DIAMOND_END;
  // Facetas 4 a 13 (10 facetas exteriores)
  const nonDiamondCount = OFFICIAL_FACETS.length - 4; // 10 facetas
  const facetIndex = 4 + (rel % nonDiamondCount);
  const facet = OFFICIAL_FACETS[facetIndex]!;

  const r1 = hash(index * 3.47 + 2.3);
  const r2 = hash(index * 5.81 + 4.1);
  const sqrtR1 = Math.sqrt(r1);

  const u = 1 - sqrtR1;
  const v = r2 * sqrtR1;
  const w = 1 - u - v;

  const nx = u * facet.v0.x + v * facet.v1.x + w * facet.v2.x;
  const ny = u * facet.v0.y + v * facet.v1.y + w * facet.v2.y;
  const nz = u * facet.v0.z + v * facet.v1.z + w * facet.v2.z;

  return {
    nx,
    ny,
    nz,
    networkColor: facet.color,
    isNetworkHub: true,
    isNetworkEdge: false,
    pulsePhase: (u + v) * Math.PI,
  };
}

/**
 * Resuelve la muestra analítica exacta de la partícula para la Etapa 2:
 * Dibuja el Logotipo Oficial de Onboarding Assistant completo y sin huecos en O(1).
 */
export function resolveNetworkSample(index: number): NetworkSample {
  if (index < EDGES_END) {
    return sampleEdgeParticle(index);
  }
  if (index < DIAMOND_END) {
    return sampleDiamondParticle(index);
  }
  return sampleFacetParticle(index);
}

// -----------------------------------------------------------------------------
// RENDERIZADO VECTORIAL DEL PRISMA ESTRUCTURAL OFICIAL
// -----------------------------------------------------------------------------

export interface LogoPrismRenderParams {
  readonly ctx: CanvasRenderingContext2D;
  readonly cx: number;
  readonly cy: number;
  readonly fov: number;
  readonly baseScale: number;
  readonly stageScale: number;
  readonly stageOffsetX: number;
  readonly stageOffsetY: number;
  readonly rotX: number;
  readonly rotY: number;
  readonly wNetwork: number;
}

interface Point2D {
  readonly sx: number;
  readonly sy: number;
}

function projectVertex(
  pt: Point3D,
  params: LogoPrismRenderParams,
  cosY: number,
  sinY: number,
  cosX: number,
  sinX: number
): Point2D {
  const x1 = pt.x * cosY + pt.z * sinY;
  const z1 = pt.z * cosY - pt.x * sinY;
  const y2 = pt.y * cosX - z1 * sinX;
  const z2 = z1 * cosX + pt.y * sinX;

  const totalScale = params.baseScale * params.stageScale;
  const x = x1 * totalScale;
  const y = y2 * totalScale;
  const z = z2 * params.baseScale;

  const depthScale = params.fov / Math.max(160, params.fov - z);
  return {
    sx: params.cx + x * depthScale + params.stageOffsetX,
    sy: params.cy + y * depthScale + params.stageOffsetY,
  };
}

/**
 * Dibuja la estructura vectorial, facetas de cristal luminosas y nodos del Logotipo Oficial.
 */
export function drawLogoPrismStructure(params: LogoPrismRenderParams): void {
  const { ctx, wNetwork } = params;
  if (wNetwork < 0.05) {
    return;
  }

  const cosY = Math.cos(params.rotY);
  const sinY = Math.sin(params.rotY);
  const cosX = Math.cos(params.rotX);
  const sinX = Math.sin(params.rotX);

  const pTop = projectVertex(P_TOP, params, cosY, sinY, cosX, sinX);
  const pTr = projectVertex(P_TR, params, cosY, sinY, cosX, sinX);
  const pBr = projectVertex(P_BR, params, cosY, sinY, cosX, sinX);
  const pBottom = projectVertex(P_BOTTOM, params, cosY, sinY, cosX, sinX);
  const pBl = projectVertex(P_BL, params, cosY, sinY, cosX, sinX);
  const pTl = projectVertex(P_TL, params, cosY, sinY, cosX, sinX);

  const dTop = projectVertex(D_TOP, params, cosY, sinY, cosX, sinX);
  const dRight = projectVertex(D_RIGHT, params, cosY, sinY, cosX, sinX);
  const dBottom = projectVertex(D_BOTTOM, params, cosY, sinY, cosX, sinX);
  const dLeft = projectVertex(D_LEFT, params, cosY, sinY, cosX, sinX);
  const dCore = projectVertex(D_CORE, params, cosY, sinY, cosX, sinX);

  const drawQuad = (p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D, color: string, alpha: number) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha * wNetwork));
    ctx.beginPath();
    ctx.moveTo(p1.sx, p1.sy);
    ctx.lineTo(p2.sx, p2.sy);
    ctx.lineTo(p3.sx, p3.sy);
    ctx.lineTo(p4.sx, p4.sy);
    ctx.closePath();
    ctx.fill();
  };

  const drawTri = (p1: Point2D, p2: Point2D, p3: Point2D, color: string, alpha: number) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha * wNetwork));
    ctx.beginPath();
    ctx.moveTo(p1.sx, p1.sy);
    ctx.lineTo(p2.sx, p2.sy);
    ctx.lineTo(p3.sx, p3.sy);
    ctx.closePath();
    ctx.fill();
  };

  // 1. Facetas Superiores Violetas (Electric Iris)
  drawQuad(pTop, pTr, dRight, dTop, '#8052ff', 0.22);
  drawQuad(pTop, pTl, dLeft, dTop, '#8052ff', 0.18);

  // 2. Facetas Inferiores Esmeraldas (Deep Verdant)
  drawQuad(pBottom, pBr, dRight, dBottom, '#15846e', 0.22);
  drawQuad(pBottom, pBl, dLeft, dBottom, '#15846e', 0.18);

  // 3. Facetas Laterales de Transición
  drawTri(pTl, dLeft, pBl, '#297775', 0.20);
  drawTri(pTr, dRight, pBr, '#6653c7', 0.20);

  // 4. Diamante Central Saffron Spark (4 caras en pirámide)
  drawTri(dTop, dRight, dCore, '#ffe680', 0.44);
  drawTri(dRight, dBottom, dCore, '#ffb829', 0.40);
  drawTri(dBottom, dLeft, dCore, '#d97706', 0.38);
  drawTri(dLeft, dTop, dCore, '#ffe680', 0.44);

  // 5. Aristas Vectoriales Nítidas del Hexágono Exterior
  ctx.lineWidth = 2.0;
  ctx.strokeStyle = '#8052ff';
  ctx.globalAlpha = 0.88 * wNetwork;
  ctx.beginPath();
  ctx.moveTo(pTop.sx, pTop.sy);
  ctx.lineTo(pTr.sx, pTr.sy);
  ctx.lineTo(pBr.sx, pBr.sy);
  ctx.lineTo(pBottom.sx, pBottom.sy);
  ctx.lineTo(pBl.sx, pBl.sy);
  ctx.lineTo(pTl.sx, pTl.sy);
  ctx.closePath();
  ctx.stroke();

  // 6. Aristas Interiores hacia el Diamante
  ctx.lineWidth = 1.4;
  ctx.globalAlpha = 0.72 * wNetwork;
  ctx.strokeStyle = '#8052ff';
  ctx.beginPath();
  ctx.moveTo(pTop.sx, pTop.sy);
  ctx.lineTo(dTop.sx, dTop.sy);
  ctx.moveTo(pTl.sx, pTl.sy);
  ctx.lineTo(dLeft.sx, dLeft.sy);
  ctx.moveTo(pTr.sx, pTr.sy);
  ctx.lineTo(dRight.sx, dRight.sy);
  ctx.stroke();

  ctx.strokeStyle = '#15846e';
  ctx.beginPath();
  ctx.moveTo(pBottom.sx, pBottom.sy);
  ctx.lineTo(dBottom.sx, dBottom.sy);
  ctx.moveTo(pBl.sx, pBl.sy);
  ctx.lineTo(dLeft.sx, dLeft.sy);
  ctx.moveTo(pBr.sx, pBr.sy);
  ctx.lineTo(dRight.sx, dRight.sy);
  ctx.stroke();

  // 7. Perímetro y Diagonales del Diamante Central
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#ffb829';
  ctx.globalAlpha = 0.96 * wNetwork;
  ctx.beginPath();
  ctx.moveTo(dTop.sx, dTop.sy);
  ctx.lineTo(dRight.sx, dRight.sy);
  ctx.lineTo(dBottom.sx, dBottom.sy);
  ctx.lineTo(dLeft.sx, dLeft.sy);
  ctx.closePath();
  ctx.moveTo(dTop.sx, dTop.sy);
  ctx.lineTo(dCore.sx, dCore.sy);
  ctx.moveTo(dRight.sx, dRight.sy);
  ctx.lineTo(dCore.sx, dCore.sy);
  ctx.moveTo(dBottom.sx, dBottom.sy);
  ctx.lineTo(dCore.sx, dCore.sy);
  ctx.moveTo(dLeft.sx, dLeft.sy);
  ctx.lineTo(dCore.sx, dCore.sy);
  ctx.stroke();

  // 8. Nodos de Vértice Brillantes (Bioluminiscencia en las esquinas)
  const drawNodeDot = (pt: Point2D, radius: number, ringColor: string, innerColor: string) => {
    ctx.globalAlpha = 0.95 * wNetwork;
    ctx.fillStyle = ringColor;
    ctx.beginPath();
    ctx.arc(pt.sx, pt.sy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = innerColor;
    ctx.beginPath();
    ctx.arc(pt.sx, pt.sy, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
  };

  drawNodeDot(pTop, 3.4, '#8052ff', '#ffffff');
  drawNodeDot(pTr, 3.4, '#8052ff', '#ffffff');
  drawNodeDot(pBr, 3.4, '#15846e', '#ffffff');
  drawNodeDot(pBottom, 3.4, '#15846e', '#ffffff');
  drawNodeDot(pBl, 3.4, '#15846e', '#ffffff');
  drawNodeDot(pTl, 3.4, '#8052ff', '#ffffff');

  drawNodeDot(dTop, 4.0, '#ffb829', '#ffffff');
  drawNodeDot(dRight, 4.0, '#ffb829', '#ffffff');
  drawNodeDot(dBottom, 4.0, '#ffb829', '#ffffff');
  drawNodeDot(dLeft, 4.0, '#ffb829', '#ffffff');
  drawNodeDot(dCore, 5.2, '#ffe680', '#ffffff');

  ctx.globalAlpha = 1.0;
}

