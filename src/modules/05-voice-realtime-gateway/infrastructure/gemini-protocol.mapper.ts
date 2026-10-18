/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/gemini-protocol.mapper.ts
 * @modulo 05-voice-realtime-gateway (Mapeador de Protocolo BidiGenerateContent de Gemini Live)
 * @proposito
 *   Serializa y deserializa las tramas JSON y binarias del protocolo WebSocket bidireccional
 *   `BidiGenerateContent` de Gemini 3.8 Live. Convierte frames PCM16 a Base64, extrae
 *   llamadas a herramientas Function Calling y calcula la latencia Time-To-First-Audio (TTFA).
 *
 * @resumen_contenido
 *   - Interfaces del protocolo BidiGenerateContent de Gemini.
 *   - Clase estatica `GeminiProtocolMapper` con metodos puros de conversion.
 *
 * @dependencias_internas
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Tipos `ToolInvocation`.
 *   - `../domain/voice-session-and-tools.types.ts`: Declaraciones de herramientas y tipos.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Mapeador puro sin estado de base de datos ni I/O).
 */

import { ToolInvocation } from '@shared/ports/billing-voice-admin.ports';
import {
  GEMINI_TOOL_DECLARATIONS,
  GeminiFunctionDeclaration,
  PhysicalVoiceToolName,
} from '../domain/voice-session-and-tools.types';

/** Trama de inicializacion `setup` enviada al abrir la conexion con Gemini Live. */
export interface GeminiBidiSetupPayload {
  readonly setup: {
    readonly model: string;
    readonly generationConfig?: {
      readonly responseModalities?: readonly string[];
      readonly temperature?: number;
      readonly speechConfig?: {
        readonly voiceConfig?: {
          readonly prebuiltVoiceConfig?: {
            readonly voiceName?: string;
          };
        };
      };
    };
    readonly systemInstruction?: {
      readonly parts: readonly { readonly text: string }[];
    };
    readonly tools?: readonly {
      readonly functionDeclarations: readonly GeminiFunctionDeclaration[];
    }[];
  };
}

/** Trama de entrada de audio en streaming `realtimeInput`. */
export interface GeminiBidiRealtimeInputPayload {
  readonly realtimeInput: {
    readonly audio: {
      readonly mimeType: string;
      readonly data: string;
    };
  };
}

/** Trama de respuesta a una llamada de herramienta Function Calling. */
export interface GeminiBidiToolResponsePayload {
  readonly toolResponse: {
    readonly functionResponses: readonly {
      readonly response: {
        readonly output: Record<string, unknown>;
      };
      readonly id: string;
    }[];
  };
}

/** Mensaje deserializado recibido desde el servidor de Gemini Live. */
export interface ParsedGeminiServerMessage {
  readonly kind: 'AUDIO' | 'TRANSCRIPT' | 'TOOL_CALL' | 'INTERRUPTED' | 'TURN_COMPLETE' | 'UNKNOWN';
  readonly audioBuffer?: Buffer;
  readonly transcriptText?: string;
  readonly isFinalTranscript?: boolean;
  readonly toolInvocations?: readonly ToolInvocation[];
  readonly rawServerPayload?: Record<string, unknown>;
}

/**
 * Mapeador estatico para el protocolo `BidiGenerateContent` de Gemini 3.8 Live.
 */
export class GeminiProtocolMapper {
  /**
   * Construye el mensaje JSON inicial `setup` para configurar el stream con Gemini.
   *
   * @param modelName - Nombre del modelo (ej: "models/gemini-3.8-live" o "models/gemini-2.0-flash-exp").
   * @param systemPrompt - Instrucciones maestras de sistema y pasos de onboarding.
   * @param voiceName - Nombre de la voz predeterminada (ej: "Puck", "Charon", "Aoede").
   * @param temperature - Temperatura de muestreo del modelo (ej: 0.7).
   */
  public static buildSetupMessage(
    modelName: string,
    systemPrompt: string,
    voiceName = 'Puck',
    temperature = 0.7
  ): string {
    const payload: GeminiBidiSetupPayload = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        tools: [
          {
            functionDeclarations: GEMINI_TOOL_DECLARATIONS,
          },
        ],
      },
    };

    return JSON.stringify(payload);
  }

  /**
   * Serializa un chunk de audio PCM16 Little-Endian a la trama `realtimeInput`.
   * El campo vigente del protocolo BidiGenerateContent es `audio`; la forma heredada
   * `mediaChunks` era ignorada en silencio por el servidor, de modo que el motor jamas escuchaba
   * al usuario final (ni VAD, ni turnos, ni llamadas de herramienta).
   *
   * @param pcmFrame - Buffer binario con datos de audio PCM16.
   * @param sampleRateHz - Frecuencia de muestreo (16000 por omision).
   */
  public static buildAudioChunkMessage(pcmFrame: Buffer, sampleRateHz = 16000): string {
    const payload: GeminiBidiRealtimeInputPayload = {
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${sampleRateHz}`,
          data: pcmFrame.toString('base64'),
        },
      },
    };

    return JSON.stringify(payload);
  }

  /**
   * Serializa la respuesta de ejecucion de una herramienta DOM al mensaje `toolResponse`.
   *
   * @param providerToolCallId - Identificador de la llamada que retorno Gemini.
   * @param succeeded - Si la accion fisica se concreto.
   * @param payload - Datos complementarios (ej: selector usado o error capturado).
   */
  public static buildToolResponseMessage(
    providerToolCallId: string,
    succeeded: boolean,
    payload: unknown
  ): string {
    const output: Record<string, unknown> = {
      success: succeeded,
      ...(typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : { details: payload }),
    };

    const message: GeminiBidiToolResponsePayload = {
      toolResponse: {
        functionResponses: [
          {
            id: providerToolCallId,
            response: { output },
          },
        ],
      },
    };

    return JSON.stringify(message);
  }

  /**
   * Deserializa y clasifica un mensaje crudo enviado por el WebSocket de Gemini.
   *
   * @param raw - Mensaje recibido (cadena JSON o Buffer).
   * @returns Mensaje normalizado y clasificado.
   */
  public static parseServerMessage(raw: string | Buffer): ParsedGeminiServerMessage {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const obj = JSON.parse(text) as Record<string, unknown>;

      // 1. Deteccion de llamada a herramientas (toolCall)
      if (typeof obj['toolCall'] === 'object' && obj['toolCall'] !== null) {
        const toolCall = obj['toolCall'] as Record<string, unknown>;
        const fCalls = Array.isArray(toolCall['functionCalls']) ? toolCall['functionCalls'] : [];
        const invocations: ToolInvocation[] = [];

        for (const fc of fCalls) {
          const callId = typeof fc['id'] === 'string' ? fc['id'] : `call_${Date.now()}`;
          const name = typeof fc['name'] === 'string' ? fc['name'] : '';
          const args = typeof fc['args'] === 'object' && fc['args'] !== null
            ? (fc['args'] as Record<string, unknown>)
            : {};

          if (name === 'click_element' || name === 'type_text' || name === 'advance_onboarding_step') {
            invocations.push({
              providerToolCallId: callId,
              toolName: name as PhysicalVoiceToolName,
              targetElementKey: typeof args['elementKey'] === 'string' ? args['elementKey'] : '',
              textPayload: typeof args['text'] === 'string' ? args['text'] : null,
            });
          }
        }

        if (invocations.length > 0) {
          return {
            kind: 'TOOL_CALL',
            toolInvocations: invocations,
            rawServerPayload: obj,
          };
        }
      }

      // 2. Deteccion de contenido del servidor (serverContent)
      if (typeof obj['serverContent'] === 'object' && obj['serverContent'] !== null) {
        const sc = obj['serverContent'] as Record<string, unknown>;

        // Interrupcion (Barge-In detectado por el modelo)
        if (sc['interrupted'] === true) {
          return {
            kind: 'INTERRUPTED',
            rawServerPayload: obj,
          };
        }

        // Fin de turno
        if (sc['turnComplete'] === true) {
          return {
            kind: 'TURN_COMPLETE',
            rawServerPayload: obj,
          };
        }

        // Modelo generando contenido (modelTurn)
        if (typeof sc['modelTurn'] === 'object' && sc['modelTurn'] !== null) {
          const mt = sc['modelTurn'] as Record<string, unknown>;
          const parts = Array.isArray(mt['parts']) ? mt['parts'] : [];

          for (const p of parts) {
            // Audio inlineData
            if (typeof p['inlineData'] === 'object' && p['inlineData'] !== null) {
              const id = p['inlineData'] as Record<string, unknown>;
              if (typeof id['data'] === 'string') {
                const audioBuffer = Buffer.from(id['data'], 'base64');
                return {
                  kind: 'AUDIO',
                  audioBuffer,
                  rawServerPayload: obj,
                };
              }
            }

            // Texto o transcripcion
            if (typeof p['text'] === 'string' && p['text'].length > 0) {
              return {
                kind: 'TRANSCRIPT',
                transcriptText: p['text'],
                isFinalTranscript: false,
                rawServerPayload: obj,
              };
            }
          }
        }
      }

      return { kind: 'UNKNOWN', rawServerPayload: obj };
    } catch {
      return { kind: 'UNKNOWN' };
    }
  }
}
