/**
 * @archivo src/modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case.ts
 * @modulo 05-voice-realtime-gateway (Ciclo de Vida Completo de una Conexion de Voz WebSocket)
 * @proposito
 *   Gobierna la conexion de voz de extremo a extremo: consume el nonce efimero de handshake para
 *   autorizar al usuario final, carga el prompt del proyecto con su primer Context Slimming, abre el
 *   canal contra el motor de voz con failover automatico y enruta cada trama del navegador a su
 *   efecto delegando en `VoiceSessionRouter`. Al cerrarse, liquida el consumo pendiente y purga el
 *   audio residente en memoria. La separacion es deliberada: esta clase gobierna CONEXIONES y el
 *   enrutador interpreta INTENCIONES, de modo que ninguna de las dos responsabilidades crezca dentro
 *   de la otra.
 *
 * @resumen_contenido
 *   - Constantes `MAX_BARGE_IN_PER_SESSION`, `UNAUTHORIZED_CLOSE_REASON` y `SESSION_INITIAL_TEMPERATURE`.
 *   - Interfaces `VoiceWebSocketOpenRequest` y `VoiceWebSocketPorts`.
 *   - Clase `VoiceWebSocketSession`: Arranque, enrutamiento, pulso de cobro y cierre.
 *   - Funcion `openVoiceWebSocketSession()`: Autorizacion y arranque de la sesion.
 *
 * @dependencias_internas
 *   - `VoiceSessionRouter` (`./voice-session-router.ts`).
 *   - `DualProviderOrchestrator` (`../infrastructure/dual-provider-orchestrator.ts`).
 *   - Codecs de tramas (`../infrastructure/voice-frame.protocol.ts`).
 *   - `DispatchDomToolUseCase` y `VoiceSessionMeteringService` (casos de uso del modulo).
 *   - `IApiKeyAndHandshakePort` e `IVisualRagAndPromptPort` (`src/shared/ports/core-modules.ports.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion transaccional con RLS).
 *
 * @tablas_bd_o_redis
 *   - Redis: `sdk_handshake:nonce:<jti>` (Consumo atomico `GETDEL` del nonce de handshake).
 *   - PostgreSQL: `voice_sessions` y `action_events` (Estado, metricas y trazabilidad de acciones).
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type {
  IActiveProviderStream,
  ToolInvocation,
  VoiceProviderEventHandlers,
  VoiceStreamOpenRequest,
} from '../../../shared/ports/billing-voice-admin.ports';
import { ValidationError } from '../../../shared/kernel/result-and-errors';
import { VoiceSessionRouter } from './voice-session-router';
import {
  MAX_BARGE_IN_PER_SESSION,
  SESSION_INITIAL_TEMPERATURE,
  UNAUTHORIZED_CLOSE_REASON,
  type ClientCloser,
  type ClientFrameSender,
  type VoiceSessionClosingStatus,
  type VoiceWebSocketOpenRequest,
  type VoiceWebSocketPorts,
} from './voice-websocket.contracts';

export { MAX_BARGE_IN_PER_SESSION, SESSION_INITIAL_TEMPERATURE };
export type {
  ClientCloser,
  ClientFrameSender,
  VoiceSessionClosingStatus,
  VoiceWebSocketOpenRequest,
  VoiceWebSocketPorts,
} from './voice-websocket.contracts';
import {
  encodeAudioDownlinkFrame,
  encodeControlFrame,
  VOICE_CLOSE_CODES,
  VoiceFrameDecoder,
  type DecodedClientFrame,
} from '../infrastructure/voice-frame.protocol';
import { OnboardingStepStateMachine } from '../domain/voice-session-and-tools.types';


/**
 * Estado en memoria de una sesion de voz activa.
 * Gobierna la conexion, el canal del motor y el pulso de cobro; el enrutamiento de intenciones vive
 * en `VoiceSessionRouter`.
 */
export class VoiceWebSocketSession {
  private readonly ports: VoiceWebSocketPorts;
  private readonly request: VoiceWebSocketOpenRequest;
  private readonly sendFrameToClient: ClientFrameSender;
  private readonly closeClientSocket: ClientCloser;
  private readonly decoder = new VoiceFrameDecoder();
  private readonly stepStateMachine: OnboardingStepStateMachine;
  private readonly router: VoiceSessionRouter;

  private providerStream: IActiveProviderStream | null = null;
  private functionalMapId = '';
  private isClosed = false;
  /**
   * Organizacion AUTENTICADA por el nonce de handshake.
   * Es la unica identidad de tenant que la sesion usa para facturar, resolver el contexto RLS y
   * registrarse ante el gobierno. Se inicializa con el valor de la peticion solo para que el tipo sea
   * no nulo, y `start()` la sustituye por la del nonce antes de cualquier uso.
   */
  private authenticatedOrganizationId: string;
  /** Indica que la peticion declaro una organizacion distinta de la autenticada. */
  private authenticationMismatchDetected = false;

  /**
   * @param ports - Puertos y casos de uso del gateway.
   * @param request - Datos de apertura de la sesion.
   * @param sendFrameToClient - Envio de tramas al navegador.
   * @param closeClientSocket - Cierre del socket del cliente.
   */
  public constructor(
    ports: VoiceWebSocketPorts,
    request: VoiceWebSocketOpenRequest,
    sendFrameToClient: ClientFrameSender,
    closeClientSocket: ClientCloser
  ) {
    this.ports = ports;
    this.request = request;
    this.sendFrameToClient = sendFrameToClient;
    this.closeClientSocket = closeClientSocket;
    this.authenticatedOrganizationId = request.organizationId;
    this.stepStateMachine = new OnboardingStepStateMachine(
      request.initialStepNumber,
      request.totalSteps,
      request.strictStepEnforcement
    );
    this.router = new VoiceSessionRouter(
      {
        ragPort: ports.ragPort,
        projectId: request.projectId,
        sendFrameToClient,
        getCurrentStepNumber: () => this.stepStateMachine.getCurrentStep(),
        onBargeInLimitReached: (bargeInCount: number) => {
          void this.close('TERMINATED_BARGE_IN_LIMIT', `Se alcanzo el maximo de ${bargeInCount} interrupciones.`);
        },
      },
      request.initialRoutePath,
      MAX_BARGE_IN_PER_SESSION
    );
  }

  /**
   * Autoriza la sesion, abre el canal del motor de voz y arranca el pulso de facturacion.
   *
   * @returns `true` cuando la sesion quedo operativa.
   */
  public async start(): Promise<boolean> {
    // 1. Consumo ATOMICO del nonce de handshake: si ya fue usado o expiro, el puerto lo rechaza, de
    // modo que un nonce capturado no pueda reutilizarse para abrir una segunda sesion.
    const nonceResult = await this.ports.handshakePort.consumeEphemeralWsNonce(this.request.nonceId, this.request.projectId);
    if (!nonceResult.ok) {
      this.closeClientSocket(VOICE_CLOSE_CODES.UNAUTHORIZED, UNAUTHORIZED_CLOSE_REASON);
      return false;
    }

    // 1.b. La organizacion se toma del NONCE, nunca de la peticion. El identificador que llega por la
    // URL es un dato declarado por el cliente: aceptarlo permitiria a un proyecto con credenciales
    // legitimas abrir una sesion de voz a nombre de otra organizacion, facturandole los minutos
    // consumidos y sustrayendose ademas al corte masivo de sesiones de una organizacion suspendida.
    // Una discrepancia NO se corrige en silencio: se rechaza y se deja constancia, porque es un
    // intento de suplantacion que conviene poder auditar.
    if (nonceResult.organizationId !== this.request.organizationId) {
      this.authenticationMismatchDetected = true;
      this.closeClientSocket(
        VOICE_CLOSE_CODES.UNAUTHORIZED,
        'La organizacion declarada en la peticion no corresponde al proyecto autenticado.'
      );
      return false;
    }
    this.authenticatedOrganizationId = nonceResult.organizationId;

    // 2. Prompt vigente y metadatos del mapa activo.
    const prompt = await this.ports.ragPort.getActiveProjectPromptAndMapMeta(this.request.projectId);
    if (!prompt.ok) {
      this.closeClientSocket(VOICE_CLOSE_CODES.PROVIDER_UNAVAILABLE, 'El proyecto no tiene un mapa funcional publicado.');
      return false;
    }
    this.functionalMapId = prompt.mapMetadata.functionalMapId;

    // 3. Primer Context Slimming de la ruta inicial.
    const slimmedContext = await this.ports.ragPort.getSlimmedRouteContext(
      this.request.projectId,
      this.request.initialRoutePath,
      this.stepStateMachine.getCurrentStep()
    );
    const routeSummary = slimmedContext.ok
      ? this.router.summarizeAllowedActions(slimmedContext.context.allowedActions)
      : 'Sin elementos etiquetados.';

    // 4. Apertura del canal contra el motor, con failover automatico si el primario no responde.
    const openRequest: VoiceStreamOpenRequest = {
      organizationId: this.authenticatedOrganizationId,
      projectId: this.request.projectId,
      voiceSessionId: this.request.voiceSessionId,
      systemPrompt: this.buildSystemPrompt(prompt.systemPrompt, slimmedContext.ok ? slimmedContext.context.stepInstruction : '', routeSummary),
      onboardingStepsJson: prompt.onboardingStepsJson,
      voicePersonaCode: this.request.voicePersonaCode,
      modelTemperature: SESSION_INITIAL_TEMPERATURE,
      pcmSampleRateHz: this.request.sampleRateHz,
      externalEndUserId: nonceResult.externalEndUserId,
    };

    const orchestration = await this.ports.orchestrator.orchestrateStream(openRequest, this.buildProviderHandlers());
    if (!orchestration.ok) {
      this.closeClientSocket(VOICE_CLOSE_CODES.PROVIDER_UNAVAILABLE, 'El motor de voz no esta disponible en este momento.');
      return false;
    }
    this.providerStream = orchestration.stream;

    // 5. Registro en el servicio de facturacion y anuncio de disponibilidad al cliente.
    this.ports.meteringService.registerSession(this.authenticatedOrganizationId, this.request.projectId, this.request.voiceSessionId);
    this.sendFrameToClient(
      encodeControlFrame('session.ready', {
        voiceSessionId: this.request.voiceSessionId,
        activeProvider: orchestration.activeProviderKind,
        failoverTriggered: orchestration.wasFailoverTriggered,
        currentStepNumber: this.stepStateMachine.getCurrentStep(),
        routePath: this.request.initialRoutePath,
      })
    );

    this.startMeteringPulse();
    return true;
  }

  /**
   * Procesa un paquete de bytes recibido del navegador, reconstruyendo sus tramas.
   *
   * @param chunk - Bytes recibidos del socket.
   */
  public async handleIncomingBytes(chunk: Buffer): Promise<void> {
    if (this.isClosed) {
      return;
    }

    for (const outcome of this.decoder.push(chunk)) {
      if (!outcome.ok) {
        // Una trama ilegible se informa y se ignora: derribar la sesion por un paquete corrupto
        // castigaria al usuario por un fallo de red que no controla.
        this.sendFrameToClient(encodeControlFrame('session.ready', { warning: outcome.reason }));
        continue;
      }
      await this.routeFrame(outcome.frame);
    }
  }

  /**
   * Cierra la sesion liquidando el consumo pendiente y purgando el audio residente.
   *
   * @param status - Estado final de la sesion de voz.
   * @param reason - Motivo del cierre, registrado para la auditoria.
   */
  public async close(status: VoiceSessionClosingStatus, reason: string): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.ports.meteringService.stopTimer(this.request.voiceSessionId);
    this.decoder.reset();
    this.router.resolveAllPendingAcks('SESSION_CLOSED');

    if (this.providerStream !== null) {
      const stream = this.providerStream;
      this.providerStream = null;
      await stream.close(status);
    }

    await this.settleAndPersist(status, reason);
  }

  /**
   * Indica si la peticion intento declarar una organizacion distinta de la autenticada.
   * El gateway lo usa para registrar el intento de suplantacion en la bitacora de seguridad.
   *
   * @returns `true` cuando se detecto y rechazo una discrepancia de organizacion.
   */
  public wasAuthenticationMismatchDetected(): boolean {
    return this.authenticationMismatchDetected;
  }

  /**
   * Devuelve la organizacion autenticada de la sesion.
   *
   * @returns Identificador de la organizacion tomada del nonce de handshake.
   */
  public getAuthenticatedOrganizationId(): string {
    return this.authenticatedOrganizationId;
  }

  /**
   * Devuelve el numero de interrupciones registradas en la sesion.
   *
   * @returns Contador de interrupciones del usuario final.
   */
  public getBargeInCount(): number {
    return this.router.getBargeInCount();
  }

  /**
   * Indica si la sesion sigue operativa.
   *
   * @returns `true` cuando la sesion no ha sido cerrada.
   */
  public isSessionOpen(): boolean {
    return !this.isClosed;
  }

  /**
   * Enruta una trama ya decodificada a su efecto correspondiente.
   *
   * @param frame - Trama decodificada.
   */
  private async routeFrame(frame: DecodedClientFrame): Promise<void> {
    if (frame.kind === 'AUDIO') {
      if (frame.audioPayload !== undefined && this.providerStream !== null) {
        this.providerStream.sendAudioFrame(frame.audioPayload);
      }
      return;
    }

    if (frame.controlName === 'route.changed') {
      await this.router.handleRouteChanged(this.readRoutePath(frame.controlBody ?? {}), this.providerStream);
      return;
    }
    if (frame.controlName === 'voice.barge_in') {
      this.router.handleBargeIn(this.providerStream);
      return;
    }
    if (frame.controlName === 'tool.execution.ack') {
      this.router.handleToolAck(frame.controlBody ?? {});
    }
  }

  /**
   * Extrae la ruta declarada en un mensaje de cambio de ruta.
   *
   * @param body - Cuerpo del mensaje de control.
   * @returns Ruta declarada, o cadena vacia cuando no es utilizable.
   */
  private readRoutePath(body: Readonly<Record<string, unknown>>): string {
    const routePath = body['routePath'];
    return typeof routePath === 'string' ? routePath : '';
  }

  /**
   * Compone los manejadores de los eventos que emite el motor de voz.
   *
   * @returns Manejadores del gateway de voz.
   */
  private buildProviderHandlers(): VoiceProviderEventHandlers {
    return {
      onAudioFrame: (pcmFrame: Buffer) => {
        this.sendFrameToClient(encodeAudioDownlinkFrame(pcmFrame));
      },
      onTranscript: (text: string, isFinal: boolean) => {
        this.sendFrameToClient(encodeControlFrame('assistant.speaking', { transcript: text, isFinal }));
      },
      onToolInvocation: (invocation: ToolInvocation) => {
        void this.dispatchToolInvocation(invocation);
      },
      onAssistantSpeechStarted: () => {
        this.sendFrameToClient(encodeControlFrame('assistant.speaking', { started: true }));
      },
      onProviderError: (reason: string) => {
        void this.close('FAILED_PROVIDER_ERROR', `Fallo del motor de voz: ${reason}`);
      },
      onClosed: () => {
        if (!this.isClosed) {
          void this.close('COMPLETED_NORMAL', 'El motor de voz cerro el canal.');
        }
      },
    };
  }

  /**
   * Despacha una invocacion de herramienta aplicando las barreras de seguridad.
   *
   * @param invocation - Invocacion emitida por el motor.
   */
  private async dispatchToolInvocation(invocation: ToolInvocation): Promise<void> {
    if (this.providerStream === null || this.isClosed) {
      return;
    }
    const providerStream = this.providerStream;

    await this.ports.pool.runInTenantTransaction({ organizationId: this.authenticatedOrganizationId }, async (client: PoolClient) => {
      await this.ports.dispatchToolUseCase.execute({
        organizationId: this.authenticatedOrganizationId,
        projectId: this.request.projectId,
        functionalMapId: this.functionalMapId,
        voiceSessionId: this.request.voiceSessionId,
        client,
        routePath: this.router.getCurrentRoutePath(),
        currentStepNumber: this.stepStateMachine.getCurrentStep(),
        invocation,
        stepStateMachine: this.stepStateMachine,
        providerStream,
        sendFrameToClient: this.sendFrameToClient,
        awaitClientAck: (providerToolCallId, timeoutMs) => this.router.registerPendingAck(providerToolCallId, timeoutMs),
      });
    });
  }

  /**
   * Arranca el pulso de facturacion con el contexto transaccional de cada cobro.
   */
  private startMeteringPulse(): void {
    this.ports.meteringService.startTimer(
      this.request.voiceSessionId,
      async () =>
        this.ports.pool.runInTenantTransaction({ organizationId: this.authenticatedOrganizationId }, async (client) => ({
          client,
          sendFrameToClient: this.sendFrameToClient,
        })),
      (tickResult) => {
        void this.close(
          'TERMINATED_INSUFFICIENT_FUNDS',
          tickResult.terminationReason ?? 'Fondos insuficientes para continuar la sesion.'
        );
      }
    );
  }

  /**
   * Liquida el consumo pendiente y persiste el estado final de la sesion.
   *
   * @param status - Estado final de la sesion.
   * @param reason - Motivo del cierre.
   */
  private async settleAndPersist(status: VoiceSessionClosingStatus, reason: string): Promise<void> {
    await this.ports.pool.runInTenantTransaction({ organizationId: this.authenticatedOrganizationId }, async (client) => {
      try {
        await this.ports.meteringService.settleAndClose(this.request.voiceSessionId, {
          client,
          sendFrameToClient: this.sendFrameToClient,
        });
      } catch {
        // Un fallo de liquidacion no debe impedir registrar el cierre: el consumo ya cobrado queda en
        // el libro mayor y el estado de la sesion se comunica de todas formas.
      }
    });

    this.sendFrameToClient(encodeControlFrame('session.closing', { closeCode: 1000, publicMessage: reason, status }));
  }

  /**
   * Compone el prompt de sistema con el paso vigente y los elementos de la ruta.
   *
   * @param basePrompt - Prompt publicado por el proyecto.
   * @param stepInstruction - Instruccion del paso vigente.
   * @param routeSummary - Resumen de los elementos accionables de la ruta.
   * @returns Prompt de sistema listo para el motor de voz.
   */
  private buildSystemPrompt(basePrompt: string, stepInstruction: string, routeSummary: string): string {
    const sections = [basePrompt];
    if (stepInstruction.length > 0) {
      sections.push(`Paso vigente: ${stepInstruction}`);
    }
    if (routeSummary.length > 0) {
      sections.push(`Elementos disponibles en la pantalla actual: ${routeSummary}`);
    }
    return sections.join('\n\n');
  }

  /**
   * Devuelve la latencia del ultimo refresco de contexto de ruta.
   *
   * @returns Latencia medida en milisegundos.
   */
  public getLastContextRefreshMs(): number {
    return this.router.getLastContextRefreshMs();
  }
}

/**
 * Autoriza y arranca una sesion de voz sobre una conexion WebSocket ya establecida.
 *
 * @param ports - Puertos y casos de uso del gateway.
 * @param request - Datos de apertura de la sesion.
 * @param sendFrameToClient - Envio de tramas al navegador.
 * @param closeClientSocket - Cierre del socket del cliente.
 * @returns Sesion operativa, o `null` cuando la autorizacion falla.
 * @throws ValidationError cuando faltan datos obligatorios de apertura.
 */
export async function openVoiceWebSocketSession(
  ports: VoiceWebSocketPorts,
  request: VoiceWebSocketOpenRequest,
  sendFrameToClient: ClientFrameSender,
  closeClientSocket: ClientCloser
): Promise<VoiceWebSocketSession | null> {
  if (request.nonceId.trim().length === 0 || request.projectId.trim().length === 0) {
    throw new ValidationError('La apertura de una sesion de voz exige el nonce de handshake y el proyecto.');
  }

  const session = new VoiceWebSocketSession(ports, request, sendFrameToClient, closeClientSocket);
  const started = await session.start();
  return started ? session : null;
}


