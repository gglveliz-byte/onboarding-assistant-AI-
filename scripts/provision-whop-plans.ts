/**
 * @archivo scripts/provision-whop-plans.ts
 * @modulo 04-billing-and-whop (Aprovisionamiento de Planes Reales en la Pasarela)
 * @proposito
 *   Crea (o reutiliza) en la pasarela los planes de suscripcion que el catalogo interno describe, y
 *   escribe sus identificadores reales `plan_...` de vuelta en `pricing_plans_config`. Sin este paso la
 *   plataforma no tiene nada que vender: la cuenta solo contenia un plan gratuito de pago unico, y el
 *   catalogo guardaba marcadores de desarro (`whop_plan_starter_5usd`) que la pasarela no reconoce, con
 *   lo que todo checkout fallaba antes de cobrar.
 *
 *   El precio que se registra en la pasarela es el BRUTO: el neto objetivo de la empresa mas la
 *   comision que la pasarela descuenta, redondeado hacia arriba al centavo. Asi el importe que liquida
 *   en el panel es exactamente el precio de lista del plan, que es el requisito de negocio.
 *
 *   Es IDEMPOTENTE: empareja por `metadata.internal_plan_code`, reutiliza el plan coincidente y solo
 *   actualiza el precio cuando cambia. Puede ejecutarse tantas veces como haga falta sin multiplicar
 *   el catalogo de la tienda.
 *
 * @resumen_contenido
 *   - Funcion `loadPricingMatrix()`: Lectura del catalogo interno con privilegio de gobierno.
 *   - Funcion `listGatewayPlans()`: Inventario actual de la pasarela.
 *   - Funcion `provisionPlan()`: Alta o actualizacion de un plan del catalogo.
 *   - Funcion `persistPlanMapping()`: Escritura del identificador real y su precio bruto.
 *   - Funcion `main()`: Orquestacion con Resumen final por consola.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) y `DecimalMath` (`src/shared/kernel/decimal.util.ts`).
 *   - `computeGrossPriceUsd()` (`src/modules/04-billing-and-whop/domain/whop-fee.util.ts`).
 *
 * @dependencias_externas
 *   - `@whop/sdk` (`WhopClient`) y `pg` (Pool de propietario para la escritura del catalogo).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config` (SELECT y UPDATE del catalogo, con `app.is_superadmin`).
 *
 * @uso
 *   npx tsx scripts/provision-whop-plans.ts            # aplica los cambios
 *   npx tsx scripts/provision-whop-plans.ts --dry-run  # solo informa, no escribe
 */

import { WhopClient } from '@whop/sdk';
import { Client } from 'pg';
import { getEnvConfig } from '../src/config/env.schema';
import { DecimalMath, type Fixed6String } from '../src/shared/kernel/decimal.util';
import { computeGrossPriceUsd, type PlatformFeeConfig } from '../src/modules/04-billing-and-whop/domain/whop-fee.util';
import { resolveWhopEnvironment } from '../src/modules/04-billing-and-whop/infrastructure/whop-sdk-client';

/** Plan del catalogo interno, leido de `pricing_plans_config`. */
interface CatalogPlan {
  readonly planCode: string;
  readonly whopPlanId: string;
  readonly displayName: string;
  readonly monthlyFixedPriceUsd: Fixed6String;
  readonly recurringPeriodDays: number | null;
  readonly isActive: boolean;
}

/** Plan existente en la pasarela, reducido a lo que interesa para emparejar. */
interface GatewayPlan {
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly initialPrice: number | null;
}

/** Indicador de ejecucion sin efectos laterales. */
const dryRun = process.argv.includes('--dry-run');

/** Lee el catalogo interno con privilegio de gobierno. */
async function loadPricingMatrix(client: Client): Promise<readonly CatalogPlan[]> {
  await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
  const result = await client.query<{
    plan_code: string;
    whop_plan_id: string;
    display_name: string;
    monthly_fixed_price_usd: string;
    whop_recurring_period_days: string | null;
    is_active: boolean;
  }>(
    `SELECT plan_code, whop_plan_id, display_name, monthly_fixed_price_usd,
            whop_recurring_period_days, is_active
     FROM pricing_plans_config
     ORDER BY monthly_fixed_price_usd, plan_code`
  );

  return result.rows.map((row) => ({
    planCode: row.plan_code,
    whopPlanId: row.whop_plan_id,
    displayName: row.display_name,
    monthlyFixedPriceUsd: row.monthly_fixed_price_usd,
    recurringPeriodDays: row.whop_recurring_period_days === null ? null : Number(row.whop_recurring_period_days),
    isActive: row.is_active,
  }));
}

/** Inventario actual de planes de la cuenta en la pasarela. */
async function listGatewayPlans(whop: WhopClient, accountId: string): Promise<readonly GatewayPlan[]> {
  const page = await whop.plans.list({ account_id: accountId, first: 100 });
  return (page as unknown as { data?: unknown[] }).data?.map((item) => {
    const plan = item as Record<string, unknown>;
    return {
      id: String(plan['id'] ?? ''),
      metadata: (plan['metadata'] ?? {}) as Record<string, unknown>,
      initialPrice: typeof plan['initial_price'] === 'number' ? plan['initial_price'] : null,
    };
  }) ?? [];
}

/**
 * Crea o actualiza un plan del catalogo en la pasarela.
 *
 * @param whop - Cliente autenticado de la empresa.
 * @param plan - Fila del catalogo interno.
 * @param grossPrice - Importe bruto que pagara el cliente.
 * @param existing - Plan ya existente que empareja por codigo interno, si lo hay.
 * @returns Identificador `plan_...` del plan vigente en la pasarela.
 */
async function provisionPlan(
  whop: WhopClient,
  plan: CatalogPlan,
  grossPrice: number,
  existing: GatewayPlan | undefined
): Promise<string> {
  const isRecurring = plan.recurringPeriodDays !== null && plan.recurringPeriodDays > 0;
  const productId = getEnvConfig().WHOP_PRODUCT_ID;

  // La pasarela limita el titulo del plan a 30 caracteres y es lo que lee el cliente en el checkout,
  // asi que debe mostrar el importe BRUTO real, no el nombre comercial largo del catalogo interno.
  const compactTitle = (
    grossPrice > 0 ? `Plan $${grossPrice.toFixed(2)}${isRecurring ? '/mes' : ''}` : plan.displayName
  ).slice(0, 30);

  const attributes = {
    account_id: getEnvConfig().WHOP_COMPANY_ID,
    ...(productId === undefined ? {} : { product_id: productId }),
    title: compactTitle,
    description: plan.displayName.slice(0, 500),
    plan_type: isRecurring ? 'renewal' : 'one_time',
    currency: 'usd',
    initial_price: grossPrice,
    renewal_price: grossPrice,
    ...(isRecurring ? { billing_period: plan.recurringPeriodDays ?? 30 } : {}),
    visibility: plan.monthlyFixedPriceUsd === '0.00' || plan.planCode === 'CUSTOM_ENTERPRISE' ? 'hidden' : 'visible',
    unlimited_stock: true,
    internal_notes: `oa:${plan.planCode}`,
    metadata: { internal_plan_code: plan.planCode },
  };

  if (dryRun) {
    console.log(`  [DRY-RUN] ${plan.planCode} -> ${existing ? 'ACTUALIZARIA' : 'CREARIA'} precio bruto $${grossPrice.toFixed(2)}`);
    return existing?.id ?? '(pendiente-en-dry-run)';
  }

  if (existing !== undefined) {
    if (existing.initialPrice === grossPrice) {
      console.log(`  ${plan.planCode} -> ${existing.id} ya coincide ($${grossPrice.toFixed(2)}), sin cambios`);
      return existing.id;
    }
    await whop.plans.update({ id: existing.id, ...attributes });
    console.log(`  ${plan.planCode} -> ${existing.id} PRECIO ACTUALIZADO a $${grossPrice.toFixed(2)}`);
    return existing.id;
  }

  const created = (await whop.plans.create(attributes)) as unknown as Record<string, unknown>;
  const createdId = typeof created['id'] === 'string' ? created['id'] : '';
  if (createdId.length === 0) {
    throw new Error(`La pasarela no devolvio identificador al crear el plan ${plan.planCode}.`);
  }
  console.log(`  ${plan.planCode} -> CREADO ${createdId} ($${grossPrice.toFixed(2)})`);
  return createdId;
}

/** Escribe el mapeo real y el precio bruto en el catalogo interno. */
async function persistPlanMapping(client: Client, planCode: string, whopPlanId: string, grossPrice: number): Promise<void> {
  if (dryRun || !/^plan_[A-Za-z0-9]+$/u.test(whopPlanId)) {
    return;
  }
  await client.query(
    `UPDATE pricing_plans_config
     SET whop_plan_id = $2,
         whop_gross_price_usd = $3::numeric,
         whop_plan_is_live = TRUE,
         updated_at = NOW()
     WHERE plan_code = $1`,
    [planCode, whopPlanId, grossPrice.toFixed(2)]
  );
}

/** Orquesta el aprovisionamiento completo del catalogo. */
async function main(): Promise<void> {
  const environment = getEnvConfig();
  const fee: PlatformFeeConfig = {
    percent: DecimalMath.fromNumber(environment.WHOP_PLATFORM_FEE_PERCENT, 'comision porcentual'),
    fixedUsd: DecimalMath.fromNumber(environment.WHOP_PLATFORM_FEE_FIXED_USD, 'comision fija'),
  };

  console.log('=================================================================');
  console.log('APROVISIONAMIENTO DE PLANES REALES EN LA PASARELA');
  console.log(`Cuenta: ${environment.WHOP_COMPANY_ID} | Comision: ${(environment.WHOP_PLATFORM_FEE_PERCENT * 100).toFixed(2)}% + $${environment.WHOP_PLATFORM_FEE_FIXED_USD.toFixed(2)}`);
  console.log(`Modo: ${dryRun ? 'SOLO LECTURA (--dry-run)' : 'APLICANDO CAMBIOS'}`);
  console.log('=================================================================');

  const client = new Client({ connectionString: environment.DATABASE_OWNER_URL ?? environment.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const matrix = await loadPricingMatrix(client);
    const whop = new WhopClient({ token: environment.WHOP_COMPANY_API_KEY, environment: resolveWhopEnvironment() });
    const gatewayPlans = await listGatewayPlans(whop, environment.WHOP_COMPANY_ID);

    console.log(`\nPlanes existentes en la pasarela: ${gatewayPlans.length}`);
    console.log('Provisionando catalogo:');

    for (const plan of matrix) {
      if (!plan.isActive) {
        console.log(`  ${plan.planCode} -> inactivo, se omite`);
        continue;
      }
      // Un plan sin cuota fija (pago por uso y corporativo) no tiene cargo recurrente que recargar:
      // su bruto es 0. Aplicarle la comision invertida produciria un cargo fantasma de $0.32.
      const isFreePlan = DecimalMath.compareFixed6(plan.monthlyFixedPriceUsd, '0.000000') === 0;
      const gross = isFreePlan ? '0.000000' : computeGrossPriceUsd(plan.monthlyFixedPriceUsd, fee);
      const grossNumber = Number(gross);
      const existing = gatewayPlans.find((candidate) => candidate.metadata['internal_plan_code'] === plan.planCode);
      const appliedId = await provisionPlan(whop, plan, grossNumber, existing);
      await persistPlanMapping(client, plan.planCode, appliedId, grossNumber);
    }

    const check = await client.query(
      `SELECT plan_code, whop_plan_id, monthly_fixed_price_usd, whop_gross_price_usd, whop_plan_is_live
       FROM pricing_plans_config ORDER BY monthly_fixed_price_usd`
    );
    console.log('\n=================================================================');
    console.log('ESTADO FINAL DEL CATALOGO');
    console.log('=================================================================');
    for (const row of check.rows) {
      console.log(
        `  ${String(row.plan_code).padEnd(18)} neto=$${String(row.monthly_fixed_price_usd).padEnd(7)} bruto=${String(row.whop_gross_price_usd ?? 'SIN ASIGNAR').padEnd(9)} vivo=${row.whop_plan_is_live}  id=${row.whop_plan_id}`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('APROVISIONAMIENTO FALLIDO:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
