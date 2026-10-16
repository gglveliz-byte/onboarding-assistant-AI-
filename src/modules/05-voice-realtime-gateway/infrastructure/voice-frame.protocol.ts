/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol.ts
 * @modulo 05-voice-realtime-gateway (Codecs del Protocolo de Tramas del Socket de Voz)
 * @proposito
 *   Define y codifica el protocolo de tramas que viaja entre el navegador del usuario final y el
 *   gateway de voz: un byte de tipo seguido del contenido, de modo que el audio viaje como binario
 *   crudo sin inflarlo un 33% en Base64 ni obligar a serializar cada fragmento de 20 ms. El primer
 *   byte distingue el audio del usuario final (uplink) del audio del asistente (downlink, que llega
 *   sin cabecera porque es la ruta caliente), y reserva un tipo para las tramas de control JSON
 *   (`route.changed`, `voice.barge_in`, `tool.execution.ack`, `tool.execute`). Un error de un solo
 *   byte aqui produce silencio, audio interpretado como JSON o acciones ejecutadas dos veces.
 *
 * @resumen_contenido
 *   - Constantes `FRAME_TYPE_*` y `VOICE_CLOSE_CODES`.
 *   - Funciones `encodeAudioUplinkFrame()`, `encodeControlFrame()`, `encodeToolExecuteFrame()`.
 *   - Funciones `decodeClientFrame()`, `encodeAudioDownlinkFrame()` y `encodeControlMessage()`.
 *   - Clase `VoiceFrameDecoder`: acumulador que resuelve tramas partidas entre paquetes TCP.
 *
 * @dependencias_internas
 *   - `ToolInvocation`, `VoiceSessionStatus` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Codec puro sobre `Buffer`: sin dependencias de serializacion externas).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Codec de transporte: no persiste nada; el audio jamas toca disco ni Redis).
 */

import type { ToolInvocation } from '../../../shared/ports/billing-voice-admin.ports';

/** Tipo de trama: audio PCM16 del usuario final hacia el motor de voz. */
export const FRAME_TYPE_AUDIO_UPLINK = 0x01;

/** Tipo de trama: mensaje de control JSON en cualquiera de las dos direcciones. */
export const FRAME_TYPE_CONTROL_JSON = 0x02;

/** Muestras PCM16 de un fragmento canonico de 20 ms a 16 kHz mono. */
export const AUDIO_FRAME_SAMPLE_COUNT = 320;

/** Tamano total de una trama de audio uplink, incluido su byte de tipo. */
export const AUDIO_UPLINK_FRAME_BYTES = 1 + AUDIO_FRAME_SAMPLE_COUNT * 2;

/**
 * Codigos de cierre del socket de voz, alineados con la politica de la plataforma.
 * `4001` sesion no autorizada, `4002` pago requerido, `4003` organizacion suspendida,
 * `4007` limite de frecuencia excedido y `4008` motor de voz no disponible.
 */
export const VOICE_CLOSE_CODES = Object.freeze({
  UNAUTHORIZED: 4001,
  PAYMENT_REQUIRED: 4002,
  TENANT_SUSPENDED: 4003,
  RATE_LIMITED: 4007,
  PROVIDER_UNAVAILABLE: 4008,
});

/** Nombres de los mensajes de control que viajan como JSON. */
export type VoiceControlMessageName =
  | 'route.changed'
  | 'voice.barge_in'
  | 'tool.execute'
  | 'tool.execution.ack'
  | 'session.ready'
  | 'session.closing'
  | 'assistant.speaking';

/** Accion fisica solicitada al cliente, con la cascada de selectores ya resuelta. */
export interface ToolExecuteDirective {
  /** Identificador de la llamada del motor, que el cliente debe devolver en el acuse. */
  readonly providerToolCallId: string;
  /** Herramienta solicitada. */
  readonly toolName: ToolInvocation['toolName'];
  /** Clave del elemento en el mapa funcional. */
  readonly targetElementKey: string;
  /** Selector primario validado por la barrera de seguridad. */
  readonly primarySelector: string;
  /** Cascada completa de selectores alternativos, en orden de preferencia. */
  readonly selectorCascade: readonly string[];
  /** Texto a escribir cuando la herramienta es `type_text`; `null` en los demas casos. */
  readonly textPayload: string | null;
  /** Indica si la accion exige confirmacion explicita del usuario final. */
  readonly requiresUserConfirmation: boolean;
  /** Nivel de riesgo atribuido por la barrera de seguridad. */
  readonly riskLevel: string;
}

/** Trama de control ya deserializada, lista para el enrutador del gateway. */
export interface DecodedClientFrame {
  /** Tipo de trama recibida. */
  readonly kind: 'AUDIO' | 'CONTROL';
  /** Audio PCM16 cuando la trama es de audio. */
  readonly audioPayload?: Buffer;
  /** Nombre del mensaje de control cuando la trama es JSON. */
  readonly controlName?: VoiceControlMessageName;
  /** Cuerpo del mensaje de control, ya deserializado. */
  readonly controlBody?: Record<string, unknown>;
  /** Motivo del descarte cuando la trama no pudo interpretarse. */
  readonly rejectionReason?: string;
}

/** Resultado del intento de decodificacion de una trama del cliente. */
export type DecodeOutcome =
  | { readonly ok: true; readonly frame: DecodedClientFrame }
  | { readonly ok: false; readonly reason: string };

/** Nombres de control reconocidos, usados para descartar mensajes desconocidos. */
const KNOWN_CONTROL_NAMES: readonly VoiceControlMessageName[] = [
  'route.changed',
  'voice.barge_in',
  'tool.execution.ack',
  'tool.execute',
  'session.ready',
  'session.closing',
  'assistant.speaking',
];

/**
 * Compone una trama de audio del usuario final con su byte de tipo.
 *
 * @param pcmFrame - Audio PCM16 little-endian.
 * @returns Trama lista para enviar por el socket.
 */
export function encodeAudioUplinkFrame(pcmFrame: Buffer): Buffer {
  return Buffer.concat([Buffer.from([FRAME_TYPE_AUDIO_UPLINK]), pcmFrame]);
}

/**
 * Compone una trama de audio del asistente hacia el navegador.
 * El downlink viaja SIN cabecera porque es la ruta caliente: el cliente ya sabe que todo lo que
 * recibe en binario es audio del asistente, y ahorrar un byte por fragmento evita copiar el buffer
 * entero decenas de veces por segundo.
 *
 * @param pcmFrame - Audio PCM16 little-endian.
 * @returns Trama lista para enviar al navegador.
 */
export function encodeAudioDownlinkFrame(pcmFrame: Buffer): Buffer {
  return pcmFrame;
}

/**
 * Compone una trama de control JSON con su byte de tipo.
 *
 * @param messageName - Nombre del mensaje de control.
 * @param body - Cuerpo del mensaje.
 * @returns Trama lista para enviar por el socket.
 */
export function encodeControlFrame(messageName: VoiceControlMessageName, body: Readonly<Record<string, unknown>>): Buffer {
  const header = Buffer.from([FRAME_TYPE_CONTROL_JSON]);
  return Buffer.concat([header, Buffer.from(JSON.stringify({ type: messageName, ...body }), 'utf8')]);
}

/**
 * Compone la directiva de ejecucion de herramienta que el cliente debe aplicar en su DOM.
 *
 * @param directive - Accion validada con su cascada de selectores.
 * @returns Trama de control lista para enviar al navegador.
 */
export function encodeToolExecuteFrame(directive: ToolExecuteDirective): Buffer {
  return encodeControlFrame('tool.execute', {
    providerToolCallId: directive.providerToolCallId,
    toolName: directive.toolName,
    targetElementKey: directive.targetElementKey,
    primarySelector: directive.primarySelector,
    selectorCascade: directive.selectorCascade,
    textPayload: directive.textPayload,
    requiresUserConfirmation: directive.requiresUserConfirmation,
    riskLevel: directive.riskLevel,
  });
}

/**
 * Compone la trama de cierre cortes de una sesion, con el motivo en lenguaje de marca.
 *
 * @param closeCode - Codigo de cierre del socket.
 * @param publicMessage - Mensaje que el asistente debe pronunciar antes de cerrar.
 * @returns Trama de control lista para enviar al navegador.
 */
export function encodeSessionClosingFrame(closeCode: number, publicMessage: string): Buffer {
  return encodeControlFrame('session.closing', { closeCode, publicMessage });
}

/**
 * Compone el mensaje con el que el cliente anuncia que la accion fisica termino.
 *
 * @param providerToolCallId - Identificador de la llamada que se confirma.
 * @param succeeded - Indica si la accion se completo.
 * @param detail - Detalle adicional, como el motivo del bloqueo por campo sensible.
 * @returns Cuerpo del mensaje de acuse.
 */
export function buildToolAckBody(
  providerToolCallId: string,
  succeeded: boolean,
  detail: string | null
): Readonly<Record<string, unknown>> {
  return { providerToolCallId, succeeded, detail };
}

/**
 * Decodifica una trama completa recibida del navegador.
 * Es defensiva por diseno: una trama de audio con un numero impar de bytes no es PCM16 valido, y un
 * mensaje de control desconocido no debe derribar una sesion de voz en curso.
 *
 * @param rawFrame - Trama cruda, incluido su byte de tipo.
 * @returns Resultado de la decodificacion.
 */
export function decodeClientFrame(rawFrame: Buffer): DecodeOutcome {
  if (rawFrame.length === 0) {
    return { ok: false, reason: 'Trama vacia.' };
  }

  const frameType = rawFrame[0];
  const payload = rawFrame.subarray(1);

  if (frameType === FRAME_TYPE_AUDIO_UPLINK) {
    if (payload.length === 0) {
      return { ok: false, reason: 'Trama de audio sin contenido.' };
    }
    if (payload.length % 2 !== 0) {
      return { ok: false, reason: 'La trama de audio no contiene un numero entero de muestras PCM16.' };
    }
    return { ok: true, frame: { kind: 'AUDIO', audioPayload: Buffer.from(payload) } };
  }

  if (frameType === FRAME_TYPE_CONTROL_JSON) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as unknown;
    } catch {
      return { ok: false, reason: 'El mensaje de control no es JSON valido.' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'El mensaje de control debe ser un objeto JSON.' };
    }

    const record = parsed as Record<string, unknown>;
    const rawName = typeof record['type'] === 'string' ? (record['type'] as string) : '';
    const matchedName = KNOWN_CONTROL_NAMES.find((knownName) => knownName === rawName);
    if (matchedName === undefined) {
      return { ok: false, reason: `Mensaje de control no soportado: "${rawName}".` };
    }
    return { ok: true, frame: { kind: 'CONTROL', controlName: matchedName, controlBody: record } };
  }

  // `noUncheckedIndexedAccess` obliga a tratar el byte de cabecera como posiblemente ausente, aunque
  // la guarda inicial ya garantice que la trama tiene al menos un byte.
  const unknownFrameType = rawFrame[0] as number;
  return { ok: false, reason: `Tipo de trama desconocido: 0x${unknownFrameType.toString(16)}.` };
}

/**
 * Acumulador que reconstruye tramas completas a partir de paquetes del socket.
 * Un socket entrega un flujo de bytes, no mensajes: un fragmento de audio puede llegar partido en
 * dos paquetes, y tratarlo como trama completa produciria audio truncado con un byte de cabecera
 * incrustado en medio. El acumulador resuelve ese limite y descarta lo que exceda la capacidad.
 */
export class VoiceFrameDecoder {
  private readonly maxFrameBytes: number;
  private pendingBytes: Buffer = Buffer.alloc(0);

  /**
   * @param maxFrameBytes - Tamano maximo que puede alcanzar una trama antes de descartarse.
   */
  public constructor(maxFrameBytes = 65536) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /**
   * Incorpora un paquete recibido y extrae todas las tramas completas que contenga.
   *
   * @param chunk - Bytes recibidos del socket.
   * @returns Tramas completas y decodificadas, en orden de llegada.
   */
  public push(chunk: Buffer): readonly DecodeOutcome[] {
    if (chunk.length === 0) {
      return [];
    }

    this.pendingBytes = this.pendingBytes.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pendingBytes, chunk]);

    if (this.pendingBytes.length > this.maxFrameBytes) {
      // Un emisor que nunca completa una trama no puede consumir memoria sin limite.
      this.pendingBytes = Buffer.alloc(0);
      return [{ ok: false, reason: `La trama supero el maximo de ${this.maxFrameBytes} bytes y fue descartada.` }];
    }

    return this.extractCompleteFrames();
  }

  /**
   * Devuelve los bytes pendientes que aun no completan una trama.
   *
   * @returns Bytes en espera de completarse.
   */
  public getPendingByteLength(): number {
    return this.pendingBytes.length;
  }

  /**
   * Descarta los bytes pendientes, usado al cerrar una sesion.
   */
  public reset(): void {
    this.pendingBytes = Buffer.alloc(0);
  }

  /**
   * Extrae las tramas completas disponibles del acumulador.
   *
   * @returns Tramas decodificadas.
   */
  private extractCompleteFrames(): readonly DecodeOutcome[] {
    const outcomes: DecodeOutcome[] = [];

    while (this.pendingBytes.length > 0) {
      const frameLength = this.measureNextFrameLength();
      if (frameLength === null) {
        break;
      }
      const frame = this.pendingBytes.subarray(0, frameLength);
      this.pendingBytes = this.pendingBytes.subarray(frameLength);
      outcomes.push(decodeClientFrame(frame));
    }

    return outcomes;
  }

  /**
   * Determina la longitud de la siguiente trama completa, si esta disponible.
   * Las tramas de audio no declaran su longitud porque el cliente envia fragmentos de tamano
   * canonico (20 ms, 640 bytes); las de control son JSON y se aceptan al completarse la llave de
   * cierre, de modo que un objeto anidado o una llave dentro de una cadena no las corte antes.
   *
   * @returns Longitud de la trama en bytes, o `null` cuando aun esta incompleta.
   */
  private measureNextFrameLength(): number | null {
    // `noUncheckedIndexedAccess` obliga a tratar el byte de cabecera como posiblemente ausente,
    // aunque la guarda previa ya garantice que hay al menos un byte pendiente.
    const frameType = this.pendingBytes.length > 0 ? (this.pendingBytes[0] as number) : null;

    if (frameType === FRAME_TYPE_AUDIO_UPLINK) {
      const canonicalFrameLength = AUDIO_UPLINK_FRAME_BYTES;
      return this.pendingBytes.length >= canonicalFrameLength ? canonicalFrameLength : null;
    }

    if (frameType === FRAME_TYPE_CONTROL_JSON) {
      const closingBraceIndex = this.findJsonEnd(this.pendingBytes, 1);
      return closingBraceIndex === null ? null : closingBraceIndex + 1;
    }

    // Un tipo desconocido no puede medirse: se descarta su byte y se continua con el resto.
    return 1;
  }

  /**
   * Localiza el indice de la llave que cierra el objeto JSON, respetando cadenas y escapes.
   *
   * @param buffer - Buffer que contiene la trama.
   * @param startIndex - Indice donde comienza el JSON.
   * @returns Indice de la llave de cierre, o `null` cuando el objeto aun no esta completo.
   */
  private findJsonEnd(buffer: Buffer, startIndex: number): number | null {
    let depth = 0;
    let insideString = false;
    let isEscaped = false;

    for (let byteIndex = startIndex; byteIndex < buffer.length; byteIndex += 1) {
      const currentByte = buffer[byteIndex] as number;
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (currentByte === 0x5c) {
        isEscaped = true;
        continue;
      }
      if (currentByte === 0x22) {
        insideString = !insideString;
        continue;
      }
      if (insideString) {
        continue;
      }
      if (currentByte === 0x7b) {
        depth += 1;
        continue;
      }
      if (currentByte === 0x7d) {
        depth -= 1;
        if (depth === 0) {
          return byteIndex;
        }
      }
    }

    return null;
  }
}
