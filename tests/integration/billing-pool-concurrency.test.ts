/**
 * @archivo tests/integration/billing-pool-concurrency.test.ts
 * @modulo 04-billing-and-whop (Prueba de Concurrencia del Pulso de Cobro, hallazgo C1-21)
 * @proposito
 *   Mide contra PostgreSQL real que el pulso de cobro retenga UNA sola conexion del pool cuando
 *   varias sesiones de la MISMA organizacion cobran a la vez, y que no se pierda ni un cobro. El
 *   defecto anidaba conexiones (exterior + catalogo + bloqueo) y con 50 sesiones se perdian 7
 *   cobros. La prueba falla si el anidamiento vuelve: con el pool acotado, una segunda conexion por
 *   pulso agota el pool y los cobros se pierden o la corrida se queda sin tiempo.
 *
 * @resumen_contenido
 *   - Instrumentacion de `Pool.prototype.connect` (unico punto donde nace una conexion).
 *   - Bloque 1: 5 sesiones x 6 pulsos concurrentes con una conexion por pulso y total exacto.
 *   - Bloque 2: pool de UNA conexion con cliente exterior retenido; el cobro debe caber igual.
 *   - Redis centinela que falla si la deduccion lo toca (el cobro no depende de Redis).
 *
 * @dependencias_internas
 *   - `BillingWhopPortAdapter`, `DeductSessionMinutesUseCase`, `VoiceSessionMeteringService` reales.
 *
 * @dependencias_externas
 *   - `pg` y Redis real (centinela que prohibe su uso en la deduccion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `voice_sessions`.
 */

import { mock } from 'node:test';
import * as assert from 'node:assert';
import { Pool, type PoolClient } from 'pg';
import { BillingWhopPortAdapter } from '../../src/modules/04-billing-and-whop/billing-whop.port-adapter';
import { DeductSessionMinutesUseCase } from '../../src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case';
import { BillingDashboardQueriesUseCase } from '../../src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case';
import { DecimalMath } from '../../src/shared/kernel/decimal.util';
import type { CheckoutUseCaseDependencies } from '../../src/modules/04-billing-and-whop/application/checkout-use-case.dependencies';
import { PostgresBillingRepository } from '../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import {
  createVoiceSessionMeteringService,
  type VoiceSessionMeteringService,
} from '../../src/modules/05-voice-realtime-gateway/application/voice-session-metering.service';
import type { VoiceSessionMeteringStore } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store';
import type { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';
import {
  FIXTURE_MAP_ID,
  FIXTURE_PROJECT_ID,
  prepareBillingFixture,
} from './support/billing-fixtures';

/** Sesiones de voz concurrentes sobre la misma organizacion. */
const CONCURRENT_SESSIONS = 5;

/** Pulsos que ejecuta cada sesion. */
const TICKS_PER_SESSION = 6;

/** Segundos que declara cada pulso (medio minuto). */
const SECONDS_PER_TICK = 30;

/** Cuota sembrada: 10 minutos; cada pulso factura 30 s o mas, de modo que la cuota se agota. */
const FIXTURE_QUOTA_MINUTES = 10;

/** Saldo prepagado sembrado con holgura: cubre todo el exceso aunque el reloj simulado infle los pulsos. */
const FIXTURE_CREDIT_USD = '20.000000';

/** Tope de gasto de la organizacion medida: NULO a proposito (escenario C2-02 con prepago). */
const MEASURED_ORG_ID = '00000000-0000-4000-8000-00000000c9f1';

/** Maximo del pool medido: igual al numero de sesiones, sin holgura para anidar. */
const MEASURED_POOL_MAX = 5;

/** Contador de verificaciones superadas. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion.
 *
 * @param condition - Condicion que debe cumplirse.
 * @param description - Descripcion del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Ejecuta un trabajo con limite de tiempo: si el pool se agota por anidamiento, la espera de
 * conexion no tiene limite propio y la corrida se colgaria para siempre; este limite la convierte
 * en un fallo explicito.
 *
 * @param label - Nombre del bloque medido.
 * @param ms - Tiempo maximo admitido.
 * @param work - Promesa del trabajo.
 * @returns Resultado del trabajo.
 */
async function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`AGOTADO: ${label} supero ${ms} ms sin terminar.`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Identificadores de sesion validos como UUID, uno por sesion concurrente. */
function buildSessionIds(): readonly string[] {
  return Array.from(
    { length: CONCURRENT_SESSIONS },
    (_value, index) => `00000000-0000-4000-8000-00000000c9${index}1`
  );
}

/**
 * Siembra la organizacion medida con tope NULO, cuota de 10 minutos y 10 USD de prepago.
 *
 * @param ownerPool - Pool directo con contexto de gobierno.
 * @param voiceSessionIds - Sesiones que van a facturar.
 */
async function seedMeasuredSubscription(ownerPool: Pool, voiceSessionIds: readonly string[]): Promise<void> {
  await prepareBillingFixture(ownerPool, 180);
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, name, slug, status, dpa_signed_at)
       VALUES ($1, 'Organizacion de concurrencia de cobro', 'concurrencia-de-cobro-pool', 'ACTIVE', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
      [MEASURED_ORG_ID]
    );
    await client.query(
      `INSERT INTO whop_subscriptions (organization_id, plan_code, status,
          period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
          current_period_overage_billed_usd, credit_balance_usd, hard_spend_cap_usd,
          current_period_start, current_period_end)
       VALUES ($1, 'PLAN_50', 'ACTIVE', $2::numeric, $2::numeric, 0.000000, 0.000000, $3::numeric, NULL,
               NOW() - INTERVAL '1 day', NOW() + INTERVAL '29 days')
       ON CONFLICT (organization_id) DO UPDATE
         SET plan_code = 'PLAN_50', status = 'ACTIVE',
             period_included_minutes_quota = $2::numeric, period_included_minutes_remaining = $2::numeric,
             period_overage_minutes_used = 0.000000, current_period_overage_billed_usd = 0.000000,
             credit_balance_usd = $3::numeric, hard_spend_cap_usd = NULL, updated_at = NOW()`,
      [MEASURED_ORG_ID, FIXTURE_QUOTA_MINUTES.toFixed(6), FIXTURE_CREDIT_USD]
    );
    for (const voiceSessionId of voiceSessionIds) {
      await client.query(
        `INSERT INTO voice_sessions (id, organization_id, project_id, functional_map_id, origin_domain,
            ai_model_used, status, client_ip_hash)
         VALUES ($1, $2, $3, $4, 'concurrencia.interno.local', 'GEMINI_3_8_LIVE', 'ACTIVE_STREAMING', $5)
         ON CONFLICT (id) DO NOTHING`,
        [voiceSessionId, MEASURED_ORG_ID, FIXTURE_PROJECT_ID, FIXTURE_MAP_ID, 'c'.repeat(64)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Instrumenta `Pool.prototype.connect` para contar conexiones vivas y su maximo simultaneo.
 *
 * @returns Contador compartido y restauracion garantizada por el llamador.
 */
function instrumentPoolConnections(): { readonly counter: { live: number; peak: number }; readonly uninstall: () => void } {
  const counter = { live: 0, peak: 0 };
  const originalConnect = Pool.prototype.connect;
  Pool.prototype.connect = function instrumentedConnect(this: Pool): Promise<PoolClient> {
    return (originalConnect as (this: Pool) => Promise<PoolClient>).call(this).then((client) => {
      counter.live += 1;
      counter.peak = Math.max(counter.peak, counter.live);
      const originalRelease = client.release.bind(client);
      let released = false;
      client.release = ((error?: Error | boolean) => {
        if (!released) {
          released = true;
          counter.live -= 1;
        }
        return (originalRelease as (value?: Error | boolean) => void)(error);
      }) as PoolClient['release'];
      return client;
    });
  } as typeof Pool.prototype.connect;
  return { counter, uninstall: (): void => {
    Pool.prototype.connect = originalConnect;
  } };
}

/**
 * Ejecuta los pulsos de una sesion sobre el pool, como hace el gateway real: transaccion exterior
 * retenida y deduccion con la conexion del llamador.
 *
 * @param metering - Servicio de facturacion bajo prueba.
 * @param pool - Pool con contexto RLS.
 * @param voiceSessionId - Sesion facturada.
 * @returns Pulsos confirmados con asiento.
 */
async function runSessionTicks(
  metering: VoiceSessionMeteringService,
  pool: RlsDatabasePool,
  voiceSessionId: string
): Promise<number> {
  metering.registerSession(MEASURED_ORG_ID, voiceSessionId, voiceSessionId);
  let confirmed = 0;
  for (let tick = 0; tick < TICKS_PER_SESSION; tick += 1) {
    mock.timers.tick(SECONDS_PER_TICK * 1000);
    const result = await pool.runInTenantTransaction({ organizationId: MEASURED_ORG_ID }, async (client) =>
      metering.runTick(voiceSessionId, { client, sendFrameToClient: () => undefined })
    );
    if (result.ledgerEntryId.length > 0) {
      confirmed += 1;
    }
  }
  return confirmed;
}

/**
 * Lee el total facturado, el numero de asientos y la marca temporal de lectura de la organizacion.
 *
 * La marca temporal delimita los asientos nuevos del libro append-only: como el reloj simulado es
 * global, los pulsos concurrentes facturan mas de 30 s por turno y los totales absolutos NO son
 * deterministas; lo determinista es el CIERRE (cada minuto facturado aparece exactamente una vez
 * en cuota, exceso y libro mayor).
 *
 * @param ownerPool - Pool directo con contexto de gobierno.
 * @returns Total en 6 decimales, conteo de asientos y marca temporal de la lectura.
 */
async function readLedgerState(ownerPool: Pool): Promise<{ readonly total: string; readonly entries: number; readonly readAt: string }> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    const total = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_usd_delta), 0)::TEXT AS total FROM usage_ledger
        WHERE organization_id = $1 AND entry_type = 'VOICE_MINUTE_DEDUCTION'`,
      [MEASURED_ORG_ID]
    );
    const entries = await client.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM usage_ledger
        WHERE organization_id = $1 AND entry_type = 'VOICE_MINUTE_DEDUCTION'`,
      [MEASURED_ORG_ID]
    );
    const clock = await client.query<{ now: string }>(`SELECT NOW()::TEXT AS now`);
    await client.query('ROLLBACK');
    return {
      total: DecimalMath.formatFixed6(total.rows[0]?.total ?? '0', 'total facturado'),
      entries: Number.parseInt(entries.rows[0]?.total ?? '0', 10),
      readAt: clock.rows[0]?.now ?? new Date(0).toISOString(),
    };
  } finally {
    client.release();
  }
}

/** Asiento de consumo recien escrito, con su desglose de metadatos. */
interface FreshLedgerRow {
  /** Variacion de minutos (negativa). */
  readonly minutes: string;
  /** Tarifa unitaria persistida. */
  readonly rate: string;
  /** Importe persistido. */
  readonly amount: string;
  /** Desglose del pulso que origino el asiento. */
  readonly meta: { readonly coveredMinutes: string; readonly overageMinutes: string; readonly overageCostUsd: string; readonly uncoveredCostUsd: string };
}

/**
 * Lee los asientos escritos estrictamente entre dos lecturas, en orden cronologico.
 *
 * @param ownerPool - Pool directo con contexto de gobierno.
 * @param fromIso - Marca de la lectura previa (excluida).
 * @param toIso - Marca de la lectura posterior (incluida).
 * @returns Asientos nuevos ordenados del mas antiguo al mas reciente.
 */
async function readFreshEntries(ownerPool: Pool, fromIso: string, toIso: string): Promise<readonly FreshLedgerRow[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    const result = await client.query<{
      minutes: string;
      rate: string;
      amount: string;
      meta: FreshLedgerRow['meta'];
    }>(
      `SELECT minutes_delta::TEXT AS minutes, unit_rate_usd::TEXT AS rate, amount_usd_delta::TEXT AS amount,
              metadata_json AS meta
         FROM usage_ledger
        WHERE organization_id = $1 AND entry_type = 'VOICE_MINUTE_DEDUCTION'
          AND created_at > $2::timestamptz AND created_at <= $3::timestamptz
        ORDER BY created_at ASC, id ASC`,
      [MEASURED_ORG_ID, fromIso, toIso]
    );
    await client.query('ROLLBACK');
    return result.rows;
  } finally {
    client.release();
  }
}

/** Ejecuta la bateria completa y libera todos los recursos. */
async function main(): Promise<void> {
  console.log('PRUEBA DE CONCURRENCIA DEL PULSO DE COBRO SOBRE EL POOL REAL (C1-21)');
  console.log('='.repeat(96));

  const environment = getEnvConfig();
  const pool = new RlsDatabasePool({
    connectionString: environment.DATABASE_URL,
    maxConnections: MEASURED_POOL_MAX,
    statementTimeoutMs: 60000,
  });
  const ownerPool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, statement_timeout: 60000 });
  ownerPool.on('error', () => undefined);
  const forbiddenRedis = new Proxy({} as RedisClusterClient, {
    get(_target, property): never {
      throw new Error(`La deduccion no debe tocar Redis (acceso a "${String(property)}").`);
    },
  });
  const dependencies: CheckoutUseCaseDependencies = {
    gateway: new WhopApiAndHmacAdapter({
      companyApiKey: environment.WHOP_API_KEY,
      companyId: 'biz_test_company_001',
      webhookSecret: 'whop_webhook_secret_placeholder_dev_32chars',
      checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
      checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
      webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
    }),
    billingRepository: new PostgresBillingRepository(pool),
    redisClient: forbiddenRedis,
    dpaVerifier: { isDpaSigned: async () => ({ signed: true, signedAtIso: new Date().toISOString() }) },
  };
  const billingPort = new BillingWhopPortAdapter(
    dependencies.billingRepository as PostgresBillingRepository,
    pool,
    new DeductSessionMinutesUseCase(dependencies),
    new BillingDashboardQueriesUseCase(dependencies)
  );
  const sessionIds = buildSessionIds();

  try {
    const health = await pool.healthCheck();
    console.log(`PostgreSQL ${health.engineVersion} | Pool medido: maximo ${MEASURED_POOL_MAX} conexiones`);
    await seedMeasuredSubscription(ownerPool, sessionIds);

    const metering = createVoiceSessionMeteringService({
      billingPort,
      meteringStore: { persistTotals: async () => undefined } as unknown as VoiceSessionMeteringStore,
    });
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T00:00:00.000Z') });
    const { counter, uninstall } = instrumentPoolConnections();
    const before = await readLedgerState(ownerPool);
    let confirmedTicks = 0;
    try {
      const outcomes = await withTimeout(
        'pulsos concurrentes',
        150000,
        Promise.all(sessionIds.map((voiceSessionId) => runSessionTicks(metering, pool, voiceSessionId)))
      );
      confirmedTicks = outcomes.reduce((total, value) => total + value, 0);
    } finally {
      uninstall();
      mock.timers.reset();
    }
    const after = await readLedgerState(ownerPool);

    const expectedTicks = CONCURRENT_SESSIONS * TICKS_PER_SESSION;
    console.log(
      `    Sesiones: ${CONCURRENT_SESSIONS} | Confirmados: ${confirmedTicks}/${expectedTicks} | ` +
        `Pico de conexiones vivas: ${counter.peak} (tope ${MEASURED_POOL_MAX})`
    );
    // Cada pulso retiene UNA conexion (la exterior, reutilizada): el pico nunca supera el numero de
    // sesiones concurrentes. Con el defecto, cada pulso tomaba 2-4 y el pool se agotaba.
    check(
      counter.peak <= CONCURRENT_SESSIONS,
      `Ningun pulso debe anidar conexiones: pico ${counter.peak} sobre ${CONCURRENT_SESSIONS} sesiones`
    );
    check(confirmedTicks === expectedTicks, `Ningun pulso debe perderse: ${confirmedTicks} de ${expectedTicks}`);
    check(
      after.entries - before.entries === expectedTicks,
      `Un asiento por pulso: ${after.entries - before.entries} nuevos de ${expectedTicks}`
    );
    // Cierre contable determinista bajo cualquier intercalado: cada minuto facturado aparece
    // exactamente una vez en la cuota, en el exceso y en el libro mayor.
    const fresh = await readFreshEntries(ownerPool, before.readAt, after.readAt);
    check(fresh.length === expectedTicks, `Cada pulso deja su asiento: ${fresh.length} nuevos de ${expectedTicks}`);

    const minutesSum = DecimalMath.sumFixed6(fresh.map((row) => row.minutes));
    const coveredSum = DecimalMath.sumFixed6(fresh.map((row) => row.meta.coveredMinutes));
    const overageSum = DecimalMath.sumFixed6(fresh.map((row) => row.meta.overageMinutes));
    const billedSum = DecimalMath.sumFixed6([coveredSum, overageSum]);
    check(
      DecimalMath.sumFixed6([minutesSum, billedSum]) === '0.000000',
      'Los minutos del libro deben igualar el desglose cubierto + exceso de los metadatos'
    );
    check(coveredSum === '10.000000', `La cuota de 10 minutos debe agotarse exacta (obtenido: ${coveredSum})`);

    for (const row of fresh) {
      const recomputed = DecimalMath.multiplyUnitsByRate(row.meta.overageMinutes, row.rate);
      check(row.rate === '0.128520', `La tarifa del asiento conserva sus 6 decimales (obtenido: ${row.rate})`);
      check(
        recomputed === row.meta.overageCostUsd && row.meta.overageCostUsd === row.amount,
        `exceso x tarifa = importe en el asiento (${row.meta.overageMinutes} x ${row.rate} = ${recomputed}, importe: ${row.amount})`
      );
      check(row.meta.uncoveredCostUsd === '0.000000', 'Cubierto con prepago, nada queda impagable');
    }

    const overageCostSum = DecimalMath.sumFixed6(fresh.map((row) => row.meta.overageCostUsd));
    const actualDelta = DecimalMath.sumFixed6([after.total, `-${before.total}`]);
    check(
      actualDelta === overageCostSum,
      `El total facturado crece exactamente la suma de los excesos (${overageCostSum} USD, obtenido: ${actualDelta})`
    );

    const subscription = await (dependencies.billingRepository as PostgresBillingRepository).findSubscription(MEASURED_ORG_ID);
    check(subscription !== null, 'La suscripcion debe seguir existiendo tras la rafaga');
    check(
      subscription?.periodIncludedMinutesRemaining === '0.000000',
      `Sin cuota restante (obtenido: ${String(subscription?.periodIncludedMinutesRemaining)})`
    );
    check(
      subscription?.periodOverageMinutesUsed === overageSum,
      `El exceso acumulado iguala la suma de los asientos (${overageSum}, obtenido: ${String(subscription?.periodOverageMinutesUsed)})`
    );
    check(
      subscription?.currentPeriodOverageBilledUsd === actualDelta,
      `Lo facturado del periodo iguala el delta del libro (${actualDelta}, obtenido: ${String(subscription?.currentPeriodOverageBilledUsd)})`
    );
    check(
      DecimalMath.sumFixed6([subscription?.creditBalanceUsd ?? '0', actualDelta]) === FIXTURE_CREDIT_USD,
      `El prepago baja exactamente lo facturado (saldo: ${String(subscription?.creditBalanceUsd)})`
    );
    console.log('[1/2] Sesiones concurrentes sin anidar conexiones ni perder cobros: APROBADO.');

    // Caja negra con el pool al minimo: si la deduccion abriera una segunda conexion con la primera
    // retenida, esperaria para siempre (el pool no tiene limite de espera propio).
    const tightPool = new RlsDatabasePool({ connectionString: environment.DATABASE_URL, maxConnections: 1, statementTimeoutMs: 30000 });
    try {
      const tightRepository = new PostgresBillingRepository(tightPool);
      const tightPort = new BillingWhopPortAdapter(
        tightRepository,
        tightPool,
        new DeductSessionMinutesUseCase({ ...dependencies, billingRepository: tightRepository }),
        new BillingDashboardQueriesUseCase({ ...dependencies, billingRepository: tightRepository })
      );
      const beforeTight = await readLedgerState(ownerPool);
      const outcome = await withTimeout(
        'cobro con pool minimo',
        40000,
        tightPool.runInTenantTransaction({ organizationId: MEASURED_ORG_ID }, async (client) =>
          tightPort.deductVoiceSessionSlice(MEASURED_ORG_ID, sessionIds[0] as string, SECONDS_PER_TICK, client)
        )
      );
      check(outcome.ok, `Con una sola conexion el cobro debe completarse (${outcome.ok ? '' : outcome.reason})`);
      if (outcome.ok) {
        check(outcome.deduction.ledgerEntryId.length > 0, 'El cobro debe registrar su asiento contable');
        const afterTight = await readLedgerState(ownerPool);
        check(afterTight.entries - beforeTight.entries === 1, 'El libro mayor debe reflejar el cobro con el pool al minimo');
      }
    } finally {
      await tightPool.close();
    }
    console.log('[2/2] Con el pool agotado a una sola conexion, el cobro sigue completandose: APROBADO.');

    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
  } finally {
    await ownerPool.end();
    await pool.close();
  }
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
