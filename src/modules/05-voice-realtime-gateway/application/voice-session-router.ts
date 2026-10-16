/**
 * @archivo src/modules/05-voice-realtime-gateway/application/voice-session-router.ts
 * @modulo 05-voice-realtime-gateway (Enrutador de Tramas y Contexto Vivo de una Sesion de Voz)
 * @proposito
 *   Concentra las tres reacciones que una sesion de voz tiene ante lo que ocurre en el navegador del
 *   usuario final: el cambio de ruta dispara un nuevo Context Slimming e inyecta los elementos de la
 *   pantalla nueva en el motor sin reiniciar la conversacion; la interrupcion cancela la
 *   reproduccion en curso y se contabiliza; y el acuse de herramienta resuelve la promesa que el
 *   despachador espera, con un temporizador de seguridad para que una accion sin respuesta no deje
 *   al asistente mudo. Se separa del ciclo de vida del socket porque son dos responsabilidades
 *   distintas: aquel gobierna conexiones, este interpreta intenciones.
 *
 * @resumen_contenido
 *   - Constante `CLIENT_ACK_TIMEOUT_DETAIL`.
 *   - Interface `SessionRouterDependencies`.
 *   - Clase `VoiceSessionRouter`:
 *       * `handleRouteChanged()`: Context Slimming en vivo e inyeccion en el motor.
 *       * `handleBargeIn()`: Interrupcion inmediata con su contabilizacion.
 *       * `handleToolAck()` y `registerPendingAck()`: Confirmacion de acciones.
 *       * `resolveAllPendingAcks()`: Cierre limpio de esperas pendientes.
 *
 * @dependencias_internas
 *   - `encodeControlFrame()` (`../infrastructure/voice-frame.protocol.ts`).
 *   - `IActiveProviderStream` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `IVisualRagAndPromptPort` (`src/shared/ports/core-modules.ports.ts`).
 *   - `ToolAckOutcome` (`./dispatch-dom-tool.use-case.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Enrutamiento puro: el transporte y la persistencia llegan inyectados).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions` (El contador de interrupciones se persiste en esta tabla).
 */

import type { IActiveProviderStream } from '../../../shared/ports/billing-voice-admin.ports';
import type { IVisualRagAndPromptPort } from '../../../shared/ports/core-modules.ports';
import type { ToolAckOutcome } from './dispatch-dom-tool.use-case';
import { encodeControlFrame } from '../infrastructure/voice-frame.protocol';

/** Detalle con el que se resuelve un acuse que nunca llego. */
export const CLIENT_ACK_TIMEOUT_DETAIL = 'CLIENT_ACK_TIMEOUT';

/** Dependencias del enrutador de tramas de una sesion de voz. */
export interface SessionRouterDependencies {
  /** Puerto del mapa funcional, usado por el Context Slimming en vivo. */
  readonly ragPort: IVisualRagAndPromptPort;
  /** Identificador del proyecto de la sesion. */
  readonly projectId: string;
  /** Envio de tramas de control al navegador del usuario final. */
  readonly sendFrameToClient: (frame: Buffer) => void;
  /** Consulta del paso de onboarding vigente. */
  readonly getCurrentStepNumber: () => number;
  /** Aviso de que se alcanzo el maximo de interrupciones permitidas. */
  readonly onBargeInLimitReached: (bargeInCount: number) => void;
}

/**
 * Enrutador de las intenciones que llegan del navegador durante una sesion de voz.
 * Es determinista y no abre conexiones: toda su salida pasa por el envio de tramas inyectado.
 */
export class VoiceSessionRouter {
  private readonly dependencies: SessionRouterDependencies;
  private readonly pendingAcks = new Map<string, (outcome: ToolAckOutcome) => void>();

  private currentRoutePath: string;
  private bargeInCount = 0;
  private lastContextRefreshMs = 0;
  private maxBargeInCount: number;

  /**
   * @param dependencies - Puerto del mapa, proyecto y envio de tramas.
   * @param initialRoutePath - Ruta en la que arranca la sesion.
   * @param maxBargeInCount - Maximo de interrupciones admitidas antes de avisar del limite.
   */
  public constructor(dependencies: SessionRouterDependencies, initialRoutePath: string, maxBargeInCount: number) {
    this.dependencies = dependencies;
    this.currentRoutePath = initialRoutePath;
    this.maxBargeInCount = maxBargeInCount;
  }

  /**
   * Devuelve la ruta vigente del usuario final.
   *
   * @returns Ruta actual normalizada.
   */
  public getCurrentRoutePath(): string {
    return this.currentRoutePath;
  }

  /**
   * Devuelve el numero de interrupciones registradas.
   *
   * @returns Contador de interrupciones de la sesion.
   */
  public getBargeInCount(): number {
    return this.bargeInCount;
  }

  /**
   * Devuelve la latencia del ultimo refresco de contexto de ruta.
   *
   * @returns Latencia medida en milisegundos.
   */
  public getLastContextRefreshMs(): number {
    return this.lastContextRefreshMs;
  }

  /**
   * Devuelve cuantas esperas de acuse siguen pendientes.
   *
   * @returns Numero de acciones sin confirmar.
   */
  public getPendingAckCount(): number {
    return this.pendingAcks.size;
  }

  /**
   * Refresca el contexto de la ruta cuando el usuario navega en su aplicacion.
   * La ruta se actualiza SIEMPRE, aunque el puerto del mapa falle: si el asistente siguiera creyendo
   * que el usuario esta en la pantalla anterior, intentaria acciones sobre elementos inexistentes.
   *
   * @param routePath - Ruta nueva declarada por el navegador.
   * @param providerStream - Canal activo del motor, o `null` cuando aun no esta abierto.
   * @returns `true` cuando el contexto se refresco y se inyecto correctamente.
   */
  public async handleRouteChanged(routePath: string, providerStream: IActiveProviderStream | null): Promise<boolean> {
    if (routePath.trim().length === 0) {
      return false;
    }

    const startedAtMs = Date.now();
    this.currentRoutePath = routePath;

    const slimmedContext = await this.dependencies.ragPort.getSlimmedRouteContext(
      this.dependencies.projectId,
      routePath,
      this.dependencies.getCurrentStepNumber()
    );
    if (!slimmedContext.ok) {
      this.dependencies.sendFrameToClient(
        encodeControlFrame('session.ready', { routePath, contextUnavailable: slimmedContext.reason })
      );
      return false;
    }

    const routeSummary = this.summarizeAllowedActions(slimmedContext.context.allowedActions);
    this.lastContextRefreshMs = Date.now() - startedAtMs;

    // Se inyecta en caliente como elemento de sistema: el asistente conoce la pantalla nueva sin
    // reiniciar la conversacion ni perder el audio ya bufferizado.
    let injected = false;
    if (providerStream !== null && 'updateDynamicRouteContext' in providerStream) {
      const updatableStream = providerStream as IActiveProviderStream & {
        updateDynamicRouteContext: (route: string, summary: string) => boolean;
      };
      injected = updatableStream.updateDynamicRouteContext(routePath, routeSummary);
    }

    this.dependencies.sendFrameToClient(
      encodeControlFrame('session.ready', {
        routePath,
        slimmedElementCount: slimmedContext.context.allowedActions.length,
        refreshLatencyMs: this.lastContextRefreshMs,
      })
    );
    return injected;
  }

  /**
   * Cancela la reproduccion en curso y contabiliza la interrupcion del usuario final.
   *
   * @param providerStream - Canal activo del motor, o `null` cuando no esta abierto.
   * @returns Numero de interrupciones acumuladas tras esta.
   */
  public handleBargeIn(providerStream: IActiveProviderStream | null): number {
    this.bargeInCount += 1;

    if (providerStream !== null) {
      providerStream.requestBargeIn();
    }

    if (this.bargeInCount >= this.maxBargeInCount) {
      // Un usuario que interrumpe sin parar no esta siendo ayudado: la sesion debe cerrarse para que
      // vuelva a empezar con un flujo claro en lugar de consumir saldo en un bucle.
      this.dependencies.onBargeInLimitReached(this.bargeInCount);
    }

    return this.bargeInCount;
  }

  /**
   * Resuelve la promesa del despachador de herramientas que esperaba este acuse.
   *
   * @param body - Cuerpo del mensaje de acuse recibido del navegador.
   * @returns `true` cuando el acuse correspondia a una accion en curso.
   */
  public handleToolAck(body: Readonly<Record<string, unknown>>): boolean {
    const providerToolCallId = typeof body['providerToolCallId'] === 'string' ? body['providerToolCallId'] : '';
    const resolver = this.pendingAcks.get(providerToolCallId);
    if (resolver === undefined) {
      // Un acuse de una accion ya resuelta o desconocida se ignora: llegaria por un reintento del
      // cliente y volver a resolver la promesa no tendria efecto alguno.
      return false;
    }
    this.pendingAcks.delete(providerToolCallId);
    resolver({
      succeeded: body['succeeded'] === true,
      detail: typeof body['detail'] === 'string' ? body['detail'] : null,
    });
    return true;
  }

  /**
   * Registra la espera del acuse de una herramienta con su temporizador de seguridad.
   *
   * @param providerToolCallId - Identificador de la llamada emitida por el motor.
   * @param timeoutMs - Tiempo maximo que se espera la confirmacion.
   * @returns Acuse recibido, o un fallo por tiempo agotado.
   */
  public async registerPendingAck(providerToolCallId: string, timeoutMs: number): Promise<ToolAckOutcome> {
    return new Promise<ToolAckOutcome>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAcks.delete(providerToolCallId);
        resolve({
          succeeded: false,
          detail: `${CLIENT_ACK_TIMEOUT_DETAIL}: el navegador no confirmo la accion en ${timeoutMs} ms.`,
        });
      }, timeoutMs);

      this.pendingAcks.set(providerToolCallId, (outcome) => {
        clearTimeout(timeoutHandle);
        resolve(outcome);
      });
    });
  }

  /**
   * Resuelve como fallidas todas las esperas de acuse pendientes al cerrar la sesion.
   *
   * @param detail - Detalle con el que se resuelven las esperas.
   */
  public resolveAllPendingAcks(detail: string): void {
    for (const [, resolver] of this.pendingAcks) {
      resolver({ succeeded: false, detail });
    }
    this.pendingAcks.clear();
  }

  /**
   * Ajusta el maximo de interrupciones admitidas, usado cuando el proyecto lo configura.
   *
   * @param maxBargeInCount - Nuevo maximo de interrupciones.
   */
  public setMaxBargeInCount(maxBargeInCount: number): void {
    this.maxBargeInCount = Math.max(1, Math.trunc(maxBargeInCount));
  }

  /**
   * Resume los elementos accionables de una ruta, ya depurados de campos sensibles.
   *
   * @param allowedActions - Acciones permitidas en la ruta.
   * @returns Resumen textual de los elementos disponibles.
   */
  public summarizeAllowedActions(
    allowedActions: readonly { readonly elementKey: string; readonly title: string; readonly actionType: string }[]
  ): string {
    if (allowedActions.length === 0) {
      return 'Sin elementos etiquetados.';
    }
    return allowedActions.map((action) => `${action.elementKey} (${action.title}, ${action.actionType})`).join('; ');
  }
}
