/**
 * @archivo tests/integration/billing-ledger-precision.test.ts
 * @modulo 04-billing-and-whop (Prueba de Precision Contable del Libro Mayor, hallazgo C2-01)
 * @proposito
 *   Demuestra contra PostgreSQL real que la tarifa unitaria persistida en `usage_ledger.unit_rate_usd`
 *   conserva sus 6 decimales y cumple la identidad `minutos_de_exceso x tarifa = importe`. Con una
 *   tarifa efectiva de 0.128520 USD/min y 10 minutos de exceso, el asiento debe registrar 0.128520 y
 *   1.285200 USD: si se reintroduce el redondeo a centavos, registra 0.130000 y la multiplicacion da
 *   1.300000, de modo que ESTA prueba falla. Sin identidad contable, un auditor detecta el descuadre.
 *
 * @resumen_contenido
 *   - Siembra de organizacion, proyecto, mapa, sesion y suscripcion PLAN_50 propios y aislados.
 *   - Deduccion real de 12 minutos (2 cubiertos + 10 de exceso) contra Neon.
 *   - Lectura del asiento persistido y asercion de igualdad EXACTA de cadenas de 6 decimales.
 *
 * @dependencias_internas
 *   - `DeductSessionMinutesUseCase`, `PostgresBillingRepository`, `RlsDatabasePool`, `DecimalMath`.
 *
 * @dependencias_externas
 *   - `pg` (siembra con contexto de gobierno) y Redis real (inyectado, sin uso en la deduccion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `projects`, `functional_maps`, `voice_sessions`,
 *     `whop_subscriptions`, `usage_ledger` (lectura del asiento recien escrito).
 */

import * as assert from 'node:assert';
import { Pool } from 'pg';
import { DeductSessionMinutesUseCase } from '../../src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case';
import type { CheckoutUseCaseDependencies } from '../../src/modules/04-billing-and-whop/application/checkout-use-case.dependencies';
import { PostgresBillingRepository } from '../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { DecimalMath } from '../../src/shared/kernel/decimal.util';
import { createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';

/** Organizacion aislada de esta prueba (no comparte asientos con otras suites). */
const PRECISION_ORG_ID = '00000000-0000-4000-8000-00000000d201';

/** Proyecto aislado de esta prueba. */
const PRECISION_PROJECT_ID = '00000000-0000-4000-8000-00000000d202';

/** Mapa funcional aislado de esta prueba. */
const PRECISION_MAP_ID = '00000000-0000-4000-8000-00000000d203';

/** Sesion de voz aislada de esta prueba. */
const PRECISION_SESSION_ID = '00000000-0000-4000-8000-00000000d204';

/** Segundos deducidos: 12 minutos (2 cubiertos por la cuota + 10 de exceso). */
const ELAPSED_SECONDS = 720;

/** Tarifa efectiva esperada del PLAN_50 en el primer tramo (0.142800 con 10% de descuento). */
const EXPECTED_RATE_USPD = '0.128520';

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
 * Siembra la cadena completa de la prueba con suscripcion PLAN_50, cuota de 2 minutos y tope alto.
 *
 * @param ownerPool - Pool directo para la siembra con contexto de gobierno.
 */
async function seedPrecisionFixture(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, name, slug, status, dpa_signed_at)
       VALUES ($1, 'Organizacion de precision contable', 'precision-contable-c2-01', 'ACTIVE', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
      [PRECISION_ORG_ID]
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment)
       VALUES ($1, $2, 'Proyecto de precision contable', 'precision-c2-01', 'LIVE')
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
      [PRECISION_PROJECT_ID, PRECISION_ORG_ID]
    );
    await client.query(
      `INSERT INTO functional_maps (id, organization_id, project_id, version_number, version_label,
          canonical_map_json, content_sha256_hash, total_elements_count, is_active)
       VALUES ($1, $2, $3, 1, 'v-precision', '{"version":1,"elements":[]}'::jsonb, $4, 0, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [PRECISION_MAP_ID, PRECISION_ORG_ID, PRECISION_PROJECT_ID, 'd'.repeat(64)]
    );
    await client.query(
      `INSERT INTO voice_sessions (id, organization_id, project_id, functional_map_id, origin_domain,
          ai_model_used, status, client_ip_hash)
       VALUES ($1, $2, $3, $4, 'precision.interno.local', 'GEMINI_3_8_LIVE', 'ACTIVE_STREAMING', $5)
       ON CONFLICT (id) DO NOTHING`,
      [PRECISION_SESSION_ID, PRECISION_ORG_ID, PRECISION_PROJECT_ID, PRECISION_MAP_ID, 'e'.repeat(64)]
    );
    await client.query(
      `INSERT INTO whop_subscriptions (organization_id, plan_code, status,
          period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
          current_period_overage_billed_usd, credit_balance_usd, hard_spend_cap_usd,
          current_period_start, current_period_end)
       VALUES ($1, 'PLAN_50', 'ACTIVE', 2.000000, 2.000000, 0.000000, 0.000000, 0.000000, 10000.000000,
               NOW() - INTERVAL '1 day', NOW() + INTERVAL '29 days')
       ON CONFLICT (organization_id) DO UPDATE
         SET plan_code = 'PLAN_50', status = 'ACTIVE',
             period_included_minutes_quota = 2.000000, period_included_minutes_remaining = 2.000000,
             period_overage_minutes_used = 0.000000, current_period_overage_billed_usd = 0.000000,
             credit_balance_usd = 0.000000, hard_spend_cap_usd = 10000.000000, updated_at = NOW()`,
      [PRECISION_ORG_ID]
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
 * Lee el ultimo asiento de consumo de la sesion con contexto de gobierno.
 *
 * @param ownerPool - Pool directo para la lectura.
 * @returns Tarifas e importes persistidos como texto exacto.
 */
async function readPersistedEntry(ownerPool: Pool): Promise<{ rate: string; amount: string; minutes: string }> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    const result = await client.query<{ rate: string; amount: string; minutes: string }>(
      `SELECT unit_rate_usd::TEXT AS rate, amount_usd_delta::TEXT AS amount, minutes_delta::TEXT AS minutes
         FROM usage_ledger
        WHERE voice_session_id = $1 AND entry_type = 'VOICE_MINUTE_DEDUCTION'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [PRECISION_SESSION_ID]
    );
    await client.query('ROLLBACK');
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('No se encontro el asiento de consumo de la sesion de precision.');
    }
    return row;
  } finally {
    client.release();
  }
}

/** Ejecuta la prueba completa contra PostgreSQL y Redis reales. */
async function main(): Promise<void> {
  console.log('PRUEBA DE PRECISION CONTABLE DEL LIBRO MAYOR (C2-01)');
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

  try {
    const health = await pool.healthCheck();
    const redisHealth = await redisClient.healthCheck();
    console.log(`PostgreSQL ${health.engineVersion} | Redis alcanzable: ${redisHealth.reachable}`);

    await seedPrecisionFixture(ownerPool);

    const result = await useCase.execute({
      organizationId: PRECISION_ORG_ID,
      projectId: PRECISION_PROJECT_ID,
      voiceSessionId: PRECISION_SESSION_ID,
      elapsedSeconds: ELAPSED_SECONDS,
    });

    check(result.billedMinutes === '12.000000', `Se deben cobrar 12 minutos (obtenido: ${result.billedMinutes})`);
    check(result.coveredMinutes === '2.000000', `2 minutos van a la cuota (obtenido: ${result.coveredMinutes})`);
    check(result.overageMinutes === '10.000000', `10 minutos van al exceso (obtenido: ${result.overageMinutes})`);
    check(
      result.effectiveRatePerMinuteUsd === EXPECTED_RATE_USPD,
      `La tarifa efectiva debe ser ${EXPECTED_RATE_USPD} (obtenido: ${result.effectiveRatePerMinuteUsd})`
    );
    check(result.overageCostUsd === '1.285200', `El exceso debe costar 1.285200 USD (obtenido: ${result.overageCostUsd})`);

    const persisted = await readPersistedEntry(ownerPool);
    check(
      persisted.rate === EXPECTED_RATE_USPD,
      `El libro mayor debe persistir la tarifa COMPLETA ${EXPECTED_RATE_USPD}, sin redondear a centavos (obtenido: ${persisted.rate})`
    );
    check(
      persisted.amount === result.overageCostUsd,
      `El importe persistido debe igualar el coste del exceso (persistido: ${persisted.amount}, calculado: ${result.overageCostUsd})`
    );
    check(persisted.minutes === '-12.000000', `El asiento registra el consumo como variacion negativa (obtenido: ${persisted.minutes})`);

    // La identidad contable sobre los VALORES PERSISTIDOS: es lo que revisa un auditor.
    const recomputed = DecimalMath.multiplyUnitsByRate(result.overageMinutes, persisted.rate);
    check(
      recomputed === persisted.amount,
      `minutos_de_exceso x tarifa persistida debe igualar el importe persistido (${result.overageMinutes} x ${persisted.rate} = ${recomputed}, importe: ${persisted.amount})`
    );

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
