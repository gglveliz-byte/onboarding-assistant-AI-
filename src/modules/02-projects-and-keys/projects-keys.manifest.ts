/**
 * @archivo src/modules/02-projects-and-keys/projects-keys.manifest.ts
 * @modulo 02-projects-and-keys (Manifiesto Oficial y Auto-Wiring del Modulo de Proyectos y Claves)
 * @proposito
 *   Conecta e inicializa todos los repositorios, casos de uso, adaptadores de puertos y
 *   endpoints REST del Modulo 02 (Proyectos, Dominios Permitidos, Claves de API y Handshake del SDK).
 *   Registra el puerto oficial `IApiKeyAndHandshakePort` en el contenedor de dependencias
 *   (`DI_TOKENS.ApiKeyValidationPort` y `DI_TOKENS.SdkHandshakePort`) y publica sus rutas en `HttpRouterRegistry`.
 *
 * @resumen_contenido
 *   - Funcion `registerProjectsKeysModule()`:
 *       * Resolucion de dependencias del Kernel, Redis y Facturacion.
 *       * Instanciacion de casos de uso de gestion de proyectos, claves y handshake.
 *       * Registro del adaptador `ApiKeyAndHandshakePortAdapter`.
 *       * Enrutamiento de endpoints `/api/v1/projects/*` y `/api/v1/sdk/handshake`.
 *
 * @dependencias_internas
 *   - `DependencyContainer`, `DI_TOKENS` (@shared/container/di-container.ts).
 *   - `HttpRouterRegistry`, `WsRouteRegistry` (@shared/infrastructure/http/http-server.types.ts).
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `JwtEddsaSigner` (@modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer.ts).
 *   - `IBillingWhopPort` (@shared/ports/billing-voice-admin.ports.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`.
 *   - Redis: `oa:apikey:sha256:<hash>`, `oa:proj:<id>:allowed_domains`, `oa:sdk_handshake:nonce:<jti>`.
 */

import type { DependencyContainer } from '@shared/container/di-container';
import { DI_TOKENS } from '@shared/container/di-container';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRouteHandler,
  HttpRouterRegistry,
  HttpRequestLike,
  WsRouteRegistry,
} from '@shared/infrastructure/http/http-server.types';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import type { IBillingWhopPort } from '@shared/ports/billing-voice-admin.ports';
import { UnauthorizedError, ValidationError } from '@shared/kernel/result-and-errors';
import { JwtEddsaSigner } from '@modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { PostgresProjectsKeysRepository } from './infrastructure/postgres-projects-keys.repository';
import {
  CreateAllowedDomainUseCase,
  CreateProjectUseCase,
  DeleteAllowedDomainUseCase,
  ListProjectsUseCase,
  UpdateProjectUseCase,
} from './application/manage-projects-and-domains.use-case';
import {
  CreateApiKeyUseCase,
  RevokeApiKeyImmediatelyUseCase,
  RotateApiKeyUseCase,
  ValidateSecretApiKeyUseCase,
} from './application/api-key-lifecycle.use-case';
import {
  ApiKeyAndHandshakePortAdapter,
  ValidateSdkHandshakeUseCase,
} from './application/sdk-handshake.use-case';
import { ApiKeyType } from '@shared/kernel/api-key.util';
import {
  CreateProjectInput,
  ProjectEnvironment,
  UpdateProjectInput,
  VadSensitivity,
  VoiceModelType,
} from './domain/projects-keys.entities';

/** Helper para requerir que el contexto posea un principal autenticado. */
function assertPrincipal(ctx: AuthenticatedRequestContext) {
  if (!ctx.principal) {
    throw new UnauthorizedError('Se requiere un token de acceso valido para gestionar este recurso');
  }
  return ctx.principal;
}

/** Envoltorio de manejador para compatibilidad de tipos con HttpRouteRegistration. */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/** Extrae un parametro nombrado de la URL tras una clave base (ej. 'projects' -> projectId). */
function getRouteParam(path: string, keyName: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  const idx = parts.indexOf(keyName);
  if (idx !== -1 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return undefined;
}

/**
 * Registra y auto-conecta el modulo 02 en el contenedor de dependencias y en el enrutador HTTP.
 */
export function registerProjectsKeysModule(
  container: DependencyContainer,
  router: HttpRouterRegistry,
  _wsRegistry?: WsRouteRegistry
): void {
  // 1. Resolver dependencias de infraestructura desde el contenedor
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;
  const jwtSigner = new JwtEddsaSigner(redisClient);

  // Resolver puerto de facturacion obligatorio: falla cerrado si no esta cableado (C1-02)
  let billingPort: IBillingWhopPort;
  if (container.has(DI_TOKENS.BillingDeductionPort)) {
    billingPort = container.get(DI_TOKENS.BillingDeductionPort) as IBillingWhopPort;
  } else {
    billingPort = {
      checkOrganizationSolvency: async () => ({
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'El modulo de facturacion no esta registrado en el contenedor de dependencias',
        retryable: false,
      }),
      deductVoiceSessionSlice: async () => {
        throw new Error('BILLING_MODULE_NOT_INITIALIZED: registerBillingWhopModule() requerido');
      },
      grantPromotionalMinutes: async () => {
        throw new Error('BILLING_MODULE_NOT_INITIALIZED: registerBillingWhopModule() requerido');
      },
    };
  }

  // 2. Instanciar repositorio especializado
  const repository = new PostgresProjectsKeysRepository(redisClient);

  // 3. Instanciar casos de uso
  const createProjectUseCase = new CreateProjectUseCase(rlsPool, repository);
  const updateProjectUseCase = new UpdateProjectUseCase(rlsPool, repository);
  const listProjectsUseCase = new ListProjectsUseCase(rlsPool, repository);
  const createAllowedDomainUseCase = new CreateAllowedDomainUseCase(rlsPool, repository);
  const deleteAllowedDomainUseCase = new DeleteAllowedDomainUseCase(rlsPool, repository);

  const createApiKeyUseCase = new CreateApiKeyUseCase(rlsPool, repository);
  const rotateApiKeyUseCase = new RotateApiKeyUseCase(rlsPool, repository);
  const revokeApiKeyUseCase = new RevokeApiKeyImmediatelyUseCase(rlsPool, repository);
  const validateSecretKeyUseCase = new ValidateSecretApiKeyUseCase(rlsPool, repository);

  const validateSdkHandshakeUseCase = new ValidateSdkHandshakeUseCase(
    rlsPool,
    repository,
    jwtSigner,
    billingPort
  );

  // 4. Registrar adaptador oficial de puertos
  const portAdapter = new ApiKeyAndHandshakePortAdapter(
    validateSecretKeyUseCase,
    rlsPool,
    repository,
    billingPort
  );
  container.registerInstance(DI_TOKENS.ApiKeyValidationPort, portAdapter);
  container.registerInstance(DI_TOKENS.SdkHandshakePort, portAdapter);

  // ===========================================================================
  // 5. REGISTRO DE RUTAS HTTP REST
  // ===========================================================================

  // POST /api/v1/projects (Crear proyecto con claves iniciales)
  router.register({
    method: 'POST',
    path: '/api/v1/projects',
    access: 'TENANT_SESSION',
    requiredScopes: ['project:create'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['name'] !== 'string' || typeof b['slug'] !== 'string') {
        throw new ValidationError('Los campos "name" y "slug" son obligatorios para crear un proyecto');
      }

      const input: CreateProjectInput = {
        organizationId: principal.organizationId,
        name: b['name'],
        slug: b['slug'],
        environment: (b['environment'] as ProjectEnvironment) ?? 'LIVE',
        ...(typeof b['primaryVoiceModel'] === 'string'
          ? { primaryVoiceModel: b['primaryVoiceModel'] as VoiceModelType }
          : {}),
        ...(typeof b['fallbackVoiceModel'] === 'string'
          ? { fallbackVoiceModel: b['fallbackVoiceModel'] as VoiceModelType }
          : {}),
        ...(typeof b['voicePersonaCode'] === 'string' ? { voicePersonaCode: b['voicePersonaCode'] } : {}),
        ...(typeof b['speechSpeed'] === 'number' ? { speechSpeed: b['speechSpeed'] } : {}),
        ...(typeof b['vadBargeInSensitivity'] === 'string'
          ? { vadBargeInSensitivity: b['vadBargeInSensitivity'] as VadSensitivity }
          : {}),
        ...(typeof b['modelTemperature'] === 'number' ? { modelTemperature: b['modelTemperature'] } : {}),
        ...(typeof b['systemPrompt'] === 'string' ? { systemPrompt: b['systemPrompt'] } : {}),
        createdByUserId: principal.userId,
      };

      const result = await createProjectUseCase.execute(input);
      if (!result.ok) {
        throw result.error;
      }
      return { status: 201, body: result.value };
    }),
  });

  // GET /api/v1/projects (Listar proyectos del tenant)
  router.register({
    method: 'GET',
    path: '/api/v1/projects',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const result = await listProjectsUseCase.execute(principal.organizationId, principal.userId);
      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });

  // PUT /api/v1/projects/:projectId (Actualizar configuracion de un proyecto)
  router.register({
    method: 'PUT',
    path: '/api/v1/projects/:projectId',
    access: 'TENANT_SESSION',
    requiredScopes: ['project:update'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) {
        throw new ValidationError('Parametro :projectId requerido en la ruta');
      }

      const b = (req.body ?? {}) as Record<string, unknown>;
      const updateDto: UpdateProjectInput = {
        ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
        ...(typeof b['primaryVoiceModel'] === 'string'
          ? { primaryVoiceModel: b['primaryVoiceModel'] as VoiceModelType }
          : {}),
        ...(typeof b['fallbackVoiceModel'] === 'string'
          ? { fallbackVoiceModel: b['fallbackVoiceModel'] as VoiceModelType }
          : {}),
        ...(typeof b['voicePersonaCode'] === 'string' ? { voicePersonaCode: b['voicePersonaCode'] } : {}),
        ...(typeof b['speechSpeed'] === 'number' ? { speechSpeed: b['speechSpeed'] } : {}),
        ...(typeof b['vadBargeInSensitivity'] === 'string'
          ? { vadBargeInSensitivity: b['vadBargeInSensitivity'] as VadSensitivity }
          : {}),
        ...(typeof b['modelTemperature'] === 'number' ? { modelTemperature: b['modelTemperature'] } : {}),
        ...(typeof b['systemPrompt'] === 'string' ? { systemPrompt: b['systemPrompt'] } : {}),
        ...(typeof b['strictStepEnforcement'] === 'boolean'
          ? { strictStepEnforcement: b['strictStepEnforcement'] }
          : {}),
        ...(typeof b['askConfirmationBeforeSubmit'] === 'boolean'
          ? { askConfirmationBeforeSubmit: b['askConfirmationBeforeSubmit'] }
          : {}),
        ...(typeof b['isActive'] === 'boolean' ? { isActive: b['isActive'] } : {}),
      };

      const result = await updateProjectUseCase.execute(
        principal.organizationId,
        projectId,
        updateDto,
        principal.userId
      );

      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });

  // POST /api/v1/projects/:projectId/domains (Registrar origen en allowed_domains)
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/domains',
    access: 'TENANT_SESSION',
    requiredScopes: ['domain:create'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) {
        throw new ValidationError('Parametro :projectId requerido en la ruta');
      }

      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['originPattern'] !== 'string') {
        throw new ValidationError('El campo "originPattern" es obligatorio');
      }

      const result = await createAllowedDomainUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        originPattern: b['originPattern'],
        allowLocalhostDev: Boolean(b['allowLocalhostDev']),
        createdByUserId: principal.userId,
      });

      if (!result.ok) {
        throw result.error;
      }
      return { status: 201, body: result.value };
    }),
  });

  // DELETE /api/v1/projects/:projectId/domains/:domainId (Eliminar origen de allowed_domains)
  router.register({
    method: 'DELETE',
    path: '/api/v1/projects/:projectId/domains/:domainId',
    access: 'TENANT_SESSION',
    requiredScopes: ['domain:delete'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      const domainId = getRouteParam(req.path, 'domains');
      if (!projectId || !domainId) {
        throw new ValidationError('Parametros :projectId y :domainId requeridos en la ruta');
      }

      const result = await deleteAllowedDomainUseCase.execute(
        principal.organizationId,
        projectId,
        domainId,
        principal.userId
      );

      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });

  // POST /api/v1/projects/:projectId/keys (Crear clave adicional)
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/keys',
    access: 'TENANT_SESSION',
    requiredScopes: ['apikey:create'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) {
        throw new ValidationError('Parametro :projectId requerido en la ruta');
      }

      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['name'] !== 'string' || (b['keyType'] !== 'pk' && b['keyType'] !== 'sk')) {
        throw new ValidationError('Los campos "name" y "keyType" (pk|sk) son obligatorios');
      }

      const result = await createApiKeyUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        name: b['name'],
        keyType: b['keyType'] as ApiKeyType,
        environment: (b['environment'] as ProjectEnvironment) ?? 'LIVE',
        scopes: Array.isArray(b['scopes']) ? (b['scopes'] as string[]) : [],
        createdByUserId: principal.userId,
      });

      if (!result.ok) {
        throw result.error;
      }
      return { status: 201, body: result.value };
    }),
  });

  // POST /api/v1/projects/:projectId/keys/rotate (Rotar clave con ventana de gracia)
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/keys/rotate',
    access: 'TENANT_SESSION',
    requiredScopes: ['apikey:rotate'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) {
        throw new ValidationError('Parametro :projectId requerido en la ruta');
      }

      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['apiKeyId'] !== 'string') {
        throw new ValidationError('El campo "apiKeyId" es obligatorio para rotar una clave');
      }

      const result = await rotateApiKeyUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        apiKeyId: b['apiKeyId'],
        gracePeriodHours: typeof b['gracePeriodHours'] === 'number' ? b['gracePeriodHours'] : 24,
        createdByUserId: principal.userId,
      });

      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });

  // DELETE /api/v1/projects/:projectId/keys/:keyId (Revocar clave inmediatamente)
  router.register({
    method: 'DELETE',
    path: '/api/v1/projects/:projectId/keys/:keyId',
    access: 'TENANT_SESSION',
    requiredScopes: ['apikey:revoke'],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      const keyId = getRouteParam(req.path, 'keys');
      if (!projectId || !keyId) {
        throw new ValidationError('Parametros :projectId y :keyId requeridos en la ruta');
      }

      const result = await revokeApiKeyUseCase.execute(
        principal.organizationId,
        projectId,
        keyId,
        principal.userId
      );

      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });

  // POST /api/v1/sdk/handshake (Punto de admision y enlace seguro del SDK Web)
  router.register({
    method: 'POST',
    path: '/api/v1/sdk/handshake',
    // Nivel SDK_HANDSHAKE y NO PUBLIC: el borde del transporte comprueba la presencia del encabezado
    // Origin antes de ejecutar el manejador, de modo que una peticion sin origen declarado se rechaza
    // con 403 sin llegar a tocar el caso de uso. El manejador sigue validando el origen contra
    // allowed_domains —esa es la comprobacion profunda—, pero clasificar la ruta como PUBLIC dejaba
    // esa primera barrera desactivada y contradecia el diseno de niveles de acceso del transporte.
    access: 'SDK_HANDSHAKE',
    requiredScopes: [],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const pubKey = (req.headers['x-oa-publishable-key'] as string) ?? (b['publishableKey'] as string);
      const origin = (req.headers['origin'] as string) ?? (req.headers['referer'] as string);
      const projectId = (req.headers['x-oa-project-id'] as string) ?? (b['projectId'] as string);

      if (!pubKey || !origin || !projectId) {
        throw new ValidationError(
          'Cabeceras o campos obligatorios faltantes: Publishable Key, Origin y Project ID'
        );
      }

      const result = await validateSdkHandshakeUseCase.execute({
        publishableKey: pubKey,
        origin,
        projectId,
        clientIp: req.clientIp,
        endUserConsentGranted: Boolean(b['endUserConsentGranted']),
        ...(typeof b['externalEndUserId'] === 'string'
          ? { externalEndUserId: b['externalEndUserId'] }
          : {}),
      });

      if (!result.ok) {
        throw result.error;
      }
      return { status: 200, body: result.value };
    }),
  });
}
