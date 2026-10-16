/**
 * @archivo src/modules/06-superadmin-governance/application/tenant-lifecycle-governance.use-case.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Orquesta las operaciones criticas del ciclo de vida de organizaciones por SuperAdmin:
 *   suspension inmediata con corte de sockets (codigo 4003), reactivacion, cierre forzoso
 *   de sesiones de usuarios via incremento de `token_version` y auditoria inmutable.
 *
 * @resumen_contenido
 *   - `SuspendOrganizationUseCase`: Pasa organizacion a SUSPENDED, purga Redis y corta sockets.
 *   - `ReactivateOrganizationUseCase`: Restaura ACTIVE y registra en auditoria.
 *   - `ForceGlobalLogoutOrganizationUseCase`: Invalida todos los JWTs del tenant via token_version.
 *   - `ListGovernanceOrganizationsUseCase`: Listado paginado de tenants con telemetria.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`@shared/infrastructure/database/rls-pool.ts`).
 *   - `RedisClusterClient` (`@shared/infrastructure/redis/redis-cluster.client.ts`).
 *   - `DomainEventBus` (`@shared/infrastructure/event-bus/domain-event-bus.ts`).
 *   - `IVoiceGatewayControlPort` (`@shared/ports/billing-voice-admin.ports.ts`).
 *   - `PostgresGovernanceAuditRepository` (`../infrastructure/postgres-governance-audit.repository.ts`).
 *   - `Result`, `NotFoundError`, `ConflictError`, `toAppError`, `AppError` (`@shared/kernel/result-and-errors.ts`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `audit_logs`.
 *   - Redis: `auth:user_tv:*`, `oa:apikey:sha256:*`.
 */

import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import type { DomainEventBus } from '../../../shared/infrastructure/event-bus/domain-event-bus';
import type { IVoiceGatewayControlPort } from '../../../shared/ports/billing-voice-admin.ports';
import {
  Result,
  NotFoundError,
  ConflictError,
  toAppError,
  AppError,
} from '../../../shared/kernel/result-and-errors';
import type { PostgresGovernanceAdminRepository } from '../infrastructure/postgres-governance-admin.repository';
import type { PostgresGovernanceAuditRepository } from '../infrastructure/postgres-governance-audit.repository';
import type {
  TenantGovernanceDetails,
  SuspendOrganizationInput,
  ReactivateOrganizationInput,
  ForceLogoutOrganizationInput,
} from '../domain/governance.entities';

/** Dependencias inyectadas para la gobernanza del ciclo de vida de tenants. */
export interface TenantLifecycleGovernanceDependencies {
  readonly rlsPool: RlsDatabasePool;
  readonly adminRepo: PostgresGovernanceAdminRepository;
  readonly auditRepo: PostgresGovernanceAuditRepository;
  readonly redisClient?: RedisClusterClient | undefined;
  readonly eventBus?: DomainEventBus | undefined;
  readonly voiceGatewayControl?: IVoiceGatewayControlPort | undefined;
}

/** Caso de uso: Suspender una organizacion con corte de sockets y purga de claves. */
export class SuspendOrganizationUseCase {
  public constructor(private readonly deps: TenantLifecycleGovernanceDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string,
    input: SuspendOrganizationInput
  ): Promise<Result<TenantGovernanceDetails, AppError>> {
    try {
      const updatedOrg = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const current = await this.deps.adminRepo.getOrganizationById(client, orgId);
          if (!current) {
            throw new NotFoundError(`Organizacion ${orgId} no encontrada`);
          }
          if (current.status === 'SUSPENDED') {
            throw new ConflictError(`La organizacion ${orgId} ya se encuentra suspendida`);
          }

          const updated = await this.deps.adminRepo.updateOrganizationStatus(
            client,
            orgId,
            'SUSPENDED',
            input.reason,
            superAdminUserId
          );

          if (!updated) {
            throw new NotFoundError(`Fallo al actualizar estado de la organizacion ${orgId}`);
          }

          // 1. Invalidar tokens JWT EdDSA de todos los usuarios vinculados incrementando token_version (C1-10)
          const tokenVersionRes = await client.query<{ id: string; token_version: number }>(
            `UPDATE users u
             SET token_version = token_version + 1,
                 updated_at = NOW()
             FROM memberships m
             WHERE m.user_id = u.id AND m.organization_id = $1
             RETURNING u.id, u.token_version`,
            [orgId]
          );

          if (this.deps.redisClient) {
            for (const userRow of tokenVersionRes.rows) {
              await this.deps.redisClient.json.setText(
                this.deps.redisClient.keyNamespaces.authUserTokenVersion(userRow.id),
                String(userRow.token_version),
                86400
              );
            }
          }

          // 2. Registrar entrada inmutable en audit_logs dentro de la transaccion (C1-09)
          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'GOVERNANCE',
            eventAction: 'TENANT_SUSPENDED',
            severity: 'WARN',
            targetResourceType: 'ORGANIZATION',
            targetResourceId: orgId,
            beforeStateJson: { status: current.status },
            afterStateJson: { status: 'SUSPENDED', reason: input.reason },
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return updated;
        }
      );

      // 1. Corte inmediato de todas las sesiones de voz activas via puerto de control (Codigo 4003)
      if (input.immediateSocketClose && this.deps.voiceGatewayControl) {
        await this.deps.voiceGatewayControl.terminateAllOrgSessionsImmediately(
          orgId,
          `Organizacion suspendida por gobierno: ${input.reason}`,
          4003
        );
      }

      // 2. Propagacion por canal Pub/Sub en Redis para corte inmediato en todos los Node Pools (C1-10)
      if (this.deps.redisClient) {
        await this.deps.redisClient.publish(
          this.deps.redisClient.channels.terminateOrganizationSessions(orgId),
          { organizationId: orgId, reason: input.reason, code: 4003 }
        );
      }

      // 3. Notificacion de evento de dominio global duradero (C1-10: publishGlobal)
      if (this.deps.eventBus) {
        await this.deps.eventBus.publishGlobal(
          'organization.suspended',
          {
            organizationId: orgId,
            reason: input.reason,
            suspendedByUserId: superAdminUserId,
            suspendedAtIso: updatedOrg.suspendedAt ?? new Date().toISOString(),
          },
          { organizationId: orgId }
        );
      }

      return Result.ok(updatedOrg);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Reactivar una organizacion suspendida. */
export class ReactivateOrganizationUseCase {
  public constructor(private readonly deps: TenantLifecycleGovernanceDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string,
    input: ReactivateOrganizationInput
  ): Promise<Result<TenantGovernanceDetails, AppError>> {
    try {
      const updatedOrg = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          const current = await this.deps.adminRepo.getOrganizationById(client, orgId);
          if (!current) {
            throw new NotFoundError(`Organizacion ${orgId} no encontrada`);
          }
          if (current.status === 'ACTIVE') {
            throw new ConflictError(`La organizacion ${orgId} ya esta activa`);
          }

          const updated = await this.deps.adminRepo.updateOrganizationStatus(
            client,
            orgId,
            'ACTIVE',
            null,
            superAdminUserId
          );

          if (!updated) {
            throw new NotFoundError(`Fallo al reactivar la organizacion ${orgId}`);
          }

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'GOVERNANCE',
            eventAction: 'TENANT_REACTIVATED',
            severity: 'INFO',
            targetResourceType: 'ORGANIZATION',
            targetResourceId: orgId,
            beforeStateJson: { status: current.status, reason: current.suspendedReason },
            afterStateJson: { status: 'ACTIVE', notes: input.reactivationNotes },
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return updated;
        }
      );

      if (this.deps.eventBus) {
        await this.deps.eventBus.publishGlobal(
          'organization.reactivated',
          {
            organizationId: orgId,
            reactivatedByUserId: superAdminUserId,
            reactivatedAtIso: updatedOrg.updatedAt,
          },
          { organizationId: orgId }
        );
      }

      return Result.ok(updatedOrg);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Forzar cierre de sesion global de todos los usuarios de un tenant (revocacion EdDSA). */
export class ForceGlobalLogoutOrganizationUseCase {
  public constructor(private readonly deps: TenantLifecycleGovernanceDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string,
    input: ForceLogoutOrganizationInput
  ): Promise<Result<{ readonly affectedUsersCount: number }, AppError>> {
    try {
      const affectedCount = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          // Incrementa el token_version de todos los usuarios vinculados a la organizacion
          const updateRes = await client.query<{ id: string; token_version: number }>(
            `UPDATE users u
             SET token_version = token_version + 1,
                 updated_at = NOW()
             FROM memberships m
             WHERE m.user_id = u.id AND m.organization_id = $1
             RETURNING u.id, u.token_version`,
            [orgId]
          );

          // Purga atómica en Redis si el cliente esta disponible
          if (this.deps.redisClient) {
            for (const userRow of updateRes.rows) {
              await this.deps.redisClient.json.setText(
                this.deps.redisClient.keyNamespaces.authUserTokenVersion(userRow.id),
                String(userRow.token_version),
                86400
              );
            }
          }

          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'SECURITY',
            eventAction: 'GLOBAL_LOGOUT_FORCED',
            severity: 'WARN',
            targetResourceType: 'ORGANIZATION',
            targetResourceId: orgId,
            beforeStateJson: null,
            afterStateJson: { affectedUsers: updateRes.rowCount, reason: input.reason },
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return updateRes.rowCount ?? 0;
        }
      );

      if (this.deps.eventBus) {
        await this.deps.eventBus.publishGlobal(
          'voice.terminate_all_org_sessions',
          {
            organizationId: orgId,
            reason: input.reason,
            requestedByUserId: superAdminUserId,
          },
          { organizationId: orgId }
        );
      }

      return Result.ok({ affectedUsersCount: affectedCount });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: Listar organizaciones con filtros de estado y paginacion. */
export class ListGovernanceOrganizationsUseCase {
  public constructor(private readonly deps: TenantLifecycleGovernanceDependencies) {}

  public async execute(
    superAdminUserId: string,
    options: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined }
  ): Promise<Result<readonly TenantGovernanceDetails[], AppError>> {
    try {
      const orgs = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          return await this.deps.adminRepo.listOrganizations(client, options);
        }
      );
      return Result.ok(orgs);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
