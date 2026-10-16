/**
 * @archivo src/modules/04-billing-and-whop/application/calculate-effective-rate.use-case.ts
 * @modulo 04-billing-and-whop (Motor Matematico Determinista de Tarificacion)
 * @proposito
 *   Calcula, con precision exacta de 6 decimales y cero aritmetica de coma flotante, cuanto cuesta
 *   un consumo de voz. El motor resuelve tres decisiones encadenadas: 1) si el override del
 *   SuperAdmin impone una tarifa, esa manda sobre cualquier otra regla; 2) si la organizacion tiene
 *   derecho al escalafon de descuento por volumen, se busca el tramo alcanzado por el consumo
 *   acumulado del periodo; 3) el descuento manual del SuperAdmin se compone de forma multiplicativa
 *   con el tramo, nunca sumando porcentajes. Ademas parte el consumo exactamente entre minutos
 *   cubiertos por la cuota y minutos en exceso, que es lo que determina el importe a cobrar.
 *
 * @resumen_contenido
 *   - Constantes `DEFAULT_BASE_RATE_PER_MINUTE_USD` y `ZERO_FIXED6`.
 *   - Interfaces `EffectiveRateInput`, `ConsumptionSplit` y `EffectiveRateQuote`.
 *   - Clase `CalculateEffectiveRateUseCase`:
 *       * `execute()`: Tarifa efectiva y descuento aplicable dado el consumo acumulado.
 *       * `splitConsumption()`: Particion exacta entre cuota incluida y exceso.
 *       * `isVolumeTierEligible()`: Derecho al escalafon de volumen.
 *       * `resolveApplicableTier()`: Tramo alcanzado segun el consumo.
 *       * `calculateOverageCostUsd()`: Importe del exceso ya descontado.
 *       * `resolveBaseRateUsd()`: Tarifa base segun la precedencia de overrides.
 *
 * @dependencias_internas
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`): `subtractMinutesClamped()`,
 *     `multiplyUnitsByRate()`, `calculateCompoundedRate()`, `applyCompoundDiscount()`.
 *   - `resolveVolumeDiscountTier()` y `computeIncludedMinutesForPlan()`
 *     (`../domain/billing-whop.entities.ts`).
 *   - Tipos del dominio (`../domain/billing-whop.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Nucleo de aplicacion puro: sin acceso a red, base de datos ni reloj del sistema).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (El motor es puro. Sus datos provienen de `pricing_plans_config`,
 *     `whop_subscriptions` y `organization_pricing_overrides`, inyectados por quien lo invoca).
 */

import {
  DecimalMath,
  type Fixed6String,
  type UsdAmountFixed6,
} from '../../../shared/kernel/decimal.util';
import { ValidationError } from '../../../shared/kernel/result-and-errors';
import { computeIncludedMinutesForPlan, resolveVolumeDiscountTier } from '../domain/billing-whop.entities';
import type {
  OrganizationPricingOverride,
  PricingPlanConfig,
  VolumeDiscountTier,
  WhopSubscriptionState,
} from '../domain/billing-whop.types';

/** Valor decimal de 6 cifras que representa la ausencia de movimiento o de descuento. */
const ZERO_FIXED6: Fixed6String = '0.000000';

/** Tarifa por minuto aplicada cuando el plan no declara una propia, en USD. */
const DEFAULT_BASE_RATE_PER_MINUTE_USD: UsdAmountFixed6 = '0.200000';

/** Entrada del motor de tarificacion. */
export interface EffectiveRateInput {
  /** Estado vigente de la suscripcion de la organizacion. */
  readonly subscription: WhopSubscriptionState;
  /** Plan contratado, con sus tramos de descuento declarados. */
  readonly plan: PricingPlanConfig;
  /** Override vigente del SuperAdmin, o `null` cuando la organizacion usa los precios del plan. */
  readonly override: OrganizationPricingOverride | null;
  /** Minutos de exceso ya acumulados en el periodo, para resolver el tramo alcanzado. */
  readonly accumulatedOverageMinutes: Fixed6String;
  /** Tarifa base que sustituye a la del plan; `null` para usar la del plan. */
  readonly customBaseRateUsd?: UsdAmountFixed6 | null;
}

/** Particion exacta de un consumo entre la cuota incluida y el exceso facturable. */
export interface ConsumptionSplit {
  /** Minutos cubiertos por la cuota incluida del periodo. */
  readonly coveredMinutes: Fixed6String;
  /** Minutos que exceden la cuota y se cobran por separado. */
  readonly overageMinutes: Fixed6String;
  /** Minutos incluidos que quedan disponibles tras el consumo. */
  readonly remainingIncludedMinutes: Fixed6String;
  /** Indica si el consumo agoto por completo la cuota incluida. */
  readonly exhaustedIncludedMinutes: boolean;
}

/** Cotizacion completa de un consumo, con la trazabilidad del descuento aplicado. */
export interface EffectiveRateQuote {
  /** Tarifa base antes de descuentos, en USD por minuto. */
  readonly baseRatePerMinuteUsd: UsdAmountFixed6;
  /** Tarifa final aplicable, en USD por minuto. */
  readonly effectiveRatePerMinuteUsd: UsdAmountFixed6;
  /** Porcentaje del tramo de volumen alcanzado; `0.000000` si no aplica. */
  readonly volumeDiscountPercent: Fixed6String;
  /** Porcentaje del descuento manual del SuperAdmin; `0.000000` si no existe. */
  readonly manualDiscountPercent: Fixed6String;
  /** Descuento total efectivo, ya compuesto de forma multiplicativa. */
  readonly totalDiscountPercent: Fixed6String;
  /** Numero del tramo de volumen alcanzado; `null` cuando la organizacion no es elegible. */
  readonly appliedTierNumber: number | null;
  /** Minutos incluidos que otorga el plan en el periodo. */
  readonly includedMinutesQuota: Fixed6String;
  /** Indica si la organizacion tiene derecho al escalafon de descuento por volumen. */
  readonly volumeTierEligible: boolean;
  /** Indica si la tarifa proviene de un override del SuperAdmin. */
  readonly usesSuperAdminOverride: boolean;
}

/**
 * Motor matematico de tarificacion del consumo de voz.
 * Es determinista y sin estado: la misma entrada produce siempre exactamente la misma cotizacion.
 */
export class CalculateEffectiveRateUseCase {
  /**
   * Calcula la cotizacion completa de tarifa y descuentos para una organizacion.
   *
   * @param input - Suscripcion, plan, override y consumo acumulado del periodo.
   * @returns Cotizacion con la tarifa efectiva y la trazabilidad del descuento.
   * @throws ValidationError cuando el consumo acumulado es negativo o los importes son invalidos.
   */
  public execute(input: EffectiveRateInput): EffectiveRateQuote {
    const volumeTierEligible = this.isVolumeTierEligible(input);
    const applicableTier = this.resolveApplicableTier(input, volumeTierEligible);
    const volumeDiscountPercent = applicableTier === null ? ZERO_FIXED6 : DecimalMath.formatFixed6(applicableTier.discountPercent, 'descuento por volumen');
    const manualDiscountPercent = this.resolveManualDiscountPercent(input.override);
    const baseRatePerMinuteUsd = this.resolveBaseRateUsd(input);

    // Los descuentos se COMPONEN de forma multiplicativa: un 10% de volumen y un 5% manual producen
    // un 14,5% efectivo, jamas un 15%. Sumarlos seria otorgar un descuento que nadie autorizo.
    const effectiveRatePerMinuteUsd = DecimalMath.calculateCompoundedRate(
      baseRatePerMinuteUsd,
      volumeDiscountPercent,
      manualDiscountPercent
    );
    const totalDiscountPercent = this.calculateTotalDiscountPercent(volumeDiscountPercent, manualDiscountPercent);

    return Object.freeze({
      baseRatePerMinuteUsd,
      effectiveRatePerMinuteUsd,
      volumeDiscountPercent,
      manualDiscountPercent,
      totalDiscountPercent,
      appliedTierNumber: applicableTier === null ? null : applicableTier.tier,
      includedMinutesQuota: computeIncludedMinutesForPlan(input.plan.planCode),
      volumeTierEligible,
      usesSuperAdminOverride: input.override !== null && input.override.customRatePerMinuteUsd !== null,
    });
  }

  /**
   * Parte un consumo de minutos entre la cuota incluida y el exceso facturable.
   * La particion es exacta: si una sesion cruza el limite, los minutos anteriores al limite se
   * cubren con la cuota y solo los posteriores se cobran como exceso.
   *
   * @param includedMinutesRemaining - Minutos incluidos disponibles antes del consumo.
   * @param consumedMinutes - Minutos consumidos por el pulso de facturacion.
   * @returns Particion con minutos cubiertos, exceso y saldo restante.
   * @throws ValidationError cuando el consumo es negativo.
   */
  public splitConsumption(includedMinutesRemaining: Fixed6String, consumedMinutes: Fixed6String): ConsumptionSplit {
    const partition = DecimalMath.subtractMinutesClamped(includedMinutesRemaining, consumedMinutes);
    return Object.freeze({
      coveredMinutes: partition.covered,
      overageMinutes: partition.uncoveredOverage,
      remainingIncludedMinutes: partition.remaining,
      exhaustedIncludedMinutes: DecimalMath.compareFixed6(partition.remaining, ZERO_FIXED6) === 0,
    });
  }

  /**
   * Determina si la organizacion tiene derecho al escalafon de descuento por volumen.
   * Una organizacion es elegible cuando su plan lo declara, cuando el override del SuperAdmin lo
   * fuerza explicitamente o cuando aporta tramos personalizados negociados.
   *
   * @param input - Entrada del motor de tarificacion.
   * @returns `true` cuando corresponde evaluar los tramos de volumen.
   */
  public isVolumeTierEligible(input: EffectiveRateInput): boolean {
    const override = input.override;
    const overrideForcesTiers = override !== null && override.forceVolumeDiscountTiers;
    const overrideProvidesTiers = override !== null && override.customVolumeTiers !== null && override.customVolumeTiers.length > 0;
    return input.plan.volumeDiscountEligible || overrideForcesTiers || overrideProvidesTiers;
  }

  /**
   * Resuelve el tramo de descuento por volumen alcanzado por el consumo acumulado del periodo.
   * Los tramos personalizados del override sustituyen por completo a los del plan cuando existen.
   *
   * @param input - Entrada del motor de tarificacion.
   * @param isEligible - Resultado previo de la elegibilidad, para no repetir la evaluacion.
   * @returns Tramo alcanzado, o `null` cuando no aplica ningun descuento por volumen.
   */
  public resolveApplicableTier(input: EffectiveRateInput, isEligible: boolean): VolumeDiscountTier | null {
    if (!isEligible) {
      return null;
    }

    const overrideTiers = input.override?.customVolumeTiers ?? null;
    const tiers: readonly VolumeDiscountTier[] = overrideTiers !== null && overrideTiers.length > 0 ? overrideTiers : input.plan.volumeDiscountTiers;
    return resolveVolumeDiscountTier(tiers, input.accumulatedOverageMinutes);
  }

  /**
   * Calcula el importe en USD de un consumo ya particionado, aplicando la tarifa efectiva.
   * Solo los minutos en exceso se cobran: los cubiertos por la cuota ya estan pagados con la
   * cuota fija del plan y volver a cobrarlos seria un doble cobro.
   *
   * @param overageMinutes - Minutos que exceden la cuota incluida.
   * @param effectiveRatePerMinuteUsd - Tarifa efectiva ya descontada.
   * @returns Importe del exceso en USD con 6 decimales.
   * @throws ValidationError cuando la tarifa es negativa.
   */
  public calculateOverageCostUsd(overageMinutes: Fixed6String, effectiveRatePerMinuteUsd: UsdAmountFixed6): UsdAmountFixed6 {
    if (DecimalMath.compareFixed6(effectiveRatePerMinuteUsd, ZERO_FIXED6) < 0) {
      throw new ValidationError('La tarifa efectiva por minuto no puede ser negativa.');
    }
    return DecimalMath.multiplyUnitsByRate(overageMinutes, effectiveRatePerMinuteUsd);
  }

  /**
   * Resuelve la tarifa base por minuto segun la precedencia de reglas del sistema.
   * El override del SuperAdmin tiene prioridad absoluta porque representa una negociacion
   * contractual concreta; en su ausencia manda la tarifa declarada por el plan.
   *
   * @param input - Entrada del motor de tarificacion.
   * @returns Tarifa base por minuto en USD.
   */
  public resolveBaseRateUsd(input: EffectiveRateInput): UsdAmountFixed6 {
    if (input.customBaseRateUsd !== null && input.customBaseRateUsd !== undefined) {
      return DecimalMath.formatFixed6(input.customBaseRateUsd, 'tarifa personalizada');
    }

    const overrideRate = input.override?.customRatePerMinuteUsd ?? null;
    if (overrideRate !== null) {
      return DecimalMath.formatFixed6(overrideRate, 'tarifa del override');
    }

    return input.plan.baseOverageRatePerMinuteUsd === ZERO_FIXED6
      ? DEFAULT_BASE_RATE_PER_MINUTE_USD
      : DecimalMath.formatFixed6(input.plan.baseOverageRatePerMinuteUsd, 'tarifa base del plan');
  }

  /**
   * Extrae el descuento manual vigente del override del SuperAdmin.
   *
   * @param override - Override vigente, o `null`.
   * @returns Porcentaje de descuento manual, `0.000000` cuando no existe.
   */
  private resolveManualDiscountPercent(override: OrganizationPricingOverride | null): Fixed6String {
    return override === null ? ZERO_FIXED6 : DecimalMath.formatFixed6(override.manualDiscountPercentage, 'descuento manual');
  }

  /**
   * Calcula el descuento total efectivo de componer dos porcentajes de forma multiplicativa.
   * Se usa unicamente para mostrarlo en el panel: el importe siempre se calcula componiendo.
   * Un consumo de referencia de 100 USD revela directamente el porcentaje retenido, de modo que
   * `100 - retenido` es el descuento real que percibio el cliente.
   *
   * @param volumeDiscountPercent - Porcentaje del tramo de volumen.
   * @param manualDiscountPercent - Porcentaje del descuento manual.
   * @returns Porcentaje total efectivo, en formato decimal de 6 cifras.
   */
  private calculateTotalDiscountPercent(volumeDiscountPercent: Fixed6String, manualDiscountPercent: Fixed6String): Fixed6String {
    const referenceAmountUsd: UsdAmountFixed6 = '100.000000';
    const retainedAmountUsd = DecimalMath.applyCompoundDiscount(referenceAmountUsd, [volumeDiscountPercent, manualDiscountPercent]);
    const discountAmountUsd = DecimalMath.sumFixed6([referenceAmountUsd, `-${retainedAmountUsd}`]);
    return DecimalMath.formatFixed6(discountAmountUsd, 'descuento total');
  }
}

/**
 * Ensambla el motor de tarificacion.
 * Se expone como fabrica para que el contenedor de inyeccion lo registre con la misma forma que el
 * resto de casos de uso del modulo.
 *
 * @returns Instancia del motor de tarificacion.
 */
export function createCalculateEffectiveRateUseCase(): CalculateEffectiveRateUseCase {
  return new CalculateEffectiveRateUseCase();
}
