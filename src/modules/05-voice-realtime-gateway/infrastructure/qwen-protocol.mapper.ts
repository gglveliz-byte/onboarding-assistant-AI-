/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/qwen-protocol.mapper.ts
 * @modulo 05-voice-realtime-gateway (Mapeador del Protocolo Realtime de Qwen3.8-Omni)
 * @proposito
 *   Traduce entre el contrato comun del nucleo y el vocabulario nativo del motor de voz alterno, que
 *   difiere por completo del de su homologo: aqui la configuracion viaja en `session.update`, el
 *   audio en `input_audio_buffer.append` codificado en Base64, la interrupcion en `response.cancel`
 *   seguido de `output_audio_buffer.clear`, y las herramientas se resuelven en dos tiempos. Un
 *   mapeador equivocado produce silencio, audio corrupto o llamadas de herramienta que nunca se
 *   confirman, por lo que la traduccion se aisla y se prueba sin red. Las constantes y la forma de
 *   las tramas viven en `./qwen-protocol.types.ts`.
 *
 * @resumen_contenido
 *   - Clase `QwenProtocolMapper`:
 *       * Construccion: `buildSessionUpdateMessage()`, `buildAudioAppendMessage()`,
 *         `buildDynamicRouteContextMessage()`, `buildBargeInMessages()` y `buildToolResultMessage()`.
 *       * Deserializacion: `parseServerMessage()` y `dispatchToHandlers()`.
 *       * Normalizacion: `normalizeTemperature()` y `truncateInstructions()`.
 *       * Auxiliares privados: decodificacion de audio y armado de invocaciones de herramienta.
 *
 * @dependencias_internas
 *   - Tipos y constantes del protocolo (`./qwen-protocol.types.ts`).
 *   - `VoiceProviderEventHandlers` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Transformacion pura de datos: no abre sockets ni lee configuracion del entorno).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `action_events` (Los identificadores de llamada que se traducen aqui son los que se
 *     persisten como `provider_tool_call_id`).
 */

import type { ToolInvocation, VoiceProviderEventHandlers } from '../../../shared/ports/billing-voice-admin.ports';
import type { PhysicalVoiceToolName } from '../domain/voice-session-and-tools.types';
import {
  KNOWN_TOOL_NAMES,
  QWEN_AUDIO_MIME_TYPE,
  QWEN_DEFAULT_VOICE,
  QWEN_MAX_SESSION_PROMPT_CHARS,
  QWEN_TOOL_DECLARATIONS,
  type ParsedQwenServerMessage,
  type QwenAudioAppendPayload,
  type QwenConversationItemPayload,
  type QwenSessionUpdatePayload,
} from './qwen-protocol.types';

/** Temperatura de muestreo aplicada cuando el proyecto no declara una valida. */
const DEFAULT_TEMPERATURE = 0.7;

/** Temperatura maxima admitida por el motor alterno. */
const MAX_TEMPERATURE = 1.5;

/**
 * Mapeador estatico del protocolo nativo del motor de voz alterno.
 * Es puro y sin estado: la misma entrada produce siempre exactamente la misma trama.
 */
export class QwenProtocolMapper {
  /**
   * Construye la trama `session.update` que configura el canal recien abierto.
   *
   * @param modelName - Identificador del modelo en el proveedor.
   * @param systemPrompt - Instrucciones maestras con los pasos de onboarding.
   * @param voiceName - Persona de voz solicitada por el proyecto.
   * @param temperature - Temperatura de muestreo, ya normalizada.
   * @param sampleRateHz - Frecuencia de muestreo del audio negociada.
   * @returns Trama serializada de configuracion de sesion.
   */
  public static buildSessionUpdateMessage(
    modelName: string,
    systemPrompt: string,
    voiceName: string,
    temperature: number,
    sampleRateHz: number
  ): string {
    const payload: QwenSessionUpdatePayload = {
      type: 'session.update',
      session: {
        model: modelName,
        modalities: ['audio', 'text'],
        instructions: QwenProtocolMapper.truncateInstructions(systemPrompt),
        voice: voiceName.length > 0 ? voiceName : QWEN_DEFAULT_VOICE,
        temperature: QwenProtocolMapper.normalizeTemperature(temperature),
        input_audio_format: `${QWEN_AUDIO_MIME_TYPE};rate=${sampleRateHz}`,
        output_audio_format: `${QWEN_AUDIO_MIME_TYPE};rate=${sampleRateHz}`,
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        tools: QWEN_TOOL_DECLARATIONS.map((declaration) => ({ type: 'function' as const, function: declaration })),
        tool_choice: 'auto',
      },
    };
    return JSON.stringify(payload);
  }

  /**
   * Construye la trama de envio de un fragmento de audio del usuario final.
   * El audio viaja codificado en Base64 porque el protocolo es textual: enviarlo en crudo dentro de
   * un JSON produciria bytes invalidos y el motor descartaria la trama.
   *
   * @param pcmFrame - Audio PCM16 little-endian sin cabecera.
   * @returns Trama serializada de audio.
   */
  public static buildAudioAppendMessage(pcmFrame: Buffer): string {
    const payload: QwenAudioAppendPayload = {
      type: 'input_audio_buffer.append',
      audio: pcmFrame.toString('base64'),
    };
    return JSON.stringify(payload);
  }

  /**
   * Construye la trama que actualiza en caliente el contexto de ruta del usuario final.
   * Se envia como elemento de sistema para que el modelo conozca la pantalla actual sin reiniciar
   * la sesion ni perder el audio ya bufferizado.
   *
   * @param routePath - Ruta en la que se encuentra el usuario final.
   * @param visibleElementsSummary - Resumen legible de los elementos disponibles en esa ruta.
   * @returns Trama serializada de actualizacion de contexto.
   */
  public static buildDynamicRouteContextMessage(routePath: string, visibleElementsSummary: string): string {
    return JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `El usuario esta ahora en la ruta "${routePath}". Elementos disponibles: ${visibleElementsSummary}`,
          },
        ],
      },
    });
  }

  /**
   * Construye la secuencia de tramas que interrumpe de inmediato la reproduccion en curso.
   * El orden importa: cancelar la respuesta sin vaciar el buffer de salida dejaria audio ya generado
   * reproduciendose despues de la interrupcion, que es exactamente lo que el usuario acaba de pedir
   * que pare.
   *
   * @returns Par de tramas serializadas, en el orden exacto en que deben enviarse.
   */
  public static buildBargeInMessages(): readonly string[] {
    return [JSON.stringify({ type: 'response.cancel' }), JSON.stringify({ type: 'output_audio_buffer.clear' })];
  }

  /**
   * Construye la trama que devuelve el resultado de una herramienta ejecutada en el navegador.
   * El motor mantiene la llamada abierta hasta recibirla: sin este mensaje el asistente se queda
   * esperando indefinidamente y deja de responder al usuario.
   *
   * @param providerToolCallId - Identificador de la llamada que se confirma.
   * @param succeeded - Indica si la accion fisica se completo.
   * @param payload - Datos adicionales del resultado.
   * @returns Trama serializada con el resultado de la herramienta.
   */
  public static buildToolResultMessage(providerToolCallId: string, succeeded: boolean, payload: unknown): string {
    const message: QwenConversationItemPayload = {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: providerToolCallId,
        output: JSON.stringify({ success: succeeded, result: payload ?? null }),
      },
    };
    return JSON.stringify(message);
  }

  /**
   * Deserializa de forma defensiva una trama recibida del motor alterno.
   * El proveedor puede emitir tipos desconocidos o malformados: en ese caso se devuelve `UNKNOWN` en
   * lugar de lanzar, porque una trama rara no debe derribar una sesion de voz en curso.
   *
   * @param rawMessage - Texto crudo recibido por el socket.
   * @returns Mensaje tipado con su naturaleza y su carga util.
   */
  public static parseServerMessage(rawMessage: string): ParsedQwenServerMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage) as unknown;
    } catch {
      return { kind: 'UNKNOWN' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'UNKNOWN' };
    }

    const record = parsed as Record<string, unknown>;
    const messageType = typeof record['type'] === 'string' ? (record['type'] as string) : '';
    const rawServerPayload = record;

    switch (messageType) {
      case 'response.audio.delta':
      case 'response.output_item.audio': {
        const audioBuffer = QwenProtocolMapper.decodeAudioField(record['delta'] ?? record['audio']);
        return audioBuffer === null ? { kind: 'UNKNOWN', rawServerPayload } : { kind: 'AUDIO', audioBuffer, rawServerPayload };
      }

      case 'response.audio_transcript.delta': {
        const transcriptText = typeof record['delta'] === 'string' ? record['delta'] : '';
        return transcriptText.length === 0
          ? { kind: 'UNKNOWN', rawServerPayload }
          : { kind: 'TRANSCRIPT', transcriptText, isFinalTranscript: false, rawServerPayload };
      }

      case 'response.audio_transcript.done': {
        const transcriptText = typeof record['transcript'] === 'string' ? record['transcript'] : '';
        return transcriptText.length === 0
          ? { kind: 'UNKNOWN', rawServerPayload }
          : { kind: 'TRANSCRIPT', transcriptText, isFinalTranscript: true, rawServerPayload };
      }

      case 'response.function_call_arguments.delta': {
        const pendingToolCallId = typeof record['call_id'] === 'string' ? record['call_id'] : undefined;
        const pendingToolName = QwenProtocolMapper.normalizeToolName(record['name']);
        // `exactOptionalPropertyTypes` exige construir el objeto condicionalmente en lugar de
        // declarar las propiedades como `undefined`, que es un valor distinto de "ausente".
        return {
          kind: 'TOOL_CALL_READY',
          rawServerPayload,
          ...(pendingToolCallId === undefined ? {} : { pendingToolCallId }),
          ...(pendingToolName === undefined ? {} : { pendingToolName }),
        };
      }

      case 'response.function_call_arguments.done': {
        const toolInvocation = QwenProtocolMapper.buildToolInvocation(
          typeof record['call_id'] === 'string' ? record['call_id'] : '',
          QwenProtocolMapper.normalizeToolName(record['name']),
          record['arguments']
        );
        return toolInvocation === null ? { kind: 'UNKNOWN', rawServerPayload } : { kind: 'TOOL_CALL', toolInvocation, rawServerPayload };
      }

      case 'input_audio_buffer.speech_started':
        return { kind: 'SPEECH_STARTED', rawServerPayload };

      case 'input_audio_buffer.speech_stopped':
        return { kind: 'SPEECH_STOPPED', rawServerPayload };

      case 'response.cancelled':
      case 'output_audio_buffer.cleared':
        return { kind: 'INTERRUPTED', rawServerPayload };

      case 'response.done':
        return { kind: 'TURN_COMPLETE', rawServerPayload };

      case 'error':
      case 'session.failed': {
        const errorRecord =
          typeof record['error'] === 'object' && record['error'] !== null ? (record['error'] as Record<string, unknown>) : record;
        const message = typeof errorRecord['message'] === 'string' ? (errorRecord['message'] as string) : 'Error no detallado del motor de voz';
        return { kind: 'ERROR', errorReason: message, rawServerPayload };
      }

      default:
        return { kind: 'UNKNOWN', rawServerPayload };
    }
  }

  /**
   * Traduce la interpretacion de una trama a las llamadas de los manejadores del contrato comun.
   * Concentra aqui el enrutamiento para que el adaptador solo gestione el ciclo de vida del socket.
   *
   * @param message - Mensaje ya deserializado.
   * @param handlers - Manejadores registrados por el gateway de voz.
   * @returns `true` cuando el mensaje produjo al menos un efecto observable.
   */
  public static dispatchToHandlers(message: ParsedQwenServerMessage, handlers: VoiceProviderEventHandlers): boolean {
    switch (message.kind) {
      case 'AUDIO':
        if (message.audioBuffer === undefined) {
          return false;
        }
        // El aviso de "el asistente comenzo a hablar" NO se emite aqui: es una transicion de estado
        // del canal, y anunciarla en cada fragmento dispararia el detector de interrupcion decenas de
        // veces por segundo. El canal la emite una sola vez, al pasar de silencio a habla.
        handlers.onAudioFrame(message.audioBuffer);
        return true;

      case 'TRANSCRIPT':
        if (message.transcriptText === undefined) {
          return false;
        }
        handlers.onTranscript(message.transcriptText, message.isFinalTranscript === true);
        return true;

      case 'TOOL_CALL':
        if (message.toolInvocation === undefined) {
          return false;
        }
        handlers.onToolInvocation(message.toolInvocation);
        return true;

      case 'ERROR':
        handlers.onProviderError(message.errorReason ?? 'Error no detallado del motor de voz');
        return true;

      default:
        return false;
    }
  }

  /**
   * Normaliza la temperatura de muestreo al rango que acepta el motor.
   *
   * @param temperature - Temperatura solicitada.
   * @returns Temperatura acotada al rango [0, 1.5] o el valor por omision si no es finita.
   */
  public static normalizeTemperature(temperature: number): number {
    if (!Number.isFinite(temperature)) {
      return DEFAULT_TEMPERATURE;
    }
    return Math.min(Math.max(temperature, 0), MAX_TEMPERATURE);
  }

  /**
   * Trunca el prompt de sistema al limite que acepta el motor.
   *
   * @param systemPrompt - Prompt declarado por el proyecto.
   * @returns Prompt acotado al limite del proveedor.
   */
  public static truncateInstructions(systemPrompt: string): string {
    return systemPrompt.length <= QWEN_MAX_SESSION_PROMPT_CHARS
      ? systemPrompt
      : systemPrompt.slice(0, QWEN_MAX_SESSION_PROMPT_CHARS);
  }

  /**
   * Decodifica un campo de audio Base64 a un buffer PCM16.
   *
   * @param rawAudioField - Valor crudo del campo de audio.
   * @returns Buffer de audio, o `null` cuando el valor no es una cadena Base64 utilizable.
   */
  private static decodeAudioField(rawAudioField: unknown): Buffer | null {
    if (typeof rawAudioField !== 'string' || rawAudioField.length === 0) {
      return null;
    }
    try {
      const decoded = Buffer.from(rawAudioField, 'base64');
      return decoded.length === 0 ? null : decoded;
    } catch {
      return null;
    }
  }

  /**
   * Normaliza el nombre de herramienta declarado por el proveedor.
   *
   * @param rawToolName - Nombre crudo recibido.
   * @returns Nombre reconocido, o `undefined` cuando no corresponde a ninguna herramienta fisica.
   */
  private static normalizeToolName(rawToolName: unknown): PhysicalVoiceToolName | undefined {
    if (typeof rawToolName !== 'string') {
      return undefined;
    }
    const normalized = rawToolName.trim().toLowerCase();
    return KNOWN_TOOL_NAMES.find((knownName) => knownName === normalized);
  }

  /**
   * Construye la invocacion tipada de herramienta a partir de los argumentos del proveedor.
   * Los argumentos llegan como una cadena JSON que puede venir malformada o declarar una herramienta
   * desconocida: en ambos casos se descarta la invocacion en lugar de despachar una accion insegura.
   *
   * @param providerToolCallId - Identificador de la llamada.
   * @param toolName - Nombre normalizado de la herramienta.
   * @param rawArguments - Argumentos crudos, normalmente una cadena JSON.
   * @returns Invocacion lista para el despachador, o `null` cuando no es utilizable.
   */
  private static buildToolInvocation(
    providerToolCallId: string,
    toolName: PhysicalVoiceToolName | undefined,
    rawArguments: unknown
  ): ToolInvocation | null {
    if (providerToolCallId.length === 0 || toolName === undefined) {
      return null;
    }

    const parsedArguments = QwenProtocolMapper.parseToolArguments(rawArguments);
    if (parsedArguments === null) {
      return null;
    }

    const targetElementKey = typeof parsedArguments['elementKey'] === 'string' ? (parsedArguments['elementKey'] as string) : '';
    const textPayload = typeof parsedArguments['text'] === 'string' ? (parsedArguments['text'] as string) : null;
    return { providerToolCallId, toolName, targetElementKey, textPayload };
  }

  /**
   * Interpreta los argumentos de una llamada de herramienta.
   *
   * @param rawArguments - Argumentos crudos, en cadena JSON u objeto ya deserializado.
   * @returns Objeto de argumentos, o `null` cuando no es interpretable.
   */
  private static parseToolArguments(rawArguments: unknown): Record<string, unknown> | null {
    if (typeof rawArguments === 'string') {
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    if (typeof rawArguments === 'object' && rawArguments !== null && !Array.isArray(rawArguments)) {
      return rawArguments as Record<string, unknown>;
    }
    return null;
  }
}
