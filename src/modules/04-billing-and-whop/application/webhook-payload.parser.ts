/**
 * @archivo src/modules/04-billing-and-whop/application/webhook-payload.parser.ts
 * @modulo 04-billing-and-whop (Parser Defensivo de Payloads de Webhook de la Pasarela)
 * @proposito
 *   Convierte el cuerpo crudo de un webhook —ya verificado criptograficamente— en el payload tipado
 *   que esperan los casos de uso. La pasarela no garantiza la forma exacta de su JSON: los campos
 *   pueden venir en `camelCase` o `snake_case`, anidados bajo `data` o en la raiz. Este parser acepta
 *   ambas formas, valida los campos obligatorios y normaliza los importes con `DecimalMath`, de modo
 *   que un cambio de version del emisor produzca un error explicito en lugar de un saldo corrupto.
 *
 * @resumen_contenido
 *   - Clase `WhopWebhookPayloadParser`: Metodos estaticos de normalizacion y validacion.
 *   - Funcion `readTextField()`: Lectura tolerante de un campo de texto entre varios alias.
 *   - Funcion `readAmountField()`: Lectura y normalizacion de un importe monetario.
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

/**
 * Lee un campo de texto probando varios alias, tolerando las variantes de nomenclatura del emisor.
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
  }
  return null;
}

/**
 * Lee un importe monetario y lo normaliza a la representacion decimal de 6 cifras.
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
  }
  return '0.000000';
}

/**
 * Parser defensivo de los payloads de webhook de la pasarela de cobros.
 * Todos los metodos son estaticos y puros: no mantienen estado entre eventos.
 */
export class WhopWebhookPayloadParser {
  /**
   * Normaliza el nombre del evento declarado por el emisor.
   *
   * @param rawEventName - Nombre crudo declarado en el encabezado o el cuerpo.
   * @returns Nombre canonico del evento.
   * @throws ValidationError cuando el evento no esta soportado.
   */
  public static normalizeEventName(rawEventName: string): SupportedWebhookEventName {
    const normalized = rawEventName.trim().toLowerCase();
    if (normalized === 'membership.went_valid' || normalized === 'membership.went_invalid' || normalized === 'payment.succeeded') {
      return normalized;
    }
    throw new ValidationError(`Evento de cobro no soportado: "${rawEventName}".`);
  }

  /**
   * Deserializa el cuerpo crudo del webhook y extrae el objeto de datos del evento.
   * Los emisores suelen anidar la carga bajo la propiedad `data`; cuando no lo hacen, se usa la raiz.
   *
   * @param rawBodyBuffer - Cuerpo crudo ya verificado criptograficamente.
   * @returns Objeto de datos del evento.
   * @throws ValidationError cuando el cuerpo no es un objeto JSON.
   */
  public static extractEventData(rawBodyBuffer: Buffer): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBodyBuffer.toString('utf8')) as unknown;
    } catch {
      throw new ValidationError('El cuerpo del webhook no es JSON valido.');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('El cuerpo del webhook debe ser un objeto JSON.');
    }

    const record = parsed as Record<string, unknown>;
    const nestedData = record['data'];
    if (typeof nestedData === 'object' && nestedData !== null && !Array.isArray(nestedData)) {
      return { ...record, ...(nestedData as Record<string, unknown>) };
    }
    return record;
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
    const internalPlanCode = readTextField(data, ['internal_plan_code', 'internalPlanCode']);

    if (membershipId === null) {
      throw new ValidationError('El evento de activacion debe declarar el identificador de la membresia.');
    }
    if (internalPlanCode === null) {
      throw new ValidationError('El evento de activacion debe declarar el codigo interno del plan.');
    }

    return {
      eventId: readTextField(data, ['event_id', 'eventId']) ?? membershipId,
      membershipId,
      externalPlanId: readTextField(data, ['plan_id', 'planId', 'externalPlanId']) ?? '',
      internalPlanCode: internalPlanCode as BillingPlanCode,
      organizationId,
      externalUserId: readTextField(data, ['user_id', 'userId']),
      periodStartIso: readTextField(data, ['period_start', 'periodStart']) ?? new Date().toISOString(),
      periodEndIso:
        readTextField(data, ['period_end', 'periodEnd']) ??
        new Date(Date.now() + DAYS_PER_BILLING_PERIOD * MILLISECONDS_PER_DAY).toISOString(),
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
      eventId: readTextField(data, ['event_id', 'eventId']) ?? membershipId,
      membershipId,
      organizationId,
      reason: readTextField(data, ['reason', 'cancellation_reason', 'cancelReason']) ?? 'MOTIVO_NO_DECLARADO',
      occurredAtIso: readTextField(data, ['occurred_at', 'occurredAt']) ?? new Date().toISOString(),
    };
  }

  /**
   * Construye el payload tipado de un pago confirmado.
   *
   * @param data - Objeto de datos del evento.
   * @returns Payload del pago con su importe normalizado y su naturaleza resuelta.
   * @throws ValidationError cuando falta la organizacion o el importe tiene formato invalido.
   */
  public static parsePaymentSucceeded(data: Readonly<Record<string, unknown>>): PaymentSucceededPayload {
    const organizationId = WhopWebhookPayloadParser.requireOrganizationId(data);
    const paymentId = readTextField(data, ['payment_id', 'paymentId', 'id']) ?? '';
    const rawPaymentKind = (readTextField(data, ['payment_kind', 'paymentKind', 'kind']) ?? 'RENEWAL').toUpperCase();

    return {
      eventId: readTextField(data, ['event_id', 'eventId']) ?? paymentId,
      paymentId,
      membershipId: readTextField(data, ['membership_id', 'membershipId']),
      organizationId,
      amountUsd: readAmountField(data, ['amount_usd', 'amount', 'total']),
      paymentKind: rawPaymentKind === 'TOP_UP' ? 'TOP_UP' : rawPaymentKind === 'INITIAL' ? 'INITIAL' : 'RENEWAL',
      periodStartIso: readTextField(data, ['period_start', 'periodStart']),
      periodEndIso: readTextField(data, ['period_end', 'periodEnd']),
    };
  }

  /**
   * Extrae el identificador de organizacion, obligatorio en los tres eventos soportados.
   *
   * @param data - Objeto de datos del evento.
   * @returns Identificador de la organizacion.
   * @throws ValidationError cuando el evento no declara la organizacion.
   */
  private static requireOrganizationId(data: Readonly<Record<string, unknown>>): string {
    const organizationId = readTextField(data, ['organization_id', 'organizationId', 'org_id', 'orgId']);
    if (organizationId === null) {
      throw new ValidationError('El webhook no declara la organizacion en sus metadatos firmados.');
    }
    return organizationId;
  }
}
