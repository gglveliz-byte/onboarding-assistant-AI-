/**
 * @archivo src/modules/04-billing-and-whop/application/webhook-payload.parser.ts
 * @modulo 04-billing-and-whop (Parser del Payload Real de Webhooks de la Pasarela de Cobros)
 * @proposito
 *   Convierte el cuerpo crudo de un webhook —ya verificado criptograficamente— en el payload tipado
 *   que esperan los casos de uso. Resuelve los tres fallos que impedian procesar un evento legitimo:
 *
 *   1. NOMBRES DE EVENTO. El receptor solo aceptaba `membership.went_valid` y `membership.went_invalid`,
 *      nombres de la API v2/v5 ya deprecada. La pasarela actual emite `membership.activated`,
 *      `membership.deactivated` y `membership.updated`, y este ultimo reenvia tambien la activacion,
 *      asi que la validez se decide leyendo `data.status`, no el nombre del evento.
 *
 *   2. METADATOS ANIDADOS. La pasarela copia la metadata del checkout en la membresia y en el pago,
 *      pero dentro del objeto `metadata`. El anterior parser aplana `data` y busca `organization_id` e
 *      `internal_plan_code` en la raiz, donde nunca aparecen: todo evento legitimo se rechazaba con
 *      "El webhook no declara la organizacion". Aqui se desanida `data.metadata` antes de leer.
 *
 *   3. OBJETOS MONETARIOS. El importe no viene como numero suelto sino como
 *      `{ amount, currency, decimals, display_decimals }`, y `amount` llega como cadena con dos
 *      decimales. Se leen ambos formatos y se exige que la moneda sea USD antes de acreditar nada.
 *
 *   Se conservan ademas las tolerancias legacy (`camelCase`, campos en la raiz, marcas en segundos)
 *   porque un webhook antiguo sigue entregando eventos mientras exista.
 *
 * @resumen_contenido
 *   - Clase `WhopWebhookPayloadParser`:
 *       * `normalizeEventName()`: Alias legacy y nombres canonicos actuales.
 *       * `extractEventData()`: Desenvelope y desanidamiento de `data` y `data.metadata`.
 *       * `membershipStatusIsCurrent()` / `parseMembershipChange()`: Alta o morosidad segun `status`.
 *       * `parseMembershipValid()` / `parseMembershipInvalid()`: Payloads tipados de membresia.
 *       * `parsePaymentSucceeded()`: Payload del pago, con verificacion de moneda y `substatus`.
 *   - Funcion `readTextField()` y funcion `readAmountField()`: Lectura tolerante entre varios alias.
 *
 * @dependencias_internas
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`) para normalizar importes a 6 decimales.
 *   - `ValidationError` (`src/shared/kernel/result-and-errors.ts`) para cuerpos invalidos.
 *   - Tipos del dominio (`../domain/billing-whop.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Parser puro: no realiza llamadas de red ni consultas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (Los payloads alimentan sus mutaciones).
 */

import { DecimalMath } from '../../../shared/kernel/decimal.util';
import { ValidationError } from '../../../shared/kernel/result-and-errors';
import type {
  BillingPlanCode,
  MembershipWentInvalidPayload,
  MembershipWentValidPayload,
  PaymentSucceededPayload,
  SupportedWebhookEventName,
} from '../domain/billing-whop.types';

/** Meses por defecto que se asumen cuando el emisor no declara el fin del periodo. */
const DAYS_PER_BILLING_PERIOD = 30;

/** Milisegundos que componen un dia. */
const MILLISECONDS_PER_DAY = 86400000;

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/** Umbral por debajo del cual una marca numerica se interpreta como segundos del epoch. */
const SECONDS_EPOCH_THRESHOLD = 100_000_000_000;

/** Estados de membresia que conceden acceso vigente en la API actual. */
const CURRENT_MEMBERSHIP_STATUSES: readonly string[] = ['active', 'trialing'];

/** Importe que se devuelve cuando el emisor no declara ninguno. */
const ZERO_AMOUNT = '0.000000';

/** Moneda que la plataforma factura; cualquier otra se rechaza en lugar de converirla a ciegas. */
const SUPPORTED_CURRENCY = 'usd';

/** Determina si un valor desconocido es un registro indexable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lee un campo de texto probando varios alias, tolerando las variantes de nomenclatura del emisor.
 * Un objeto monetario `{ amount, ... }` tambien se acepta leyendo su campo `amount`.
 *
 * @param source - Objeto del que se lee el campo.
 * @param fieldNames - Nombres alternativos aceptados, en orden de preferencia.
 * @returns Texto no vacio encontrado, o `null` cuando ningun alias tiene valor util.
 */
export function readTextField(source: Readonly<Record<string, unknown>>, fieldNames: readonly string[]): string | null {
  for (const fieldName of fieldNames) {
    const value = source[fieldName];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (isRecord(value) && typeof value['amount'] === 'string' && value['amount'].length > 0) {
      return value['amount'];
    }
  }
  return null;
}

/**
 * Convierte una marca temporal del emisor a ISO 8601.
 * La API actual entrega cadenas ISO; la legacy entrega segundos del epoch como numero.
 *
 * @param value - Valor crudo encontrado en el payload.
 * @returns Fecha en ISO 8601, o `null` cuando el valor no representa un instante valido.
 */
function toIsoString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < SECONDS_EPOCH_THRESHOLD ? value * MILLISECONDS_PER_SECOND : value;
    return new Date(millis).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Lee un importe monetario y lo normaliza a la representacion decimal de 6 cifras.
 * Acepta numero suelto, cadena decimal y el objeto monetario `{ amount, currency }` de la API actual.
 *
 * @param source - Objeto del que se lee el importe.
 * @param fieldNames - Nombres alternativos aceptados, en orden de preferencia.
 * @returns Importe normalizado, o `0.000000` cuando el emisor no lo declara.
 * @throws ValidationError cuando el importe declarado tiene un formato invalido.
 */
export function readAmountField(source: Readonly<Record<string, unknown>>, fieldNames: readonly string[]): string {
  for (const fieldName of fieldNames) {
    const value = source[fieldName];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return DecimalMath.fromNumber(value, 'importe cobrado');
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return DecimalMath.formatFixed6(value.trim(), 'importe cobrado');
    }
    if (isRecord(value)) {
      const nested = readAmountField(value, ['amount', 'value']);
      if (nested !== ZERO_AMOUNT) {
        return nested;
      }
    }
  }
  return ZERO_AMOUNT;
}

/**
 * Extrae la moneda declarada por un campo monetario del emisor.
 *
 * @param source - Objeto del que se lee la moneda.
 * @returns Codigo ISO en minusculas, o `null` cuando el emisor no la declara.
 */
function readCurrency(source: Readonly<Record<string, unknown>>): string | null {
  const candidates: readonly unknown[] = [source['currency'], isRecord(source['total']) ? source['total']['currency'] : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length >= 3) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

/**
 * Parser del payload real de los webhooks de la pasarela de cobros.
 * Todos los metodos son estaticos y puros: no mantienen estado entre eventos.
 */
export class WhopWebhookPayloadParser {
  /**
   * Normaliza el nombre del evento declarado por el emisor.
   * Admite los nombres canonicos actuales y los alias legacy de la API v2/v5.
   *
   * @param rawEventName - Nombre crudo declarado en el cuerpo (`type`).
   * @returns Nombre canonico del evento.
   * @throws ValidationError cuando el evento no esta soportado.
   */
  public static normalizeEventName(rawEventName: string): SupportedWebhookEventName {
    const normalized = rawEventName.trim().toLowerCase();
    switch (normalized) {
      case 'membership.activated':
      case 'membership.went_valid':
        return 'membership.activated';
      case 'membership.deactivated':
      case 'membership.went_invalid':
        return 'membership.deactivated';
      case 'membership.updated':
        return 'membership.updated';
      case 'payment.succeeded':
        return 'payment.succeeded';
      default:
        throw new ValidationError(`Evento de cobro no soportado: "${rawEventName}".`);
    }
  }

  /**
   * Deserializa el cuerpo crudo del webhook y extrae el objeto de datos del evento.
   *
   * Aplana en este orden, de menor a mayor prioridad: envelope, `data`, `data.metadata`, `metadata`.
   * El desanidamiento de `metadata` es imprescindible: la pasarela copia alli los campos que la
   * plataforma inyecta al crear el checkout (`organization_id`, `internal_plan_code`), y sin ellos no
   * hay forma de saber a que organizacion acreditar el cobro.
   *
   * @param rawBodyBuffer - Cuerpo crudo ya verificado criptograficamente.
   * @returns Objeto de datos del evento, con la metadata promotions a la raiz.
   * @throws ValidationError cuando el cuerpo no es un objeto JSON.
   */
  public static extractEventData(rawBodyBuffer: Buffer): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBodyBuffer.toString('utf8')) as unknown;
    } catch {
      throw new ValidationError('El cuerpo del webhook no es JSON valido.');
    }

    if (!isRecord(parsed)) {
      throw new ValidationError('El cuerpo del webhook debe ser un objeto JSON.');
    }
    return WhopWebhookPayloadParser.flattenVerifiedPayload(parsed as Record<string, unknown>);
  }

  /**
   * Aplana un sobre de webhook ya verificado y deserializado por el helper oficial.
   *
   * Es la via normal en produccion: `unwrapWebhook` ya devolvio el objeto parseado sobre los bytes
   * exactos del cuerpo, y volver a serializar y parsear el buffer seria redundante.
   *
   * @param envelope - Sobre del evento tal como lo entrego el helper.
   * @returns Datos del evento con la metadata del checkout promotions a la raiz.
   */
  public static flattenVerifiedPayload(envelope: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const dataSection = isRecord(envelope['data']) ? (envelope['data'] as Record<string, unknown>) : {};
    const dataMetadata = isRecord(dataSection['metadata']) ? (dataSection['metadata'] as Record<string, unknown>) : {};
    const envelopeMetadata = isRecord(envelope['metadata']) ? (envelope['metadata'] as Record<string, unknown>) : {};

    return { ...envelope, ...dataSection, ...envelopeMetadata, ...dataMetadata };
  }

  /**
   * Decide si una membresia esta vigente a partir de su estado declarado.
   *
   * Se usa sobre todo con `membership.updated`, que la pasarela envia tanto en altas como en bajas:
   * el nombre del evento no dice nada y la decision depende exclusivamente de `status`.
   *
   * @param data - Objeto de datos ya desanidado.
   * @returns `true` cuando el estado concede acceso vigente.
   */
  public static membershipStatusIsCurrent(data: Readonly<Record<string, unknown>>): boolean {
    const status = readTextField(data, ['status', 'membership_status', 'access_status']);
    if (status === null) {
      // Sin estado declarado se mira el booleano legacy `valid`; a falta de ambos, no se da de alta.
      return data['valid'] === true;
    }
    return CURRENT_MEMBERSHIP_STATUSES.includes(status.toLowerCase());
  }

  /**
   * Intenta leer la organizacion acreditada SIN lanzar: devuelve `null` cuando falta.
   *
   * Se necesita antes de tocar saldos para poder decidir entre "esto es un error del emisor y hay que
   * reintentar" y "este evento legitimately no tiene titularidad, acusar recibo y seguir".
   *
   * @param data - Objeto de datos del evento ya desanidado.
   * @returns Identificador de organizacion, o `null` cuando el evento no la declara.
   */
  public static readOrganizationIdOrNothing(data: Readonly<Record<string, unknown>>): string | null {
    return readTextField(data, ['organization_id', 'organizationId', 'org_id', 'orgId']);
  }

  /**
   * Extrae el identificador de organizacion, obligatorio en los tres eventos soportados.
   *
   * @param data - Objeto de datos del evento ya desanidado.
   * @returns Identificador de la organizacion.
   * @throws ValidationError cuando el evento no declara la organizacion en sus metadatos.
   */
  public static requireOrganizationId(data: Readonly<Record<string, unknown>>): string {
    const organizationId = readTextField(data, ['organization_id', 'organizationId', 'org_id', 'orgId']);
    if (organizationId === null) {
      throw new ValidationError(
        'El webhook no declara la organizacion. La pasarela debio copiar en `metadata` la referencia ' +
          'interna inyectada al crear el checkout; sin ella no se puede acreditar el cobro.'
      );
    }
    return organizationId;
  }

  /**
   * Resuelve el codigo interno del plan desde la metadata firmada del checkout.
   *
   * @param data - Objeto de datos del evento ya desanidado.
   * @returns Codigo de plan del catalogo interno.
   * @throws ValidationError cuando falta o no pertenece al catalogo.
   */
  public static requireInternalPlanCode(data: Readonly<Record<string, unknown>>): BillingPlanCode {
    const raw = readTextField(data, ['internal_plan_code', 'internalPlanCode', 'plan_code', 'planCode']);
    const normalized = (raw ?? '').trim().toUpperCase();
    const admitted: readonly string[] = ['PAYG', 'PLAN_5', 'PLAN_10', 'PLAN_30', 'PLAN_50', 'CUSTOM_ENTERPRISE'];
    if (!admitted.includes(normalized)) {
      throw new ValidationError(
        `El webhook declara un plan interno invalido ("${raw ?? 'AUSENTE'}"); se esperaba uno de ${admitted.join(', ')}.`
      );
    }
    return normalized as BillingPlanCode;
  }

  /**
   * Construye el payload tipado de una activacion de membresia.
   *
   * @param data - Objeto de datos del evento.
   * @returns Payload de activacion con la organizacion y el plan resueltos.
   * @throws ValidationError cuando falta la organizacion, la membresia o el codigo interno del plan.
   */
  public static parseMembershipValid(data: Readonly<Record<string, unknown>>): MembershipWentValidPayload {
    const organizationId = WhopWebhookPayloadParser.requireOrganizationId(data);
    const membershipId = readTextField(data, ['membership_id', 'membershipId', 'id']);
    const internalPlanCode = WhopWebhookPayloadParser.requireInternalPlanCode(data);

    if (membershipId === null) {
      throw new ValidationError('El evento de activacion debe declarar el identificador de la membresia.');
    }

    const startIso = toIsoString(data['current_period_start'] ?? data['period_start'] ?? data['periodStart'] ?? data['renewal_period_start']);
    const endIso = toIsoString(data['current_period_end'] ?? data['period_end'] ?? data['periodEnd'] ?? data['renewal_period_end']);

    return {
      eventId: readTextField(data, ['event_id', 'eventId', 'id']) ?? membershipId,
      membershipId,
      externalPlanId: readTextField(data, ['plan_id', 'planId', 'externalPlanId']) ?? '',
      internalPlanCode,
      organizationId,
      externalUserId: readTextField(data, ['user_id', 'userId']),
      periodStartIso: startIso ?? new Date().toISOString(),
      periodEndIso: endIso ?? new Date(Date.now() + DAYS_PER_BILLING_PERIOD * MILLISECONDS_PER_DAY).toISOString(),
    };
  }

  /**
   * Construye el payload tipado de una invalidacion de membresia.
   *
   * @param data - Objeto de datos del evento.
   * @returns Payload de invalidacion con el motivo declarado.
   * @throws ValidationError cuando falta la organizacion.
   */
  public static parseMembershipInvalid(data: Readonly<Record<string, unknown>>): MembershipWentInvalidPayload {
    const organizationId = WhopWebhookPayloadParser.requireOrganizationId(data);
    const membershipId = readTextField(data, ['membership_id', 'membershipId', 'id']) ?? '';

    return {
      eventId: readTextField(data, ['event_id', 'eventId', 'id']) ?? membershipId,
      membershipId,
      organizationId,
      reason:
        readTextField(data, ['reason', 'cancellation_reason', 'cancelReason', 'status', 'substatus']) ?? 'MOTIVO_NO_DECLARADO',
      occurredAtIso: toIsoString(data['occurred_at'] ?? data['canceled_at'] ?? data['updated_at']) ?? new Date().toISOString(),
    };
  }

  /**
   * Construye el payload tipado de un pago confirmado.
   *
   * Verifica antes de acreditar, como exige el standard de la pasarela: la moneda debe ser USD y el
   * `substatus` del pago debe ser `succeeded`. Un pago `pending` o `requires_action` que llegara por
   * esta via no debe sumar saldo.
   *
   * @param data - Objeto de datos del evento.
   * @returns Payload del pago con su importe normalizado y su naturaleza resuelta.
   * @throws ValidationError cuando falta la organizacion, la moneda no es USD o el pago no esta liquidado.
   */
  public static parsePaymentSucceeded(data: Readonly<Record<string, unknown>>): PaymentSucceededPayload {
    const organizationId = WhopWebhookPayloadParser.requireOrganizationId(data);
    const paymentId = readTextField(data, ['payment_id', 'paymentId', 'id']) ?? '';

    const substatus = readTextField(data, ['substatus', 'payment_substatus']);
    if (substatus !== null && substatus.toLowerCase() !== 'succeeded') {
      throw new ValidationError(`El pago ${paymentId} no esta liquidado: substatus declarado "${substatus}".`);
    }

    const currency = readCurrency(data);
    if (currency !== null && currency !== SUPPORTED_CURRENCY) {
      throw new ValidationError(
        `El pago ${paymentId} esta expresado en "${currency}" y la plataforma solo factura en ${SUPPORTED_CURRENCY.toUpperCase()}.`
      );
    }

    const declaredKind = (readTextField(data, ['payment_kind', 'paymentKind', 'kind', 'billing_reason']) ?? '').toUpperCase();
    const checkoutMode = (readTextField(data, ['checkout_mode', 'checkoutMode']) ?? '').toUpperCase();
    const paymentKind = WhopWebhookPayloadParser.resolvePaymentKind(declaredKind, checkoutMode);

    const startIso = toIsoString(data['period_start'] ?? data['current_period_start'] ?? data['created_at']);
    const endIso = toIsoString(data['period_end'] ?? data['current_period_end']);

    return {
      eventId: readTextField(data, ['event_id', 'eventId']) ?? `msg_${paymentId}`,
      paymentId,
      membershipId: readTextField(data, ['membership_id', 'membershipId']),
      organizationId,
      amountUsd: readAmountField(data, ['amount_usd', 'usd_total', 'total', 'amount']),
      paymentKind,
      periodStartIso: paymentKind === 'TOP_UP' ? null : startIso,
      periodEndIso: paymentKind === 'TOP_UP' ? null : endIso,
    };
  }

  /**
   * Clasifica el cobro como recarga de saldo o como pago ciclico de suscripcion.
   *
   * La pasarela no tiene un campo propio "recarga": la distingue la metadata del checkout. Se da
   * prioridad a esa metadata porque es la intencion expresada por el comprador al iniciar el pago,
   * y solo en su ausencia se recurre al `billing_reason` del propio pago.
   *
   * @param declaredKind - `payment_kind` o `billing_reason` declarado por el emisor.
   * @param checkoutMode - `checkout_mode` copiado desde la metadata del checkout.
   * @returns Naturaleza del cobro.
   */
  private static resolvePaymentKind(declaredKind: string, checkoutMode: string): PaymentSucceededPayload['paymentKind'] {
    if (checkoutMode === 'TOP_UP' || declaredKind === 'TOP_UP' || declaredKind === 'TOPUP') {
      return 'TOP_UP';
    }
    if (declaredKind === 'INITIAL' || declaredKind === 'SUBSCRIPTION_CREATE' || declaredKind === 'FIRST_PAYMENT') {
      return 'INITIAL';
    }
    return 'RENEWAL';
  }
}
