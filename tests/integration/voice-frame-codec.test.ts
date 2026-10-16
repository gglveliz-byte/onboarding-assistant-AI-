/**
 * @archivo tests/integration/voice-frame-codec.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego del Codec de Tramas del Socket de Voz)
 * @proposito
 *   Certifica el codec binario sin red. Un socket entrega un flujo de bytes y no mensajes, de modo
 *   que un fragmento de audio puede llegar partido en dos paquetes: el acumulador debe reconstruirlo
 *   sin incrustar el byte de cabecera en medio del audio, sin confundir un mensaje de control con
 *   audio y sin cortar un JSON antes de tiempo cuando contiene llaves dentro de una cadena —por
 *   ejemplo una ruta con llaves, que es un caso real y no una hipotesis. Tambien verifica que el
 *   audio del asistente viaje sin cabecera, porque es la ruta caliente y copiar el buffer entero
 *   decenas de veces por segundo tiene un coste medible.
 *
 * @resumen_contenido
 *   - Bloque `verifyRoundTrip()`: Ida y vuelta de audio, control y directivas de herramienta.
 *   - Bloque `verifyDefensiveDecoding()`: Tramas vacias, impares, ilegibles y desconocidas.
 *   - Bloque `verifyFrameAccumulator()`: Paquetes partidos, multiples tramas y desbordamiento.
 *   - Bloque `verifyJsonBoundaries()`: Llaves dentro de cadenas y reinicio del acumulador.
 *
 * @dependencias_internas
 *   - Codecs y acumulador (`src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol.ts`).
 *   - Dobles compartidos (`./support/voice-gateway-doubles.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Prueba puramente en memoria: no abre conexiones ni escribe datos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (El codec de transporte no persiste nada).
 */

import {
  AUDIO_UPLINK_FRAME_BYTES,
  buildToolAckBody,
  decodeClientFrame,
  encodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  encodeControlFrame,
  encodeSessionClosingFrame,
  encodeToolExecuteFrame,
  FRAME_TYPE_AUDIO_UPLINK,
  FRAME_TYPE_CONTROL_JSON,
  VOICE_CLOSE_CODES,
  VoiceFrameDecoder,
} from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import { buildPcmFrame, check, countPassedAssertions } from './support/voice-gateway-doubles';

/** Verifica el ciclo completo de codificacion y decodificacion de cada tipo de trama. */
function verifyRoundTrip(): void {
  const audioFrame = buildPcmFrame(16384, 320);
  const uplinkFrame = encodeAudioUplinkFrame(audioFrame);

  check(
    uplinkFrame.length === AUDIO_UPLINK_FRAME_BYTES,
    `La trama de audio debe medir ${AUDIO_UPLINK_FRAME_BYTES} bytes (obtenido: ${uplinkFrame.length})`
  );
  check(uplinkFrame[0] === FRAME_TYPE_AUDIO_UPLINK, 'La trama de audio debe declarar su tipo en el primer byte');

  const decodedAudio = decodeClientFrame(uplinkFrame);
  check(decodedAudio.ok, 'Una trama de audio completa debe decodificarse');
  check(
    decodedAudio.ok && decodedAudio.frame.kind === 'AUDIO',
    'La trama de audio debe reconocerse como audio'
  );
  check(
    decodedAudio.ok && decodedAudio.frame.audioPayload?.equals(audioFrame) === true,
    'El audio debe recuperarse byte a byte, sin la cabecera incrustada'
  );

  check(
    encodeAudioDownlinkFrame(audioFrame).equals(audioFrame),
    'El audio del asistente viaja sin cabecera porque es la ruta caliente'
  );

  const controlFrame = encodeControlFrame('voice.barge_in', { reason: 'usuario_interrumpio' });
  check(controlFrame[0] === FRAME_TYPE_CONTROL_JSON, 'La trama de control debe declarar su tipo en el primer byte');
  const decodedControl = decodeClientFrame(controlFrame);
  check(decodedControl.ok && decodedControl.frame.kind === 'CONTROL', 'La trama de control debe reconocerse como tal');
  check(
    decodedControl.ok && decodedControl.frame.controlName === 'voice.barge_in',
    'El nombre del mensaje de control debe conservarse'
  );
  check(
    decodedControl.ok && decodedControl.frame.controlBody?.['reason'] === 'usuario_interrumpio',
    'El cuerpo del mensaje de control debe llegar intacto'
  );

  const toolFrame = encodeToolExecuteFrame({
    providerToolCallId: 'call-1',
    toolName: 'type_text',
    targetElementKey: 'input_email',
    primarySelector: '#email',
    selectorCascade: ['#email', '[data-oa-key="input_email"]'],
    textPayload: 'usuario@ejemplo.com',
    requiresUserConfirmation: false,
    riskLevel: 'LOW',
  });
  const decodedTool = decodeClientFrame(toolFrame);
  check(
    decodedTool.ok && decodedTool.frame.controlName === 'tool.execute',
    'La directiva de herramienta debe viajar como tool.execute'
  );
  check(
    decodedTool.ok && Array.isArray(decodedTool.frame.controlBody?.['selectorCascade']),
    'La cascada de selectores debe viajar en la directiva'
  );

  const closingFrame = encodeSessionClosingFrame(VOICE_CLOSE_CODES.PAYMENT_REQUIRED, 'Mensaje de marca.');
  const decodedClosing = decodeClientFrame(closingFrame);
  check(
    decodedClosing.ok && decodedClosing.frame.controlBody?.['closeCode'] === 4002,
    'La trama de cierre debe declarar el codigo 4002 de pago requerido'
  );

  const ackBody = buildToolAckBody('call-9', false, 'SENSITIVE_FIELD_BLOCKED');
  check(ackBody['providerToolCallId'] === 'call-9', 'El acuse debe conservar el identificador de la llamada');
  check(ackBody['succeeded'] === false, 'El acuse debe declarar el fallo de la accion');
}

/** Verifica que las tramas invalidas se rechacen sin lanzar excepciones. */
function verifyDefensiveDecoding(): void {
  check(!decodeClientFrame(Buffer.alloc(0)).ok, 'Una trama vacia debe rechazarse');
  check(!decodeClientFrame(Buffer.from([FRAME_TYPE_AUDIO_UPLINK])).ok, 'Una trama de audio sin contenido debe rechazarse');

  const oddAudio = Buffer.concat([Buffer.from([FRAME_TYPE_AUDIO_UPLINK]), Buffer.from([1, 2, 3])]);
  check(!decodeClientFrame(oddAudio).ok, 'Un audio con un numero impar de bytes no es PCM16 valido');

  const badJson = Buffer.concat([Buffer.from([FRAME_TYPE_CONTROL_JSON]), Buffer.from('{no-json', 'utf8')]);
  check(!decodeClientFrame(badJson).ok, 'Un mensaje de control ilegible debe rechazarse');

  const nonObjectJson = Buffer.concat([Buffer.from([FRAME_TYPE_CONTROL_JSON]), Buffer.from('[1,2,3]', 'utf8')]);
  check(!decodeClientFrame(nonObjectJson).ok, 'Un arreglo JSON no es un mensaje de control valido');

  const unknownControl = Buffer.concat([
    Buffer.from([FRAME_TYPE_CONTROL_JSON]),
    Buffer.from(JSON.stringify({ type: 'orden.destructiva' }), 'utf8'),
  ]);
  check(!decodeClientFrame(unknownControl).ok, 'Un mensaje de control no soportado debe descartarse');

  check(!decodeClientFrame(Buffer.from([0x7f, 1, 2, 3])).ok, 'Un tipo de trama desconocido debe rechazarse');
}

/** Verifica el acumulador ante paquetes partidos y multiples tramas por paquete. */
function verifyFrameAccumulator(): void {
  const audioFrame = buildPcmFrame(16384, 320);
  const uplinkFrame = encodeAudioUplinkFrame(audioFrame);

  const emptyDecoder = new VoiceFrameDecoder();
  check(emptyDecoder.push(Buffer.alloc(0)).length === 0, 'Un paquete vacio no debe producir tramas');

  const splitDecoder = new VoiceFrameDecoder();
  check(splitDecoder.push(uplinkFrame.subarray(0, 300)).length === 0, 'Media trama no debe producir una trama completa');
  check(splitDecoder.getPendingByteLength() === 300, 'El acumulador debe conservar los bytes pendientes');
  const splitOutcomes = splitDecoder.push(uplinkFrame.subarray(300));
  check(splitOutcomes.length === 1, 'Al completarse, la trama partida debe emitirse una sola vez');
  check(
    splitOutcomes[0]?.ok === true && splitOutcomes[0].frame.audioPayload?.equals(audioFrame) === true,
    'El audio partido entre dos paquetes debe reconstruirse byte a byte, sin corromperse'
  );
  check(splitDecoder.getPendingByteLength() === 0, 'Tras completar la trama no deben quedar bytes pendientes');

  const byteByByteDecoder = new VoiceFrameDecoder();
  let emittedFrames = 0;
  for (const singleByte of uplinkFrame) {
    emittedFrames += byteByByteDecoder.push(Buffer.from([singleByte])).length;
  }
  check(emittedFrames === 1, 'Una trama entregada byte a byte debe emitirse exactamente una vez al completarse');

  const multiDecoder = new VoiceFrameDecoder();
  const threeFrames = Buffer.concat([uplinkFrame, encodeControlFrame('voice.barge_in', {}), uplinkFrame]);
  const multiOutcomes = multiDecoder.push(threeFrames);
  check(multiOutcomes.length === 3, `Tres tramas en un paquete deben emitir tres tramas (obtenido: ${multiOutcomes.length})`);
  check(
    multiOutcomes[0]?.ok === true && multiOutcomes[1]?.ok === true && multiOutcomes[2]?.ok === true,
    'Las tres tramas deben decodificarse'
  );

  const overflowDecoder = new VoiceFrameDecoder(256);
  const overflowOutcomes = overflowDecoder.push(Buffer.alloc(300));
  check(overflowOutcomes.length === 1 && !overflowOutcomes[0]?.ok, 'Una trama que excede el maximo debe descartarse');
  check(
    overflowDecoder.getPendingByteLength() === 0,
    'El acumulador debe vaciarse al descartar una trama excesiva para no consumir memoria sin limite'
  );
}

/** Verifica el reconocimiento de limites de JSON con llaves dentro de cadenas. */
function verifyJsonBoundaries(): void {
  const controlSplitDecoder = new VoiceFrameDecoder();
  const controlBytes = encodeControlFrame('route.changed', { routePath: '/panel/facturacion' });
  check(controlSplitDecoder.push(controlBytes.subarray(0, 10)).length === 0, 'Un JSON de control incompleto no debe emitirse');
  const controlSplitOutcomes = controlSplitDecoder.push(controlBytes.subarray(10));
  check(controlSplitOutcomes.length === 1, 'El JSON de control completado debe emitirse');
  check(
    controlSplitOutcomes[0]?.ok === true && controlSplitOutcomes[0].frame.controlBody?.['routePath'] === '/panel/facturacion',
    'El cuerpo del control partido debe reconstruirse integro'
  );

  const braceInStringDecoder = new VoiceFrameDecoder();
  const trickyControl = encodeControlFrame('route.changed', { routePath: '/ruta/con}llave', note: 'a}b' });
  const trickyOutcomes = braceInStringDecoder.push(trickyControl);
  check(trickyOutcomes.length === 1, 'Una llave dentro de una cadena no debe cortar el mensaje antes de tiempo');
  check(
    trickyOutcomes[0]?.ok === true && trickyOutcomes[0].frame.controlBody?.['routePath'] === '/ruta/con}llave',
    'El contenido con llaves debe conservarse literalmente'
  );

  const escapedQuoteDecoder = new VoiceFrameDecoder();
  const escapedControl = encodeControlFrame('route.changed', { note: 'dice "hola" y sigue' });
  const escapedOutcomes = escapedQuoteDecoder.push(escapedControl);
  check(escapedOutcomes.length === 1, 'Las comillas escapadas no deben confundir al detector de limites');
  check(
    escapedOutcomes[0]?.ok === true && escapedOutcomes[0].frame.controlBody?.['note'] === 'dice "hola" y sigue',
    'El texto con comillas debe conservarse integro'
  );

  const resetDecoder = new VoiceFrameDecoder();
  resetDecoder.push(encodeAudioUplinkFrame(buildPcmFrame(1000, 320)).subarray(0, 100));
  resetDecoder.reset();
  check(resetDecoder.getPendingByteLength() === 0, 'Reiniciar el acumulador debe descartar los bytes pendientes');

  const twoControlDecoder = new VoiceFrameDecoder();
  const twoControls = Buffer.concat([
    encodeControlFrame('route.changed', { routePath: '/a' }),
    encodeControlFrame('voice.barge_in', { at: 1 }),
  ]);
  const twoOutcomes = twoControlDecoder.push(twoControls);
  check(twoOutcomes.length === 2, 'Dos mensajes de control contiguos deben emitirse por separado');
  check(
    twoOutcomes[0]?.ok === true && twoOutcomes[1]?.ok === true,
    'Ambos mensajes de control deben decodificarse correctamente'
  );
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE FUEGO DEL CODEC DE TRAMAS DEL SOCKET DE VOZ (PARTE 13)');
  console.log('='.repeat(96));

  verifyRoundTrip();
  console.log('[1/4] Ida y vuelta de audio, control y directivas: APROBADO.');

  verifyDefensiveDecoding();
  console.log('[2/4] Rechazo defensivo de tramas invalidas y desconocidas: APROBADO.');

  verifyFrameAccumulator();
  console.log('[3/4] Acumulador ante paquetes partidos y multiples tramas: APROBADO.');

  verifyJsonBoundaries();
  console.log('[4/4] Limites de JSON con llaves y comillas en cadenas: APROBADO.');

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
