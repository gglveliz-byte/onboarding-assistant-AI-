/**
 * @archivo tests/integration/whop-billing.test.ts
 * @modulo 04-billing-and-whop (Prueba de Integracion del Procesador de Webhooks contra Neon y Redis)
 * @proposito
 *   Ejecuta el procesador de webhooks contra los servicios reales: PostgreSQL en Neon con RLS activo
 *   y el cliente Redis con la marca de idempotencia. Se certifica que un evento activa la suscripcion
 *   y otorga los minutos del plan contratado, que un reenvio del mismo evento se descarta sin
 *   duplicar nada, que la restriccion unica del libro mayor impide el asiento duplicado aunque se
 *   borre la marca de Redis, y que la invalidacion congela los minutos incluidos conservando el saldo
 *   prepagado. Todas las fixtures usan tablas mutables y se eliminan al terminar.
 *
 * @resumen_contenido
 *   - Fixtures: organizacion de prueba con acuerdo de datos firmado.
 *   - Bloque `verifyActivation()`: Activacion de suscripcion con otorgamiento de minutos.
 *   - Bloque `verifyIdempotency()`: Reenvio descartado y respaldo por indice unico contable.
 *   - Bloque `verifyRenewalAndTopUp()`: Renovacion de cupo y recarga de saldo prepagado.
 *   - Bloque `verifyInvalidation()`: Congelamiento de minutos conservando el saldo prepagado.
 *
 * @dependencias_internas
 *   - `ProcessWhopWebhookUseCase` y `CreateWhopCheckoutUseCase` del modulo de cobros.
 *   - `PostgresBillingRepository`, `WhopApiAndHmacAdapter` y el cliente Redis del kernel.
 *
 * @dependencias_externas
 *   - `pg` (Limpieza directa de las fixtures) y `node:assert`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `whop_subscriptions` y `usage_ledger`.
 *   - Redis: `oa:whop:webhook:evt:<id>` (Marcas de idempotencia eliminadas al finalizar).
 */

import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ProcessWhopWebhookUseCase } from '../../src/modules/04-billing-and-whop/application/process-whop-webhook.use-case';
import type { CheckoutUseCaseDependencies } from '../../src/modules/04-billing-and-whop/application/checkout-use-case.dependencies';
import { PostgresBillingRepository } from '../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter, type WhopWebhookHeaders } from '../../src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter';
import { getEnvConfig } from '../../src/config/env.schema';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient, createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';

/** Secreto de webhooks usado por las fixtures firmadas. */
const TEST_WEBHOOK_SECRET = 'whop_webhook_secret_placeholder_dev_32chars';

/**
 * Identificador deterministico de la organizacion de prueba.
 * Se reutiliza entre corridas porque `usage_ledger` es append-only por diseno: una organizacion nueva
 * en cada ejecucion acumularia asientos que jamas podrian eliminarse. Con identificador fijo, la
 * limpieza elimina la suscripcion y la organizacion, y los asientos quedan huerfanos sin bloquear.
 */
const FIXTURE_ORG_ID = '00000000-0000-4000-8000-00000000b111';

/** Identificador de la membresia de prueba en la pasarela. */
const FIXTURE_MEMBERSHIP_ID = `mem_${randomUUID().slice(0, 12)}`;

/** Marcas de idempotencia creadas por la prueba, eliminadas al finalizar. */
const createdIdempotencyKeys: string[] = [];

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Construye el cuerpo crudo y las cabeceras firmadas de un webhook sintetico valido.
 *
 * @param eventId - Identificador unico del evento.
 * @param eventName - Nombre canonico del evento.
 * @param data - Datos del evento que se envian dentro del cuerpo.
 * @returns Cuerpo crudo y cabeceras firmadas.
 */
function buildSignedWebhook(
  eventId: string,
  eventName: string,
  data: Readonly<Record<string, unknown>>
): { readonly rawBody: Buffer; readonly headers: WhopWebhookHeaders } {
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const rawBody = Buffer.from(JSON.stringify({ event_id: eventId, event_type: eventName, data: { organization_id: FIXTURE_ORG_ID, ...data } }), 'utf8');
  const headers: WhopWebhookHeaders = {
    eventId,
    timestampHeader: String(timestampSeconds),
    signatureHeader: CryptoUtils.hmacSha256Hex(TEST_WEBHOOK_SECRET, `${timestampSeconds}.${rawBody.toString('utf8')}`),
    eventNameHeader: eventName,
  };
  return { rawBody, headers };
}

/**
 * Siembra la organizacion de prueba con el acuerdo de procesamiento de datos firmado.
 * La siembra es idempotente (`ON CONFLICT DO UPDATE`) porque la organizacion determinista se
 * reutiliza entre corridas: el libro mayor append-only impide eliminarla y sus referencias
 * historicas deben seguir siendo validas.
 *
 * @param ownerPool - Pool con privilegios de propietario para la siembra.
 */
async function prepareFixtureOrganization(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, name, slug, status, dpa_signed_at)
       VALUES ($1, $2, $3, 'ACTIVE', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE
         SET status = 'ACTIVE', dpa_signed_at = COALESCE(organizations.dpa_signed_at, NOW() - INTERVAL '1 day'), updated_at = NOW()`,
      [FIXTURE_ORG_ID, 'Organizacion de prueba de cobros', `prueba-cobros-${FIXTURE_ORG_ID.slice(0, 8)}`]
    );
    // La suscripcion tambien se reutiliza mediante upsert: el libro mayor la referencia con
    // `ON DELETE SET NULL`, por lo que borrarla dispararia un UPDATE prohibido sobre sus asientos.
    // Reiniciar sus saldos es la unica via compatible con la inmutabilidad contable.
    await client.query(
      `INSERT INTO whop_subscriptions (organization_id, plan_code, status,
          period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
          current_period_overage_billed_usd, credit_balance_usd)
       VALUES ($1, 'PAYG', 'ACTIVE', 0.000000, 0.000000, 0.000000, 0.000000, 0.000000)
       ON CONFLICT (organization_id) DO UPDATE
         SET plan_code = 'PAYG', status = 'ACTIVE',
             period_included_minutes_quota = 0.000000, period_included_minutes_remaining = 0.000000,
             period_overage_minutes_used = 0.000000, current_period_overage_billed_usd = 0.000000,
             credit_balance_usd = 0.000000, whop_membership_id = NULL,
             last_whop_webhook_event_id = NULL, updated_at = NOW()`,
      [FIXTURE_ORG_ID]
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
 * Elimina todas las fixtures de la prueba respetando el orden de las claves foraneas.
 *
 * @param ownerPool - Pool con privilegios de propietario para la limpieza.
 * @returns Resumen del rastro remanente tras la limpieza.
 */
async function cleanupFixtures(ownerPool: Pool): Promise<{ readonly subscriptions: string; readonly ledgerEntries: string; readonly organizations: string }> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    // La limpieza NO elimina la suscripcion ni la organizacion: los asientos historicos del libro
    // mayor las referencian y su trigger de inmutabilidad bloquea cualquier `DELETE` o `UPDATE`,
    // incluido el propagado por la clave foranea. En su lugar se informa el estado y la siguiente
    // ejecucion reinicia las fixtures mutables al sembrarlas.
    const remaining = await client.query<{ subscriptions: string; ledger: string; organizations: string }>(
      `SELECT (SELECT COUNT(*)::TEXT FROM whop_subscriptions WHERE organization_id = $1) AS subscriptions,
              (SELECT COUNT(*)::TEXT FROM usage_ledger WHERE organization_id = $1) AS ledger,
              (SELECT COUNT(*)::TEXT FROM organizations WHERE id = $1) AS organizations`,
      [FIXTURE_ORG_ID]
    );
    await client.query('COMMIT');
    const row = remaining.rows[0];
    return { subscriptions: row?.subscriptions ?? '?', ledgerEntries: row?.ledger ?? '?', organizations: row?.organizations ?? '?' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Verifica que un evento de activacion cree la suscripcion y otorgue los minutos del plan. */
async function verifyActivation(
  useCase: ProcessWhopWebhookUseCase,
  repository: PostgresBillingRepository
): Promise<void> {
  const eventId = `evt_activation_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(eventId);
  const { rawBody, headers } = buildSignedWebhook(eventId, 'membership.went_valid', {
    membership_id: FIXTURE_MEMBERSHIP_ID,
    internal_plan_code: 'PLAN_30',
    plan_id: 'whop_plan_pro_30usd',
    period_start: new Date().toISOString(),
    period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
  });

  const outcome = await useCase.execute(rawBody, headers);
  check(!outcome.wasDuplicate, 'La primera activacion no debe considerarse duplicada');
  check(outcome.ledgerEntryId !== null, 'La activacion debe registrar un asiento contable');
  check(outcome.appliedAction.includes('180.000000'), `La activacion de PLAN_30 debe otorgar 180 minutos (accion: ${outcome.appliedAction})`);

  const subscription = await repository.findSubscription(FIXTURE_ORG_ID);
  check(subscription !== null, 'La suscripcion debe existir tras la activacion');
  check(subscription?.status === 'ACTIVE', 'La suscripcion debe quedar activa');
  check(subscription?.planCode === 'PLAN_30', 'El plan contratado debe quedar registrado');
  check(subscription?.periodIncludedMinutesRemaining === '180.000000', 'Los minutos incluidos deben quedar disponibles en su totalidad');
  check(subscription?.periodIncludedMinutesQuota === '180.000000', 'La cuota del periodo debe coincidir con el plan');
  check(subscription?.externalMembershipId === FIXTURE_MEMBERSHIP_ID, 'La membresia externa debe quedar vinculada');
  check(subscription?.lastExternalEventId === eventId, 'El ultimo evento aplicado debe quedar registrado');
  check(await repository.canOrganizationOperate(FIXTURE_ORG_ID), 'Una organizacion activa con minutos debe poder operar');
}

/**
 * Verifica la doble idempotencia: marca en Redis y restriccion unica del libro mayor.
 *
 * @param useCase - Caso de uso bajo prueba.
 * @param repository - Repositorio para comprobar los saldos resultantes.
 * @param redisClient - Cliente Redis para eliminar la marca y forzar el camino del indice unico.
 */
async function verifyIdempotency(
  useCase: ProcessWhopWebhookUseCase,
  repository: PostgresBillingRepository,
  redisClient: RedisClusterClient
): Promise<void> {
  const eventId = `evt_activation_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(eventId);
  const { rawBody, headers } = buildSignedWebhook(eventId, 'membership.went_valid', {
    membership_id: FIXTURE_MEMBERSHIP_ID,
    internal_plan_code: 'PLAN_10',
    period_start: new Date().toISOString(),
    period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
  });

  const firstOutcome = await useCase.execute(rawBody, headers);
  check(!firstOutcome.wasDuplicate, 'El primer envio debe procesarse');
  const balanceAfterFirst = (await repository.findSubscription(FIXTURE_ORG_ID))?.periodIncludedMinutesRemaining;
  check(balanceAfterFirst === '55.000000', `El cambio de plan debe otorgar los 55 minutos de PLAN_10 (saldo: ${String(balanceAfterFirst)})`);

  const repeatedOutcome = await useCase.execute(rawBody, headers);
  check(repeatedOutcome.wasDuplicate, 'El reenvio del mismo evento debe descartarse como duplicado');
  check(repeatedOutcome.ledgerEntryId === null, 'Un evento duplicado no debe generar un segundo asiento');
  const balanceAfterRepeat = (await repository.findSubscription(FIXTURE_ORG_ID))?.periodIncludedMinutesRemaining;
  check(balanceAfterRepeat === balanceAfterFirst, 'El reenvio no debe alterar el saldo de minutos');

  // Se elimina la marca de Redis para forzar el segundo mecanismo: el indice unico del libro mayor.
  await redisClient.keys.remove(redisClient.keyNamespaces.webhookEventSeen(eventId));
  let conflictThrown = false;
  try {
    await useCase.execute(rawBody, headers);
  } catch (error) {
    conflictThrown = error instanceof Error && error.message.includes('idempotencia contable');
  }
  check(conflictThrown, 'Sin la marca de Redis, el indice unico del libro mayor debe impedir el asiento duplicado');

  const balanceAfterForced = (await repository.findSubscription(FIXTURE_ORG_ID))?.periodIncludedMinutesRemaining;
  check(balanceAfterForced === balanceAfterFirst, 'El intento forzado tampoco debe alterar el saldo');
}

/** Verifica la renovacion del cupo y la recarga de saldo prepagado. */
async function verifyRenewalAndTopUp(useCase: ProcessWhopWebhookUseCase, repository: PostgresBillingRepository): Promise<void> {
  const renewalEventId = `evt_renewal_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(renewalEventId);
  const renewalWebhook = buildSignedWebhook(renewalEventId, 'payment.succeeded', {
    payment_id: `pay_${randomUUID().slice(0, 8)}`,
    membership_id: FIXTURE_MEMBERSHIP_ID,
    amount_usd: 10,
    payment_kind: 'renewal',
    period_start: new Date().toISOString(),
    period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
  });

  // Se agota parte del cupo escribiendo un consumo previo para comprobar el reinicio de excesos.
  const renewalOutcome = await useCase.execute(renewalWebhook.rawBody, renewalWebhook.headers);
  check(!renewalOutcome.wasDuplicate, 'La renovacion debe procesarse');
  check(renewalOutcome.appliedAction.includes('55.000000'), `La renovacion debe restablecer los 55 minutos del plan (accion: ${renewalOutcome.appliedAction})`);

  const afterRenewal = await repository.findSubscription(FIXTURE_ORG_ID);
  check(afterRenewal?.periodIncludedMinutesRemaining === '55.000000', 'La renovacion debe restablecer el cupo completo');
  check(afterRenewal?.periodOverageMinutesUsed === '0.000000', 'La renovacion debe reiniciar el contador de excesos');
  check(afterRenewal?.creditBalanceUsd === '0.000000', 'Una renovacion no debe modificar el saldo prepagado');

  const topUpEventId = `evt_topup_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(topUpEventId);
  const topUpWebhook = buildSignedWebhook(topUpEventId, 'payment.succeeded', {
    payment_id: `pay_${randomUUID().slice(0, 8)}`,
    amount_usd: 25.5,
    payment_kind: 'top_up',
  });

  const topUpOutcome = await useCase.execute(topUpWebhook.rawBody, topUpWebhook.headers);
  check(!topUpOutcome.wasDuplicate, 'La recarga debe procesarse');
  check(topUpOutcome.appliedAction.includes('25.500000'), `La recarga debe sumar el importe exacto (accion: ${topUpOutcome.appliedAction})`);

  const afterTopUp = await repository.findSubscription(FIXTURE_ORG_ID);
  check(afterTopUp?.creditBalanceUsd === '25.500000', `El saldo prepagado debe quedar en 25.500000 USD (saldo: ${String(afterTopUp?.creditBalanceUsd)})`);
  check(afterTopUp?.periodIncludedMinutesRemaining === '55.000000', 'Una recarga no debe alterar los minutos incluidos');

  const secondTopUpEventId = `evt_topup_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(secondTopUpEventId);
  const secondTopUpWebhook = buildSignedWebhook(secondTopUpEventId, 'payment.succeeded', {
    payment_id: `pay_${randomUUID().slice(0, 8)}`,
    amount_usd: 4.5,
    payment_kind: 'top_up',
  });
  await useCase.execute(secondTopUpWebhook.rawBody, secondTopUpWebhook.headers);

  const afterSecondTopUp = await repository.findSubscription(FIXTURE_ORG_ID);
  check(
    afterSecondTopUp?.creditBalanceUsd === '30.000000',
    `Dos recargas deben acumularse sin perdida de precision (saldo: ${String(afterSecondTopUp?.creditBalanceUsd)})`
  );
}

/** Verifica que la invalidacion congele los minutos incluidos conservando el saldo prepagado. */
async function verifyInvalidation(useCase: ProcessWhopWebhookUseCase, repository: PostgresBillingRepository): Promise<void> {
  const eventId = `evt_invalid_${randomUUID().slice(0, 8)}`;
  createdIdempotencyKeys.push(eventId);
  const { rawBody, headers } = buildSignedWebhook(eventId, 'membership.went_invalid', {
    membership_id: FIXTURE_MEMBERSHIP_ID,
    reason: 'PAGO_RECHAZADO_POR_EL_EMISOR',
  });

  const outcome = await useCase.execute(rawBody, headers);
  check(!outcome.wasDuplicate, 'La invalidacion debe procesarse');
  check(outcome.ledgerEntryId === null, 'La invalidacion no genera asiento porque no mueve saldos');
  check(outcome.appliedAction.includes('PAGO_RECHAZADO_POR_EL_EMISOR'), `El motivo debe conservarse en la accion aplicada (accion: ${outcome.appliedAction})`);

  const subscription = await repository.findSubscription(FIXTURE_ORG_ID);
  check(subscription?.status === 'PAST_DUE_OR_INVALID', 'La suscripcion debe quedar en estado moroso');
  check(subscription?.periodIncludedMinutesRemaining === '0.000000', 'Los minutos incluidos deben quedar congelados');
  check(subscription?.periodIncludedMinutesQuota === '55.000000', 'La cuota contratada debe conservarse para la auditoria');
  check(subscription?.creditBalanceUsd === '30.000000', 'El saldo prepagado debe conservarse intacto ante la morosidad');
  check(
    await repository.canOrganizationOperate(FIXTURE_ORG_ID),
    'Una organizacion morosa con saldo prepagado debe poder seguir operando'
  );
}

/** Ejecuta la bateria completa preparando y limpiando las fixtures de forma garantizada. */
async function main(): Promise<void> {
  console.log('PRUEBA DE INTEGRACION DEL PROCESADOR DE WEBHOOKS DE COBRO (PARTE 9)');
  console.log('='.repeat(96));

  const environment = getEnvConfig();
  // Los tiempos maximos se acotan para que un bloqueo falle rapido y con un error claro en lugar de
// esperar el timeout de inactividad del servidor gestionado.
  const pool = new RlsDatabasePool({ connectionString: environment.DATABASE_URL, maxConnections: 4, statementTimeoutMs: 20000 });  const ownerPool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, idleTimeoutMillis: 8000, statement_timeout: 20000 });

  // Un servidor gestionado puede cerrar una conexion ociosa por su propia politica; sin este
  // manejador el evento `error` de un cliente inactivo derriba el proceso de prueba.
  ownerPool.on('error', () => undefined);
  const redisClient = createRedisClusterClientFromEnv();
  const repository = new PostgresBillingRepository(pool);
  const gateway = new WhopApiAndHmacAdapter({
    apiKey: environment.WHOP_API_KEY,
    webhookSecret: TEST_WEBHOOK_SECRET,
    checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
    apiBaseUrl: environment.WHOP_API_BASE_URL,
    checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
    webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
  });

  const dependencies: CheckoutUseCaseDependencies = {
    gateway,
    billingRepository: repository,
    redisClient,
    dpaVerifier: {
      isDpaSigned: async () => ({ signed: true, signedAtIso: new Date().toISOString() }),
    },
  };
  const useCase = new ProcessWhopWebhookUseCase(dependencies);

  try {
    const health = await pool.healthCheck();
    const redisHealth = await redisClient.healthCheck();
    console.log(`PostgreSQL ${health.engineVersion} | Redis alcanzable: ${redisHealth.reachable} (${redisHealth.latencyMs}ms)`);

    const catalogo = await repository.getPlanCatalog();
    check(Object.keys(catalogo).length >= 5, `El catalogo debe declarar al menos 5 planes (declarados: ${Object.keys(catalogo).length})`);
    check(catalogo.PLAN_50?.volumeDiscountEligible === true, 'El plan de 50 USD debe ser elegible para descuento por volumen');
    check(catalogo.PLAN_50?.volumeDiscountTiers.length === 4, 'El plan de 50 USD debe declarar sus 4 tramos de volumen');
    check(catalogo.PLAN_5?.includedMinutes === '25.000000', `El plan de 5 USD debe declarar 25 minutos incluidos (obtenido: ${String(catalogo.PLAN_5?.includedMinutes)})`);

    await prepareFixtureOrganization(ownerPool);
    console.log('Fixtures sembradas: 1 organizacion con acuerdo de datos firmado.');

    await verifyActivation(useCase, repository);
    console.log('[1/4] Activacion de suscripcion con otorgamiento de minutos: APROBADO.');

    await verifyIdempotency(useCase, repository, redisClient);
    console.log('[2/4] Doble idempotencia (marca en Redis e indice unico contable): APROBADO.');

    await verifyRenewalAndTopUp(useCase, repository);
    console.log('[3/4] Renovacion de cupo y acumulacion de saldo prepagado: APROBADO.');

    await verifyInvalidation(useCase, repository);
    console.log('[4/4] Invalidacion con congelamiento de minutos y saldo intacto: APROBADO.');

    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
  } finally {
    const removedKeys = await Promise.all(
      createdIdempotencyKeys.map((eventId) => redisClient.keys.remove(redisClient.keyNamespaces.webhookEventSeen(eventId)))
    );
    const cleanupReport = await cleanupFixtures(ownerPool);
    console.log(
      `Limpieza verificada: ${cleanupReport.organizations} organizaciones, ${cleanupReport.subscriptions} suscripciones y ` +
        `${cleanupReport.ledgerEntries} asientos historicos conservados (libro mayor append-only) | organizacion determinista reutilizable:  | marcas de idempotencia eliminadas: ${removedKeys.filter((count) => count > 0).length}.`
    );
    await redisClient.close();
    await ownerPool.end();
    await pool.close();
  }
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (error instanceof Error && error.stack !== undefined) {
    console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  }
  process.exit(1);
});







