/**
 * @archivo tests/unit/webhook-signing.test.ts
 * @modulo 04-billing-and-whop (Prueba de Fuego de la Firma Real de Webhooks)
 * @proposito
 *   Verifica que el verificador acepte EXACTAMENTE el esquema que la pasarela envia y rechace el que
 *   usaba la integracion anterior. La version previa firmaba `{timestamp}.{cuerpo}` en hexadecimal y
 *   exigia cabeceras `x-whop-*`, incompatibles con Standard Webhooks: ninguna entrega legitima pasaba
 *   y toda suscripcion se rechazaba con 401.
 *
 *   El contrato real, copiado de `@whop/sdk/helpers/verifyWebhook`: HMAC-SHA256 sobre
 *   `{webhook-id}.{webhook-timestamp}.{cuerpo crudo}`, codificado en Base64, presentado como
 *   `v1,<base64>`, firmado con los BYTES LITERALES del secreto `ws_...` (la pasarela no lo recorta ni
 *   lo decodifica), y con ventana de tolerancia sobre `webhook-timestamp`.
 *
 * @resumen_contenido
 *   - `verifyRealSchemeSignature()`: firma correcta aceptada; variantes manipuladas rechazadas.
 *   - `verifyLegacyHexSignatureIsRejected()`: el esquema hexagesimal antiguo ya no pasa.
 *   - `verifyToleranceWindow()`: eventos fuera de ventana se rechazan.
 *   - `verifyEventNames()`: nombres actuales y alias legacy.
 *   - `verifyMetadataUnwrapping()`: la metadata del checkout se desanida desde `data.metadata`.
 *   - `verifyMoneyAndSubstatus()`: objeto monetario, moneda y `substatus`.
 *   - `verifyMembershipUpdatedDecidesByStatus()`: alta o morosidad segun `status`.
 *   - `verifyAdapterCredentialGuards()`: credenciales incompletas o invalidas fallan al construir.
 *
 * @dependencias_internas
 *   - `WhopApiAndHmacAdapter`, `WebhookSignatureVerifier`, `WhopWebhookPayloadParser`.
 *   - `CryptoUtils.hmacSha256Base64` (kernel): unico generador de fixtures.
 *
 * @dependencias_externas
 *   - `node:assert`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba pura de firma y parseo, sin base de datos).
 */

import assert from 'node:assert';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import { WhopApiAndHmacAdapter, type WhopWebhookHeaders } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { WhopWebhookPayloadParser } from '../../src/modules/04-billing-and-whop/application/webhook-payload.parser';
import { triageVerifiedWebhook } from '../../src/modules/04-billing-and-whop/application/webhook-intake.triage';

/** Secreto literal de la pasarela usado por las fixtures. */
const TEST_WEBHOOK_SECRET = 'ws_test_secret_literal_bytes_0123456789';
/** Secreto interno de firma de enlaces de pago. */
const TEST_CHECKOUT_SECRET = 'internal_checkout_hmac_secret_at_least_32_chars';
/** Cuenta de empresa de prueba. */
const TEST_COMPANY_ID = 'biz_test_company_001';
/** Tolerancia anti-repeticion bajo prueba, en segundos. */
const TEST_TOLERANCE_SECONDS = 300;

/** Adaptador bajo prueba con credenciales sinteticas. */
const adapter = new WhopApiAndHmacAdapter({
  companyApiKey: 'apik_test_company_key_literal',
  companyId: TEST_COMPANY_ID,
  webhookSecret: TEST_WEBHOOK_SECRET,
  checkoutHmacSecret: TEST_CHECKOUT_SECRET,
  checkoutBaseUrl: 'https://pago.interno.local/checkout',
  webhookToleranceSeconds: TEST_TOLERANCE_SECONDS,
});

/** Contador de verificaciones superadas. */
let passedAssertions = 0;

/** Aserta una condicion y contabiliza la verificacion superada. */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Construye una entrega de webhook con el esquema REAL de la pasarela.
 *
 * @param eventId - Identificador `msg_...` del evento.
 * @param body - Sobre del evento que se serializa como cuerpo crudo.
 * @param timestampSeconds - Marca temporal de `webhook-timestamp`.
 * @param secret - Secreto literal con el que se firma.
 * @returns Cuerpo crudo y cabeceras normalizadas listas para la verificacion.
 */
function buildRealWebhook(
  eventId: string,
  body: Readonly<Record<string, unknown>>,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
  secret: string = TEST_WEBHOOK_SECRET
): { readonly rawBody: Buffer; readonly headers: WhopWebhookHeaders } {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const signingInput = `${eventId}.${timestampSeconds}.${rawBody.toString('utf8')}`;
  return {
    rawBody,
    headers: {
      eventId,
      timestampHeader: String(timestampSeconds),
      signatureHeader: `v1,${CryptoUtils.hmacSha256Base64(secret, signingInput)}`,
    },
  };
}

/** Sobre de evento de activacion con la metadata anidada como la envia la pasarela. */
function activationEnvelope(eventId: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'membership.activated',
    api_version: 'v1',
    account_id: TEST_COMPANY_ID,
    data: {
      id: 'mem_real_001',
      status: 'active',
      plan_id: 'plan_kVPGj57x5DVsm',
      user_id: 'user_real_001',
      current_period_start: '2026-10-20T00:00:00.000Z',
      current_period_end: '2026-11-19T00:00:00.000Z',
      metadata: { organization_id: 'org-real-1', internal_plan_code: 'PLAN_5', checkout_mode: 'SUBSCRIPTION' },
    },
  };
}

/** Verifica que la firma del esquema real se acepte y que las manipulaciones se rechacen. */
function verifyRealSchemeSignature(): void {
  const { rawBody, headers } = buildRealWebhook('msg_ok_1', activationEnvelope('msg_ok_1'));

  const verification = adapter.verifyWebhookSignature(rawBody, headers);
  check(verification.valid, 'Una firma correcta del esquema real debe aceptarse');
  check(verification.rejectionReason === null, 'Una verificacion exitosa no reporta motivo de rechazo');
  check(verification.eventId === 'msg_ok_1', 'El identificador del evento debe propagarse al resultado');
  check(verification.payload !== null, 'El helper debe devolver el cuerpo ya deserializado');
  check((verification.payload ?? {})['type'] === 'membership.activated', 'El payload parseado debe conservar el tipo de evento');

  const strict = adapter.assertValidWebhookSignature(rawBody, headers);
  check(strict.valid, 'La variante estricta devuelve el resultado cuando la firma es valida');

  const tamperedBody = Buffer.from(`${rawBody.toString('utf8')} `, 'utf8');
  check(!adapter.verifyWebhookSignature(tamperedBody, headers).valid, 'Anadir un espacio al cuerpo debe invalidar la firma');

  const wrongSecret = buildRealWebhook('msg_ok_1', activationEnvelope('msg_ok_1'), Math.floor(Date.now() / 1000), 'ws_otro_secreto_distinto');
  check(!adapter.verifyWebhookSignature(wrongSecret.rawBody, wrongSecret.headers).valid, 'Un secreto distinto debe rechazar la entrega');

  const swappedId = buildRealWebhook('msg_ok_1', activationEnvelope('msg_ok_1'));
  check(
    !adapter.verifyWebhookSignature(swappedId.rawBody, { ...swappedId.headers, eventId: 'msg_otro' }).valid,
    'Suplantar el webhook-id debe invalidar la firma, porque entra en la cadena firmada'
  );
}

/** Verifica que el esquema hexagesimal legacy de esta plataforma ya no sea aceptado. */
function verifyLegacyHexSignatureIsRejected(): void {
  const timestamp = Math.floor(Date.now() / 1000);
  const { rawBody, headers } = buildRealWebhook('msg_hex_1', activationEnvelope('msg_hex_1'), timestamp);
  const legacyHex = CryptoUtils.hmacSha256Hex(TEST_WEBHOOK_SECRET, `${timestamp}.${rawBody.toString('utf8')}`);

  const rejected = adapter.verifyWebhookSignature(rawBody, { ...headers, signatureHeader: legacyHex });
  check(!rejected.valid, 'La firma hexagesimal sobre {timestamp}.{cuerpo} debe rechazarse: no es el esquema de la pasarela');
  check(rejected.rejectionReason !== null && rejected.rejectionReason.includes('FIRMA_HMAC_INVALIDA'), 'El rechazo debe reportar firma invalida');
}

/** Verifica la ventana anti-repeticion sobre `webhook-timestamp`. */
function verifyToleranceWindow(): void {
  const staleSeconds = Math.floor(Date.now() / 1000) - (TEST_TOLERANCE_SECONDS + 120);
  const { rawBody, headers } = buildRealWebhook('msg_stale_1', activationEnvelope('msg_stale_1'), staleSeconds);

  const result = adapter.verifyWebhookSignature(rawBody, headers);
  check(!result.valid, 'Un evento fuera de la ventana de tolerancia debe rechazarse');
  check(result.ageSeconds > TEST_TOLERANCE_SECONDS, 'La antiguedad reportada debe exceder la tolerancia');
}

/** Verifica la normalizacion de nombres de evento actuales y legacy. */
function verifyEventNames(): void {
  check(WhopWebhookPayloadParser.normalizeEventName('membership.activated') === 'membership.activated', 'El evento actual de alta debe aceptarse');
  check(WhopWebhookPayloadParser.normalizeEventName('membership.updated') === 'membership.updated', 'El evento de cambio debe aceptarse');
  check(WhopWebhookPayloadParser.normalizeEventName('membership.deactivated') === 'membership.deactivated', 'El evento de baja debe aceptarse');
  check(WhopWebhookPayloadParser.normalizeEventName('  PAYMENT.SUCCEEDED  ') === 'payment.succeeded', 'El nombre debe normalizarse a minusculas y sin espacios');
  check(WhopWebhookPayloadParser.normalizeEventName('membership.went_valid') === 'membership.activated', 'El alias legacy de alta debe mapearse al canonico');
  check(WhopWebhookPayloadParser.normalizeEventName('membership.went_invalid') === 'membership.deactivated', 'El alias legacy de baja debe mapearse al canonico');

  let unsupportedRejected = false;
  try {
    WhopWebhookPayloadParser.normalizeEventName('invoice.created');
  } catch {
    unsupportedRejected = true;
  }
  check(unsupportedRejected, 'Un evento no soportado debe lanzar error de validacion');
}

/** Verifica que la metadata del checkout se desanide desde `data.metadata`. */
function verifyMetadataUnwrapping(): void {
  const data = WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(activationEnvelope('msg_meta_1')), 'utf8'));
  const parsed = WhopWebhookPayloadParser.parseMembershipValid(data);

  check(parsed.organizationId === 'org-real-1', 'La organizacion debe leerse desde la metadata anidada del checkout');
  check(parsed.internalPlanCode === 'PLAN_5', 'El plan interno debe leerse desde la metadata anidada del checkout');
  check(parsed.membershipId === 'mem_real_001', 'La membresia debe leerse de data.id');
  check(parsed.externalPlanId === 'plan_kVPGj57x5DVsm', 'El plan externo debe propagarse');
  check(parsed.periodStartIso === '2026-10-20T00:00:00.000Z', 'El inicio de periodo debe leerse de current_period_start');
  check(parsed.periodEndIso === '2026-11-19T00:00:00.000Z', 'El fin de periodo debe leerse de current_period_end');

  const withoutOrg = { id: 'msg_x', type: 'membership.activated', data: { id: 'mem_1', status: 'active', metadata: {} } };
  let missingOrgRejected = false;
  try {
    WhopWebhookPayloadParser.parseMembershipValid(WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(withoutOrg), 'utf8')));
  } catch {
    missingOrgRejected = true;
  }
  check(missingOrgRejected, 'Un evento sin organizacion acreditada debe rechazarse, no adivinarla');
}

/** Verifica la lectura del importe, la moneda y el `substatus` del pago. */
function verifyMoneyAndSubstatus(): void {
  const paymentEnvelope = {
    id: 'msg_pay_1',
    type: 'payment.succeeded',
    data: {
      id: 'pay_real_1',
      membership_id: 'mem_real_1',
      status: 'paid',
      substatus: 'succeeded',
      currency: 'usd',
      total: { amount: '5.50', currency: 'usd', decimals: 2, display_decimals: 2 },
      metadata: { organization_id: 'org-pay-1', checkout_mode: 'TOP_UP', internal_plan_code: 'PAYG' },
    },
  };

  const parsed = WhopWebhookPayloadParser.parsePaymentSucceeded(
    WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(paymentEnvelope), 'utf8'))
  );
  check(parsed.amountUsd === '5.500000', 'El importe debe leerse del objeto monetario total.amount');
  check(parsed.paymentKind === 'TOP_UP', 'La metadata del checkout define la naturaleza del cobro');
  check(parsed.paymentId === 'pay_real_1', 'El identificador del pago debe propagarse');
  check(parsed.membershipId === 'mem_real_1', 'La membresia del pago debe propagarse');
  check(parsed.periodStartIso === null, 'Una recarga no declara periodo');

  const notSettled = { ...paymentEnvelope, data: { ...paymentEnvelope.data, substatus: 'pending' } };
  let pendingRejected = false;
  try {
    WhopWebhookPayloadParser.parsePaymentSucceeded(WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(notSettled), 'utf8')));
  } catch {
    pendingRejected = true;
  }
  check(pendingRejected, 'Un pago con substatus distinto de succeeded no debe acreditarse');

  const wrongCurrency = { ...paymentEnvelope, data: { ...paymentEnvelope.data, currency: 'eur' } };
  let currencyRejected = false;
  try {
    WhopWebhookPayloadParser.parsePaymentSucceeded(WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(wrongCurrency), 'utf8')));
  } catch {
    currencyRejected = true;
  }
  check(currencyRejected, 'Un cobro en una moneda distinta de USD debe rechazarse en lugar de convertirse a ciegas');
}

/** Verifica que `membership.updated` decida alta o morosidad por el estado declarado. */
function verifyMembershipUpdatedDecidesByStatus(): void {
  const active = { id: 'msg_up_1', type: 'membership.updated', data: { id: 'mem_1', status: 'active', metadata: { organization_id: 'org-1', internal_plan_code: 'PLAN_10' } } };
  const pastDue = { id: 'msg_up_2', type: 'membership.updated', data: { id: 'mem_2', status: 'past_due', metadata: { organization_id: 'org-2', internal_plan_code: 'PLAN_10' } } };

  const flatten = (envelope: Record<string, unknown>) => WhopWebhookPayloadParser.extractEventData(Buffer.from(JSON.stringify(envelope), 'utf8'));
  check(WhopWebhookPayloadParser.membershipStatusIsCurrent(flatten(active)), 'Un estado active debe conceder acceso vigente');
  check(!WhopWebhookPayloadParser.membershipStatusIsCurrent(flatten(pastDue)), 'Un estado past_due no debe conceder acceso');

  const canceled = { id: 'msg_up_3', type: 'membership.updated', data: { id: 'mem_3', status: 'canceled', metadata: { organization_id: 'org-3' } } };
  const invalidPayload = WhopWebhookPayloadParser.parseMembershipInvalid(flatten(canceled));
  check(invalidPayload.reason === 'canceled', 'El motivo de la morosidad debe tomar el estado declarado por la pasarela');
}

/** Verifica que el adaptador exija credenciales completas y coherentes. */
function verifyAdapterCredentialGuards(): void {
  const base = {
    companyId: TEST_COMPANY_ID,
    webhookSecret: TEST_WEBHOOK_SECRET,
    checkoutHmacSecret: TEST_CHECKOUT_SECRET,
    checkoutBaseUrl: 'https://pago.interno.local/checkout',
    webhookToleranceSeconds: TEST_TOLERANCE_SECONDS,
  };

  let missingKeyRejected = false;
  try {
    new WhopApiAndHmacAdapter({ ...base, companyApiKey: '   ' });
  } catch {
    missingKeyRejected = true;
  }
  check(missingKeyRejected, 'La pasarela debe exigir la clave de empresa; la clave publica del app no autoriza cobros');

  let badCompanyRejected = false;
  try {
    new WhopApiAndHmacAdapter({ ...base, companyApiKey: 'apik_ok', companyId: 'company_sin_prefijo' });
  } catch {
    badCompanyRejected = true;
  }
  check(badCompanyRejected, 'El identificador de empresa debe tener el formato biz_ que la API v1 exige');

  let missingSecretRejected = false;
  try {
    new WhopApiAndHmacAdapter({ ...base, companyApiKey: 'apik_ok', webhookSecret: '' });
  } catch {
    missingSecretRejected = true;
  }
  check(missingSecretRejected, 'Sin secreto de webhooks no puede verificarse ninguna entrega');
}

/**
 * Verifica el triage de eventos ya firmados: que un evento legitimo pero no procesable se ACUSE
 * RECIBIDO (2xx) en lugar de rechazarse. Esto importa operativamente porque la pasarela reintenta
 * todo lo que no sea 2xx: un 4xx sobre un evento que esta plataforma nunca procesara se convierte en
 * una tormenta de reintentos indefinida.
 */
function verifyTriageAcknowledges(): void {
  const sinOrganizacion = {
    id: 'msg_atribs_1',
    type: 'payment.succeeded',
    data: { id: 'pay_1', total: { amount: '10.00', currency: 'usd' }, metadata: {} },
  };
  const decisionSinOrg = triageVerifiedWebhook(sinOrganizacion, 'msg_atribs_1');
  check(decisionSinOrg.kind === 'acknowledge', 'Un pago sin organizacion acreditada debe acusarse recibo, no rechazarse');
  check(
    decisionSinOrg.kind === 'acknowledge' && decisionSinOrg.appliedAction === 'EVENTO_SIN_ORGANIZACION_ACUSE_RECIBIDO',
    'El acuse debe declarar la causa de falta de titularidad'
  );

  const desconocido = { id: 'msg_unk_1', type: 'invoice.paid', data: { metadata: { organization_id: 'org-1' } } };
  const decisionDesconocido = triageVerifiedWebhook(desconocido, 'msg_unk_1');
  check(
    decisionDesconocido.kind === 'acknowledge' && decisionDesconocido.appliedAction.startsWith('EVENTO_NO_RECONOCIDO:'),
    'Un evento de nombre no contratado debe acusarse recibo con la causa'
  );

  const atribuible = {
    id: 'msg_ok_2',
    type: 'membership.activated',
    data: { id: 'mem_2', status: 'active', metadata: { organization_id: 'org-2', internal_plan_code: 'PLAN_5' } },
  };
  const decisionOk = triageVerifiedWebhook(atribuible, 'msg_ok_2');
  check(decisionOk.kind === 'process', 'Un evento firmado, conocido y con titularidad debe procesarse');

  let sinIdRejected = false;
  try {
    triageVerifiedWebhook({ type: 'payment.succeeded', data: { metadata: { organization_id: 'org-3' } } }, '');
  } catch {
    sinIdRejected = true;
  }
  check(sinIdRejected, 'Un evento sin identificador debe fallar: sin el no existe idempotencia posible');
}

/** Ejecuta la bateria de verificaciones. */
function main(): void {
  console.log('PRUEBA DE FIRMA REAL DE WEBHOOKS DE LA PASARELA (Standard Webhooks)');
  console.log('=======================================================================');
  verifyRealSchemeSignature();
  verifyLegacyHexSignatureIsRejected();
  verifyToleranceWindow();
  verifyEventNames();
  verifyMetadataUnwrapping();
  verifyMoneyAndSubstatus();
  verifyMembershipUpdatedDecidesByStatus();
  verifyAdapterCredentialGuards();
  verifyTriageAcknowledges();
  console.log(`\nRESULTADO: OK — ${passedAssertions} aserciones superadas.`);
}

main();
