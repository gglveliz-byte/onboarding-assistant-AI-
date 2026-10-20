/**
 * @archivo src/modules/02-projects-and-keys/end-user-voice-consent.manifest.ts
 * @modulo 02-projects-and-keys (API Publica de Certificacion de Consentimiento de Voz)
 * @proposito
 *   Registra `POST /api/v1/public/end-user-consents`, el unico punto de entrada para que el
 *   sistema del cliente B2B certifique con su clave secreta `sk_live_...` el consentimiento
 *   de voz de un usuario final. Se mantiene separado de `projects-keys.manifest.ts` porque ese
 *   archivo esta en el limite critico de 500 lineas y la regla global prohibe agregarle lineas.
 *
 * @resumen_contenido
 *   - Funcion `registerEndUserVoiceConsentModule()`: instancia repositorio, validador de clave
 *     secreta y caso de uso, y publica la ruta publica.
 *   - Manejador HTTP con validacion estricta del cuerpo y del encabezado `Authorization`.
 *
 * @dependencias_internas
 *   - `DependencyContainer`, `DI_TOKENS` (@shared/container/di-container.ts).
 *   - `HttpRouterRegistry`, `HttpRequestLike`, `HttpHandlerResult` (@shared/infrastructure/http/http-server.types.ts).
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `PostgresProjectsKeysRepository` (./infrastructure/postgres-projects-keys.repository.ts).
 *   - `ValidateSecretApiKeyUseCase` (./application/api-key-lifecycle.use-case.ts).
 *   - `RecordEndUserVoiceConsentUseCase` (./application/end-user-voice-consent.use-case.ts).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `end_user_voice_consents`, `legal_documents`.
 *   - Redis: cache de validacion de claves de API.
 */

import type { DependencyContainer } from '@shared/container/di-container';
import { DI_TOKENS } from '@shared/container/di-container';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRouteHandler,
  HttpRequestLike,
  HttpRouterRegistry,
} from '@shared/infrastructure/http/http-server.types';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { UnauthorizedError, ValidationError } from '@shared/kernel/result-and-errors';
import { PostgresProjectsKeysRepository } from './infrastructure/postgres-projects-keys.repository';
import { ValidateSecretApiKeyUseCase } from './application/api-key-lifecycle.use-case';
import { RecordEndUserVoiceConsentUseCase } from './application/end-user-voice-consent.use-case';

/** Envoltorio de manejador para compatibilidad de tipos con HttpRouteRegistration. */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/**
 * Registra la API publica de certificacion de consentimiento de voz de usuarios finales.
 *
 * @param container - Contenedor con el pool RLS y el cliente Redis.
 * @param router - Registro HTTP donde se publica la ruta.
 */
export function registerEndUserVoiceConsentModule(
  container: DependencyContainer,
  router: HttpRouterRegistry
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;

  const repository = new PostgresProjectsKeysRepository(redisClient);
  const validateSecretKeyUseCase = new ValidateSecretApiKeyUseCase(rlsPool, repository);
  const recordConsentUseCase = new RecordEndUserVoiceConsentUseCase(rlsPool, validateSecretKeyUseCase);

  // POST /api/v1/public/end-user-consents (certificacion B2B del consentimiento de un usuario final)
  router.register({
    method: 'POST',
    path: '/api/v1/public/end-user-consents',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '02-projects-and-keys',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const authorization = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const headerSecret = typeof req.headers['x-oa-secret-key'] === 'string' ? req.headers['x-oa-secret-key'].trim() : '';
      const secretKey = bearer || headerSecret;
      if (secretKey.length === 0) {
        throw new UnauthorizedError('Se requiere una clave secreta sk_... en Authorization: Bearer o X-OA-Secret-Key.');
      }

      if (typeof body['externalEndUserId'] !== 'string') {
        throw new ValidationError('`externalEndUserId` es obligatorio y debe ser texto.', ['externalEndUserId']);
      }
      if (typeof body['consentGranted'] !== 'boolean') {
        throw new ValidationError('`consentGranted` es obligatorio y debe ser booleano.', ['consentGranted']);
      }
      if (body['grantedAt'] !== undefined && typeof body['grantedAt'] !== 'string') {
        throw new ValidationError('`grantedAt` debe ser una fecha ISO 8601 en texto.', ['grantedAt']);
      }
      if (body['projectId'] !== undefined && typeof body['projectId'] !== 'string') {
        throw new ValidationError('`projectId` debe ser texto.', ['projectId']);
      }
      const evidence = body['evidence'];
      if (evidence !== undefined && (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence))) {
        throw new ValidationError('`evidence` debe ser un objeto JSON plano.', ['evidence']);
      }

      const result = await recordConsentUseCase.execute({
        secretKey,
        externalEndUserId: body['externalEndUserId'],
        consentGranted: body['consentGranted'],
        ...(typeof body['grantedAt'] === 'string' ? { grantedAt: body['grantedAt'] } : {}),
        ...(typeof body['projectId'] === 'string' ? { projectId: body['projectId'] } : {}),
        ...(evidence !== undefined ? { evidence: evidence as Record<string, unknown> } : {}),
        clientIp: req.clientIp,
        userAgent: String(req.headers['user-agent'] ?? 'Unknown'),
      });

      return {
        status: 201,
        body: result,
        headers: { 'Cache-Control': 'no-store' },
      };
    }),
  });
}
