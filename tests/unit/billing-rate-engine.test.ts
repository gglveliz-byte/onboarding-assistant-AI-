/**
 * @archivo tests/unit/billing-rate-engine.test.ts
 * @modulo 04-billing-and-whop (Prueba Unitaria del Motor Matematico de Tarificacion)
 * @proposito
 *   Certifica que el motor de tarificacion sea determinista y exacto al sexto decimal, sin tocar
 *   ninguna base de datos: precedencia absoluta del override del operador de gobierno sobre la
 *   tarifa del plan, escalafon de descuento por volumen con sus limites exactos, composicion
 *   multiplicativa de descuentos —un 10% y un 5% producen 14,5% y jamas 15%—, sustitucion de tramos
 *   personalizados y particion exacta del consumo cuando una sesion cruza el limite de la cuota
 *   incluida. Ademas verifica la exportacion contable: escapado CSV correcto y blindaje contra la
 *   inyeccion de formulas, un vector de ataque real cuando el archivo lo abre una hoja de calculo.
 *
 * @resumen_contenido
 *   - Bloque `verifyRatePrecedence()`: Override, plan de pago por uso y tarifas base.
 *   - Bloque `verifyVolumeTiers()`: Tramos alcanzados, limites exactos y tramos personalizados.
 *   - Bloque `verifyDiscountComposition()`: Composicion multiplicativa del descuento.
 *   - Bloque `verifyConsumptionSplit()`: Particion entre cuota incluida y exceso.
 *   - Bloque `verifyCsvExport()`: Escapado, blindaje de formulas y totales.
 *
 * @dependencias_internas
 *   - `CalculateEffectiveRateUseCase` del modulo de cobros.
 *   - Exportador CSV (`src/modules/04-billing-and-whop/application/ledger-csv.exporter.ts`).
 *   - `DEFAULT_PLAN_CATALOG` y fixtures compartidas (`tests/integration/support/billing-fixtures.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente matematica: no abre conexiones ni escribe datos).
 */

import { CalculateEffectiveRateUseCase } from '../../src/modules/04-billing-and-whop/application/calculate-effective-rate.use-case';
import { DEFAULT_PLAN_CATALOG } from '../../src/modules/04-billing-and-whop/domain/billing-whop.entities';
import type { PricingPlanConfig } from '../../src/modules/04-billing-and-whop/domain/billing-whop.types';
import {
  buildLedgerCsvDocument,
  escapeCsvCell,
  summarizeLedgerExport,
} from '../../src/modules/04-billing-and-whop/application/ledger-csv.exporter';
import { buildOverride, buildSubscription, check, countPassedAssertions } from '../integration/support/billing-fixtures';

/** Plan de 30 USD del catalogo, usado como referencia de tarifa base. */
const PLAN_30 = DEFAULT_PLAN_CATALOG.PLAN_30 as PricingPlanConfig;

/** Plan de 50 USD del catalogo, unico elegible para el escalafon de descuento por volumen. */
const PLAN_50 = DEFAULT_PLAN_CATALOG.PLAN_50 as PricingPlanConfig;

/** Verifica la precedencia de tarifas y el plan de pago por uso. */
function verifyRatePrecedence(): void {
  const engine = new CalculateEffectiveRateUseCase();

  const plainQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: null,
    accumulatedOverageMinutes: '0.000000',
  });
  check(plainQuote.baseRatePerMinuteUsd === '0.166700', `La tarifa base de PLAN_30 debe ser 0.166700 (obtenido: ${plainQuote.baseRatePerMinuteUsd})`);
  check(plainQuote.effectiveRatePerMinuteUsd === '0.166700', 'Sin descuentos la tarifa efectiva debe igualar a la base');
  check(plainQuote.volumeDiscountPercent === '0.000000', 'Un plan no elegible no debe recibir descuento por volumen');
  check(plainQuote.appliedTierNumber === null, 'Sin tramo aplicable no debe reportarse numero de tramo');
  check(plainQuote.includedMinutesQuota === '180.000000', 'La cuota incluida debe provenir del plan contratado');
  check(!plainQuote.usesSuperAdminOverride, 'Sin override no debe marcarse la tarifa como negociada');
  check(plainQuote.totalDiscountPercent === '0.000000', 'Sin descuentos el total debe ser cero');

  const overrideQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: buildOverride({ customRatePerMinuteUsd: '0.090000' }),
    accumulatedOverageMinutes: '0.000000',
  });
  check(overrideQuote.baseRatePerMinuteUsd === '0.090000', `El override debe imponer la tarifa base (obtenido: ${overrideQuote.baseRatePerMinuteUsd})`);
  check(overrideQuote.usesSuperAdminOverride, 'La cotizacion debe declarar que usa un override negociado');

  // Un override de 9 centavos debe ganarle a la tarifa del plan aunque el plan sea mas barato.
  const overrideWinsQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_50,
    override: buildOverride({ customRatePerMinuteUsd: '0.090000' }),
    accumulatedOverageMinutes: '30000.000000',
  });
  check(
    overrideWinsQuote.baseRatePerMinuteUsd === '0.090000',
    'El override debe mandar sobre la tarifa del plan aunque existan tramos de volumen'
  );

  const customBaseQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: null,
    accumulatedOverageMinutes: '0.000000',
    customBaseRateUsd: '0.050000',
  });
  check(customBaseQuote.baseRatePerMinuteUsd === '0.050000', 'Una tarifa base inyectada debe tener la maxima precedencia');

  const paygQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PAYG', periodIncludedMinutesQuota: '0.000000', periodIncludedMinutesRemaining: '0.000000' }),
    plan: DEFAULT_PLAN_CATALOG.PAYG as PricingPlanConfig,
    override: null,
    accumulatedOverageMinutes: '0.000000',
  });
  check(paygQuote.baseRatePerMinuteUsd === '0.200000', 'El plan de pago por uso debe tarifar a 0.200000 USD por minuto');
  check(paygQuote.includedMinutesQuota === '0.000000', 'El plan de pago por uso no otorga minutos incluidos');
}

/** Verifica el escalafon de descuento por volumen y sus limites exactos. */
function verifyVolumeTiers(): void {
  const engine = new CalculateEffectiveRateUseCase();

  const tierOneQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: null,
    accumulatedOverageMinutes: '500.000000',
  });
  check(tierOneQuote.volumeTierEligible, 'PLAN_50 debe ser elegible para el escalafon de volumen');
  check(tierOneQuote.volumeDiscountPercent === '10.000000', `500 minutos deben caer en el tramo del 10% (obtenido: ${tierOneQuote.volumeDiscountPercent})`);
  check(tierOneQuote.appliedTierNumber === 1, 'El tramo alcanzado debe reportarse como el numero 1');
  check(tierOneQuote.effectiveRatePerMinuteUsd === '0.128520', `0.1428 con 10% debe dar 0.128520 (obtenido: ${tierOneQuote.effectiveRatePerMinuteUsd})`);

  const boundaryQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: null,
    accumulatedOverageMinutes: '1000.000000',
  });
  check(boundaryQuote.volumeDiscountPercent === '10.000000', 'El limite exacto de 1000 minutos pertenece al primer tramo');

  const justOverBoundaryQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: null,
    accumulatedOverageMinutes: '1000.000001',
  });
  check(justOverBoundaryQuote.volumeDiscountPercent === '20.000000', 'Una millonésima por encima del limite debe saltar al segundo tramo');

  const tierThreeQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: null,
    accumulatedOverageMinutes: '10000.000000',
  });
  check(tierThreeQuote.volumeDiscountPercent === '35.000000', 'Diez mil minutos deben caer en el tramo del 35%');
  check(tierThreeQuote.appliedTierNumber === 3, 'El tercer tramo debe identificarse como tal');

  const tierFourQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: null,
    accumulatedOverageMinutes: '30000.000000',
  });
  check(tierFourQuote.volumeDiscountPercent === '50.000000', 'Treinta mil minutos deben alcanzar el tramo del 50%');
  check(tierFourQuote.appliedTierNumber === 4, 'El cuarto tramo debe identificarse como tal');
  check(tierFourQuote.effectiveRatePerMinuteUsd === '0.071400', `0.1428 con 50% debe dar 0.071400 (obtenido: ${tierFourQuote.effectiveRatePerMinuteUsd})`);

  const forcedTiersQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: buildOverride({ forceVolumeDiscountTiers: true }),
    accumulatedOverageMinutes: '2000.000000',
  });
  check(forcedTiersQuote.volumeTierEligible, 'El override debe poder forzar la elegibilidad de volumen en un plan que no la declara');
  check(forcedTiersQuote.appliedTierNumber === null, 'Sin tramos declarados ni personalizados no hay tramo que aplicar');

  const customTierQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: buildOverride({
      forceVolumeDiscountTiers: true,
      customVolumeTiers: [{ tier: 1, minOveragesMinutes: '0.000000', maxOveragesMinutes: null, discountPercent: '40.000000' }],
    }),
    accumulatedOverageMinutes: '100.000000',
  });
  check(customTierQuote.volumeDiscountPercent === '40.000000', 'Los tramos personalizados del override deben sustituir a los del plan');
  check(customTierQuote.effectiveRatePerMinuteUsd === '0.100020', `0.1667 con 40% debe dar 0.100020 (obtenido: ${customTierQuote.effectiveRatePerMinuteUsd})`);

  const customTiersOverridePlanTiers = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: buildOverride({
      customVolumeTiers: [{ tier: 1, minOveragesMinutes: '0.000000', maxOveragesMinutes: null, discountPercent: '5.000000' }],
    }),
    accumulatedOverageMinutes: '30000.000000',
  });
  check(
    customTiersOverridePlanTiers.volumeDiscountPercent === '5.000000',
    'Un tramo personalizado debe reemplazar por completo el escalafon del plan, incluso si es menos generoso'
  );
}

/** Verifica la composicion multiplicativa de los descuentos. */
function verifyDiscountComposition(): void {
  const engine = new CalculateEffectiveRateUseCase();

  const composedQuote = engine.execute({
    subscription: buildSubscription({ planCode: 'PLAN_50' }),
    plan: PLAN_50,
    override: buildOverride({ manualDiscountPercentage: '5.000000' }),
    accumulatedOverageMinutes: '500.000000',
  });
  // Componer 10% y 5% es multiplicativo: 0.1428 x 0.9 x 0.95 = 0.122094, jamas 0.1428 x 0.85.
  check(composedQuote.effectiveRatePerMinuteUsd === '0.122094', `El descuento compuesto debe ser 0.122094 (obtenido: ${composedQuote.effectiveRatePerMinuteUsd})`);
  check(composedQuote.totalDiscountPercent === '14.500000', `El descuento total debe ser 14.5% y no 15% (obtenido: ${composedQuote.totalDiscountPercent})`);
  check(composedQuote.manualDiscountPercent === '5.000000', 'El descuento manual debe exponerse por separado');

  const manualOnlyQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: buildOverride({ manualDiscountPercentage: '20.000000' }),
    accumulatedOverageMinutes: '0.000000',
  });
  check(manualOnlyQuote.effectiveRatePerMinuteUsd === '0.133360', `0.1667 con 20% manual debe dar 0.133360 (obtenido: ${manualOnlyQuote.effectiveRatePerMinuteUsd})`);

  const zeroDiscountQuote = engine.execute({
    subscription: buildSubscription(),
    plan: PLAN_30,
    override: buildOverride({ manualDiscountPercentage: '0.000000' }),
    accumulatedOverageMinutes: '0.000000',
  });
  check(zeroDiscountQuote.effectiveRatePerMinuteUsd === '0.166700', 'Un descuento manual de cero no debe alterar la tarifa');
  check(zeroDiscountQuote.totalDiscountPercent === '0.000000', 'Un descuento de cero debe reportarse como cero');
}

/** Verifica la particion exacta del consumo entre cuota incluida y exceso. */
function verifyConsumptionSplit(): void {
  const engine = new CalculateEffectiveRateUseCase();

  const exactSplit = engine.splitConsumption('10.000000', '4.000000');
  check(exactSplit.coveredMinutes === '4.000000', 'Un consumo dentro de la cuota debe cubrirse por completo');
  check(exactSplit.overageMinutes === '0.000000', 'Sin cruzar el limite no debe existir exceso');
  check(exactSplit.remainingIncludedMinutes === '6.000000', 'El saldo restante debe ser exacto');
  check(!exactSplit.exhaustedIncludedMinutes, 'Un saldo restante positivo no agota la cuota');

  const exactBoundarySplit = engine.splitConsumption('4.000000', '4.000000');
  check(exactBoundarySplit.coveredMinutes === '4.000000', 'Consumir exactamente la cuota debe cubrirse entero');
  check(exactBoundarySplit.overageMinutes === '0.000000', 'Consumir exactamente la cuota no genera exceso');
  check(exactBoundarySplit.exhaustedIncludedMinutes, 'Consumir exactamente la cuota la deja agotada');

  const crossingSplit = engine.splitConsumption('2.000000', '5.000000');
  check(crossingSplit.coveredMinutes === '2.000000', 'Solo los minutos disponibles cubren la cuota');
  check(crossingSplit.overageMinutes === '3.000000', 'El resto del consumo debe facturarse como exceso');
  check(crossingSplit.remainingIncludedMinutes === '0.000000', 'La cuota queda agotada tras cruzar el limite');
  check(crossingSplit.exhaustedIncludedMinutes, 'Cruzar el limite debe marcar la cuota como agotada');

  const alreadyEmptySplit = engine.splitConsumption('0.000000', '1.000000');
  check(alreadyEmptySplit.coveredMinutes === '0.000000', 'Sin cuota disponible nada puede cubrirse');
  check(alreadyEmptySplit.overageMinutes === '1.000000', 'Sin cuota todo el consumo es exceso');

  const fractionalSplit = engine.splitConsumption('0.500000', '1.250000');
  check(fractionalSplit.coveredMinutes === '0.500000', 'La particion debe funcionar con fracciones de minuto');
  check(fractionalSplit.overageMinutes === '0.750000', 'El exceso fraccionario debe calcularse al sexto decimal');

  const negativeBalanceSplit = engine.splitConsumption('-1.000000', '2.000000');
  check(negativeBalanceSplit.coveredMinutes === '0.000000', 'Un saldo negativo no debe cubrir consumo');
  check(negativeBalanceSplit.overageMinutes === '2.000000', 'Con saldo negativo todo el consumo es exceso');

  check(engine.calculateOverageCostUsd('3.000000', '0.166700') === '0.500100', 'Tres minutos a 0.166700 deben costar 0.500100 USD');
  check(engine.calculateOverageCostUsd('0.000000', '0.166700') === '0.000000', 'Sin exceso el importe debe ser cero');
  check(engine.calculateOverageCostUsd('8.000000', '0.128520') === '1.028160', 'Ocho minutos a 0.128520 deben costar 1.028160 USD');

  let negativeRateRejected = false;
  try {
    engine.calculateOverageCostUsd('1.000000', '-0.100000');
  } catch {
    negativeRateRejected = true;
  }
  check(negativeRateRejected, 'Una tarifa negativa debe rechazarse');

  let negativeConsumptionRejected = false;
  try {
    engine.splitConsumption('10.000000', '-1.000000');
  } catch {
    negativeConsumptionRejected = true;
  }
  check(negativeConsumptionRejected, 'Un consumo negativo debe rechazarse');
}

/** Verifica el escapado, el blindaje de formulas y los totales de la exportacion contable. */
function verifyCsvExport(): void {
  check(escapeCsvCell('texto simple') === 'texto simple', 'Un valor sin caracteres especiales no debe comillarse');
  check(escapeCsvCell('con,coma') === '"con,coma"', 'Un valor con coma debe comillarse');
  check(escapeCsvCell('con"comilla') === '"con""comilla"', 'Las comillas internas deben duplicarse segun el estandar CSV');
  check(escapeCsvCell('=SUMA(A1:A9)') === "'=SUMA(A1:A9)", 'Una formula debe neutralizarse con comilla simple');
  check(escapeCsvCell('+34 600') === "'+34 600", 'Un valor que empieza por mas debe neutralizarse');
  check(escapeCsvCell('-1.000000') === "'-1.000000", 'Un valor negativo debe neutralizarse para no evaluarse como formula');
  check(escapeCsvCell('@SUM') === "'@SUM", 'Un valor que empieza por arroba debe neutralizarse');
  check(escapeCsvCell('=1,2') === '"\'=1,2"', 'La neutralizacion y el comillado deben combinarse cuando ambos aplican');

  const document = buildLedgerCsvDocument([
    {
      ledgerEntryId: 'asiento-1',
      projectId: null,
      voiceSessionId: null,
      entryType: 'VOICE_MINUTE_DEDUCTION',
      minutesDelta: '-0.500000',
      unitRateUsd: '0.166700',
      discountAppliedPercent: '0.000000',
      amountUsdDelta: '0.083350',
      includedMinutesBalanceAfter: '179.500000',
      creditBalanceUsdAfter: '0.000000',
      createdAtIso: '2026-01-15T10:00:00.000Z',
    },
  ]);
  check(document.startsWith('\uFEFF'), 'El documento debe iniciar con la marca UTF-8 para no corromper acentos');
  check(document.includes('asiento_id'), 'El documento debe incluir el encabezado de columnas');
  check(document.includes('\r\n'), 'El documento debe usar terminador CRLF');
  check(document.includes("'-0.500000"), 'Los minutos negativos deben exportarse neutralizados');

  const emptyDocument = buildLedgerCsvDocument([]);
  check(emptyDocument.includes('asiento_id'), 'Un periodo sin asientos debe conservar el encabezado');
  check(emptyDocument.split('\r\n').filter((line) => line.length > 0).length === 1, 'Un periodo sin asientos solo debe tener el encabezado');

  const totals = summarizeLedgerExport([
    {
      ledgerEntryId: 'a',
      projectId: null,
      voiceSessionId: null,
      entryType: 'VOICE_MINUTE_DEDUCTION',
      minutesDelta: '-1.500000',
      unitRateUsd: '0.166700',
      discountAppliedPercent: '0.000000',
      amountUsdDelta: '0.250050',
      includedMinutesBalanceAfter: '178.500000',
      creditBalanceUsdAfter: '0.000000',
      createdAtIso: '2026-01-15T10:00:00.000Z',
    },
    {
      ledgerEntryId: 'b',
      projectId: null,
      voiceSessionId: null,
      entryType: 'PAYMENT_SUCCEEDED_TOPUP',
      minutesDelta: '0.000000',
      unitRateUsd: '0.000000',
      discountAppliedPercent: '0.000000',
      amountUsdDelta: '25.000000',
      includedMinutesBalanceAfter: '178.500000',
      creditBalanceUsdAfter: '25.000000',
      createdAtIso: '2026-01-15T11:00:00.000Z',
    },
    {
      ledgerEntryId: 'c',
      projectId: null,
      voiceSessionId: null,
      entryType: 'PLAN_ACTIVATION_GRANT',
      minutesDelta: '180.000000',
      unitRateUsd: '0.166700',
      discountAppliedPercent: '0.000000',
      amountUsdDelta: '0.000000',
      includedMinutesBalanceAfter: '358.500000',
      creditBalanceUsdAfter: '25.000000',
      createdAtIso: '2026-01-15T12:00:00.000Z',
    },
  ]);
  check(totals.rowCount === 3, 'El resumen debe contar los tres asientos');
  check(totals.totalBilledUsd === '25.250050', `La suma de importes debe ser exacta (obtenido: ${totals.totalBilledUsd})`);
  check(
    totals.totalConsumedMinutes === '1.500000',
    `Solo el consumo de voz cuenta como minutos consumidos, no los otorgamientos (obtenido: ${totals.totalConsumedMinutes})`
  );

  const emptyTotals = summarizeLedgerExport([]);
  check(emptyTotals.rowCount === 0, 'Un rango sin asientos debe resumirse en cero');
  check(emptyTotals.totalBilledUsd === '0.000000', 'Un rango sin asientos no debe facturar nada');
}

/** Ejecuta los cinco bloques de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA UNITARIA DEL MOTOR MATEMATICO DE TARIFICACION (PARTE 10)');
  console.log('='.repeat(96));

  verifyRatePrecedence();
  console.log('[1/5] Precedencia de tarifas: override, plan y pago por uso: APROBADO.');

  verifyVolumeTiers();
  console.log('[2/5] Escalafon de descuento por volumen y limites exactos: APROBADO.');

  verifyDiscountComposition();
  console.log('[3/5] Composicion multiplicativa de descuentos: APROBADO.');

  verifyConsumptionSplit();
  console.log('[4/5] Particion exacta entre cuota incluida y exceso: APROBADO.');

  verifyCsvExport();
  console.log('[5/5] Exportacion contable con blindaje de formulas: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
}

main();
