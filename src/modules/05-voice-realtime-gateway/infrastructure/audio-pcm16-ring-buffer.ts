/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/audio-pcm16-ring-buffer.ts
 * @modulo 05-voice-realtime-gateway (Buffer Circular de Audio PCM16 en Memoria Volatil)
 * @proposito
 *   Acumula el audio del usuario final en un buffer circular que vive unicamente en memoria RAM y
 *   jamas toca el disco, cumpliendo por diseno la politica de no persistir grabaciones crudas. El
 *   buffer calcula la energia RMS de cada fragmento para asistir al detector de actividad de voz
 *   (VAD) y expone un metodo de purga que sobrescribe con ceros la memoria ocupada: confiar en que
 *   el recolector de basura limpie el audio seria dejar la voz del usuario residente en memoria
 *   indefinidamente. Los fragmentos canonicos son de 20 ms, que a 16 kHz y 16 bits mono son 640
 *   bytes exactos.
 *
 * @resumen_contenido
 *   - Constantes `PCM16_BYTES_PER_SAMPLE`, `DEFAULT_FRAME_DURATION_MS` y `DEFAULT_SAMPLE_RATE_HZ`.
 *   - Funcion `calculateFrameDurationMs()` y `computeRootMeanSquare()`.
 *   - Interfaces `Pcm16FrameMetadata` y `QwenCompatibleRingBufferOptions`.
 *   - Clase `Pcm16RingBuffer`: escritura, lectura, RMS, VAD, purga con sobrescritura y estadisticas.
 *
 * @dependencias_internas
 *   - `ValidationError` (`src/shared/kernel/result-and-errors.ts`) para entradas invalidas.
 *
 * @dependencias_externas
 *   - Ninguna (Aritmetica entera sobre `Buffer`; sin dependencias de audio de terceros).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Buffer volatil: por diseno no escribe en PostgreSQL ni en Redis. La duracion y el
 *     costo del consumo se persisten agregados, nunca el audio).
 */

import { ValidationError } from '../../../shared/kernel/result-and-errors';

/** Bytes que ocupa una muestra PCM16: dos por muestra, signada y little-endian. */
export const PCM16_BYTES_PER_SAMPLE = 2;

/** Duracion canonica de un fragmento de audio, en milisegundos. */
export const DEFAULT_FRAME_DURATION_MS = 20;

/** Frecuencia de muestreo por omision del audio de entrada, en hercios. */
export const DEFAULT_SAMPLE_RATE_HZ = 16000;

/** Amplitud maxima de una muestra PCM16 signada. */
const PCM16_MAX_AMPLITUDE = 32768;

/** Escala con la que se normaliza la energia RMS a un valor comparable con umbrales de VAD. */
const NORMALIZED_RMS_SCALE = 10000;

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Calcula la duracion en milisegundos de un fragmento PCM16 mono.
 *
 * @param frameBytes - Tamano del fragmento en bytes.
 * @param sampleRateHz - Frecuencia de muestreo en hercios.
 * @returns Duracion del fragmento en milisegundos.
 * @throws ValidationError cuando el tamano o la frecuencia no son validos.
 */
export function calculateFrameDurationMs(frameBytes: number, sampleRateHz: number = DEFAULT_SAMPLE_RATE_HZ): number {
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
    throw new ValidationError('El tamano del fragmento de audio debe ser un entero positivo de bytes.');
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new ValidationError('La frecuencia de muestreo debe ser un entero positivo de hercios.');
  }
  const sampleCount = frameBytes / PCM16_BYTES_PER_SAMPLE;
  return (sampleCount / sampleRateHz) * MILLISECONDS_PER_SECOND;
}

/**
 * Calcula la energia RMS normalizada de un fragmento PCM16 little-endian.
 * El valor se expresa sobre una escala de 0 a 10000 para que los umbrales del VAD sean legibles y
 * no dependan del numero de muestras del fragmento. Prohibido usar coma flotante para el importe
 * facturable: aqui solo se calcula una magnitud de decision, no un precio.
 *
 * @param pcmFrame - Fragmento de audio PCM16 little-endian.
 * @returns Energia RMS normalizada, entre 0 y 10000.
 * @throws ValidationError cuando el fragmento no contiene un numero entero de muestras.
 */
export function computeRootMeanSquare(pcmFrame: Buffer): number {
  if (pcmFrame.length === 0) {
    return 0;
  }
  if (pcmFrame.length % PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new ValidationError('El fragmento PCM16 debe contener un numero entero de muestras de 16 bits.');
  }

  const sampleCount = pcmFrame.length / PCM16_BYTES_PER_SAMPLE;
  let sumOfSquares = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = pcmFrame.readInt16LE(sampleIndex * PCM16_BYTES_PER_SAMPLE);
    sumOfSquares += sample * sample;
  }

  const meanOfSquares = sumOfSquares / sampleCount;
  const normalizedRms = (Math.sqrt(meanOfSquares) / PCM16_MAX_AMPLITUDE) * NORMALIZED_RMS_SCALE;
  return Math.round(normalizedRms);
}

/** Metadatos de un fragmento almacenado en el buffer circular. */
export interface Pcm16FrameMetadata {
  /** Secuencia monotona del fragmento, desde el inicio de la sesion. */
  readonly sequence: number;
  /** Duracion del fragmento en milisegundos. */
  readonly durationMs: number;
  /** Energia RMS normalizada del fragmento. */
  readonly rmsNormalized: number;
  /** Tamano del fragmento en bytes. */
  readonly byteLength: number;
}

/** Opciones de construccion del buffer circular de audio. */
export interface Pcm16RingBufferOptions {
  /** Frecuencia de muestreo del audio, en hercios. */
  readonly sampleRateHz?: number;
  /** Duracion de cada fragmento, en milisegundos. */
  readonly frameDurationMs?: number;
  /** Capacidad total del buffer, en milisegundos de audio. */
  readonly capacityMs?: number;
  /** Umbral de RMS a partir del cual se considera que hay voz. */
  readonly voiceActivityThreshold?: number;
}

/**
 * Buffer circular de audio PCM16 residente unicamente en memoria.
 * Cuando se llena, el fragmento mas antiguo se descarta: en una sesion de voz en vivo el audio
 * viejo carece de valor y bloquear la escritura perderia audio nuevo, que si importa.
 */
export class Pcm16RingBuffer {
  private readonly sampleRateHz: number;
  private readonly frameBytes: number;
  private readonly frameDurationMs: number;
  private readonly capacityBytes: number;
  private readonly storage: Buffer;
  private readonly voiceActivityThreshold: number;

  private writeOffset = 0;
  private bufferedBytes = 0;
  private sequence = 0;
  private overwrittenFrameCount = 0;
  private peakRmsNormalized = 0;

  /**
   * @param options - Frecuencia, duracion de fragmento, capacidad y umbral de voz.
   * @throws ValidationError cuando las dimensiones derivadas no son enteras y positivas.
   */
  public constructor(options: Pcm16RingBufferOptions = {}) {
    this.sampleRateHz = options.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.frameDurationMs = options.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS;
    this.voiceActivityThreshold = options.voiceActivityThreshold ?? 250;
    this.frameBytes = Math.round((this.frameDurationMs / MILLISECONDS_PER_SECOND) * this.sampleRateHz) * PCM16_BYTES_PER_SAMPLE;

    if (this.frameBytes <= 0) {
      throw new ValidationError('La duracion del fragmento y la frecuencia de muestreo producen un fragmento vacio.');
    }

    // La capacidad se redondea a un numero entero de fragmentos para que el anillo nunca parta uno.
    const capacityFrames = Math.max(1, Math.ceil((options.capacityMs ?? 2000) / this.frameDurationMs));
    this.capacityBytes = capacityFrames * this.frameBytes;
    this.storage = Buffer.alloc(this.capacityBytes);
  }

  /**
   * Escribe un fragmento de audio en el anillo y devuelve sus metadatos.
   * Un fragmento mayor que la capacidad completa se rechaza: aceptarlo dejaria el anillo con un
   * unico fragmento truncado y el VAD analizaria audio incompleto.
   *
   * @param pcmFrame - Fragmento PCM16 little-endian.
   * @returns Metadatos del fragmento escrito.
   * @throws ValidationError cuando el fragmento esta vacio, no es PCM16 valido o excede la capacidad.
   */
  public write(pcmFrame: Buffer): Pcm16FrameMetadata {
    if (pcmFrame.length === 0) {
      throw new ValidationError('No se puede escribir un fragmento de audio vacio.');
    }
    if (pcmFrame.length % PCM16_BYTES_PER_SAMPLE !== 0) {
      throw new ValidationError('El fragmento PCM16 debe contener un numero entero de muestras de 16 bits.');
    }
    if (pcmFrame.length > this.capacityBytes) {
      throw new ValidationError(
        `El fragmento de ${pcmFrame.length} bytes excede la capacidad del anillo (${this.capacityBytes} bytes).`
      );
    }

    const rmsNormalized = computeRootMeanSquare(pcmFrame);

    if (this.bufferedBytes + pcmFrame.length > this.capacityBytes) {
      // Se libera espacio descartando lo mas antiguo, sin detener la captura del audio en vivo.
      const bytesToFree = this.bufferedBytes + pcmFrame.length - this.capacityBytes;
      this.advanceReadOffset(bytesToFree);
      this.overwrittenFrameCount += 1;
    }

    const firstChunkLength = Math.min(pcmFrame.length, this.capacityBytes - this.writeOffset);
    pcmFrame.copy(this.storage, this.writeOffset, 0, firstChunkLength);
    if (firstChunkLength < pcmFrame.length) {
      // El fragmento cruza el final del almacenamiento: el resto se escribe al principio.
      pcmFrame.copy(this.storage, 0, firstChunkLength);
    }

    this.writeOffset = (this.writeOffset + pcmFrame.length) % this.capacityBytes;
    this.bufferedBytes += pcmFrame.length;
    this.sequence += 1;
    this.peakRmsNormalized = Math.max(this.peakRmsNormalized, rmsNormalized);

    return Object.freeze({
      sequence: this.sequence,
      durationMs: calculateFrameDurationMs(pcmFrame.length, this.sampleRateHz),
      rmsNormalized,
      byteLength: pcmFrame.length,
    });
  }

  /**
   * Lee y extrae del anillo la cantidad de bytes indicada.
   *
   * @param byteCount - Bytes a extraer; por omision, todos los disponibles.
   * @returns Fragmento extraido, que puede ser menor si no hay suficientes bytes.
   * @throws ValidationError cuando la cantidad solicitada no es un entero positivo.
   */
  public read(byteCount?: number): Buffer {
    const requestedBytes = byteCount ?? this.bufferedBytes;
    if (!Number.isInteger(requestedBytes) || requestedBytes < 0) {
      throw new ValidationError('La cantidad de bytes a leer debe ser un entero no negativo.');
    }

    const bytesToRead = Math.min(requestedBytes, this.bufferedBytes);
    if (bytesToRead === 0) {
      return Buffer.alloc(0);
    }

    const readOffset = (this.writeOffset - this.bufferedBytes + this.capacityBytes) % this.capacityBytes;
    const extracted = Buffer.alloc(bytesToRead);
    const firstChunkLength = Math.min(bytesToRead, this.capacityBytes - readOffset);
    this.storage.copy(extracted, 0, readOffset, readOffset + firstChunkLength);
    if (firstChunkLength < bytesToRead) {
      this.storage.copy(extracted, firstChunkLength, 0, bytesToRead - firstChunkLength);
    }

    this.advanceReadOffset(bytesToRead);
    return extracted;
  }

  /**
   * Extrae un fragmento completo del anillo si hay al menos uno disponible.
   *
   * @returns Fragmento del tamano canonico, o `null` cuando aun no se ha acumulado uno completo.
   */
  public readFrame(): Buffer | null {
    if (this.bufferedBytes < this.frameBytes) {
      return null;
    }
    return this.read(this.frameBytes);
  }

  /**
   * Extrae todos los fragmentos completos disponibles y descarta el remanente parcial.
   * El remanente se conserva en el anillo para no perder la continuidad del flujo de audio.
   *
   * @returns Lista de fragmentos completos en orden cronologico.
   */
  public drainFrames(): readonly Buffer[] {
    const completeFrameCount = Math.floor(this.bufferedBytes / this.frameBytes);
    const frames: Buffer[] = [];
    for (let frameIndex = 0; frameIndex < completeFrameCount; frameIndex += 1) {
      const frame = this.read(this.frameBytes);
      frames.push(frame);
    }
    return frames;
  }

  /**
   * Calcula la energia RMS media de los bytes pendientes, sin extraerlos del anillo.
   * Se usa como insumo del detector de actividad de voz antes de decidir si el fragmento se envia.
   *
   * @returns Energia RMS normalizada del contenido pendiente; `0` cuando el anillo esta vacio.
   */
  public getPendingRms(): number {
    const pending = this.peekAll();
    return pending.length === 0 ? 0 : computeRootMeanSquare(pending);
  }

  /**
   * Indica si el contenido pendiente supera el umbral de voz configurado.
   *
   * @returns `true` cuando hay actividad de voz detectable.
   */
  public isVoiceDetected(): boolean {
    return this.getPendingRms() >= this.voiceActivityThreshold;
  }

  /**
   * Copia el contenido pendiente sin extraerlo del anillo.
   *
   * @returns Copia de los bytes pendientes en orden cronologico.
   */
  public peekAll(): Buffer {
    if (this.bufferedBytes === 0) {
      return Buffer.alloc(0);
    }
    const readOffset = (this.writeOffset - this.bufferedBytes + this.capacityBytes) % this.capacityBytes;
    const snapshot = Buffer.alloc(this.bufferedBytes);
    const firstChunkLength = Math.min(this.bufferedBytes, this.capacityBytes - readOffset);
    this.storage.copy(snapshot, 0, readOffset, readOffset + firstChunkLength);
    if (firstChunkLength < this.bufferedBytes) {
      this.storage.copy(snapshot, firstChunkLength, 0, this.bufferedBytes - firstChunkLength);
    }
    return snapshot;
  }

  /**
   * Purga el anillo sobrescribiendo con ceros toda la memoria ocupada.
   * Es la garantia de la politica de no persistencia: liberar el indice sin borrar los bytes
   * dejaria la voz del usuario residente en memoria hasta que el recolector la reutilice, lo que
   * podria tardar indefinidamente.
   */
  public purge(): void {
    this.storage.fill(0);
    this.writeOffset = 0;
    this.bufferedBytes = 0;
  }

  /**
   * Devuelve las estadisticas de uso del anillo para el diagnostico y la auditoria.
   *
   * @returns Estadisticas con bytes pendientes, fragmentos escritos, descartados y pico de energia.
   */
  public getStatistics(): {
    readonly bufferedBytes: number;
    readonly capacityBytes: number;
    readonly frameBytes: number;
    readonly frameDurationMs: number;
    readonly sampleRateHz: number;
    readonly framesWritten: number;
    readonly framesOverwritten: number;
    readonly peakRmsNormalized: number;
    readonly isSaturated: boolean;
  } {
    return Object.freeze({
      bufferedBytes: this.bufferedBytes,
      capacityBytes: this.capacityBytes,
      frameBytes: this.frameBytes,
      frameDurationMs: this.frameDurationMs,
      sampleRateHz: this.sampleRateHz,
      framesWritten: this.sequence,
      framesOverwritten: this.overwrittenFrameCount,
      peakRmsNormalized: this.peakRmsNormalized,
      isSaturated: this.bufferedBytes === this.capacityBytes,
    });
  }

  /**
   * Indica cuantos bytes quedan pendientes de leer.
   *
   * @returns Bytes pendientes en el anillo.
   */
  public getBufferedByteLength(): number {
    return this.bufferedBytes;
  }

  /**
   * Devuelve el tamano del fragmento canonico del anillo.
   *
   * @returns Tamano del fragmento en bytes.
   */
  public getFrameByteLength(): number {
    return this.frameBytes;
  }

  /**
   * Avanza el indice de lectura descartando bytes del contenido mas antiguo.
   *
   * @param byteCount - Bytes a descartar del frente del anillo.
   */
  private advanceReadOffset(byteCount: number): void {
    this.bufferedBytes = Math.max(0, this.bufferedBytes - byteCount);
  }
}
