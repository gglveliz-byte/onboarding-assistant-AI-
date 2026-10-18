/**
 * @archivo tests/integration/public-demo-operations.test.ts
 * @modulo Prueba de Integracion (Guion Operativo Real de la Demostracion Publica)
 * @proposito
 *   Certifica que la demostracion publica de la landing DEJE de ser solo conversacion: su mapa
 *   funcional sintetico declara los elementos reales del CRM simulado, la barrera de seguridad
 *   autoriza unicamente ese guion, el puerto RAG lo entrega al motor dentro del resumen de pantalla
 *   y el despacho de herramientas ejecuta la directiva hacia el navegador con su acuse, mientras el
 *   repositorio anulado del camino demo garantiza que una visita anonima jamas escriba en
 *   PostgreSQL (la organizacion sintetica `public-demo` no existe en la base a proposito).
 *
 * @resumen_contenido
 *   - Bloque `verifyPublicDemoFunctionalMap()`: Mapa sintetico, metadatos, entrega al motor y barrera.
 *   - Bloque `verifyPublicDemoDispatchAndRepository()`: Despacho real y repositorio anulado.
 *
 * @dependencias_internas
 *   - Mapa funcional de la demo (`src/bootstrap/public-demo-functional-map.ts`).
 *   - Costura de soporte demo (`src/bootstrap/public-demo-voice-support.ts`).
 *   - Despachador demo (`src/bootstrap/public-demo-tool-dispatch.ts`).
 *   - Dobles compartidos (`./support/voice-gateway-doubles.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Prueba con dobles: no abre conexiones ni toca la base de datos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (El repositorio anulado se verifica precisamente por no tocar PostgreSQL).
 */

import {
  DispatchDomToolUseCase,
  type ToolAckOutcome,
} from '../../src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case';
import { decodeClientFrame } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import {
  PUBLIC_DEMO_ALLOWED_ACTIONS,
  PUBLIC_DEMO_MAP_ELEMENTS,
  PUBLIC_DEMO_MAP_METADATA,
  PUBLIC_DEMO_STEP_INSTRUCTION,
  validatePublicDemoElementAction,
} from '../../src/bootstrap/public-demo-functional-map';
import { createPublicDemoRagPort } from '../../src/bootstrap/public-demo-voice-support';
import { PublicDemoVoiceSessionRepository } from '../../src/bootstrap/public-demo-tool-dispatch';
import {
  buildDispatchRequest,
  buildFakeProviderStream,
  buildFakeSessionRepository,
  buildInvocation,
  check,
  countPassedAssertions,
} from './support/voice-gateway-doubles';

/**
 * Verifica el mapa sintetico de la demo: guion completo, selectores anclados al tablero, entrega
 * del resumen al motor y barrera que solo autoriza ese guion.
 */
async function verifyPublicDemoFunctionalMap(): Promise<void> {
  check(PUBLIC_DEMO_MAP_ELEMENTS.length >= 5, 'El mapa de la demo debe declarar el guion operativo completo');
  check(
    PUBLIC_DEMO_MAP_METADATA.totalElementsCount === PUBLIC_DEMO_MAP_ELEMENTS.length,
    'Los metadatos de la demo deben declarar el numero real de elementos del guion'
  );
  check(
    PUBLIC_DEMO_ALLOWED_ACTIONS.every((action) =>
      PUBLIC_DEMO_MAP_ELEMENTS.some((element) => element.elementKey === action.elementKey)
    ),
    'Toda accion permitida de la demo debe existir en el mapa de elementos'
  );
  check(
    PUBLIC_DEMO_ALLOWED_ACTIONS.every((action) => action.primarySelector.startsWith('[data-oa-id="')),
    'Los selectores de la demo deben anclarse al atributo data-oa-id del tablero de la landing'
  );

  check(
    validatePublicDemoElementAction('click_element', 'btn-new-deal', '/').ok,
    'Abrir el formulario del trato debe estar autorizado en la demostracion'
  );
  check(
    validatePublicDemoElementAction('type_text', 'input-deal-name', '/').ok,
    'La barrera debe tolerar la clave sin prefijo demo- (el tablero resuelve ambas anclas)'
  );
  check(
    validatePublicDemoElementAction('click_element', 'btn-validate-cfdi', '/#demo-en-vivo').ok,
    'El ancla de la landing no debe invalidar la ruta unica de la demostracion'
  );
  const unknownElement = validatePublicDemoElementAction('click_element', 'btn-borrar-pipeline', '/');
  check(
    !unknownElement.ok && unknownElement.code === 'ELEMENT_NOT_FOUND',
    'Un elemento ausente del mapa demo debe rechazarse en lugar de despacharse'
  );
  const wrongAction = validatePublicDemoElementAction('type_text', 'btn-save-deal', '/');
  check(
    !wrongAction.ok && wrongAction.code === 'ELEMENT_ACTION_NOT_ALLOWED',
    'Escribir texto sobre un boton del mapa demo debe rechazarse'
  );
  const foreignRoute = validatePublicDemoElementAction('click_element', 'btn-new-deal', '/admin');
  check(
    !foreignRoute.ok && foreignRoute.code === 'MAP_NOT_PUBLISHED',
    'Una ruta ajena a la demostracion debe rechazarse'
  );

  const demoPort = createPublicDemoRagPort();
  const promptMeta = await demoPort.getActiveProjectPromptAndMapMeta('public-demo');
  check(
    promptMeta.ok && promptMeta.mapMetadata.totalElementsCount === PUBLIC_DEMO_MAP_ELEMENTS.length,
    'El puerto RAG de la demo debe entregar prompt y metadatos del mapa sintetico'
  );
  const slimmed = await demoPort.getSlimmedRouteContext('public-demo', '/', 1);
  check(
    slimmed.ok && slimmed.context.allowedActions.length === PUBLIC_DEMO_MAP_ELEMENTS.length,
    'El resumen de pantalla de la demo debe entregar el guion completo al motor'
  );
  check(
    slimmed.ok && slimmed.context.stepInstruction === PUBLIC_DEMO_STEP_INSTRUCTION,
    'La instruccion del paso debe ser la del guion operativo de la demostracion'
  );
}

/**
 * Verifica el despacho real sobre el mapa demo y el repositorio anulado de la visita anonima:
 * la directiva viaja con su selector validado, el motor recibe el acuse y ninguna operacion del
 * camino demo intenta escribir en PostgreSQL.
 */
async function verifyPublicDemoDispatchAndRepository(): Promise<void> {
  const providerDoubles = buildFakeProviderStream();
  const sentFrames: Buffer[] = [];
  const demoDispatch = new DispatchDomToolUseCase({
    pool: {} as never,
    sessionRepository: buildFakeSessionRepository().repository,
    ragPort: createPublicDemoRagPort(),
  });
  const executed = await demoDispatch.execute(
    buildDispatchRequest({
      routePath: '/',
      invocation: buildInvocation({ toolName: 'click_element', targetElementKey: 'btn-new-deal' }),
      providerStream: providerDoubles.stream,
      sendFrameToClient: (frame: Buffer) => sentFrames.push(frame),
      awaitClientAck: async (): Promise<ToolAckOutcome> => ({ succeeded: true, detail: null }),
    })
  );
  check(executed.executed && executed.finalStatus === 'ACK_SUCCESS', 'El guion de la demo debe ejecutarse sobre el tablero');
  const demoDirective = decodeClientFrame(sentFrames[0] as Buffer);
  check(
    demoDirective.ok && demoDirective.frame.controlBody?.['primarySelector'] === '[data-oa-id="btn-new-deal"]',
    'La directiva de la demo debe viajar con el selector validado del tablero'
  );
  check(providerDoubles.toolResults[0]?.succeeded === true, 'El motor debe recibir el exito de la accion para narrarlo');

  const demoRepository = new PublicDemoVoiceSessionRepository({} as never);
  const syntheticEvent = await demoRepository.createActionEvent({} as never, {
    organizationId: 'public-demo',
    projectId: 'public-demo',
    voiceSessionId: 'demo_sesion_prueba',
    providerToolCallId: 'call-demo-1',
    toolName: 'click_element',
    routePathAtExecution: '/',
    selectorUsed: '[data-oa-id="btn-new-deal"]',
    actionPayloadRedactedJson: { targetElementKey: 'btn-new-deal' },
  });
  check(
    syntheticEvent.id.startsWith('public-demo-action-'),
    'El repositorio anulado debe devolver un evento sintetico en memoria'
  );
  check(
    (await demoRepository.incrementToolCallsCount({} as never, 'demo_sesion_prueba')) === 0,
    'El contador de herramientas de la demo no debe intentar actualizar una fila inexistente'
  );
  let statusError: unknown = null;
  try {
    await demoRepository.updateActionEventStatus({} as never, syntheticEvent.id, 'ACK_SUCCESS', 42);
  } catch (error: unknown) {
    statusError = error;
  }
  check(statusError === null, 'La actualizacion de estado del evento sintetico no debe lanzar');
}

/** Ejecuta los dos bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE INTEGRACION DEL GUION OPERATIVO DE LA DEMOSTRACION PUBLICA');
  console.log('='.repeat(96));

  await verifyPublicDemoFunctionalMap();
  console.log('[1/2] Mapa sintetico, entrega al motor y barrera de la demo: APROBADO.');

  await verifyPublicDemoDispatchAndRepository();
  console.log('[2/2] Despacho real y repositorio anulado de la visita anonima: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
