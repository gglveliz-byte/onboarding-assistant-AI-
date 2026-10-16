/**
 * @archivo src/modules/04-billing-and-whop/application/process-whop-webhook.use-case.ts
 * @modulo 04-billing-and-whop (Procesador Idempotente de Webhooks de la Pasarela de Cobros)
 * @proposito
 *   Aplica los eventos que emite la pasarela con doble garantia de idempotencia: una marca atomica
 *   en Redis (`SET NX EX`) que impide el procesamiento simultaneo en dos nodos, y el indice unico
 *   `usage_ledger.external_whop_event_id` que impide el asiento contable duplicado aunque la marca
 *   caduque. Cada mutacion de saldo ocurre bajo el bloqueo pesimista de la suscripcion, de modo que
 *   un reenvio del mismo evento o dos eventos concurrentes jamas dupliquen minutos ni importes.
 *
 * @resumen_contenido
 *   - Interface `WebhookProcessingOutcome`: Resultado del procesamiento con su estado de idempotencia.
 *   - Clase `ProcessWhopWebhookUseCase`:
 *       * `execute()`: Verifica la firma, reserva la idempotencia y despacha el evento.
 *       * `dispatchEvent()`: Enruta el evento a su manejador segun su nombre canonico.
 *       * `applyMembershipActivation()`: Activa la suscripcion y otorga los minutos del plan.
 *       * `applyMembershipInvalidation()`: Marca morosidad y congela los minutos incluidos.
 *       * `applyPaymentSucceeded()`: Renueva el cupo o suma saldo prepagado.
 *       * `appendLedgerEntry()`: Registra el asiento traduciendo la unicidad en conflicto controlado.
 *   - Funcion `createProcessWhopWebhookUseCase()`: Ensamblado desde las dependencias del modulo.
 *
 * @dependencias_internas
 *   - `CheckoutUseCaseDependencies` (`./checkout-use-case.dependencies.ts`).
 *   - `WhopWebhookPayloadParser` (`./webhook-payload.parser.ts`).
 *   - Funciones puras del dominio (`../domain/billing-whop.entities.ts`).
 *   - `DecimalMath`, `ConflictError`, `NotFoundError`, `ValidationError` del kernel.
 *
 * @dependencias_externas
 *   - Ninguna (El acceso a red y datos ocurre en los adaptadores inyectados).
 *
 * @tablas_bd_o_redis
 *   - Redis: `whop:webhook:evt:<id>` (Marca `PROCESSING`/`PROCESSED` con vigencia de 48 horas).
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (Bajo bloqueo `FOR UPDATE` y RLS activo).
 */

import { DecimalMath } from '../../../shared/kernel/decimal.util';
import type { PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import { computeIncludedMinutesForPlan } from '../domain/billing-whop.entities';
import type {
  MembershipWentInvalidPayload,
  MembershipWentValidPayload,
  PaymentSucceededPayload,
  SupportedWebhookEventName,
  WhopSubscriptionState,
} from '../domain/billing-whop.types';
import type { LedgerAppendInput, SubscriptionPeriodUpdate } from '../infrastructure/postgres-billing.repository';
import type { WhopWebhookHeaders } from '../infrastructure/whop-api-and-hmac.adapter';
import {
  WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
  ZERO_FIXED6,
  type CheckoutUseCaseDependencies,
} from './checkout-use-case.dependencies';
import { WhopWebhookPayloadParser } from './webhook-payload.parser';

/** Resultado del procesamiento de un webhook. */
export interface WebhookProcessingOutcome {
  /** Identificador del evento procesado. */
  readonly eventId: string;
  /** Nombre canonico del evento. */
  readonly eventName: SupportedWebhookEventName;
  /** Indica si el evento ya habia sido procesado y se descarto. */
  readonly wasDuplicate: boolean;
  /** Identificador del asiento contable registrado, cuando el evento lo genero. */
  readonly ledgerEntryId: string | null;
  /** Descripcion legible de la accion aplicada, para la bitacora. */
  readonly appliedAction: string;
}

/**
 * Caso de uso de procesamiento de webhooks de la pasarela.
 * Doble idempotencia: marca atomica en Redis y restriccion unica en el libro mayor.
 */
export class ProcessWhopWebhookUseCase {
  private readonly dependencies: CheckoutUseCaseDependencies;

  /**
   * @param dependencies - Pasarela, repositorio, Redis y verificador de DPA.
   */
  public constructor(dependencies: CheckoutUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Procesa un webhook entrante: verifica la firma, reserva la idempotencia y aplica el evento.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido, base de la verificacion de firma.
   * @param headers - Cabeceras de firma y nombre del evento.
   * @returns Resultado del procesamiento con su estado de idempotencia.
   * @throws UnauthorizedError cuando la firma es invalida o la marca temporal esta fuera de ventana.
   * @throws ValidationError cuando el nombre del evento no esta soportado.
   * @throws ConflictError cuando otra instancia ya esta procesando el mismo evento.
   */
  public async execute(rawBodyBuffer: Buffer, headers: WhopWebhookHeaders): Promise<WebhookProcessingOutcome> {
    this.dependencies.gateway.assertValidWebhookSignature(rawBodyBuffer, headers);

    const eventName = WhopWebhookPayloadParser.normalizeEventName(headers.eventNameHeader);
    const idempotencyKey = this.dependencies.redisClient.keyNamespaces.webhookEventSeen(headers.eventId);
    const reserved = await this.dependencies.redisClient.keys.setIfAbsent(idempotencyKey, 'PROCESSING', WEBHOOK_IDEMPOTENCY_TTL_SECONDS);

    if (!reserved) {
      const previousState = await this.dependencies.redisClient.json.getText(idempotencyKey);
      if (previousState === 'PROCESSED') {
        return { eventId: headers.eventId, eventName, wasDuplicate: true, ledgerEntryId: null, appliedAction: 'EVENTO_YA_PROCESADO' };
      }
      throw new ConflictError(
        `El evento ${headers.eventId} ya esta en proceso por otra instancia; reintente cuando la marca de idempotencia expire.`
      );
    }

    try {
      const eventData = WhopWebhookPayloadParser.extractEventData(rawBodyBuffer);
      const outcome = await this.dispatchEvent(eventName, headers.eventId, eventData);
      await this.dependencies.redisClient.json.setText(idempotencyKey, 'PROCESSED', WEBHOOK_IDEMPOTENCY_TTL_SECONDS);
      return outcome;
    } catch (error) {
      // La marca se libera ante un fallo para permitir el reintento legitimo del emisor.
      await this.dependencies.redisClient.keys.remove(idempotencyKey).catch(() => 0);
      throw error;
    }
  }

  /**
   * Despacha el evento a su manejador segun su nombre canonico.
   *
   * @param eventName - Nombre canonico del evento.
   * @param eventId - Identificador del evento, usado en el asiento contable.
   * @param eventData - Objeto de datos ya deserializado y normalizado.
   * @returns Resultado del procesamiento.
   */
  private async dispatchEvent(
    eventName: SupportedWebhookEventName,
    eventId: string,
    eventData: Readonly<Record<string, unknown>>
  ): Promise<WebhookProcessingOutcome> {
    switch (eventName) {
      case 'membership.went_valid':
        return this.applyMembershipActivation(WhopWebhookPayloadParser.parseMembershipValid(eventData), eventId);
      case 'membership.went_invalid':
        return this.applyMembershipInvalidation(WhopWebhookPayloadParser.parseMembershipInvalid(eventData), eventId);
      case 'payment.succeeded':
        return this.applyPaymentSucceeded(WhopWebhookPayloadParser.parsePaymentSucceeded(eventData), eventId);
      default:
        throw new ValidationError(`Evento de cobro no soportado: ${String(eventName)}`);
    }
  }

  /**
   * Aplica la activacion de una membresia: activa la suscripcion y otorga los minutos del plan.
   *
   * @param payload - Payload tipado del evento.
   * @param eventId - Identificador del evento.
   * @returns Resultado del procesamiento con el asiento de alta.
   * @throws NotFoundError cuando el plan no existe en el catalogo.
   */
  public async applyMembershipActivation(payload: MembershipWentValidPayload, eventId: string): Promise<WebhookProcessingOutcome> {
    const planCatalog = await this.dependencies.billingRepository.getPlanCatalog();
    const plan = planCatalog[payload.internalPlanCode];
    if (plan === undefined) {
      throw new NotFoundError(`plan de precios ${payload.internalPlanCode}`);
    }

    // Esta lectura ocurre ANTES de abrir el bloqueo pesimista: tomarla aqui no anida conexiones
    // porque aun no se retiene ninguna (ver `applyRenewal`, que si debe reutilizar la bloqueada).

    const grantedMinutes = computeIncludedMinutesForPlan(payload.internalPlanCode, planCatalog);
    const activationState: SubscriptionPeriodUpdate = {
      planCode: payload.internalPlanCode,
      status: 'ACTIVE',
      periodIncludedMinutesQuota: grantedMinutes,
      periodIncludedMinutesRemaining: grantedMinutes,
      periodOverageMinutesUsed: ZERO_FIXED6,
      currentPeriodOverageBilledUsd: ZERO_FIXED6,
      creditBalanceUsd: ZERO_FIXED6,
      currentPeriodStartIso: payload.periodStartIso,
      currentPeriodEndIso: payload.periodEndIso,
      externalMembershipId: payload.membershipId,
      lastExternalEventId: eventId,
    };
    await this.dependencies.billingRepository.ensureSubscriptionExists(payload.organizationId, activationState);

    return this.dependencies.billingRepository.withLockedSubscription(payload.organizationId, async (client, lockedSubscription) => {
      await this.dependencies.billingRepository.applyPeriodUpdateOnLockedClient(client, payload.organizationId, {
        ...activationState,
        creditBalanceUsd: lockedSubscription.creditBalanceUsd,
      });

      const ledgerEntryId = await this.appendLedgerEntry(client, eventId, {
        organizationId: payload.organizationId,
        subscriptionId: lockedSubscription.subscriptionId,
        externalEventId: eventId,
        externalPaymentId: null,
        entryType: 'PLAN_ACTIVATION_GRANT',
        minutesDelta: grantedMinutes,
        unitRateUsd: plan.baseOverageRatePerMinuteUsd,
        discountAppliedPercent: ZERO_FIXED6,
        amountUsdDelta: ZERO_FIXED6,
        includedMinutesBalanceAfter: grantedMinutes,
        creditBalanceUsdAfter: lockedSubscription.creditBalanceUsd,
        metadataJson: { planCode: payload.internalPlanCode, membershipId: payload.membershipId, source: 'membership.went_valid' },
      });

      return {
        eventId,
        eventName: 'membership.went_valid' as const,
        wasDuplicate: false,
        ledgerEntryId,
        appliedAction: `SUSCRIPCION_ACTIVADA_CON_${grantedMinutes}_MINUTOS`,
      };
    });
  }

  /**
   * Aplica la invalidacion de una membresia: marca morosidad y congela los minutos incluidos.
   * El saldo prepagado se conserva intacto: la organizacion puede seguir operando con el.
   *
   * @param payload - Payload tipado del evento.
   * @param eventId - Identificador del evento.
   * @returns Resultado del procesamiento sin asiento contable (no hay movimiento de saldos).
   */
  public async applyMembershipInvalidation(payload: MembershipWentInvalidPayload, eventId: string): Promise<WebhookProcessingOutcome> {
    // La invalidacion puede llegar antes que la activacion: se garantiza la fila antes de bloquearla.
    await this.dependencies.billingRepository.ensureSubscriptionExists(payload.organizationId, {
      planCode: 'PAYG',
      status: 'PAST_DUE_OR_INVALID',
      periodIncludedMinutesQuota: ZERO_FIXED6,
      periodIncludedMinutesRemaining: ZERO_FIXED6,
      periodOverageMinutesUsed: ZERO_FIXED6,
      currentPeriodOverageBilledUsd: ZERO_FIXED6,
      creditBalanceUsd: ZERO_FIXED6,
      externalMembershipId: payload.membershipId,
      lastExternalEventId: eventId,
    });

    await this.dependencies.billingRepository.withLockedSubscription(payload.organizationId, async (client, lockedSubscription) =>
      this.dependencies.billingRepository.applyPeriodUpdateOnLockedClient(client, payload.organizationId, {
        planCode: lockedSubscription.planCode,
        status: 'PAST_DUE_OR_INVALID',
        periodIncludedMinutesQuota: lockedSubscription.periodIncludedMinutesQuota,
        // Los minutos incluidos se congelan: dejan de estar disponibles hasta el siguiente pago.
        periodIncludedMinutesRemaining: ZERO_FIXED6,
        periodOverageMinutesUsed: lockedSubscription.periodOverageMinutesUsed,
        currentPeriodOverageBilledUsd: lockedSubscription.currentPeriodOverageBilledUsd,
        creditBalanceUsd: lockedSubscription.creditBalanceUsd,
        externalMembershipId: payload.membershipId,
        lastExternalEventId: eventId,
      })
    );

    return {
      eventId,
      eventName: 'membership.went_invalid',
      wasDuplicate: false,
      ledgerEntryId: null,
      appliedAction: `SUSCRIPCION_EN_MORA: ${payload.reason}`,
    };
  }

  /**
   * Aplica un pago exitoso: renueva el cupo mensual de minutos o suma saldo prepagado.
   *
   * @param payload - Payload tipado del evento.
   * @param eventId - Identificador del evento.
   * @returns Resultado del procesamiento con el asiento contable correspondiente.
   * @throws ValidationError cuando el importe del pago es negativo.
   */
  public async applyPaymentSucceeded(payload: PaymentSucceededPayload, eventId: string): Promise<WebhookProcessingOutcome> {
    const paidAmountUsd = DecimalMath.formatFixed6(payload.amountUsd, 'importe cobrado');
    if (DecimalMath.compareFixed6(paidAmountUsd, ZERO_FIXED6) < 0) {
      throw new ValidationError('El importe de un pago confirmado no puede ser negativo.');
    }

    await this.dependencies.billingRepository.ensureSubscriptionExists(payload.organizationId, {
      planCode: 'PAYG',
      status: 'ACTIVE',
      periodIncludedMinutesQuota: ZERO_FIXED6,
      periodIncludedMinutesRemaining: ZERO_FIXED6,
      periodOverageMinutesUsed: ZERO_FIXED6,
      currentPeriodOverageBilledUsd: ZERO_FIXED6,
      creditBalanceUsd: payload.paymentKind === 'TOP_UP' ? paidAmountUsd : ZERO_FIXED6,
      externalMembershipId: payload.membershipId,
      lastExternalEventId: eventId,
    });

    return this.dependencies.billingRepository.withLockedSubscription(payload.organizationId, async (client, lockedSubscription) =>
      payload.paymentKind === 'TOP_UP'
        ? this.applyTopUp(client, payload, eventId, paidAmountUsd, lockedSubscription)
        : this.applyRenewal(client, payload, eventId, paidAmountUsd, lockedSubscription)
    );
  }

  /**
   * Suma saldo prepagado en dolares y registra el asiento de recarga.
   *
   * @param payload - Payload tipado del evento de pago.
   * @param eventId - Identificador del evento.
   * @param paidAmountUsd - Importe cobrado ya normalizado.
   * @param lockedSubscription - Suscripcion bajo bloqueo pesimista.
   * @returns Resultado del procesamiento con el asiento de recarga.
   */
  private async applyTopUp(
    client: PoolClient,
    payload: PaymentSucceededPayload,
    eventId: string,
    paidAmountUsd: string,
    lockedSubscription: WhopSubscriptionState
  ): Promise<WebhookProcessingOutcome> {
    const newCreditBalance = DecimalMath.sumFixed6([lockedSubscription.creditBalanceUsd, paidAmountUsd]);
    await this.dependencies.billingRepository.applyPeriodUpdateOnLockedClient(client, payload.organizationId, {
      planCode: lockedSubscription.planCode,
      status: 'ACTIVE',
      periodIncludedMinutesQuota: lockedSubscription.periodIncludedMinutesQuota,
      periodIncludedMinutesRemaining: lockedSubscription.periodIncludedMinutesRemaining,
      periodOverageMinutesUsed: lockedSubscription.periodOverageMinutesUsed,
      currentPeriodOverageBilledUsd: lockedSubscription.currentPeriodOverageBilledUsd,
      creditBalanceUsd: newCreditBalance,
      lastExternalEventId: eventId,
    });

    const ledgerEntryId = await this.appendLedgerEntry(client, eventId, {
      organizationId: payload.organizationId,
      subscriptionId: lockedSubscription.subscriptionId,
      externalEventId: eventId,
      externalPaymentId: payload.paymentId,
      entryType: 'PAYMENT_SUCCEEDED_TOPUP',
      minutesDelta: ZERO_FIXED6,
      unitRateUsd: ZERO_FIXED6,
      discountAppliedPercent: ZERO_FIXED6,
      amountUsdDelta: paidAmountUsd,
      includedMinutesBalanceAfter: lockedSubscription.periodIncludedMinutesRemaining,
      creditBalanceUsdAfter: newCreditBalance,
      metadataJson: { paymentKind: payload.paymentKind, paymentId: payload.paymentId, source: 'payment.succeeded' },
    });

    return {
      eventId,
      eventName: 'payment.succeeded',
      wasDuplicate: false,
      ledgerEntryId,
      appliedAction: `SALDO_PREPAGADO_AUMENTADO_EN_${paidAmountUsd}_USD`,
    };
  }

  /**
   * Renueva el cupo mensual de minutos incluidos y reinicia el contador de excesos.
   *
   * @param payload - Payload tipado del evento de pago.
   * @param eventId - Identificador del evento.
   * @param paidAmountUsd - Importe cobrado ya normalizado.
   * @param lockedSubscription - Suscripcion bajo bloqueo pesimista.
   * @returns Resultado del procesamiento con el asiento de renovacion.
   */
  private async applyRenewal(
    client: PoolClient,
    payload: PaymentSucceededPayload,
    eventId: string,
    paidAmountUsd: string,
    lockedSubscription: WhopSubscriptionState
  ): Promise<WebhookProcessingOutcome> {
    // El catalogo se lee SOBRE LA CONEXION BLOQUEADA: abrir una propia aqui tomaria una segunda
    // conexion del pool mientras el bloqueo pesimista sigue retenido (hallazgo C1-21).
    const planCatalog = await this.dependencies.billingRepository.getPlanCatalog(client);
    const renewedMinutes = computeIncludedMinutesForPlan(lockedSubscription.planCode, planCatalog);

    await this.dependencies.billingRepository.applyPeriodUpdateOnLockedClient(client, payload.organizationId, {
      planCode: lockedSubscription.planCode,
      status: 'ACTIVE',
      periodIncludedMinutesQuota: renewedMinutes,
      periodIncludedMinutesRemaining: renewedMinutes,
      // El contador de excesos se reinicia con cada renovacion del periodo.
      periodOverageMinutesUsed: ZERO_FIXED6,
      currentPeriodOverageBilledUsd: ZERO_FIXED6,
      creditBalanceUsd: lockedSubscription.creditBalanceUsd,
      ...(payload.periodStartIso === null ? {} : { currentPeriodStartIso: payload.periodStartIso }),
      ...(payload.periodEndIso === null ? {} : { currentPeriodEndIso: payload.periodEndIso }),
      lastExternalEventId: eventId,
    });

    const ledgerEntryId = await this.appendLedgerEntry(client, eventId, {
      organizationId: payload.organizationId,
      subscriptionId: lockedSubscription.subscriptionId,
      externalEventId: eventId,
      externalPaymentId: payload.paymentId,
      entryType: 'PAYMENT_SUCCEEDED_RENEWAL',
      minutesDelta: renewedMinutes,
      unitRateUsd: ZERO_FIXED6,
      discountAppliedPercent: ZERO_FIXED6,
      amountUsdDelta: paidAmountUsd,
      includedMinutesBalanceAfter: renewedMinutes,
      creditBalanceUsdAfter: lockedSubscription.creditBalanceUsd,
      metadataJson: { paymentKind: payload.paymentKind, paymentId: payload.paymentId, source: 'payment.succeeded' },
    });

    return {
      eventId,
      eventName: 'payment.succeeded',
      wasDuplicate: false,
      ledgerEntryId,
      appliedAction: `CUPO_RENOVADO_A_${renewedMinutes}_MINUTOS`,
    };
  }

  /**
   * Registra un asiento contable traduciendo la violacion de unicidad en un conflicto controlado.
   *
   * @param eventId - Identificador del evento externo.
   * @param entry - Asiento a registrar.
   * @returns Identificador del asiento creado.
   * @throws ConflictError cuando el asiento ya existe para el mismo evento externo.
   */
  private async appendLedgerEntry(client: PoolClient, eventId: string, entry: LedgerAppendInput): Promise<string> {
    try {
      const created = await this.dependencies.billingRepository.appendImmutableLedgerEntryOnLockedClient(client, entry);
      return created.ledgerEntryId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('external_whop_event_id') || message.includes('duplicate key')) {
        throw new ConflictError(`El asiento del evento ${eventId} ya existe: la idempotencia contable impidio duplicarlo.`);
      }
      throw error;
    }
  }
}

/**
 * Ensambla el caso de uso de procesamiento de webhooks.
 *
 * @param dependencies - Pasarela, repositorio, Redis y verificador de DPA.
 * @returns Caso de uso listo para ser registrado en el contenedor de inyeccion.
 */
export function createProcessWhopWebhookUseCase(dependencies: CheckoutUseCaseDependencies): ProcessWhopWebhookUseCase {
  return new ProcessWhopWebhookUseCase(dependencies);
}




