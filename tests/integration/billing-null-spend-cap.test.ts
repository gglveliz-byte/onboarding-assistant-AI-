/**
 * @archivo tests/integration/billing-null-spend-cap.test.ts
 * @modulo 04-billing-and-whop (Prueba del Tope de Gasto Nulo, hallazgo C2-02)
 * @proposito
 *   Demuestra contra PostgreSQL real que una suscripcion SIN tope de gasto duro
 *   (`hard_spend_cap_usd IS NULL`) no acumula deuda infinita: agotada la cuota y sin saldo
 *   prepagado, la deduccion marca la sesion para corte con motivo `FONDOS_AGOTADOS`, NO registra
 *   deuda en el periodo y la admision deniega nuevas sesiones. Con saldo prepagado, el exceso se
 *   cubre con normalidad. Si se reintroduce la acumulacion incondicional de deuda, ESTA prueba
 *   falla: es el riesgo financiero que describe el hallazgo.
 *
 * @resumen_contenido
 *   - Siembra de organizacion, proyecto, mapa, sesion y suscripcion PLAN_30 con tope NULO.
 *   - Deduccion real con cuota agotada y sin saldo: corte, sin deuda y sin admision.
 *   - Recarga de saldo y deduccion cubierta con prepago: exito sin corte.
 *
 * @dependencias_internas
 *   - `DeductSessionMinutesUseCase`, `BillingDashboardQueriesUseCase`, `PostgresBillingRepository`,
 *     `RlsDatabasePool`, `WhopApiAndHmacAdapter`.
 *
 * @dependencias_externas
 *   - `pg` (siembra y lectura con contexto de gobierno) y Redis real (inyectado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `projects`, `functional_maps`, `voice_sessions`,
 *     `whop_subscriptions`, `usage_ledger`.
 */

import * as assert from 'node:assert';
import { Pool } from 'pg';
import {
  BillingDashboardQueriesUseCase,
} from '../../src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case';
import { DeductSessionMinutesUseCase } from '../../src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case';
import type { CheckoutUseCaseDependencies } from '../../src/modules/04-billing-and-whop/application/checkout-use-case.dependencies';
import { PostgresBillingRepository } from '../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';

/** Organizacion aislada de esta prueba. */
const NULL_CAP_ORG_ID = '00000000-0000-4000-8000-00000000d301';

/** Proyecto aislado de esta prueba. */
const NULL_CAP_PROJECT_ID = '00000000-0000-4000-8000-00000000d302';

/** Mapa funcional aislado de esta prueba. */
const NULL_CAP_MAP_ID = '00000000-0000-4000-8000-00000000d303';

/** Sesion de voz aislada de esta prueba. */
const NULL_CAP_SESSION_ID = '00000000-0000-4000-8000-00000000d304';

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
 * Siembra la cadena completa con suscripcion PLAN_30, cuota de 1 minuto, sin saldo y tope NULO.
 *
 * @param ownerPool - Pool directo para la siembra con contexto de gobierno.
 */
async function seedNullCapFixture(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, name, slug, status, dpa_signed_at)
       VALUES ($1, 'Organizacion sin tope de gasto', 'sin-tope-c2-02', 'ACTIVE', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
      [NULL_CAP_ORG_ID]
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment)
       VALUES ($1, $2, 'Proyecto sin tope', 'sin-tope-c2-02', 'LIVE')
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
      [NULL_CAP_PROJECT_ID, NULL_CAP_ORG_ID]
    );
    await client.query(
      `INSERT INTO functional_maps (id, organization_id, project_id, version_number, version_label,
          canonical_map_json, content_sha256_hash, total_elements_count, is_active)
       VALUES ($1, $2, $3, 1, 'v-sin-tope', '{"version":1,"elements":[]}'::jsonb, $4, 0, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [NULL_CAP_MAP_ID, NULL_CAP_ORG_ID, NULL_CAP_PROJECT_ID, 'f'.repeat(64)]
    );
    await client.query(
      `INSERT INTO voice_sessions (id, organization_id, project_id, functional_map_id, origin_domain,
          ai_model_used, status, client_ip_hash)
       VALUES ($1, $2, $3, $4, 'sintope.interno.local', 'GEMINI_3_8_LIVE', 'ACTIVE_STREAMING', $5)
       ON CONFLICT (id) DO NOTHING`,
      [NULL_CAP_SESSION_ID, NULL_CAP_ORG_ID, NULL_CAP_PROJECT_ID, NULL_CAP_MAP_ID, '0'.repeat(64)]
    );
    await client.query(
      `INSERT INTO whop_subscriptions (organization_id, plan_code, status,
          period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
          current_period_overage_billed_usd, credit_balance_usd, hard_spend_cap_usd,
          current_period_start, current_period_end)
       VALUES ($1, 'PLAN_30', 'ACTIVE', 1.000000, 1.000000, 0.000000, 0.000000, 0.000000, NULL,
               NOW() - INTERVAL '1 day', NOW() + INTERVAL '29 days')
       ON CONFLICT (organization_id) DO UPDATE
         SET plan_code = 'PLAN_30', status = 'ACTIVE',
             period_included_minutes_quota = 1.000000, period_included_minutes_remaining = 1.000000,
             period_overage_minutes_used = 0.000000, current_period_overage_billed_usd = 0.000000,
             credit_balance_usd = 0.000000, hard_spend_cap_usd = NULL, updated_at = NOW()`,
      [NULL_CAP_ORG_ID]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recarga saldo prepagado en la suscripcion de la prueba, en UNA sola conexion con contexto.
 *
 * @param ownerPool - Pool directo con contexto de gobierno.
 * @param creditUsd - Saldo a dejar, en formato decimal de 6 cifras.
 */
async function setPrepaidCredit(ownerPool: Pool, creditUsd: string): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    const updated = await client.query(
      `UPDATE whop_subscriptions SET credit_balance_usd = $2::numeric, updated_at = NOW() WHERE organization_id = $1`,
      [NULL_CAP_ORG_ID, creditUsd]
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error('La recarga de saldo no actualizo la suscripcion de la prueba.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Ejecuta la prueba completa contra PostgreSQL y Redis reales. */
async function main(): Promise<void> {
  console.log('PRUEBA DEL TOPE DE GASTO NULO SIN DEUDA INFINITA (C2-02)');
  console.log('='.repeat(96));

  const environment = getEnvConfig();
  const pool = new RlsDatabasePool({ connectionString: environment.DATABASE_URL, maxConnections: 4, statementTimeoutMs: 20000 });
  const ownerPool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, statement_timeout: 20000 });
  ownerPool.on('error', () => undefined);
  const redisClient = createRedisClusterClientFromEnv();
  const repository = new PostgresBillingRepository(pool);
  const dependencies: CheckoutUseCaseDependencies = {
    gateway: new WhopApiAndHmacAdapter({
      companyApiKey: environment.WHOP_API_KEY,
      companyId: 'biz_test_company_001',
      webhookSecret: 'whop_webhook_secret_placeholder_dev_32chars',
      checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
      checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
      webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
    }),
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

    await seedNullCapFixture(ownerPool);

    // 120 segundos = 2 minutos: 1 cubierto por la cuota y 1 de exceso sin respaldo.
    const result = await useCase.execute({
      organizationId: NULL_CAP_ORG_ID,
      projectId: NULL_CAP_PROJECT_ID,
      voiceSessionId: NULL_CAP_SESSION_ID,
      elapsedSeconds: 120,
    });

    check(result.coveredMinutes === '1.000000', `1 minuto va a la cuota (obtenido: ${result.coveredMinutes})`);
    check(result.overageMinutes === '1.000000', `1 minuto va al exceso (obtenido: ${result.overageMinutes})`);
    check(
      result.overageCostUsd === '0.000000',
      `Sin saldo ni tope nada es cargable en este pulso (obtenido: ${result.overageCostUsd})`
    );
    check(
      result.uncoveredCostUsd === '0.166700',
      `Sin tope no hay deuda admitida: el exceso queda impagable (obtenido: ${result.uncoveredCostUsd})`
    );
    check(
      result.shouldTerminateSession === true,
      'La sesion sin tope, sin cuota y sin saldo debe marcarse para corte'
    );
    check(
      result.terminationReason === 'FONDOS_AGOTADOS',
      `El motivo debe ser FONDOS_AGOTADOS (obtenido: ${String(result.terminationReason)})`
    );
    check(result.ledgerEntryId.length > 0, 'El pulso debe dejar su asiento contable aunque provoque el corte');

    const afterCut = await repository.findSubscription(NULL_CAP_ORG_ID);
    check(
      afterCut?.currentPeriodOverageBilledUsd === '0.000000',
      `El periodo NO debe acumular deuda sin tope (acumulado: ${String(afterCut?.currentPeriodOverageBilledUsd)})`
    );
    check(
      afterCut !== null && useCase.shouldTerminateSession(afterCut),
      'La consulta rapida de corte debe ordenar el cierre para la suscripcion sin tope y sin fondos'
    );
    check(
      (await repository.canOrganizationOperate(NULL_CAP_ORG_ID)) === false,
      'La admision debe denegar nuevas sesiones a la suscripcion sin tope y sin fondos'
    );

    const snapshot = await dashboard.getConsumptionSnapshot(NULL_CAP_ORG_ID);
    check(snapshot.hardSpendCapUsd === null, 'El panel debe exponer el tope nulo tal cual, sin inventar uno');
    check(snapshot.canStartSession === false, 'El panel debe bloquear el inicio de sesiones sin fondos ni tope');

    // Con saldo prepagado, el mismo exceso se cubre con normalidad y no hay corte.
    await setPrepaidCredit(ownerPool, '5.000000');
    const prepaid = await useCase.execute({
      organizationId: NULL_CAP_ORG_ID,
      projectId: NULL_CAP_PROJECT_ID,
      voiceSessionId: NULL_CAP_SESSION_ID,
      elapsedSeconds: 60,
    });
    check(prepaid.overageCostUsd === '0.166700', `El exceso de 1 minuto cuesta 0.166700 USD (obtenido: ${prepaid.overageCostUsd})`);
    check(
      prepaid.uncoveredCostUsd === '0.000000',
      `Cubierto con prepago, nada queda impagable (obtenido: ${prepaid.uncoveredCostUsd})`
    );
    check(prepaid.remainingCreditUsd === '4.833300', `El saldo baja a 4.833300 USD (obtenido: ${prepaid.remainingCreditUsd})`);
    check(prepaid.shouldTerminateSession === false, 'Con saldo que cubre el exceso no debe ordenarse el corte');

    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
  } finally {
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
