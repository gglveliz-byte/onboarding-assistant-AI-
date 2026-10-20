/**
 * @archivo src/modules/04-billing-and-whop/domain/billing-whop.entities.ts
 * @modulo 04-billing-and-whop (Catalogo de Planes y Reglas Puras de Facturacion)
 * @proposito
 *   Reune el catalogo de planes con sus tramos de descuento por volumen y las tres reglas puras de
 *   facturacion: resolver el tramo aplicable a un consumo de exceso, determinar los minutos incluidos
 *   de un plan y decidir si una suscripcion puede iniciar nuevas sesiones de voz. Se mantiene
 *   separado de los tipos para que las capas que solo necesitan las formas no arrastren logica.
 *
 * @resumen_contenido
 *   - Constante `DEFAULT_PLAN_CATALOG`: Catalogo de respaldo alineado con la semilla de la base.
 *   - Funcion `resolveVolumeDiscountTier()`: Tramo aplicable segun el consumo de exceso.
 *   - Funcion `computeIncludedMinutesForPlan()`: Minutos incluidos del plan contratado.
 *   - Funcion `canSubscriptionStartNewSessions()`: Solvencia operativa de una suscripcion.
 *
 * @dependencias_internas
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`) para comparar y normalizar importes.
 *   - `ValidationError` (`src/shared/kernel/result-and-errors.ts`) para entradas invalidas.
 *   - Tipos del dominio (`./billing-whop.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Dominio puro: cero acoplamiento a pasarelas, frameworks o bases de datos).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config` (Este catalogo refleja exactamente su semilla).
 */

import { DecimalMath, type Fixed6String } from '../../../shared/kernel/decimal.util';
import { ValidationError } from '../../../shared/kernel/result-and-errors';
import type {
  BillingPlanCode,
  PricingPlanConfig,
  VolumeDiscountTier,
  WhopSubscriptionState,
} from './billing-whop.types';

/** Minutos incluidos que otorga el plan de pago por uso: ninguno. */
const PAYG_INCLUDED_MINUTES: Fixed6String = '0.000000';

/**
 * Construye una entrada del catalogo de respaldo con los dos campos de aprovisionamiento ya resueltos.
 *
 * @param planCode - Codigo del plan.
 * @param externalPlanId - Identificador REAL del plan en la pasarela (prefijo `plan_`).
 * @param displayName - Nombre comercial del plan.
 * @param monthlyFixedPriceUsd - Cuota fija MENSUAL en USD (neto que liquida en el panel).
 * @param grossPriceUsd - Importe BRUTO cobrado al cliente, con la comision de la pasarela trasladada.
 * @param includedMinutes - Minutos incluidos en el periodo.
 * @param baseOverageRatePerMinuteUsd - Tarifa base por minuto excedente.
 * @param volumeDiscountTiers - Tramos de descuento por volumen.
 * @returns Entrada normalizada y congelada del catalogo.
 */
function fallbackPlan(
  planCode: BillingPlanCode,
  externalPlanId: string,
  displayName: string,
  monthlyFixedPriceUsd: Fixed6String,
  grossPriceUsd: Fixed6String,
  includedMinutes: Fixed6String,
  baseOverageRatePerMinuteUsd: Fixed6String,
  volumeDiscountTiers: readonly VolumeDiscountTier[] = []
): PricingPlanConfig {
  return Object.freeze({
    planCode,
    externalPlanId,
    displayName,
    monthlyFixedPriceUsd,
    includedMinutes,
    baseOverageRatePerMinuteUsd,
    overageAllowed: true,
    volumeDiscountEligible: volumeDiscountTiers.length > 0,
    volumeDiscountTiers,
    grossPriceUsd,
    isProvisioned: /^plan_[A-Za-z0-9]+$/u.test(externalPlanId),
  });
}

/**
 * Catalogo de respaldo de planes, alineado con la semilla de `pricing_plans_config`.
 *
 * Los `externalPlanId` son los identificadores REALES aprovisionados en la pasarela: los marcadores
 * legacy (`whop_plan_starter_5usd`) no existen en Whop y provocaban el fallo de todo checkout. Los
 * importes brutos llevan la comision de la pasarela (3.5% + $0.30) trasladada al cliente, de modo que
 * el neto que liquida en el panel es exactamente la cuota fija de cada plan.
 */
export const DEFAULT_PLAN_CATALOG: Readonly<Record<BillingPlanCode, PricingPlanConfig>> = Object.freeze({
  PAYG: fallbackPlan('PAYG', 'plan_uEqJlVAg0fuE9', 'Pago por Uso Puro (Pay-As-You-Go)', '0.000000', '0.000000', PAYG_INCLUDED_MINUTES, '0.200000'),
  PLAN_5: fallbackPlan('PLAN_5', 'plan_kVPGj57x5DVsm', 'Plan Starter $5 USD / mes', '5.000000', '5.500000', '25.000000', '0.200000'),
  PLAN_10: fallbackPlan('PLAN_10', 'plan_21zGkl7lUR5UN', 'Plan Growth $10 USD / mes', '10.000000', '10.680000', '55.000000', '0.181800'),
  PLAN_30: fallbackPlan('PLAN_30', 'plan_CJ1kwuWUWzdmh', 'Plan Pro $30 USD / mes', '30.000000', '31.400000', '180.000000', '0.166700'),
  PLAN_50: fallbackPlan(
    'PLAN_50',
    'plan_EX3G3Ydbxojg6',
    'Plan Scale & Masivo $50 USD / mes',
    '50.000000',
    '52.130000',
    '350.000000',
    '0.142800',
    [
      { tier: 1, minOveragesMinutes: '0.000000', maxOveragesMinutes: '1000.000000', discountPercent: '10.000000' },
      { tier: 2, minOveragesMinutes: '1000.000001', maxOveragesMinutes: '5000.000000', discountPercent: '20.000000' },
      { tier: 3, minOveragesMinutes: '5000.000001', maxOveragesMinutes: '25000.000000', discountPercent: '35.000000' },
      { tier: 4, minOveragesMinutes: '25000.000001', maxOveragesMinutes: null, discountPercent: '50.000000' },
    ]
  ),
  CUSTOM_ENTERPRISE: fallbackPlan('CUSTOM_ENTERPRISE', 'plan_RcNAAQqUZaFfj', 'Plan Corporativo Personalizado', '0.000000', '0.000000', PAYG_INCLUDED_MINUTES, '0.200000'),
});

/**
 * Resuelve el tramo de descuento por volumen que corresponde a un consumo de exceso.
 * Los tramos se evaluan en orden ascendente y se devuelve el primero cuyo rango contenga el
 * consumo; un consumo por debajo del primer tramo no recibe descuento.
 *
 * @param tiers - Tramos declarados por el plan o por el override.
 * @param overageMinutesUsed - Minutos de exceso acumulados en el periodo.
 * @returns Tramo aplicable, o `null` cuando ningun tramo cubre el consumo.
 * @throws ValidationError cuando el consumo informado es negativo.
 */
export function resolveVolumeDiscountTier(
  tiers: readonly VolumeDiscountTier[],
  overageMinutesUsed: Fixed6String
): VolumeDiscountTier | null {
  if (DecimalMath.compareFixed6(overageMinutesUsed, '0.000000') < 0) {
    throw new ValidationError('Los minutos de exceso no pueden ser negativos.');
  }

  const orderedTiers = [...tiers].sort((left, right) => left.tier - right.tier);
  for (const tier of orderedTiers) {
    const meetsMinimum = DecimalMath.compareFixed6(overageMinutesUsed, tier.minOveragesMinutes) >= 0;
    const belowMaximum = tier.maxOveragesMinutes === null || DecimalMath.compareFixed6(overageMinutesUsed, tier.maxOveragesMinutes) <= 0;
    if (meetsMinimum && belowMaximum) {
      return tier;
    }
  }
  return null;
}

/**
 * Calcula los minutos incluidos que corresponden a un plan contratado.
 * La cuota se otorga en la activacion y se renueva en cada pago exitoso.
 *
 * @param planCode - Plan contratado.
 * @param catalog - Catalogo de planes vigente; por omision, el de respaldo.
 * @returns Minutos incluidos del periodo, en formato decimal de 6 cifras.
 * @throws ValidationError cuando el plan no existe en el catalogo.
 */
export function computeIncludedMinutesForPlan(
  planCode: BillingPlanCode,
  catalog: Readonly<Record<BillingPlanCode, PricingPlanConfig>> = DEFAULT_PLAN_CATALOG
): Fixed6String {
  const plan = catalog[planCode];
  if (plan === undefined) {
    throw new ValidationError(`El plan "${planCode}" no existe en el catalogo de precios vigente.`);
  }
  return DecimalMath.formatFixed6(plan.includedMinutes, 'minutos incluidos del plan');
}

/**
 * Determina si una suscripcion puede iniciar nuevas sesiones de voz.
 * Una suscripcion morosa o cancelada solo puede operar si conserva saldo prepagado: de lo contrario
 * se corta el servicio sin esperar al siguiente pago. Una suscripcion operativa con cuota agotada
 * puede seguir operando porque su plan admite consumo por exceso, PERO solo cuando tiene tope de
 * gasto duro configurado: sin tope no hay deuda admitida (hallazgo C2-02) y la suscripcion opera
 * unicamente con fondos reales, igual que el pago por uso.
 *
 * @param subscription - Estado vigente de la suscripcion.
 * @returns `true` cuando la organizacion puede iniciar sesiones de voz.
 */
export function canSubscriptionStartNewSessions(subscription: WhopSubscriptionState): boolean {
  const hasIncludedMinutes = DecimalMath.compareFixed6(subscription.periodIncludedMinutesRemaining, '0.000000') > 0;
  const hasPrepaidCredit = DecimalMath.compareFixed6(subscription.creditBalanceUsd, '0.000000') > 0;
  const isOperational = subscription.status === 'ACTIVE' || subscription.status === 'TRIALING';

  if (isOperational) {
    if (subscription.planCode !== 'PAYG' && subscription.hardSpendCapUsd === null) {
      return hasIncludedMinutes || hasPrepaidCredit;
    }
    return hasIncludedMinutes || hasPrepaidCredit || subscription.planCode !== 'PAYG';
  }
  return hasPrepaidCredit;
}
