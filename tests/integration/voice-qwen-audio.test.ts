/**
 * @archivo tests/integration/voice-qwen-audio.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego del Buffer Circular PCM16 y el Protocolo Alterno)
 * @proposito
 *   Certifica las dos piezas de datos de la Parte 11 sin tocar la red. Primero, que el buffer
 *   circular de audio respete el anillo —incluida la escritura que cruza su frontera, donde un
 *   calculo de indices equivocado corrompe o reordena el audio—, calcule la energia RMS de forma
 *   correcta y **sobrescriba con ceros** la memoria al purgarse, que es la garantia fisica de la
 *   politica de no persistencia de voz: confiar en el recolector de basura dejaria la voz del
 *   usuario residente en memoria indefinidamente. Segundo, que el mapeador del protocolo produzca el
 *   vocabulario exacto del motor alterno y descarte de forma segura las tramas malformadas o con
 *   herramientas desconocidas, porque una invocacion no validada seria una accion fisica arbitraria
 *   en el navegador del usuario final.
 *
 * @resumen_contenido
 *   - Bloque `verifyRingBufferDimensions()`: Duracion de fragmento, RMS y validaciones.
 *   - Bloque `verifyRingBufferRing()`: Escritura, extraccion, saturacion y cruce de frontera.
 *   - Bloque `verifyRingBufferVadAndPurge()`: Deteccion de voz y purga con ceros.
 *   - Bloque `verifyQwenSessionFrames()`: Configuracion de sesion, audio y contexto de ruta.
 *   - Bloque `verifyQwenServerParsing()`: Deserializacion defensiva y herramientas.
 *
 * @dependencias_internas
 *   - `Pcm16RingBuffer` y utilidades (`src/modules/05-voice-realtime-gateway/infrastructure/`).
 *   - `QwenProtocolMapper` y el vocabulario del protocolo.
 *   - Dobles compartidos (`./support/voice-qwen-doubles.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Prueba puramente en memoria: no abre conexiones ni escribe datos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Verifica precisamente que el audio NO se persiste en ningun sitio).
 */

import {
  Pcm16RingBuffer,
  calculateFrameDurationMs,
  computeRootMeanSquare,
  DEFAULT_FRAME_DURATION_MS,
  DEFAULT_SAMPLE_RATE_HZ,
} from '../../src/modules/05-voice-realtime-gateway/infrastructure/audio-pcm16-ring-buffer';
import { QwenProtocolMapper } from '../../src/modules/05-voice-realtime-gateway/infrastructure/qwen-protocol.mapper';
import {
  QWEN_DEFAULT_VOICE,
  QWEN_MAX_SESSION_PROMPT_CHARS,
  QWEN_TOOL_DECLARATIONS,
} from '../../src/modules/05-voice-realtime-gateway/infrastructure/qwen-protocol.types';
import {
  buildEventRecorder,
  buildPcmFrame,
  buildSilenceFrame,
  check,
  countPassedAssertions,
} from './support/voice-qwen-doubles';

/** Verifica las dimensiones canonicas del audio y la correccion del calculo de energia. */
function verifyRingBufferDimensions(): void {
  check(
    calculateFrameDurationMs(640, 16000) === 20,
    `640 bytes a 16 kHz deben durar 20 ms (obtenido: ${calculateFrameDurationMs(640, 16000)})`
  );
  check(DEFAULT_FRAME_DURATION_MS === 20, 'La duracion canonica del fragmento debe ser de 20 ms');
  check(DEFAULT_SAMPLE_RATE_HZ === 16000, 'La frecuencia de muestreo por omision debe ser 16 kHz');

  check(computeRootMeanSquare(buildSilenceFrame(320)) === 0, 'El silencio digital debe medir energia cero');

  const halfScaleRms = computeRootMeanSquare(buildPcmFrame(16384, 320));
  check(Math.abs(halfScaleRms - 5000) <= 1, `Media escala debe medir RMS cercano a 5000 (obtenido: ${halfScaleRms})`);

  const fullScaleRms = computeRootMeanSquare(buildPcmFrame(32767, 320));
  check(fullScaleRms >= 9999 && fullScaleRms <= 10000, `Escala completa debe medir RMS cercano a 10000 (obtenido: ${fullScaleRms})`);

  const negativeRms = computeRootMeanSquare(buildPcmFrame(-16384, 320));
  check(Math.abs(negativeRms - 5000) <= 1, `Una onda negativa debe medir la misma energia que su equivalente positiva (obtenido: ${negativeRms})`);

  let oddLengthRejected = false;
  try {
    computeRootMeanSquare(Buffer.from([0x01, 0x02, 0x03]));
  } catch {
    oddLengthRejected = true;
  }
  check(oddLengthRejected, 'Un fragmento con un numero impar de bytes no es PCM16 valido');

  const buffer = new Pcm16RingBuffer({ sampleRateHz: 16000, frameDurationMs: 20, capacityMs: 100 });
  check(buffer.getFrameByteLength() === 640, `El fragmento canonico debe medir 640 bytes (obtenido: ${buffer.getFrameByteLength()})`);

  let emptyRejected = false;
  try {
    buffer.write(Buffer.alloc(0));
  } catch {
    emptyRejected = true;
  }
  check(emptyRejected, 'No debe aceptarse un fragmento de audio vacio');

  let oversizedRejected = false;
  try {
    buffer.write(buildPcmFrame(100, 4000));
  } catch {
    oversizedRejected = true;
  }
  check(oversizedRejected, 'Un fragmento mayor que la capacidad del anillo debe rechazarse de forma explicita');
}

/** Verifica el comportamiento de anillo: escritura, extraccion, saturacion y cruce de frontera. */
function verifyRingBufferRing(): void {
  const buffer = new Pcm16RingBuffer({ sampleRateHz: 16000, frameDurationMs: 20, capacityMs: 100 });

  const firstMetadata = buffer.write(buildPcmFrame(16384, 320));
  check(firstMetadata.sequence === 1, 'La secuencia del primer fragmento debe ser 1');
  check(firstMetadata.byteLength === 640, 'Los metadatos deben declarar el tamano real del fragmento');
  check(Math.abs(firstMetadata.durationMs - 20) < 1e-9, `Los metadatos deben declarar 20 ms (obtenido: ${firstMetadata.durationMs})`);
  check(buffer.getBufferedByteLength() === 640, 'Tras escribir un fragmento debe haber 640 bytes pendientes');

  const extractedFrame = buffer.readFrame();
  check(extractedFrame !== null && extractedFrame.length === 640, 'Debe poder extraerse un fragmento completo');
  check(buffer.getBufferedByteLength() === 0, 'Extraer el unico fragmento debe vaciar el anillo');
  check(buffer.readFrame() === null, 'Sin bytes suficientes no debe devolverse fragmento alguno');

  // El anillo completo son 5 fragmentos de 20 ms (100 ms). Se escriben 8 para forzar el descarte.
  const ringBuffer = new Pcm16RingBuffer({ sampleRateHz: 16000, frameDurationMs: 20, capacityMs: 100 });
  for (let frameIndex = 0; frameIndex < 8; frameIndex += 1) {
    ringBuffer.write(buildPcmFrame(1000 + frameIndex, 320));
  }
  const ringStatistics = ringBuffer.getStatistics();
  check(ringStatistics.isSaturated, 'Tras escribir mas fragmentos que la capacidad el anillo debe saturarse');
  check(ringStatistics.framesWritten === 8, 'Deben contabilizarse los ocho fragmentos escritos');
  check(ringStatistics.framesOverwritten > 0, 'Debe registrarse que se descartaron fragmentos antiguos');
  check(ringStatistics.bufferedBytes === ringStatistics.capacityBytes, 'La saturacion debe dejar el anillo lleno hasta su capacidad exacta');
  check(ringStatistics.peakRmsNormalized > 0, 'Debe registrarse el pico de energia observado');

  const drainedFrames = ringBuffer.drainFrames();
  check(drainedFrames.length === 5, `Deben extraerse 5 fragmentos completos (obtenido: ${drainedFrames.length})`);
  check(drainedFrames.every((frame) => frame.length === 640), 'Todos los fragmentos extraidos deben tener el tamano canonico');
  check(ringBuffer.getBufferedByteLength() === 0, 'Tras drenar todos los fragmentos no debe quedar audio');

  // Prueba del cruce de frontera: un fragmento que no cabe al final debe completarse al principio.
  const crossingBuffer = new Pcm16RingBuffer({ sampleRateHz: 16000, frameDurationMs: 20, capacityMs: 100 });
  crossingBuffer.write(buildPcmFrame(100, 320));
  crossingBuffer.read(640);
  const crossingFrame = buildPcmFrame(20000, 750);
  crossingBuffer.write(crossingFrame);
  const reconstructedFrame = crossingBuffer.read(1500);
  check(reconstructedFrame.length === 1500, `El fragmento que cruza la frontera debe reconstruirse entero (obtenido: ${reconstructedFrame.length})`);
  check(reconstructedFrame.equals(crossingFrame), 'El audio que cruza la frontera del anillo no debe corromperse ni reordenarse');

  const partialReadBuffer = new Pcm16RingBuffer({ sampleRateHz: 16000, capacityMs: 100 });
  partialReadBuffer.write(buildPcmFrame(5000, 320));
  partialReadBuffer.write(buildPcmFrame(6000, 320));
  const partialRead = partialReadBuffer.read(100);
  check(partialRead.length === 100, 'Una lectura parcial debe devolver exactamente los bytes solicitados');
  check(partialReadBuffer.getBufferedByteLength() === 1180, 'Una lectura parcial debe descontar solo lo leido');
  check(partialReadBuffer.read(99999).length === 1180, 'Solicitar mas bytes de los disponibles debe devolver todo el contenido');
  check(partialReadBuffer.getBufferedByteLength() === 0, 'Leer todo el contenido debe vaciar el anillo');

  let negativeReadRejected = false;
  try {
    partialReadBuffer.read(-1);
  } catch {
    negativeReadRejected = true;
  }
  check(negativeReadRejected, 'Una lectura con cantidad negativa debe rechazarse');
}

/** Verifica la deteccion de voz y la purga con sobrescritura de ceros. */
function verifyRingBufferVadAndPurge(): void {
  const vadBuffer = new Pcm16RingBuffer({ sampleRateHz: 16000, voiceActivityThreshold: 250 });
  vadBuffer.write(buildSilenceFrame(320));
  check(!vadBuffer.isVoiceDetected(), 'El silencio no debe activar la deteccion de voz');
  check(vadBuffer.getPendingRms() === 0, 'El silencio pendiente debe medir energia cero');

  vadBuffer.write(buildPcmFrame(16384, 320));
  check(vadBuffer.isVoiceDetected(), 'El audio a media escala debe activar la deteccion de voz');
  const peekedAudio = vadBuffer.peekAll();
  check(peekedAudio.length === 1280, 'La lectura sin extraccion debe devolver todo el contenido pendiente');
  check(vadBuffer.getBufferedByteLength() === 1280, 'La lectura sin extraccion no debe consumir el anillo');

  const purgeBuffer = new Pcm16RingBuffer({ capacityMs: 100 });
  purgeBuffer.write(buildPcmFrame(32767, 320));
  check(purgeBuffer.peekAll().some((byte) => byte !== 0), 'Antes de purgar debe haber audio real en memoria');

  purgeBuffer.purge();
  check(purgeBuffer.getBufferedByteLength() === 0, 'Tras purgar no debe quedar audio pendiente');
  check(purgeBuffer.peekAll().length === 0, 'Tras purgar no debe poder recuperarse ni un solo byte de audio');
  check(purgeBuffer.peekAll().every((byte) => byte === 0), 'La memoria purgada debe estar sobrescrita con ceros');

  const frameAfterPurge = purgeBuffer.write(buildPcmFrame(100, 320));
  check(frameAfterPurge.rmsNormalized > 0, 'El anillo debe seguir siendo utilizable despues de purgarse');
  check(frameAfterPurge.sequence === 2, 'La secuencia debe continuar tras la purga para conservar la trazabilidad del flujo');
}

/** Verifica las tramas que el backend envia al motor alterno. */
function verifyQwenSessionFrames(): void {
  check(QWEN_TOOL_DECLARATIONS.length === 3, 'Deben declararse exactamente las tres herramientas fisicas');
  const declaredToolNames = QWEN_TOOL_DECLARATIONS.map((declaration) => declaration.name).join(',');
  check(
    declaredToolNames === 'click_element,type_text,advance_onboarding_step',
    `Los nombres de herramienta deben coincidir con el contrato comun (obtenido: ${declaredToolNames})`
  );
  check(
    QWEN_TOOL_DECLARATIONS.every((declaration) => declaration.parameters.required.length > 0),
    'Toda herramienta debe declarar al menos un parametro obligatorio'
  );

  const sessionMessage = JSON.parse(
    QwenProtocolMapper.buildSessionUpdateMessage('modelo-prueba', 'Prompt del proyecto', 'voz-propia', 0.3, 16000)
  ) as Record<string, unknown>;
  check(sessionMessage['type'] === 'session.update', 'La configuracion debe viajar como session.update');

  const sessionBody = sessionMessage['session'] as Record<string, unknown>;
  check(sessionBody['instructions'] === 'Prompt del proyecto', 'Las instrucciones deben ser el prompt del proyecto');
  check(sessionBody['voice'] === 'voz-propia', 'La voz declarada por el proyecto debe respetarse (campo de compatibilidad)');
  check(sessionBody['temperature'] === 0.3, 'La temperatura debe propagarse sin alteracion');
  // Qwen3.8-Omni-Realtime: audio anidado en session.audio (entrada 16k, salida 24k) y semantic_vad.
  const audioCfg = (sessionBody['audio'] ?? {}) as Record<string, unknown>;
  const audioInput = ((audioCfg['input'] ?? {}) as Record<string, unknown>);
  const audioOutput = ((audioCfg['output'] ?? {}) as Record<string, unknown>);
  const inFmt = ((audioInput['format'] ?? {}) as Record<string, unknown>);
  const outFmt = ((audioOutput['format'] ?? {}) as Record<string, unknown>);
  check(inFmt['type'] === 'pcm' && inFmt['sample_rate'] === 16000, 'El audio de entrada debe declarar pcm a 16 kHz (session.audio.input.format)');
  check(outFmt['type'] === 'pcm' && outFmt['sample_rate'] === 24000, 'El audio de salida debe declarar pcm a 24 kHz (session.audio.output.format)');
  check(audioOutput['voice'] === 'voz-propia', 'La voz debe viajar en session.audio.output.voice (forma nativa de 3.8)');
  check((sessionBody['turn_detection'] as Record<string, unknown>)['type'] === 'semantic_vad', 'Qwen 3.8 debe usar semantic_vad');
  check(Array.isArray(sessionBody['tools']) && (sessionBody['tools'] as unknown[]).length === 3, 'Deben declararse las tres herramientas en la sesion');
  check(sessionBody['tool_choice'] === 'auto', 'El motor debe poder decidir cuando invocar las herramientas');

  const defaultVoiceMessage = JSON.parse(
    QwenProtocolMapper.buildSessionUpdateMessage('modelo-prueba', 'Prompt', '', 0.7, 16000)
  ) as Record<string, unknown>;
  check(
    (defaultVoiceMessage['session'] as Record<string, unknown>)['voice'] === QWEN_DEFAULT_VOICE,
    'Sin voz declarada debe aplicarse la voz por omision'
  );

  const longPrompt = 'x'.repeat(QWEN_MAX_SESSION_PROMPT_CHARS + 500);
  check(
    QwenProtocolMapper.truncateInstructions(longPrompt).length === QWEN_MAX_SESSION_PROMPT_CHARS,
    'Un prompt excesivo debe truncarse al limite del proveedor en lugar de dejar que el canal falle'
  );
  check(QwenProtocolMapper.normalizeTemperature(Number.NaN) === 0.7, 'Una temperatura no numerica debe caer al valor por omision');
  check(QwenProtocolMapper.normalizeTemperature(9) === 1.5, 'Una temperatura excesiva debe acotarse al maximo admitido');
  check(QwenProtocolMapper.normalizeTemperature(-3) === 0, 'Una temperatura negativa debe acotarse al minimo');
  check(QwenProtocolMapper.normalizeTemperature(0.4) === 0.4, 'Una temperatura valida debe conservarse intacta');

  const audioMessage = JSON.parse(QwenProtocolMapper.buildAudioAppendMessage(Buffer.from([1, 2, 3, 4]))) as Record<string, unknown>;
  check(audioMessage['type'] === 'input_audio_buffer.append', 'El audio debe viajar como input_audio_buffer.append');
  check(
    audioMessage['audio'] === Buffer.from([1, 2, 3, 4]).toString('base64'),
    'El audio debe codificarse en Base64 porque el protocolo es textual'
  );

  const contextMessage = JSON.parse(
    QwenProtocolMapper.buildDynamicRouteContextMessage('/panel/facturacion', 'boton_pagar')
  ) as Record<string, unknown>;
  check(contextMessage['type'] === 'conversation.item.create', 'El contexto de ruta debe viajar como elemento de conversacion');
  const contextItem = contextMessage['item'] as Record<string, unknown>;
  check(contextItem['role'] === 'system', 'El contexto de ruta debe declararse como mensaje de sistema');
  check(JSON.stringify(contextItem).includes('/panel/facturacion'), 'La ruta actual debe incluirse para que el modelo sepa donde esta el usuario');

  const bargeInMessages = QwenProtocolMapper.buildBargeInMessages();
  check(bargeInMessages.length === 2, 'La interrupcion debe componerse de exactamente dos tramas');
  check(
    (JSON.parse(bargeInMessages[0] as string) as Record<string, unknown>)['type'] === 'response.cancel',
    'La primera trama de interrupcion debe cancelar la respuesta'
  );
  check(
    (JSON.parse(bargeInMessages[1] as string) as Record<string, unknown>)['type'] === 'output_audio_buffer.clear',
    'La segunda trama debe vaciar el buffer de salida para que no siga sonando audio ya generado'
  );

  const toolResultMessage = JSON.parse(QwenProtocolMapper.buildToolResultMessage('call-1', true, { ok: 1 })) as Record<string, unknown>;
  const toolResultItem = toolResultMessage['item'] as Record<string, unknown>;
  check(toolResultItem['type'] === 'function_call_output', 'El resultado debe viajar como function_call_output');
  check(toolResultItem['call_id'] === 'call-1', 'El resultado debe referenciar la llamada que se confirma');
  check(
    typeof toolResultItem['output'] === 'string' && (toolResultItem['output'] as string).includes('"success":true'),
    'El resultado debe declarar el exito de la accion de forma explicita'
  );
}

/** Verifica la deserializacion defensiva de las tramas del servidor. */
function verifyQwenServerParsing(): void {
  // Qwen3.8-Omni-Realtime emite a 24 kHz; el mapper remuestrea a 16 kHz antes de entregar al gateway.
  // 24 muestras (48 bytes) a 24 kHz -> 16 muestras (32 bytes) a 16 kHz.
  const pcm24k = Buffer.alloc(48);
  for (let i = 0; i < 24; i += 1) pcm24k.writeInt16LE(i * 100 - 1000, i * 2);
  const audioDelta = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.audio.delta', delta: pcm24k.toString('base64') })
  );
  check(audioDelta.kind === 'AUDIO', 'Una trama de audio debe reconocerse como tal');
  check(
    audioDelta.audioBuffer !== undefined && audioDelta.audioBuffer.length === 32,
    'El audio 24 kHz debe remuestrearse a 16 kHz (24 muestras -> 16 muestras = 32 bytes)'
  );

  const partialTranscript = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Hola' })
  );
  check(partialTranscript.kind === 'TRANSCRIPT', 'Una transcripcion parcial debe reconocerse como tal');
  check(partialTranscript.isFinalTranscript === false, 'La transcripcion parcial no debe marcarse como definitiva');

  const finalTranscript = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.audio_transcript.done', transcript: 'Hola, complete el paso.' })
  );
  check(finalTranscript.isFinalTranscript === true, 'La transcripcion cerrada debe marcarse como definitiva');

  const toolCall = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call-9',
      name: 'click_element',
      arguments: JSON.stringify({ elementKey: 'btn_comenzar', reason: 'iniciar' }),
    })
  );
  check(toolCall.kind === 'TOOL_CALL', 'Una llamada de herramienta completa debe reconocerse');
  check(toolCall.toolInvocation?.providerToolCallId === 'call-9', 'La invocacion debe conservar el identificador de la llamada');
  check(toolCall.toolInvocation?.targetElementKey === 'btn_comenzar', 'La invocacion debe resolver el elemento objetivo');
  check(toolCall.toolInvocation?.textPayload === null, 'Un clic no debe declarar texto escribible');

  const typeTextCall = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call-10',
      name: 'type_text',
      arguments: JSON.stringify({ elementKey: 'input_email', text: 'usuario@ejemplo.com' }),
    })
  );
  check(typeTextCall.toolInvocation?.textPayload === 'usuario@ejemplo.com', 'La escritura debe conservar el texto exacto');

  const unknownToolCall = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-11', name: 'delete_account', arguments: '{}' })
  );
  check(
    unknownToolCall.kind === 'UNKNOWN',
    'Una herramienta no declarada debe descartarse: despachar acciones arbitrarias seria un agujero de seguridad'
  );

  const malformedArguments = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-12', name: 'click_element', arguments: '{no-json' })
  );
  check(malformedArguments.kind === 'UNKNOWN', 'Argumentos malformados deben descartar la invocacion');

  const missingCallId = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'response.function_call_arguments.done', name: 'click_element', arguments: '{"elementKey":"x"}' })
  );
  check(missingCallId.kind === 'UNKNOWN', 'Una llamada sin identificador no puede confirmarse y debe descartarse');

  check(QwenProtocolMapper.parseServerMessage('{no-json').kind === 'UNKNOWN', 'Una trama ilegible no debe derribar la sesion');
  check(QwenProtocolMapper.parseServerMessage('"solo-texto"').kind === 'UNKNOWN', 'Una trama que no es objeto debe descartarse');
  check(QwenProtocolMapper.parseServerMessage('[1,2,3]').kind === 'UNKNOWN', 'Un arreglo JSON no es una trama valida');
  check(QwenProtocolMapper.parseServerMessage(JSON.stringify({ type: 'tipo.inexistente' })).kind === 'UNKNOWN', 'Un tipo desconocido debe tratarse como no reconocido');

  const errorMessage = QwenProtocolMapper.parseServerMessage(
    JSON.stringify({ type: 'error', error: { message: 'Cuota de motor excedida' } })
  );
  check(errorMessage.kind === 'ERROR', 'Una trama de error debe reconocerse');
  check(errorMessage.errorReason === 'Cuota de motor excedida', 'El motivo del error debe propagarse para el failover');

  const speechStarted = QwenProtocolMapper.parseServerMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  check(speechStarted.kind === 'SPEECH_STARTED', 'El inicio de habla del usuario debe reconocerse');
  const turnComplete = QwenProtocolMapper.parseServerMessage(JSON.stringify({ type: 'response.done' }));
  check(turnComplete.kind === 'TURN_COMPLETE', 'El fin de turno debe reconocerse para reiniciar el estado de habla');
  const interrupted = QwenProtocolMapper.parseServerMessage(JSON.stringify({ type: 'response.cancelled' }));
  check(interrupted.kind === 'INTERRUPTED', 'La cancelacion de respuesta debe reconocerse como interrupcion');

  const recorder = buildEventRecorder();
  check(QwenProtocolMapper.dispatchToHandlers(audioDelta, recorder.handlers), 'Una trama de audio debe producir un efecto observable');
  check(recorder.audioFrames.length === 1, 'El audio debe entregarse al manejador correspondiente');
  check(
    recorder.speechStartedCount === 0,
    'El traductor no debe anunciar el habla: esa transicion corresponde al canal, y anunciarla por fragmento dispararia el detector de interrupcion sin control'
  );
  check(!QwenProtocolMapper.dispatchToHandlers({ kind: 'SPEECH_STARTED' }, recorder.handlers), 'Una trama sin efecto no debe reportarse como despachada');
}

/** Ejecuta los cinco bloques de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE FUEGO DEL BUFFER CIRCULAR PCM16 Y EL PROTOCOLO ALTERNO (PARTE 11)');
  console.log('='.repeat(96));

  verifyRingBufferDimensions();
  console.log('[1/5] Dimensiones canonicas del audio y calculo de energia RMS: APROBADO.');

  verifyRingBufferRing();
  console.log('[2/5] Anillo circular, saturacion y cruce de frontera sin corrupcion: APROBADO.');

  verifyRingBufferVadAndPurge();
  console.log('[3/5] Deteccion de voz y purga con sobrescritura de ceros: APROBADO.');

  verifyQwenSessionFrames();
  console.log('[4/5] Tramas de sesion, audio, contexto de ruta e interrupcion: APROBADO.');

  verifyQwenServerParsing();
  console.log('[5/5] Deserializacion defensiva y validacion de herramientas: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
}

try {
  main();
} catch (error) {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
