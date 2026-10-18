/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-geometry.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — geometría base)
 * @proposito
 *   Primitivas matemáticas deterministas y contratos de datos del fondo vivo de constelación
 *   de la Landing Comercial: funciones de ruido/hash para dispersión reproducible, interpolación
 *   y suavizado de transiciones, la paleta cromática de alto contraste calibrada para el lienzo
 *   claro (#f2fbf9) del portal Auros Light y las constantes del lienzo, incluida la
 *   transformación de pantalla por etapa (deriva lateral del Cerebro en el hero).
 *
 * @resumen_contenido
 *   - `BackdropNode`: nodo-triángulo con coordenadas precalculadas para las tres esculturas
 *     (cerebro `b*`, red de nodos `n*`, planeta Tierra `w*`) y sus parámetros cinemáticos.
 *   - `BackdropGlyph`: glifo ambiental flotante (triángulo wireframe de polvo estelar).
 *   - `BackdropBuild`: par de colecciones devueltas por el ensamblador de esculturas.
 *   - `BACKDROP_COLORS` + `AMBIENT_PALETTE`: paleta ámbar/violeta/turquesa/magenta/índigo.
 *   - `fract`, `hash`, `hash3`, `noise3D`, `lerp`, `smootherstep`: matemática pura del motor.
 *   - `BrainSample`, `NetworkSample`, `WorldSample`: contratos de salida de los escultores analíticos.
 *   - `ProjectedTriangle`, `PointerState`, `StageScreenTransform` y constantes del lienzo (FOV,
 *     densidades, presupuesto de píxeles, rangos de scroll y deriva del Cerebro).
 *
 * @dependencias_internas
 *   - Ninguna (utilidad matemática pura, sin efectos secundarios ni DOM).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (módulo puro de presentación: no accede a datos).
 */

/** Nodo de la constelación: un microtriángulo con sus 3 posiciones de etapa precalculadas. */
export interface BackdropNode {
  /** Etapa 1 — Cerebro anatómico (bx, by, bz) + color y realce de borde cortical. */
  bx: number;
  by: number;
  bz: number;
  brainColor: string;
  isRim: boolean;
  /** Etapa 2 — Red de nodos y conectores (nx, ny, nz) + rol de concentrador o conector. */
  nx: number;
  ny: number;
  nz: number;
  networkColor: string;
  isNetworkHub: boolean;
  isNetworkEdge: boolean;
  /** Etapa 3 — Planeta Tierra (wx, wy, wz) + tipología de trazo cartográfico. */
  wx: number;
  wy: number;
  wz: number;
  worldColor: string;
  isOceanGrid: boolean;
  isOrbital: boolean;
  isCoastline: boolean;
  /** Cinemática de reposo: tamaño base, giro propio y fase de pulso neural. */
  size: number;
  rotZ: number;
  rotX: number;
  vRotZ: number;
  vRotX: number;
  phase: number;
}

/** Glifo ambiental flotante (polvo de triángulos wireframe fuera de la escultura). */
export interface BackdropGlyph {
  x: number;
  y: number;
  z: number;
  size: number;
  strokeWidth: number;
  alpha: number;
  color: string;
  rotZ: number;
  rotX: number;
  vRot: number;
  speed: number;
  phase: number;
}

/** Colecciones construidas una sola vez por montaje del fondo. */
export interface BackdropBuild {
  readonly nodes: readonly BackdropNode[];
  readonly glyphs: readonly BackdropGlyph[];
}

/** Paleta cromática calibrada para alto contraste sobre el lienzo claro (#f2fbf9). */
export const BACKDROP_COLORS = {
  amberRim: '#f59e0b',
  amberBright: '#ffb829',
  amberDeep: '#d97706',
  violet: '#8052ff',
  violetDeep: '#5b21b6',
  magenta: '#d946ef',
  pink: '#ec4899',
  teal: '#0f766e',
  cyan: '#0d9488',
  indigo: '#4338ca',
  obsidian: '#1e1b4b',
} as const;

/** Rotación cromática de los glifos ambientales flotantes. */
export const AMBIENT_PALETTE: readonly string[] = [
  BACKDROP_COLORS.amberRim,
  BACKDROP_COLORS.amberBright,
  BACKDROP_COLORS.violet,
  BACKDROP_COLORS.teal,
  BACKDROP_COLORS.magenta,
  BACKDROP_COLORS.indigo,
];

/** Parte fraccionaria positiva de un número. */
export function fract(value: number): number {
  return value - Math.floor(value);
}

/** Hash determinista de un índice escalar (dispersión reproducible de partículas). */
export function hash(seed: number): number {
  return fract(Math.sin(seed * 127.1 + 311.7) * 43758.5453123);
}

/** Hash determinista de tres coordenadas (ruido por volumen). */
export function hash3(x: number, y: number, z: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123);
}

/** Ruido tridimensional suave por interpolación polinómica (smootherstep local). */
export function noise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  const nx00 = n000 + (n100 - n000) * ux;
  const nx10 = n010 + (n110 - n010) * ux;
  const nx01 = n001 + (n101 - n001) * ux;
  const nx11 = n011 + (n111 - n011) * ux;

  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;

  return nxy0 + (nxy1 - nxy0) * uz;
}

/** Interpolación lineal entre dos valores. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Suavizado quíntico de Ken Perlin usado en las transiciones de scroll (quintic smootherstep). */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Triángulo proyectado en pantalla con lote cromático cuantizado: `colorId` indexa la tabla de
 * colores del estado del compositor, `alphaLevel` cubre 0..15 niveles y `widthId` 0/1 selecciona
 * el grosor de trazo. La rotación propia llega como coseno/seno precalculados (el pintor no
 * vuelve a llamar a `Math.cos`).
 */
export interface ProjectedTriangle {
  sx: number;
  sy: number;
  z: number;
  r: number;
  cosZ: number;
  sinZ: number;
  squash: number;
  colorId: number;
  alphaLevel: number;
  widthId: number;
}

/** Estado del puntero con amortiguación exponencial (paralaje y repulsión elástica). */
export interface PointerState {
  x: number;
  y: number;
  normX: number;
  normY: number;
  smoothX: number;
  smoothY: number;
  active: boolean;
}

/** Muestreo anatómico del cerebro por partícula (etapa 1: contorno, giros, temporal, cerebelo y tronco). */
export interface BrainSample {
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly brainColor: string;
  readonly isRim: boolean;
}

/** Muestreo de la red de nodos y conectores (etapa 2: concentradores, cadenas y polvo de datos). */
export interface NetworkSample {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly networkColor: string;
  readonly isNetworkHub: boolean;
  readonly isNetworkEdge: boolean;
  readonly pulsePhase: number;
}

/** Muestreo cartográfico del planeta Tierra por partícula (etapa 3: costa, masa, retícula y órbita). */
export interface WorldSample {
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly worldColor: string;
  readonly isOceanGrid: boolean;
  readonly isOrbital: boolean;
  readonly isCoastline: boolean;
}

/** Lienzo base Auros Light (#f2fbf9) sobre el que se dibuja cada fotograma del fondo. */
export const CANVAS_BACKGROUND = '#f2fbf9';
/** Ancho de viewport por debajo del cual se reduce la densidad de la constelación (móvil). */
export const COMPACT_VIEWPORT_BREAKPOINT = 768;
/** Densidad de microtriángulos y glifos ambientales por terminal (calibrada para 60 fps sostenidos). */
export const DESKTOP_NODE_COUNT = 3000;
export const COMPACT_NODE_COUNT = 1500;
export const DESKTOP_GLYPH_COUNT = 96;
export const COMPACT_GLYPH_COUNT = 56;
/** Presupuesto total de píxeles del lienzo (acota el área pintada en pantallas retina y 4K). */
export const MAX_CANVAS_PIXELS = 2_600_000;
/** Cotas de densidad de píxeles: techo retina (1.5) y suelo de nitidez (0.75). */
export const MAX_DEVICE_PIXEL_RATIO = 1.5;
export const MIN_DEVICE_PIXEL_RATIO = 0.75;
/** Distancia focal de la proyección en perspectiva de las tres esculturas. */
export const PERSPECTIVE_FOV = 780;
/** Tiempo congelado (segundos) del fotograma único cuando el usuario reduce el movimiento. */
export const STATIC_MOTION_TIME = 2.6;
/** Rango de transición Cerebro → Red de nodos sobre el progreso de scroll (0..1). */
export const BRAIN_TO_NETWORK_RANGE: readonly [number, number] = [0.12, 0.42];
/** Rango de transición Red de nodos → Planeta Tierra sobre el progreso de scroll (0..1). */
export const NETWORK_TO_WORLD_RANGE: readonly [number, number] = [0.58, 0.88];

/** Transformación de pantalla de una etapa: deriva relativa y escala uniforme de la escultura. */
export interface StageScreenTransform {
  /** Deriva horizontal como fracción del ancho del viewport (positiva hacia la derecha). */
  readonly offsetX: number;
  /** Deriva vertical como fracción de la altura del viewport (negativa hacia arriba). */
  readonly offsetY: number;
  /** Escala uniforme adicional aplicada a las posiciones proyectadas. */
  readonly scale: number;
}

/** El Cerebro inicial deriva a la zona derecha del hero (círculo libre de texto) y se compacta. */
export const BRAIN_SCREEN_TRANSFORM: StageScreenTransform = { offsetX: 0.315, offsetY: -0.02, scale: 0.7 };
/** Deriva y escala del Cerebro en viewports angostos (el hero apila el contenido en una columna). */
export const BRAIN_COMPACT_OFFSET_FACTOR = 0.12;
export const BRAIN_COMPACT_SCALE = 0.84;
/** Ancho mínimo de viewport para activar la deriva lateral del Cerebro (debajo: recentrado). */
export const BRAIN_SIDE_SHIFT_MIN_WIDTH = 1024;
