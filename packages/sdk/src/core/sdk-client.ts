/**
 * @archivo packages/sdk/src/core/sdk-client.ts
 * @modulo @onboarding-assistant/sdk (Cliente Oficial del SDK Web)
 * @proposito
 *   Punto de entrada principal del cliente `@onboarding-assistant/sdk`. Coordina el
 *   handshake seguro con el backend (`POST /api/v1/sdk/handshake`), la conexión WebSocket
 *   binaria con el Gateway de Voz (`WSS /ws/v1/realtime`), la detección automática de rutas
 *   en SPAs (`route.changed`), la cancelación inmediata de Barge-in (`<5ms`) y el despacho
 *   de órdenes de herramientas físicas sobre el DOM delegadas al `ActionExecutor`.
 *
 * @resumen_contenido
 *   - Interfaz de opciones `OnboardingAssistantOptions`.
 *   - Clase `OnboardingAssistantClient`:
 *     - `init(options)`: Método estático de arranque.
 *     - `start()`: Handshake y apertura de socket bidireccional.
 *     - `stop()`: Cierre limpio de sesión y desenganche de observadores.
 *     - `attachSpaNavigationTracking()`: Interceptores de `pushState` y `popstate`.
 *     - `handleIncomingGatewayMessage()`: Deserialización de tramas JSON y binarias.
 *
 * @dependencias_internas
 *   - `ActionExecutor`, `ToolExecutePayload` (../dom/action-executor.ts).
 *   - `SensitiveFieldScrubber`, `defaultSensitiveFieldScrubber` (../security/sensitive-field-scrubber.ts).
 */

import { ActionExecutor, ToolExecutePayload } from '../dom/action-executor';
import {
  SensitiveFieldScrubber,
  defaultSensitiveFieldScrubber,
} from '../security/sensitive-field-scrubber';

/** Configuración de inicialización del SDK `@onboarding-assistant/sdk`. */
export interface OnboardingAssistantOptions {
  /** Clave publicable de la organización (`pk_live_...`). */
  readonly publishableKey: string;
  /** URL base de la API REST (por defecto `https://api.plataforma.com`). */
  readonly apiUrl?: string | undefined;
  /** URL base del Gateway de Voz (por defecto `wss://voice.plataforma.com/ws/v1/realtime`). */
  readonly websocketUrl?: string | undefined;
  /** Mostrar cursor virtual asistido en pantalla (por defecto `true`). */
  readonly showVirtualCursor?: boolean | undefined;
  /** Monitoreo automático de navegación en Single Page Applications (por defecto `true`). */
  readonly autoTrackSpaRoutes?: boolean | undefined;
  /** Habilitar logs detallados en la consola del navegador. */
  readonly debug?: boolean | undefined;
  /** Callback invocado cuando el asistente completa un paso. */
  readonly onStepAdvanced?: ((stepIndex: number) => void) | undefined;
  /** Callback invocado cuando la sesión se cierra (ej. por saldo o corte). */
  readonly onSessionTerminated?: ((reason: string, closeCode: number) => void) | undefined;
  /** Scrubber personalizado de privacidad. */
  readonly scrubber?: SensitiveFieldScrubber | undefined;
}

/** Respuesta del endpoint de Handshake del backend. */
interface SdkHandshakeResponse {
  readonly sessionId: string;
  readonly handshakeNonce: string;
  readonly allowedOrigin: string;
  readonly voiceGatewayWsUrl?: string | undefined;
  readonly maxSessionMinutes?: number | undefined;
}

/**
 * Cliente principal del SDK Onboarding Assistant.
 */
export class OnboardingAssistantClient {
  private readonly options: OnboardingAssistantOptions;
  private readonly actionExecutor: ActionExecutor;
  private readonly scrubber: SensitiveFieldScrubber;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private active = false;
  private currentPath = '';
  private detachNavigation: (() => void) | null = null;

  public constructor(options: OnboardingAssistantOptions) {
    if (!options.publishableKey || !options.publishableKey.startsWith('pk_live_')) {
      throw new Error("Clave inválida: Debe proporcionar una clave publicable válida ('pk_live_...')");
    }
    this.options = options;
    this.scrubber = options.scrubber ?? defaultSensitiveFieldScrubber;
    this.actionExecutor = new ActionExecutor(this.scrubber, options.showVirtualCursor ?? true);
  }

  /**
   * Método de factoría estática para arranque fluido del SDK.
   */
  public static init(options: OnboardingAssistantOptions): OnboardingAssistantClient {
    const client = new OnboardingAssistantClient(options);
    return client;
  }

  /**
   * Inicia el proceso de handshake y abre el canal de streaming de voz en tiempo real.
   */
  public async start(): Promise<void> {
    if (this.active) return;

    this.log('Iniciando sesión del Onboarding Assistant...');
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const currentRoute = typeof window !== 'undefined' ? window.location.pathname : '/';
    this.currentPath = currentRoute;

    // 1. Handshake seguro con el backend
    const handshakeData = await this.performHandshake(currentOrigin, currentRoute);
    this.sessionId = handshakeData.sessionId;

    // 2. Conexión WebSocket al Gateway de Voz
    const wsBase = handshakeData.voiceGatewayWsUrl ?? this.options.websocketUrl ?? 'wss://voice.plataforma.com/ws/v1/realtime';
    const wsUrl = `${wsBase}?sessionId=${handshakeData.sessionId}&nonce=${handshakeData.handshakeNonce}`;

    await this.connectWebSocket(wsUrl);
    this.active = true;

    // 3. Activar rastreo de navegación SPA si está configurado
    if (this.options.autoTrackSpaRoutes !== false) {
      this.attachSpaNavigationTracking();
    }

    this.log(`Sesión de voz activada exitosamente [Session ID: ${this.sessionId}]`);
  }

  /**
   * Cierra de forma ordenada la sesión de voz y desconecta observadores.
   */
  public stop(reason = 'Cliente detuvo la sesión'): void {
    if (!this.active) return;
    this.active = false;

    if (this.detachNavigation) {
      this.detachNavigation();
      this.detachNavigation = null;
    }

    if (this.socket) {
      try {
        this.socket.close(1000, reason);
      } catch {
        // Ignorar excepciones al cerrar
      }
      this.socket = null;
    }

    this.log(`Sesión detenida: ${reason}`);
  }

  /** Indica si la sesión de voz está activa actualmente. */
  public isActive(): boolean {
    return this.active;
  }

  /** Retorna el identificador de la sesión activa si existe. */
  public getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Ejecuta manualmente una herramienta sobre el DOM (útil para pruebas y modo sandbox).
   */
  public async executeTool(payload: ToolExecutePayload) {
    return await this.actionExecutor.executeTool(payload);
  }

  /**
   * Dispara una señal inmediata de Barge-in (<5ms) para silenciar la voz del asistente.
   */
  public triggerBargeIn(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const bargeInPayload = JSON.stringify({
      type: 'voice.barge_in',
      timestamp: Date.now(),
    });

    this.socket.send(bargeInPayload);
    this.log('Barge-in local disparado (<5ms)');
  }

  /**
   * Notifica al Gateway de Voz que la ruta activa en la SPA cambió.
   */
  public notifyRouteChanged(newPath: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.currentPath = newPath;

    const routeMessage = JSON.stringify({
      type: 'route.changed',
      routePath: newPath,
      timestamp: Date.now(),
    });

    this.socket.send(routeMessage);
    this.log(`Ruta SPA actualizada enviada al gateway: ${newPath}`);
  }

  /**
   * Realiza la llamada HTTP POST al endpoint de Handshake.
   */
  private async performHandshake(origin: string, route: string): Promise<SdkHandshakeResponse> {
    const apiBase = this.options.apiUrl ?? 'https://api.plataforma.com';
    const handshakeUrl = `${apiBase}/api/v1/sdk/handshake`;

    const response = await fetch(handshakeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.publishableKey}`,
      },
      body: JSON.stringify({
        publishableKey: this.options.publishableKey,
        currentOrigin: origin,
        currentRoute: route,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Fallo en el Handshake del SDK (${response.status}): ${errText}`);
    }

    return (await response.json()) as SdkHandshakeResponse;
  }

  /**
   * Abre y configura los controladores de eventos del WebSocket.
   */
  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          this.socket = ws;
          resolve();
        };

        ws.onerror = (evt) => {
          this.log('Error en canal WebSocket:', evt);
          reject(new Error('No se pudo establecer la conexión WebSocket con el Gateway de Voz'));
        };

        ws.onclose = (evt) => {
          this.active = false;
          this.log(`WebSocket cerrado [Código: ${evt.code}, Razón: ${evt.reason}]`);
          if (this.options.onSessionTerminated) {
            this.options.onSessionTerminated(evt.reason || 'Conexión finalizada', evt.code);
          }
        };

        ws.onmessage = async (evt) => {
          await this.handleIncomingMessage(evt.data);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Procesa las tramas entrantes desde el Gateway de Voz.
   */
  private async handleIncomingMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as { type?: string; payload?: unknown };

        if (parsed.type === 'tool.execute') {
          const toolPayload = parsed.payload as ToolExecutePayload;
          const ackResult = await this.actionExecutor.executeTool(toolPayload);

          // Enviar ACK de vuelta al gateway de voz
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(
              JSON.stringify({
                type: 'tool.execution.ack',
                payload: ackResult,
              })
            );
          }

          if (toolPayload.toolName === 'advance_onboarding_step' && this.options.onStepAdvanced) {
            this.options.onStepAdvanced(toolPayload.stepIndex ?? 1);
          }
        } else if (parsed.type === 'session.terminate') {
          const termPayload = parsed.payload as { reason: string; closeCode: number };
          this.stop(termPayload.reason);
        }
      } catch (err) {
        this.log('Error al deserializar trama JSON del gateway:', err);
      }
    }
  }

  /**
   * Engancha observadores a la API History de navegación en el navegador.
   */
  private attachSpaNavigationTracking(): void {
    if (typeof window === 'undefined') return;

    const onPopState = () => {
      if (window.location.pathname !== this.currentPath) {
        this.notifyRouteChanged(window.location.pathname);
      }
    };

    window.addEventListener('popstate', onPopState);

    // Parche limpio sobre pushState y replaceState
    const originalPush = window.history.pushState.bind(window.history);
    const originalReplace = window.history.replaceState.bind(window.history);

    window.history.pushState = (...args: Parameters<History['pushState']>) => {
      originalPush(...args);
      if (window.location.pathname !== this.currentPath) {
        this.notifyRouteChanged(window.location.pathname);
      }
    };

    window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
      originalReplace(...args);
      if (window.location.pathname !== this.currentPath) {
        this.notifyRouteChanged(window.location.pathname);
      }
    };

    this.detachNavigation = () => {
      window.removeEventListener('popstate', onPopState);
      window.history.pushState = originalPush;
      window.history.replaceState = originalReplace;
    };
  }

  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[OnboardingAssistant SDK]', ...args);
    }
  }
}
