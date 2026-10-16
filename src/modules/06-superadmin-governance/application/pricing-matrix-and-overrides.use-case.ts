/**
 * @archivo src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Gestiona la matriz global de precios sincronizada con Whop, la asignacion de tarifas
 *   personalizadas (overrides) por organizacion, el otorgamiento de minutos de cortesia
 *   y el accionamiento del Kill-Switch de emergencia del motor de voz IA.
 *
 * @resumen_contenido
 *   - `UpdateGlobalPricingMatrixUseCase`: Actualiza tarifas base, cuota y tramos de volumen.
 *   - `SetTenantPricingOverrideUseCase`: Fija descuentos o tarifa especial a un cliente.
 *   - `RemoveTenantPricingOverrideUseCase`: Elimina override restableciendo precio Whop oficial.
 *   - `GrantPromotionalMinutesUseCase`: Acredita minutos con asiento inmutable en `usage_ledger`.
 *   - `SwitchVoiceAiKillSwitchUseCase`: Conmuta el Kill-Switch global del gateway de voz.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`@shared/infrastructure/database/rls-pool.ts`).
 *   - `PostgresGovernanceAuditRepository` (`../infrastructure/postgres-governance-audit.repository.ts`).
 *   - `Result`, `NotFoundError`, `toAppError`, `AppError` (`@shared/kernel/result-and-errors.ts`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`, `organization_pricing_overrides`,
 *     `whop_subscriptions`, `usage_ledger`, `audit_logs`.
 */

import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import { Result, NotFoundError, toAppError, AppError } from '../../../shared/kernel/result-and-errors';
import type { PostgresGovernanceAdminRepository } from '../infrastructure/postgres-governance-admin.repository';
import type { PostgresGovernanceAuditRepository } from '../infrastructure/postgres-governance-audit.repository';
import type { DomainEventBus } from '../../../shared/infrastructure/event-bus/domain-event-bus';
import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import type {
  GlobalPricingPlanEntity,
  TenantPricingOverrideEntity,
  UpdateGlobalPricingInput,
  SetTenantOverrideInput,
  GrantPromotionalMinutesInput,
  VoiceAiKillSwitchInput,
} from '../domain/governance.entities';

/** Dependencias para la gobernanza de precios y overrides. */
export interface PricingMatrixAndOverridesDependencies {
  readonly rlsPool: RlsDatabasePool;
  readonly adminRepo: PostgresGovernanceAdminRepository;
  readonly auditRepo: PostgresGovernanceAuditRepository;
  readonly getKillSwitchState: () => Promise<boolean> | boolean;
  readonly setKillSwitchState: (active: boolean, reason: string | null, superAdminUserId: string) => Promise<void> | void;
  readonly redisClient?: RedisClusterClient | undefined;
  readonly eventBus?: DomainEventBus | undefined;
}

/** Caso de uso: Actualizar un plan de precios global sincronizado con Whop. */
export class UpdateGlobalPricingMatrixUseCase {
  public constructor(private readonly deps: PricingMatrixAndOverridesDependencies) {}

  public async execute(
    superAdminUserId: string,
    planCode: string,
    input: UpdateGlobalPricingInput
  ): Promise<Result<GlobalPricingPlanEntity, AppError>> {
    try {
      const plan = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const previous = await this.deps.adminRepo.getPricingPlan(client, planCode);

          const savedPlan = await this.deps.adminRepo.upsertPricingPlan(client, {
            planCode,
            whopPlanId: input.whopPlanId,
            displayName: input.displayName,
            monthlyFixedPriceUsd: input.monthlyFixedPriceUsd,
            includedMinutes: input.includedMinutes,
            baseOverageRatePerMinuteUsd: input.baseOverageRatePerMinuteUsd,
            overageAllowed: input.overageAllowed,
            volumeDiscountEligible: input.volumeDiscountEligible,
            volumeDiscountTiersJson: input.volumeDiscountTiersJson,
            isActive: input.isActive,
            superAdminId: superAdminUserId,
          });

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: null,
            actorUserId: superAdminUserId,
            eventCategory: 'PRICING',
            eventAction: 'PRICING_PLAN_UPDATED',
            severity: 'WARN',
            targetResourceType: 'PRICING_PLAN',
            targetResourceId: planCode,
            beforeStateJson: previous,
            afterStateJson: savedPlan,
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return savedPlan;
        }
      );

      return Result.ok(plan);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Asignar override de tarifa o descuento manual a un tenant especifico. */
export class SetTenantPricingOverrideUseCase {
  public constructor(private readonly deps: PricingMatrixAndOverridesDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string,
    input: SetTenantOverrideInput
  ): Promise<Result<TenantPricingOverrideEntity, AppError>> {
    try {
      const override = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const org = await this.deps.adminRepo.getOrganizationById(client, orgId);
          if (!org) {
            throw new NotFoundError(`Organizacion ${orgId} no encontrada`);
          }

          const previous = await this.deps.adminRepo.getPricingOverride(client, orgId);

          const savedOverride = await this.deps.adminRepo.upsertPricingOverride(client, {
            organizationId: orgId,
            customRatePerMinuteUsd: input.customRatePerMinuteUsd ?? null,
            manualDiscountPercentage: input.manualDiscountPercentage ?? 0,
            forceVolumeDiscountTiers: input.forceVolumeDiscountTiers ?? false,
            customVolumeTiersJson: input.customVolumeTiersJson ?? null,
            overrideNotes: input.overrideNotes,
            effectiveUntil: input.effectiveUntilIso ?? null,
            superAdminId: superAdminUserId,
          });

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'PRICING',
            eventAction: 'TENANT_PRICING_OVERRIDE_SET',
            severity: 'INFO',
            targetResourceType: 'PRICING_OVERRIDE',
            targetResourceId: savedOverride.id,
            beforeStateJson: previous,
            afterStateJson: savedOverride,
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return savedOverride;
        }
      );

      return Result.ok(override);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Eliminar el override de tarificacion restableciendo el plan base. */
export class RemoveTenantPricingOverrideUseCase {
  public constructor(private readonly deps: PricingMatrixAndOverridesDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string
  ): Promise<Result<boolean, AppError>> {
    try {
      const deleted = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const previous = await this.deps.adminRepo.getPricingOverride(client, orgId);
          if (!previous) {
            throw new NotFoundError(`La organizacion ${orgId} no tiene overrides registrados`);
          }

          const success = await this.deps.adminRepo.deletePricingOverride(client, orgId);

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'PRICING',
            eventAction: 'TENANT_PRICING_OVERRIDE_REMOVED',
            severity: 'INFO',
            targetResourceType: 'PRICING_OVERRIDE',
            targetResourceId: previous.id,
            beforeStateJson: previous,
            afterStateJson: null,
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return success;
        }
      );

      return Result.ok(deleted);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Acreditar minutos de cortesia o promocionales con registro contable. */
export class GrantPromotionalMinutesUseCase {
  public constructor(private readonly deps: PricingMatrixAndOverridesDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string,
    input: GrantPromotionalMinutesInput
  ): Promise<Result<{ readonly creditedMinutes: string; readonly organizationId: string }, AppError>> {
    try {
      await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const org = await this.deps.adminRepo.getOrganizationById(client, orgId);
          if (!org) {
            throw new NotFoundError(`Organizacion ${orgId} no encontrada`);
          }

          const credited = await this.deps.adminRepo.creditPromotionalMinutes(
            client,
            orgId,
            input.minutesToGrant,
            input.reason
          );

          if (!credited) {
            throw new NotFoundError(`La organizacion ${orgId} no tiene suscripcion activa para acreditar minutos`);
          }

          // Asiento inmutable en usage_ledger (append-only)
          await client.query(
            `INSERT INTO usage_ledger (
              organization_id, entry_type, minutes_delta, unit_rate_usd,
              discount_applied_pct, amount_usd_delta, included_minutes_balance_after,
              credit_balance_usd_after, metadata_json, created_at
            ) VALUES ($1, 'CREDIT_SUPERADMIN_GRANT', $2::numeric, 0, 0, 0, $2::numeric, 0, $3, NOW())`,
            [orgId, input.minutesToGrant, JSON.stringify({ reason: input.reason, grantedBy: superAdminUserId })]
          );

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'FINANCIAL',
            eventAction: 'PROMOTIONAL_MINUTES_GRANTED',
            severity: 'INFO',
            targetResourceType: 'ORGANIZATION',
            targetResourceId: orgId,
            beforeStateJson: null,
            afterStateJson: { minutesGranted: input.minutesToGrant, reason: input.reason },
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }
        }
      );

      return Result.ok({ creditedMinutes: input.minutesToGrant, organizationId: orgId });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Accionar el Kill-Switch global del motor de voz IA en emergencia. */
export class SwitchVoiceAiKillSwitchUseCase {
  public constructor(private readonly deps: PricingMatrixAndOverridesDependencies) {}

  public async execute(
    superAdminUserId: string,
    input: VoiceAiKillSwitchInput
  ): Promise<Result<{ readonly killSwitchActive: boolean; readonly reason: string }, AppError>> {
    try {
      await this.deps.setKillSwitchState(input.active, input.active ? input.reason : null, superAdminUserId);

      // Publicar comando de infraestructura en el canal de gobierno distribuido (C1-08)
      if (this.deps.redisClient) {
        await this.deps.redisClient.publish(
          this.deps.redisClient.channels.governanceCommands,
          JSON.stringify({
            type: 'VOICE_KILL_SWITCH_UPDATED',
            active: input.active,
            reason: input.reason,
            superAdminUserId,
            toggledAt: new Date().toISOString(),
          })
        );
      }

      const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
        organizationId: null,
        actorUserId: superAdminUserId,
        eventCategory: 'SECURITY',
        eventAction: input.active ? 'VOICE_AI_KILL_SWITCH_ACTIVATED' : 'VOICE_AI_KILL_SWITCH_DEACTIVATED',
        severity: input.active ? 'CRITICAL_SECURITY' : 'INFO',
        targetResourceType: 'PLATFORM_INFRASTRUCTURE',
        targetResourceId: 'VOICE_GATEWAY_AI',
        beforeStateJson: { active: !input.active },
        afterStateJson: { active: input.active, reason: input.reason },
      });

      if (!auditRes.ok) {
        throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
      }

      return Result.ok({ killSwitchActive: input.active, reason: input.reason });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
