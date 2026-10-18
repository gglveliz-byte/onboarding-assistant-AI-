/**
 * @archivo apps/web/src/components/landing/hero/useAcousticSpherePhysics.ts
 * @modulo 12. Landing Publica Comercial: Hero (Subagente 1.4)
 * @proposito
 *   Hook de fisica acustica de la Esfera Bioluminiscente del hero: nube de 420 particulas
 *   bioluminiscentes sobre una esfera unitaria (espiral de Fibonacci), resolucion en vivo
 *   de las anclas DOM `[data-oa-id]` y handle mutable de alta frecuencia que el lienzo
 *   Canvas 2D consume a 60 FPS sin re-renders de React.
 * @resumen_contenido
 *   - `SphereAnchor` + `SPHERE_ANCHOR_TARGETS`: anclas con coordenadas normalizadas 0..1
 *     del viewport y los 4 objetivos congelados del hero (`btn-new-deal`,
 *     `input-company-tax`, `btn-validate-cfdi` y `nav-billing`).
 *   - `resolveDomAnchorPositions()`: mide `getBoundingClientRect()` de cada selector con
 *     respaldos deterministas mientras 1.5 monta los elementos; nunca lanza excepciones.
 *   - `AcousticParticleState` / `AcousticAnchorFlow` / `AcousticSpherePhysicsHandle`:
 *     estado mutable de alta frecuencia (tinte, deriva, profundidad z) y comandos
 *     (`setCursorTarget`, `setEnergyLevel`, `setActive`, `refreshAnchors`, `step`).
 *   - `useAcousticSpherePhysics()`: paralaje de cursor interpolado, respiracion idle
 *     (~6 s, amplitud baja) y energia externa 0..1 tipo espectro de PCM16 a 16 kHz.
 * @dependencias_internas
 *   - Consumido por `./BioluminescentVoiceDomSphere.tsx` (mismo Subagente 1.4).
 * @dependencias_externas
 *   - `react` (hooks `useCallback`, `useEffect`, `useMemo`, `useState`); cero motores 3D:
 *     la proyeccion ortografica es aritmetica pura sobre Canvas 2D.
 * @tablas_bd_o_redis
 *   - Ninguna (simulacion visual en memoria del navegador).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

/** Cantidad por defecto de particulas (contrato congelado) y paleta bioluminiscente de 5 colores. */
const DEFAULT_PARTICLE_COUNT = 420;
const PARTICLE_TINTS: readonly [string, string, string, string, string] = [
  '#00827C', // Teal bioluminiscente primario
  '#00B8B0', // Cyan luminiscente suave
  '#7A28CB', // Orquídea bioluminiscente
  '#15846E', // Verde esmeralda profundo
  '#FFB829', // Chispa azafrán dorada
];
/** Angulo aureo de Fibonacci: reparte la nube de forma uniforme sobre la esfera. */
const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));
/** Respiracion idle sin energia externa: periodo de ~6 s y amplitud baja. */
const IDLE_BREATH_PERIOD_MS = 6000;
const IDLE_ENERGY_BASE = 0.24;
const IDLE_ENERGY_AMPLITUDE = 0.12;
/** Cotas de la simulacion: paso maximo, paralaje, giro ambiente y multiplicadores. */
const MAX_STEP_DELTA_MS = 64;
const CURSOR_PARALLAX_GAIN = 0.85;
const CURSOR_EASE_PER_MS = 0.0022;
const AMBIENT_YAW_PER_MS = 0.00006;
const ACTIVE_DRIFT_MULTIPLIER = 1.45;
/** Debounce ligero de la re-resolucion de anclas en el evento `resize`. */
const RESIZE_DEBOUNCE_MS = 160;
/** Respaldo determinista (esfera centrada en 0.5/0.48) si no hay DOM o elemento. */
const ANCHOR_FALLBACK_DEFAULT: { readonly xNorm: number; readonly yNorm: number } = { xNorm: 0.5, yNorm: 0.48 };
const ANCHOR_FALLBACK_POSITIONS: Readonly<Record<string, { readonly xNorm: number; readonly yNorm: number }>> = {
  'btn-new-deal': { xNorm: 0.74, yNorm: 0.32 },
  'input-company-tax': { xNorm: 0.62, yNorm: 0.58 },
  'btn-validate-cfdi': { xNorm: 0.8, yNorm: 0.68 },
  'nav-billing': { xNorm: 0.88, yNorm: 0.44 },
};
/** Velocidades de bucle (ciclos por ms) de los 4 flujos cineticos de ancla. */
const ANCHOR_FLOW_SPEEDS: readonly [number, number, number, number] = [0.00028, 0.00034, 0.00024, 0.00031];

/** Ancla DOM resuelta: centro del `getBoundingClientRect` normalizado al viewport. */
export interface SphereAnchor {
  readonly id: string;
  readonly selector: string;
  readonly xNorm: number;
  readonly yNorm: number;
  readonly isResolved: boolean;
}

/** Objetivos congelados del hero: ids y selectores literales no negociables con 1.5. */
export const SPHERE_ANCHOR_TARGETS: readonly { readonly id: string; readonly selector: string }[] = [
  { id: 'btn-new-deal', selector: '[data-oa-id="btn-new-deal"]' },
  { id: 'input-company-tax', selector: '[data-oa-id="input-company-tax"]' },
  { id: 'btn-validate-cfdi', selector: '[data-oa-id="btn-validate-cfdi"]' },
  { id: 'nav-billing', selector: '[data-oa-id="nav-billing"]' },
];

/** Estado mutable de alta frecuencia: coordenadas morfeables en 3 formas y posición activa. */
export interface AcousticParticleState {
  readonly tint: string;
  readonly baseX: number;
  readonly baseY: number;
  readonly baseZ: number;
  readonly brainX: number;
  readonly brainY: number;
  readonly brainZ: number;
  readonly voiceX: number;
  readonly voiceY: number;
  readonly voiceZ: number;
  readonly logoX: number;
  readonly logoY: number;
  readonly logoZ: number;
  readonly phase: number;
  readonly driftSpeed: number;
  readonly weight: number;
  x: number;
  y: number;
  z: number;
}

/** Vector cinetico en bucle hacia el punto de ancla (`progress` 0..1, luego reinicia). */
export interface AcousticAnchorFlow {
  readonly anchorId: string;
  readonly offsetJitter: number;
  progress: number;
}

/** Contrato del handle de simulacion consumido por el renderizador Canvas 2D. */
export interface AcousticSpherePhysicsHandle {
  readonly particles: readonly AcousticParticleState[];
  readonly anchors: readonly SphereAnchor[];
  readonly anchorFlows: readonly AcousticAnchorFlow[];
  readonly energy: number;
  readonly scrollProgress: number;
  setCursorTarget(xNorm: number, yNorm: number): void;
  setScrollProgress(progress: number): void;
  setEnergyLevel(level: number): void;
  setActive(active: boolean): void;
  refreshAnchors(): void;
  step(deltaMs: number): void;
}

/** Estado interno mutable de la simulacion (vive fuera del ciclo de render de React). */
type MutableSimulation = ReturnType<typeof createSimulation>;

/** Limita un numero al rango [min, max]; los no finitos caen al minimo. */
function clampRange(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** Respaldo determinista de un objetivo no medible (documentado en el encabezado). */
function createFallbackAnchor(target: { readonly id: string; readonly selector: string }): SphereAnchor {
  const fallback = ANCHOR_FALLBACK_POSITIONS[target.id] ?? ANCHOR_FALLBACK_DEFAULT;
  return { id: target.id, selector: target.selector, xNorm: fallback.xNorm, yNorm: fallback.yNorm, isResolved: false };
}

/** Genera la nube morfeable con silueta de Cerebro 🧠, Aura Acústica y Prisma del Logo. */
function createParticles(count: number): AcousticParticleState[] {
  const total = count > 0 ? Math.floor(count) : DEFAULT_PARTICLE_COUNT;
  const particles: AcousticParticleState[] = [];
  for (let index = 0; index < total; index += 1) {
    const vertical = total === 1 ? 0 : 1 - (index / (total - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    const theta = GOLDEN_ANGLE_RAD * index;
    const baseX = Math.cos(theta) * ring;
    const baseZ = Math.sin(theta) * ring;
    const baseY = vertical;

    // Silueta orgánica viva de Cerebro Humano 🧠 (dos hemisferios con corteza plegada)
    const hemisphere = index % 2 === 0 ? 1 : -1;
    const u = (index / total) * Math.PI;
    const v = (((index * 7) % total) / total) * Math.PI * 2;
    const sulcusFold = 1 + 0.11 * Math.sin(6 * theta) * Math.cos(4 * vertical);
    const brainX = hemisphere * (0.24 + 0.54 * Math.sin(u) * Math.cos(v) * sulcusFold);
    const brainY = 0.8 * Math.cos(u) * (1 + 0.12 * Math.sin(5 * v)) * sulcusFold;
    const brainZ = 0.64 * Math.sin(u) * Math.sin(v) * sulcusFold;

    // Aura Acústica del Asistente de Voz (ondas y frentes concéntricos)
    const ringTier = (index % 7) + 1;
    const ringRadius = 0.32 + (ringTier / 7) * 0.68;
    const waveTheta = theta + ringTier * 0.45;
    const voiceX = ringRadius * Math.cos(waveTheta) * ring;
    const voiceY = ringRadius * vertical * 0.95;
    const voiceZ = ringRadius * Math.sin(waveTheta) * ring;

    // Prisma Hexagonal del Logotipo Oficial y nodos DOM
    const hexSide = index % 6;
    const hexAngle = (hexSide / 6) * Math.PI * 2;
    const hexLevel = ((index % 5) - 2) * 0.36;
    const hexRadius = 0.84 * (1 - Math.abs(hexLevel) * 0.3);
    const logoX = hexRadius * Math.cos(hexAngle);
    const logoY = hexLevel;
    const logoZ = hexRadius * Math.sin(hexAngle);

    particles.push({
      tint: PARTICLE_TINTS[index % PARTICLE_TINTS.length] ?? PARTICLE_TINTS[0],
      baseX,
      baseY,
      baseZ,
      brainX,
      brainY,
      brainZ,
      voiceX,
      voiceY,
      voiceZ,
      logoX,
      logoY,
      logoZ,
      phase: (index * GOLDEN_ANGLE_RAD) % (Math.PI * 2),
      driftSpeed: 0.55 + ((index * 7) % 13) / 13,
      weight: 0.45 + (((index * 29) % 23) / 23) * 0.55,
      x: brainX,
      y: brainY,
      z: brainZ,
    });
  }
  return particles;
}

/** Construye el estado mutable inicial: particulas, anclas resueltas y 4 flujos. */
function createSimulation(particleCount: number, initialEnergy: number | null) {
  return {
    particles: createParticles(particleCount),
    anchors: resolveDomAnchorPositions(),
    anchorFlows: SPHERE_ANCHOR_TARGETS.map((target, index): AcousticAnchorFlow => ({
      anchorId: target.id,
      offsetJitter: ((index * 97) % 11) / 11,
      progress: (index * 0.27) % 1,
    })),
    externalEnergy: initialEnergy,
    isActive: false,
    elapsedMs: 0,
    energy: initialEnergy ?? IDLE_ENERGY_BASE,
    scrollProgress: 0,
    cursorX: 0.5,
    cursorY: 0.5,
    yaw: 0,
    pitch: 0,
    targetYaw: 0,
    targetPitch: 0,
  };
}

/**
 * Mide los 4 selectores congelados en el DOM real y devuelve sus centros normalizados al
 * viewport (clamp 0..1). Defensiva: sin navegador, sin `root` o sin elemento aplica el
 * respaldo determinista con `isResolved: false` y jamas lanza excepciones.
 */
export function resolveDomAnchorPositions(root?: ParentNode | null): readonly SphereAnchor[] {
  const canUseDom = typeof document !== 'undefined' && typeof window !== 'undefined';
  const queryRoot: ParentNode | null = root ?? (canUseDom ? document : null);
  const viewportWidth = canUseDom ? window.innerWidth : 0;
  const viewportHeight = canUseDom ? window.innerHeight : 0;
  const canMeasure = queryRoot !== null && viewportWidth > 0 && viewportHeight > 0;

  return SPHERE_ANCHOR_TARGETS.map((target): SphereAnchor => {
    if (!canMeasure || queryRoot === null) return createFallbackAnchor(target);
    try {
      const element = queryRoot.querySelector(target.selector);
      if (element === null) return createFallbackAnchor(target);
      const rect = element.getBoundingClientRect();
      return {
        id: target.id,
        selector: target.selector,
        xNorm: clampRange((rect.left + rect.width / 2) / viewportWidth, 0, 1),
        yNorm: clampRange((rect.top + rect.height / 2) / viewportHeight, 0, 1),
        isResolved: true,
      };
    } catch {
      return createFallbackAnchor(target);
    }
  });
}

/** Avanza la fisica un delta: morfismo con scroll, energia, rotacion y deriva. */
function stepSimulation(simulation: MutableSimulation, deltaMs: number): void {
  const dt = clampRange(deltaMs, 0, MAX_STEP_DELTA_MS);
  simulation.elapsedMs += dt;
  const driftTimeMs = simulation.elapsedMs * (simulation.isActive ? ACTIVE_DRIFT_MULTIPLIER : 1);
  const idleEnergy = IDLE_ENERGY_BASE + IDLE_ENERGY_AMPLITUDE * Math.sin((simulation.elapsedMs / IDLE_BREATH_PERIOD_MS) * Math.PI * 2);
  const energy = clampRange(simulation.externalEnergy ?? idleEnergy, 0, 1);
  simulation.energy = energy;

  const ease = Math.min(1, dt * CURSOR_EASE_PER_MS);
  simulation.yaw += (simulation.targetYaw - simulation.yaw) * ease;
  simulation.pitch += (simulation.targetPitch - simulation.pitch) * ease;
  const yaw = simulation.yaw + driftTimeMs * AMBIENT_YAW_PER_MS;
  const pitch = simulation.pitch + Math.sin(driftTimeMs * 0.00021) * 0.06;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const radiusScale = 0.86 + 0.14 * energy;
  const jitterAmplitude = 0.02 + 0.07 * energy;

  // Calculo de interpolacion continua entre las 3 geometrias segun scrollProgress (0..1)
  // 0.00 a 0.25: Silueta organica viva de Cerebro Humano 🧠
  // 0.25 a 0.60: Transicion continua hacia el Aura Acustica del Asistente de Voz
  // 0.60 a 1.00: Reorganizacion hacia el Prisma Hexagonal del Logotipo y nodos DOM
  const scroll = simulation.scrollProgress;

  for (const particle of simulation.particles) {
    let morphX = particle.brainX;
    let morphY = particle.brainY;
    let morphZ = particle.brainZ;

    if (scroll <= 0.25) {
      // 100% Cerebro
      morphX = particle.brainX;
      morphY = particle.brainY;
      morphZ = particle.brainZ;
    } else if (scroll <= 0.6) {
      // Transicion Cerebro -> Aura Acustica
      const t = (scroll - 0.25) / 0.35;
      const smooth = t * t * (3 - 2 * t);
      morphX = particle.brainX * (1 - smooth) + particle.voiceX * smooth;
      morphY = particle.brainY * (1 - smooth) + particle.voiceY * smooth;
      morphZ = particle.brainZ * (1 - smooth) + particle.voiceZ * smooth;
    } else {
      // Transicion Aura Acustica -> Prisma Hexagonal
      const t = (scroll - 0.6) / 0.4;
      const smooth = t * t * (3 - 2 * t);
      morphX = particle.voiceX * (1 - smooth) + particle.logoX * smooth;
      morphY = particle.voiceY * (1 - smooth) + particle.logoY * smooth;
      morphZ = particle.voiceZ * (1 - smooth) + particle.logoZ * smooth;
    }

    const swell = 1 + jitterAmplitude * Math.sin(particle.phase + driftTimeMs * 0.0018 * particle.driftSpeed);
    const rotatedX = morphX * cosYaw + morphZ * sinYaw;
    const rotatedZ = morphZ * cosYaw - morphX * sinYaw;
    const rotatedY = morphY * cosPitch - rotatedZ * sinPitch;
    const depth = morphY * sinPitch + rotatedZ * cosPitch;
    const scale = radiusScale * swell;
    particle.x = rotatedX * scale;
    particle.y = rotatedY * scale;
    particle.z = clampRange(depth, -1, 1);
  }


  const flowDelta = dt * (simulation.isActive ? ACTIVE_DRIFT_MULTIPLIER : 1);
  for (let index = 0; index < simulation.anchorFlows.length; index += 1) {
    const flow = simulation.anchorFlows[index];
    if (flow === undefined) continue;
    flow.progress = (flow.progress + flowDelta * (ANCHOR_FLOW_SPEEDS[index] ?? 0)) % 1;
  }
}

/**
 * Hook principal: crea la simulacion una sola vez (estado mutable fuera del render),
 * re-resuelve anclas al montar y en `resize` con debounce ligero, y entrega comandos de
 * alta frecuencia estables para el bucle `requestAnimationFrame` del lienzo.
 */
export function useAcousticSpherePhysics(options?: {
  readonly particleCount?: number;
  readonly energyLevel?: number;
}): AcousticSpherePhysicsHandle {
  const particleCount = options?.particleCount ?? DEFAULT_PARTICLE_COUNT;
  const externalEnergyOption = options?.energyLevel;
  const [simulation] = useState<MutableSimulation>(() =>
    createSimulation(particleCount, externalEnergyOption === undefined ? null : clampRange(externalEnergyOption, 0, 1)),
  );

  useEffect(() => {
    simulation.externalEnergy = externalEnergyOption === undefined ? null : clampRange(externalEnergyOption, 0, 1);
  }, [simulation, externalEnergyOption]);

  useEffect(() => {
    simulation.anchors = resolveDomAnchorPositions();
    let debounceId = 0;
    const handleWindowResize = () => {
      window.clearTimeout(debounceId);
      debounceId = window.setTimeout(() => { simulation.anchors = resolveDomAnchorPositions(); }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      window.clearTimeout(debounceId);
    };
  }, [simulation]);

  const setCursorTarget = useCallback((xNorm: number, yNorm: number) => {
    simulation.targetYaw = (clampRange(xNorm, 0, 1) - 0.5) * CURSOR_PARALLAX_GAIN;
    simulation.targetPitch = (clampRange(yNorm, 0, 1) - 0.5) * CURSOR_PARALLAX_GAIN;
  }, [simulation]);

  const setScrollProgress = useCallback((progress: number) => {
    simulation.scrollProgress = clampRange(progress, 0, 1);
  }, [simulation]);

  const setEnergyLevel = useCallback((level: number) => { simulation.externalEnergy = clampRange(level, 0, 1); }, [simulation]);

  const setActive = useCallback((active: boolean) => { simulation.isActive = active; }, [simulation]);

  const refreshAnchors = useCallback(() => { simulation.anchors = resolveDomAnchorPositions(); }, [simulation]);

  const step = useCallback((deltaMs: number) => { stepSimulation(simulation, deltaMs); }, [simulation]);

  return useMemo<AcousticSpherePhysicsHandle>(
    () => ({
      get particles(): readonly AcousticParticleState[] { return simulation.particles; },
      get anchors(): readonly SphereAnchor[] { return simulation.anchors; },
      get anchorFlows(): readonly AcousticAnchorFlow[] { return simulation.anchorFlows; },
      get energy(): number { return simulation.energy; },
      get scrollProgress(): number { return simulation.scrollProgress; },
      setCursorTarget, setScrollProgress, setEnergyLevel, setActive, refreshAnchors, step,
    }),
    [simulation, setCursorTarget, setScrollProgress, setEnergyLevel, setActive, refreshAnchors, step],
  );
}

