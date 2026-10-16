/**
 * @archivo tests/integration/support/voice-qwen-doubles.ts
 * @modulo 05-voice-realtime-gateway (Dobles de Prueba del Motor de Voz)
 * @proposito
 *   Reune los dobles que permiten certificar el adaptador de voz sin abrir ninguna conexion de red:
 *   un socket falso en memoria que cumple el contrato minimo que el adaptador consume de la libreria
 *   de sockets, un registrador de eventos que se cierra sobre si mismo para que las aserciones lean
 *   el estado real, y las utilidades para construir fragmentos PCM16 de amplitud conocida. El
 *   registrador merece una advertencia: devolver una copia de los arreglos dejaria las clausuras
 *   mutando un objeto distinto del inspeccionado, y la prueba mediria un estado congelado.
 *
 * @resumen_contenido
 *   - Constantes `VOICE_TEST_WS_URL` y `VOICE_TEST_API_KEY`.
 *   - Clase `FakeWebSocket`: socket en memoria con el contrato minimo de la libreria.
 *   - Funciones `buildPcmFrame()` y `buildSilenceFrame()`: audio sintetico determinista.
 *   - Funcion `buildEventRecorder()`: registrador de eventos del gateway.
 *   - Funcion `buildOpenRequest()`: peticion de apertura de canal sintetica.
 *   - Funcion `flushEventLoop()`: cede el turno para que el socket resuelva su apertura.
 *
 * @dependencias_internas
 *   - `VoiceProviderEventHandlers`, `ToolInvocation` y `VoiceStreamOpenRequest` del puerto del nucleo.
 *
 * @dependencias_externas
 *   - `node:events` (Emisor de eventos del que hereda el socket falso).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Dobles en memoria: por diseno no tocan PostgreSQL ni Redis).
 */

import { EventEmitter } from 'node:events';
import type {
  ToolInvocation,
  VoiceProviderEventHandlers,
  VoiceStreamOpenRequest,
} from '../../../src/shared/ports/billing-voice-admin.ports';
import { DEFAULT_SAMPLE_RATE_HZ } from '../../../src/modules/05-voice-realtime-gateway/infrastructure/audio-pcm16-ring-buffer';

/** Endpoint sintetico del motor de voz usado por las pruebas. */
export const VOICE_TEST_WS_URL = 'wss://motor.interno.local/v1/realtime';

/** Credencial sintetica con la longitud minima que exige el adaptador. */
export const VOICE_TEST_API_KEY = 'clave_de_prueba_con_longitud_suficiente';

/**
 * Socket falso en memoria que cumple el contrato minimo que el adaptador consume de la libreria.
 * Permite probar el ciclo de vida completo del canal, el envio de tramas y la recepcion de mensajes.
 */
export class FakeWebSocket extends EventEmitter {
  /** Estados del socket, equivalentes a los de la libreria real. */
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState: number = FakeWebSocket.CONNECTING;
  /** Tramas enviadas por el backend, en orden. */
  public readonly sentFrames: string[] = [];
  /** Motivo del ultimo cierre ordenado. */
  public lastCloseReason = '';
  /** Indica si el socket fue terminado abruptamente. */
  public wasTerminated = false;

  /**
   * Simula la apertura del socket.
   */
  public simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  /**
   * Simula la recepcion de una trama del motor.
   *
   * @param rawMessage - Texto crudo recibido.
   */
  public simulateMessage(rawMessage: string): void {
    this.emit('message', Buffer.from(rawMessage, 'utf8'));
  }

  /**
   * Simula un fallo del socket.
   *
   * @param message - Mensaje del error.
   */
  public simulateError(message: string): void {
    this.emit('error', new Error(message));
  }

  /**
   * Simula el cierre del socket por parte del motor.
   */
  public simulateRemoteClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  /**
   * Registra una trama enviada.
   *
   * @param data - Contenido de la trama.
   * @returns `true` cuando el envio se acepto.
   */
  public send(data: string): boolean {
    if (this.readyState !== FakeWebSocket.OPEN) {
      return false;
    }
    this.sentFrames.push(data);
    return true;
  }

  /**
   * Cierra el socket de forma ordenada.
   *
   * @param code - Codigo de cierre.
   * @param reason - Motivo del cierre.
   */
  public close(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.lastCloseReason = `${code}:${reason}`;
    this.emit('close');
  }

  /**
   * Termina el socket de forma abrupta.
   */
  public terminate(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.wasTerminated = true;
    this.emit('close');
  }
}

/**
 * Construye un fragmento PCM16 con una amplitud constante.
 *
 * @param amplitude - Amplitud de la muestra, en el rango de PCM16 signado.
 * @param sampleCount - Numero de muestras del fragmento.
 * @returns Buffer PCM16 little-endian.
 */
export function buildPcmFrame(amplitude: number, sampleCount: number): Buffer {
  const frame = Buffer.alloc(sampleCount * 2);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    frame.writeInt16LE(amplitude, sampleIndex * 2);
  }
  return frame;
}

/**
 * Construye un fragmento de silencio digital.
 *
 * @param sampleCount - Numero de muestras del fragmento.
 * @returns Buffer PCM16 con todas las muestras en cero.
 */
export function buildSilenceFrame(sampleCount: number): Buffer {
  return Buffer.alloc(sampleCount * 2);
}

/** Registro de todo lo que el adaptador reporta al gateway durante una prueba. */
export interface VoiceEventRecorder {
  /** Manejadores que se entregan al adaptador. */
  readonly handlers: VoiceProviderEventHandlers;
  /** Fragmentos de audio recibidos del motor. */
  readonly audioFrames: Buffer[];
  /** Transcripciones recibidas, con su caracter de definitivas o parciales. */
  readonly transcripts: { readonly text: string; readonly isFinal: boolean }[];
  /** Invocaciones de herramienta recibidas. */
  readonly toolInvocations: ToolInvocation[];
  /** Motivos de error reportados. */
  readonly errors: string[];
  /** Estados finales de cierre notificados. */
  readonly closedStatuses: string[];
  /** Numero de veces que el motor anuncio que el asistente empezo a hablar. */
  speechStartedCount: number;
}

/**
 * Construye el registrador de eventos que consumen las pruebas del adaptador.
 *
 * @returns Registrador cuyos manejadores mutan el propio objeto devuelto.
 */
export function buildEventRecorder(): VoiceEventRecorder {
  // Los manejadores se cierran SOBRE ESTE MISMO objeto: devolver una copia con `...recorder` dejaria
  // las clausuras mutando un objeto distinto del que la prueba inspecciona, de modo que las
  // aserciones medirian un estado congelado en cero y la prueba aprobaria o fallaria por ficcion.
  const recorder = {
    handlers: undefined as unknown as VoiceProviderEventHandlers,
    audioFrames: [] as Buffer[],
    transcripts: [] as { readonly text: string; readonly isFinal: boolean }[],
    toolInvocations: [] as ToolInvocation[],
    errors: [] as string[],
    closedStatuses: [] as string[],
    speechStartedCount: 0,
  };

  recorder.handlers = {
    onAudioFrame: (pcmFrame: Buffer) => recorder.audioFrames.push(pcmFrame),
    onTranscript: (text: string, isFinal: boolean) => recorder.transcripts.push({ text, isFinal }),
    onToolInvocation: (invocation: ToolInvocation) => recorder.toolInvocations.push(invocation),
    onAssistantSpeechStarted: () => {
      recorder.speechStartedCount += 1;
    },
    onProviderError: (reason: string) => recorder.errors.push(reason),
    onClosed: (status) => recorder.closedStatuses.push(status),
  };

  return recorder;
}

/**
 * Construye una peticion de apertura de canal sintetica.
 *
 * @param overrides - Campos a sobrescribir respecto de la peticion base.
 * @returns Peticion completa de apertura.
 */
export function buildOpenRequest(overrides: Partial<VoiceStreamOpenRequest> = {}): VoiceStreamOpenRequest {
  return {
    organizationId: 'org-prueba',
    projectId: 'proy-prueba',
    voiceSessionId: 'ses-prueba',
    systemPrompt: 'Eres el asistente de onboarding. Guia al usuario paso a paso.',
    onboardingStepsJson: [{ step: 1, title: 'Crear cuenta' }],
    voicePersonaCode: 'aura-es-neutral',
    modelTemperature: '0.30',
    pcmSampleRateHz: DEFAULT_SAMPLE_RATE_HZ,
    externalEndUserId: null,
    ...overrides,
  };
}

/**
 * Cede el turno al bucle de eventos para que un socket falso resuelva su apertura.
 *
 * @returns Promesa que se resuelve tras el siguiente ciclo del bucle de eventos.
 */
export async function flushEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Contador de verificaciones superadas durante la ejecucion de una prueba. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
export function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`FALLO: ${description}`);
  }
  passedAssertions += 1;
}

/**
 * Devuelve el numero de aserciones superadas hasta el momento.
 *
 * @returns Total acumulado de aserciones superadas.
 */
export function countPassedAssertions(): number {
  return passedAssertions;
}
