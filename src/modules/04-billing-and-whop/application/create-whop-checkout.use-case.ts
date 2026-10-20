/**
 * @archivo src/modules/04-billing-and-whop/application/create-whop-checkout.use-case.ts
 * @modulo 04-billing-and-whop (Apertura de Enlaces de Pago Firmados)
 * @proposito
 *   Emite los enlaces de pago con los que una organizacion contrata un plan, activa el pago por uso
 *   o recarga saldo. Antes de permitir cualquier cobro exige que el acuerdo de procesamiento de
 *   datos este firmado, y firma con HMAC-SHA256 los metadatos del enlace para que un cliente no
 *   pueda alterar el plan, la organizacion ni el importe reutilizando un enlace legitimo.
 *
 * @resumen_contenido
 *   - Interface `CreateCheckoutInput`: Organizacion, actor, plan, modalidad e importe de recarga.
 *   - Interface `CreatedCheckoutSession`: Enlace local firmado y sesion creada en la pasarela.
 *   - Clase `CreateWhopCheckoutUseCase`:
 *       * `execute()`: Valida el acuerdo de datos, firma los metadatos y crea la sesion de pago.
 *       * `resolveTopUpAmount()`: Coherencia entre modalidad e importe de recarga.
 *       * `assertDpaSigned()`: Exigencia del acuerdo de procesamiento de datos.
 *
 * @dependencias_internas
 *   - `CheckoutUseCaseDependencies` (`./checkout-use-case.dependencies.ts`).
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`) para normalizar el importe de recarga.
 *   - `ValidationError`, `DpaNotSignedError`, `NotFoundError` del kernel.
 *
 * @dependencias_externas
 *   - Ninguna (El acceso a red ocurre en el adaptador inyectado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config` (Catalogo del que se resuelve el plan externo).
 *   - PostgreSQL: `organizations` (Origen del estado del acuerdo de procesamiento de datos).
 */

import { DecimalMath, type Fixed6String } from '../../../shared/kernel/decimal.util';
import { DpaNotSignedError, NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { BillingPlanCode, CheckoutMode, CheckoutSignedMetadata } from '../domain/billing-whop.types';
import { CHECKOUT_LINK_TTL_SECONDS, type CheckoutUseCaseDependencies } from './checkout-use-case.dependencies';

/** Importe minimo admitido en una recarga de saldo, en USD. */
const MINIMUM_TOP_UP_USD: Fixed6String = '1.000000';

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/** Datos de entrada para abrir un enlace de pago. */
export interface CreateCheckoutInput {
  /** Organizacion que contrata. */
  readonly organizationId: string;
  /** Usuario que inicia la contratacion. */
  readonly actorUserId: string;
  /** Plan solicitado. */
  readonly planCode: BillingPlanCode;
  /** Modalidad de cobro. */
  readonly checkoutMode: CheckoutMode;
  /** Importe de la recarga en USD; obligatorio en modo recarga. */
  readonly topUpAmountUsd?: Fixed6String;
  /** URL a la que la pasarela devuelve al cliente tras el pago. */
  readonly redirectUrl: string;
}

/** Enlace de pago emitido y firmado por el backend. */
export interface CreatedCheckoutSession {
  /** URL local firmada que puede usarse sin llamar a la pasarela. */
  readonly signedUrl: string;
  /** URL de la sesion de pago creada en la pasarela. */
  readonly gatewayCheckoutUrl: string;
  /** Identificador de la sesion de pago en la pasarela. */
  readonly gatewaySessionId: string;
  /** Firma HMAC de los metadatos del enlace. */
  readonly signatureHex: string;
  /** Momento de expiracion del enlace, en formato ISO 8601. */
  readonly expiresAtIso: string;
}

/**
 * Caso de uso de apertura de enlaces de pago.
 * Exige el acuerdo de procesamiento de datos firmado antes de permitir cualquier cobro.
 */
export class CreateWhopCheckoutUseCase {
  private readonly dependencies: CheckoutUseCaseDependencies;

  /**
   * @param dependencies - Pasarela, repositorio, Redis y verificador de DPA.
   */
  public constructor(dependencies: CheckoutUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Emite un enlace de pago firmado para contratar un plan, activar el pago por uso o recargar saldo.
   *
   * @param input - Organizacion, actor, plan, modalidad e importe de recarga.
   * @returns Enlace local firmado y sesion creada en la pasarela.
   * @throws ValidationError cuando la modalidad y el importe de recarga son incoherentes.
   * @throws DpaNotSignedError cuando la organizacion no tiene firmado el acuerdo de datos.
   * @throws NotFoundError cuando el plan no existe en el catalogo vigente.
   */
  public async execute(input: CreateCheckoutInput): Promise<CreatedCheckoutSession> {
    const topUpAmountUsd = this.resolveTopUpAmount(input);
    await this.assertDpaSigned(input.organizationId);

    const planCatalog = await this.dependencies.billingRepository.getPlanCatalog();
    const plan = planCatalog[input.planCode];
    if (plan === undefined) {
      throw new NotFoundError(`plan de precios ${input.planCode}`);
    }
    // Un plan sin aprovisionar lleva un identificador marcador, no un `plan_...` real: enviarlo a la
    // pasarela produciria un error opaco de medio cobro. Se rechaza aqui, con causa legible.
    if (!plan.isProvisioned) {
      throw new ValidationError(
        `El plan ${input.planCode} aun no esta aprovisionado en la pasarela. Ejecute el alta de planes antes de ofrecerlo.`
      );
    }

    const issuedAtMs = Date.now();
    const signedMetadata: CheckoutSignedMetadata = this.dependencies.gateway.signCheckoutMetadata({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      internalPlanCode: input.planCode,
      checkoutMode: input.checkoutMode,
      topUpAmountUsd,
      issuedAtMs,
    });

    const gatewaySession = await this.dependencies.gateway.createCheckoutSession(plan.externalPlanId, signedMetadata, input.redirectUrl);

    return {
      signedUrl: this.dependencies.gateway.buildSignedCheckoutUrl(signedMetadata, plan.externalPlanId),
      gatewayCheckoutUrl: gatewaySession.checkoutUrl,
      gatewaySessionId: gatewaySession.sessionId,
      signatureHex: signedMetadata.signatureHex,
      expiresAtIso: new Date(issuedAtMs + CHECKOUT_LINK_TTL_SECONDS * MILLISECONDS_PER_SECOND).toISOString(),
    };
  }

  /**
   * Valida la coherencia entre la modalidad de cobro y el importe de recarga.
   *
   * @param input - Datos de entrada del enlace de pago.
   * @returns Importe de recarga normalizado, o `null` cuando la modalidad no lo requiere.
   * @throws ValidationError cuando la modalidad y el importe no son coherentes o el importe es bajo.
   */
  private resolveTopUpAmount(input: CreateCheckoutInput): Fixed6String | null {
    if (input.checkoutMode !== 'TOP_UP') {
      if (input.topUpAmountUsd !== undefined) {
        throw new ValidationError('El importe de recarga solo puede declararse en la modalidad de recarga de saldo.');
      }
      return null;
    }

    if (input.topUpAmountUsd === undefined) {
      throw new ValidationError('La modalidad de recarga de saldo exige declarar el importe en USD.');
    }

    const normalizedAmount = DecimalMath.formatFixed6(input.topUpAmountUsd, 'importe de recarga');
    if (DecimalMath.compareFixed6(normalizedAmount, MINIMUM_TOP_UP_USD) < 0) {
      throw new ValidationError(`El importe minimo de recarga es de ${MINIMUM_TOP_UP_USD} USD.`);
    }
    return normalizedAmount;
  }

  /**
   * Verifica que la organizacion tenga firmado el acuerdo de procesamiento de datos.
   *
   * @param organizationId - Organizacion a verificar.
   * @throws DpaNotSignedError cuando el acuerdo no esta firmado.
   */
  private async assertDpaSigned(organizationId: string): Promise<void> {
    const verification = await this.dependencies.dpaVerifier.isDpaSigned(organizationId);
    if (!verification.signed) {
      throw new DpaNotSignedError({ organizationId, details: { reason: verification.reason } });
    }
  }
}

/**
 * Ensambla el caso de uso de apertura de enlaces de pago.
 *
 * @param dependencies - Pasarela, repositorio, Redis y verificador de DPA.
 * @returns Caso de uso listo para ser registrado en el contenedor de inyeccion.
 */
export function createWhopCheckoutUseCase(dependencies: CheckoutUseCaseDependencies): CreateWhopCheckoutUseCase {
  return new CreateWhopCheckoutUseCase(dependencies);
}
