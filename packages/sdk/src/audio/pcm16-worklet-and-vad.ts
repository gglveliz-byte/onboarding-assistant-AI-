/**
 * @archivo packages/sdk/src/audio/pcm16-worklet-and-vad.ts
 * @modulo @onboarding-assistant/sdk (Captura de Micrófono PCM16 + VAD Local < 5 ms)
 * @proposito
 *   Captura el micrófono del usuario final en el navegador y lo convierte en tramas
 *   binarias de 20 ms a 16 kHz PCM16 little-endian con prefijo `0x01` (641 bytes),
 *   listas para el canal de voz en tiempo real. El procesamiento vive dentro de un
 *   AudioWorklet (fuera del hilo de render) y el VAD local detecta la voz del usuario
 *   en ≈2.7 ms por quantum a 48 kHz para emitir `barge_in` mucho antes que el servidor.
 *
 * @resumen_contenido
 *   - Constantes congeladas del protocolo: `PCM16_SAMPLE_RATE`, `PCM16_FRAME_MS`,
 *     `PCM16_FRAME_BYTES`, `PCM16_FRAME_HEADER_BYTE` y `PCM16_WORKLET_PROCESSOR_NAME`.
 *   - `buildPcm16WorkletSource()`: código fuente JavaScript puro del procesador de audio
 *     (acumulación Float32, remuestreo continuo a 16 kHz, Int16 PCM LE, barge-in y nivel).
 *   - `createPcm16WorkletBlobUrl()`: publica esa fuente como Blob URL inyectable.
 *   - Interfaces `Pcm16CaptureHandlers` y `Pcm16CaptureOptions`.
 *   - Clase `Pcm16CapturePipeline`: grafo MediaStream → AudioWorklet → sink silencioso.
 *
 * @dependencias_internas
 *   - Ninguna (módulo autónomo del SDK).
 *
 * @dependencias_externas
 *   - Solo APIs DOM estándar del navegador (AudioContext, AudioWorkletNode, Blob, URL).
 *     Las globales del worklet (`AudioWorkletProcessor`, `registerProcessor`, `sampleRate`)
 *     existen únicamente dentro del string generado, nunca como ambientales de TypeScript.
 */

/** Frecuencia de muestreo canónica del canal de voz ascendente (16 kHz mono). */
export const PCM16_SAMPLE_RATE = 16000;

/** Duración de cada trama de audio emitida hacia el gateway (20 ms). */
export const PCM16_FRAME_MS = 20;

/** Tamaño de la carga útil PCM16 (20 ms × 16 kHz × 2 bytes = 640 bytes sin prefijo). */
export const PCM16_FRAME_BYTES = (PCM16_SAMPLE_RATE * PCM16_FRAME_MS * 2) / 1000;

/** Prefijo binario de trama de audio ascendente: `0x01 + PCM16` (641 bytes totales). */
export const PCM16_FRAME_HEADER_BYTE = 0x01;

/** Nombre registrado del AudioWorkletProcessor de captura dentro del worklet. */
export const PCM16_WORKLET_PROCESSOR_NAME = 'oa-pcm16-capture';

/** Umbral de energía RMS que separa voz de silencio en el VAD local. */
const DEFAULT_VAD_ENERGY_THRESHOLD = 0.015;

/** Umbral de RMS a partir del cual la voz del usuario interrumpe al asistente. */
const DEFAULT_BARGE_IN_RMS_THRESHOLD = 0.07;

/**
 * Genera el código fuente JavaScript puro del AudioWorkletProcessor de captura.
 * Se publica como Blob URL mediante `createPcm16WorkletBlobUrl()` para inyectarlo
 * con `audioWorklet.addModule()`. El texto es JavaScript de navegador: no usa
 * sintaxis TypeScript y solo toca APIs disponibles dentro del ámbito del worklet.
 *
 * @returns Código fuente del procesador `oa-pcm16-capture` como cadena lista para Blob.
 */
export function buildPcm16WorkletSource(): string {
  return `'use strict';
// ============================================================================
// Procesador de captura PCM16 (${PCM16_WORKLET_PROCESSOR_NAME}) — JavaScript puro
// ============================================================================
// Convierte el audio entrante (Float32, típicamente 48 kHz estéreo/mono) en tramas
// binarias de EXACTAMENTE ${PCM16_FRAME_BYTES} bytes Int16 little-endian a ${PCM16_SAMPLE_RATE} Hz,
// precedidas por un byte de cabecera ${PCM16_FRAME_HEADER_BYTE} (0x01 + PCM16 = ${PCM16_FRAME_BYTES + 1} bytes).
// ============================================================================

// RMS de un bloque Float32 en rango [-1, 1].
function computeRms(float32Block) {
  var sumSquares = 0;
  for (var i = 0; i < float32Block.length; i += 1) {
    var sample = float32Block[i];
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / float32Block.length);
}

class OaPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var raw = (options && options.processorOptions) || {};
    this.frameBytes = typeof raw.frameBytes === 'number' ? raw.frameBytes : ${PCM16_FRAME_BYTES};
    this.samplesPerFrame = this.frameBytes / 2;
    this.vadEnabled = raw.vadEnabled !== false;
    this.vadEnergyThreshold = typeof raw.vadEnergyThreshold === 'number' ? raw.vadEnergyThreshold : 0.015;
    this.bargeInRmsThreshold = typeof raw.bargeInRmsThreshold === 'number' ? raw.bargeInRmsThreshold : 0.07;

    // Remuestreo continuo hacia 16 kHz: relación entre la tasa del contexto (sampleRate)
    // y la tasa canónica del protocolo. A 48 kHz la relación es 3 y a 16 kHz es 1.
    this.resampleRatio = sampleRate / ${PCM16_SAMPLE_RATE};
    this.hasPreviousSample = false;
    this.previousSample = 0;
    this.inputIndex = 0;
    this.nextOutputAt = this.resampleRatio;

    // Búfer de salida reutilizado entre quanta: cero asignaciones por muestra, sin GC.
    this.frameBuffer = new Float32Array(this.samplesPerFrame);
    this.frameFill = 0;

    this.assistantPlayback = false;
    this.bargeInLatched = false;

    // El hilo principal informa el estado de reproducción del asistente para el barge-in.
    var processor = this;
    this.port.onmessage = function (event) {
      var data = event.data || {};
      if (data.type === 'assistant_playback') {
        processor.assistantPlayback = data.active === true;
        if (!processor.assistantPlayback) {
          processor.bargeInLatched = false;
        }
      }
    };
  }

  // Convierte el búfer Float32 completo en una trama binaria y la transfiere al hilo
  // principal (transfer list: el ArrayBuffer se mueve, no se copia). Emite además el
  // nivel RMS de la trama para telemetría local.
  emitFrame() {
    var payload = new ArrayBuffer(this.frameBytes + 1);
    var view = new DataView(payload);
    view.setUint8(0, ${PCM16_FRAME_HEADER_BYTE}); // prefijo 0x01 de audio ascendente
    var energy = 0;
    for (var i = 0; i < this.samplesPerFrame; i += 1) {
      var sample = this.frameBuffer[i];
      var clamped = sample < -1 ? -1 : (sample > 1 ? 1 : sample);
      var int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(1 + i * 2, int16, true); // little-endian
      energy += clamped * clamped;
    }
    this.frameFill = 0;
    this.port.postMessage(payload, [payload]);
    this.port.postMessage({ type: 'level', rms: Math.sqrt(energy / this.samplesPerFrame) });
  }

  // Acumula una muestra remuestreada; al completar ${PCM16_FRAME_BYTES / 2} muestras emite la trama.
  pushOutputSample(value) {
    this.frameBuffer[this.frameFill] = value;
    this.frameFill += 1;
    if (this.frameFill >= this.samplesPerFrame) {
      this.emitFrame();
    }
  }

  process(inputs) {
    var input = inputs[0];
    var channel = input && input.length > 0 ? input[0] : null;
    if (!channel || channel.length === 0) {
      return true; // Sin entrada conectada: se mantiene vivo el procesador.
    }

    // ------------------------------------------------------------------
    // VAD LOCAL EN EL CLIENTE (barge-in en menos de 5 ms a 48 kHz)
    // ------------------------------------------------------------------
    // El quantum de audio dura 128 muestras: a 48 kHz apenas ≈2.7 ms, por lo que
    // la voz del usuario se detecta aquí, dentro del hilo de audio del navegador,
    // antes de que cualquier viaje de ida y vuelta al servidor (decenas o cientos
    // de milisegundos) pudiera reaccionar. Por eso el VAD local "vacía la cola"
    // antes que el servidor: en cuanto hay voz sobre el asistente en reproducción
    // se emite barge_in de inmediato y la cola de contexto pendiente deja de ser
    // válida; cuando el aviso llega al servidor, la interrupción ya ocurrió en el
    // cliente y nunca se reproduce audio obsoleto del asistente.
    if (this.vadEnabled) {
      var quantumRms = computeRms(channel);
      var isVoiceActive = quantumRms >= this.vadEnergyThreshold;
      if (isVoiceActive && this.assistantPlayback && quantumRms >= this.bargeInRmsThreshold && !this.bargeInLatched) {
        this.bargeInLatched = true;
        this.port.postMessage({ type: 'barge_in', rms: quantumRms });
      }
      if (!isVoiceActive) {
        this.bargeInLatched = false; // El usuario guardó silencio: un nuevo ataque puede interrumpir otra vez.
      }
    }

    // ------------------------------------------------------------------
    // REMUESTREO CONTINUO A 16 kHz CON INTERPOLACIÓN LINEAL
    // ------------------------------------------------------------------
    // Cada muestra de salida cae en una posición fraccional de la línea de entrada;
    // se interpola entre la muestra anterior y la entrante. El estado sobrevive
    // entre quanta, así que las tramas cruzan los límites de process() sin cortes.
    for (var i = 0; i < channel.length; i += 1) {
      var incoming = channel[i];
      if (!this.hasPreviousSample) {
        this.previousSample = incoming;
        this.hasPreviousSample = true;
        continue;
      }
      this.inputIndex += 1;
      while (this.nextOutputAt <= this.inputIndex) {
        var fraction = this.nextOutputAt - (this.inputIndex - 1);
        if (fraction < 0) fraction = 0;
        if (fraction > 1) fraction = 1;
        this.pushOutputSample(this.previousSample + (incoming - this.previousSample) * fraction);
        this.nextOutputAt += this.resampleRatio;
      }
      this.previousSample = incoming;
    }
    return true;
  }
}

registerProcessor('${PCM16_WORKLET_PROCESSOR_NAME}', OaPcm16CaptureProcessor);
`;
}

/**
 * Publica la fuente del procesador como Blob URL de JavaScript para inyectarla
 * con `audioWorklet.addModule()`. Quien la consuma debe revocarla al terminar;
 * `Pcm16CapturePipeline.stop()` lo hace automáticamente.
 *
 * @returns Blob URL absoluto con el código del AudioWorkletProcessor.
 */
export function createPcm16WorkletBlobUrl(): string {
  const workletSource = buildPcm16WorkletSource();
  const workletBlob = new Blob([workletSource], { type: 'application/javascript' });
  return URL.createObjectURL(workletBlob);
}

/**
 * Callbacks que el pipeline invoca al hilo que lo consume.
 */
export interface Pcm16CaptureHandlers {
  /** Entrega cada trama binaria `0x01 + PCM16` de 641 bytes lista para enviar al gateway. */
  readonly onEncodedFrame: (payload: ArrayBuffer) => void;
  /** Notifica que el usuario habló sobre el asistente: el SDK debe interrumpir de inmediato. */
  readonly onBargeIn: () => void;
  /** Nivel RMS de cada trama emitida (telemetría opcional de voz del usuario). */
  readonly onLevel?: (rms: number) => void;
}

/**
 * Opciones de comportamiento del pipeline de captura.
 */
export interface Pcm16CaptureOptions {
  /** Activar/desactivar el VAD local (por defecto activado). */
  readonly vadEnabled?: boolean;
  /** Umbral de RMS que separa voz de silencio (por defecto `0.015`). */
  readonly vadEnergyThreshold?: number;
  /** Umbral de RMS que dispara el barge-in local (por defecto `0.07`). */
  readonly bargeInRmsThreshold?: number;
  /** Fuente autoritativa del estado de reproducción del asistente al arrancar la captura. */
  readonly assistantPlaybackActive?: () => boolean;
}

/** Handlers inertes usados cuando se instancia el pipeline sin `options`. */
const INERT_CAPTURE_HANDLERS: Pcm16CaptureHandlers = {
  onEncodedFrame: (): void => undefined,
  onBargeIn: (): void => undefined,
};

/**
 * Pipeline de captura de micrófono del SDK Web:
 * `MediaStreamAudioSourceNode` → `AudioWorkletNode` (PCM16 16 kHz + VAD local) →
 * `GainNode` a 0 conectado a `destination` para mantener vivo el grafo de audio
 * sin realimentación acústica.
 */
export class Pcm16CapturePipeline {
  private readonly handlers: Pcm16CaptureHandlers;
  private readonly options: Pcm16CaptureOptions;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sinkGain: GainNode | null = null;
  private audioContext: AudioContext | null = null;
  private ownsAudioContext = false;
  private workletBlobUrl: string | null = null;
  private active = false;
  private assistantPlaybackActive = false;

  /**
   * Crea el pipeline sin tocar el DOM ni el audio: el grafo se monta en `start()`.
   *
   * @param options - Handlers obligatorios dentro de las opciones de captura; si se
   *   omite por completo, las tramas y eventos se descartan (modo observación del grafo).
   */
  public constructor(options?: Pcm16CaptureOptions & { readonly handlers: Pcm16CaptureHandlers }) {
    this.handlers = options?.handlers ?? INERT_CAPTURE_HANDLERS;
    this.options = options ?? {};
  }

  /** Indica si el grafo de captura está montado y emitiendo tramas. */
  public get isActive(): boolean {
    return this.active;
  }

  /**
   * Monta el grafo de captura: reanuda el AudioContext si está suspendido, inyecta el
   * worklet desde Blob URL, conecta el micrófono y arranca la emisión de tramas de
   * 641 bytes (prefijo `0x01`).
   *
   * @param source - Pista de micrófono obtenida con `getUserMedia()`.
   * @param audioContext - Contexto existente opcional; si se omite, el pipeline crea y
   *   posee su propio contexto (y lo cierra en `stop()`).
   */
  public async start(source: MediaStream, audioContext?: AudioContext): Promise<void> {
    if (this.active) {
      return;
    }

    const context = audioContext ?? new AudioContext();
    this.ownsAudioContext = audioContext === undefined;
    this.audioContext = context;

    try {
      if (context.state === 'suspended') {
        await context.resume();
      }

      const blobUrl = createPcm16WorkletBlobUrl();
      this.workletBlobUrl = blobUrl;
      await context.audioWorklet.addModule(blobUrl);

      const workletNode = new AudioWorkletNode(context, PCM16_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: {
          frameBytes: PCM16_FRAME_BYTES,
          vadEnabled: this.options.vadEnabled !== false,
          vadEnergyThreshold: this.options.vadEnergyThreshold ?? DEFAULT_VAD_ENERGY_THRESHOLD,
          bargeInRmsThreshold: this.options.bargeInRmsThreshold ?? DEFAULT_BARGE_IN_RMS_THRESHOLD,
        },
      });
      workletNode.port.onmessage = (event: MessageEvent<unknown>): void => {
        this.handleWorkletMessage(event.data);
      };

      const sourceNode = context.createMediaStreamSource(source);
      const sinkGain = context.createGain();
      sinkGain.gain.value = 0;
      sourceNode.connect(workletNode);
      workletNode.connect(sinkGain);
      sinkGain.connect(context.destination);

      this.sourceNode = sourceNode;
      this.workletNode = workletNode;
      this.sinkGain = sinkGain;

      const seedPlaybackState = this.options.assistantPlaybackActive;
      if (seedPlaybackState !== undefined) {
        this.assistantPlaybackActive = seedPlaybackState();
      }
      this.syncWorkletPlaybackState();
      this.active = true;
    } catch (error) {
      this.releaseCaptureGraph();
      throw error;
    }
  }

  /**
   * Informa al worklet si el asistente está reproduciendo voz, habilitando así la
   * detección de barge-in del usuario sobre la reproducción.
   *
   * @param active - `true` mientras suena la voz del asistente.
   */
  public setAssistantPlaybackActive(active: boolean): void {
    this.assistantPlaybackActive = active;
    this.syncWorkletPlaybackState();
  }

  /**
   * Detiene la captura: desconecta el grafo, revoca el Blob URL del worklet y cierra
   * el AudioContext si el pipeline lo creó. Es seguro llamarlo más de una vez.
   */
  public stop(): void {
    this.active = false;
    this.releaseCaptureGraph();
  }

  /** Reenvía hacia los handlers las tramas y eventos emitidos por el worklet. */
  private handleWorkletMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.handlers.onEncodedFrame(data);
      return;
    }
    if (typeof data !== 'object' || data === null) {
      return;
    }
    const message = data as { readonly type?: unknown; readonly rms?: unknown };
    if (message.type === 'barge_in') {
      this.handlers.onBargeIn();
      return;
    }
    if (message.type === 'level' && typeof message.rms === 'number') {
      const onLevel = this.handlers.onLevel;
      if (onLevel !== undefined) {
        onLevel(message.rms);
      }
    }
  }

  /** Sincroniza el estado de reproducción del asistente con el procesador del worklet. */
  private syncWorkletPlaybackState(): void {
    const workletNode = this.workletNode;
    if (workletNode === null) {
      return;
    }
    workletNode.port.postMessage({ type: 'assistant_playback', active: this.assistantPlaybackActive });
  }

  /** Libera nodos, Blob URL y contexto de audio; tolera desconexiones ya realizadas. */
  private releaseCaptureGraph(): void {
    if (this.workletNode !== null) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        /* El nodo ya estaba desconectado. */
      }
      this.workletNode = null;
    }
    if (this.sourceNode !== null) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* El nodo ya estaba desconectado. */
      }
      this.sourceNode = null;
    }
    if (this.sinkGain !== null) {
      try {
        this.sinkGain.disconnect();
      } catch {
        /* El nodo ya estaba desconectado. */
      }
      this.sinkGain = null;
    }
    if (this.workletBlobUrl !== null) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    if (this.audioContext !== null) {
      const context = this.audioContext;
      this.audioContext = null;
      if (this.ownsAudioContext) {
        void context.close().catch((): void => {
          /* Cierre tolerante: el contexto ya estaba cerrado. */
        });
      }
    }
    this.ownsAudioContext = false;
    this.assistantPlaybackActive = false;
  }
}
