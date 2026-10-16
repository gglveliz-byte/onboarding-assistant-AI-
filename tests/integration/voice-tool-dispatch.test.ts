/**
 * @archivo tests/integration/voice-tool-dispatch.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego de las Barreras de Seguridad y el Despacho de Herramientas)
 * @proposito
 *   Certifica que ninguna accion fisica llegue al navegador del usuario final sin haber pasado las
 *   tres barreras de seguridad. Un avance de paso que se salta el orden estricto del onboarding, un
 *   elemento que no existe en la ruta activa, una herramienta no declarada o una escritura en un
 *   campo sensible deben rechazarse. Y el rechazo se devuelve AL MODELO, no al DOM: si solo se
 *   descartara la accion, el asistente se quedaria esperando una confirmacion que nunca llega y la
 *   conversacion se detendria en silencio. Tambien verifica que el texto escrito jamas se persista
 *   en claro en la bitacora de acciones, porque puede contener datos personales del usuario final.
 *
 * @resumen_contenido
 *   - Bloque `verifyStepMachineGuardrail()`: Cumplimiento estricto del orden de pasos.
 *   - Bloque `verifyFunctionalMapGuardrail()`: Elemento ausente en la ruta activa.
 *   - Bloque `verifySuccessfulDispatch()`: Directiva enviada, cascada de selectores y acuse.
 *   - Bloque `verifyBlockedAndTimeoutPaths()`: Campo sensible y accion sin confirmacion.
 *
 * @dependencias_internas
 *   - `DispatchDomToolUseCase` (`src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case.ts`).
 *   - `OnboardingStepStateMachine` (dominio del modulo).
 *   - Codec de tramas y dobles compartidos (`./support/voice-gateway-doubles.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Prueba con dobles: no abre conexiones ni toca la base de datos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (La prueba verifica el rechazo ANTES de cualquier escritura).
 */

import {
  DispatchDomToolUseCase,
  type ToolAckOutcome,
} from '../../src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case';
import { OnboardingStepStateMachine } from '../../src/modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types';
import { decodeClientFrame } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import {
  buildDispatchRequest,
  buildFakeProviderStream,
  buildFakeRagPort,
  buildFakeSessionRepository,
  buildInvocation,
  check,
  countPassedAssertions,
} from './support/voice-gateway-doubles';

/**
 * Construye el caso de uso con los dobles indicados.
 *
 * @param guardrailResult - Respuesta que debe devolver la barrera del mapa funcional.
 * @returns Caso de uso listo para la prueba.
 */
function buildUseCase(guardrailResult: Parameters<typeof buildFakeRagPort>[0]): DispatchDomToolUseCase {
  return new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: buildFakeSessionRepository().repository,
    ragPort: buildFakeRagPort(guardrailResult),
  });
}

/** Verifica el cumplimiento estricto del orden de pasos del onboarding. */
async function verifyStepMachineGuardrail(): Promise<void> {
  const providerDoubles = buildFakeProviderStream();
  const sessionDoubles = buildFakeSessionRepository();
  const useCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: sessionDoubles.repository,
    ragPort: buildFakeRagPort({ ok: true, primarySelector: '#x', riskLevel: 'LOW', requiresUserConfirmation: false }),
  });

  const rejected = await useCase.execute(
    buildDispatchRequest({
      invocation: buildInvocation({
        toolName: 'advance_onboarding_step',
        targetElementKey: '',
        textPayload: JSON.stringify({ currentStepNumber: 1, nextStepNumber: 3 }),
      }),
      stepStateMachine: new OnboardingStepStateMachine(1, 4, true),
      currentStepNumber: 1,
      providerStream: providerDoubles.stream,
    })
  );

  check(!rejected.executed, 'Saltarse un paso con cumplimiento estricto no debe ejecutar la accion');
  check(
    rejected.finalStatus === 'REJECTED_BY_GUARDRAIL',
    `El estado final debe ser un rechazo por barrera (obtenido: ${rejected.finalStatus})`
  );
  check(rejected.rejectionReason?.includes('paso') === true, 'El motivo debe explicar el salto de paso rechazado');
  check(providerDoubles.toolResults.length === 1, 'El rechazo debe devolverse al modelo para que pueda explicarlo');
  check(providerDoubles.toolResults[0]?.succeeded === false, 'El resultado devuelto al modelo debe declarar el fallo');
  check(
    sessionDoubles.statusUpdates.some((update) => update.status === 'REJECTED_BY_GUARDRAIL'),
    'El rechazo debe quedar registrado en la trazabilidad de acciones'
  );

  const machine = new OnboardingStepStateMachine(1, 4, true);
  const allowed = await useCase.execute(
    buildDispatchRequest({
      invocation: buildInvocation({
        toolName: 'advance_onboarding_step',
        targetElementKey: '',
        textPayload: JSON.stringify({ currentStepNumber: 1, nextStepNumber: 2 }),
      }),
      stepStateMachine: machine,
      currentStepNumber: 1,
    })
  );
  check(allowed.executed, 'Avanzar al paso inmediato siguiente si debe permitirse');
  check(allowed.currentStepNumber === 2, `El paso vigente debe avanzar a 2 (obtenido: ${allowed.currentStepNumber})`);

  const missingTarget = await useCase.execute(
    buildDispatchRequest({
      invocation: buildInvocation({ toolName: 'advance_onboarding_step', targetElementKey: '', textPayload: null }),
      stepStateMachine: new OnboardingStepStateMachine(1, 4, true),
    })
  );
  check(!missingTarget.executed, 'Un avance sin paso de destino declarado debe rechazarse');

  const laxMachine = new OnboardingStepStateMachine(1, 4, false);
  check(laxMachine.validateTransition(4).allowed, 'Sin cumplimiento estricto la maquina de estados debe admitir saltos');
  check(!laxMachine.validateTransition(9).allowed, 'Un paso fuera del rango del flujo debe rechazarse siempre');
  check(!laxMachine.validateTransition(0).allowed, 'Un paso por debajo del primero debe rechazarse');

  const completionMachine = new OnboardingStepStateMachine(3, 4, true);
  check(!completionMachine.isComplete(), 'El flujo no debe darse por completo antes del ultimo paso');
  completionMachine.advance(4);
  check(completionMachine.isComplete(), 'Alcanzar el ultimo paso debe marcar el flujo como completo');
  check(completionMachine.getTotalSteps() === 4, 'El total de pasos debe conservarse');
}

/** Verifica la barrera del mapa funcional. */
async function verifyFunctionalMapGuardrail(): Promise<void> {
  const useCase = buildUseCase({
    ok: false,
    code: 'ELEMENT_NOT_FOUND',
    reason: 'El elemento no existe en la ruta activa.',
    retryable: false,
  });
  const providerDoubles = buildFakeProviderStream();
  const sessionDoubles = buildFakeSessionRepository();
  const guardedUseCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: sessionDoubles.repository,
    ragPort: buildFakeRagPort({
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
      reason: 'El elemento no existe en la ruta activa.',
      retryable: false,
    }),
  });

  const mapRejection = await guardedUseCase.execute(
    buildDispatchRequest({ providerStream: providerDoubles.stream, sendFrameToClient: () => undefined })
  );
  check(!mapRejection.executed, 'Un elemento ausente del mapa funcional no debe ejecutarse');
  check(
    mapRejection.finalStatus === 'REJECTED_BY_GUARDRAIL',
    'La ausencia de elemento debe registrarse como rechazo por barrera'
  );
  check(
    providerDoubles.toolResults[0]?.payload !== undefined,
    'El modelo debe recibir el motivo del rechazo para poder explicarlo al usuario'
  );

  const outOfRange = await useCase.execute(
    buildDispatchRequest({
      invocation: buildInvocation({ toolName: 'advance_onboarding_step', targetElementKey: '', textPayload: '{}' }),
    })
  );
  check(!outOfRange.executed, 'Un avance con argumentos ilegibles debe rechazarse en lugar de despacharse');
}

/** Verifica el camino exitoso de despacho con su cascada de selectores y su acuse. */
async function verifySuccessfulDispatch(): Promise<void> {
  const sessionDoubles = buildFakeSessionRepository();
  const providerDoubles = buildFakeProviderStream();
  const sentFrames: Buffer[] = [];
  let capturedCallId = '';
  let capturedTimeout = 0;

  const useCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: sessionDoubles.repository,
    ragPort: buildFakeRagPort({
      ok: true,
      primarySelector: '#btn-comenzar',
      riskLevel: 'LOW',
      requiresUserConfirmation: false,
    }),
  });

  const success = await useCase.execute(
    buildDispatchRequest({
      providerStream: providerDoubles.stream,
      sendFrameToClient: (frame: Buffer) => sentFrames.push(frame),
      awaitClientAck: async (providerToolCallId: string, timeoutMs: number): Promise<ToolAckOutcome> => {
        capturedCallId = providerToolCallId;
        capturedTimeout = timeoutMs;
        return { succeeded: true, detail: null };
      },
    })
  );

  check(success.executed, 'Con un elemento valido la accion debe ejecutarse');
  check(success.finalStatus === 'ACK_SUCCESS', `El estado final debe ser ACK_SUCCESS (obtenido: ${success.finalStatus})`);
  check(success.actionEventId !== null, 'La accion despachada debe tener su evento de trazabilidad');
  check(success.executionLatencyMs !== null, 'La latencia del acuse debe medirse');
  check(capturedCallId === 'call-prueba-1', 'El acuse debe esperarse con el identificador de la llamada correcta');
  check(capturedTimeout > 0, 'El tiempo de espera del acuse debe ser positivo');

  check(sentFrames.length === 1, 'Debe enviarse exactamente una directiva al navegador');
  const directive = decodeClientFrame(sentFrames[0] as Buffer);
  check(directive.ok && directive.frame.controlName === 'tool.execute', 'La directiva enviada debe ser tool.execute');
  const cascade = directive.ok ? (directive.frame.controlBody?.['selectorCascade'] as string[] | undefined) : undefined;
  check(cascade !== undefined && cascade.length >= 2, 'La directiva debe incluir una cascada de selectores de respaldo');
  check(cascade?.[0] === '#btn-comenzar', 'El primer selector de la cascada debe ser el validado por el mapa');
  check(
    cascade?.some((selector) => selector.includes('data-oa-key')) === true,
    'La cascada debe incluir el selector por atributo de datos'
  );
  check(
    cascade?.every((selector, index) => cascade.indexOf(selector) === index) === true,
    'La cascada no debe repetir selectores'
  );

  check(sessionDoubles.createdEvents.length === 1, 'Debe registrarse exactamente un evento de accion');
  const recordedPayload = sessionDoubles.createdEvents[0]?.['actionPayloadRedactedJson'] as Record<string, unknown> | undefined;
  check(
    recordedPayload?.['targetElementKey'] === 'btn_comenzar' || recordedPayload?.['textPayloadLength'] !== undefined,
    'El evento debe registrar metadatos depurados de la accion'
  );
  check(
    sessionDoubles.createdEvents[0]?.['routePathAtExecution'] === '/panel/inicio',
    'El evento debe conservar la ruta en la que se ejecuto la accion'
  );
  check(
    sessionDoubles.statusUpdates.some((update) => update.status === 'ACK_SUCCESS' && update.latencyMs !== undefined),
    'El acuse exitoso debe persistirse con su latencia medida'
  );

  const textSent: Buffer[] = [];
  const textSessionDoubles = buildFakeSessionRepository();
  const textUseCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: textSessionDoubles.repository,
    ragPort: buildFakeRagPort({ ok: true, primarySelector: '#email', riskLevel: 'LOW', requiresUserConfirmation: false }),
  });
  await textUseCase.execute(
    buildDispatchRequest({
      invocation: buildInvocation({ toolName: 'type_text', targetElementKey: 'input_email', textPayload: 'ana@ejemplo.com' }),
      sendFrameToClient: (frame: Buffer) => textSent.push(frame),
    })
  );
  const textDirective = decodeClientFrame(textSent[0] as Buffer);
  check(
    textDirective.ok && textDirective.frame.controlBody?.['textPayload'] === 'ana@ejemplo.com',
    'La escritura debe enviar el texto al navegador aunque no se persista en la bitacora'
  );
  check(
    JSON.stringify(textSessionDoubles.createdEvents).includes('ana@ejemplo.com') === false,
    'El texto escrito jamas debe persistirse en claro: puede contener datos personales del usuario final'
  );
}

/** Verifica el bloqueo por campo sensible y la ausencia de confirmacion del navegador. */
async function verifyBlockedAndTimeoutPaths(): Promise<void> {
  const sensitiveProvider = buildFakeProviderStream();
  const sensitiveSession = buildFakeSessionRepository();
  const sensitiveUseCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: sensitiveSession.repository,
    ragPort: buildFakeRagPort({ ok: true, primarySelector: '#tarjeta', riskLevel: 'HIGH', requiresUserConfirmation: true }),
  });

  const sentFrames: Buffer[] = [];
  const sensitive = await sensitiveUseCase.execute(
    buildDispatchRequest({
      providerStream: sensitiveProvider.stream,
      sendFrameToClient: (frame: Buffer) => sentFrames.push(frame),
      invocation: buildInvocation({ toolName: 'type_text', targetElementKey: 'input_tarjeta', textPayload: '4111111111111111' }),
      awaitClientAck: async () => ({ succeeded: false, detail: 'SENSITIVE_FIELD_BLOCKED por el cliente' }),
    })
  );

  check(!sensitive.executed, 'Una escritura bloqueada por campo sensible no debe considerarse ejecutada');
  check(
    sensitive.finalStatus === 'BLOCKED_SENSITIVE_FIELD',
    `El estado final debe identificar el bloqueo por campo sensible (obtenido: ${sensitive.finalStatus})`
  );
  check(
    sensitiveProvider.toolResults[0]?.succeeded === false,
    'El modelo debe saber que la escritura fue bloqueada para no insistir con el mismo campo'
  );
  check(
    sensitiveSession.statusUpdates.some((update) => update.errorCode === 'SENSITIVE_FIELD_BLOCKED'),
    'El evento debe registrar el codigo de bloqueo por campo sensible'
  );
  check(
    JSON.stringify(sensitiveSession.createdEvents).includes('4111111111111111') === false,
    'El numero de tarjeta jamas debe quedar en la bitacora de acciones'
  );
  const sensitiveDirective = decodeClientFrame(sentFrames[0] as Buffer);
  check(
    sensitiveDirective.ok && sensitiveDirective.frame.controlBody?.['requiresUserConfirmation'] === true,
    'Una accion de riesgo alto debe exigir confirmacion explicita del usuario final'
  );

  const timeoutSession = buildFakeSessionRepository();
  const timeoutUseCase = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: timeoutSession.repository,
    ragPort: buildFakeRagPort({ ok: true, primarySelector: '#boton', riskLevel: 'LOW', requiresUserConfirmation: false }),
  });
  const timedOut = await timeoutUseCase.execute(
    buildDispatchRequest({ awaitClientAck: async () => ({ succeeded: false, detail: 'CLIENT_ACK_TIMEOUT: sin confirmacion' }) })
  );
  check(!timedOut.executed, 'Una accion sin confirmacion no debe considerarse ejecutada');
  check(
    timedOut.finalStatus === 'FAILED_CLIENT_TIMEOUT',
    `El estado final debe identificar el tiempo agotado (obtenido: ${timedOut.finalStatus})`
  );
  check(
    timeoutSession.statusUpdates.some((update) => update.errorCode === 'CLIENT_ACK_TIMEOUT'),
    'El evento debe registrar el codigo de tiempo agotado del cliente'
  );

  const failingPersistence = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: {
      incrementToolCallsCount: async () => {
        throw new Error('La base de datos no responde.');
      },
    } as never,
    ragPort: buildFakeRagPort({
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
      reason: 'Elemento ausente.',
      retryable: false,
    }),
  });
  const resilient = await failingPersistence.execute(buildDispatchRequest());
  check(!resilient.executed, 'Un fallo de persistencia no debe convertir un rechazo en una ejecucion');
  check(resilient.actionEventId === null, 'Si la trazabilidad falla, el evento debe declararse ausente en lugar de inventarse');
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DE LAS BARRERAS DE SEGURIDAD Y EL DESPACHO DE HERRAMIENTAS (PARTE 13)');
  console.log('='.repeat(96));

  await verifyStepMachineGuardrail();
  console.log('[1/4] Cumplimiento estricto del orden de pasos del onboarding: APROBADO.');

  await verifyFunctionalMapGuardrail();
  console.log('[2/4] Barrera del mapa funcional ante elementos ausentes: APROBADO.');

  await verifySuccessfulDispatch();
  console.log('[3/4] Despacho con cascada de selectores, acuse y depuracion del texto: APROBADO.');

  await verifyBlockedAndTimeoutPaths();
  console.log('[4/4] Bloqueo por campo sensible y accion sin confirmacion: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
