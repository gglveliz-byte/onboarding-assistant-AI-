/**
 * @archivo tests/unit/pricing-plan-identity-guard.test.ts
 * @modulo 06-superadmin-governance (Guarda de Identidad del Plan en la Pasarela)
 * @proposito
 *   Ejerce las tres reglas que evitan que el gobierno de precios vuelva a dejar la plataforma sin
 *   poder cobrar. El adaptador del puerto `ISuperAdminGovernancePort` inventaba el identificador de la
 *   pasarela (`whop_${planCode}`) y lo sobrescribia sobre el `plan_...` real; con un identificador
 *   falso el checkout contra la pasarela falla de forma garantida.
 *
 *   Reglas verificadas:
 *   1. Un identificador con forma ajena a la pasarela se RECHAZA y no se escribe.
 *   2. Gobernar precio o minutos SIN declarar identificador CONSERVA el vigente.
 *   3. Crear un plan nuevo exige aportar su identificador real.
 *
 *   Se usan dobles minimos en memoria: la logica gobernada es la del adaptador, no la de PostgreSQL.
 *
 * @resumen_contenido
 *   - Doble `FakeAdminRepository` y `FakeRlsPool`: sostienen la matriz en un `Map`.
 *   - Funcion `buildPortAdapter()`: ensambla el adaptador sobre los dobles.
 *   - Tres grupos de aserciones correspondientes a las tres reglas.
 *
 * @dependencias_internas
 *   - `SuperAdminGovernancePortAdapter` (manifiesto del modulo 06).
 *   - `UpdateGlobalPricingMatrixUseCase` (caso de uso de matriz global).
 *
 * @dependencias_externas
 *   - `node:assert`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (dobles en memoria).
 */

import assert from 'node:assert';
import type { GlobalPricingPlanEntity } from '../../src/modules/06-superadmin-governance/domain/governance.entities';
import { UpdateGlobalPricingMatrixUseCase } from '../../src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case';
import { SuperAdminGovernancePortAdapter } from '../../src/modules/06-superadmin-governance/superadmin-governance.manifest';

/** Identificador real de la pasarela usado por las fixtures. */
const REAL_PLAN_ID = 'plan_Sc4l3Pr0Test01';
/** Operario de gobierno de prueba. */
const SUPERADMIN_ID = '00000000-0000-4000-8000-00000000a111';

/** Matriz en memoria compartida por los dobles. */
const matrixStore = new Map<string, GlobalPricingPlanEntity>();

/** Doble del repositorio de administracion, reducido a lo que ejerce esta prueba. */
const fakeAdminRepository = {
  async getPricingPlan(_client: unknown, planCode: string): Promise<GlobalPricingPlanEntity | null> {
    return matrixStore.get(planCode) ?? null;
  },
  async upsertPricingPlan(_client: unknown, data: Record<string, unknown>): Promise<GlobalPricingPlanEntity> {
    const entity = data as unknown as GlobalPricingPlanEntity;
    matrixStore.set(String(entity.planCode), entity);
    return entity;
  },
} as never;

/** Doble del pool: ejecuta el trabajo sin abrir conexion real. */
const fakeRlsPool = {
  async runInSuperAdminTransaction<T>(_userId: string, work: (client: unknown) => Promise<T>): Promise<T> {
    return work({});
  },
} as never;

/** Doble del repositorio de auditoria: acepta todo y no registra. */
const fakeAuditRepository = {
  async appendImmutableAuditLog(): Promise<{ readonly ok: true; readonly entryId: string }> {
    return { ok: true as const, entryId: 'audit_fake_1' };
  },
} as never;

/**
 * Ensambla el adaptador del puerto sobre los dobles en memoria.
 *
 * @returns Adaptador listo para gobernar la matriz ficticia.
 */
function buildPortAdapter(): SuperAdminGovernancePortAdapter {
  const updatePricingUseCase = new UpdateGlobalPricingMatrixUseCase({
    rlsPool: fakeRlsPool,
    adminRepo: fakeAdminRepository,
    auditRepo: fakeAuditRepository,
    getKillSwitchState: () => false,
    setKillSwitchState: () => undefined,
  } as never);

  return new SuperAdminGovernancePortAdapter(
    { execute: async () => ({ ok: true, value: {} }) } as never,
    { execute: async () => ({ ok: true, value: {} }) } as never,
    { execute: async () => ({ ok: true, value: { id: 'override_1' } }) } as never,
    updatePricingUseCase,
    { execute: async () => ({ ok: true, value: {} }) } as never
  );
}

/** Parametros base de una operacion de gobierno de precio. */
function baseParams(overrides: Partial<Record<string, unknown>> = {}): never {
  return {
    superAdminUserId: SUPERADMIN_ID,
    planCode: 'SCALE_PRO',
    monthlyFixedPriceUsd: '199.00',
    includedMinutes: '1000',
    baseOverageRatePerMinuteUsd: '0.20',
    overageAllowed: true,
    volumeDiscountEligible: true,
    volumeDiscountTiersJson: [],
    ...overrides,
  } as never;
}

/** Contador de aserciones superadas. */
let passedAssertions = 0;

/** Aserta una condicion y contabiliza la verificacion. */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** Regla 1: un identificador inventado se rechaza y no toca la matriz. */
async function verifyRejectsFabricatedIdentity(): Promise<void> {
  const adapter = buildPortAdapter();

  const created = await adapter.updateGlobalPricingPlan(baseParams({ whopPlanId: REAL_PLAN_ID, displayName: 'Escala Pro' }));
  check(created.ok === true, 'Crear un plan con identificador real debe ser exitoso');
  check(matrixStore.get('SCALE_PRO')?.whopPlanId === REAL_PLAN_ID, 'La matriz debe conservar el identificador real');

  const rejected = await adapter.updateGlobalPricingPlan(baseParams({ whopPlanId: 'whop_scale_pro' }));
  check(rejected.ok === false, 'Un identificador con forma inventada debe rechazarse');
  check(
    matrixStore.get('SCALE_PRO')?.whopPlanId === REAL_PLAN_ID,
    'El rechazo no debe haber sobrescrito el identificador real de la pasarela'
  );
}

/** Regla 2: gobernar precio sin declarar identificador conserva el vigente. */
async function verifyPreservesExistingIdentity(): Promise<void> {
  const adapter = buildPortAdapter();

  const preserved = await adapter.updateGlobalPricingPlan(
    baseParams({ monthlyFixedPriceUsd: '249.00', includedMinutes: '1500' })
  );
  check(preserved.ok === true, 'Gobernar precio y minutos sin declarar identificador debe ser exitoso');
  check(
    matrixStore.get('SCALE_PRO')?.whopPlanId === REAL_PLAN_ID,
    'Actualizar la tarifa no debe romper nunca el vinculo con la pasarela'
  );
  check(
    matrixStore.get('SCALE_PRO')?.monthlyFixedPriceUsd === '249.00',
    'El nuevo precio debe haberse aplicado sobre la matriz'
  );
}

/** Regla 3: crear un plan exige aportar su identificador real. */
async function verifyRequiresIdentityForNewPlan(): Promise<void> {
  matrixStore.delete('SCALE_PRO');
  const adapter = buildPortAdapter();

  const refused = await adapter.updateGlobalPricingPlan(baseParams());
  check(refused.ok === false, 'Crear un plan sin identificador de pasarela debe rechazarse');
  check(!matrixStore.has('SCALE_PRO'), 'El plan no debe existir en la matriz tras el rechazo');
}

/** Ejecuta la bateria. */
async function main(): Promise<void> {
  console.log('GUARDA DE IDENTIDAD DEL PLAN EN LA PASARELA (modulo 06)');
  console.log('========================================================');
  await verifyRejectsFabricatedIdentity();
  await verifyPreservesExistingIdentity();
  await verifyRequiresIdentityForNewPlan();
  console.log(`\nRESULTADO: OK — ${passedAssertions} aserciones superadas.`);
}

main().catch((error) => {
  console.error('GUARDA DE IDENTIDAD FALLIDA:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
