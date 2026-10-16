/**
 * @archivo src/modules/06-superadmin-governance/superadmin-governance.manifest.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Manifiesto central del Módulo 06. Implementa el adaptador del puerto oficial
 *   `ISuperAdminGovernancePort`, monta la inyección de dependencias en el DI Container
 *   (`DI_TOKENS.SuperAdminGovernancePort`, `DI_TOKENS.AuditLoggerPort`) y delega el
 *   registro de endpoints REST `/api/v1/superadmin/*` protegidos con rol SuperAdmin.
 *
 * @resumen_contenido
 *   - Clase `SuperAdminGovernancePortAdapter`: Implementa `ISuperAdminGovernancePort`.
 *   - Función `registerSuperAdminGovernanceModule()`: Cableado automático en `DependencyContainer`.
 *   - Conexión con `registerGovernanceHttpRoutes` para el enrutamiento REST.
 *
 * @dependencias_internas
 *   - `DependencyContainer`, `DependencyToken`, `DI_TOKENS` (@shared/container/di-container.ts).
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `HttpRouterRegistry` (@shared/infrastructure/http/http-server.types.ts).
 *   - `ISuperAdminGovernancePort`, `IAuditLoggerPort`, `PortFailure` (@shared/ports/billing-voice-admin.ports.ts).
 *   - `PostgresGovernanceAdminRepository`, `PostgresGovernanceAuditRepository`.
 *   - Casos de uso de gobierno (@modules/06-superadmin-governance/application/*).
 *   - `registerGovernanceHttpRoutes` (./infrastructure/governance-http.routes.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `pricing_plans_config`, `organization_pricing_overrides`,
 *     `audit_logs`, `whop_subscriptions`, `usage_ledger`.
 */

import type { DependencyContainer, DependencyToken } from '../../shared/container/di-container';
import { DI_TOKENS } from '../../shared/container/di-container';
import type { RlsDatabasePool } from '../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../shared/infrastructure/redis/redis-cluster.client';
import type { DomainEventBus } from '../../shared/infrastructure/event-bus/domain-event-bus';
import type { HttpRouterRegistry } from '../../shared/infrastructure/http/http-server.types';
import type {
  ISuperAdminGovernancePort,
  IAuditLoggerPort,
  IVoiceGatewayControlPort,
  SuspendTenantParams,
  ReactivateTenantParams,
  SetTenantPricingOverrideParams,
  UpdateGlobalPricingPlanParams,
  PortFailure,
} from '../../shared/ports/billing-voice-admin.ports';
import { PostgresGovernanceAdminRepository } from './infrastructure/postgres-governance-admin.repository';
import { PostgresGovernanceAuditRepository } from './infrastructure/postgres-governance-audit.repository';
import {
  SuspendOrganizationUseCase,
  ReactivateOrganizationUseCase,
  ForceGlobalLogoutOrganizationUseCase,
  ListGovernanceOrganizationsUseCase,
} from './application/tenant-lifecycle-governance.use-case';
import {
  UpdateGlobalPricingMatrixUseCase,
  SetTenantPricingOverrideUseCase,
  RemoveTenantPricingOverrideUseCase,
  GrantPromotionalMinutesUseCase,
  SwitchVoiceAiKillSwitchUseCase,
} from './application/pricing-matrix-and-overrides.use-case';
import { registerGovernanceHttpRoutes } from './infrastructure/governance-http.routes';

/**
 * Adaptador que implementa el contrato oficial `ISuperAdminGovernancePort`.
 */
export class SuperAdminGovernancePortAdapter implements ISuperAdminGovernancePort {
  private killSwitchActive = false;
  private killSwitchReason: string | null = null;

  public constructor(
    private readonly suspendUseCase: SuspendOrganizationUseCase,
    private readonly reactivateUseCase: ReactivateOrganizationUseCase,
    private readonly setOverrideUseCase: SetTenantPricingOverrideUseCase,
    private readonly updatePricingUseCase: UpdateGlobalPricingMatrixUseCase,
    private readonly killSwitchUseCase: SwitchVoiceAiKillSwitchUseCase,
    private readonly getKillSwitchStateFn?: () => Promise<boolean> | boolean,
    private readonly redisClient?: RedisClusterClient
  ) {}

  public async suspendTenant(
    params: SuspendTenantParams
  ): Promise<{ readonly ok: true; readonly suspendedAtIso: string } | PortFailure> {
    const res = await this.suspendUseCase.execute(params.superAdminUserId, params.organizationId, {
      reason: params.reason,
      immediateSocketClose: true,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.error.code === 'NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : 'PERSISTENCE_UNAVAILABLE',
        reason: res.error.message,
        retryable: false,
      };
    }
    return { ok: true, suspendedAtIso: res.value.suspendedAt ?? new Date().toISOString() };
  }

  public async reactivateTenant(
    params: ReactivateTenantParams
  ): Promise<{ readonly ok: true; readonly reactivatedAtIso: string } | PortFailure> {
    const res = await this.reactivateUseCase.execute(params.superAdminUserId, params.organizationId, {
      reactivationNotes: 'Reactivado via puerto ISuperAdminGovernancePort',
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.error.code === 'NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : 'PERSISTENCE_UNAVAILABLE',
        reason: res.error.message,
        retryable: false,
      };
    }
    return { ok: true, reactivatedAtIso: res.value.updatedAt };
  }

  public async setTenantPricingOverride(
    params: SetTenantPricingOverrideParams
  ): Promise<{ readonly ok: true; readonly overrideId: string } | PortFailure> {
    const res = await this.setOverrideUseCase.execute(params.superAdminUserId, params.organizationId, {
      overrideNotes: params.overrideNotes,
      customRatePerMinuteUsd: params.customRatePerMinuteUsd,
      manualDiscountPercentage: params.manualDiscountPercentage ?? 0,
      forceVolumeDiscountTiers: params.forceVolumeDiscountTiers ?? false,
      customVolumeTiersJson: params.customVolumeTiersJson ? [...params.customVolumeTiersJson] as Record<string, unknown>[] : undefined,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.error.code === 'NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : 'PERSISTENCE_UNAVAILABLE',
        reason: res.error.message,
        retryable: false,
      };
    }
    return { ok: true, overrideId: res.value.id };
  }

  public async updateGlobalPricingPlan(
    params: UpdateGlobalPricingPlanParams
  ): Promise<{ readonly ok: true; readonly updatedPlanCode: string } | PortFailure> {
    const res = await this.updatePricingUseCase.execute(params.superAdminUserId, params.planCode, {
      whopPlanId: `whop_${params.planCode.toLowerCase()}`,
      displayName: params.planCode,
      monthlyFixedPriceUsd: params.monthlyFixedPriceUsd,
      includedMinutes: params.includedMinutes,
      baseOverageRatePerMinuteUsd: params.baseOverageRatePerMinuteUsd,
      overageAllowed: params.overageAllowed,
      volumeDiscountEligible: params.volumeDiscountEligible,
      volumeDiscountTiersJson: [...params.volumeDiscountTiersJson] as Record<string, unknown>[],
      isActive: true,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: res.error.message,
        retryable: false,
      };
    }
    return { ok: true, updatedPlanCode: res.value.planCode };
  }

  public async isPlatformVoiceKillSwitchActive(): Promise<boolean> {
    if (this.redisClient) {
      try {
        const val = await this.redisClient.json.getJson<{ active?: boolean }>('oa:governance:voice_kill_switch');
        if (val && typeof val.active === 'boolean') {
          return val.active;
        }
      } catch {
        // Fallback a comprobación en memoria
      }
    }
    if (this.getKillSwitchStateFn) {
      return await this.getKillSwitchStateFn();
    }
    return this.killSwitchActive;
  }

  public async setPlatformVoiceKillSwitch(params: {
    readonly active: boolean;
    readonly reason: string;
    readonly superAdminUserId: string;
  }): Promise<{ readonly ok: true; readonly active: boolean } | PortFailure> {
    const res = await this.killSwitchUseCase.execute(params.superAdminUserId, {
      active: params.active,
      reason: params.reason,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: res.error.message,
        retryable: false,
      };
    }
    this.killSwitchActive = res.value.killSwitchActive;
    this.killSwitchReason = res.value.reason;
    return { ok: true, active: res.value.killSwitchActive };
  }
}

/**
 * Registra el Módulo 06 en el DependencyContainer y monta los endpoints REST.
 */
export function registerSuperAdminGovernanceModule(
  container: DependencyContainer,
  router: HttpRouterRegistry
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.tryGet(DI_TOKENS.RedisClusterClient) as RedisClusterClient | undefined;
  const eventBus = container.tryGet(DI_TOKENS.DomainEventBus) as DomainEventBus | undefined;
  const voiceGatewayControl = container.tryGet(DI_TOKENS.VoiceGatewayControlPort) as IVoiceGatewayControlPort | undefined;

  const adminRepo = new PostgresGovernanceAdminRepository();
  const auditRepo = new PostgresGovernanceAuditRepository(rlsPool);

  let globalKillSwitch = false;
  let globalKillSwitchReason: string | null = null;

  const getKillSwitchState = (): boolean => globalKillSwitch;
  const getKillSwitchReason = (): string | null => globalKillSwitchReason;
  const setKillSwitchState = async (active: boolean, reason: string | null, superAdminUserId: string): Promise<void> => {
    globalKillSwitch = active;
    globalKillSwitchReason = reason;
    if (redisClient) {
      try {
        const payload = { active, reason, superAdminUserId, updatedAt: new Date().toISOString() };
        await redisClient.json.setJson('oa:governance:voice_kill_switch', payload);
        await redisClient.publish(
          redisClient.channels.governanceCommands,
          JSON.stringify({ type: 'VOICE_KILL_SWITCH_UPDATED', active, reason, superAdminUserId })
        );
      } catch {
        // Fallback no bloqueante si Redis falla
      }
    }
  };

  const suspendOrgUseCase = new SuspendOrganizationUseCase({
    rlsPool,
    adminRepo,
    auditRepo,
    redisClient,
    eventBus,
    voiceGatewayControl,
  });

  const reactivateOrgUseCase = new ReactivateOrganizationUseCase({
    rlsPool,
    adminRepo,
    auditRepo,
    redisClient,
    eventBus,
    voiceGatewayControl,
  });

  const forceLogoutUseCase = new ForceGlobalLogoutOrganizationUseCase({
    rlsPool,
    adminRepo,
    auditRepo,
    redisClient,
    eventBus,
  });

  const listOrgsUseCase = new ListGovernanceOrganizationsUseCase({
    rlsPool,
    adminRepo,
    auditRepo,
  });

  const pricingDeps = {
    rlsPool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
    redisClient,
    eventBus,
  };

  const updatePricingUseCase = new UpdateGlobalPricingMatrixUseCase(pricingDeps);
  const setOverrideUseCase = new SetTenantPricingOverrideUseCase(pricingDeps);
  const removeOverrideUseCase = new RemoveTenantPricingOverrideUseCase(pricingDeps);
  const grantMinutesUseCase = new GrantPromotionalMinutesUseCase(pricingDeps);
  const killSwitchUseCase = new SwitchVoiceAiKillSwitchUseCase(pricingDeps);

  const portAdapter = new SuperAdminGovernancePortAdapter(
    suspendOrgUseCase,
    reactivateOrgUseCase,
    setOverrideUseCase,
    updatePricingUseCase,
    killSwitchUseCase,
    getKillSwitchState,
    redisClient
  );

  container.registerInstance(
    DI_TOKENS.SuperAdminGovernancePort as unknown as DependencyToken<ISuperAdminGovernancePort>,
    portAdapter
  );
  container.registerInstance(
    DI_TOKENS.AuditLoggerPort as unknown as DependencyToken<IAuditLoggerPort>,
    auditRepo
  );

  // Registro modular de endpoints REST
  registerGovernanceHttpRoutes(router, {
    rlsPool,
    adminRepo,
    getKillSwitchState,
    getKillSwitchReason,
    suspendOrgUseCase,
    reactivateOrgUseCase,
    forceLogoutUseCase,
    listOrgsUseCase,
    updatePricingUseCase,
    setOverrideUseCase,
    removeOverrideUseCase,
    grantMinutesUseCase,
    killSwitchUseCase,
  });
}
