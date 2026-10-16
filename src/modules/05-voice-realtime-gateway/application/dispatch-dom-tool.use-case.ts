/**
 * @archivo src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case.ts
 * @modulo 05-voice-realtime-gateway (Despacho Validado de Herramientas Fisicas sobre el DOM)
 * @proposito
 *   Convierte una invocacion de herramienta propuesta por el motor de voz en una accion fisica
 *   segura sobre el navegador del usuario final. Antes de enviar nada al SDK se aplican TRES
 *   barreras en orden: la maquina de estados del onboarding (un avance de paso no puede saltarse
 *   pasos cuando el proyecto exige cumplimiento estricto), la barrera del mapa funcional (el
 *   elemento debe existir en la ruta activa y soportar la accion solicitada) y la proteccion de
 *   campos sensibles del SDK. Un rechazo se devuelve AL MODELO como resultado de la herramienta, no
 *   al navegador: asi el asistente puede explicar al usuario por que no puede hacer eso, en lugar de
 *   quedarse esperando una confirmacion que nunca llegara.
 *
 * @resumen_contenido
 *   - Constantes `TOOL_ACK_TIMEOUT_MS` y `SENSITIVE_FIELD_ERROR_CODE`.
 *   - Interfaces `DomToolDispatchRequest`, `DomToolDispatchResult` y `DomToolDispatchDependencies`.
 *   - Clase `DispatchDomToolUseCase`:
 *       * `execute()`: Valida, persiste, envia al SDK y espera el acuse.
 *       * `validateAgainstGuardrails()`: Las tres barreras en orden.
 *       * `recordDispatchedEvent()` y `recordFinalStatus()`: Trazabilidad en `action_events`.
 *
 * @dependencias_internas
 *   - `IVisualRagAndPromptPort.validateElementActionGuardrail()` (`src/shared/ports/core-modules.ports.ts`).
 *   - `IActiveProviderStream.sendToolResult()` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `PostgresVoiceSessionRepository` (`../infrastructure/postgres-voice-session.repository.ts`).
 *   - `encodeToolExecuteFrame()` (`../infrastructure/voice-frame.protocol.ts`).
 *   - `OnboardingStepStateMachine` (`../domain/voice-session-and-tools.types.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion transaccional con RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `action_events` (Alta en estado `DISPATCHED` y actualizacion con el acuse) y
 *     `voice_sessions` (Incremento del contador de llamadas de herramienta).
 */

import type { PoolClient } from 'pg';
import { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { IActiveProviderStream, ToolInvocation } from '../../../shared/ports/billing-voice-admin.ports';
import type { IVisualRagAndPromptPort } from '../../../shared/ports/core-modules.ports';
import type { OnboardingStepStateMachine } from '../domain/voice-session-and-tools.types';
import type { PostgresVoiceSessionRepository } from '../infrastructure/postgres-voice-session.repository';
import { encodeToolExecuteFrame, type ToolExecuteDirective } from '../infrastructure/voice-frame.protocol';

/** Tiempo maximo que se espera el acuse del navegador antes de dar la accion por fallida. */
export const TOOL_ACK_TIMEOUT_MS = 5000;

/** Codigo de error con el que se marca una accion bloqueada por un campo sensible. */
export const SENSITIVE_FIELD_ERROR_CODE = 'SENSITIVE_FIELD_BLOCKED';

/** Solicitud de despacho de una herramienta fisica. */
export interface DomToolDispatchRequest {
  /** Organizacion propietaria de la sesion. */
  readonly organizationId: string;
  /** Proyecto cuyo mapa funcional gobierna la accion. */
  readonly projectId: string;
  /** Version inmutable del mapa activo. */
  readonly functionalMapId: string;
  /** Sesion de voz que propone la accion. */
  readonly voiceSessionId: string;
  /** Conexion transaccional con contexto RLS para la trazabilidad. */
  readonly client: PoolClient;
  /** Ruta en la que se encuentra el usuario final. */
  readonly routePath: string;
  /** Paso de onboarding vigente. */
  readonly currentStepNumber: number;
  /** Invocacion emitida por el motor de voz. */
  readonly invocation: ToolInvocation;
  /** Maquina de estados del onboarding, cuando el proyecto exige cumplimiento estricto. */
  readonly stepStateMachine: OnboardingStepStateMachine | null;
  /** Canal activo del motor, usado para devolverle el resultado. */
  readonly providerStream: IActiveProviderStream;
  /** Envio de la directiva al navegador del usuario final. */
  readonly sendFrameToClient: (frame: Buffer) => void;
  /** Espera del acuse del navegador, resuelto por el bucle de tramas del socket. */
  readonly awaitClientAck: (providerToolCallId: string, timeoutMs: number) => Promise<ToolAckOutcome>;
}

/** Acuse recibido del navegador del usuario final. */
export interface ToolAckOutcome {
  /** Indica si la accion fisica se completo. */
  readonly succeeded: boolean;
  /** Detalle del fallo, cuando la accion no se completo. */
  readonly detail: string | null;
}

/** Resultado del despacho de una herramienta. */
export interface DomToolDispatchResult {
  /** Indica si la accion se ejecuto efectivamente en el navegador. */
  readonly executed: boolean;
  /** Estado final registrado en `action_events`. */
  readonly finalStatus: 'ACK_SUCCESS' | 'REJECTED_BY_GUARDRAIL' | 'BLOCKED_SENSITIVE_FIELD' | 'FAILED_CLIENT_TIMEOUT';
  /** Motivo del rechazo o del fallo, en lenguaje tecnico para la bitacora. */
  readonly rejectionReason: string | null;
  /** Identificador del evento de accion registrado. */
  readonly actionEventId: string | null;
  /** Latencia medida entre el envio de la directiva y el acuse, en milisegundos. */
  readonly executionLatencyMs: number | null;
  /** Paso de onboarding que queda vigente tras la accion. */
  readonly currentStepNumber: number;
}

/** Dependencias del caso de uso de despacho. */
export interface DomToolDispatchDependencies {
  /** Pool con contexto RLS para la trazabilidad transaccional. */
  readonly pool: RlsDatabasePool;
  /** Repositorio de sesiones de voz y eventos de accion. */
  readonly sessionRepository: PostgresVoiceSessionRepository;
  /** Puerto del mapa funcional y de la barrera de seguridad de elementos. */
  readonly ragPort: IVisualRagAndPromptPort;
}

/**
 * Caso de uso de despacho validado de herramientas fisicas.
 * Ninguna accion llega al navegador sin haber pasado las tres barreras de seguridad.
 */
export class DispatchDomToolUseCase {
  private readonly dependencies: DomToolDispatchDependencies;

  /**
   * @param dependencies - Pool con RLS, repositorio de sesiones y puerto del mapa funcional.
   */
  public constructor(dependencies: DomToolDispatchDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Valida y despacha una invocacion de herramienta hacia el navegador del usuario final.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @returns Resultado del despacho con su estado final.
   */
  public async execute(request: DomToolDispatchRequest): Promise<DomToolDispatchResult> {
    const { invocation } = request;

    const guardrailOutcome = await this.validateAgainstGuardrails(request);
    if (!guardrailOutcome.allowed) {
      // Un rechazo se devuelve al MODELO, no al navegador: asi el asistente explica al usuario por
      // que no puede hacerlo, en lugar de quedarse esperando un acuse que jamas llegara.
      request.providerStream.sendToolResult(invocation.providerToolCallId, false, {
        rejectedBy: guardrailOutcome.category,
        reason: guardrailOutcome.reason,
      });
      const actionEventId = await this.recordRejectedEvent(request, guardrailOutcome.reason);

      return {
        executed: false,
        finalStatus: 'REJECTED_BY_GUARDRAIL',
        rejectionReason: guardrailOutcome.reason,
        actionEventId,
        executionLatencyMs: null,
        currentStepNumber: request.currentStepNumber,
      };
    }

    const actionEventId = await this.recordDispatchedEvent(request, guardrailOutcome.directive);
    request.sendFrameToClient(encodeToolExecuteFrame(guardrailOutcome.directive));

    const dispatchedAtMs = Date.now();
    const ack = await request.awaitClientAck(invocation.providerToolCallId, TOOL_ACK_TIMEOUT_MS);
    const executionLatencyMs = Date.now() - dispatchedAtMs;

    const finalStatus = this.resolveFinalStatus(ack);
    await this.recordFinalStatus(request, actionEventId, finalStatus, executionLatencyMs, ack.detail);
    request.providerStream.sendToolResult(invocation.providerToolCallId, ack.succeeded, {
      status: finalStatus,
      ...(ack.detail === null ? {} : { detail: ack.detail }),
    });

    const advancedStep = this.applyStepAdvance(request);

    return {
      executed: ack.succeeded,
      finalStatus,
      rejectionReason: ack.succeeded ? null : ack.detail,
      actionEventId,
      executionLatencyMs,
      currentStepNumber: advancedStep,
    };
  }

  /**
   * Aplica las tres barreras de seguridad en orden de coste creciente.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @returns Autorizacion con la directiva lista para el navegador, o el motivo del rechazo.
   */
  public async validateAgainstGuardrails(
    request: DomToolDispatchRequest
  ): Promise<
    | {
        readonly allowed: true;
        readonly directive: ToolExecuteDirective;
      }
    | { readonly allowed: false; readonly category: string; readonly reason: string }
  > {
    const { invocation } = request;

    // Barrera 1: la maquina de estados del onboarding. Un avance de paso no puede saltarse pasos
    // cuando el proyecto exige cumplimiento estricto, porque el asistente perderia el hilo del flujo.
    if (invocation.toolName === 'advance_onboarding_step') {
      const targetStep = this.readNumericArgument(invocation, 'nextStepNumber');
      if (targetStep === null) {
        return { allowed: false, category: 'STEP_MACHINE', reason: 'El avance de paso no declara el paso de destino.' };
      }
      if (request.stepStateMachine !== null) {
        const transition = request.stepStateMachine.validateTransition(targetStep);
        if (!transition.allowed) {
          return { allowed: false, category: 'STEP_MACHINE', reason: transition.reason };
        }
      }
      return {
        allowed: true,
        directive: {
          providerToolCallId: invocation.providerToolCallId,
          toolName: invocation.toolName,
          targetElementKey: invocation.targetElementKey,
          primarySelector: '',
          selectorCascade: [],
          textPayload: null,
          requiresUserConfirmation: false,
          riskLevel: 'LOW',
        },
      };
    }

    // Barrera 2: el mapa funcional. El elemento debe existir en la ruta activa y soportar la accion.
    const guardrail = await this.dependencies.ragPort.validateElementActionGuardrail(
      request.projectId,
      request.functionalMapId,
      invocation.toolName,
      invocation.targetElementKey,
      request.routePath
    );
    if (!guardrail.ok) {
      return { allowed: false, category: 'FUNCTIONAL_MAP', reason: guardrail.reason };
    }

    return {
      allowed: true,
      directive: {
        providerToolCallId: invocation.providerToolCallId,
        toolName: invocation.toolName,
        targetElementKey: invocation.targetElementKey,
        primarySelector: guardrail.primarySelector,
        selectorCascade: this.buildSelectorCascade(guardrail.primarySelector, invocation.targetElementKey),
        textPayload: invocation.toolName === 'type_text' ? invocation.textPayload : null,
        requiresUserConfirmation: guardrail.requiresUserConfirmation,
        riskLevel: guardrail.riskLevel,
      },
    };
  }

  /**
   * Registra el evento de accion en estado despachado y contabiliza la llamada en la sesion.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @param directive - Directiva ya validada.
   * @returns Identificador del evento de accion registrado.
   */
  private async recordDispatchedEvent(request: DomToolDispatchRequest, directive: ToolExecuteDirective): Promise<string> {
    await this.dependencies.sessionRepository.incrementToolCallsCount(request.client, request.voiceSessionId);
    const actionEvent = await this.dependencies.sessionRepository.createActionEvent(request.client, {
      organizationId: request.organizationId,
      projectId: request.projectId,
      voiceSessionId: request.voiceSessionId,
      providerToolCallId: request.invocation.providerToolCallId,
      toolName: request.invocation.toolName,
      routePathAtExecution: request.routePath,
      selectorUsed: directive.primarySelector,
      // El texto a escribir NO se registra en claro: puede contener datos personales del usuario
      // final, y la bitacora de acciones no es el lugar para conservarlos.
      actionPayloadRedactedJson: {
        targetElementKey: directive.targetElementKey,
        textPayloadLength: directive.textPayload === null ? 0 : directive.textPayload.length,
        riskLevel: directive.riskLevel,
      },
    });
    return actionEvent.id;
  }

  /**
   * Registra el evento de accion rechazado por la barrera de seguridad.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @param reason - Motivo del rechazo.
   * @returns Identificador del evento de accion registrado, o `null` si la persistencia falla.
   */
  private async recordRejectedEvent(request: DomToolDispatchRequest, reason: string): Promise<string | null> {
    try {
      const actionEvent = await this.dependencies.sessionRepository.createActionEvent(request.client, {
        organizationId: request.organizationId,
        projectId: request.projectId,
        voiceSessionId: request.voiceSessionId,
        providerToolCallId: request.invocation.providerToolCallId,
        toolName: request.invocation.toolName,
        routePathAtExecution: request.routePath,
        selectorUsed: '',
        actionPayloadRedactedJson: { rejectedReason: reason, targetElementKey: request.invocation.targetElementKey },
      });
      await this.dependencies.sessionRepository.updateActionEventStatus(
        request.client,
        actionEvent.id,
        'REJECTED_BY_GUARDRAIL',
        undefined,
        'GUARDRAIL_REJECTED'
      );
      return actionEvent.id;
    } catch {
      // La trazabilidad es valiosa pero no puede impedir que el modelo reciba su rechazo: si el
      // modelo no recibe respuesta, deja de hablar y la sesion queda muda.
      return null;
    }
  }

  /**
   * Actualiza el evento de accion con su estado final y su latencia medida.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @param actionEventId - Identificador del evento de accion.
   * @param finalStatus - Estado final resuelto a partir del acuse.
   * @param latencyMs - Latencia medida.
   * @param detail - Detalle del fallo, cuando existe.
   */
  private async recordFinalStatus(
    request: DomToolDispatchRequest,
    actionEventId: string,
    finalStatus: DomToolDispatchResult['finalStatus'],
    latencyMs: number,
    detail: string | null
  ): Promise<void> {
    const errorCode =
      finalStatus === 'BLOCKED_SENSITIVE_FIELD'
        ? SENSITIVE_FIELD_ERROR_CODE
        : finalStatus === 'FAILED_CLIENT_TIMEOUT'
          ? 'CLIENT_ACK_TIMEOUT'
          : null;
    await this.dependencies.sessionRepository.updateActionEventStatus(
      request.client,
      actionEventId,
      finalStatus,
      latencyMs,
      errorCode ?? detail ?? undefined
    );
  }

  /**
   * Traduce el acuse del navegador a un estado final del evento de accion.
   *
   * @param ack - Acuse recibido del navegador.
   * @returns Estado final del evento de accion.
   */
  private resolveFinalStatus(ack: ToolAckOutcome): DomToolDispatchResult['finalStatus'] {
    if (ack.succeeded) {
      return 'ACK_SUCCESS';
    }
    if (ack.detail !== null && ack.detail.includes(SENSITIVE_FIELD_ERROR_CODE)) {
      return 'BLOCKED_SENSITIVE_FIELD';
    }
    return ack.detail !== null && ack.detail.includes('TIMEOUT') ? 'FAILED_CLIENT_TIMEOUT' : 'BLOCKED_SENSITIVE_FIELD';
  }

  /**
   * Aplica el avance de paso del onboarding cuando la accion lo solicita.
   *
   * @param request - Invocacion del motor con el contexto de la sesion.
   * @returns Paso de onboarding vigente tras la accion.
   */
  private applyStepAdvance(request: DomToolDispatchRequest): number {
    if (request.invocation.toolName !== 'advance_onboarding_step' || request.stepStateMachine === null) {
      return request.currentStepNumber;
    }
    const targetStep = this.readNumericArgument(request.invocation, 'nextStepNumber');
    if (targetStep === null) {
      return request.currentStepNumber;
    }
    try {
      request.stepStateMachine.advance(targetStep);
      return request.stepStateMachine.getCurrentStep();
    } catch {
      // La transicion ya fue validada antes de despachar: si aun asi falla, se conserva el paso
      // vigente en lugar de dejar la sesion en un estado indeterminado.
      return request.currentStepNumber;
    }
  }

  /**
   * Compone la cascada de selectores que el cliente probara en orden.
   * La cascada es deliberadamente conservadora: si el selector primario del mapa no encuentra el
   * elemento —porque la aplicacion del cliente cambio su marcado—, se intenta primero por atributo
   * de datos y despues por identificador estable, sin recurrir nunca a coincidencias por texto
   * visible, que engancharian elementos equivocados.
   *
   * @param primarySelector - Selector validado por la barrera del mapa.
   * @param targetElementKey - Clave del elemento en el mapa funcional.
   * @returns Cascada de selectores en orden de preferencia.
   */
  private buildSelectorCascade(primarySelector: string, targetElementKey: string): readonly string[] {
    const cascade = [primarySelector];
    const dataAttributeSelector = `[data-oa-key="${targetElementKey}"]`;
    if (!cascade.includes(dataAttributeSelector)) {
      cascade.push(dataAttributeSelector);
    }
    const idSelector = `#${targetElementKey}`;
    if (!cascade.includes(idSelector)) {
      cascade.push(idSelector);
    }
    return cascade;
  }

  /**
   * Lee un argumento numerico de los metadatos de la invocacion.
   *
   * @param invocation - Invocacion del motor.
   * @param argumentName - Nombre del argumento buscado.
   * @returns Valor numerico, o `null` cuando no esta declarado o no es un entero.
   */
  private readNumericArgument(invocation: ToolInvocation, argumentName: string): number | null {
    // El contrato comun del nucleo solo transporta la clave del elemento y el texto; los argumentos
    // numericos del avance de paso viajan serializados en el texto, de modo que se interpretan aqui.
    if (invocation.textPayload === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(invocation.textPayload) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const rawValue = (parsed as Record<string, unknown>)[argumentName];
      const numericValue = typeof rawValue === 'number' ? rawValue : Number.parseInt(String(rawValue ?? ''), 10);
      return Number.isInteger(numericValue) ? numericValue : null;
    } catch {
      return null;
    }
  }
}

/**
 * Ensambla el caso de uso de despacho de herramientas.
 *
 * @param dependencies - Pool con RLS, repositorio de sesiones y puerto del mapa funcional.
 * @returns Caso de uso listo para el gateway de voz.
 */
export function createDispatchDomToolUseCase(dependencies: DomToolDispatchDependencies): DispatchDomToolUseCase {
  return new DispatchDomToolUseCase(dependencies);
}
