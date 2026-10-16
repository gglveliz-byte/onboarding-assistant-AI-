/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/cdp-transport.port.ts
 * @modulo 03-visual-trainer-and-rag (Puerto del Transporte del Protocolo de Desarrollo)
 * @proposito
 *   Declara el contrato del canal por el que el backend gobierna el navegador efimero. El adaptador
 *   depende de esta interfaz y no de la implementacion concreta sobre WebSocket, lo que permite
 *   sustituir el transporte en las pruebas automatizadas sin un navegador ni un motor de
 *   contenedores, y deja la puerta abierta a otros transportes (por ejemplo un tunel cifrado) sin
 *   tocar la logica de seguridad ni el ciclo de vida de la sesion.
 *
 * @resumen_contenido
 *   - Interface `CdpInterceptedRequest`: Peticion de red interceptada pendiente de decision.
 *   - Interface `CdpInterceptionDecision`: Instruccion de permitir o abortar con su motivo.
 *   - Interface `CdpEventSubscription`: Suscripcion a un evento del navegador.
 *   - Interface `CdpTransport`: Contrato completo del canal de gobierno del navegador.
 *   - Tipo `CdpTransportFactory`: Fabrica del transporte para una sesion de entrenamiento.
 *
 * @dependencias_internas
 *   - Ninguna (Contrato puro: es una hoja del grafo de dependencias del modulo).
 *
 * @dependencias_externas
 *   - Ninguna (Solo interfaces: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (El transporte sostiene la sesion activa).
 *   - PostgreSQL: `action_events` (La interceptacion alimenta el conteo de intentos bloqueados).
 */

/** Peticion de red interceptada que espera la decision del escudo Anti-SSRF. */
export interface CdpInterceptedRequest {
  /**
   * Identificador que el navegador asigna a la peticion interceptada.
   *
   * Se llama `requestId` y **no** `interceptionId` porque es el nombre real del campo del evento
   * `Fetch.requestPaused`: el navegador nunca emite un campo llamado `interceptionId`, y las
   * respuestas `Fetch.continueRequest` y `Fetch.failRequest` exigen este identificador con
   * exactamente este nombre. Usar otro nombre hace que el navegador responda «parametros invalidos»,
   * la peticion quede colgada y —lo mas grave— la decision del escudo **nunca se aplique**: todas las
   * salidas de red del navegador quedarian sin validar.
   */
  readonly requestId: string;
  /** URL completa de la peticion. */
  readonly url: string;
  /** Metodo HTTP de la peticion. */
  readonly method: string;
  /** Tipo de recurso segun el navegador (`Document`, `XHR`, `Image`, `Script`). */
  readonly resourceType: string;
}

/** Instruccion que el canal aplica sobre una peticion interceptada. */
export interface CdpInterceptionDecision {
  /** Indica si la peticion debe continuar hacia la red. */
  readonly allow: boolean;
  /** Motivo de la decision, registrado en auditoria cuando se aborta. */
  readonly reason: string;
}

/**
 * Opciones de ejecucion de una expresion dentro del navegador.
 *
 * `executionContextId` dirige la ejecucion a un contexto concreto —el mundo aislado del agente— en
 * lugar del mundo principal de la pagina. Sin el, la pagina entrenada comparte mundo con el agente,
 * puede leerlo, sobrescribirlo y devolver metadatos falsos que el backend acepta y persiste (C1-49).
 */
export interface CdpEvaluateOptions {
  /** Identificador del contexto de ejecucion destino, o `undefined` para el mundo principal. */
  readonly executionContextId?: number;
}

/** Suscripcion a un evento del navegador con su funcion de cancelacion. */
export interface CdpEventSubscription {
  /** Nombre del evento suscrito (por ejemplo `Page.loadEventFired`). */
  readonly eventName: string;
  /** Cancela la suscripcion y libera el manejador. */
  readonly cancel: () => void;
}

/**
 * Contrato del transporte de gobierno del navegador efimero.
 * Toda implementacion debe respetar el limite de tiempo por comando y liberar sus recursos en
 * `close()` sin propagar errores de cierre.
 */
export interface CdpTransport {
  /** Indica si el canal esta abierto y listo para enviar comandos. */
  readonly isConnected: boolean;

  /**
   * Abre el canal contra el punto de depuracion indicado.
   *
   * @param webSocketDebuggerUrl - URL del canal de depuracion de la pestana a gobernar.
   */
  connect(webSocketDebuggerUrl: string): Promise<void>;

  /**
   * Envia un comando del protocolo y espera su respuesta.
   *
   * @param method - Nombre del metodo del protocolo.
   * @param params - Parametros del comando.
   * @returns Resultado devuelto por el navegador.
   */
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;

  /**
   * Ejecuta una expresion JavaScript en la pagina y devuelve su valor deserializado.
   *
   * @param expression - Codigo a ejecutar.
   * @param args - Argumentos que se interpolan en la llamada.
   * @param options - Contexto de ejecucion destino (mundo aislado del agente).
   * @returns Valor devuelto por la pagina, o `null` cuando la ejecucion falla.
   */
  evaluate(expression: string, args?: readonly unknown[], options?: CdpEvaluateOptions): Promise<unknown>;

  /**
   * Suscribe un manejador a un evento del navegador.
   *
   * @param eventName - Nombre del evento del protocolo.
   * @param handler - Funcion invocada por cada emision del evento.
   * @returns Suscripcion con su funcion de cancelacion.
   */
  onEvent(eventName: string, handler: (params: Record<string, unknown>) => void): CdpEventSubscription;

  /**
   * Habilita la interceptacion de red delegando cada decision en el manejador indicado.
   *
   * @param interceptor - Funcion que decide si una peticion se permite o se aborta.
   */
  enableRequestInterception(interceptor: (request: CdpInterceptedRequest) => Promise<CdpInterceptionDecision>): Promise<void>;

  /**
   * Traduce un clic del desarrollador en el visor a un evento de raton real en el navegador.
   *
   * @param x - Coordenada horizontal del clic.
   * @param y - Coordenada vertical del clic.
   * @param button - Boton del raton.
   */
  dispatchMouseClick(x: number, y: number, button?: 'left' | 'middle' | 'right'): Promise<void>;

  /**
   * Escribe un texto en el elemento con foco del navegador remoto.
   *
   * @param text - Texto a insertar.
   */
  dispatchKeyText(text: string): Promise<void>;

  /**
   * Cierra el canal liberando todos sus recursos.
   */
  close(): Promise<void>;
}

/**
 * Fabrica del transporte de una sesion de entrenamiento concreta.
 * El adaptador la invoca al levantar cada sesion para obtener un canal independiente.
 */
export type CdpTransportFactory = () => CdpTransport;
