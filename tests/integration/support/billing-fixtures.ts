/**
 * @archivo tests/integration/support/billing-fixtures.ts
 * @modulo 04-billing-and-whop (Fixtures y Utilidades Compartidas de las Pruebas de Cobro)
 * @proposito
 *   Reune el estado sintetico de suscripciones y overrides que consumen las pruebas del motor de
 *   tarificacion, junto con la siembra de la cadena de datos que exige la clave foranea del libro
 *   mayor —organizacion, proyecto, mapa funcional y sesion de voz— y el contador de aserciones.
 *   La siembra es idempotente y determinista porque `usage_ledger` es estrictamente append-only: sus
 *   asientos referencian estas filas y jamas pueden eliminarse, de modo que cada corrida debe
 *   REUTILIZAR las mismas entidades en lugar de crear nuevas.
 *
 * @resumen_contenido
 *   - Constantes deterministas `FIXTURE_ORG_ID`, `FIXTURE_PROJECT_ID`, `FIXTURE_MAP_ID` y
 *     `FIXTURE_VOICE_SESSION_ID`.
 *   - Funcion `check()`: Asercion con contador acumulado.
 *   - Funciones `buildSubscription()` y `buildOverride()`: Estados sinteticos del dominio.
 *   - Funcion `prepareBillingFixture()`: Siembra idempotente de la cadena completa.
 *   - Funcion `reportFinalFixtureState()`: Estado final para la bitacora de la prueba.
 *
 * @dependencias_internas
 *   - Tipos del dominio de cobros (`src/modules/04-billing-and-whop/domain/billing-whop.types.ts`).
 *   - `PostgresBillingRepository` para leer el estado final de la suscripcion.
 *
 * @dependencias_externas
 *   - `node:assert` y `pg` (Aserciones nativas y pool de propietario para la siembra).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `projects`, `functional_maps`, `voice_sessions` y
 *     `whop_subscriptions` (Todas sembradas o actualizadas de forma idempotente).
 */

import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  OrganizationPricingOverride,
  WhopSubscriptionState,
} from '../../../src/modules/04-billing-and-whop/domain/billing-whop.types';
import type { PostgresBillingRepository } from '../../../src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository';

/** Identificador de la organizacion determinista reutilizable entre corridas. */
export const FIXTURE_ORG_ID = '00000000-0000-4000-8000-00000000b111';

/** Identificador del proyecto determinista que referencia el consumo facturable. */
export const FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-00000000b222';

/** Identificador del mapa funcional determinista que exige la sesion de voz. */
export const FIXTURE_MAP_ID = '00000000-0000-4000-8000-00000000b333';

/** Identificador de la sesion de voz determinista a la que se imputan los asientos de consumo. */
export const FIXTURE_VOICE_SESSION_ID = '00000000-0000-4000-8000-00000000b444';

/** Cuota incluida con la que se siembra la suscripcion de prueba, en minutos. */
export const FIXTURE_INCLUDED_MINUTES = 2;

/** Tope de gasto duro con el que se siembra la suscripcion de prueba, en USD. */
export const FIXTURE_HARD_SPEND_CAP_USD = '1.000000';

/** Contador de verificaciones superadas durante la ejecucion de una prueba. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
export function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Devuelve el numero de aserciones superadas hasta el momento.
 *
 * @returns Total acumulado de aserciones superadas.
 */
export function countPassedAssertions(): number {
  return passedAssertions;
}

/**
 * Construye un estado de suscripcion sintetico para las pruebas del motor matematico.
 *
 * @param overrides - Campos que se desean sobrescribir respecto del estado base.
 * @returns Estado de suscripcion completo.
 */
export function buildSubscription(overrides: Partial<WhopSubscriptionState> = {}): WhopSubscriptionState {
  return {
    subscriptionId: randomUUID(),
    organizationId: randomUUID(),
    planCode: 'PLAN_30',
    status: 'ACTIVE',
    externalMembershipId: 'mem_prueba',
    currentPeriodStartIso: '2026-01-01T00:00:00.000Z',
    currentPeriodEndIso: '2026-02-01T00:00:00.000Z',
    periodIncludedMinutesQuota: '180.000000',
    periodIncludedMinutesRemaining: '180.000000',
    periodOverageMinutesUsed: '0.000000',
    currentPeriodOverageBilledUsd: '0.000000',
    creditBalanceUsd: '0.000000',
    hardSpendCapUsd: null,
    autoTopUpEnabled: false,
    lastExternalEventId: null,
    ...overrides,
  };
}

/**
 * Construye un override sintetico del operador de gobierno.
 *
 * @param overrides - Campos que se desean sobrescribir.
 * @returns Override completo.
 */
export function buildOverride(overrides: Partial<OrganizationPricingOverride> = {}): OrganizationPricingOverride {
  return {
    customRatePerMinuteUsd: null,
    manualDiscountPercentage: '0.000000',
    forceVolumeDiscountTiers: false,
    customVolumeTiers: null,
    overrideNotes: 'Override de prueba',
    effectiveFromIso: '2026-01-01T00:00:00.000Z',
    effectiveUntilIso: null,
    ...overrides,
  };
}

/**
 * Siembra de forma idempotente toda la cadena de datos que necesita la prueba de deduccion.
 *
 * Se siembra la organizacion, el proyecto, el mapa funcional y la sesion de voz porque cada asiento
 * de consumo referencia una sesion real; y se reinicia la suscripcion con `ON CONFLICT DO UPDATE`
 * en lugar de borrarla, porque el libro mayor la referencia mediante `ON DELETE SET NULL` y su
 * trigger de inmutabilidad bloquearia cualquier `UPDATE` propagado por la clave foranea.
 *
 * @param ownerPool - Pool con privilegios de propietario para la siembra.
 * @param includedMinutes - Cuota incluida con la que sembrar la suscripcion, en minutos.
 * @throws Error cuando la siembra falla, tras revertir la transaccion.
 */
export async function prepareBillingFixture(ownerPool: Pool, includedMinutes: number = FIXTURE_INCLUDED_MINUTES): Promise<void> {
  const quota = includedMinutes.toFixed(6);
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, name, slug, status, dpa_signed_at)
       VALUES ($1, 'Organizacion de prueba de cobros', 'prueba-cobros-determinista', 'ACTIVE', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
      [FIXTURE_ORG_ID]
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment)
       VALUES ($1, $2, 'Proyecto de prueba de consumo', 'consumo-prueba', 'LIVE')
       ON CONFLICT (organization_id, slug) DO UPDATE SET updated_at = NOW()`,
      [FIXTURE_PROJECT_ID, FIXTURE_ORG_ID]
    );
    await client.query(
      `INSERT INTO functional_maps (id, organization_id, project_id, version_number, version_label,
          canonical_map_json, content_sha256_hash, total_elements_count, is_active)
       VALUES ($1, $2, $3, 1, 'v-prueba', '{"version":1,"elements":[]}'::jsonb, $4, 0, TRUE)
       ON CONFLICT (project_id, version_number) DO UPDATE SET is_active = TRUE`,
      [FIXTURE_MAP_ID, FIXTURE_ORG_ID, FIXTURE_PROJECT_ID, 'a'.repeat(64)]
    );
    await client.query(
      `INSERT INTO voice_sessions (id, organization_id, project_id, functional_map_id, origin_domain,
          ai_model_used, status, client_ip_hash)
       VALUES ($1, $2, $3, $4, 'prueba.interno.local', 'GEMINI_3_8_LIVE', 'ACTIVE_STREAMING', $5)
       ON CONFLICT (id) DO NOTHING`,
      [FIXTURE_VOICE_SESSION_ID, FIXTURE_ORG_ID, FIXTURE_PROJECT_ID, FIXTURE_MAP_ID, 'b'.repeat(64)]
    );
    await client.query(
      `INSERT INTO whop_subscriptions (organization_id, plan_code, status,
          period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
          current_period_overage_billed_usd, credit_balance_usd, hard_spend_cap_usd)
       VALUES ($1, 'PLAN_50', 'ACTIVE', $2::numeric, $2::numeric, 0.000000, 0.000000, 0.000000, $3::numeric)
       ON CONFLICT (organization_id) DO UPDATE
         SET plan_code = 'PLAN_50', status = 'ACTIVE',
             period_included_minutes_quota = $2::numeric, period_included_minutes_remaining = $2::numeric,
             period_overage_minutes_used = 0.000000, current_period_overage_billed_usd = 0.000000,
             credit_balance_usd = 0.000000, hard_spend_cap_usd = $3::numeric, updated_at = NOW()`,
      [FIXTURE_ORG_ID, quota, FIXTURE_HARD_SPEND_CAP_USD]
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
 * Lee el estado final de la suscripcion de la fixture para la bitacora de la prueba.
 *
 * @param repository - Repositorio de facturacion.
 * @returns Descripcion legible del estado final.
 */
export async function reportFinalFixtureState(repository: PostgresBillingRepository): Promise<string> {
  const finalState = await repository.findSubscription(FIXTURE_ORG_ID);
  return (
    `plan=${String(finalState?.planCode)} minutos_restantes=${String(finalState?.periodIncludedMinutesRemaining)} ` +
    `exceso_acumulado=${String(finalState?.periodOverageMinutesUsed)} facturado=${String(finalState?.currentPeriodOverageBilledUsd)} USD.`
  );
}
