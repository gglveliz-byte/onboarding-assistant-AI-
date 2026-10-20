/**
 * @archivo src/modules/06-superadmin-governance/application/delete-organization.use-case.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Ejecuta la eliminación segura y definitiva de una organización (tenant) por parte del
 *   SuperAdmin. Invalida todas las sesiones de usuario en base de datos y Redis, purga
 *   las API keys, cierra las llamadas de voz activas con código 4003, respeta las restricciones
 *   legales de auditoría/contabilidad (ON DELETE RESTRICT en usage_ledger y audit_logs)
 *   y registra un asiento inmutable de auditoría forense SOC2 encadenado con SHA-256.
 *
 * @resumen_contenido
 *   - Interfaz `DeleteOrganizationResult`: Detalles de la eliminación y modo aplicado (físico o tombstone).
 *   - Clase `DeleteOrganizationUseCase`:
 *       * `execute()`: Orquesta la transacción de SuperAdmin, purga credenciales y sockets,
 *         y publica eventos duraderos en Redis y EventBus.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (`@shared/infrastructure/database/rls-pool.ts`).
 *   - `RedisClusterClient` (`@shared/infrastructure/redis/redis-cluster.client.ts`).
 *   - `DomainEventBus` (`@shared/infrastructure/event-bus/domain-event-bus.ts`).
 *   - `IVoiceGatewayControlPort` (`@shared/ports/billing-voice-admin.ports.ts`).
 *   - `PostgresGovernanceAdminRepository`, `PostgresGovernanceAuditRepository`.
 *   - `TenantLifecycleGovernanceDependencies` (`./tenant-lifecycle-governance.use-case.ts`).
 *   - `Result`, `NotFoundError`, `toAppError`, `AppError` (`@shared/kernel/result-and-errors.ts`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `memberships`, `api_keys`, `projects`, `audit_logs`.
 *   - Redis: `auth:user_tv:*`, `oa:apikey:sha256:*`.
 */

import type { TenantLifecycleGovernanceDependencies } from './tenant-lifecycle-governance.use-case';
import {
  Result,
  NotFoundError,
  toAppError,
  type AppError,
} from '../../../shared/kernel/result-and-errors';

export interface DeleteOrganizationResult {
  readonly organizationId: string;
  readonly deleted: boolean;
  readonly mode: 'HARD_DELETED' | 'SOFT_DELETED_TOMBSTONE';
}

/**
 * Caso de uso: Eliminación segura de organizaciones por SuperAdmin.
 */
export class DeleteOrganizationUseCase {
  public constructor(private readonly deps: TenantLifecycleGovernanceDependencies) {}

  public async execute(
    superAdminUserId: string,
    orgId: string
  ): Promise<Result<DeleteOrganizationResult, AppError>> {
    try {
      const deleteResult = await this.deps.rlsPool.runInSuperAdminTransaction(
        superAdminUserId,
        async (client) => {
          // 1. Verificar existencia previa de la organización
          const current = await this.deps.adminRepo.getOrganizationById(client, orgId);
          if (!current) {
            throw new NotFoundError(`Organización ${orgId} no encontrada.`);
          }

          // 2. Incrementar token_version de todos los usuarios vinculados para invalidar JWTs
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
              ).catch(() => {});
            }
          }

          // 3. Ejecutar borrado o tombstone en el repositorio administrativo
          const repoOutcome = await this.deps.adminRepo.deleteOrganization(client, orgId);

          // 4. Registrar asiento inmutable de auditoría forense SOC2 encadenado SHA-256
          const auditRes = await this.deps.auditRepo.appendImmutableAuditLog({
            organizationId: repoOutcome.mode === 'HARD_DELETED' ? null : orgId,
            actorUserId: superAdminUserId,
            eventCategory: 'GOVERNANCE',
            eventAction: 'ORGANIZATION_DELETED',
            severity: 'CRITICAL_SECURITY',
            targetResourceType: 'ORGANIZATION',
            targetResourceId: orgId,
            beforeStateJson: {
              id: current.id,
              name: current.name,
              slug: current.slug,
              status: current.status,
            },
            afterStateJson: {
              deleted: true,
              mode: repoOutcome.mode,
              purgedAt: new Date().toISOString(),
              purgedBySuperAdminUserId: superAdminUserId,
            },
          }, client);

          if (!auditRes.ok) {
            throw new Error(`AUDIT_LOG_FAILED: ${auditRes.reason}`);
          }

          return {
            organizationId: orgId,
            deleted: repoOutcome.deleted,
            mode: repoOutcome.mode,
          };
        }
      );

      // 5. Corte forzoso e inmediato de sesiones de voz activas (Código 4003)
      if (this.deps.voiceGatewayControl) {
        await this.deps.voiceGatewayControl.terminateAllOrgSessionsImmediately(
          orgId,
          'Organización eliminada por gobierno SuperAdmin.',
          4003
        ).catch(() => {});
      }

      // 6. Propagar orden de terminación inmediata en Redis Pub/Sub a todos los Node Pools
      if (this.deps.redisClient) {
        await this.deps.redisClient.publish(
          this.deps.redisClient.channels.terminateOrganizationSessions(orgId),
          { organizationId: orgId, reason: 'Organización eliminada', code: 4003 }
        ).catch(() => {});
      }

      // 7. Notificación en EventBus de dominio global
      if (this.deps.eventBus) {
        await this.deps.eventBus.publishGlobal(
          'organization.deleted',
          {
            organizationId: orgId,
            deletedByUserId: superAdminUserId,
            deletedAtIso: new Date().toISOString(),
            mode: deleteResult.mode,
          },
          { organizationId: orgId }
        ).catch(() => {});
      }

      return Result.ok(deleteResult);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
