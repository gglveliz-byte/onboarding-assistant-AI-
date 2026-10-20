/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/qwen-protocol.types.ts
 * @modulo 05-voice-realtime-gateway (Constantes, Declaraciones y Tramas del Protocolo Qwen3.8-Omni)
 * @proposito
 *   Declara el vocabulario exacto del protocolo nativo del motor de voz alterno: sus constantes de
 *   audio, las declaraciones de las tres herramientas fisicas en su dialecto, las tramas que el
 *   backend le envia y la forma del mensaje deserializado que devuelve. Se separa del mapeador para
 *   que este conserve una unica responsabilidad —la traduccion— y para que cualquier consumidor
 *   pueda importar los tipos sin arrastrar la logica de serializacion.
 *
 * @resumen_contenido
 *   - Constantes `QWEN_AUDIO_MIME_TYPE`, `QWEN_DEFAULT_VOICE` y `QWEN_MAX_SESSION_PROMPT_CHARS`.
 *   - Interface `QwenFunctionDeclaration` y constante `QWEN_TOOL_DECLARATIONS`.
 *   - Interfaces de trama `QwenSessionUpdatePayload`, `QwenAudioAppendPayload`,
 *     `QwenConversationItemPayload` y `QwenUserTextItemPayload`.
 *   - Interface `ParsedQwenServerMessage`: mensaje deserializado del servidor.
 *
 * @dependencias_internas
 *   - `ToolInvocation` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `PhysicalVoiceToolName` (`../domain/voice-session-and-tools.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Declaraciones puras: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `action_events` (El `provider_tool_call_id` que se traduce aqui es el que se
 *     persiste en esa tabla).
 */

import type { ToolInvocation } from '../../../shared/ports/billing-voice-admin.ports';
import type { PhysicalVoiceToolName } from '../domain/voice-session-and-tools.types';

/** Tipo MIME con el que el motor alterno espera el audio del usuario final. */
export const QWEN_AUDIO_MIME_TYPE = 'audio/pcm';

/** Voz predeterminada del motor alterno cuando el proyecto no declara una persona propia (defecto de Qwen3.8-Omni-Realtime). */
export const QWEN_DEFAULT_VOICE = 'Tina';

/** Frecuencia nativa de SALIDA de audio de Qwen3.8-Omni-Realtime (24 kHz PCM16). */
export const QWEN_NATIVE_OUTPUT_RATE_HZ = 24000;

/** Frecuencia que espera el navegador/gateway en la bajada (16 kHz). Se remuestrea 24→16 en el mapper. */
export const QWEN_TARGET_OUTPUT_RATE_HZ = 16000;

/**
 * Limite de caracteres del prompt de sistema que acepta el motor alterno.
 * Un prompt mas largo se rechaza con un error de sesion, de modo que se trunca de forma explicita
 * y controlada en lugar de dejar que el proveedor cierre el canal.
 */
export const QWEN_MAX_SESSION_PROMPT_CHARS = 32000;

/** Declaracion de herramienta en el dialecto del motor alterno. */
export interface QwenFunctionDeclaration {
  /** Nombre de la herramienta, identico al del contrato comun del nucleo. */
  readonly name: PhysicalVoiceToolName;
  /** Descripcion en lenguaje natural que el motor usa para decidir cuando invocarla. */
  readonly description: string;
  /** Parametros declarados en JSON Schema. */
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Readonly<
      Record<string, { readonly type: 'string' | 'integer' | 'boolean'; readonly description: string }>
    >;
    readonly required: readonly string[];
  };
}

/**
 * Declaraciones de las tres herramientas fisicas en el dialecto del motor alterno.
 * Los nombres y los parametros son EXACTAMENTE los mismos que los del contrato comun: si un
 * adaptador renombrara una herramienta, el enrutador del gateway de voz no sabria despacharla y la
 * accion se perderia en silencio.
 */
export const QWEN_TOOL_DECLARATIONS: readonly QwenFunctionDeclaration[] = [
  {
    name: 'click_element',
    description: 'Hace clic en un elemento interactivo identificado por su clave del mapa funcional.',
    parameters: {
      type: 'object',
      properties: {
        elementKey: { type: 'string', description: 'Clave unica del elemento en el mapa funcional.' },
        reason: { type: 'string', description: 'Explicacion breve del clic para guiar al usuario.' },
      },
      required: ['elementKey'],
    },
  },
  {
    name: 'type_text',
    description: 'Escribe texto en un campo de entrada identificado por su clave del mapa funcional.',
    parameters: {
      type: 'object',
      properties: {
        elementKey: { type: 'string', description: 'Clave unica del campo de texto en el mapa funcional.' },
        text: { type: 'string', description: 'Texto que se introducira en el campo.' },
        reason: { type: 'string', description: 'Motivo de la escritura o indicacion para el usuario.' },
      },
      required: ['elementKey', 'text'],
    },
  },
  {
    name: 'advance_onboarding_step',
    description: 'Avanza formalmente al siguiente paso estructurado del flujo de onboarding guiado.',
    parameters: {
      type: 'object',
      properties: {
        currentStepNumber: { type: 'integer', description: 'Numero del paso recien completado.' },
        nextStepNumber: { type: 'integer', description: 'Numero del paso al que se procede.' },
        notes: { type: 'string', description: 'Resumen de los logros del paso o estado alcanzado.' },
      },
      required: ['currentStepNumber', 'nextStepNumber'],
    },
  },
];

/**
 * Trama de configuracion de sesion enviada al abrir el canal.
 * Qwen3.8-Omni-Flash-Realtime usa la forma ANIDADA `session.audio` (voz en `audio.output.voice`,
 * entrada a 16 kHz y SALIDA a 24 kHz) y `turn_detection: semantic_vad`. Se conserva `voice` de
 * compatibilidad en la raiz: si ambos existen, el proveedor usa `audio.output.voice`.
 */
export interface QwenSessionUpdatePayload {
  readonly type: 'session.update';
  readonly session: {
    readonly model: string;
    readonly modalities: readonly string[];
    readonly instructions: string;
    readonly voice: string;
    readonly temperature: number;
    readonly turn_detection: {
      readonly type: string;
      readonly threshold: number;
      readonly prefix_padding_ms: number;
      readonly silence_duration_ms: number;
    };
    readonly audio: {
      readonly input: {
        readonly format: {
          readonly type: 'pcm';
          readonly sample_rate: number;
          readonly sample_format: 's16le';
          readonly channels: number;
          readonly packing: 'interleaved';
          readonly channel_layout: 'mono';
        };
      };
      readonly output: {
        readonly voice: string;
        readonly format: { readonly type: 'pcm'; readonly sample_rate: number };
      };
    };
    readonly tools: readonly { readonly type: 'function'; readonly function: QwenFunctionDeclaration }[];
    readonly tool_choice: string;
  };
}

/** Trama de envio de audio del usuario final. */
export interface QwenAudioAppendPayload {
  readonly type: 'input_audio_buffer.append';
  readonly audio: string;
}

/** Trama de elemento de conversacion, usada para el resultado de una herramienta. */
export interface QwenConversationItemPayload {
  readonly type: 'conversation.item.create';
  readonly item: {
    readonly type: 'function_call_output';
    readonly call_id: string;
    readonly output: string;
  };
}

/**
 * Trama de elemento de conversacion de USUARIO EN TEXTO, usada para el turno inicial hablado.
 * El item entra al contexto igual que una frase dictada por el visitante: seguido de
 * `response.create` hace que el motor enuncie en voz alta la introduccion pedida.
 */
export interface QwenUserTextItemPayload {
  readonly type: 'conversation.item.create';
  readonly item: {
    readonly type: 'message';
    readonly role: 'user';
    readonly content: readonly { readonly type: 'input_text'; readonly text: string }[];
  };
}

/** Mensaje deserializado recibido desde el servidor del motor alterno. */
export interface ParsedQwenServerMessage {
  /** Naturaleza de la trama recibida. */
  readonly kind:
    | 'AUDIO'
    | 'TRANSCRIPT'
    | 'TOOL_CALL'
    | 'TOOL_CALL_READY'
    | 'SPEECH_STARTED'
    | 'SPEECH_STOPPED'
    | 'INTERRUPTED'
    | 'TURN_COMPLETE'
    | 'ERROR'
    | 'UNKNOWN';
  /** Audio PCM16 decodificado, presente en las tramas de audio. */
  readonly audioBuffer?: Buffer;
  /** Texto transcrito, presente en las tramas de transcripcion. */
  readonly transcriptText?: string;
  /** Indica si la transcripcion es definitiva y no parcial. */
  readonly isFinalTranscript?: boolean;
  /** Invocacion de herramienta ya completa y lista para despachar al navegador. */
  readonly toolInvocation?: ToolInvocation;
  /** Identificador de la llamada de herramienta cuyos argumentos empezaron a llegar. */
  readonly pendingToolCallId?: string;
  /** Nombre de la herramienta cuyos argumentos empezaron a llegar. */
  readonly pendingToolName?: PhysicalVoiceToolName;
  /** Motivo del error reportado por el motor. */
  readonly errorReason?: string;
  /** Carga util cruda recibida, conservada para diagnostico. */
  readonly rawServerPayload?: Record<string, unknown>;
}

/** Herramientas fisicas reconocidas, usadas para descartar nombres desconocidos del proveedor. */
export const KNOWN_TOOL_NAMES: readonly PhysicalVoiceToolName[] = [
  'click_element',
  'type_text',
  'advance_onboarding_step',
];
