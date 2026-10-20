/**
 * @archivo apps/web/src/components/landing/live-demo/usePublicVoiceDemoSession.ts
 * @modulo apps/web/src/components/landing/live-demo (demostración de voz pública de la landing)
 * @proposito
 *   Hook de la demostración de voz en vivo: permiso de micrófono, sesión efímera de 90 s contra el
 *   plano de control, canal binario, barge-in local <50 ms, vúmetro de 24 barras y contrato congelado.
 *   Optimizado para Safari iOS (desbloqueo síncrono de AudioContext, buffer mudo) y móviles (buffer 2048,
 *   channelCount ideal 1, reloj absoluto contra expiresAtMs y AudioContext unificado).
 * @resumen_contenido
 *   - Clasificación: `0x02` + `0x7B` = JSON de control; otro binario = PCM16 crudo (ruta caliente).
 *   - Uplink canónico `[0x01] + 640 bytes`; apagado idempotente en el desmontaje del componente.
 * @dependencias_internas
 *   - `backendFetch`, `BackendHttpError` y contratos espejo de `../../../lib/api-client/*`.
 * @dependencias_externas
 *   - `react`, `WebSocket`, `AudioContext` y `navigator.mediaDevices`; sin librerías adicionales.
 */

import { useEffect, useRef, useState } from 'react';
import { BackendHttpError, backendFetch } from '../../../lib/api-client/http-client';
import {
  AUDIO_FRAME_SAMPLE_COUNT, AUDIO_SAMPLE_RATE_HZ, FRAME_TYPE_AUDIO_UPLINK, FRAME_TYPE_CONTROL_JSON,
  VOICE_CLOSE_CODES, type PublicDemoSessionDto, type PublicDemoSessionRequestDto,
  type ToolExecuteMessageDto, type VoiceModelId,
} from '../../../lib/api-client/backend-contracts.types';

/** Fase visible de la demostración de voz pública. */
export type PublicDemoPhase = 'IDLE' | 'REQUESTING_MIC_PERMISSION' | 'FETCHING_DEMO_EPHEMERAL_TOKEN'
  | 'CONNECTED_LISTENING' | 'AI_SPEAKING' | 'EXECUTING_DOM_ACTION' | 'DEMO_COMPLETED' | 'RATE_LIMITED';
/** Directiva física de herramienta: alias exacto del contrato espejo del backend. */
export type VoiceToolDirective = ToolExecuteMessageDto;
/** Contrato congelado que consumen los componentes visuales de la demo (Subagente 1.7). */
export interface PublicVoiceDemoSessionHandle {
  readonly phase: PublicDemoPhase; // Fase actual de la máquina de estados.
  readonly voiceModel: VoiceModelId | null; // Motor de voz; `null` antes de emitir la sesión.
  readonly activeDirective: VoiceToolDirective | null; // Directiva física pendiente para el DOM.
  readonly errorMessage: string | null; // Mensaje legible de error o de cierre.
  readonly remainingSeconds: number; // Segundos restantes de la demostración.
  readonly barsEnergy: readonly number[]; // Vúmetro de 24 barras normalizadas 0..1.
  readonly energyLevel: number; // Energía global 0..1 para la esfera del hero.
  readonly lastAckLatencyMs: number | null; // `tool.execute` recibido → ack enviado (ms).
  readonly lastBargeInLatencyMs: number | null; // Voz detectada → control `0x02` enviado (ms).
  startDemo(options?: { readonly preferredVoiceModel?: VoiceModelId; readonly preferredVoiceName?: string }): Promise<void>; // Micrófono + sesión + canal.
  stopDemo(): void; // Cierre idempotente con liberación de recursos.
  interruptAssistant(): void; // Barge-in manual sobre el asistente.
  acknowledgeDirective(directiveId: string, succeeded: boolean, detail: string | null): void; // Ack + latencia.
}
/**
 * Token de prueba que el backend acepta fuera de producción; el widget real de Cloudflare Turnstile
 * queda pendiente con la variable reservada `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
 */
const TURNSTILE_TEST_TOKEN = 'turnstile-test-passed';
const DEMO_SESSION_PATH = '/api/v1/public/demo-session';
const MIC_DENIED_MESSAGE = 'Necesitamos acceso al micrófono para la demostración en vivo.';
const START_FAILED_MESSAGE = 'No fue posible iniciar la demostración en vivo. Inténtalo de nuevo en unos instantes.';
const RATE_LIMIT_MESSAGE = 'Has alcanzado el límite diario de 2 demostraciones por IP...';
const UNAUTHORIZED_MESSAGE = 'Sesión de demostración no autorizada.';
const PROVIDER_UNAVAILABLE_MESSAGE = 'El motor de voz no está disponible en este momento. Inténtalo en unos minutos.';
const CONNECTION_LOST_MESSAGE = 'La conexión con la demostración en vivo se interrumpió. Inténtalo de nuevo.';
const BAR_COUNT = 24; const ENERGY_INTERVAL_MS = 100; // Barras del vúmetro y cadencia de publicación (~10 Hz).
const ENERGY_GAIN = 4; const RMS_THRESHOLD = 0.06; // Presentación del RMS real y umbral de voz del barge-in.
const BARGE_IN_DEBOUNCE_MS = 900; // Anti-rebote entre barge-ins consecutivos (evita cortes en ráfaga).
const BARGE_IN_MIN_BLOCKS = 3; // Ventanas de captura (2048 muestras) con voz sostenida antes de interrumpir.

/**
 * Traza diagnóstica de la demo pública. Activada por defecto para poder auditar en la consola del
 * navegador cómo fluye la sesión (fases, audio de bajada, barge-in, acciones y acuses con latencia).
 * Se silencia con `localStorage.setItem('oa_demo_debug','0')`. Cada línea lleva un offset en ms desde
 * que arrancó la sesión para detectar dónde se corta o cuánto tarda cada paso.
 */
let DEMO_T0 = 0;
function demoDebugEnabled(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem('oa_demo_debug') !== '0'; }
  catch { return true; }
}
function dbg(event: string, data?: Record<string, unknown>): void {
  if (!demoDebugEnabled()) return;
  const t = DEMO_T0 === 0 ? 0 : Math.round(performance.now() - DEMO_T0);
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  // eslint-disable-next-line no-console
  console.info(`%c[oa-demo +${t}ms] ${event}${suffix}`, 'color:#00838f;font-weight:bold');
}

/** Recursos vivos de una demostración: audio, socket, métricas y temporizadores. */
interface DemoRuntime {
  active: boolean; readonly mediaStream: MediaStream; socket: WebSocket | null; phase: PublicDemoPhase; transcript: string;
  audioContext: AudioContext | null; captureActive: boolean; source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null; sinkGain: GainNode | null; remainingSeconds: number; expiresAtMs: number; countdownTimer: number | null; energyTimer: number | null;
  energyBars: readonly number[]; energySmoothed: number; energySum: number; energyBlocks: number; uplinkSamples: Float32Array; decimPending: Float32Array;
  playbackSources: AudioBufferSourceNode[]; nextPlaybackTime: number; lastBargeInAtMs: number; directiveReceivedAtMs: number | null; lastServerAck: Readonly<Record<string, unknown>> | null;
  bargeInCandidateBlocks: number; // Ventanas consecutivas por encima del umbral (aún sin confirmar).
}
/** Resultado público por código de cierre del socket (`VOICE_CLOSE_CODES` + cierre normal 1000). */
const CLOSE_OUTCOMES: Readonly<Record<number, { readonly message: string | null; readonly phase: PublicDemoPhase }>> = {
  [VOICE_CLOSE_CODES.UNAUTHORIZED]: { message: UNAUTHORIZED_MESSAGE, phase: 'IDLE' },
  [VOICE_CLOSE_CODES.RATE_LIMITED]: { message: RATE_LIMIT_MESSAGE, phase: 'RATE_LIMITED' },
  [VOICE_CLOSE_CODES.PROVIDER_UNAVAILABLE]: { message: PROVIDER_UNAVAILABLE_MESSAGE, phase: 'IDLE' }, [1000]: { message: null, phase: 'DEMO_COMPLETED' },
};
/** Devuelve el vúmetro vacío de 24 barras en cero. */
const createEmptyBars = (): readonly number[] => new Array<number>(BAR_COUNT).fill(0);
/**
 * Resuelve la URL del socket: si `NEXT_PUBLIC_VOICE_WS_URL` está definida, sustituye solo el origen y
 * el path base (si la variable no trae path se conserva el del backend) y mantiene intacto el query
 * string con `token`, `sessionId` y `demo=true` emitido por el backend.
 */
function resolveSocketUrl(serverUrl: string): string {
  const override = typeof process === 'undefined' ? undefined : process.env['NEXT_PUBLIC_VOICE_WS_URL'];
  if (override === undefined || override.length === 0) return serverUrl;
  try {
    const backend = new URL(serverUrl); const target = new URL(override);
    return `${target.protocol}//${target.host}${target.pathname === '/' ? backend.pathname : target.pathname}${backend.search}`;
  } catch { return serverUrl; }
}
/** Empaqueta muestras float 16 kHz como trama uplink `[0x01] + PCM16 little-endian`. */
function encodeUplinkAudioFrame(samples: Float32Array): ArrayBuffer {
  const frame = new ArrayBuffer(1 + samples.length * 2); const view = new DataView(frame);
  view.setUint8(0, FRAME_TYPE_AUDIO_UPLINK);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(1 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index] ?? 0)) * 32767), true);
  return frame;
}
/** Envía una trama de control `[0x02] + JSON UTF-8` cuando el socket sigue abierto. */
function sendControlFrame(socket: WebSocket | null, body: Readonly<Record<string, unknown>>): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  const payload = new TextEncoder().encode(JSON.stringify(body)); const frame = new Uint8Array(payload.length + 1);
  frame[0] = FRAME_TYPE_CONTROL_JSON; frame.set(payload, 1); socket.send(frame);
}
/** Detiene las pistas del micrófono ya adquirido (cancelaciones y errores de emisión). */
function stopTracks(stream: MediaStream): void { for (const track of stream.getTracks()) track.stop(); }
/** Vacía la cola de reproducción programada: `stop(0)` + descarte + reseteo de la agenda continua. */
function flushPlayback(runtime: DemoRuntime): void {
  for (const source of runtime.playbackSources) { try { source.stop(0); } catch { /* ya terminó */ } } runtime.playbackSources = []; runtime.nextPlaybackTime = 0;
}
/**
 * Diezma por promedio a 16 kHz cuando el `AudioContext` real no nace a 16 kHz (factor entero: exacto a
 * 48 kHz y aproximado a 44.1 kHz): el navegador puede ignorar `sampleRate` y abrir el hardware real.
 */
function resampleToSixteenKhz(runtime: DemoRuntime, block: Float32Array): Float32Array {
  const sourceRate = runtime.audioContext?.sampleRate ?? AUDIO_SAMPLE_RATE_HZ;
  if (sourceRate === AUDIO_SAMPLE_RATE_HZ) return block;
  const factor = Math.max(1, Math.round(sourceRate / AUDIO_SAMPLE_RATE_HZ));
  const pending = new Float32Array(runtime.decimPending.length + block.length); pending.set(runtime.decimPending); pending.set(block, runtime.decimPending.length);
  const output: number[] = []; let index = 0;
  while (index + factor <= pending.length) {
    let sum = 0; for (let offset = 0; offset < factor; offset += 1) sum += pending[index + offset] ?? 0;
    output.push(sum / factor); index += factor;
  }
  runtime.decimPending = pending.slice(index);
  return Float32Array.from(output);
}
/** Libera por completo una sesión: temporizadores, audio, pistas del micrófono y socket. */
function teardownRuntime(runtime: DemoRuntime): void {
  runtime.active = false; runtime.captureActive = false;
  for (const timer of [runtime.energyTimer, runtime.countdownTimer]) if (timer !== null) window.clearInterval(timer); runtime.energyTimer = null; runtime.countdownTimer = null;
  if (runtime.processor !== null) { runtime.processor.onaudioprocess = null; runtime.processor.disconnect(); }
  runtime.source?.disconnect(); runtime.sinkGain?.disconnect(); flushPlayback(runtime); stopTracks(runtime.mediaStream);
  const context = runtime.audioContext; runtime.audioContext = null;
  runtime.source = null; runtime.processor = null; runtime.sinkGain = null;
  if (context !== null) void context.close().catch(() => undefined);
  const socket = runtime.socket; runtime.socket = null;
  if (socket === null) return;
  socket.onopen = null; socket.onmessage = null; socket.onclose = null;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'demo.finished');
}
/**
 * Crea y desbloquea síncronamente un `AudioContext` con compatibilidad para Safari iOS y WebKit móvil.
 * Si `{ sampleRate: 16000 }` arroja `NotSupportedError` (habitual en WebKit iOS con AirPods),
 * recurre al constructor nativo `new AudioContext()` y se apoya en `resampleToSixteenKhz`.
 * Conecta un buffer mudo de calentamiento para cumplir la política estricta de activación de Safari.
 */
function createAndUnlockAudioContext(): AudioContext {
  const AudioContextClass = typeof window !== 'undefined'
    ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;
  if (!AudioContextClass) throw new Error('AudioContext no soportado en este entorno');
  let context: AudioContext;
  try {
    context = new AudioContextClass({ sampleRate: AUDIO_SAMPLE_RATE_HZ });
  } catch {
    context = new AudioContextClass();
  }
  try {
    void context.resume();
    const silentBuffer = context.createBuffer(1, 1, context.sampleRate > 0 ? context.sampleRate : AUDIO_SAMPLE_RATE_HZ);
    const source = context.createBufferSource();
    source.buffer = silentBuffer; source.connect(context.destination); source.start(0);
  } catch { /* continuar si el navegador restringe la reproducción del buffer silencioso */ }
  return context;
}
/** Construye los recursos vivos de una sesión recién emitida por el backend. */
function createRuntime(mediaStream: MediaStream, dto: PublicDemoSessionDto, audioContext: AudioContext | null): DemoRuntime {
  return {
    active: true, mediaStream, socket: null, phase: 'FETCHING_DEMO_EPHEMERAL_TOKEN', captureActive: false, transcript: '',
    audioContext, source: null, processor: null, sinkGain: null,
    remainingSeconds: dto.maxDurationSeconds, expiresAtMs: Date.now() + dto.maxDurationSeconds * 1000, countdownTimer: null, energyTimer: null, energyBars: createEmptyBars(),
    energySmoothed: 0, energySum: 0, energyBlocks: 0, uplinkSamples: new Float32Array(0), decimPending: new Float32Array(0),
    playbackSources: [], nextPlaybackTime: 0, lastBargeInAtMs: 0, directiveReceivedAtMs: null, lastServerAck: null,
    bargeInCandidateBlocks: 0,
  };
}
/** Hook de la demostración de voz pública: máquina de fases, audio 16 kHz, barge-in y vúmetro. */
export function usePublicVoiceDemoSession(): PublicVoiceDemoSessionHandle {
  const [phase, setPhase] = useState<PublicDemoPhase>('IDLE');
  const [voiceModel, setVoiceModel] = useState<VoiceModelId | null>(null);
  const [activeDirective, setActiveDirective] = useState<VoiceToolDirective | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [meter, setMeter] = useState<{ bars: readonly number[]; level: number }>(() => ({ bars: createEmptyBars(), level: 0 }));
  const [latencies, setLatencies] = useState<{ ack: number | null; bargeIn: number | null }>({ ack: null, bargeIn: null });
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const startTokenRef = useRef(0);
  /** Espeja la fase en el runtime (rutas de audio) y la publica en React. */
  const transition = (runtime: DemoRuntime, next: PublicDemoPhase): void => {
    if (runtime.phase !== next) dbg('fase', { de: runtime.phase, a: next });
    runtime.phase = next; setPhase(next);
  };
  /** Barge-in local <50 ms: mide, vacía la cola, avisa con `0x02` y vuelve a escucha. */
  const performBargeIn = (runtime: DemoRuntime): void => {
    const startedAtMs = performance.now();
    const cancelados = runtime.playbackSources.length;
    flushPlayback(runtime);
    sendControlFrame(runtime.socket, { type: 'voice.barge_in', timestamp: Date.now() });
    const lat = performance.now() - startedAtMs;
    setLatencies((current) => ({ ...current, bargeIn: lat }));
    dbg('BARGE-IN interrumpiendo al asistente', { fuentesCanceladas: cancelados, latenciaMs: Math.round(lat) });
    runtime.lastBargeInAtMs = performance.now(); runtime.bargeInCandidateBlocks = 0; transition(runtime, 'CONNECTED_LISTENING');
  };
  /** Encadena un bloque PCM16 del asistente sin huecos y enciende la fase de elocución. */
  const scheduleDownlinkAudio = (runtime: DemoRuntime, bytes: Uint8Array): void => {
    const context = runtime.audioContext;
    if (context === null || bytes.length < 2) return;
    const sampleCount = Math.floor(bytes.length / 2); const buffer = context.createBuffer(1, sampleCount, AUDIO_SAMPLE_RATE_HZ);
    const channel = buffer.getChannelData(0); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    const scheduleAt = Math.max(runtime.nextPlaybackTime, context.currentTime + 0.02); source.start(scheduleAt);
    // Si hubo que retrasar la agenda respecto a nextPlaybackTime, el buffer se quedó seco: hueco audible.
    const subRun = runtime.nextPlaybackTime > 0 && scheduleAt > runtime.nextPlaybackTime + 0.02;
    if (subRun) dbg('AUDIO HUECO (buffer sub-run) — la red llegó más lento que la reproducción', { gapMs: Math.round((scheduleAt - runtime.nextPlaybackTime) * 1000) });
    runtime.nextPlaybackTime = scheduleAt + buffer.duration; runtime.playbackSources.push(source);
    dbg('audio bajada', { bytes: bytes.length, durMs: Math.round(buffer.duration * 1000), enCola: runtime.playbackSources.length });
    source.onended = () => {
      runtime.playbackSources = runtime.playbackSources.filter((candidate) => candidate !== source);
      if (runtime.active && runtime.playbackSources.length === 0 && runtime.phase === 'AI_SPEAKING') transition(runtime, 'CONNECTED_LISTENING');
    };
    transition(runtime, 'AI_SPEAKING');
  };
  /** Procesa un bloque de captura: barge-in por RMS, vúmetro y fragmentos canónicos de 20 ms. */
  const handleCaptureBlock = (runtime: DemoRuntime, inputBuffer: AudioBuffer): void => {
    if (!runtime.active) return;
    const frameCount = inputBuffer.length; const channels = inputBuffer.numberOfChannels;
    const samples = new Float32Array(frameCount);
    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = inputBuffer.getChannelData(channel);
      for (let index = 0; index < frameCount; index += 1) samples[index] = (samples[index] ?? 0) + (channelData[index] ?? 0);
    }
    let sumSquares = 0;
    for (let index = 0; index < frameCount; index += 1) { const value = (samples[index] ?? 0) / channels; samples[index] = value; sumSquares += value * value; }
    const rms = Math.min(1, Math.sqrt(sumSquares / Math.max(1, frameCount)));
    runtime.energySmoothed = runtime.energySmoothed * 0.8 + rms * 0.2; runtime.energySum += rms; runtime.energyBlocks += 1;
    const interruptible = runtime.phase === 'AI_SPEAKING' || runtime.phase === 'EXECUTING_DOM_ACTION';
    // Voz sostenida: se exige un minimo de ventanas consecutivas por encima del umbral antes de
    // interrumpir. Un solo pico (tos, clic del raton o el propio eco del altavoz) ya no corta la
    // narracion del asistente, que era la causa de los cortes que se sentian en la demo.
    if (!interruptible || rms < RMS_THRESHOLD) {
      runtime.bargeInCandidateBlocks = 0;
    } else {
      runtime.bargeInCandidateBlocks += 1;
      if (
        runtime.bargeInCandidateBlocks >= BARGE_IN_MIN_BLOCKS
        && performance.now() - runtime.lastBargeInAtMs >= BARGE_IN_DEBOUNCE_MS
      ) {
        runtime.bargeInCandidateBlocks = 0;
        performBargeIn(runtime);
      }
    }
    const socket = runtime.socket; if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const resampled = resampleToSixteenKhz(runtime, samples);
    const merged = new Float32Array(runtime.uplinkSamples.length + resampled.length);
    merged.set(runtime.uplinkSamples); merged.set(resampled, runtime.uplinkSamples.length); runtime.uplinkSamples = merged;
    while (runtime.uplinkSamples.length >= AUDIO_FRAME_SAMPLE_COUNT) {
      const frameSamples = runtime.uplinkSamples.slice(0, AUDIO_FRAME_SAMPLE_COUNT);
      runtime.uplinkSamples = runtime.uplinkSamples.slice(AUDIO_FRAME_SAMPLE_COUNT); socket.send(encodeUplinkAudioFrame(frameSamples));
    }
  };
  /** Arranca captura y reproducción en `session.ready`, con vúmetro publicado a ~10 Hz. */
  const beginAudioSession = (runtime: DemoRuntime): void => {
    if (runtime.captureActive) return;
    if (runtime.audioContext === null) {
      try { runtime.audioContext = createAndUnlockAudioContext(); } catch { return; }
    }
    const audioContext = runtime.audioContext;
    if (audioContext === null) return;
    const source = audioContext.createMediaStreamSource(runtime.mediaStream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const sink = audioContext.createGain(); sink.gain.value = 0;
    source.connect(processor); processor.connect(sink); sink.connect(audioContext.destination);
    processor.onaudioprocess = (event: AudioProcessingEvent) => handleCaptureBlock(runtime, event.inputBuffer);
    runtime.source = source; runtime.processor = processor; runtime.sinkGain = sink; runtime.captureActive = true;
    void audioContext.resume();
    runtime.energyTimer = window.setInterval(() => {
      if (!runtime.active) return;
      const windowMean = runtime.energyBlocks === 0 ? 0 : runtime.energySum / runtime.energyBlocks;
      runtime.energySum = 0; runtime.energyBlocks = 0;
      runtime.energyBars = [...runtime.energyBars.slice(1), Math.min(1, windowMean * ENERGY_GAIN)];
      setMeter({ bars: runtime.energyBars, level: Math.min(1, runtime.energySmoothed * ENERGY_GAIN) });
    }, ENERGY_INTERVAL_MS);
  };
  /** Enruta cada mensaje de control del canal de voz a su fase y su estado. */
  const handleControlMessage = (runtime: DemoRuntime, jsonText: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText) as unknown; } catch { return; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const message = parsed as Readonly<Record<string, unknown>>;
    switch (message['type']) {
      case 'session.ready': {
        dbg('SESSION.LISTO (proveedor activo)', { activeProvider: message['activeProvider'], failover: message['failoverTriggered'], paso: message['currentStepNumber'] });
        beginAudioSession(runtime); transition(runtime, 'CONNECTED_LISTENING'); return;
      }
      case 'assistant.speaking': {
        const transcript = message['transcript'];
        if (typeof transcript === 'string') { runtime.transcript += transcript; dbg('asistente hablando', { delta: transcript.slice(0, 60), final: message['isFinal'] === true }); }
        if (message['isFinal'] !== true || runtime.playbackSources.length > 0) transition(runtime, 'AI_SPEAKING'); return;
      }
      case 'tool.execute': {
        if (typeof message['providerToolCallId'] !== 'string' || typeof message['toolName'] !== 'string') return;
        if (typeof message['primarySelector'] !== 'string' || typeof message['targetElementKey'] !== 'string') return;
        dbg('TOOL.EXECUTE recibido', { id: message['providerToolCallId'], accion: message['toolName'], objetivo: message['targetElementKey'], texto: message['textPayload'] ?? null });
        runtime.directiveReceivedAtMs = performance.now(); setActiveDirective(message as unknown as VoiceToolDirective);
        transition(runtime, 'EXECUTING_DOM_ACTION'); return;
      }
      case 'tool.execution.ack': runtime.lastServerAck = message; dbg('ACK del servidor (eco)', { id: message['providerToolCallId'] }); return;
      case 'session.closing': {
        const publicMessage = message['publicMessage']; // El cierre del socket fija la fase terminal final.
        dbg('SESSION.CLOSING', { codigo: message['closeCode'], mensaje: publicMessage ?? null });
        if (typeof publicMessage === 'string' && publicMessage.length > 0) setErrorMessage(publicMessage);
        transition(runtime, 'DEMO_COMPLETED'); return;
      }
      default: dbg('control no reconocido', { tipo: message['type'] }); return;
    }
  };
  /** Abre el socket binario de voz y enruta apertura, tramas, cierre y cuenta regresiva de 90 s. */
  const connectSocket = (runtime: DemoRuntime, serverUrl: string): void => {
    const socket = new WebSocket(resolveSocketUrl(serverUrl)); socket.binaryType = 'arraybuffer'; runtime.socket = socket;
    dbg('conectando al gateway de voz', { url: resolveSocketUrl(serverUrl).split('?')[0] });
    socket.onopen = () => {
      if (!runtime.active) return;
      dbg('WEBSOCKET abierto; ventana', { segundos: runtime.remainingSeconds });
      runtime.expiresAtMs = Date.now() + runtime.remainingSeconds * 1000;
      runtime.countdownTimer = window.setInterval(() => {
        if (!runtime.active) return;
        const remaining = Math.max(0, Math.ceil((runtime.expiresAtMs - Date.now()) / 1000));
        runtime.remainingSeconds = remaining; setRemainingSeconds(remaining);
        if (remaining <= 0) stopDemo();
      }, 500);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!runtime.active || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length >= 2 && bytes[0] === FRAME_TYPE_CONTROL_JSON && bytes[1] === 0x7b) { handleControlMessage(runtime, new TextDecoder().decode(bytes.subarray(1))); return; }
      scheduleDownlinkAudio(runtime, bytes);
    };
    socket.onclose = (event: CloseEvent) => {
      if (!runtime.active) return;
      dbg('WEBSOCKET cerrado', { codigo: event.code, motivo: event.reason || '(sin motivo)', fueCierreNormal: event.code === 1000 });
      runtime.active = false;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      const outcome = CLOSE_OUTCOMES[event.code] ?? { message: CONNECTION_LOST_MESSAGE, phase: 'IDLE' as const };
      if (outcome.message !== null) setErrorMessage(outcome.message);
      setPhase(outcome.phase); teardownRuntime(runtime);
    };
  };
  /** Detiene y libera la sesión en curso de forma idempotente. */
  const stopDemo = (): void => {
    startTokenRef.current += 1; const runtime = runtimeRef.current; runtimeRef.current = null;
    if (runtime === null) { setPhase((current) => (current === 'RATE_LIMITED' || current === 'DEMO_COMPLETED' || current === 'IDLE' ? current : 'IDLE')); return; }
    teardownRuntime(runtime); setPhase('DEMO_COMPLETED');
    setActiveDirective(null); setRemainingSeconds(0);
  };
  /** Inicia la demostración: permiso de micrófono, sesión efímera y canal binario de voz. */
  const startDemo = async (options?: { readonly preferredVoiceModel?: VoiceModelId; readonly preferredVoiceName?: string }): Promise<void> => {
    if (runtimeRef.current !== null) return;
    DEMO_T0 = performance.now();
    dbg('INICIO de demostración', { motor: options?.preferredVoiceModel ?? '(defecto)', voz: options?.preferredVoiceName ?? '(defecto)' });
    let preUnlockedAudioContext: AudioContext | null = null;
    try { preUnlockedAudioContext = createAndUnlockAudioContext(); } catch { /* sin soporte de audio */ }
    const requestToken = startTokenRef.current + 1; startTokenRef.current = requestToken;
    setErrorMessage(null); setActiveDirective(null); setRemainingSeconds(0); setMeter({ bars: createEmptyBars(), level: 0 });
    setPhase('REQUESTING_MIC_PERMISSION');
    let mediaStream: MediaStream;
    try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: { ideal: 1 } } }); dbg('micrófono concedido', { pistas: mediaStream.getAudioTracks().length }); }
    catch {
      dbg('micrófono DENEGADO');
      if (preUnlockedAudioContext !== null) void preUnlockedAudioContext.close().catch(() => undefined);
      setErrorMessage(MIC_DENIED_MESSAGE); setPhase('IDLE'); return;
    }
    if (startTokenRef.current !== requestToken) {
      stopTracks(mediaStream);
      if (preUnlockedAudioContext !== null) void preUnlockedAudioContext.close().catch(() => undefined);
      return;
    }
    setPhase('FETCHING_DEMO_EPHEMERAL_TOKEN');
    const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const requestBody: PublicDemoSessionRequestDto = { turnstileToken: TURNSTILE_TEST_TOKEN,
      ...(options?.preferredVoiceModel === undefined ? {} : { preferredVoiceModel: options.preferredVoiceModel }),
      ...(options?.preferredVoiceName === undefined ? {} : { preferredVoiceName: options.preferredVoiceName }),
      ...(userTimezone.length === 0 ? {} : { userTimezone }) };
    let dto: PublicDemoSessionDto;
    try { dto = await backendFetch<PublicDemoSessionDto>(DEMO_SESSION_PATH, { method: 'POST', anonymous: true, body: requestBody }); }
    catch (caughtError) {
      dbg('ERROR al crear la sesión demo', { code: caughtError instanceof BackendHttpError ? caughtError.code : 'RED', mensaje: caughtError instanceof Error ? caughtError.message : String(caughtError) });
      stopTracks(mediaStream);
      if (preUnlockedAudioContext !== null) void preUnlockedAudioContext.close().catch(() => undefined);
      if (startTokenRef.current !== requestToken) return;
      if (caughtError instanceof BackendHttpError && caughtError.code === 'RATE_LIMIT_EXCEEDED') { setErrorMessage(String(caughtError.details['message'] ?? RATE_LIMIT_MESSAGE)); setPhase('RATE_LIMITED'); return; }
      setErrorMessage(caughtError instanceof BackendHttpError ? caughtError.message : START_FAILED_MESSAGE); setPhase('IDLE'); return;
    }
    if (startTokenRef.current !== requestToken) {
      stopTracks(mediaStream);
      if (preUnlockedAudioContext !== null) void preUnlockedAudioContext.close().catch(() => undefined);
      return;
    }
    dbg('SESIÓN emitida por el backend', { motor: dto.voiceModel, voz: dto.voiceName, duracionS: dto.maxDurationSeconds, sesion: dto.sessionId });
    const runtime = createRuntime(mediaStream, dto, preUnlockedAudioContext);
    runtimeRef.current = runtime;
    setVoiceModel(dto.voiceModel); setRemainingSeconds(dto.maxDurationSeconds);
    connectSocket(runtime, dto.websocketUrl);
  };
  /** Interrumpe al asistente con la misma secuencia manual del barge-in local. */
  const interruptAssistant = (): void => { const runtime = runtimeRef.current; if (runtime !== null) performBargeIn(runtime); };
  /** Envía el acuse de una directiva física y mide la latencia desde su recepción. */
  const acknowledgeDirective = (directiveId: string, succeeded: boolean, detail: string | null): void => {
    const runtime = runtimeRef.current;
    sendControlFrame(runtime?.socket ?? null, { type: 'tool.execution.ack', providerToolCallId: directiveId, succeeded, detail });
    if (runtime !== null) {
      if (runtime.directiveReceivedAtMs !== null) {
        const ackLatencyMs = performance.now() - runtime.directiveReceivedAtMs; runtime.directiveReceivedAtMs = null;
        setLatencies((current) => ({ ...current, ack: ackLatencyMs }));
        dbg('ACK enviado al backend', { id: directiveId, exito: succeeded, latenciaMs: Math.round(ackLatencyMs), detalle: detail });
      } else {
        dbg('ACK enviado al backend', { id: directiveId, exito: succeeded, detalle: detail });
      }
      transition(runtime, 'CONNECTED_LISTENING');
    }
    setActiveDirective(null);
  };
  useEffect(() => () => { stopDemo(); }, []);
  return {
    phase, voiceModel, activeDirective, errorMessage, remainingSeconds, barsEnergy: meter.bars,
    energyLevel: meter.level, lastAckLatencyMs: latencies.ack, lastBargeInLatencyMs: latencies.bargeIn,
    startDemo, stopDemo, interruptAssistant, acknowledgeDirective,
  };
}
