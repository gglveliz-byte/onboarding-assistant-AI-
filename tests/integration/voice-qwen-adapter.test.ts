/**
 * @archivo tests/integration/voice-qwen-adapter.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego del Canal del Motor de Voz Alterno)
 * @proposito
 *   Certifica el ciclo de vida completo del canal contra el motor de voz alterno usando un socket
 *   falso en memoria, sin abrir ninguna conexion de red. Comprueba que la apertura configure la
 *   sesion con el prompt y la voz del proyecto, que el audio del usuario final llegue al motor byte
 *   a byte codificado como exige su protocolo textual, que la actualizacion de contexto de ruta y el
 *   resultado de herramienta se entreguen, que las tramas recibidas se enruten a sus manejadores con
 *   el aviso de habla emitido UNA sola vez por turno —emitirlo por fragmento dispararia el detector
 *   de interrupcion decenas de veces por segundo—, que la interrupcion inmediata se complete dentro
 *   del presupuesto configurado enviando sus dos tramas en el orden correcto, y que el cierre purgue
 *   siempre el audio residente en memoria, incluso cuando el socket falla.
 *
 * @resumen_contenido
 *   - Bloque `verifyAvailability()`: Disponibilidad y fallo controlado sin credenciales.
 *   - Bloque `verifyChannelLifecycle()`: Apertura, configuracion, envio y recepcion.
 *   - Bloque `verifySpeechAnnouncement()`: Aviso de habla una sola vez por turno.
 *   - Bloque `verifyClosurePaths()`: Cierre ordenado, cierre remoto inesperado y tiempo agotado.
 *   - Bloque `verifyBargeIn()`: Presupuesto de interrupcion y orden de las tramas.
 *
 * @dependencias_internas
 *   - `Qwen38OmniAdapter` (`src/modules/05-voice-realtime-gateway/infrastructure/`).
 *   - Dobles compartidos (`./support/voice-qwen-doubles.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (El socket falso sustituye a la libreria de sockets; no hay red implicada).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba en memoria: verifica que el audio jamas se persiste).
 */

import { Qwen38OmniAdapter } from '../../src/modules/05-voice-realtime-gateway/infrastructure/qwen-38-omni.adapter';
import type { IActiveProviderStream } from '../../src/shared/ports/billing-voice-admin.ports';
import {
  buildEventRecorder,
  buildOpenRequest,
  buildPcmFrame,
  check,
  countPassedAssertions,
  FakeWebSocket,
  flushEventLoop,
  VOICE_TEST_API_KEY,
  VOICE_TEST_WS_URL,
} from './support/voice-qwen-doubles';

/**
 * Abre un canal contra un socket falso ya creado.
 *
 * @param adapter - Adaptador bajo prueba.
 * @param socket - Socket falso que el adaptador usara.
 * @param recorder - Registrador de eventos del gateway.
 * @returns Resultado de la apertura.
 */
async function openChannelWithFakeSocket(
  adapter: Qwen38OmniAdapter,
  socket: FakeWebSocket,
  recorder: ReturnType<typeof buildEventRecorder>
): Promise<{ readonly ok: true; readonly stream: IActiveProviderStream } | { readonly ok: false; readonly reason: string }> {
  const openPromise = adapter.openStream(buildOpenRequest(), recorder.handlers);
  await flushEventLoop();
  socket.simulateOpen();
  const result = await openPromise;
  return result.ok ? { ok: true, stream: result.stream } : { ok: false, reason: result.reason };
}

/** Verifica la comprobacion de disponibilidad y el fallo controlado sin credenciales. */
async function verifyAvailability(): Promise<void> {
  const socket = new FakeWebSocket();
  const adapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    providerRole: 'FAILOVER',
    wsFactory: () => socket as unknown as never,
  });

  check(adapter.providerKind === 'QWEN', 'El adaptador debe declararse como motor alterno');
  check(adapter.providerRole === 'FAILOVER', 'El rol por omision del motor alterno debe ser el de respaldo');
  check(await adapter.isAvailable(), 'Con endpoint y credencial el motor debe declararse disponible');

  const withoutCredentials = new Qwen38OmniAdapter({ wsUrl: '', apiKey: 'corta' });
  check(!(await withoutCredentials.isAvailable()), 'Sin endpoint ni credencial valida el motor no debe declararse disponible');
  const failedOpen = await withoutCredentials.openStream(buildOpenRequest(), buildEventRecorder().handlers);
  check(!failedOpen.ok, 'Abrir canal sin credenciales debe fallar de forma controlada');
  check(failedOpen.ok === false && failedOpen.retryable, 'El fallo de disponibilidad debe declararse reintentable');
  check(
    failedOpen.ok === false && failedOpen.code === 'PERSISTENCE_UNAVAILABLE',
    'El fallo debe usar el codigo normalizado del contrato del nucleo'
  );
}

/** Verifica la apertura, la configuracion y el intercambio de tramas del canal. */
async function verifyChannelLifecycle(): Promise<void> {
  const socket = new FakeWebSocket();
  const adapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    modelName: 'modelo-alterno',
    wsFactory: () => socket as unknown as never,
  });
  const recorder = buildEventRecorder();

  const openResult = await openChannelWithFakeSocket(adapter, socket, recorder);
  check(openResult.ok, 'Con un socket sano el canal debe abrirse');
  if (!openResult.ok) {
    return;
  }

  const stream = openResult.stream;
  check(stream.providerKind === 'QWEN', 'El canal debe declarar el motor alterno');
  check(stream.streamId.startsWith('qwen_stream_'), 'El identificador del canal debe ser trazable a su motor');
  check(stream.openedAtIso.length > 0, 'El canal debe registrar su instante de apertura');

  check(socket.sentFrames.length === 1, 'La apertura debe enviar exactamente la trama de configuracion');
  const setupFrame = JSON.parse(socket.sentFrames[0] as string) as Record<string, unknown>;
  check(setupFrame['type'] === 'session.update', 'La primera trama debe configurar la sesion');
  const setupSession = setupFrame['session'] as Record<string, unknown>;
  check(setupSession['model'] === 'modelo-alterno', 'El modelo configurado debe propagarse');
  check(setupSession['voice'] === 'aura-es-neutral', 'La persona de voz del proyecto debe propagarse');
  check(
    typeof setupSession['instructions'] === 'string' && (setupSession['instructions'] as string).includes('onboarding'),
    'El prompt del proyecto debe viajar en la configuracion de sesion'
  );

  const audioFrame = buildPcmFrame(16384, 320);
  stream.sendAudioFrame(audioFrame);
  check(socket.sentFrames.length === 2, 'El audio debe enviarse al motor');
  const audioAppend = JSON.parse(socket.sentFrames[1] as string) as Record<string, unknown>;
  check(audioAppend['type'] === 'input_audio_buffer.append', 'El audio debe usar la trama de append del protocolo');
  check(
    Buffer.from(audioAppend['audio'] as string, 'base64').equals(audioFrame),
    'El audio debe llegar al motor byte a byte, sin perdida ni reordenacion'
  );

  const streamInspector = stream as unknown as {
    readonly getRingBufferStatistics: () => { readonly framesWritten: number; readonly bufferedBytes: number };
  };
  check(
    streamInspector.getRingBufferStatistics().framesWritten === 1,
    'El audio enviado debe registrarse en el buffer volatil para el analisis de voz'
  );

  const routeDelivered = (stream as unknown as { updateDynamicRouteContext: (route: string, summary: string) => boolean })
    .updateDynamicRouteContext('/panel/inicio', 'boton_empezar');
  check(routeDelivered, 'La actualizacion de contexto de ruta debe entregarse al motor');
  check((socket.sentFrames[2] as string).includes('/panel/inicio'), 'La ruta debe viajar en la trama de contexto');

  stream.sendToolResult('call-20', true, { clicked: true });
  check((socket.sentFrames[3] as string).includes('call-20'), 'El resultado de herramienta debe referenciar su llamada');

  socket.simulateMessage(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Claro,' }));
  check(recorder.transcripts.length === 1, 'La transcripcion del motor debe reenviarse');
  check(recorder.transcripts[0]?.isFinal === false, 'La transcripcion parcial debe conservarse como parcial');

  socket.simulateMessage(
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call-21',
      name: 'type_text',
      arguments: JSON.stringify({ elementKey: 'input_nombre', text: 'Ana' }),
    })
  );
  check(recorder.toolInvocations.length === 1, 'La invocacion de herramienta debe reenviarse al gateway');
  check(recorder.toolInvocations[0]?.toolName === 'type_text', 'La herramienta invocada debe conservarse');
  check(recorder.toolInvocations[0]?.textPayload === 'Ana', 'El texto a escribir debe conservarse intacto');

  socket.simulateMessage(JSON.stringify({ type: 'tipo.desconocido' }));
  check(recorder.errors.length === 0, 'Una trama desconocida no debe reportarse como error del motor');

  socket.simulateError('Corte de red simulado');
  check(recorder.errors.length === 1, 'Un fallo del socket debe reportarse al gateway para habilitar el failover');
  check(recorder.errors[0] === 'Corte de red simulado', 'El motivo del fallo debe propagarse literalmente');
}

/** Verifica que el aviso de habla se emita una sola vez por turno. */
async function verifySpeechAnnouncement(): Promise<void> {
  const socket = new FakeWebSocket();
  const adapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    wsFactory: () => socket as unknown as never,
  });
  const recorder = buildEventRecorder();

  const openResult = await openChannelWithFakeSocket(adapter, socket, recorder);
  check(openResult.ok, 'El canal debe abrirse para probar el aviso de habla');
  if (!openResult.ok) {
    return;
  }

  socket.simulateMessage(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([5, 5, 5, 5]).toString('base64') }));
  check(recorder.audioFrames.length === 1, 'El audio del motor debe reenviarse al manejador del gateway');
  check(recorder.speechStartedCount === 1, 'El primer audio del motor debe anunciar que el asistente habla');

  socket.simulateMessage(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([6, 6, 6, 6]).toString('base64') }));
  check(recorder.audioFrames.length === 2, 'El segundo fragmento de audio tambien debe reenviarse');
  check(
    recorder.speechStartedCount === 1,
    'Un segundo fragmento mientras el asistente ya habla no debe reanunciar el habla: el detector de interrupcion se dispararia en falso'
  );

  socket.simulateMessage(JSON.stringify({ type: 'response.done' }));
  socket.simulateMessage(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([7, 7, 7, 7]).toString('base64') }));
  check(recorder.speechStartedCount === 2, 'Tras cerrarse el turno, un audio nuevo si debe anunciar el habla de nuevo');

  socket.simulateMessage(JSON.stringify({ type: 'response.cancelled' }));
  socket.simulateMessage(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([8, 8, 8, 8]).toString('base64') }));
  check(recorder.speechStartedCount === 3, 'Una interrupcion tambien reinicia el turno y el siguiente audio debe reanunciarse');
}

/** Verifica los tres caminos de cierre del canal. */
async function verifyClosurePaths(): Promise<void> {
  const orderedSocket = new FakeWebSocket();
  const orderedAdapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    wsFactory: () => orderedSocket as unknown as never,
  });
  const orderedRecorder = buildEventRecorder();
  const orderedOpen = await openChannelWithFakeSocket(orderedAdapter, orderedSocket, orderedRecorder);
  check(orderedOpen.ok, 'El canal debe abrirse antes de probar el cierre ordenado');
  if (orderedOpen.ok) {
    orderedOpen.stream.sendAudioFrame(buildPcmFrame(16384, 320));
    const framesBeforeClose = orderedSocket.sentFrames.length;
    await orderedOpen.stream.close('COMPLETED_NORMAL');

    check(orderedRecorder.closedStatuses.length === 1, 'El cierre debe notificarse exactamente una vez');
    check(orderedRecorder.closedStatuses[0] === 'COMPLETED_NORMAL', 'El estado final debe propagarse al gateway');
    check(orderedSocket.lastCloseReason.startsWith('1000:'), 'El cierre ordenado debe usar el codigo 1000 del estandar');
    check(
      (orderedOpen.stream as unknown as { getRingBufferStatistics: () => { readonly bufferedBytes: number } })
        .getRingBufferStatistics().bufferedBytes === 0,
      'Al cerrar el canal el audio residente en memoria debe quedar purgado'
    );

    orderedOpen.stream.sendAudioFrame(buildPcmFrame(1000, 320));
    check(orderedSocket.sentFrames.length === framesBeforeClose, 'Tras cerrar el canal no debe enviarse ninguna trama adicional');
    check(
      (orderedOpen.stream as unknown as { getRingBufferStatistics: () => { readonly bufferedBytes: number } })
        .getRingBufferStatistics().bufferedBytes === 0,
      'Un envio posterior al cierre no debe rellenar el buffer ya purgado'
    );

    await orderedOpen.stream.close('COMPLETED_NORMAL');
    check(orderedRecorder.closedStatuses.length === 1, 'Un segundo cierre no debe volver a notificarse');
  }

  const remoteSocket = new FakeWebSocket();
  const remoteAdapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    wsFactory: () => remoteSocket as unknown as never,
  });
  const remoteRecorder = buildEventRecorder();
  const remoteOpen = await openChannelWithFakeSocket(remoteAdapter, remoteSocket, remoteRecorder);
  check(remoteOpen.ok, 'El canal debe abrirse antes de simular el cierre remoto');
  if (remoteOpen.ok) {
    remoteOpen.stream.sendAudioFrame(buildPcmFrame(16384, 320));
    remoteSocket.simulateRemoteClose();
    check(remoteRecorder.errors.length === 1, 'Un cierre inesperado del motor debe reportarse como error para el failover');
    check(
      remoteRecorder.closedStatuses[0] === 'FAILED_PROVIDER_ERROR',
      'Un cierre inesperado debe declararse como fallo del proveedor, no como cierre normal'
    );
    check(
      (remoteOpen.stream as unknown as { getRingBufferStatistics: () => { readonly bufferedBytes: number } })
        .getRingBufferStatistics().bufferedBytes === 0,
      'Un cierre inesperado tambien debe purgar el audio residente en memoria'
    );
  }

  const timeoutSocket = new FakeWebSocket();
  const timeoutAdapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    connectTimeoutMs: 20,
    wsFactory: () => timeoutSocket as unknown as never,
  });
  const timeoutResult = await timeoutAdapter.openStream(buildOpenRequest(), buildEventRecorder().handlers);
  check(!timeoutResult.ok, 'Si el socket nunca abre, la apertura debe fallar dentro del presupuesto de tiempo');
  check(timeoutSocket.wasTerminated, 'El socket que no abrio debe terminarse para no dejar recursos colgados');
  check(
    timeoutResult.ok === false && timeoutResult.reason.includes('Tiempo de conexion agotado'),
    'El fallo por tiempo agotado debe explicarse en el motivo'
  );
}

/** Verifica el presupuesto y el orden de la interrupcion inmediata. */
async function verifyBargeIn(): Promise<void> {
  const socket = new FakeWebSocket();
  const adapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    bargeInBudgetMs: 50,
    wsFactory: () => socket as unknown as never,
  });
  const recorder = buildEventRecorder();

  const openResult = await openChannelWithFakeSocket(adapter, socket, recorder);
  check(openResult.ok, 'El canal debe abrirse para poder probar la interrupcion');
  if (!openResult.ok) {
    return;
  }

  const stream = openResult.stream as unknown as {
    requestBargeIn: () => void;
    getLastBargeInReport: () => {
      readonly withinBudget: boolean;
      readonly elapsedMs: number;
      readonly budgetMs: number;
      readonly delivered: boolean;
    } | null;
  };

  check(stream.getLastBargeInReport() === null, 'Sin interrupciones previas no debe haber reporte de latencia');

  const framesBeforeBargeIn = socket.sentFrames.length;
  stream.requestBargeIn();

  const report = stream.getLastBargeInReport();
  check(report !== null, 'Tras interrumpir debe existir un reporte de latencia');
  check(report?.delivered === true, 'La interrupcion debe declararse entregada con el canal abierto');
  check(report?.budgetMs === 50, 'El presupuesto de interrupcion debe ser el configurado');
  check(
    report !== null && report.elapsedMs < report.budgetMs,
    `La interrupcion debe completarse dentro del presupuesto de 50 ms (obtenido: ${String(report?.elapsedMs)} ms)`
  );
  check(report?.withinBudget === true, 'La interrupcion debe declararse dentro del presupuesto');

  const bargeInFrames = socket.sentFrames.slice(framesBeforeBargeIn);
  check(bargeInFrames.length === 2, `La interrupcion debe enviar exactamente dos tramas (obtenido: ${bargeInFrames.length})`);
  check(
    (JSON.parse(bargeInFrames[0] as string) as Record<string, unknown>)['type'] === 'response.cancel',
    'La primera trama enviada debe cancelar la respuesta en curso'
  );
  check(
    (JSON.parse(bargeInFrames[1] as string) as Record<string, unknown>)['type'] === 'output_audio_buffer.clear',
    'La segunda trama debe vaciar el buffer de salida para que el audio ya generado deje de sonar'
  );

  const closedSocket = new FakeWebSocket();
  const closedAdapter = new Qwen38OmniAdapter({
    wsUrl: VOICE_TEST_WS_URL,
    apiKey: VOICE_TEST_API_KEY,
    wsFactory: () => closedSocket as unknown as never,
  });
  const closedOpen = await openChannelWithFakeSocket(closedAdapter, closedSocket, buildEventRecorder());
  check(closedOpen.ok, 'El canal de la segunda prueba debe abrirse');
  if (closedOpen.ok) {
    await closedOpen.stream.close('COMPLETED_NORMAL');
    const closedStream = closedOpen.stream as unknown as {
      requestBargeIn: () => void;
      getLastBargeInReport: () => { readonly delivered: boolean; readonly withinBudget: boolean } | null;
    };
    closedStream.requestBargeIn();
    check(
      closedStream.getLastBargeInReport()?.delivered === false,
      'Interrumpir un canal ya cerrado no debe declararse entregado ni lanzar una excepcion'
    );
  }
}

/** Ejecuta los cinco bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL CANAL DEL MOTOR DE VOZ ALTERNO (PARTE 11)');
  console.log('='.repeat(96));

  await verifyAvailability();
  console.log('[1/5] Disponibilidad del motor y fallo controlado sin credenciales: APROBADO.');

  await verifyChannelLifecycle();
  console.log('[2/5] Apertura, configuracion, audio, contexto de ruta y recepcion: APROBADO.');

  await verifySpeechAnnouncement();
  console.log('[3/5] Aviso de habla una sola vez por turno: APROBADO.');

  await verifyClosurePaths();
  console.log('[4/5] Cierre ordenado, cierre remoto inesperado y tiempo agotado: APROBADO.');

  await verifyBargeIn();
  console.log('[5/5] Interrupcion inmediata dentro del presupuesto y orden de tramas: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
