/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-network-map.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — Grafo Neuronal RAG 3D)
 * @proposito
 *   Geometría analítica pura del Grafo Neuronal y Memoria RAG 3D:
 *   Sustituye cualquier nube informe por una escultura icónica con silueta reconocible al instante:
 *   - 15 nodos neuronales con anillos circulares definidos (núcleo central SHA-256 dorado radiante,
 *     anillo interior cognitivo en rombo y anillo exterior de efectores y percepción).
 *   - 32 vías axonales nítidas con amplio espacio negativo (sin cruces masivos que empasten).
 *   - 2 anillos giroscópicos orbitales que abrazan el núcleo SHA-256.
 *   - Polvo de fondo sutil y disperso que da profundidad sin ensuciar la silueta central.
 *
 * @resumen_contenido
 *   - `GRAPH_NODES`: 15 nodos con posiciones 3D, roles, radios y colores Auros.
 *   - `GRAPH_EDGES`: 32 conexiones axonales seleccionadas con aire y respiración visual.
 *   - `ORBITAL_RINGS`: 2 órbitas inclinadas que rodean el núcleo SHA-256.
 *   - `resolveNetworkSample(index)`: resuelve nodos, axones, órbitas o polvo ambiental en O(1).
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (paleta, hash y tipo `NetworkSample`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (módulo puramente matemático de renderizado 3D).
 */

import { BACKDROP_COLORS as COLORS, hash, type NetworkSample } from './dala-constellation-geometry';

/** Nodo funcional del grafo neuronal con posición tridimensional y parámetros de anillo. */
interface GraphNode {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: string;
  readonly isCore: boolean;
  readonly ringRadius: number;
  readonly phase: number;
}

/**
 * 15 nodos distribuidos en una topología elíptica icónica (ancho 270, alto 220, profundidad 60):
 * - Nodo 0: Núcleo central SHA-256 en (0, 0, 0), prominente y radiante.
 * - Nodos 1-4: Anillo cognitivo intermedio en rombo a radio ~68 unidades.
 * - Nodos 5-14: Anillo sensorial y efector exterior a radio ~125 unidades.
 */
const GRAPH_NODES: readonly GraphNode[] = [
  // 0. Núcleo central SHA-256 (ancla dorada brillante)
  { x: 0, y: 0, z: 0, color: COLORS.amberBright, isCore: true, ringRadius: 18, phase: 0.0 },

  // Anillo intermedio cognitivo (rombo a radio ~68)
  { x: -68, y: -12, z: 20, color: COLORS.cyan, isCore: false, ringRadius: 11, phase: 0.8 }, // 1. Percepción
  { x: 68, y: -12, z: -20, color: COLORS.amberRim, isCore: false, ringRadius: 11, phase: 1.6 }, // 2. Ejecución
  { x: 0, y: -68, z: -18, color: COLORS.violet, isCore: false, ringRadius: 11, phase: 2.4 }, // 3. Prompts / Razonamiento
  { x: 0, y: 68, z: 18, color: COLORS.teal, isCore: false, ringRadius: 11, phase: 3.2 }, // 4. Memoria Vectorial HNSW

  // Anillo exterior perceptual y de acciones (radio ~120 - 135 con amplio espacio negativo)
  { x: -130, y: -58, z: -24, color: COLORS.cyan, isCore: false, ringRadius: 8.5, phase: 0.4 }, // 5. Audio / VAD Gate
  { x: -140, y: 0, z: 28, color: COLORS.teal, isCore: false, ringRadius: 8.5, phase: 1.1 }, // 6. Observador DOM
  { x: -120, y: 60, z: -18, color: COLORS.cyan, isCore: false, ringRadius: 8.5, phase: 1.8 }, // 7. Inspector CDP
  { x: -50, y: -112, z: 22, color: COLORS.violet, isCore: false, ringRadius: 8.5, phase: 2.5 }, // 8. Clasificador
  { x: 50, y: -112, z: -22, color: COLORS.magenta, isCore: false, ringRadius: 8.5, phase: 3.1 }, // 9. Guardrails
  { x: 122, y: -54, z: 25, color: COLORS.amberBright, isCore: false, ringRadius: 8.5, phase: 3.7 }, // 10. Click DOM
  { x: 138, y: 4, z: -24, color: COLORS.amberRim, isCore: false, ringRadius: 8.5, phase: 4.3 }, // 11. Type DOM
  { x: 118, y: 62, z: 18, color: COLORS.violet, isCore: false, ringRadius: 8.5, phase: 4.9 }, // 12. Auditoría SOC2
  { x: 52, y: 110, z: -20, color: COLORS.amberBright, isCore: false, ringRadius: 8.5, phase: 5.5 }, // 13. Tarificación
  { x: -52, y: 110, z: 20, color: COLORS.teal, isCore: false, ringRadius: 8.5, phase: 6.1 }, // 14. Embeddings 1536d
];

/** Conexión axonal entre dos nodos del grafo. */
interface GraphEdge {
  readonly a: number;
  readonly b: number;
}

/**
 * 32 conexiones sinápticas seleccionadas con aire:
 * Conectan la estructura de forma clara, legible y sin generar una maraña densa.
 */
const GRAPH_EDGES: readonly GraphEdge[] = [
  // Rayos principales desde el Núcleo Central hacia los 4 nodos cardinales
  { a: 0, b: 1 },
  { a: 0, b: 2 },
  { a: 0, b: 3 },
  { a: 0, b: 4 },

  // Rombo interior que interconecta los 4 nodos cardinales
  { a: 1, b: 3 },
  { a: 3, b: 2 },
  { a: 2, b: 4 },
  { a: 4, b: 1 },

  // Ramas del Nodo Izquierdo (Percepción) hacia la periferia izquierda
  { a: 1, b: 5 },
  { a: 1, b: 6 },
  { a: 1, b: 7 },

  // Ramas del Nodo Superior (Prompts) hacia la periferia superior
  { a: 3, b: 8 },
  { a: 3, b: 9 },
  { a: 3, b: 5 },
  { a: 3, b: 10 },

  // Ramas del Nodo Derecho (Acciones) hacia la periferia derecha
  { a: 2, b: 10 },
  { a: 2, b: 11 },
  { a: 2, b: 12 },

  // Ramas del Nodo Inferior (HNSW) hacia la periferia inferior
  { a: 4, b: 13 },
  { a: 4, b: 14 },
  { a: 4, b: 7 },
  { a: 4, b: 12 },

  // Arcos perimetrales de contorno exterior (silueta curva)
  { a: 5, b: 8 },
  { a: 8, b: 9 },
  { a: 9, b: 10 },
  { a: 10, b: 11 },
  { a: 11, b: 12 },
  { a: 12, b: 13 },
  { a: 13, b: 14 },
  { a: 14, b: 7 },
  { a: 7, b: 6 },
  { a: 6, b: 5 },
];

/** Partículas asignadas al núcleo central (triple anillo estelar). */
const CORE_PARTICLES = 36;
/** Partículas asignadas a cada nodo periférico (anillo circular visible). */
const NODE_PARTICLES = 16;
/** Partículas a lo largo de cada una de las 32 conexiones axonales. */
const PARTICLES_PER_EDGE = 24;
/** Partículas de los dos anillos giroscópicos orbitales. */
const ORBITAL_PARTICLES = 160;

/** Zonas de corte por índice: */
export const NETWORK_HUB_ZONE = CORE_PARTICLES + (GRAPH_NODES.length - 1) * NODE_PARTICLES; // 36 + 14 * 16 = 260
export const NETWORK_EDGE_ZONE = NETWORK_HUB_ZONE + GRAPH_EDGES.length * PARTICLES_PER_EDGE; // 260 + 32 * 24 = 1028
const NETWORK_ORBITAL_ZONE = NETWORK_EDGE_ZONE + ORBITAL_PARTICLES; // 1028 + 160 = 1188

/**
 * Resuelve una partícula asignada a un nodo (cuerpo neuronal circular definido):
 * Para el núcleo central: triple corona concéntrica.
 * Para los satélites: anillo circular de microtriángulos claramente visible.
 */
function resolveNodeParticle(index: number): NetworkSample {
  if (index < CORE_PARTICLES) {
    // Núcleo central SHA-256 (Nodo 0): centro denso + 2 anillos radiantes
    const node = GRAPH_NODES[0]!;
    if (index < 6) {
      // Centro compacto
      const angle = (index / 6) * Math.PI * 2;
      return {
        nx: Math.cos(angle) * 3.5,
        ny: Math.sin(angle) * 3.5,
        nz: (index % 2 === 0 ? 1 : -1) * 2.5,
        networkColor: COLORS.amberBright,
        isNetworkHub: true,
        isNetworkEdge: false,
        pulsePhase: 0,
      };
    }
    if (index < 18) {
      // Primer anillo
      const k = index - 6;
      const angle = (k / 12) * Math.PI * 2;
      return {
        nx: Math.cos(angle) * 9.5,
        ny: Math.sin(angle) * 9.5 * 0.9,
        nz: Math.sin(angle * 2) * 4,
        networkColor: COLORS.amberRim,
        isNetworkHub: true,
        isNetworkEdge: false,
        pulsePhase: 0.8,
      };
    }
    // Segundo anillo exterior
    const k = index - 18;
    const angle = (k / 18) * Math.PI * 2;
    return {
      nx: Math.cos(angle) * node.ringRadius,
      ny: Math.sin(angle) * node.ringRadius * 0.88,
      nz: Math.cos(angle * 3) * 5,
      networkColor: COLORS.amberBright,
      isNetworkHub: true,
      isNetworkEdge: false,
      pulsePhase: 1.6,
    };
  }

  // Nodos satélite 1 a 14
  const satelliteIndex = index - CORE_PARTICLES;
  const nodeIndex = 1 + Math.floor(satelliteIndex / NODE_PARTICLES);
  const k = satelliteIndex % NODE_PARTICLES;
  const node = GRAPH_NODES[nodeIndex] ?? GRAPH_NODES[1]!;

  if (k < 3) {
    // Punto central del nodo
    return {
      nx: node.x + (k - 1) * 1.5,
      ny: node.y,
      nz: node.z + (k === 1 ? 2 : -2),
      networkColor: node.color,
      isNetworkHub: true,
      isNetworkEdge: false,
      pulsePhase: node.phase,
    };
  }

  // Anillo circular nítido que delimita el nodo
  const stepInRing = k - 3;
  const ringSteps = NODE_PARTICLES - 3; // 13 puntos en el anillo
  const angle = (stepInRing / ringSteps) * Math.PI * 2 + node.phase;

  const nx = node.x + Math.cos(angle) * node.ringRadius;
  const ny = node.y + Math.sin(angle) * node.ringRadius * 0.92;
  const nz = node.z + Math.sin(angle * 2) * 3.5;

  return {
    nx,
    ny,
    nz,
    networkColor: node.color,
    isNetworkHub: true,
    isNetworkEdge: false,
    pulsePhase: node.phase,
  };
}

/**
 * Resuelve una partícula a lo largo de un axón lineal:
 * Distribuye 24 partículas uniformemente entre el nodo A y el nodo B,
 * dejando claro el camino sináptico sin amontonamiento ni ruido.
 */
function resolveEdgeParticle(index: number): NetworkSample {
  const edgeRelIndex = index - NETWORK_HUB_ZONE;
  const edgeIndex = Math.floor(edgeRelIndex / PARTICLES_PER_EDGE);
  const stepInEdge = edgeRelIndex % PARTICLES_PER_EDGE;

  const edge = GRAPH_EDGES[edgeIndex % GRAPH_EDGES.length]!;
  const nodeA = GRAPH_NODES[edge.a]!;
  const nodeB = GRAPH_NODES[edge.b]!;

  // Fracción a lo largo del enlace (del 0.08 al 0.92 para no pisar el centro de los nodos)
  const t = 0.08 + (stepInEdge / (PARTICLES_PER_EDGE - 1)) * 0.84;

  // Arco sutil en 3D para que los enlaces no sean cuerdas rígidas
  const arcLift = Math.sin(t * Math.PI) * 6;

  const nx = nodeA.x + (nodeB.x - nodeA.x) * t;
  const ny = nodeA.y + (nodeB.y - nodeA.y) * t;
  const nz = nodeA.z + (nodeB.z - nodeA.z) * t + arcLift;

  const color = t < 0.5 ? nodeA.color : nodeB.color;

  return {
    nx,
    ny,
    nz,
    networkColor: color,
    isNetworkHub: false,
    isNetworkEdge: true,
    pulsePhase: t * Math.PI * 2 + nodeA.phase,
  };
}

/**
 * Resuelve una partícula de los anillos giroscópicos cuánticos que rodean al núcleo:
 * Dos órbitas circulares inclinadas en ángulos opuestos (±38°) que dan profundidad y movimiento.
 */
function resolveOrbitalParticle(index: number): NetworkSample {
  const orbitalRel = index - NETWORK_EDGE_ZONE;
  const ringId = orbitalRel < 80 ? 0 : 1;
  const k = orbitalRel % 80;
  const angle = (k / 80) * Math.PI * 2;

  const radius = ringId === 0 ? 36 : 46;
  const tilt = ringId === 0 ? 0.62 : -0.68;

  const px = Math.cos(angle) * radius;
  const pz = Math.sin(angle) * radius;
  const py = pz * Math.sin(tilt);
  const finalZ = pz * Math.cos(tilt);

  return {
    nx: px,
    ny: py,
    nz: finalZ,
    networkColor: ringId === 0 ? COLORS.amberBright : COLORS.violet,
    isNetworkHub: false,
    isNetworkEdge: true,
    pulsePhase: angle,
  };
}

/**
 * Resuelve una partícula de la atmósfera de profundidad (polvo de fondo estelar):
 * Dispersa las partículas restantes en un volumen esférico amplio (radio 160 a 340 unidades)
 * con baja opacidad en el compositor para no saturar ni competir con la escultura central.
 */
function resolveAmbientDust(index: number): NetworkSample {
  const seed1 = hash(index * 4.31 + 1.7);
  const seed2 = hash(index * 7.89 + 3.2);
  const seed3 = hash(index * 9.17 + 5.9);

  const radius = 160 + seed1 * 180;
  const theta = seed2 * Math.PI * 2;
  const phi = (seed3 - 0.5) * Math.PI * 0.75;

  const nx = Math.cos(theta) * Math.cos(phi) * radius;
  const ny = Math.sin(phi) * radius * 0.65;
  const nz = Math.sin(theta) * Math.cos(phi) * radius * 0.6;

  const color = seed3 < 0.4 ? COLORS.cyan : seed3 < 0.75 ? COLORS.violet : COLORS.teal;

  return {
    nx,
    ny,
    nz,
    networkColor: color,
    isNetworkHub: false,
    isNetworkEdge: false,
    pulsePhase: seed1 * Math.PI * 2,
  };
}

/**
 * Resuelve la posición analítica exacta de la partícula en la etapa 2:
 * Nodo circular, axón lineal, anillo orbital o polvo estelar ambiental en O(1).
 */
export function resolveNetworkSample(index: number): NetworkSample {
  if (index < NETWORK_HUB_ZONE) {
    return resolveNodeParticle(index);
  }
  if (index < NETWORK_EDGE_ZONE) {
    return resolveEdgeParticle(index);
  }
  if (index < NETWORK_ORBITAL_ZONE) {
    return resolveOrbitalParticle(index);
  }
  return resolveAmbientDust(index);
}
