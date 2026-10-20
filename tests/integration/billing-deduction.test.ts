/**
 * @archivo tests/integration/billing-deduction.test.ts
 * @modulo 04-billing-and-whop (Prueba de Integracion de la Deduccion Pesimista de Minutos)
 * @proposito
 *   Certifica contra PostgreSQL real que la deduccion de minutos sea verdaderamente atomica. Se
 *   lanzan ocho deducciones concurrentes contra la misma organizacion y se comprueba que el total
 *   cobrado coincide al sexto decimal con la suma de los pulsos, que cada una genera su propio
 *   asiento contable y que el saldo final es exacto: eso solo puede ocurrir si el bloqueo
 *   `SELECT ... FOR UPDATE` serializo las transacciones, porque sin el varias sesiones leerian el
 *   mismo saldo y lo descontarian dos veces. La cuota sembrada es inferior al consumo total para
 *   ejercitar LAS DOS rutas del reparto —minutos cubiertos y minutos en exceso—, y la prueba
 *   verifica ademas la instantanea del panel, la paginacion por clave y el corte por tope de gasto.
 *
 * @resumen_contenido
 *   - Bloque `verifyConcurrentDeduction()`: Ocho deducciones concurrentes y reparto exacto.
 *   - Bloque `verifyDashboardSnapshot()`: Panel, paginacion y corte de servicio.
 *   - Funcion `main()`: Orquestacion, siembra de fixtures y liberacion de recursos.
 *
 * @dependencias_internas
 *   - `DeductSessionMinutesUseCase` y `BillingDashboardQueriesUseCase` del modulo de cobros.
 *   - `PostgresBillingRepository` y el cliente Redis del kernel.
 *   - Fixtures compartidas (`./support/billing-fixtures.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Pool de propietario para la siembra idempotente de la cadena de datos).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger` y `voice_sessions` (Asientos conservados).
 *   - Redis: `oa:whop:webhook:evt:<id>` (Sin uso directo; el caso de uso lo recibe inyectado).
 */

import { Pool } from 'pg';
import { DecimalMath } from '../../src/shared/kernel/decimal.util';
import { DeductSessionMinutesUseCase } from '../../src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case';
import {
  BillingDashboardQueriesUseCase,
  MAX_LEDGER_PAGE_SIZE,
} from '../../src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case';
import type { CheckoutUseCaseDependencies } from '../../src/modules/04-billing-and-whop/application/checkout-use-case.dependencies';
import { PostgresBillingRepository } from '../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import {
  check,
  countPassedAssertions,
  FIXTURE_INCLUDED_MINUTES,
  FIXTURE_ORG_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_VOICE_SESSION_ID,
  prepareBillingFixture,
  reportFinalFixtureState,
} from './support/billing-fixtures';

/** Numero de deducciones concurrentes lanzadas en la prueba de atomicidad. */
const CONCURRENT_DEDUCTION_COUNT = 8;

/** Segundos que consume cada deduccion concurrente (medio minuto por pulso). */
const SECONDS_PER_CONCURRENT_PULSE = 30;

/**
 * Verifica que las deducciones concurrentes se serialicen sin perder ni duplicar cobros.
 *
 * @param useCase - Caso de uso de deduccion bajo prueba.
 * @param repository - Repositorio para comprobar el saldo resultante.
 */
async function verifyConcurrentDeduction(useCase: DeductSessionMinutesUseCase, repository: PostgresBillingRepository): Promise<void> {
  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENT_DEDUCTION_COUNT }, () =>
      useCase.execute({
        organizationId: FIXTURE_ORG_ID,
        projectId: FIXTURE_PROJECT_ID,
        voiceSessionId: FIXTURE_VOICE_SESSION_ID,
        elapsedSeconds: SECONDS_PER_CONCURRENT_PULSE,
      })
    )
  );

  check(outcomes.length === CONCURRENT_DEDUCTION_COUNT, 'Todas las deducciones concurrentes deben completarse');

  const expectedMinutes = (CONCURRENT_DEDUCTION_COUNT * SECONDS_PER_CONCURRENT_PULSE) / 60;
  const totalBilled = outcomes.reduce((accumulator, entry) => accumulator + Number.parseFloat(entry.billedMinutes), 0);
  check(
    Math.abs(totalBilled - expectedMinutes) < 1e-9,
    `La suma de minutos cobrados debe ser exactamente ${expectedMinutes} (obtenido: ${totalBilled})`
  );

  const ledgerEntries = new Set(outcomes.map((entry) => entry.ledgerEntryId));
  check(ledgerEntries.size === CONCURRENT_DEDUCTION_COUNT, 'Cada deduccion debe generar un asiento contable distinto');
  check(![...ledgerEntries].includes(''), 'Ninguna deduccion con consumo debe carecer de asiento');

  const subscription = await repository.findSubscription(FIXTURE_ORG_ID);
  check(subscription !== null, 'La suscripcion debe seguir existiendo tras las deducciones');

  // La cuota sembrada es inferior al consumo total: la mitad se cubre con la cuota y la otra mitad
  // debe facturarse como exceso. Esto ejercita LAS DOS rutas del reparto en una sola corrida.
  const remaining = Number.parseFloat(subscription?.periodIncludedMinutesRemaining ?? '-1');
  check(
    Math.abs(remaining) < 1e-9,
    `La cuota sembrada de ${FIXTURE_INCLUDED_MINUTES} minutos debe quedar agotada (obtenido: ${remaining})`
  );

  const expectedOverage = expectedMinutes - FIXTURE_INCLUDED_MINUTES;
  check(expectedOverage > 0, 'El escenario debe cruzar el limite de la cuota incluida');
  const overageUsed = Number.parseFloat(subscription?.periodOverageMinutesUsed ?? '-1');
  check(
    Math.abs(overageUsed - expectedOverage) < 1e-9,
    `Los minutos de exceso acumulados deben ser ${expectedOverage} (obtenido: ${overageUsed})`
  );

  const coveredTotal = outcomes.reduce((accumulator, entry) => accumulator + Number.parseFloat(entry.coveredMinutes), 0);
  const overageTotal = outcomes.reduce((accumulator, entry) => accumulator + Number.parseFloat(entry.overageMinutes), 0);
  check(
    Math.abs(coveredTotal - FIXTURE_INCLUDED_MINUTES) < 1e-9,
    `Entre todas las deducciones deben cubrirse ${FIXTURE_INCLUDED_MINUTES} minutos de cuota (obtenido: ${coveredTotal})`
  );
  check(
    Math.abs(overageTotal - expectedOverage) < 1e-9,
    `Entre todas las deducciones deben facturarse ${expectedOverage} minutos de exceso (obtenido: ${overageTotal})`
  );

  const billedTotal = outcomes.reduce((accumulator, entry) => accumulator + Number.parseFloat(entry.overageCostUsd), 0);
  check(billedTotal > 0, `El exceso debe generar un importe facturable positivo (obtenido: ${billedTotal})`);
  // Un plan de suscripcion acumula el exceso como deuda del periodo: la suma de los importes de los
  // asientos debe igualar el importe facturable acumulado, sin perdida de precision.
  check(
    Math.abs(billedTotal - Number.parseFloat(subscription?.currentPeriodOverageBilledUsd ?? '0')) < 1e-9,
    'El importe facturable acumulado debe coincidir con la suma de los importes de los asientos'
  );

  const zeroPulse = await useCase.execute({
    organizationId: FIXTURE_ORG_ID,
    projectId: FIXTURE_PROJECT_ID,
    voiceSessionId: FIXTURE_VOICE_SESSION_ID,
    elapsedSeconds: 0,
  });
  check(zeroPulse.billedMinutes === '0.000000', 'Un pulso de cero segundos no debe cobrar minutos');
  check(zeroPulse.ledgerEntryId === '', 'Un pulso sin consumo no debe escribir en el libro mayor');
  check(!zeroPulse.shouldTerminateSession, 'Un pulso sin consumo no debe provocar el corte de la sesion');

  let negativeRejected = false;
  try {
    await useCase.execute({
      organizationId: FIXTURE_ORG_ID,
      projectId: FIXTURE_PROJECT_ID,
      voiceSessionId: FIXTURE_VOICE_SESSION_ID,
      elapsedSeconds: -5,
    });
  } catch {
    negativeRejected = true;
  }
  check(negativeRejected, 'Un consumo negativo debe rechazarse antes de tocar la base de datos');

  let notANumberRejected = false;
  try {
    await useCase.execute({
      organizationId: FIXTURE_ORG_ID,
      projectId: FIXTURE_PROJECT_ID,
      voiceSessionId: FIXTURE_VOICE_SESSION_ID,
      elapsedSeconds: Number.NaN,
    });
  } catch {
    notANumberRejected = true;
  }
  check(notANumberRejected, 'Un consumo que no es un numero finito debe rechazarse');
}

/**
 * Verifica la instantanea del panel, la paginacion por clave y el corte por tope de gasto.
 *
 * @param dashboard - Caso de uso de consultas del panel.
 * @param useCase - Caso de uso de deduccion, para forzar el tope de gasto.
 */
async function verifyDashboardSnapshot(
  dashboard: BillingDashboardQueriesUseCase,
  useCase: DeductSessionMinutesUseCase,
  repository: PostgresBillingRepository
): Promise<void> {
  const snapshot = await dashboard.getConsumptionSnapshot(FIXTURE_ORG_ID);
  check(snapshot.planCode === 'PLAN_50', 'La instantanea debe declarar el plan contratado');
  check(
    snapshot.appliedTierNumber === 1,
    `El tramo de volumen alcanzado debe ser el primero (obtenido: ${String(snapshot.appliedTierNumber)})`
  );
  check(snapshot.volumeDiscountPercent === '10.000000', 'La instantanea debe exponer el descuento por volumen vigente');
  // La matriz de precios es editable en caliente por el SuperAdmin: la tarifa se deriva del catalogo
  // vivo en lugar de fijar el numero de la semilla, y la invariante verificada es la del tramo.
  const liveCatalog = await repository.getPlanCatalog();
  const baseRate = liveCatalog.PLAN_50?.baseOverageRatePerMinuteUsd ?? '0.000000';
  const expectedRate = DecimalMath.applyCompoundDiscount(baseRate, ['10.000000']);
  check(
    snapshot.effectiveRatePerMinuteUsd === expectedRate,
    `La tarifa efectiva debe ser la base del plan (${baseRate}) con el tramo 1 al 10% = ${expectedRate} (obtenido: ${snapshot.effectiveRatePerMinuteUsd})`
  );
  check(snapshot.hardSpendCapUsd === '1.000000', 'La instantanea debe exponer el tope de gasto configurado');
  check(snapshot.includedMinutesRemaining === '0.000000', 'La instantanea debe reflejar la cuota agotada');
  check(
    snapshot.includedMinutesConsumedPercent === '100.000000',
    `La barra de progreso debe marcar el 100% (obtenido: ${snapshot.includedMinutesConsumedPercent})`
  );
  check(snapshot.canStartSession, 'Un plan de suscripcion activo debe poder seguir operando pese a agotar la cuota');

  const history = await dashboard.getLedgerHistory(FIXTURE_ORG_ID, null, 5);
  check(history.entries.length === 5, `La pagina debe devolver 5 asientos (obtenido: ${history.entries.length})`);
  check(history.hasMore, 'Debe indicarse que existe al menos una pagina adicional');
  check(history.nextCursorIso !== null, 'Debe devolverse la clave de continuacion de la pagina');

  const secondPage = await dashboard.getLedgerHistory(FIXTURE_ORG_ID, history.nextCursorIso, 5);
  check(secondPage.entries.length > 0, 'La segunda pagina debe devolver asientos');
  const firstPageIds = new Set(history.entries.map((entry) => entry.ledgerEntryId));
  const overlaps = secondPage.entries.filter((entry) => firstPageIds.has(entry.ledgerEntryId));
  check(overlaps.length === 0, 'La paginacion por clave no debe repetir asientos entre paginas');

  const voiceEntries = history.entries.filter((entry) => entry.entryType === 'VOICE_MINUTE_DEDUCTION');
  check(voiceEntries.length > 0, 'El historial debe contener asientos de consumo de voz');
  check(
    voiceEntries.every((entry) => entry.voiceSessionId === FIXTURE_VOICE_SESSION_ID),
    'Cada asiento de consumo debe conservar la trazabilidad de su sesion de voz'
  );

  let invalidPageSizeRejected = false;
  try {
    await dashboard.getLedgerHistory(FIXTURE_ORG_ID, null, 0);
  } catch {
    invalidPageSizeRejected = true;
  }
  check(invalidPageSizeRejected, 'Un tamano de pagina invalido debe rechazarse');

  let invalidCursorRejected = false;
  try {
    await dashboard.getLedgerHistory(FIXTURE_ORG_ID, 'no-es-fecha', 5);
  } catch {
    invalidCursorRejected = true;
  }
  check(invalidCursorRejected, 'Una clave de continuacion ilegible debe rechazarse');
  check(MAX_LEDGER_PAGE_SIZE === 200, 'El limite maximo de pagina debe ser 200 asientos');

  const document = await dashboard.exportLedgerCsv(FIXTURE_ORG_ID);
  check(
    document.fileName.startsWith('consumo-') && document.fileName.endsWith('.csv'),
    `El nombre del archivo debe ser descriptivo (obtenido: ${document.fileName})`
  );
  check(document.contentType.includes('text/csv'), 'El tipo de contenido debe declarar CSV');
  check(document.rowCount > 0, 'La exportacion del periodo debe contener asientos');
  check(document.csvContent.startsWith('\uFEFF'), 'La exportacion debe incluir la marca UTF-8');
  check(document.totalConsumedMinutes !== '0.000000', 'La exportacion debe reflejar los minutos consumidos en el periodo');

  // El tope de gasto es de 1 USD: se consume hasta superarlo y se comprueba el corte de servicio.
  let terminationObserved = false;
  let reason: string | null = null;
  for (let attempt = 0; attempt < 12 && !terminationObserved; attempt += 1) {
    const result = await useCase.execute({
      organizationId: FIXTURE_ORG_ID,
      projectId: FIXTURE_PROJECT_ID,
      voiceSessionId: FIXTURE_VOICE_SESSION_ID,
      elapsedSeconds: 120,
    });
    terminationObserved = result.shouldTerminateSession;
    reason = result.terminationReason;
  }
  check(terminationObserved, 'Superar el tope de gasto duro debe marcar la sesion para corte');
  check(
    reason?.includes('TOPE_DE_GASTO_ALCANZADO') === true,
    `El motivo del corte debe identificar el tope alcanzado (obtenido: ${String(reason)})`
  );
}

/** Ejecuta la bateria completa y libera los recursos de forma garantizada. */
async function main(): Promise<void> {
  console.log('PRUEBA DE INTEGRACION DE LA DEDUCCION PESIMISTA DE MINUTOS (PARTE 10)');
  console.log('='.repeat(96));

  const environment = getEnvConfig();
  const pool = new RlsDatabasePool({ connectionString: environment.DATABASE_URL, maxConnections: 6, statementTimeoutMs: 20000 });
  const ownerPool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, idleTimeoutMillis: 8000, statement_timeout: 20000 });
  ownerPool.on('error', () => undefined);
  const redisClient = createRedisClusterClientFromEnv();
  const repository = new PostgresBillingRepository(pool);
  const gateway = new WhopApiAndHmacAdapter({
    companyApiKey: environment.WHOP_API_KEY,
    companyId: 'biz_test_company_001',
    webhookSecret: 'whop_webhook_secret_placeholder_dev_32chars',
    checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
    checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
    webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
  });
  const dependencies: CheckoutUseCaseDependencies = {
    gateway,
    billingRepository: repository,
    redisClient,
    dpaVerifier: { isDpaSigned: async () => ({ signed: true, signedAtIso: new Date().toISOString() }) },
  };
  const useCase = new DeductSessionMinutesUseCase(dependencies);
  const dashboard = new BillingDashboardQueriesUseCase(dependencies);

  try {
    const health = await pool.healthCheck();
    const redisHealth = await redisClient.healthCheck();
    console.log(`PostgreSQL ${health.engineVersion} | Redis alcanzable: ${redisHealth.reachable}`);

    await prepareBillingFixture(ownerPool, FIXTURE_INCLUDED_MINUTES);
    console.log(`Fixtures sembradas: cuota de ${FIXTURE_INCLUDED_MINUTES} minutos y tope de gasto de 1 USD.`);

    await verifyConcurrentDeduction(useCase, repository);
    console.log(`[1/2] ${CONCURRENT_DEDUCTION_COUNT} deducciones concurrentes con reparto exacto cuota/exceso: APROBADO.`);

    await verifyDashboardSnapshot(dashboard, useCase, repository);
    console.log('[2/2] Instantanea del panel, paginacion por clave y corte por tope de gasto: APROBADO.');

    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${countPassedAssertions()} aserciones superadas.`);
  } finally {
    console.log(`Estado final de la fixture: ${await reportFinalFixtureState(repository)}`);
    await redisClient.close();
    await ownerPool.end();
    await pool.close();
  }
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
