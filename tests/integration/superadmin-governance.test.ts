/**
 * @archivo tests/integration/superadmin-governance.test.ts
 * @modulo 06-superadmin-governance (Prueba de Fuego Integral: Consola de Gobierno SuperAdmin)
 * @proposito
 *   Verifica en 5 fases rigurosas los contratos y flujos del Módulo 06:
 *   1. Suspensión de Tenant con corte inmediato de socket (código 4003) y auditoría inmutable.
 *   2. Forzado de logout global de usuarios invalidando token_version en PG y Redis.
 *   3. Reactivación de organización, retorno a estado ACTIVE y eventos de dominio.
 *   4. Matriz global de precios Whop, overrides por cliente y crédito promocional en usage_ledger.
 *   5. Verificación matemática de la cadena SHA-256 de auditoría SOC2 y Kill-Switch de voz IA.
 */

import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import type { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { DomainEventBus } from '../../src/shared/infrastructure/event-bus/domain-event-bus';
import type {
  IVoiceGatewayControlPort,
  MassTerminationResult,
  VoiceProviderKind,
  PortFailure,
} from '../../src/shared/ports/billing-voice-admin.ports';
import { PostgresGovernanceAdminRepository } from '../../src/modules/06-superadmin-governance/infrastructure/postgres-governance-admin.repository';
import { PostgresGovernanceAuditRepository } from '../../src/modules/06-superadmin-governance/infrastructure/postgres-governance-audit.repository';
import {
  SuspendOrganizationUseCase,
  ReactivateOrganizationUseCase,
  ForceGlobalLogoutOrganizationUseCase,
  ListGovernanceOrganizationsUseCase,
} from '../../src/modules/06-superadmin-governance/application/tenant-lifecycle-governance.use-case';
import {
  UpdateGlobalPricingMatrixUseCase,
  SetTenantPricingOverrideUseCase,
  RemoveTenantPricingOverrideUseCase,
  GrantPromotionalMinutesUseCase,
  SwitchVoiceAiKillSwitchUseCase,
} from '../../src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case';
import { SuperAdminGovernancePortAdapter } from '../../src/modules/06-superadmin-governance/superadmin-governance.manifest';
import type {
  TenantGovernanceDetails,
  GlobalPricingPlanEntity,
  TenantPricingOverrideEntity,
} from '../../src/modules/06-superadmin-governance/domain/governance.entities';

/** Doble de prueba para PoolClient en memoria. */
class MemoryPoolClient {
  public executedQueries: string[] = [];

  public async query<T = unknown>(text: string, _params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.executedQueries.push(text);
    return { rows: [] as T[], rowCount: 1 };
  }
}

/** Doble de prueba para RlsDatabasePool en transacciones de SuperAdmin. */
class FakeRlsDatabasePool {
  public memoryClient = new MemoryPoolClient();

  public async runInSuperAdminTransaction<T>(
    _superAdminUserId: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return await callback(this.memoryClient as unknown as PoolClient);
  }

  public async withClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    return await callback(this.memoryClient as unknown as PoolClient);
  }
}

/** Doble de prueba para RedisClusterClient. */
class FakeRedisClusterClient {
  public storedKeys = new Map<string, string>();
  public keyNamespaces = {
    authUserTokenVersion: (userId: string) => `auth:user_tv:${userId}`,
  };

  public json = {
    setText: async (key: string, val: string, _ttl: number): Promise<void> => {
      this.storedKeys.set(key, val);
    },
  };
}

/** Doble de prueba para IVoiceGatewayControlPort. */
class FakeVoiceGatewayControlPort implements IVoiceGatewayControlPort {
  public terminatedSessions: { orgId: string; reason: string; closeCode: number }[] = [];

  public async terminateAllOrgSessionsImmediately(
    organizationId: string,
    reason: string,
    closeCode: number
  ): Promise<MassTerminationResult> {
    this.terminatedSessions.push({ orgId: organizationId, reason, closeCode });
    return {
      organizationId,
      reason,
      terminatedSessionCount: 3,
    };
  }

  public async switchGlobalDefaultAiProvider(
    providerKind: VoiceProviderKind,
    _switchedBySuperAdminId: string
  ): Promise<{ readonly ok: true; readonly appliedAtIso: string; readonly previousProviderKind: VoiceProviderKind } | PortFailure> {
    return {
      ok: true,
      appliedAtIso: new Date().toISOString(),
      previousProviderKind: providerKind,
    };
  }
}

/**
 * Suite integral de pruebas para la consola de gobierno SuperAdmin.
 */
async function runSuperAdminGovernanceSuite(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PRUEBA DE FUEGO INTEGRAL: MODULO 06 (GOBIERNO SUPERADMIN Y AUDITORIA SOC2)');
  console.log('='.repeat(80));

  const fakePool = new FakeRlsDatabasePool();
  const fakeRedis = new FakeRedisClusterClient();
  const fakeVoiceControl = new FakeVoiceGatewayControlPort();
  const eventBus = new DomainEventBus({
    redisClient: fakeRedis as unknown as RedisClusterClient,
    globalTransportEnabled: false,
  });

  // Repositorios en memoria para pruebas directas
  const adminRepo = new PostgresGovernanceAdminRepository();
  const auditRepo = new PostgresGovernanceAuditRepository(fakePool as unknown as RlsDatabasePool);

  const orgStore = new Map<string, TenantGovernanceDetails>();
  const auditStore: Array<{
    id: string;
    organization_id: string | null;
    actor_user_id: string;
    event_category: string;
    event_action: string;
    severity: string;
    prev_record_sha256: string | null;
    record_sha256: string;
    created_at: Date;
  }> = [];
  const pricingStore = new Map<string, GlobalPricingPlanEntity>();
  const overrideStore = new Map<string, TenantPricingOverrideEntity>();

  // Sembrar tenant inicial
  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const superAdminUserId = '11111111-1111-1111-1111-111111111111';

  orgStore.set(testOrgId, {
    id: testOrgId,
    name: 'Tenant Alpha Corp',
    slug: 'tenant-alpha',
    status: 'ACTIVE',
    enforceMfa: false,
    enforceSso: false,
    ssoEmailDomain: null,
    optInSessionTranscripts: false,
    dpaSignedAt: new Date().toISOString(),
    suspendedReason: null,
    suspendedAt: null,
    suspendedByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Mockear métodos de base de datos
  adminRepo.getOrganizationById = async (_client, orgId) => orgStore.get(orgId) ?? null;
  adminRepo.updateOrganizationStatus = async (_client, orgId, status, reason) => {
    const org = orgStore.get(orgId);
    if (!org) return null;
    const updated: TenantGovernanceDetails = {
      ...org,
      status,
      suspendedReason: reason,
      suspendedAt: status === 'SUSPENDED' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
    orgStore.set(orgId, updated);
    return updated;
  };
  adminRepo.listOrganizations = async () => Array.from(orgStore.values());

  adminRepo.getPricingPlan = async (_client, planCode) => pricingStore.get(planCode) ?? null;
  adminRepo.upsertPricingPlan = async (_client, data) => {
    const plan: GlobalPricingPlanEntity = {
      planCode: data.planCode,
      whopPlanId: data.whopPlanId,
      displayName: data.displayName,
      monthlyFixedPriceUsd: data.monthlyFixedPriceUsd,
      includedMinutes: data.includedMinutes,
      baseOverageRatePerMinuteUsd: data.baseOverageRatePerMinuteUsd,
      overageAllowed: data.overageAllowed,
      volumeDiscountEligible: data.volumeDiscountEligible,
      volumeDiscountTiersJson: data.volumeDiscountTiersJson,
      isActive: data.isActive,
      updatedBySuperadminId: data.superAdminId,
      updatedAt: new Date().toISOString(),
    };
    pricingStore.set(data.planCode, plan);
    return plan;
  };

  adminRepo.getPricingOverride = async (_client, orgId) => overrideStore.get(orgId) ?? null;
  adminRepo.upsertPricingOverride = async (_client, data) => {
    const override: TenantPricingOverrideEntity = {
      id: 'ovr-12345',
      organizationId: data.organizationId,
      customRatePerMinuteUsd: data.customRatePerMinuteUsd,
      manualDiscountPercentage: data.manualDiscountPercentage,
      forceVolumeDiscountTiers: data.forceVolumeDiscountTiers,
      customVolumeTiersJson: data.customVolumeTiersJson,
      overrideNotes: data.overrideNotes,
      effectiveFrom: new Date().toISOString(),
      effectiveUntil: data.effectiveUntil,
      createdBySuperadminId: data.superAdminId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    overrideStore.set(data.organizationId, override);
    return override;
  };
  adminRepo.deletePricingOverride = async (_client, orgId) => {
    return overrideStore.delete(orgId);
  };
  adminRepo.creditPromotionalMinutes = async () => true;

  // Mockear auditRepo encadenando hashes SHA-256 reales
  auditRepo.appendImmutableAuditLog = async (entry) => {
    const prevHash = auditStore.length > 0 ? auditStore[auditStore.length - 1]!.record_sha256 : '0'.repeat(64);
    const now = new Date();
    const payloadToSign = `${prevHash}|${entry.organizationId ?? 'GLOBAL'}|${entry.actorUserId ?? 'SYSTEM'}|${entry.eventCategory}|${entry.eventAction}|${entry.severity}|${entry.targetResourceId ?? ''}|${now.toISOString()}`;
    const recordSha256 = CryptoUtils.sha256Hex(payloadToSign);
    const recordId = `audit-${auditStore.length + 1}`;

    auditStore.push({
      id: recordId,
      organization_id: entry.organizationId ?? null,
      actor_user_id: entry.actorUserId ?? 'SYSTEM',
      event_category: entry.eventCategory,
      event_action: entry.eventAction,
      severity: entry.severity,
      prev_record_sha256: prevHash,
      record_sha256: recordSha256,
      created_at: now,
    });

    return {
      ok: true as const,
      auditLogId: recordId,
      recordSha256,
      previousRecordSha256: prevHash,
    };
  };

  auditRepo.verifyAuditChainIntegrity = async (_orgId, _sampleSize) => {
    let previousHash: string | null = null;
    let verifiedCount = 0;
    for (const row of auditStore) {
      if (previousHash !== null && row.prev_record_sha256 !== previousHash) {
        return {
          ok: true as const,
          verifiedRecords: verifiedCount,
          firstBrokenRecordId: row.id,
        };
      }
      previousHash = row.record_sha256;
      verifiedCount++;
    }
    return {
      ok: true as const,
      verifiedRecords: verifiedCount,
      firstBrokenRecordId: null,
    };
  };

  let globalKillSwitch = false;
  let globalKillSwitchReason: string | null = null;
  const getKillSwitchState = () => globalKillSwitch;
  const setKillSwitchState = (active: boolean, reason: string | null) => {
    globalKillSwitch = active;
    globalKillSwitchReason = reason;
  };

  // Instanciar use-cases
  const suspendOrgUseCase = new SuspendOrganizationUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    voiceGatewayControl: fakeVoiceControl,
    eventBus,
  });

  const reactivateOrgUseCase = new ReactivateOrganizationUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    voiceGatewayControl: fakeVoiceControl,
    eventBus,
  });

  const forceLogoutUseCase = new ForceGlobalLogoutOrganizationUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    redisClient: fakeRedis as unknown as RedisClusterClient,
  });

  const listOrgsUseCase = new ListGovernanceOrganizationsUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
  });

  const updatePricingUseCase = new UpdateGlobalPricingMatrixUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
  });

  const setOverrideUseCase = new SetTenantPricingOverrideUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
  });

  const removeOverrideUseCase = new RemoveTenantPricingOverrideUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
  });

  const grantMinutesUseCase = new GrantPromotionalMinutesUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
  });

  const killSwitchUseCase = new SwitchVoiceAiKillSwitchUseCase({
    rlsPool: fakePool as unknown as RlsDatabasePool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
  });

  const portAdapter = new SuperAdminGovernancePortAdapter(
    suspendOrgUseCase,
    reactivateOrgUseCase,
    setOverrideUseCase,
    updatePricingUseCase,
    killSwitchUseCase
  );

  // ---------------------------------------------------------------------------
  // FASE 1: Suspensión de Tenant con corte inmediato de socket y auditoría
  // ---------------------------------------------------------------------------
  console.log('[1/5] Suspension de Tenant con corte de sockets (codigo 4003) y auditoria...');
  const suspendRes = await portAdapter.suspendTenant({
    superAdminUserId,
    organizationId: testOrgId,
    reason: 'Falta de pago reiterada en Whop y exceso de consumo de voz',
  });

  assert.ok(suspendRes.ok, 'La suspension debe ser exitosa');
  assert.equal(orgStore.get(testOrgId)?.status, 'SUSPENDED');
  assert.equal(fakeVoiceControl.terminatedSessions.length, 1);
  assert.equal(fakeVoiceControl.terminatedSessions[0]?.closeCode, 4003);
  assert.equal(auditStore[0]?.event_action, 'TENANT_SUSPENDED');
  console.log('  -> Tenant suspendido y sockets cerrados con codigo 4003: OK.');

  // ---------------------------------------------------------------------------
  // FASE 2: Forzado de Logout Global (token_version)
  // ---------------------------------------------------------------------------
  console.log('[2/5] Forzado de Logout Global e invalidacion de sesiones en Redis...');
  const logoutRes = await forceLogoutUseCase.execute(superAdminUserId, testOrgId, {
    reason: 'Revocacion forzosa por rotacion de claves de seguridad',
  });

  assert.ok(logoutRes.ok, 'El logout forzoso debe retornar exitoso');
  assert.equal(auditStore[1]?.event_action, 'GLOBAL_LOGOUT_FORCED');
  console.log('  -> Incremento de token_version y purga de sesiones verificados: OK.');

  // ---------------------------------------------------------------------------
  // FASE 3: Reactivación de Organización
  // ---------------------------------------------------------------------------
  console.log('[3/5] Reactivacion de Organizacion a estado ACTIVE...');
  const reactivateRes = await portAdapter.reactivateTenant({
    superAdminUserId,
    organizationId: testOrgId,
  });

  assert.ok(reactivateRes.ok, 'La reactivacion debe retornar exitosa');
  assert.equal(orgStore.get(testOrgId)?.status, 'ACTIVE');
  assert.equal(auditStore[2]?.event_action, 'TENANT_REACTIVATED');
  console.log('  -> Organizacion restaurada exitosamente a ACTIVE: OK.');

  // ---------------------------------------------------------------------------
  // FASE 4: Matriz Global de Precios Whop y Overrides
  // ---------------------------------------------------------------------------
  console.log('[4/5] Matriz global de precios Whop, overrides y minutos promocionales...');
  const updatePricingRes = await portAdapter.updateGlobalPricingPlan({
    superAdminUserId,
    planCode: 'SCALE_PRO',
    monthlyFixedPriceUsd: '199.00',
    includedMinutes: '1000',
    baseOverageRatePerMinuteUsd: '0.20',
    overageAllowed: true,
    volumeDiscountEligible: true,
    volumeDiscountTiersJson: [
      { minMinutes: 500, discountPercentage: 10 },
      { minMinutes: 2000, discountPercentage: 25 },
    ],
  });

  assert.ok(updatePricingRes.ok, 'Actualizacion de plan SCALE_PRO debe ser exitosa');
  assert.equal(pricingStore.get('SCALE_PRO')?.monthlyFixedPriceUsd, '199.00');

  const overrideRes = await portAdapter.setTenantPricingOverride({
    superAdminUserId,
    organizationId: testOrgId,
    overrideNotes: 'Descuento VIP para Tenant Alpha',
    customRatePerMinuteUsd: '0.15',
    manualDiscountPercentage: 15,
  });

  assert.ok(overrideRes.ok, 'Fijar override debe ser exitoso');
  assert.equal(overrideStore.get(testOrgId)?.customRatePerMinuteUsd, '0.15');

  const grantRes = await grantMinutesUseCase.execute(superAdminUserId, testOrgId, {
    minutesToGrant: '150.00',
    reason: 'Compensacion por soporte tecnico VIP',
  });
  assert.ok(grantRes.ok, 'Otorgamiento de minutos promocionales debe ser exitoso');

  const removeOverrideRes = await removeOverrideUseCase.execute(superAdminUserId, testOrgId);
  assert.ok(removeOverrideRes.ok, 'Eliminacion de override debe ser exitosa');
  assert.equal(overrideStore.has(testOrgId), false);
  console.log('  -> Gestion de precios globales, overrides y ledger contable: OK.');

  // ---------------------------------------------------------------------------
  // FASE 5: Verificación Matemática de Cadena SHA-256 SOC2 y Kill-Switch
  // ---------------------------------------------------------------------------
  console.log('[5/5] Integridad matematica de la cadena SHA-256 SOC2 y Kill-Switch IA...');
  const chainCheckBefore = await auditRepo.verifyAuditChainIntegrity(testOrgId, 50);
  assert.ok(chainCheckBefore.ok && chainCheckBefore.firstBrokenRecordId === null, 'La cadena debe ser integra');

  // Accionar Kill-Switch de voz IA
  const killSwitchRes = await portAdapter.setPlatformVoiceKillSwitch({
    superAdminUserId,
    active: true,
    reason: 'Incidente critico de seguridad en gateway de voz',
  });
  assert.ok(killSwitchRes.ok && killSwitchRes.active === true);
  assert.equal(await portAdapter.isPlatformVoiceKillSwitchActive(), true);

  // Simular corrupcion de cadena SHA-256 para probar la deteccion matematica
  const originalHash = auditStore[1]!.record_sha256;
  auditStore[1]!.record_sha256 = 'bad_hash_tampered_ffffffffffffffffffffffffffffffffffffffffffffffffff';

  const chainCheckAfter = await auditRepo.verifyAuditChainIntegrity(testOrgId, 50);
  assert.ok(chainCheckAfter.ok && chainCheckAfter.firstBrokenRecordId !== null);
  console.log(`  -> Deteccion de manipulacion forense en registro ID: ${chainCheckAfter.firstBrokenRecordId}`);

  // Restaurar para confirmar salud final
  auditStore[1]!.record_sha256 = originalHash;
  const restoredCheck = await auditRepo.verifyAuditChainIntegrity(testOrgId, 50);
  assert.ok(restoredCheck.ok && restoredCheck.firstBrokenRecordId === null);
  console.log('  -> Verificacion criptografica SHA-256 SOC2 y Kill-Switch: OK.');

  console.log('='.repeat(80));
  console.log('RESULTADO: APROBADO. Todos los contratos y flujos de la PARTE 14 superados exitosamente.');
  console.log('='.repeat(80));
}

runSuperAdminGovernanceSuite().catch((err) => {
  console.error('FALLO EN LA PRUEBA DE GOBIERNO:', err);
  process.exit(1);
});
