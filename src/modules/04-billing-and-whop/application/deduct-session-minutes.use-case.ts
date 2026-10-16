/**
 * @archivo src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case.ts
 * @modulo 04-billing-and-whop (Deduccion Atomica de Minutos de Voz bajo Bloqueo Pesimista)
 * @proposito
 *   Cobra el consumo de una sesion de voz sin permitir que dos sesiones concurrentes de la misma
 *   organizacion lean el mismo saldo y lo descuenten dos veces. Toda la operacion ocurre dentro del
 *   bloqueo pesimista `SELECT ... FOR UPDATE` sobre la suscripcion: la lectura del saldo, el calculo
 *   de la tarifa, la escritura del nuevo saldo y el asiento contable comparten una unica transaccion
 *   y **una unica conexion**. Intentar escribir desde otra conexion mientras se retiene ese candado
 *   produce un autobloqueo permanente, y abrir conexiones adicionales agota el pool en cuanto hay
 *   unas pocas sesiones simultaneas; por eso la deduccion acepta la conexion del llamador, adquiere
 *   el bloqueo pesimista SOBRE ella y jamas abre una segunda mientras la primera siga retenida.
 *
 * @resumen_contenido
 *   - Constantes `SECONDS_PER_BILLING_PULSE` y `ZERO_FIXED6`.
 *   - Interfaces `DeductSessionMinutesInput` (con `lockedClient` y `lockedSubscription` opcionales)
 *     y `DeductSessionMinutesResult`.
 *   - Clase `DeductSessionMinutesUseCase`:
 *       * `execute()`: Elige la transaccion del llamador o abre una propia, y nada mas.
 *       * `runDeduction()`: Ejecuta el cobro completo sobre la conexion que ya posee el bloqueo.
 *       * `computeCharge()`: Reparto del consumo entre cuota incluida, saldo y deuda pendiente.
 *       * `evaluateTermination()`: Decision de corte por tope de gasto o agotamiento de fondos.
 *       * `shouldTerminateSession()`: Consulta rapida de corte sin ejecutar la deduccion.
 *   - Fabrica `createDeductSessionMinutesUseCase()`.
 *
 * @dependencias_internas
 *   - `CalculateEffectiveRateUseCase` (`./calculate-effective-rate.use-case.ts`).
 *   - `BillingRepositoryPort` (`../infrastructure/postgres-billing.repository.ts`).
 *   - `DecimalMath`, `exceedsUsdCap` (`src/shared/kernel/decimal.util.ts`).
 *   - `NotFoundError`, `ValidationError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion bloqueada; no abre conexiones propias).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` (Lectura y escritura bajo `FOR UPDATE`, RLS activo).
 *   - PostgreSQL: `usage_ledger` (Insercion append-only del asiento `VOICE_MINUTE_DEDUCTION`).
 */

import type { PoolClient } from 'pg';
import {
  DecimalMath,
  exceedsUsdCap,
  type Fixed6String,
  type UsdAmountFixed6,
} from '../../../shared/kernel/decimal.util';
import { NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { WhopSubscriptionState } from '../domain/billing-whop.types';
import type { BillingRepositoryPort, LedgerAppendInput, SubscriptionPeriodUpdate } from '../infrastructure/postgres-billing.repository';
import { CalculateEffectiveRateUseCase } from './calculate-effective-rate.use-case';
import { ZERO_FIXED6, type CheckoutUseCaseDependencies } from './checkout-use-case.dependencies';

/** Segundos que abarca un pulso de facturacion del gateway de voz. */
export const SECONDS_PER_BILLING_PULSE = 15;

/** Entrada del caso de uso de deduccion. */
export interface DeductSessionMinutesInput {
  /** Organizacion que consume. */
  readonly organizationId: string;
  /** Proyecto cuya sesion de voz reporta el consumo; `null` cuando la sesion no lo declara. */
  readonly projectId: string | null;
  /** Sesion de voz que reporta el consumo. */
  readonly voiceSessionId: string;
  /** Segundos transcurridos desde el ultimo pulso de facturacion. */
  readonly elapsedSeconds: number;
  /**
   * Conexion del llamador que YA posee una transaccion con contexto de inquilino.
   *
   * La deduccion adquiere el bloqueo pesimista SOBRE ella en lugar de abrir una segunda conexion
   * del pool mientras la primera sigue retenida. Opcional para no romper llamadores sin
   * transaccion, que abren la suya.
   */
  readonly lockedClient?: PoolClient;
  /**
   * Suscripcion leida por el llamador SIN bloqueo, solo como comprobacion rapida de existencia.
   *
   * La deduccion la relee bajo `FOR UPDATE` sobre `lockedClient`: usarla sin bloquear producia
   * actualizaciones perdidas entre pulsos concurrentes. Se conserva por compatibilidad.
   */
  readonly lockedSubscription?: WhopSubscriptionState;
}

/** Resultado de la deduccion, con el desglose contable y la decision de corte. */
export interface DeductSessionMinutesResult {
  /** Minutos consumidos en este pulso, ya normalizados. */
  readonly billedMinutes: Fixed6String;
  /** Minutos cubiertos por la cuota incluida del periodo. */
  readonly coveredMinutes: Fixed6String;
  /** Minutos que excedieron la cuota y se cobran por separado. */
  readonly overageMinutes: Fixed6String;
  /** Importe del exceso en USD, ya descontado. */
  readonly overageCostUsd: UsdAmountFixed6;
  /** Tarifa efectiva aplicada en este pulso, en USD por minuto. */
  readonly effectiveRatePerMinuteUsd: UsdAmountFixed6;
  /** Porcentaje de descuento total aplicado. */
  readonly discountAppliedPercent: Fixed6String;
  /** Minutos incluidos restantes despues del pulso. */
  readonly remainingIncludedMinutes: Fixed6String;
  /** Saldo de credito restante despues del pulso. */
  readonly remainingCreditUsd: UsdAmountFixed6;
  /** Importe del exceso que el saldo no alcanzo a cubrir y queda pendiente de cobro. */
  readonly uncoveredCostUsd: UsdAmountFixed6;
  /** Importe acumulado facturado por exceso en el periodo. */
  readonly currentPeriodOverageBilledUsd: UsdAmountFixed6;
  /** Indica si la sesion debe cerrarse de inmediato. */
  readonly shouldTerminateSession: boolean;
  /** Motivo del corte cuando `shouldTerminateSession` es verdadero. */
  readonly terminationReason: string | null;
  /** Identificador del asiento contable inmutable registrado. */
  readonly ledgerEntryId: string;
}

/** Reparto interno del consumo entre cuota incluida, saldo prepagado y deuda pendiente. */
interface ChargeBreakdown {
  readonly billedMinutes: Fixed6String;
  readonly coveredMinutes: Fixed6String;
  readonly overageMinutes: Fixed6String;
  readonly overageCostUsd: UsdAmountFixed6;
  readonly chargeableCostUsd: UsdAmountFixed6;
  readonly uncoveredCostUsd: UsdAmountFixed6;
  readonly remainingIncludedMinutes: Fixed6String;
  readonly remainingCreditUsd: UsdAmountFixed6;
  readonly effectiveRatePerMinuteUsd: UsdAmountFixed6;
  readonly discountAppliedPercent: Fixed6String;
  readonly currentPeriodOverageBilledUsd: UsdAmountFixed6;
}

/**
 * Caso de uso de deduccion atomica de minutos.
 * Recibe el motor de tarificacion por inyeccion para que sus reglas sean sustituibles en pruebas.
 */
export class DeductSessionMinutesUseCase {
  private readonly dependencies: CheckoutUseCaseDependencies;
  private readonly rateCalculator: CalculateEffectiveRateUseCase;

  /**
   * @param dependencies - Repositorio, pasarela, Redis y verificador de DPA del modulo.
   * @param rateCalculator - Motor de tarificacion; se construye uno por omision.
   */
  public constructor(dependencies: CheckoutUseCaseDependencies, rateCalculator?: CalculateEffectiveRateUseCase) {
    this.dependencies = dependencies;
    this.rateCalculator = rateCalculator ?? new CalculateEffectiveRateUseCase();
  }

  /**
   * Deduce el consumo de un pulso de facturacion dentro de una unica transaccion bloqueada.
   *
   * La transaccion es **una sola** en los dos caminos posibles. Si el llamador entrega su conexion,
   * la deduccion adquiere el bloqueo pesimista SOBRE esa misma conexion y relee la suscripcion:
   * fiarse de la instantanea del llamador sin bloquear permitia que varios pulsos leyeran el mismo
   * saldo y lo sobrescribieran (actualizacion perdida). Si no la entrega, abre la suya. Lo que jamas
   * ocurre es abrir una segunda conexion mientras el llamador retiene la primera: eso agotaba el
   * pool a partir de unas pocas sesiones concurrentes.
   *
   * @param input - Organizacion, proyecto, sesion, segundos consumidos y, opcionalmente, la conexion
   *   ya abierta por el llamador.
   * @returns Desglose de la deduccion con la decision de corte.
   * @throws ValidationError cuando el consumo no es un numero valido o es negativo.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion ni plan en el catalogo.
   */
  public async execute(input: DeductSessionMinutesInput): Promise<DeductSessionMinutesResult> {
    const billedMinutes = this.normalizeElapsedSeconds(input.elapsedSeconds);
    if (DecimalMath.compareFixed6(billedMinutes, ZERO_FIXED6) === 0) {
      return this.buildNoChargeResult(billedMinutes);
    }

    const callerClient = input.lockedClient;
    if (callerClient !== undefined) {
      const lockedSubscription = await this.dependencies.billingRepository.lockSubscriptionOnClient(
        callerClient,
        input.organizationId
      );
      return this.runDeduction(input, billedMinutes, callerClient, lockedSubscription);
    }

    return this.dependencies.billingRepository.withLockedSubscription(input.organizationId, async (client, lockedSubscription) =>
      this.runDeduction(input, billedMinutes, client, lockedSubscription)
    );
  }

  /**
   * Ejecuta el cobro completo —lectura del catalogo, tarifa, saldos y asiento— sobre la conexion que
   * ya tiene el bloqueo pesimista. Toda sentencia de esta ruta reutiliza esa misma conexion.
   *
   * @param input - Entrada original de la deduccion.
   * @param billedMinutes - Minutos del pulso, ya normalizados a 6 decimales.
   * @param client - Conexion que posee el bloqueo `FOR UPDATE` de la suscripcion.
   * @param lockedSubscription - Suscripcion leida bajo ese bloqueo.
   * @returns Desglose de la deduccion con la decision de corte.
   * @throws NotFoundError cuando el plan contratado no existe en el catalogo vigente.
   */
  private async runDeduction(
    input: DeductSessionMinutesInput,
    billedMinutes: Fixed6String,
    client: PoolClient,
    lockedSubscription: WhopSubscriptionState
  ): Promise<DeductSessionMinutesResult> {
    // El catalogo y el override se leen SOBRE LA CONEXION BLOQUEADA. Resolverlos con `Promise.all`
    // tomaba hasta dos conexiones adicionales del pool mientras esta seguia retenida, que es la
    // misma clase de anidamiento que agotaba el pool; y una conexion nueva ni siquiera hereda el
    // contexto de inquilino que el llamador ya fijo.
    const planCatalog = await this.dependencies.billingRepository.getPlanCatalog(client);
    const override = await this.dependencies.billingRepository.getActivePricingOverride(input.organizationId, client);
    const plan = planCatalog[lockedSubscription.planCode];
    if (plan === undefined) {
      throw new NotFoundError(`plan de precios ${lockedSubscription.planCode}`);
    }

    const quote = this.rateCalculator.execute({
      subscription: lockedSubscription,
      plan,
      override,
      accumulatedOverageMinutes: lockedSubscription.periodOverageMinutesUsed,
    });
    const breakdown = this.computeCharge(lockedSubscription, billedMinutes, quote.effectiveRatePerMinuteUsd, quote.totalDiscountPercent);
    const termination = this.evaluateTermination(breakdown, lockedSubscription);

    await this.dependencies.billingRepository.applyPeriodUpdateOnLockedClient(client, input.organizationId, {
      planCode: lockedSubscription.planCode,
      status: lockedSubscription.status,
      periodIncludedMinutesQuota: lockedSubscription.periodIncludedMinutesQuota,
      periodIncludedMinutesRemaining: breakdown.remainingIncludedMinutes,
      periodOverageMinutesUsed: DecimalMath.sumFixed6([lockedSubscription.periodOverageMinutesUsed, breakdown.overageMinutes]),
      currentPeriodOverageBilledUsd: breakdown.currentPeriodOverageBilledUsd,
      creditBalanceUsd: breakdown.remainingCreditUsd,
    });

    const ledgerEntry = this.buildLedgerEntry(input, lockedSubscription, breakdown);
    const created = await this.dependencies.billingRepository.appendImmutableLedgerEntryOnLockedClient(client, ledgerEntry);

    return {
      billedMinutes: breakdown.billedMinutes,
      coveredMinutes: breakdown.coveredMinutes,
      overageMinutes: breakdown.overageMinutes,
      overageCostUsd: breakdown.chargeableCostUsd,
      effectiveRatePerMinuteUsd: breakdown.effectiveRatePerMinuteUsd,
      discountAppliedPercent: breakdown.discountAppliedPercent,
      remainingIncludedMinutes: breakdown.remainingIncludedMinutes,
      remainingCreditUsd: breakdown.remainingCreditUsd,
      uncoveredCostUsd: breakdown.uncoveredCostUsd,
      currentPeriodOverageBilledUsd: breakdown.currentPeriodOverageBilledUsd,
      shouldTerminateSession: termination.shouldTerminate,
      terminationReason: termination.reason,
      ledgerEntryId: created.ledgerEntryId,
    };
  }

  /**
   * Determina si una suscripcion bloqueada debe cortar la sesion en curso.
   * Se expone por separado para que el gateway de voz pueda consultarlo sin registrar consumo.
   *
   * @param subscription - Estado de la suscripcion bajo bloqueo.
   * @returns `true` cuando la sesion debe cerrarse por falta de fondos o tope alcanzado.
   */
  public shouldTerminateSession(subscription: WhopSubscriptionState): boolean {
    const hasIncludedMinutes = DecimalMath.compareFixed6(subscription.periodIncludedMinutesRemaining, ZERO_FIXED6) > 0;
    const hasCredit = DecimalMath.compareFixed6(subscription.creditBalanceUsd, ZERO_FIXED6) > 0;
    const capReached = exceedsUsdCap(subscription.currentPeriodOverageBilledUsd, subscription.hardSpendCapUsd);
    const isBillablePlan = subscription.planCode !== 'PAYG';

    if (capReached) {
      return true;
    }
    // Un plan de pago por uso sin cuota ni saldo no tiene forma de cubrir el siguiente minuto. Un
    // plan de suscripcion SIN tope de gasto tampoco admite deuda (hallazgo C2-02): sin minutos ni
    // saldo, el siguiente minuto seria impagable y la sesion debe cortarse.
    if (isBillablePlan && subscription.hardSpendCapUsd === null) {
      return !hasIncludedMinutes && !hasCredit;
    }
    return !isBillablePlan && !hasIncludedMinutes && !hasCredit;
  }

  /**
   * Reparte el consumo entre cuota incluida, saldo prepagado y deuda acumulada del periodo.
   *
   * El modelo de cobro distingue dos situaciones, y confundirlas produce o fraude o cortes
   * indebidos: un plan de suscripcion ya cobra una cuota fija mensual, de modo que su exceso se
   * acumula como deuda del periodo y se factura al cierre, con el tope de gasto duro como unica
   * proteccion; el plan de pago por uso no tiene cuota fija que lo respalde, por lo que sin saldo
   * prepagado ese consumo es impagable y la sesion debe cortarse.
   *
   * @param subscription - Suscripcion bajo bloqueo pesimista.
   * @param billedMinutes - Minutos del pulso, ya normalizados.
   * @param effectiveRatePerMinuteUsd - Tarifa efectiva aplicada.
   * @param discountAppliedPercent - Porcentaje de descuento total aplicado.
   * @returns Desglose listo para persistir.
   */
  private computeCharge(
    subscription: WhopSubscriptionState,
    billedMinutes: Fixed6String,
    effectiveRatePerMinuteUsd: UsdAmountFixed6,
    discountAppliedPercent: Fixed6String
  ): ChargeBreakdown {
    const split = this.rateCalculator.splitConsumption(subscription.periodIncludedMinutesRemaining, billedMinutes);
    const overageCostUsd = this.rateCalculator.calculateOverageCostUsd(split.overageMinutes, effectiveRatePerMinuteUsd);
    const creditAvailableUsd = DecimalMath.clampNonNegative(subscription.creditBalanceUsd);
    const isPrepaidOnlyPlan = subscription.planCode === 'PAYG';

    // El saldo prepagado solo cubre el exceso, nunca los minutos ya incluidos en la cuota del plan.
    const coveredByCreditUsd =
      DecimalMath.compareFixed6(overageCostUsd, creditAvailableUsd) <= 0 ? overageCostUsd : creditAvailableUsd;
    const unbilledCostUsd = DecimalMath.sumFixed6([overageCostUsd, `-${coveredByCreditUsd}`]);
    // Sin tope de gasto no hay deuda admitida (hallazgo C2-02): el exceso solo se cubre con saldo
    // prepagado y el resto queda impagable y provoca el corte. El pago por uso nunca admite deuda.
    const debtAllowed = !isPrepaidOnlyPlan && subscription.hardSpendCapUsd !== null;
    const accruedDebtUsd = debtAllowed ? unbilledCostUsd : ZERO_FIXED6;
    const chargeableCostUsd = DecimalMath.sumFixed6([coveredByCreditUsd, accruedDebtUsd]);

    return {
      billedMinutes,
      coveredMinutes: split.coveredMinutes,
      overageMinutes: split.overageMinutes,
      overageCostUsd,
      chargeableCostUsd,
      uncoveredCostUsd: DecimalMath.sumFixed6([unbilledCostUsd, `-${accruedDebtUsd}`]),
      remainingIncludedMinutes: split.remainingIncludedMinutes,
      remainingCreditUsd: DecimalMath.sumFixed6([creditAvailableUsd, `-${coveredByCreditUsd}`]),
      effectiveRatePerMinuteUsd,
      discountAppliedPercent,
      currentPeriodOverageBilledUsd: DecimalMath.sumFixed6([subscription.currentPeriodOverageBilledUsd, chargeableCostUsd]),
    };
  }

  /**
   * Decide si la sesion debe cerrarse tras aplicar el consumo.
   * El corte ocurre por tope de gasto duro alcanzado o por agotamiento total de fondos cuando el
   * plan no admite consumo por exceso. La deuda pendiente se registra siempre en el libro mayor.
   *
   * @param breakdown - Desglose del consumo ya aplicado.
   * @param subscription - Suscripcion bajo bloqueo, para conocer el tope y el plan.
   * @returns Decision de corte con su motivo legible.
   */
  private evaluateTermination(
    breakdown: ChargeBreakdown,
    subscription: WhopSubscriptionState
  ): { readonly shouldTerminate: boolean; readonly reason: string | null } {
    if (exceedsUsdCap(breakdown.currentPeriodOverageBilledUsd, subscription.hardSpendCapUsd)) {
      return {
        shouldTerminate: true,
        reason: `TOPE_DE_GASTO_ALCANZADO (${breakdown.currentPeriodOverageBilledUsd} USD de ${String(subscription.hardSpendCapUsd)} USD)`,
      };
    }

    const hasIncludedMinutes = DecimalMath.compareFixed6(breakdown.remainingIncludedMinutes, ZERO_FIXED6) > 0;
    const hasCredit = DecimalMath.compareFixed6(breakdown.remainingCreditUsd, ZERO_FIXED6) > 0;
    if (!hasIncludedMinutes && !hasCredit && DecimalMath.compareFixed6(breakdown.uncoveredCostUsd, ZERO_FIXED6) > 0) {
      return { shouldTerminate: true, reason: 'FONDOS_AGOTADOS' };
    }

    return { shouldTerminate: false, reason: null };
  }

  /**
   * Construye el asiento inmutable de consumo de voz.
   *
   * @param input - Entrada original de la deduccion.
   * @param subscription - Suscripcion bajo bloqueo.
   * @param breakdown - Desglose del consumo.
   * @returns Asiento listo para insertar en el libro mayor.
   */
  private buildLedgerEntry(
    input: DeductSessionMinutesInput,
    subscription: WhopSubscriptionState,
    breakdown: ChargeBreakdown
  ): LedgerAppendInput {
    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      voiceSessionId: input.voiceSessionId,
      subscriptionId: subscription.subscriptionId,
      externalEventId: null,
      externalPaymentId: null,
      entryType: 'VOICE_MINUTE_DEDUCTION',
      // El asiento registra el consumo como variacion NEGATIVA de minutos: es la unica forma de que
      // la suma del libro mayor reconstruya el saldo sin ambiguedad.
      minutesDelta: `-${breakdown.billedMinutes}`,
      // La tarifa se persiste con su precision COMPLETA de 6 decimales: el libro debe cumplir
      // `minutos x tarifa = importe`, y redondear a centavos la rompia (0.128520 con 10 minutos
      // registraba 0.130000 frente a 1.285200 USD). El redondeo se reserva al importe de pasarela.
      unitRateUsd: breakdown.effectiveRatePerMinuteUsd,
      discountAppliedPercent: DecimalMath.formatFixed6(breakdown.discountAppliedPercent, 'descuento del asiento'),
      amountUsdDelta: breakdown.chargeableCostUsd,
      includedMinutesBalanceAfter: breakdown.remainingIncludedMinutes,
      creditBalanceUsdAfter: breakdown.remainingCreditUsd,
      metadataJson: {
        coveredMinutes: breakdown.coveredMinutes,
        overageMinutes: breakdown.overageMinutes,
        overageCostUsd: breakdown.overageCostUsd,
        uncoveredCostUsd: breakdown.uncoveredCostUsd,
      },
    };
  }

  /**
   * Normaliza los segundos consumidos a minutos exactos de 6 decimales.
   *
   * @param elapsedSeconds - Segundos transcurridos desde el ultimo pulso.
   * @returns Minutos consumidos en formato decimal fijo.
   * @throws ValidationError cuando el valor no es un numero finito o es negativo.
   */
  private normalizeElapsedSeconds(elapsedSeconds: number): Fixed6String {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new ValidationError('Los segundos consumidos deben ser un numero finito no negativo.');
    }
    return DecimalMath.secondsToMinutesFixed6(elapsedSeconds);
  }

  /**
   * Construye el resultado de un pulso sin consumo efectivo.
   * Un pulso de cero segundos no debe escribir en el libro mayor ni mover saldos: hacerlo inflaria
   * el historial contable con asientos vacios que dificultarian la auditoria.
   *
   * @param billedMinutes - Minutos del pulso, que son cero.
   * @returns Resultado sin movimiento contable ni corte de sesion.
   */
  private buildNoChargeResult(billedMinutes: Fixed6String): DeductSessionMinutesResult {
    return {
      billedMinutes,
      coveredMinutes: ZERO_FIXED6,
      overageMinutes: ZERO_FIXED6,
      overageCostUsd: ZERO_FIXED6,
      effectiveRatePerMinuteUsd: ZERO_FIXED6,
      discountAppliedPercent: ZERO_FIXED6,
      remainingIncludedMinutes: ZERO_FIXED6,
      remainingCreditUsd: ZERO_FIXED6,
      uncoveredCostUsd: ZERO_FIXED6,
      currentPeriodOverageBilledUsd: ZERO_FIXED6,
      shouldTerminateSession: false,
      terminationReason: null,
      ledgerEntryId: '',
    };
  }
}

/**
 * Ensambla el caso de uso de deduccion de minutos.
 *
 * @param dependencies - Repositorio, pasarela, Redis y verificador de DPA del modulo.
 * @returns Caso de uso listo para el contenedor de inyeccion y el gateway de voz.
 */
export function createDeductSessionMinutesUseCase(dependencies: CheckoutUseCaseDependencies): DeductSessionMinutesUseCase {
  return new DeductSessionMinutesUseCase(dependencies);
}


