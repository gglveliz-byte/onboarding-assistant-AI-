/**
 * @archivo src/modules/07-public-commercial-and-sandbox/public-commercial.manifest.ts
 * @modulo 07-public-commercial-and-sandbox (Endpoints Públicos Comerciales, Demo y Sandbox)
 * @proposito
 *   Manifiesto central del Módulo 07. Registra en `DependencyContainer` los casos de uso
 *   públicos y monta en `HttpRouterRegistry` los endpoints comerciales consumidos sin autenticación:
 *   matriz oficial Whop, inicio de sesiones efímeras de demostración y simulador del Sandbox.
 *
 * @resumen_contenido
 *   - Función `registerPublicCommercialModule()`: Registro en DI Container y HttpRouterRegistry.
 *   - Endpoints REST: `GET /api/v1/public/pricing-matrix`, `POST /api/v1/public/demo-session`,
 *     `POST /api/v1/public/sandbox/simulate-action`.
 *   - El emisor de sesiones de demo lee la configuración gobernable (`readPublicDemoConfig`) publicada
 *     por el Módulo 06; las rutas de gobierno de esa config viven en el módulo de gobierno.
 *
 * @dependencias_internas
 *   - `DependencyContainer`, `DI_TOKENS` (@shared/container/di-container.ts).
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `HttpRouterRegistry`, `HttpRequestLike`, `AuthenticatedRequestContext` (@shared/infrastructure/http/http-server.types.ts).
 *   - Casos de uso de `public-demo-and-pricing.use-case.ts`.
 *   - Esquemas de validación de `public-commercial.entities.ts`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`.
 *   - Redis: `oa:demo:ip:<sha256(ip)>`, `oa:demo:session:<sessionId>`, `oa:demo:config` (gobierno de la demo).
 */

import type { DependencyContainer } from '../../shared/container/di-container';
import { DI_TOKENS } from '../../shared/container/di-container';
import type { RlsDatabasePool } from '../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../shared/infrastructure/redis/redis-cluster.client';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRouteHandler,
  HttpRouterRegistry,
  HttpRequestLike,
} from '../../shared/infrastructure/http/http-server.types';
import {
  GetPublicPricingMatrixUseCase,
  CreatePublicLiveDemoSessionUseCase,
  ValidateSandboxActionUseCase,
} from './application/public-demo-and-pricing.use-case';
import {
  demoSessionRequestSchema,
  sandboxSimulateActionSchema,
} from './domain/public-commercial.entities';

/** Envoltorio de manejador para compatibilidad de tipos con HttpRouteRegistration. */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/**
 * Registra el Módulo 07 en el contenedor de dependencias y monta sus endpoints públicos.
 */
export function registerPublicCommercialModule(
  container: DependencyContainer,
  router: HttpRouterRegistry,
  options?: {
    turnstileSecretKey?: string;
    isProduction?: boolean;
    websocketBaseUrl?: string;
  }
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.tryGet(DI_TOKENS.RedisClusterClient) as RedisClusterClient | undefined;

  const getPricingMatrixUseCase = new GetPublicPricingMatrixUseCase({ rlsPool });
  const createDemoSessionUseCase = new CreatePublicLiveDemoSessionUseCase({
    redisClient,
    turnstileSecretKey: options?.turnstileSecretKey,
    isProduction: options?.isProduction,
    websocketBaseUrl: options?.websocketBaseUrl,
  });
  const validateSandboxActionUseCase = new ValidateSandboxActionUseCase();

  // ===========================================================================
  // RUTAS HTTP REST /api/v1/public/*
  // ===========================================================================

  // GET /api/v1/public/pricing-matrix
  router.register({
    method: 'GET',
    path: '/api/v1/public/pricing-matrix',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '07-public-commercial-and-sandbox',
    requiresRawBody: false,
    handler: wrapHandler(async (): Promise<HttpHandlerResult> => {
      const res = await getPricingMatrixUseCase.execute();
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });

  // POST /api/v1/public/demo-session
  router.register({
    method: 'POST',
    path: '/api/v1/public/demo-session',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '07-public-commercial-and-sandbox',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const clientIp = ctx.clientIp && ctx.clientIp.trim().length > 0 ? ctx.clientIp.trim() : '127.0.0.1';
      const parsedBody = demoSessionRequestSchema.parse(req.body);
      const res = await createDemoSessionUseCase.execute(clientIp, parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 201, body: res.value };
    }),
  });

  // POST /api/v1/public/sandbox/simulate-action
  router.register({
    method: 'POST',
    path: '/api/v1/public/sandbox/simulate-action',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '07-public-commercial-and-sandbox',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const parsedBody = sandboxSimulateActionSchema.parse(req.body);
      const res = validateSandboxActionUseCase.execute(parsedBody);
      if (!res.ok) {
        throw res.error;
      }
      return { status: 200, body: res.value };
    }),
  });
}
