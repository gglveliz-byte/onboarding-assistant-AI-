/**
 * @archivo src/modules/04-billing-and-whop/domain/billing-whop.types.ts
 * @modulo 04-billing-and-whop (Tipos y Contratos del Dominio de Facturacion)
 * @proposito
 *   Declara los tipos puros del dominio de cobros —planes, tramos de descuento, suscripciones,
 *   asientos contables, metadatos firmados de pago y payloads de los eventos de la pasarela— sin
 *   contener una sola linea de logica. Mantener los tipos separados de las funciones permite que
 *   cualquier capa los importe sin arrastrar dependencias de calculo.
 *
 * @resumen_contenido
 *   - Tipos `BillingPlanCode`, `WhopSubscriptionStatus`, `LedgerEntryType`, `CheckoutMode`.
 *   - Interfaces `VolumeDiscountTier`, `PricingPlanConfig`, `OrganizationPricingOverride`.
 *   - Interfaces `WhopSubscriptionState` y `UsageLedgerEntry` (espejo de las tablas de PostgreSQL).
 *   - Interface `CheckoutSignedMetadata`: Metadatos firmados con HMAC del enlace de pago.
 *   - Interfaces de payload y mapa `WhopWebhookEventMap` de los tres eventos soportados.
 *
 * @dependencias_internas
 *   - `Fixed6String` (`src/shared/kernel/decimal.util.ts`) como unica dependencia de tipos.
 *
 * @dependencias_externas
 *   - Ninguna (Contratos puros: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `organization_pricing_overrides`, `whop_subscriptions`
 *     y `usage_ledger` (estos tipos son el espejo tipado de sus columnas).
 */

import type { Fixed6String } from '../../../shared/kernel/decimal.util';

/** Codigos de plan oficiales, alineados con el tipo `billing_plan_code_enum` de PostgreSQL. */
export type BillingPlanCode = 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50' | 'CUSTOM_ENTERPRISE';

/** Estados del ciclo de vida de una suscripcion, alineados con `whop_sub_status_enum`. */
export type WhopSubscriptionStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE_OR_INVALID' | 'CANCELED' | 'SUSPENDED';

/** Tipos de asiento contable, alineados con `ledger_entry_type_enum`. */
export type LedgerEntryType =
  | 'PLAN_ACTIVATION_GRANT'
  | 'PAYMENT_SUCCEEDED_RENEWAL'
  | 'PAYMENT_SUCCEEDED_TOPUP'
  | 'VOICE_MINUTE_DEDUCTION'
  | 'CREDIT_SUPERADMIN_GRANT'
  | 'MANUAL_ADJUSTMENT'
  | 'REFUND_REVERSAL';

/** Modalidad de cobro solicitada al abrir un enlace de pago. */
export type CheckoutMode = 'SUBSCRIPTION' | 'TOP_UP' | 'PAY_AS_YOU_GO';

/** Tramo escalonado de descuento por volumen de consumo excedente. */
export interface VolumeDiscountTier {
  /** Numero de tramo, empezando en 1. */
  readonly tier: number;
  /** Minutos de exceso (inclusive) a partir de los que aplica el tramo. */
  readonly minOveragesMinutes: Fixed6String;
  /** Minutos de exceso (inclusive) hasta los que aplica el tramo; `null` significa sin techo. */
  readonly maxOveragesMinutes: Fixed6String | null;
  /** Porcentaje de descuento aplicado dentro del tramo. */
  readonly discountPercent: Fixed6String;
}

/** Configuracion de un plan de precios publicada por el gobierno de la plataforma. */
export interface PricingPlanConfig {
  /** Codigo del plan. */
  readonly planCode: BillingPlanCode;
  /** Identificador del plan en la pasarela de cobros. */
  readonly externalPlanId: string;
  /** Nombre comercial mostrado en la landing y los paneles. */
  readonly displayName: string;
  /** Cuota fija mensual en USD. */
  readonly monthlyFixedPriceUsd: Fixed6String;
  /** Minutos de voz incluidos en el periodo. */
  readonly includedMinutes: Fixed6String;
  /** Tarifa base por minuto excedente en USD. */
  readonly baseOverageRatePerMinuteUsd: Fixed6String;
  /** Indica si el plan permite consumo por encima de la cuota incluida. */
  readonly overageAllowed: boolean;
  /** Indica si el plan participa del escalafon de descuento por volumen. */
  readonly volumeDiscountEligible: boolean;
  /** Tramos de descuento por volumen, vacios cuando el plan no es elegible. */
  readonly volumeDiscountTiers: readonly VolumeDiscountTier[];
  /** Importe bruto cobrado en la pasarela (neto + comision). `null` si no esta aprovisionado. */
  readonly grossPriceUsd: Fixed6String | null;
  /** `true` cuando `externalPlanId` es un plan real y vivo de la pasarela. */
  readonly isProvisioned: boolean;
}

/** Override de precios otorgado manualmente por el SuperAdmin a una organizacion. */
export interface OrganizationPricingOverride {
  /** Tarifa por minuto impuesta por el operador; `null` cuando no se sobrescribe. */
  readonly customRatePerMinuteUsd: Fixed6String | null;
  /** Descuento manual en porcentaje, aplicado despues del tramo por volumen. */
  readonly manualDiscountPercentage: Fixed6String;
  /** Indica si la organizacion recibe los tramos de volumen aunque su plan no sea elegible. */
  readonly forceVolumeDiscountTiers: boolean;
  /** Tramos personalizados que sustituyen a los del plan; `null` cuando no se personalizan. */
  readonly customVolumeTiers: readonly VolumeDiscountTier[] | null;
  /** Motivo obligatorio del override, conservado para la auditoria. */
  readonly overrideNotes: string;
  /** Inicio de vigencia del override. */
  readonly effectiveFromIso: string;
  /** Fin de vigencia del override; `null` significa vigente indefinidamente. */
  readonly effectiveUntilIso: string | null;
}

/** Estado completo de la suscripcion de una organizacion (espejo de `whop_subscriptions`). */
export interface WhopSubscriptionState {
  /** Identificador de la suscripcion. */
  readonly subscriptionId: string;
  /** Organizacion propietaria. */
  readonly organizationId: string;
  /** Plan vigente. */
  readonly planCode: BillingPlanCode;
  /** Estado del ciclo de vida. */
  readonly status: WhopSubscriptionStatus;
  /** Identificador de la membresia en la pasarela; `null` antes de la primera activacion. */
  readonly externalMembershipId: string | null;
  /** Inicio del periodo de facturacion vigente. */
  readonly currentPeriodStartIso: string;
  /** Fin del periodo de facturacion vigente. */
  readonly currentPeriodEndIso: string;
  /** Cuota de minutos incluidos del periodo. */
  readonly periodIncludedMinutesQuota: Fixed6String;
  /** Minutos incluidos disponibles del periodo. */
  readonly periodIncludedMinutesRemaining: Fixed6String;
  /** Minutos de exceso consumidos en el periodo. */
  readonly periodOverageMinutesUsed: Fixed6String;
  /** Importe facturado por exceso en el periodo. */
  readonly currentPeriodOverageBilledUsd: Fixed6String;
  /** Saldo de credito prepagado en USD. */
  readonly creditBalanceUsd: Fixed6String;
  /** Tope de gasto duro del periodo; `null` cuando no se configura. */
  readonly hardSpendCapUsd: Fixed6String | null;
  /** Indica si la recarga automatica de saldo esta habilitada. */
  readonly autoTopUpEnabled: boolean;
  /** Ultimo evento de webhook aplicado, usado para auditoria. */
  readonly lastExternalEventId: string | null;
}

/** Asiento inmutable del libro mayor contable (espejo de `usage_ledger`). */
export interface UsageLedgerEntry {
  /** Organizacion afectada. */
  readonly organizationId: string;
  /** Proyecto afectado, cuando el asiento proviene de una sesion de voz. */
  readonly projectId: string | null;
  /** Suscripcion afectada, cuando el asiento modifica el saldo del periodo. */
  readonly subscriptionId: string | null;
  /** Identificador del evento externo que origino el asiento, unico para idempotencia. */
  readonly externalEventId: string | null;
  /** Identificador del pago en la pasarela, cuando aplica. */
  readonly externalPaymentId: string | null;
  /** Naturaleza contable del asiento. */
  readonly entryType: LedgerEntryType;
  /** Variacion de minutos (positiva al otorgar, negativa al consumir). */
  readonly minutesDelta: Fixed6String;
  /** Tarifa unitaria aplicada. */
  readonly unitRateUsd: Fixed6String;
  /** Porcentaje de descuento aplicado. */
  readonly discountAppliedPercent: Fixed6String;
  /** Variacion de importe en USD. */
  readonly amountUsdDelta: Fixed6String;
  /** Saldo de minutos incluidos despues del asiento. */
  readonly includedMinutesBalanceAfter: Fixed6String;
  /** Saldo de credito despues del asiento. */
  readonly creditBalanceUsdAfter: Fixed6String;
  /** Metadatos adicionales del asiento, ya depurados de datos sensibles. */
  readonly metadataJson: Readonly<Record<string, unknown>>;
}

/**
 * Metadatos firmados que viajan con un enlace de pago.
 * La firma impide que un cliente altere el plan, la organizacion o el importe: sin ella, cualquiera
 * podria reutilizar un enlace legitimo cambiando el identificador de organizacion.
 */
export interface CheckoutSignedMetadata {
  /** Organizacion que contrata. */
  readonly organizationId: string;
  /** Usuario que inicio la contratacion. */
  readonly actorUserId: string;
  /** Plan solicitado. */
  readonly internalPlanCode: BillingPlanCode;
  /** Modalidad de cobro: suscripcion, recarga o pago por uso. */
  readonly checkoutMode: CheckoutMode;
  /** Importe de la recarga en USD; `null` salvo en modo recarga. */
  readonly topUpAmountUsd: Fixed6String | null;
  /** Marca temporal de emision en milisegundos desde el epoch, usada contra la repeticion. */
  readonly issuedAtMs: number;
  /** Cadena que se firmo, conservada para poder verificarla de forma independiente. */
  readonly signedPayload: string;
  /** Firma HMAC-SHA256 en hexadecimal del `signedPayload`. */
  readonly signatureHex: string;
}

/** Payload del evento de membresia validada. */
export interface MembershipWentValidPayload {
  /** Identificador del evento, usado para la idempotencia. */
  readonly eventId: string;
  /** Identificador de la membresia en la pasarela. */
  readonly membershipId: string;
  /** Identificador del plan contratado en la pasarela. */
  readonly externalPlanId: string;
  /** Codigo interno del plan resuelto desde los metadatos firmados. */
  readonly internalPlanCode: BillingPlanCode;
  /** Organizacion resuelta desde los metadatos firmados. */
  readonly organizationId: string;
  /** Identificador del usuario en la pasarela; `null` cuando no lo declara. */
  readonly externalUserId: string | null;
  /** Inicio del periodo informado por la pasarela, en formato ISO 8601. */
  readonly periodStartIso: string;
  /** Fin del periodo informado por la pasarela, en formato ISO 8601. */
  readonly periodEndIso: string;
}

/** Payload del evento de membresia invalidada. */
export interface MembershipWentInvalidPayload {
  /** Identificador del evento, usado para la idempotencia. */
  readonly eventId: string;
  /** Identificador de la membresia en la pasarela. */
  readonly membershipId: string;
  /** Organizacion resuelta desde los metadatos firmados. */
  readonly organizationId: string;
  /** Motivo informado por la pasarela. */
  readonly reason: string;
  /** Marca temporal del evento, en formato ISO 8601. */
  readonly occurredAtIso: string;
}

/** Payload del evento de pago exitoso. */
export interface PaymentSucceededPayload {
  /** Identificador del evento, usado para la idempotencia. */
  readonly eventId: string;
  /** Identificador del pago en la pasarela. */
  readonly paymentId: string;
  /** Identificador de la membresia asociada; `null` cuando el cobro no es recurrente. */
  readonly membershipId: string | null;
  /** Organizacion resuelta desde los metadatos firmados. */
  readonly organizationId: string;
  /** Importe cobrado en USD. */
  readonly amountUsd: Fixed6String;
  /** Naturaleza del cobro: renovacion de suscripcion, recarga de saldo o primer pago. */
  readonly paymentKind: 'RENEWAL' | 'TOP_UP' | 'INITIAL';
  /** Inicio del nuevo periodo, en formato ISO 8601; `null` en las recargas. */
  readonly periodStartIso: string | null;
  /** Fin del nuevo periodo, en formato ISO 8601; `null` en las recargas. */
  readonly periodEndIso: string | null;
}

/** Mapa canonico `nombre de evento -> payload tipado` de la pasarela de cobros. */
export interface WhopWebhookEventMap {
  /** La membresia se activo: la suscripcion queda activa. Nombre real emitido por la pasarela. */
  'membership.activated': MembershipWentValidPayload;
  /** La membresia perdio vigencia (cancelacion, expiracion o impago): la suscripcion queda morosa. */
  'membership.deactivated': MembershipWentInvalidPayload;
  /**
   * Cambio de cualquier atributo de la membresia. La pasarela reenvia aqui tambien la activacion,
   * de modo que suscribiendose solo a este evento ya se cubre el ciclo completo: se decide el alta o
   * la morosidad leyendo `data.status`.
   */
  'membership.updated': MembershipWentValidPayload | MembershipWentInvalidPayload;
  /** Un pago se completo correctamente. */
  'payment.succeeded': PaymentSucceededPayload;
}

/** Nombres de evento soportados por el receptor de webhooks. */
export type WhopWebhookEventName = keyof WhopWebhookEventMap;

/**
 * Nombres canonicos de evento que el procesador de webhooks acepta.
 *
 * Los nombres legacy `membership.went_valid` y `membership.went_invalid` pertenecen a la API v2/v5,
 * deprecada con vencimiento el 13-nov-2026; la pasarela ya no los emite en las entregas actuales.
 * Se conservan como alias de entrada en el parser para no perder los reintentos en cola de un
 * webhook antiguo, pero el contrato nuevo es el de esta union.
 */
export type SupportedWebhookEventName =
  | 'membership.activated'
  | 'membership.deactivated'
  | 'membership.updated'
  | 'payment.succeeded';
