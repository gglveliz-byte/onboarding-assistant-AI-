/**
 * @archivo src/modules/04-billing-and-whop/application/webhook-intake.triage.ts
 * @modulo 04-billing-and-whop (Triage de un Webhook Verificado, antes de tocar dinero)
 * @proposito
 *   Decide QUE se hace con un evento cuya firma ya valido el helper oficial, antes de que cualquier
 *   caso de use moviera un saldo. La decision no es obvia y confundirla cuesta dinero o cuesta ruido
 *   infinito:
 *
 *   - Un evento con firma INVALIDA es un asunto de seguridad: se rechaza con 401 y eso no se negocia.
 *   - Un evento con firma VALIDA pero de nombre desconocido, o sin organizacion acreditada, NO debe
 *     rechazarse con 4xx: la pasarela reintenta todo lo que no sea 2xx, y un evento que esta plataforma
 *     nunca va a procesar se convierte en una tormenta de reintentos perpetua. Se acusa recibo.
 *   - Un fallo de infraestructura o de catalogo (plan inexistente, base de datos indisponible) SI debe
 *     propagarse, porque ahi el reintento es lo correcto.
 *
 *   La titularidad se pierde en la metadata que la propia pasarela copia del checkout que nosotros
 *   creamos. Un pago nacido de un enlace publico de la tienda, una prueba disparada desde el panel de
 *   la pasarela o una membresia creada fuera de nuestro flujo legamente no traen organizacion: no hay a
 *   quien acreditarles nada, y adivinarlo seria regalar minutos.
 *
 * @resumen_contenido
 *   - Tipo `WebhookIntakeDecision`: los tres destinos posibles de un evento verificado.
 *   - Funcion `triageVerifiedWebhook()`: normaliza nombre, resuelve identificador y mide titularidad.
 *
 * @dependencias_internas
 *   - `WhopWebhookPayloadParser` (`./webhook-payload.parser.ts`).
 *   - Tipos del dominio (`../domain/billing-whop.types.ts`).
 *   - `ValidationError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Triage puro: sin red, sin base de datos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (No persiste; solo clasifica).
 */

import { ValidationError } from '../../../shared/kernel/result-and-errors';
import type { SupportedWebhookEventName } from '../domain/billing-whop.types';
import { WhopWebhookPayloadParser } from './webhook-payload.parser';

/** Nombre que se reporta cuando el evento no pertenece al contrato de esta plataforma. */
const UNKNOWN_EVENT_PLACEHOLDER: SupportedWebhookEventName = 'payment.succeeded';

/** Destino de un webhook cuya firma ya fue verificada. */
export type WebhookIntakeDecision =
  | {
      /** Se procesa normally: hay titularidad y el evento es conocido. */
      readonly kind: 'process';
      readonly eventName: SupportedWebhookEventName;
      readonly eventId: string;
      readonly eventData: Readonly<Record<string, unknown>>;
    }
  | {
      /** Se acusa recibo con 2xx sin mover saldo: nunca habra reintento util. */
      readonly kind: 'acknowledge';
      readonly eventName: SupportedWebhookEventName;
      readonly eventId: string;
      readonly appliedAction: string;
    };

/**
 * Clasifica el sobre de un webhook ya verificado criptograficamente.
 *
 * @param envelope - Sobre del evento deserializado por el helper oficial.
 * @param headerEventId - Valor de la cabecera `webhook-id`, fuente primaria del identificador.
 * @throws ValidationError cuando el evento no declara identificador: sin el no hay idempotencia posible.
 * @returns Decision de triage.
 */
export function triageVerifiedWebhook(
  envelope: Readonly<Record<string, unknown>>,
  headerEventId: string
): WebhookIntakeDecision {
  const rawEventName = typeof envelope['type'] === 'string' ? envelope['type'] : '';

  let eventName: SupportedWebhookEventName;
  try {
    eventName = WhopWebhookPayloadParser.normalizeEventName(rawEventName);
  } catch {
    return {
      kind: 'acknowledge',
      eventName: UNKNOWN_EVENT_PLACEHOLDER,
      eventId: headerEventId.length > 0 ? headerEventId : 'sin-id',
      appliedAction: `EVENTO_NO_RECONOCIDO:${rawEventName || 'SIN_TIPO'}`,
    };
  }

  const eventId = headerEventId.length > 0
    ? headerEventId
    : (typeof envelope['id'] === 'string' ? envelope['id'] : '');
  if (eventId.length === 0) {
    throw new ValidationError('El webhook no declara identificador de evento; no puede aplicarse idempotencia.');
  }

  const eventData = WhopWebhookPayloadParser.flattenVerifiedPayload(envelope);
  if (WhopWebhookPayloadParser.readOrganizationIdOrNothing(eventData) === null) {
    return {
      kind: 'acknowledge',
      eventName,
      eventId,
      appliedAction: 'EVENTO_SIN_ORGANIZACION_ACUSE_RECIBIDO',
    };
  }

  return { kind: 'process', eventName, eventId, eventData };
}
