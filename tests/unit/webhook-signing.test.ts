/**
 * @archivo tests/unit/webhook-signing.test.ts
 * @modulo 04-billing-and-whop (Prueba de Fuego de Firmas de Webhook y Enlaces de Pago)
 * @proposito
 *   Certifica la criptografia de las dos fronteras de cobro: la verificacion de las firmas de
 *   webhook entrantes y la firma de los metadatos de los enlaces de pago. Se comprueba que una firma
 *   manipulada, un cuerpo alterado o un evento fuera de la ventana anti-repeticion sean rechazados
 *   siempre, y que el parser de payloads normalice correctamente las dos nomenclaturas que puede
 *   emitir la pasarela sin aceptar cuerpos sin organizacion.
 *
 * @resumen_contenido
 *   - Bloque `verifyWebhookSignatureAcceptance()`: Firma valida sobre el cuerpo crudo.
 *   - Bloque `verifyWebhookSignatureRejection()`: Manipulacion, repeticion y cuerpo alterado.
 *   - Bloque `verifyCheckoutLinkSigning()`: Firma, vigencia y URL firmada del enlace de pago.
 *   - Bloque `verifyPayloadParsing()`: Normalizacion de payloads y rechazo de cuerpos invalidos.
 *
 * @dependencias_internas
 *   - `WhopApiAndHmacAdapter` (`src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter.ts`).
 *   - `WhopWebhookPayloadParser` (`src/modules/04-billing-and-whop/application/webhook-payload.parser.ts`).
 *   - `CryptoUtils` (`src/shared/kernel/crypto.util.ts`) y `DecimalMath` del kernel.
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente criptografica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import { WhopWebhookPayloadParser } from '../../src/modules/04-billing-and-whop/application/webhook-payload.parser';
import type { CheckoutSignedMetadata } from '../../src/modules/04-billing-and-whop/domain/billing-whop.types';
import {
  WhopApiAndHmacAdapter,
  type WhopWebhookHeaders,
} from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';

/** Secreto de webhooks de prueba en formato hexadecimal. */
const TEST_WEBHOOK_SECRET = 'whop_webhook_secret_placeholder_dev_32chars';

/** Secreto interno de checkout de prueba. */
const TEST_CHECKOUT_SECRET = 'dev_internal_checkout_hmac_secret_min32chars_ok';

/** Adaptador bajo prueba con credenciales sinteticas. */
const adapter = new WhopApiAndHmacAdapter({
  apiKey: 'whop_api_key_placeholder_dev',
  webhookSecret: TEST_WEBHOOK_SECRET,
  checkoutHmacSecret: TEST_CHECKOUT_SECRET,
  apiBaseUrl: 'https://api.interno.local',
  checkoutBaseUrl: 'https://pago.interno.local/checkout',
  webhookToleranceSeconds: 300,
});

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Construye el cuerpo crudo y las cabeceras firmadas de un webhook sintetico.
 *
 * @param payload - Objeto que se serializa como cuerpo del webhook.
 * @param timestampSeconds - Marca temporal declarada, en segundos desde el epoch.
 * @param secret - Secreto con el que se firma.
 * @returns Cuerpo crudo y cabeceras listas para la verificacion.
 */
function buildSignedWebhook(
  payload: Readonly<Record<string, unknown>>,
  timestampSeconds: number,
  secret: string = TEST_WEBHOOK_SECRET
): { readonly rawBody: Buffer; readonly headers: WhopWebhookHeaders } {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signatureHeader = CryptoUtils.hmacSha256Hex(secret, `${timestampSeconds}.${rawBody.toString('utf8')}`);
  return {
    rawBody,
    headers: {
      eventId: typeof payload['event_id'] === 'string' ? payload['event_id'] : 'evt-sintetico',
      timestampHeader: String(timestampSeconds),
      signatureHeader,
      eventNameHeader: typeof payload['event_type'] === 'string' ? payload['event_type'] : 'payment.succeeded',
    },
  };
}

/**
 * Devuelve la marca temporal actual en segundos desde el epoch.
 *
 * @returns Marca temporal en segundos.
 */
function currentTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Verifica que una firma correcta sobre el cuerpo crudo sea aceptada. */
function verifyWebhookSignatureAcceptance(): void {
  const timestamp = currentTimestampSeconds();
  const { rawBody, headers } = buildSignedWebhook(
    { event_id: 'evt-1', event_type: 'membership.went_valid', organization_id: 'org-1', membership_id: 'mem-1', internal_plan_code: 'PLAN_30' },
    timestamp
  );

  const verification = adapter.verifyWebhookSignature(rawBody, headers, timestamp * 1000);
  check(verification.valid, 'Una firma correcta sobre el cuerpo crudo debe ser aceptada');
  check(verification.rejectionReason === null, 'Una verificacion exitosa no debe reportar motivo de rechazo');
  check(verification.ageSeconds === 0, 'Un evento del instante declarado debe tener antiguedad cero');
  check(verification.acceptedScheme === 1, 'El primer esquema de secreto debe ser el aceptado con un secreto textual');

  const assertResult = adapter.assertValidWebhookSignature(rawBody, headers, timestamp * 1000);
  check(assertResult.valid, 'La variante estricta debe devolver el resultado cuando la firma es valida');

  const withVersionPrefix = `v1=${headers.signatureHeader}`;
  const prefixedVerification = adapter.verifyWebhookSignature(rawBody, { ...headers, signatureHeader: withVersionPrefix }, timestamp * 1000);
  check(prefixedVerification.valid, 'La firma con prefijo de version debe aceptarse');

  const multipleCandidates = adapter.verifyWebhookSignature(
    rawBody,
    { ...headers, signatureHeader: `${'a'.repeat(64)} ${headers.signatureHeader}` },
    timestamp * 1000
  );
  check(multipleCandidates.valid, 'Debe aceptarse cuando uno de los candidatos de firma es correcto');
}

/** Verifica que las manipulaciones y las repeticiones sean rechazadas. */
function verifyWebhookSignatureRejection(): void {
  const timestamp = currentTimestampSeconds();
  const payload = { event_id: 'evt-2', event_type: 'payment.succeeded', organization_id: 'org-1', amount_usd: 30 };
  const { rawBody, headers } = buildSignedWebhook(payload, timestamp);

  const tamperedSignature = `${headers.signatureHeader.slice(0, -1)}${headers.signatureHeader.endsWith('0') ? '1' : '0'}`;
  const tamperedResult = adapter.verifyWebhookSignature(rawBody, { ...headers, signatureHeader: tamperedSignature }, timestamp * 1000);
  check(!tamperedResult.valid, 'Una firma manipulada en un caracter debe ser rechazada');
  check(tamperedResult.rejectionReason === 'FIRMA_HMAC_INVALIDA', 'El motivo debe identificar la firma invalida');

  const alteredBody = Buffer.from(JSON.stringify({ ...payload, amount_usd: 1 }), 'utf8');
  const alteredResult = adapter.verifyWebhookSignature(alteredBody, headers, timestamp * 1000);
  check(!alteredResult.valid, 'Un cuerpo alterado debe invalidar la firma');

  const wrongSecretTimestamp = currentTimestampSeconds();
  const wrongSecretWebhook = buildSignedWebhook(payload, wrongSecretTimestamp, 'otro_secreto_completamente_distinto_32');
  const wrongSecretResult = adapter.verifyWebhookSignature(wrongSecretWebhook.rawBody, wrongSecretWebhook.headers, wrongSecretTimestamp * 1000);
  check(!wrongSecretResult.valid, 'Una firma calculada con otro secreto debe ser rechazada');

  const expiredTimestamp = currentTimestampSeconds() - 3600;
  const expiredWebhook = buildSignedWebhook(payload, expiredTimestamp);
  const expiredResult = adapter.verifyWebhookSignature(expiredWebhook.rawBody, expiredWebhook.headers, currentTimestampSeconds() * 1000);
  check(!expiredResult.valid, 'Un evento con una hora de antiguedad debe ser rechazado');
  check(
    expiredResult.rejectionReason?.includes('VENTANA_ANTI_REPETICION_EXCEDIDA') === true,
    'El motivo debe identificar la ventana anti-repeticion excedida'
  );
  check(expiredResult.ageSeconds >= 3500, 'La antiguedad calculada debe reflejar el retraso real');

  const futureWebhook = buildSignedWebhook(payload, currentTimestampSeconds() + 3600);
  const futureResult = adapter.verifyWebhookSignature(futureWebhook.rawBody, futureWebhook.headers, currentTimestampSeconds() * 1000);
  check(!futureResult.valid, 'Un evento con una hora de futuro tambien debe rechazarse');

  const withinTolerance = buildSignedWebhook(payload, currentTimestampSeconds() - 250);
  const withinToleranceResult = adapter.verifyWebhookSignature(
    withinTolerance.rawBody,
    withinTolerance.headers,
    currentTimestampSeconds() * 1000
  );
  check(withinToleranceResult.valid, 'Un evento dentro de la ventana de tolerancia debe aceptarse');

  const millisecondsTimestamp = Date.now();
  const millisecondWebhook = buildSignedWebhook(payload, millisecondsTimestamp);
  const millisecondResult = adapter.verifyWebhookSignature(
    millisecondWebhook.rawBody,
    { ...millisecondWebhook.headers, timestampHeader: String(millisecondsTimestamp) },
    millisecondsTimestamp
  );
  check(millisecondResult.valid, 'Una marca temporal en milisegundos debe normalizarse y aceptarse');

  const illegibleResult = adapter.verifyWebhookSignature(rawBody, { ...headers, timestampHeader: 'no-es-numero' }, Date.now());
  check(!illegibleResult.valid, 'Una marca temporal ilegible debe rechazarse');
  check(illegibleResult.rejectionReason === 'MARCA_TEMPORAL_ILEGIBLE', 'El motivo debe identificar la marca ilegible');

  let thrownError: unknown = null;
  try {
    adapter.assertValidWebhookSignature(rawBody, { ...headers, signatureHeader: 'a'.repeat(64) }, Date.now());
  } catch (error) {
    thrownError = error;
  }
  check(thrownError instanceof Error, 'La variante estricta debe lanzar un error controlado');
  check(
    thrownError instanceof Error && thrownError.message.includes('firma invalida'),
    'El error debe explicar en espanol el motivo del rechazo'
  );

  const base64Secret = `whsec_${Buffer.from(TEST_WEBHOOK_SECRET, 'utf8').toString('base64')}`;
  const base64Adapter = new WhopApiAndHmacAdapter({
    apiKey: 'clave',
    webhookSecret: base64Secret,
    checkoutHmacSecret: TEST_CHECKOUT_SECRET,
    apiBaseUrl: 'https://api.interno.local',
    checkoutBaseUrl: 'https://pago.interno.local/checkout',
    webhookToleranceSeconds: 300,
  });
  const decodedSecretWebhook = buildSignedWebhook(payload, currentTimestampSeconds(), TEST_WEBHOOK_SECRET);
  const decodedSecretResult = base64Adapter.verifyWebhookSignature(
    decodedSecretWebhook.rawBody,
    decodedSecretWebhook.headers,
    currentTimestampSeconds() * 1000
  );
  check(decodedSecretResult.valid, 'Un secreto declarado como whsec_ en Base64 debe validarse con su parte decodificada');
  check(decodedSecretResult.acceptedScheme === 2, 'El segundo esquema de secreto debe reportarse cuando se usa el decodificado');
}

/** Verifica la firma, la vigencia y la composicion de la URL del enlace de pago. */
function verifyCheckoutLinkSigning(): void {
  const issuedAtMs = Date.now();
  const signedMetadata: CheckoutSignedMetadata = adapter.signCheckoutMetadata({
    organizationId: 'org-1',
    actorUserId: 'usr-1',
    internalPlanCode: 'PLAN_50',
    checkoutMode: 'SUBSCRIPTION',
    topUpAmountUsd: null,
    issuedAtMs,
  });

  check(signedMetadata.signatureHex.length === 64, 'La firma del enlace debe ser un hexadecimal de 64 caracteres');
  check(
    signedMetadata.signedPayload === `org-1.usr-1.PLAN_50.SUBSCRIPTION.0.000000.${issuedAtMs}`,
    'La cadena firmada debe respetar el orden canonico de campos'
  );
  check(signedMetadata.signatureHex === CryptoUtils.hmacSha256Hex(TEST_CHECKOUT_SECRET, signedMetadata.signedPayload), 'La firma debe corresponder al HMAC del secreto interno');
  check(adapter.verifyCheckoutSignature(signedMetadata), 'Un enlace recien firmado debe verificarse');
  check(!adapter.verifyCheckoutSignature({ ...signedMetadata, signatureHex: 'f'.repeat(64) }), 'Una firma del enlace manipulada debe rechazarse');
  check(
    !adapter.verifyCheckoutSignature({ ...signedMetadata, signedPayload: `${signedMetadata.signedPayload}.extra` }),
    'Una cadena firmada alterada debe rechazarse'
  );
  check(!adapter.verifyCheckoutSignature(signedMetadata, issuedAtMs + 16 * 60 * 1000), 'Un enlace de mas de 15 minutos debe rechazarse');
  check(adapter.verifyCheckoutSignature(signedMetadata, issuedAtMs + 14 * 60 * 1000), 'Un enlace de 14 minutos debe seguir vigente');

  const topUpMetadata = adapter.signCheckoutMetadata({
    organizationId: 'org-2',
    actorUserId: 'usr-2',
    internalPlanCode: 'PAYG',
    checkoutMode: 'TOP_UP',
    topUpAmountUsd: '25.000000',
    issuedAtMs,
  });
  check(
    topUpMetadata.signedPayload.includes('25.000000'),
    'El importe de recarga debe formar parte de la cadena firmada'
  );
  check(
    !adapter.verifyCheckoutSignature({ ...topUpMetadata, signedPayload: topUpMetadata.signedPayload.replace('25.000000', '250.000000') }),
    'Un importe de recarga alterado debe invalidar la firma'
  );

  const signedUrl = adapter.buildSignedCheckoutUrl(topUpMetadata, 'whop_plan_payg_usage_only');
  check(signedUrl.startsWith('https://pago.interno.local/checkout/whop_plan_payg_usage_only?'), 'La URL debe apuntar al plan en la pasarela');
  check(signedUrl.includes('org=org-2'), 'La URL debe declarar la organizacion');
  check(signedUrl.includes('amount=25.000000'), 'La URL debe declarar el importe de recarga');
  check(signedUrl.includes(`sig=${topUpMetadata.signatureHex}`), 'La URL debe incluir la firma de los metadatos');
  check(!signedUrl.includes(TEST_CHECKOUT_SECRET), 'La URL jamas debe exponer el secreto interno');
}

/** Verifica la normalizacion de payloads y el rechazo de cuerpos invalidos. */
function verifyPayloadParsing(): void {
  check(
    WhopWebhookPayloadParser.normalizeEventName('membership.went_valid') === 'membership.went_valid',
    'Un nombre de evento soportado debe normalizarse'
  );
  check(WhopWebhookPayloadParser.normalizeEventName('  PAYMENT.SUCCEEDED  ') === 'payment.succeeded', 'El nombre debe normalizarse a minusculas y sin espacios');

  let unsupportedError: unknown = null;
  try {
    WhopWebhookPayloadParser.normalizeEventName('invoice.created');
  } catch (error) {
    unsupportedError = error;
  }
  check(unsupportedError instanceof Error, 'Un evento no soportado debe rechazarse con un error');

  const snakeCaseBody = Buffer.from(
    JSON.stringify({
      event_id: 'evt-10',
      event_type: 'membership.went_valid',
      data: { organization_id: 'org-9', membership_id: 'mem-9', internal_plan_code: 'PLAN_10' },
    }),
    'utf8'
  );
  const nestedValid = WhopWebhookPayloadParser.parseMembershipValid(WhopWebhookPayloadParser.extractEventData(snakeCaseBody));
  check(nestedValid.organizationId === 'org-9', 'La organizacion debe extraerse del objeto anidado `data`');
  check(nestedValid.internalPlanCode === 'PLAN_10', 'El codigo interno del plan debe conservarse');
  check(nestedValid.membershipId === 'mem-9', 'La membresia debe extraerse correctamente');
  check(!Number.isNaN(Date.parse(nestedValid.periodStartIso)), 'La fecha de inicio debe ser una marca ISO valida');

  const camelCaseBody = Buffer.from(
    JSON.stringify({ eventId: 'evt-11', organizationId: 'org-8', membershipId: 'mem-8', internalPlanCode: 'PLAN_5' }),
    'utf8'
  );
  const camelCaseValid = WhopWebhookPayloadParser.parseMembershipValid(WhopWebhookPayloadParser.extractEventData(camelCaseBody));
  check(camelCaseValid.organizationId === 'org-8', 'La nomenclatura camelCase debe aceptarse');
  check(camelCaseValid.eventId === 'evt-11', 'El identificador del evento debe aceptarse en camelCase');

  const paymentBody = Buffer.from(
    JSON.stringify({ organization_id: 'org-7', payment_id: 'pay-1', amount_usd: 49.5, payment_kind: 'top_up' }),
    'utf8'
  );
  const paymentParsed = WhopWebhookPayloadParser.parsePaymentSucceeded(WhopWebhookPayloadParser.extractEventData(paymentBody));
  check(paymentParsed.amountUsd === '49.500000', 'El importe numerico debe normalizarse a 6 decimales exactos');
  check(paymentParsed.paymentKind === 'TOP_UP', 'El tipo de pago debe normalizarse a mayusculas');

  let invalidJsonError: unknown = null;
  try {
    WhopWebhookPayloadParser.extractEventData(Buffer.from('{no-json', 'utf8'));
  } catch (error) {
    invalidJsonError = error;
  }
  check(invalidJsonError instanceof Error, 'Un cuerpo que no es JSON valido debe rechazarse');

  let missingOrganizationError: unknown = null;
  try {
    WhopWebhookPayloadParser.parsePaymentSucceeded({ payment_id: 'pay-2', amount_usd: 10 });
  } catch (error) {
    missingOrganizationError = error;
  }
  check(missingOrganizationError instanceof Error, 'Un evento sin organizacion debe rechazarse');

  const invalidBody = Buffer.from(JSON.stringify({ organization_id: 'org-1', amount_usd: 'no-es-numero' }), 'utf8');
  let invalidAmountError: unknown = null;
  try {
    WhopWebhookPayloadParser.parsePaymentSucceeded(WhopWebhookPayloadParser.extractEventData(invalidBody));
  } catch (error) {
    invalidAmountError = error;
  }
  check(invalidAmountError instanceof Error, 'Un importe con formato invalido debe rechazarse');

  const invalidEvent = WhopWebhookPayloadParser.parseMembershipInvalid(
    WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify({ organization_id: 'org-3', membership_id: 'mem-3' }), 'utf8'))
  );
  check(invalidEvent.reason === 'MOTIVO_NO_DECLARADO', 'Una invalidacion sin motivo debe declararlo como no declarado');
}

/** Ejecuta los 4 grupos de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE FUEGO DE FIRMAS DE WEBHOOK Y ENLACES DE PAGO (PARTE 9)');
  console.log('='.repeat(96));

  verifyWebhookSignatureAcceptance();
  console.log('[1/4] Aceptacion de firmas validas sobre el cuerpo crudo: APROBADO.');

  verifyWebhookSignatureRejection();
  console.log('[2/4] Rechazo de manipulacion, repeticion y cuerpo alterado: APROBADO.');

  verifyCheckoutLinkSigning();
  console.log('[3/4] Firma, vigencia y URL del enlace de pago: APROBADO.');

  verifyPayloadParsing();
  console.log('[4/4] Normalizacion defensiva de payloads de webhook: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main();
