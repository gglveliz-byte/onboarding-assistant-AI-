/**
 * @archivo src/modules/06-superadmin-governance/infrastructure/governance-http.routes.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Define y registra todos los endpoints REST `/api/v1/superadmin/*` para la consola de gobierno.
 *   Exige autenticación estricta con rol `SUPERADMIN` y alcance específico por acción, protegiendo
 *   la plataforma contra accesos no autorizados y manteniendo total aislamiento multi-tenant.
 *
 * @resumen_contenido
 *   - Endpoints de ciclo de vida de organizaciones: suspender, reactivar, force-logout, listado.
 *   - Endpoints de tarificación global y personal: matriz Whop, overrides y minutos de cortesía.
 *   - Endpoint de infraestructura: Kill-Switch global de voz IA y snapshot de telemetría.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `HttpRouterRegistry`, `HttpRequestLike`, `AuthenticatedRequestContext` (@shared/infrastructure/http/http-server.types.ts).
 *   - Casos de uso de gobierno (@modules/06-superadmin-governance/application/*).
 *   - Esquemas Zod de gobierno (@modules/06-superadmin-governance/domain/governance.entities.ts).
 *   - `PostgresGovernanceAdminRepository`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `pricing_plans_config`, `organization_pricing_overrides`, `audit_logs`.
 */

import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRouteHandler,
  HttpRouterRegistry,
  HttpRequestLike,
} from '../../../shared/infrastructure/http/http-server.types';
import { ForbiddenError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { PostgresGovernanceAdminRepository } from './postgres-governance-admin.repository';
import type { PostgresGovernanceAuditRepository } from './postgres-governance-audit.repository';
import type {
  SuspendOrganizationUseCase,
  ReactivateOrganizationUseCase,
  ForceGlobalLogoutOrganizationUseCase,
  ListGovernanceOrganizationsUseCase,
} from '../application/tenant-lifecycle-governance.use-case';
import type { DeleteOrganizationUseCase } from '../application/delete-organization.use-case';
import type {
  GetPublicDemoConfigUseCase,
  UpdatePublicDemoConfigUseCase,
} from '../application/public-demo-config.use-case';
import type {
  UpdateGlobalPricingMatrixUseCase,
  DeleteGlobalPricingPlanUseCase,
  SetTenantPricingOverrideUseCase,
  RemoveTenantPricingOverrideUseCase,
  GrantPromotionalMinutesUseCase,
  SwitchVoiceAiKillSwitchUseCase,
} from '../application/pricing-matrix-and-overrides.use-case';
import {
  suspendOrganizationSchema,
  reactivateOrganizationSchema,
  forceLogoutOrganizationSchema,
  updateGlobalPricingSchema,
  createGlobalPricingSchema,
  setTenantOverrideSchema,
  grantPromotionalMinutesSchema,
  updatePublicDemoConfigSchema,
  voiceAiKillSwitchSchema,
} from '../domain/governance.entities';

/** Envoltorio de manejador para compatibilidad de tipos con HttpRouteRegistration. */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/** Helper para requerir que el contexto posea un principal SuperAdmin autenticado. */
function assertSuperAdminPrincipal(ctx: AuthenticatedRequestContext) {
  if (!ctx.principal) {
    throw new ForbiddenError('Se requiere un token de acceso valido para gobernar este recurso');
  }
  if (ctx.principal.role !== 'SUPERADMIN') {
    throw new ForbiddenError('Se requieren privilegios de SuperAdmin de plataforma.');
  }
  return ctx.principal;
}

/** Extrae un parámetro nombrado de la URL tras una clave base (ej. 'organizations' -> orgId). */
function getRouteParam(path: string, keyName: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  const idx = parts.indexOf(keyName);
  if (idx !== -1 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return undefined;
}

/** Agrupación de dependencias de casos de uso para las rutas HTTP de gobierno. */
export interface GovernanceHttpRoutesParams {
  readonly rlsPool: RlsDatabasePool;
  readonly adminRepo: PostgresGovernanceAdminRepository;
  readonly auditRepo?: PostgresGovernanceAuditRepository | undefined;
  readonly getKillSwitchState: () => boolean;
  readonly getKillSwitchReason: () => string | null;
  readonly suspendOrgUseCase: SuspendOrganizationUseCase;
  readonly reactivateOrgUseCase: ReactivateOrganizationUseCase;
  readonly forceLogoutUseCase: ForceGlobalLogoutOrganizationUseCase;
  readonly listOrgsUseCase: ListGovernanceOrganizationsUseCase;
  readonly deleteOrgUseCase?: DeleteOrganizationUseCase | undefined;
  readonly updatePricingUseCase: UpdateGlobalPricingMatrixUseCase;
  readonly deletePricingUseCase?: DeleteGlobalPricingPlanUseCase | undefined;
  readonly setOverrideUseCase: SetTenantPricingOverrideUseCase;
  readonly removeOverrideUseCase: RemoveTenantPricingOverrideUseCase;
  readonly grantMinutesUseCase: GrantPromotionalMinutesUseCase;
  readonly killSwitchUseCase: SwitchVoiceAiKillSwitchUseCase;
  readonly getDemoConfigUseCase: GetPublicDemoConfigUseCase;
  readonly updateDemoConfigUseCase: UpdatePublicDemoConfigUseCase;
}

/**
 * Registra todas las rutas HTTP del Módulo 06 en el HttpRouterRegistry.
 */
export function registerGovernanceHttpRoutes(
  router: HttpRouterRegistry,
  deps: GovernanceHttpRoutesParams
): void {
  // POST /api/v1/superadmin/organizations/:orgId/suspend
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/organizations/:orgId/suspend',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const parsedBody = suspendOrganizationSchema.parse(req.body);
      const res = await deps.suspendOrgUseCase.execute(principal.userId, orgId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // POST /api/v1/superadmin/organizations/:orgId/reactivate
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/organizations/:orgId/reactivate',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const parsedBody = reactivateOrganizationSchema.parse(req.body);
      const res = await deps.reactivateOrgUseCase.execute(principal.userId, orgId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // POST /api/v1/superadmin/organizations/:orgId/force-logout
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/organizations/:orgId/force-logout',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const parsedBody = forceLogoutOrganizationSchema.parse(req.body);
      const res = await deps.forceLogoutUseCase.execute(principal.userId, orgId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // GET /api/v1/superadmin/organizations
  router.register({
    method: 'GET',
    path: '/api/v1/superadmin/organizations',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const statusFilter = req.query['status'] as string | undefined;
      const res = await deps.listOrgsUseCase.execute(principal.userId, { status: statusFilter });
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // DELETE /api/v1/superadmin/organizations/:orgId
  router.register({
    method: 'DELETE',
    path: '/api/v1/superadmin/organizations/:orgId',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      if (!deps.deleteOrgUseCase) {
        throw new ValidationError('Servicio de eliminacion de organizacion no configurado');
      }
      const res = await deps.deleteOrgUseCase.execute(principal.userId, orgId);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // POST /api/v1/superadmin/pricing-matrix
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/pricing-matrix',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const parsedBody = createGlobalPricingSchema.parse(req.body);
      const res = await deps.updatePricingUseCase.execute(principal.userId, parsedBody.planCode, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 201, body: res.value };
    }),
  });

  // PUT /api/v1/superadmin/pricing-matrix/:planCode
  router.register({
    method: 'PUT',
    path: '/api/v1/superadmin/pricing-matrix/:planCode',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const planCode = getRouteParam(req.path, 'pricing-matrix');
      if (!planCode) {
        throw new ValidationError('Parametro :planCode requerido en la ruta');
      }
      const parsedBody = updateGlobalPricingSchema.parse(req.body);
      const res = await deps.updatePricingUseCase.execute(principal.userId, planCode, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // DELETE /api/v1/superadmin/pricing-matrix/:planCode
  router.register({
    method: 'DELETE',
    path: '/api/v1/superadmin/pricing-matrix/:planCode',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const planCode = getRouteParam(req.path, 'pricing-matrix');
      if (!planCode) {
        throw new ValidationError('Parametro :planCode requerido en la ruta');
      }
      if (!deps.deletePricingUseCase) {
        throw new ValidationError('Servicio de eliminacion no configurado');
      }
      const res = await deps.deletePricingUseCase.execute(principal.userId, planCode);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: { success: res.value } };
    }),
  });

  // POST /api/v1/superadmin/organizations/:orgId/pricing-override
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/organizations/:orgId/pricing-override',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const parsedBody = setTenantOverrideSchema.parse(req.body);
      const res = await deps.setOverrideUseCase.execute(principal.userId, orgId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // DELETE /api/v1/superadmin/organizations/:orgId/pricing-override
  router.register({
    method: 'DELETE',
    path: '/api/v1/superadmin/organizations/:orgId/pricing-override',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const res = await deps.removeOverrideUseCase.execute(principal.userId, orgId);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: { success: res.value } };
    }),
  });

  // POST /api/v1/superadmin/organizations/:orgId/grant-promotional-minutes
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/organizations/:orgId/grant-promotional-minutes',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const orgId = getRouteParam(req.path, 'organizations');
      if (!orgId) {
        throw new ValidationError('Parametro :orgId requerido en la ruta');
      }
      const parsedBody = grantPromotionalMinutesSchema.parse(req.body);
      const res = await deps.grantMinutesUseCase.execute(principal.userId, orgId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // POST /api/v1/superadmin/infrastructure/voice-ai-killswitch
  router.register({
    method: 'POST',
    path: '/api/v1/superadmin/infrastructure/voice-ai-killswitch',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const parsedBody = voiceAiKillSwitchSchema.parse(req.body);
      const res = await deps.killSwitchUseCase.execute(principal.userId, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // GET /api/v1/superadmin/telemetry/snapshot
  router.register({
    method: 'GET',
    path: '/api/v1/superadmin/telemetry/snapshot',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const snapshot = await deps.rlsPool.runInSuperAdminTransaction(principal.userId, async (client) => {
        return await deps.adminRepo.getPlatformTelemetrySnapshot(
          client,
          deps.getKillSwitchState(),
          deps.getKillSwitchReason()
        );
      });
      return { status: 200, body: snapshot };
    }),
  });

  // GET /api/v1/superadmin/pricing-matrix
  router.register({
    method: 'GET',
    path: '/api/v1/superadmin/pricing-matrix',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      const plans = await deps.rlsPool.runInSuperAdminTransaction(principal.userId, async (client) => {
        return await deps.adminRepo.listPricingPlans(client);
      });
      return { status: 200, body: { plans } };
    }),
  });

  // GET /api/v1/superadmin/audit-logs
  router.register({
    method: 'GET',
    path: '/api/v1/superadmin/audit-logs',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:govern_tenants'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertSuperAdminPrincipal(ctx);
      if (!deps.auditRepo) {
        return { status: 200, body: { logs: [] } };
      }
      const severity = req.query['severity'] as string | undefined;
      const limit = Number(req.query['limit'] ?? 50);
      const logs = await deps.rlsPool.runInSuperAdminTransaction(principal.userId, async (client) => {
        return await deps.auditRepo!.listAuditLogs(client, { severity, limit });
      });
      return { status: 200, body: { logs } };
    }),
  });

  // GET /api/v1/superadmin/public-demo-config — configuración gobernable de la demo pública (Redis).
  router.register({
    method: 'GET',
    path: '/api/v1/superadmin/public-demo-config',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      assertSuperAdminPrincipal(ctx);
      const res = await deps.getDemoConfigUseCase.execute();
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // PUT /api/v1/superadmin/public-demo-config — fija duración y límite por IP de la demo pública.
  router.register({
    method: 'PUT',
    path: '/api/v1/superadmin/public-demo-config',
    access: 'SUPERADMIN',
    requiredScopes: ['admin:manage_pricing'],
    ownerModule: '06-superadmin-governance',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      assertSuperAdminPrincipal(ctx);
      const parsedBody = updatePublicDemoConfigSchema.parse(req.body);
      const res = await deps.updateDemoConfigUseCase.execute(parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });
}
