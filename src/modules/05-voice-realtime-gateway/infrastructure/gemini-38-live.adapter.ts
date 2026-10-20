/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/gemini-38-live.adapter.ts
 * @modulo 05-voice-realtime-gateway (Adaptador de Gemini 3.8 Live BidiGenerateContent)
 * @proposito
 *   Implementa los contratos `IVoiceRealtimeProvider` e `IActiveProviderStream` conectandose
 *   directamente mediante WebSocket bidireccional al protocolo `BidiGenerateContent` de Gemini.
 *   Transmite audio PCM16 a 16kHz, procesa invocaciones de herramientas DOM y ejecuta
 *   cancelaciones instantaneas de Barge-in ante interrupcion del usuario final.
 *
 * @resumen_contenido
 *   - Clase `Gemini38LiveStream`: Implementa `IActiveProviderStream`.
 *   - Clase `Gemini38LiveAdapter`: Implementa `IVoiceRealtimeProvider`.
 *
 * @dependencias_internas
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Interfaces oficiales de voz.
 *   - `@shared/ports/core-modules.ports.ts`: Fallos tipados `PortFailure`.
 *   - `@shared/kernel/result-and-errors.ts`: Utilidades de error.
 *   - `./gemini-protocol.mapper.ts`: Serializador de mensajes del protocolo.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Adaptador de streaming de red).
 */

import WebSocket from 'ws';
import {
  IActiveProviderStream,
  IVoiceRealtimeProvider,
  VoiceProviderEventHandlers,
  VoiceProviderKind,
  VoiceProviderRole,
  VoiceSessionStatus,
  VoiceStreamOpenRequest,
} from '@shared/ports/billing-voice-admin.ports';
import { PortFailure } from '@shared/ports/core-modules.ports';
import { GeminiProtocolMapper } from './gemini-protocol.mapper';

/** Opciones de inicializacion del adaptador Gemini Live. */
export interface Gemini38LiveAdapterOptions {
  readonly wsUrl: string;
  readonly apiKey: string;
  readonly modelName?: string;
  readonly providerRole?: VoiceProviderRole;
  readonly connectTimeoutMs?: number;
  /** Factoria inyectable de clientes WebSocket para pruebas deterministas sin red externa. */
  readonly wsFactory?: ((url: string) => WebSocket) | undefined;
}

/**
 * Canal activo de streaming contra Gemini 3.8 Live.
 */
export class Gemini38LiveStream implements IActiveProviderStream {
  public readonly providerKind: VoiceProviderKind = 'GEMINI';
  public readonly providerRole: VoiceProviderRole;
  public readonly streamId: string;
  public readonly openedAtIso: string;

  private readonly ws: WebSocket;
  private readonly handlers: VoiceProviderEventHandlers;
  private readonly sampleRateHz: number;
  private isClosed = false;
  private assistantSpeaking = false;

  public constructor(
    streamId: string,
    role: VoiceProviderRole,
    ws: WebSocket,
    handlers: VoiceProviderEventHandlers,
    sampleRateHz = 16000
  ) {
    this.streamId = streamId;
    this.providerRole = role;
    this.ws = ws;
    this.handlers = handlers;
    this.sampleRateHz = sampleRateHz;
    this.openedAtIso = new Date().toISOString();

    this.attachSocketListeners();
  }

  public sendAudioFrame(pcmFrame: Buffer): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = GeminiProtocolMapper.buildAudioChunkMessage(pcmFrame, this.sampleRateHz);
    this.ws.send(message);
  }

  public sendToolResult(providerToolCallId: string, succeeded: boolean, payload: unknown): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = GeminiProtocolMapper.buildToolResponseMessage(
      providerToolCallId,
      succeeded,
      payload
    );
    this.ws.send(message);
  }

  public requestBargeIn(): void {
    this.assistantSpeaking = false;
    // Gemini interrumpe su propia generacion cuando su VAD detecta voz del usuario en el flujo
    // `realtimeInput.audio`: el cliente no envia ningun mensaje de interrupcion (la trama heredada
    // `mediaChunks: []` no surtia efecto alguno). El reinicio local basta para que el proximo audio
    // del modelo vuelva a anunciarse con `onAssistantSpeechStarted()`.
  }

  public async close(status: VoiceSessionStatus): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, `Session closed: ${status}`);
      }
    } catch {
      // Ignora errores durante el cierre ordenado
    } finally {
      this.handlers.onClosed(status);
    }
  }

  private attachSocketListeners(): void {
    this.ws.on('message', (data: WebSocket.RawData) => {
      if (this.isClosed) return;

      const parsed = GeminiProtocolMapper.parseServerMessage(data.toString());

      switch (parsed.kind) {
        case 'AUDIO':
          if (parsed.audioBuffer) {
            if (!this.assistantSpeaking) {
              this.assistantSpeaking = true;
              this.handlers.onAssistantSpeechStarted();
            }
            this.handlers.onAudioFrame(parsed.audioBuffer);
          }
          break;

        case 'TRANSCRIPT':
          if (typeof parsed.transcriptText === 'string') {
            this.handlers.onTranscript(parsed.transcriptText, Boolean(parsed.isFinalTranscript));
          }
          break;

        case 'TOOL_CALL':
          if (parsed.toolInvocations) {
            for (const inv of parsed.toolInvocations) {
              this.handlers.onToolInvocation(inv);
            }
          }
          break;

        case 'INTERRUPTED':
          this.assistantSpeaking = false;
          break;

        case 'TURN_COMPLETE':
          this.assistantSpeaking = false;
          break;

        default:
          break;
      }
    });

    this.ws.on('error', (err: Error) => {
      if (this.isClosed) return;
      this.handlers.onProviderError(err.message);
    });

    this.ws.on('close', () => {
      if (!this.isClosed) {
        this.close('COMPLETED_NORMAL').catch(() => {});
      }
    });
  }
}

/**
 * Adaptador oficial del proveedor Gemini 3.8 Live para streaming bidireccional.
 */
export class Gemini38LiveAdapter implements IVoiceRealtimeProvider {
  public readonly providerKind: VoiceProviderKind = 'GEMINI';
  public readonly providerRole: VoiceProviderRole;

  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly connectTimeoutMs: number;
  private readonly wsFactory?: ((url: string) => WebSocket) | undefined;

  public constructor(options: Gemini38LiveAdapterOptions) {
    this.wsUrl = options.wsUrl;
    this.apiKey = options.apiKey;
    this.modelName = options.modelName ?? 'models/gemini-3.8-live';
    this.providerRole = options.providerRole ?? 'PRIMARY';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.wsFactory = options.wsFactory;
  }

  public async isAvailable(): Promise<boolean> {
    // Si la clave de API o la URL no estan configuradas, el proveedor no esta disponible
    return Boolean(this.apiKey && this.apiKey.length >= 10 && this.wsUrl);
  }

  public async openStream(
    request: VoiceStreamOpenRequest,
    handlers: VoiceProviderEventHandlers
  ): Promise<{ readonly ok: true; readonly stream: IActiveProviderStream } | PortFailure> {
    const isAvail = await this.isAvailable();
    if (!isAvail) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'El adaptador Gemini 3.8 Live no cuenta con credenciales o endpoint validos configurados',
        retryable: true,
      };
    }

    try {
      const fullUrl = this.buildFullWsUrl();
      const ws = this.wsFactory ? this.wsFactory(fullUrl) : new WebSocket(fullUrl);

      const streamId = `gemini_stream_${request.voiceSessionId}_${Date.now()}`;

      // Espera apertura del WebSocket dentro del presupuesto de tiempo
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error(`Timeout de conexion con Gemini Live (${this.connectTimeoutMs}ms)`));
        }, this.connectTimeoutMs);

        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });

        ws.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Envia trama setup inicial de protocolo
      const tempNum = Number.parseFloat(request.modelTemperature) || 0.7;
      const setupMsg = GeminiProtocolMapper.buildSetupMessage(
        this.modelName,
        request.systemPrompt,
        request.voicePersonaCode || 'Puck',
        tempNum
      );
      ws.send(setupMsg);

      // Saludo inicial (turno de introduccion de la demo): la Live API ignora los turnos que
      // llegan antes del aviso `setupComplete`, asi que se aguarda (con tope de seguridad)
      // para que la primera frase audible salga SIEMPRE, aunque el usuario aun no hable.
      const introductoryPrompt = request.introductorySpokenPrompt;
      if (introductoryPrompt !== undefined && introductoryPrompt.length > 0) {
        await Gemini38LiveAdapter.awaitSetupConfirmation(ws);
        ws.send(GeminiProtocolMapper.buildClientTextTurnMessage(introductoryPrompt));
      }

      const activeStream = new Gemini38LiveStream(
        streamId,
        this.providerRole,
        ws,
        handlers,
        request.pcmSampleRateHz
      );

      return {
        ok: true,
        stream: activeStream,
      };
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: `Fallo al abrir canal con Gemini 3.8 Live: ${errMessage}`,
        retryable: true,
      };
    }
  }

  /**
   * Espera la confirmacion `setupComplete` del servidor con un tope de seguridad.
   * Al expirar el tope se devuelve el control igualmente (best-effort): un saludo emitido un
   * instante tarde es preferible a una demostracion que se queda muda si el aviso nunca llega.
   *
   * @param ws - Socket recien configurado con la trama `setup`.
   */
  private static async awaitSetupConfirmation(ws: WebSocket, maxWaitMs = 1500): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      const onSetupDone = (data: WebSocket.RawData): void => {
        const text = typeof data === 'string' ? data : data.toString();
        if (!text.includes('"setupComplete"')) return;
        clearTimeout(timer);
        ws.off('message', onSetupDone);
        resolve();
      };
      ws.on('message', onSetupDone);
    });
  }

  private buildFullWsUrl(): string {
    const delimiter = this.wsUrl.includes('?') ? '&' : '?';
    return `${this.wsUrl}${delimiter}key=${encodeURIComponent(this.apiKey)}`;
  }
}
