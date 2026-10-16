/**
 * @archivo src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest.ts
 * @modulo 03-visual-trainer-and-rag (Manifiesto, Puerto IVisualRagAndPromptPort y Rutas HTTP)
 * @proposito
 *   Manifiesto autonomo del modulo 03. Implementa el puerto oficial `IVisualRagAndPromptPort`
 *   requerido por el gateway de voz (Modulo 05), registra en el contenedor de inyeccion de
 *   dependencias los adaptadores de Mapa RAG y monta las rutas HTTP de publicacion, rollback,
 *   versionado del prompt y context slimming.
 *
 * @resumen_contenido
 *   - Clase `VisualRagAndPromptPortAdapter`: Implementa `IVisualRagAndPromptPort`.
 *   - Funcion `registerVisualTrainerRagModule()`: Registro en DI container y enrutador HTTP.
 *
 * @dependencias_internas
 *   - `@shared/ports/core-modules.ports.ts`: Contrato oficial `IVisualRagAndPromptPort`.
 *   - `@shared/container/di-container.ts`: Contenedor y catalogo de tokens.
 *   - `@shared/infrastructure/http/http-server.types.ts`: Tipos del enrutador HTTP.
 *   - `../domain/rag-map.entities.ts`: Entidades y esquemas de validacion.
 *   - `./application/publish-and-edit-rag-map.use-case.ts`: Casos de uso de mapas.
 *   - `./application/prompt-studio-and-slimming.use-case.ts`: Casos de uso de prompt y slimming.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`, `prompt_versions`, `projects`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

import { DependencyContainer, DI_TOKENS } from '@shared/container/di-container';
import {
  AuthenticatedPrincipal,
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRequestLike,
  HttpRouteHandler,
  HttpRouterRegistry,
} from '@shared/infrastructure/http/http-server.types';
import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { UnauthorizedError, ValidationError } from '@shared/kernel/result-and-errors';
import { PostgresRagMapRepository } from './infrastructure/postgres-rag-map.repository';
import {
  PublishImmutableMapUseCase,
  RollbackFunctionalMapVersionUseCase,
  TrainingElementRepositoryAdapter,
  TrainingElementValidatorAdapter,
} from './application/publish-and-edit-rag-map.use-case';
import {
  SlimContextForRouteUseCase,
  UpdateAssistantPromptUseCase,
} from './application/prompt-studio-and-slimming.use-case';
import { VisualRagAndPromptPortAdapter } from './infrastructure/visual-rag-prompt-port.adapter';

export { VisualRagAndPromptPortAdapter };


function assertPrincipal(ctx: AuthenticatedRequestContext): AuthenticatedPrincipal {
  if (!ctx.principal) {
    throw new UnauthorizedError('Se requiere sesion autenticada');
  }
  return ctx.principal;
}

function getRouteParam(path: string, paramName: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const idx = segments.indexOf(paramName);
  return idx !== -1 && idx + 1 < segments.length ? segments[idx + 1]! : null;
}

function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/**
 * Registra el Modulo 03 en el contenedor de dependencias y monta sus rutas HTTP.
 */
export function registerVisualTrainerRagModule(
  container: DependencyContainer,
  router: HttpRouterRegistry
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;

  const repository = new PostgresRagMapRepository(redisClient);
  const publishMapUseCase = new PublishImmutableMapUseCase(rlsPool, repository);
  const rollbackMapUseCase = new RollbackFunctionalMapVersionUseCase(rlsPool, repository);
  const updatePromptUseCase = new UpdateAssistantPromptUseCase(rlsPool, repository);
  const slimContextUseCase = new SlimContextForRouteUseCase(rlsPool, repository);

  const ragPortAdapter = new VisualRagAndPromptPortAdapter(rlsPool, repository, slimContextUseCase);
  const elementRepoAdapter = new TrainingElementRepositoryAdapter(rlsPool, repository);
  const elementValidatorAdapter = new TrainingElementValidatorAdapter(rlsPool, repository);

  // Registro en DI Container
  container.registerInstance(DI_TOKENS.RagMapQueryPort, ragPortAdapter);
  container.registerInstance(DI_TOKENS.VisualTrainerPort, {
    elementRepository: elementRepoAdapter,
    elementValidator: elementValidatorAdapter,
  });

  // POST /api/v1/projects/:projectId/functional-maps/publish
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/functional-maps/publish',
    access: 'TENANT_SESSION',
    requiredScopes: ['maps:publish'],
    ownerModule: '03-visual-trainer-and-rag',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) throw new ValidationError('Parametro :projectId requerido');

      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await publishMapUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        versionLabel: typeof b['versionLabel'] === 'string' ? b['versionLabel'] : undefined,
        sourceMode: (b['sourceMode'] as any) ?? 'VISUAL_TRAINER',
        elements: b['elements'],
        publishedByUserId: principal.userId,
      });

      if (!result.ok) throw result.error;
      return { status: 201, body: result.value };
    }),
  });

  // POST /api/v1/projects/:projectId/functional-maps/rollback
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/functional-maps/rollback',
    access: 'TENANT_SESSION',
    requiredScopes: ['maps:publish'],
    ownerModule: '03-visual-trainer-and-rag',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) throw new ValidationError('Parametro :projectId requerido');

      const b = (req.body ?? {}) as Record<string, unknown>;
      const targetVersion = typeof b['targetVersionNumber'] === 'number' ? b['targetVersionNumber'] : 1;

      const result = await rollbackMapUseCase.execute(
        principal.organizationId,
        projectId,
        targetVersion,
        principal.userId
      );

      if (!result.ok) throw result.error;
      return { status: 200, body: result.value };
    }),
  });

  // PUT /api/v1/projects/:projectId/prompt
  router.register({
    method: 'PUT',
    path: '/api/v1/projects/:projectId/prompt',
    access: 'TENANT_SESSION',
    requiredScopes: ['projects:update'],
    ownerModule: '03-visual-trainer-and-rag',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) throw new ValidationError('Parametro :projectId requerido');

      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await updatePromptUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        systemPrompt: b['systemPrompt'],
        onboardingStepsJson: b['onboardingStepsJson'],
        primaryVoiceModel: b['primaryVoiceModel'],
        fallbackVoiceModel: b['fallbackVoiceModel'],
        modelTemperature: b['modelTemperature'],
        strictStepEnforcement: b['strictStepEnforcement'],
        askConfirmationBeforeSubmit: b['askConfirmationBeforeSubmit'],
        updatedViaChannel: 'DASHBOARD_UI',
        createdByUserId: principal.userId,
      });

      if (!result.ok) throw result.error;
      return { status: 200, body: result.value };
    }),
  });

  // POST /api/v1/projects/:projectId/context/slim
  router.register({
    method: 'POST',
    path: '/api/v1/projects/:projectId/context/slim',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '03-visual-trainer-and-rag',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(ctx);
      const projectId = getRouteParam(req.path, 'projects');
      if (!projectId) throw new ValidationError('Parametro :projectId requerido');

      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await slimContextUseCase.execute({
        organizationId: principal.organizationId,
        projectId,
        routePath: (b['routePath'] as string) ?? '/',
        stepNumber: typeof b['stepNumber'] === 'number' ? b['stepNumber'] : 1,
        viewport: b['viewport'] as any,
        actorUserId: principal.userId,
      });

      if (!result.ok) throw result.error;
      return { status: 200, body: result.value };
    }),
  });
}
