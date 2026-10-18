/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-render-state.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — estado del compositor)
 * @proposito
 *   Estado mutable reutilizado fotograma a fotograma por el compositor del fondo vivo: búfer de
 *   triángulos proyectados, tabla cromática con identificadores por nodo, rejilla de conteo por
 *   profundidad (orden de pintura sin `sort`), lotes cromáticos con reciclado de arreglos y las
 *   constantes de cuantización compartidas (rodajas de profundidad y niveles de transparencia).
 *   Se crea una sola vez por montaje: el bucle caliente no asigna memoria.
 *
 * @resumen_contenido
 *   - `ConstellationRenderState`: contrato del estado persistente del compositor.
 *   - `createConstellationRenderState(nodes)`: prepara búfer, tabla de colores y rejillas.
 *   - `DEPTH_SLICES` / `ALPHA_STEPS`: cuantización de profundidad y transparencia por lote.
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (tipos `BackdropNode` y `ProjectedTriangle`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (capa de presentación pura: no accede a datos).
 */

import type { BackdropNode, ProjectedTriangle } from './dala-constellation-geometry';

/** Rodajas de profundidad del pintor (de atrás hacia adelante). */
export const DEPTH_SLICES = 8;
/** Niveles de transparencia cuantizados por lote (fracción pintada: `alphaLevel / ALPHA_STEPS`). */
export const ALPHA_STEPS = 15;
/** Tabla de lotes indexada por `colorId(5 bits) | alphaLevel(4 bits) | widthId(1 bit)`. */
const BUCKET_TABLE_SIZE = 1 << 10;

/** Estado reutilizado fotograma a fotograma: cero asignaciones en el bucle caliente. */
export interface ConstellationRenderState {
  /** Búfer de triángulos proyectados (un elemento por nodo). */
  readonly buffer: ProjectedTriangle[];
  /** Identificador cromático de cada nodo por etapa (índice en `colorTable`). */
  readonly brainColorIds: Uint8Array;
  readonly networkColorIds: Uint8Array;
  readonly worldColorIds: Uint8Array;
  /** Tabla de colores únicos presentes en la constelación. */
  readonly colorTable: readonly string[];
  /** Conteo por profundidad: rodaja por elemento, arranques por rodaja y cursor de relleno. */
  readonly sliceOf: Int32Array;
  readonly sliceStart: Int32Array;
  readonly sliceCursor: Int32Array;
  readonly depthOrder: Int32Array;
  /** Lotes cromáticos por rodaja (índice → coordenadas concatenadas) con reciclado de arreglos. */
  readonly buckets: Array<number[] | null>;
  readonly usedBucketKeys: number[];
  readonly bucketPool: number[][];
  /** Coseno/seno de la torsión espiral por carril (`i % 4`) durante las transiciones. */
  readonly twistCos: Float64Array;
  readonly twistSin: Float64Array;
}

/** Prepara el estado del compositor: tabla cromática, búfer y rejillas de conteo. */
export function createConstellationRenderState(nodes: readonly BackdropNode[]): ConstellationRenderState {
  const colorIndex = new Map<string, number>();
  const colorTable: string[] = [];
  const registerColor = (color: string): number => {
    const existing = colorIndex.get(color);
    if (existing !== undefined) {
      return existing;
    }
    const id = colorTable.length;
    colorIndex.set(color, id);
    colorTable.push(color);
    return id;
  };

  const count = nodes.length;
  const buffer: ProjectedTriangle[] = new Array<ProjectedTriangle>(count);
  const brainColorIds = new Uint8Array(count);
  const networkColorIds = new Uint8Array(count);
  const worldColorIds = new Uint8Array(count);

  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    if (node === undefined) {
      continue;
    }
    brainColorIds[i] = registerColor(node.brainColor);
    networkColorIds[i] = registerColor(node.networkColor);
    worldColorIds[i] = registerColor(node.worldColor);
    buffer[i] = { sx: 0, sy: 0, z: 0, r: 0, cosZ: 1, sinZ: 0, squash: 1, colorId: 0, alphaLevel: ALPHA_STEPS, widthId: 0 };
  }

  return {
    buffer,
    brainColorIds,
    networkColorIds,
    worldColorIds,
    colorTable,
    sliceOf: new Int32Array(count),
    sliceStart: new Int32Array(DEPTH_SLICES + 1),
    sliceCursor: new Int32Array(DEPTH_SLICES),
    depthOrder: new Int32Array(count),
    buckets: new Array<number[] | null>(BUCKET_TABLE_SIZE).fill(null),
    usedBucketKeys: [],
    bucketPool: [],
    twistCos: new Float64Array(4),
    twistSin: new Float64Array(4),
  };
}
