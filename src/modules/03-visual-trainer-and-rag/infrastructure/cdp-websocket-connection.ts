/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/cdp-websocket-connection.ts
 * @modulo 03-visual-trainer-and-rag (Transporte del Protocolo de Herramientas de Desarrollo)
 * @proposito
 *   Implementa el cliente del Protocolo de Herramientas de Desarrollo (CDP) sobre WebSocket: el
 *   canal por el que el backend gobierna el Chromium efimero. Traduce la API de peticion/respuesta
 *   con identificadores incrementales, entrega los eventos del navegador a los manejadores
 *   suscritos y valida el origen de cada mensaje. Se aisla del adaptador para que el ciclo de vida
 *   del contenedor y el transporte de datos evolucionen por separado.
 *
 * @resumen_contenido
 *   - Interface `CdpConnectionOptions`: URL del punto de depuracion, timeout y reconexion.
 *   - Interface `CdpTargetInfo`: Punto de depuracion de la pestana activa.
 *   - Interface `CdpInterceptedRequest`: Peticion de red interceptada y pendiente de decision.
 *   - Interface `CdpEventSubscription`: Funciones para habilitar y cancelar una escucha de eventos.
 *   - Clase `CdpWebSocketConnection`:
 *       * `connect()` y `close()`: Ciclo de vida del socket.
 *       * `send()`: Comando CDP con espera de su respuesta por identificador.
 *       * `evaluate()`: Ejecucion de JavaScript con `Runtime.evaluate`.
 *       * `onEvent()`: Suscripcion tipada a eventos del navegador.
 *       * `enableRequestInterception()`: Interceptacion via `Fetch.enable` con manejador propio.
 *       * `dispatchMouseClick()` y `dispatchKeyText()`: Puente de entrada del desarrollador.
 *
 * @dependencias_internas
 *   - `ProviderUnavailableError` (`src/shared/kernel/result-and-errors.ts`) para fallos de canal.
 *
 * @dependencias_externas
 *   - `ws` (Cliente WebSocket binario ya autorizado en el Ledger para el sistema).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (El transporte sostiene la sesion de entrenamiento).
 *   - PostgreSQL: `action_events` (La interceptacion alimenta el conteo de intentos bloqueados).
 */

import WebSocket from 'ws';
import { ProviderUnavailableError } from '../../../shared/kernel/result-and-errors';
import type {
  CdpEvaluateOptions,
  CdpEventSubscription,
  CdpInterceptedRequest,
  CdpInterceptionDecision,
  CdpTransport,
} from './cdp-transport.port';

export type { CdpEventSubscription, CdpInterceptedRequest } from './cdp-transport.port';

/** Parametros de conexion al punto de depuracion del navegador. */
export interface CdpConnectionOptions {
  /** Tiempo maximo de espera por comando, en milisegundos. */
  readonly commandTimeoutMs?: number;
  /** Tiempo maximo de espera al establecer la conexion, en milisegundos. */
  readonly connectTimeoutMs?: number;
}

/** Descripcion del punto de depuracion de una pestana del navegador (ver `cdp-target-discovery.ts`). */
export interface CdpTargetInfo {
  /** Identificador interno de la pestana. */
  readonly targetId: string;
  /** Tipo de destino (`page`, `iframe`, `worker`). */
  readonly type: string;
  /** URL cargada en el destino. */
  readonly url: string;
  /** URL del WebSocket de depuracion del destino. */
  readonly webSocketDebuggerUrl: string;
}

/** Mensaje entrante del protocolo, ya validado en su forma minima. */
interface CdpInboundMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** Manejador pendiente de una respuesta por identificador. */
interface PendingCommand {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutHandle: NodeJS.Timeout;
}

/** Tiempo maximo de espera por comando antes de considerarlo perdido. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

/** Tiempo maximo de espera al abrir el socket de depuracion. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * Conexion persistente con el Protocolo de Herramientas de Desarrollo sobre WebSocket.
 * Cada comando se casa con su respuesta por identificador incremental y todo comando tiene un
 * limite de tiempo: un navegador colgado no puede dejar una peticion HTTP esperando indefinidamente.
 */
export class CdpWebSocketConnection implements CdpTransport {
  private readonly options: Required<Pick<CdpConnectionOptions, 'commandTimeoutMs' | 'connectTimeoutMs'>>;
  private socket: WebSocket | undefined;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private requestInterceptor: ((request: CdpInterceptedRequest) => Promise<{ readonly allow: boolean; readonly reason: string }>) | undefined;
  private closedByUser = false;

  /**
   * @param options - Limites de tiempo de los comandos y de la apertura del canal.
   */
  public constructor(options: CdpConnectionOptions = {}) {
    this.options = {
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    };
  }

  /** Indica si el socket esta abierto y listo para enviar comandos. */
  public get isConnected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Abre el socket de depuracion contra el punto indicado.
   *
   * @param webSocketDebuggerUrl - URL del WebSocket de depuracion de la pestana a gobernar.
   * @throws ProviderUnavailableError cuando el punto de depuracion no responde a tiempo.
   */
  public async connect(webSocketDebuggerUrl: string): Promise<void> {
    if (this.isConnected) {
      return;
    }

    const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: this.options.connectTimeoutMs });
    this.socket = socket;
    this.closedByUser = false;

    await new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new ProviderUnavailableError('PRIMARY', 'el punto de depuracion del navegador no respondio a tiempo'));
      }, this.options.connectTimeoutMs);

      socket.once('open', () => {
        clearTimeout(connectTimeout);
        resolve();
      });
      socket.once('error', (error: Error) => {
        clearTimeout(connectTimeout);
        reject(new ProviderUnavailableError('PRIMARY', `fallo al abrir el canal de depuracion: ${error.message}`));
      });
    });

    socket.on('message', (rawData: WebSocket.RawData) => {
      this.handleInboundMessage(rawData.toString());
    });
    socket.on('close', () => {
      this.rejectAllPending(new ProviderUnavailableError('PRIMARY', 'el canal de depuracion se cerro inesperadamente'));
    });
    socket.on('error', () => {
      this.rejectAllPending(new ProviderUnavailableError('PRIMARY', 'el canal de depuracion reporto un error de transporte'));
    });
  }

  /**
   * Envia un comando CDP y espera su respuesta.
   *
   * @param method - Nombre del metodo del protocolo.
   * @param params - Parametros del comando.
   * @returns Resultado devuelto por el navegador.
   * @throws ProviderUnavailableError cuando el canal no esta abierto.
   * @throws Error cuando el comando expira o el navegador responde con un error del protocolo.
   */
  public async send(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new ProviderUnavailableError('PRIMARY', 'se intento enviar un comando sin canal de depuracion abierto');
    }

    const commandId = this.nextCommandId;
    this.nextCommandId += 1;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`COMANDO_CDP_EXPIRADO: el comando "${method}" no respondio en ${this.options.commandTimeoutMs}ms.`));
      }, this.options.commandTimeoutMs);

      this.pendingCommands.set(commandId, { resolve, reject, timeoutHandle });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
  }

  /**
   * Ejecuta una expresion JavaScript en la pagina y devuelve su valor ya deserializado.
   *
   * @param expression - Codigo a ejecutar, seguido de la lista de argumentos serializados.
   * @param args - Argumentos que se anexan como llamada a la funcion.
   * @param options - Contexto de ejecucion destino; con `executionContextId` la expresion se evalua
   *   dentro del mundo aislado del agente en lugar del mundo principal de la pagina (C1-49).
   * @returns Valor devuelto por la pagina, o `null` cuando la ejecucion falla.
   */
  public async evaluate(expression: string, args: readonly unknown[] = [], options: CdpEvaluateOptions = {}): Promise<unknown> {
    const serializedArgs = args.map((argument) => JSON.stringify(argument)).join(', ');
    const invocation = serializedArgs.length > 0 ? `(${expression})(${serializedArgs})` : `(${expression})()`;

    const response = await this.send('Runtime.evaluate', {
      expression: invocation,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      // `contextId` es el parametro con el que el navegador dirige la ejecucion a un mundo concreto.
      // Omitirlo dejaba al agente viviendo en el mundo principal, al alcance de la pagina hostil.
      ...(options.executionContextId === undefined ? {} : { contextId: options.executionContextId }),
    });

    const exceptionDetails = response['exceptionDetails'];
    if (exceptionDetails !== undefined && exceptionDetails !== null) {
      return null;
    }

    const result = response['result'];
    if (typeof result !== 'object' || result === null) {
      return null;
    }
    return (result as Record<string, unknown>)['value'] ?? null;
  }

  /**
   * Suscribe un manejador a un evento del navegador.
   *
   * @param eventName - Nombre del evento del protocolo.
   * @param handler - Funcion invocada por cada emision del evento.
   * @returns Suscripcion con su funcion de cancelacion.
   */
  public onEvent(eventName: string, handler: (params: Record<string, unknown>) => void): CdpEventSubscription {
    const handlers = this.eventHandlers.get(eventName) ?? new Set<(params: Record<string, unknown>) => void>();
    handlers.add(handler);
    this.eventHandlers.set(eventName, handlers);

    return {
      eventName,
      cancel: (): void => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(eventName);
        }
      },
    };
  }

  /**
   * Habilita la interceptacion de peticiones de red y delega cada decision en el manejador.
   * Toda peticion del navegador pasa por el escudo Anti-SSRF antes de salir a la red: es la unica
   * forma de cubrir las peticiones secundarias que no controla la navegacion principal.
   *
   * @param interceptor - Funcion que decide si una peticion se permite o se aborta.
   */
  public async enableRequestInterception(
    interceptor: (request: CdpInterceptedRequest) => Promise<CdpInterceptionDecision>
  ): Promise<void> {
    this.onEvent('Fetch.requestPaused', (params) => {
      // El campo real del evento es `requestId`. Leer `interceptionId` —que el navegador NUNCA
      // emite— dejaba esta guarda abortando siempre: el escudo Anti-SSRF no llegaba a decidir sobre
      // ninguna peticion y todas las salidas de red del navegador quedaban SIN VALIDAR, ademas de
      // colgar la carga de cada documento al no responderse la peticion interceptada.
      const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
      const requestRecord = typeof params['request'] === 'object' && params['request'] !== null ? (params['request'] as Record<string, unknown>) : null;
      const url = typeof requestRecord?.['url'] === 'string' ? (requestRecord['url'] as string) : '';

      if (requestId === null || url.length === 0) {
        return;
      }

      const interceptedRequest: CdpInterceptedRequest = {
        requestId,
        url,
        method: typeof requestRecord?.['method'] === 'string' ? (requestRecord['method'] as string) : 'GET',
        resourceType: typeof params['resourceType'] === 'string' ? (params['resourceType'] as string) : 'Other',
      };

      void interceptor(interceptedRequest)
        .then(async (decision) => {
          if (decision.allow) {
            await this.continueRequest(requestId);
            return;
          }
          await this.abortRequest(requestId, decision.reason);
        })
        .catch(async () => {
          await this.abortRequest(requestId, 'FALLO_DE_VALIDACION_DE_DESTINO');
        });
    });

    await this.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  }

  /**
   * Permite que una peticion interceptada continue hacia la red.
   *
   * @param requestId - Identificador que el navegador asigno a la peticion interceptada.
   */
  public async continueRequest(requestId: string): Promise<void> {
    try {
      // El nombre del parametro debe ser `requestId`: con cualquier otro, el navegador responde
      // «parametros invalidos» y la peticion queda colgada indefinidamente.
      await this.send('Fetch.continueRequest', { requestId });
    } catch {
      // La sesion pudo cerrarse entre la decision y la continuacion: no es un fallo accionable.
    }
  }

  /**
   * Aborta una peticion interceptada por violar el escudo Anti-SSRF.
   *
   * @param requestId - Identificador que el navegador asigno a la peticion interceptada.
   * @param reason - Motivo del bloqueo, usado para elegir el codigo de error de red.
   */
  public async abortRequest(requestId: string, reason: string): Promise<void> {
    try {
      await this.send('Fetch.failRequest', { requestId, errorReason: mapBlockReasonToCdpError(reason) });
    } catch {
      // La sesion pudo cerrarse entre la decision y el aborto: no es un fallo accionable.
    }
  }

  /**
   * Traduce un clic del desarrollador en el visor a un evento de raton real en el navegador.
   *
   * @param x - Coordenada horizontal del clic.
   * @param y - Coordenada vertical del clic.
   * @param button - Boton del raton (`left`, `middle`, `right`).
   */
  public async dispatchMouseClick(x: number, y: number, button: 'left' | 'middle' | 'right' = 'left'): Promise<void> {
    const commonParams = { x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 0 };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...commonParams });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...commonParams });
  }

  /**
   * Escribe un texto en el elemento con foco del navegador remoto.
   * Se usa `Input.insertText` porque respeta la composicion del sistema y no requiere mapear cada
   * tecla por separado. El escudo de campos sensibles se aplica antes, en la capa de herramientas.
   *
   * @param text - Texto a insertar.
   */
  public async dispatchKeyText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /**
   * Cierra el canal de depuracion y rechaza los comandos que sigan pendientes.
   */
  public async close(): Promise<void> {
    this.closedByUser = true;
    this.rejectAllPending(new ProviderUnavailableError('PRIMARY', 'el canal de depuracion fue cerrado por la aplicacion'));
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => {
          resolve();
        });
        socket.close();
      });
    }
    this.eventHandlers.clear();
  }

  /**
   * Interpreta un mensaje entrante y lo enruta a su comando pendiente o a sus suscriptores.
   *
   * @param rawMessage - Carga textual recibida del navegador.
   */
  private handleInboundMessage(rawMessage: string): void {
    let parsed: CdpInboundMessage;
    try {
      parsed = JSON.parse(rawMessage) as CdpInboundMessage;
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pendingCommands.get(parsed.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timeoutHandle);
      this.pendingCommands.delete(parsed.id);

      if (parsed.error !== undefined) {
        pending.reject(new Error(`ERROR_CDP: ${parsed.error.message ?? 'el navegador rechazo el comando'}`));
        return;
      }
      pending.resolve(parsed.result ?? {});
      return;
    }

    if (typeof parsed.method === 'string') {
      const handlers = this.eventHandlers.get(parsed.method);
      if (handlers === undefined) {
        return;
      }
      for (const handler of handlers) {
        handler(parsed.params ?? {});
      }
    }
  }

  /**
   * Rechaza todos los comandos pendientes liberando sus temporizadores.
   *
   * @param reason - Error con el que se rechazan los comandos pendientes.
   */
  private rejectAllPending(reason: Error): void {
    for (const [commandId, pending] of this.pendingCommands) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(reason);
      this.pendingCommands.delete(commandId);
    }
  }

  /** Indica si el canal fue cerrado deliberadamente por la aplicacion. */
  public get wasClosedByUser(): boolean {
    return this.closedByUser;
  }
}

/**
 * Traduce el motivo del bloqueo al codigo de error de red que espera el navegador.
 *
 * @param reason - Etiqueta del motivo del bloqueo.
 * @returns Codigo de error de red del protocolo.
 */
export function mapBlockReasonToCdpError(reason: string): string {
  if (reason.includes('PUERTO')) {
    return 'ConnectionRefused';
  }
  if (reason.includes('ESQUEMA')) {
    return 'AccessDenied';
  }
  return 'AddressUnreachable';
}
