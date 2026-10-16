/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/qwen-38-omni.adapter.ts
 * @modulo 05-voice-realtime-gateway (Adaptador del Motor de Voz Alterno Qwen3.8-Omni-Flash-Realtime)
 * @proposito
 *   Implementa los contratos `IVoiceRealtimeProvider` e `IActiveProviderStream` conectandose por
 *   WebSocket bidireccional al motor de voz alterno. Configura la sesion con el prompt paso a paso y
 *   las tres herramientas fisicas, transmite el audio del usuario final a traves del buffer circular
 *   volatil, actualiza el contexto de ruta en caliente cuando el usuario navega, y ejecuta la
 *   interrupcion inmediata enviando la cancelacion de respuesta seguida del vaciado del buffer de
 *   salida. La cancelacion mide su propia latencia y la reporta: el presupuesto de interrupcion es
 *   una promesa de producto, no una intencion.
 *
 * @resumen_contenido
 *   - Interface `Qwen38OmniAdapterOptions` y `BargeInLatencyReport`.
 *   - Clase `Qwen38OmniStream`: implementa `IActiveProviderStream`.
 *   - Clase `Qwen38OmniAdapter`: implementa `IVoiceRealtimeProvider`.
 *
 * @dependencias_internas
 *   - `QwenProtocolMapper` (`./qwen-protocol.mapper.ts`) para la traduccion del protocolo.
 *   - `Pcm16RingBuffer` (`./audio-pcm16-ring-buffer.ts`) para el buffer volatil y el analisis de voz.
 *   - `IVoiceRealtimeProvider` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `PortFailure` (`src/shared/ports/core-modules.ports.ts`).
 *
 * @dependencias_externas
 *   - `ws` (Cliente WebSocket binario de baja latencia; unico autorizado por el proyecto).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Adaptador de streaming: el audio jamas se persiste; solo el gateway de voz escribe
 *     las metricas agregadas de la sesion).
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
} from '../../../shared/ports/billing-voice-admin.ports';
import type { PortFailure } from '../../../shared/ports/core-modules.ports';
import { Pcm16RingBuffer } from './audio-pcm16-ring-buffer';
import { QwenProtocolMapper } from './qwen-protocol.mapper';

/** Opciones de inicializacion del adaptador del motor alterno. */
export interface Qwen38OmniAdapterOptions {
  /** URL del WebSocket del motor. */
  readonly wsUrl: string;
  /** Clave de API del backend. */
  readonly apiKey: string;
  /** Identificador del modelo en el proveedor. */
  readonly modelName?: string;
  /** Rol con el que se registra el adaptador dentro del failover. */
  readonly providerRole?: VoiceProviderRole;
  /** Tiempo maximo de espera de la apertura del socket, en milisegundos. */
  readonly connectTimeoutMs?: number;
  /** Presupuesto de interrupcion inmediata, en milisegundos (por omision, 50). */
  readonly bargeInBudgetMs?: number;
  /** Capacidad del buffer circular de audio, en milisegundos. */
  readonly ringBufferCapacityMs?: number;
  /** Factoria inyectable de clientes WebSocket para pruebas deterministas sin red externa. */
  readonly wsFactory?: ((url: string) => WebSocket) | undefined;
}

/** Medicion de una interrupcion inmediata, reportada para la auditoria de latencia. */
export interface BargeInLatencyReport {
  /** Indica si la interrupcion se completo dentro del presupuesto configurado. */
  readonly withinBudget: boolean;
  /** Latencia medida en milisegundos. */
  readonly elapsedMs: number;
  /** Presupuesto vigente en milisegundos. */
  readonly budgetMs: number;
  /** Indica si el canal estaba abierto y la orden pudo enviarse. */
  readonly delivered: boolean;
}

/**
 * Canal activo de streaming contra el motor de voz alterno.
 * Mantiene el buffer circular volatil del audio entrante y traduce las tramas del protocolo.
 */
export class Qwen38OmniStream implements IActiveProviderStream {
  public readonly providerKind: VoiceProviderKind = 'QWEN';
  public readonly providerRole: VoiceProviderRole;
  public readonly streamId: string;
  public readonly openedAtIso: string;

  private readonly ws: WebSocket;
  private readonly handlers: VoiceProviderEventHandlers;
  private readonly ringBuffer: Pcm16RingBuffer;
  private readonly bargeInBudgetMs: number;
  private isClosed = false;
  private assistantSpeaking = false;
  private lastBargeInReport: BargeInLatencyReport | null = null;

  /**
   * @param streamId - Identificador del canal.
   * @param role - Rol del motor dentro del failover.
   * @param ws - Socket ya abierto contra el motor.
   * @param handlers - Manejadores de eventos del gateway de voz.
   * @param bargeInBudgetMs - Presupuesto de interrupcion en milisegundos.
   * @param ringBufferCapacityMs - Capacidad del buffer volatil en milisegundos.
   */
  public constructor(
    streamId: string,
    role: VoiceProviderRole,
    ws: WebSocket,
    handlers: VoiceProviderEventHandlers,
    bargeInBudgetMs = 50,
    ringBufferCapacityMs = 2000
  ) {
    this.streamId = streamId;
    this.providerRole = role;
    this.ws = ws;
    this.handlers = handlers;
    this.bargeInBudgetMs = bargeInBudgetMs;
    this.openedAtIso = new Date().toISOString();
    this.ringBuffer = new Pcm16RingBuffer({ capacityMs: ringBufferCapacityMs });

    this.attachSocketListeners();
  }

  /**
   * Envia un fragmento de audio del usuario final hacia el motor.
   * El fragmento se registra en el buffer volatil para el analisis de voz y se codifica en Base64
   * antes de viajar por el socket, porque el protocolo de este motor es textual.
   *
   * @param pcmFrame - Audio PCM16 little-endian sin cabecera.
   */
  public sendAudioFrame(pcmFrame: Buffer): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN || pcmFrame.length === 0) {
      return;
    }

    this.ringBuffer.write(pcmFrame);
    this.ws.send(QwenProtocolMapper.buildAudioAppendMessage(pcmFrame));
  }

  /**
   * Envia el resultado de una herramienta ejecutada en el navegador del usuario final.
   * El motor mantiene la llamada abierta hasta recibir este mensaje: sin el, el asistente se queda
   * esperando indefinidamente y deja de responder al usuario.
   *
   * @param providerToolCallId - Identificador de la llamada que se confirma.
   * @param succeeded - Indica si la accion fisica se completo.
   * @param payload - Datos adicionales del resultado.
   */
  public sendToolResult(providerToolCallId: string, succeeded: boolean, payload: unknown): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(QwenProtocolMapper.buildToolResultMessage(providerToolCallId, succeeded, payload));
  }

  /**
   * Actualiza en caliente el contexto de ruta del usuario final, sin reiniciar la sesion.
   *
   * @param routePath - Ruta en la que se encuentra el usuario final.
   * @param visibleElementsSummary - Resumen legible de los elementos de esa ruta.
   * @returns `true` cuando el contexto se envio al motor.
   */
  public updateDynamicRouteContext(routePath: string, visibleElementsSummary: string): boolean {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(QwenProtocolMapper.buildDynamicRouteContextMessage(routePath, visibleElementsSummary));
    return true;
  }

  /**
   * Interrumpe de inmediato la reproduccion en curso y mide la latencia real de la orden.
   * Se envian las dos tramas en el orden exacto que exige el protocolo: cancelar sin vaciar el
   * buffer de salida dejaria audio reproduciendose despues de la interrupcion del usuario.
   */
  public requestBargeIn(): void {
    const startedAtMs = Date.now();
    this.assistantSpeaking = false;

    const delivered = !this.isClosed && this.ws.readyState === WebSocket.OPEN;
    if (delivered) {
      for (const message of QwenProtocolMapper.buildBargeInMessages()) {
        this.ws.send(message);
      }
    }

    const elapsedMs = Date.now() - startedAtMs;
    this.lastBargeInReport = Object.freeze({
      withinBudget: elapsedMs <= this.bargeInBudgetMs,
      elapsedMs,
      budgetMs: this.bargeInBudgetMs,
      delivered,
    });
  }

  /**
   * Devuelve la medicion de la ultima interrupcion inmediata.
   *
   * @returns Reporte de latencia, o `null` cuando aun no se ha interrumpido.
   */
  public getLastBargeInReport(): BargeInLatencyReport | null {
    return this.lastBargeInReport;
  }

  /**
   * Devuelve las estadisticas del buffer volatil de audio.
   *
   * @returns Estadisticas de uso del anillo.
   */
  public getRingBufferStatistics(): ReturnType<Pcm16RingBuffer['getStatistics']> {
    return this.ringBuffer.getStatistics();
  }

  /**
   * Indica si el motor detecto voz del usuario final en el audio pendiente.
   *
   * @returns `true` cuando el audio pendiente supera el umbral de voz.
   */
  public isUserVoiceDetected(): boolean {
    return this.ringBuffer.isVoiceDetected();
  }

  /**
   * Cierra el canal de forma ordenada y purga el audio residente en memoria.
   *
   * @param status - Estado final de la sesion de voz.
   */
  public async close(status: VoiceSessionStatus): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, `Cierre de sesion: ${status}`);
      }
    } catch {
      // Un fallo al cerrar no debe impedir la purga del audio ni la notificacion al gateway.
    } finally {
      // La purga ocurre SIEMPRE, incluso si el socket fallo: el audio no puede quedar en memoria.
      this.ringBuffer.purge();
      this.handlers.onClosed(status);
    }
  }

  /**
   * Registra los escuchas del socket y enruta cada trama a su efecto correspondiente.
   */
  private attachSocketListeners(): void {
    this.ws.on('message', (data: WebSocket.RawData) => {
      if (this.isClosed) {
        return;
      }

      const message = QwenProtocolMapper.parseServerMessage(data.toString());

      // El aviso de habla se emite UNA sola vez por turno, al pasar de silencio a habla: el detector
      // de interrupcion del gateway lo usa para saber si el usuario interrumpio al asistente, y
      // emitirlo en cada fragmento lo dispararia decenas de veces por segundo.
      if (message.kind === 'AUDIO' && !this.assistantSpeaking) {
        this.assistantSpeaking = true;
        this.handlers.onAssistantSpeechStarted();
      }
      if (message.kind === 'INTERRUPTED' || message.kind === 'TURN_COMPLETE') {
        this.assistantSpeaking = false;
      }

      QwenProtocolMapper.dispatchToHandlers(message, this.handlers);
    });

    this.ws.on('error', (error: Error) => {
      if (this.isClosed) {
        return;
      }
      this.handlers.onProviderError(error.message);
    });

    this.ws.on('close', () => {
      if (!this.isClosed) {
        // Un cierre inesperado se reporta como fallo para habilitar la ruta de conmutacion.
        this.ringBuffer.purge();
        this.isClosed = true;
        this.handlers.onProviderError('El canal con el motor de voz alterno se cerro de forma inesperada.');
        this.handlers.onClosed('FAILED_PROVIDER_ERROR');
      }
    });
  }
}

/**
 * Adaptador oficial del motor de voz alterno para streaming bidireccional.
 * Es el proveedor de respaldo de la estrategia de conmutacion, pero funciona de forma autonoma.
 */
export class Qwen38OmniAdapter implements IVoiceRealtimeProvider {
  public readonly providerKind: VoiceProviderKind = 'QWEN';
  public readonly providerRole: VoiceProviderRole;

  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly connectTimeoutMs: number;
  private readonly bargeInBudgetMs: number;
  private readonly ringBufferCapacityMs: number;
  private readonly wsFactory: ((url: string) => WebSocket) | undefined;

  /**
   * @param options - Credenciales, endpoint, tiempos y factoria de sockets opcional.
   */
  public constructor(options: Qwen38OmniAdapterOptions) {
    this.wsUrl = options.wsUrl;
    this.apiKey = options.apiKey;
    this.modelName = options.modelName ?? 'qwen3.8-omni-flash-realtime';
    this.providerRole = options.providerRole ?? 'FAILOVER';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.bargeInBudgetMs = options.bargeInBudgetMs ?? 50;
    this.ringBufferCapacityMs = options.ringBufferCapacityMs ?? 2000;
    this.wsFactory = options.wsFactory;
  }

  /**
   * Comprueba la disponibilidad del motor antes de intentar abrir un canal.
   *
   * @returns `true` cuando hay endpoint y credencial utilizables.
   */
  public async isAvailable(): Promise<boolean> {
    return this.apiKey.trim().length >= 10 && this.wsUrl.trim().length > 0;
  }

  /**
   * Abre un canal de streaming bidireccional contra el motor alterno.
   *
   * @param request - Configuracion de la sesion y el prompt vigente.
   * @param handlers - Manejadores de los eventos emitidos por el motor.
   * @returns Canal activo listo para enviar audio, o fallo normalizado de disponibilidad.
   */
  public async openStream(
    request: VoiceStreamOpenRequest,
    handlers: VoiceProviderEventHandlers
  ): Promise<{ readonly ok: true; readonly stream: IActiveProviderStream } | PortFailure> {
    if (!(await this.isAvailable())) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'El motor de voz alterno no tiene endpoint o credencial validos configurados.',
        retryable: true,
      };
    }

    try {
      const fullUrl = this.buildFullWsUrl();
      const ws = this.wsFactory === undefined ? new WebSocket(fullUrl, { headers: this.buildAuthHeaders() }) : this.wsFactory(fullUrl);

      await this.awaitSocketOpen(ws);

      const temperature = QwenProtocolMapper.normalizeTemperature(Number.parseFloat(request.modelTemperature));
      ws.send(
        QwenProtocolMapper.buildSessionUpdateMessage(
          this.modelName,
          request.systemPrompt,
          request.voicePersonaCode,
          temperature,
          request.pcmSampleRateHz
        )
      );

      const streamId = `qwen_stream_${request.voiceSessionId}_${Date.now()}`;
      return {
        ok: true,
        stream: new Qwen38OmniStream(
          streamId,
          this.providerRole,
          ws,
          handlers,
          this.bargeInBudgetMs,
          this.ringBufferCapacityMs
        ),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: `No se pudo abrir el canal con el motor de voz alterno: ${reason}`,
        retryable: true,
      };
    }
  }

  /**
   * Espera la apertura del socket dentro del presupuesto de tiempo configurado.
   *
   * @param ws - Socket recien creado.
   * @throws Error cuando expira el tiempo de conexion o el socket falla al abrir.
   */
  private async awaitSocketOpen(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Tiempo de conexion agotado con el motor de voz alterno (${this.connectTimeoutMs}ms).`));
      }, this.connectTimeoutMs);

      ws.once('open', () => {
        clearTimeout(timeoutHandle);
        resolve();
      });

      ws.once('error', (error: Error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  }

  /**
   * Compone las cabeceras de autenticacion del handshake.
   * La credencial viaja en la cabecera y no en la URL: una URL queda registrada en los logs de
   * proxies y servidores intermedios, y una clave filtrada por esa via es una fuga dificil de cerrar.
   *
   * @returns Cabeceras HTTP del handshake.
   */
  private buildAuthHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'x-client-role': this.providerRole.toLowerCase(),
    };
  }

  /**
   * Compone la URL completa del socket.
   *
   * @returns URL del WebSocket del motor alterno.
   */
  private buildFullWsUrl(): string {
    const normalizedBase = this.wsUrl.replace(/\/$/u, '');
    const delimiter = normalizedBase.includes('?') ? '&' : '?';
    return `${normalizedBase}${delimiter}model=${encodeURIComponent(this.modelName)}`;
  }
}
