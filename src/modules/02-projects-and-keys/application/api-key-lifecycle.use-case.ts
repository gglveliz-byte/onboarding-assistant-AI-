/**
 * @archivo src/modules/02-projects-and-keys/application/api-key-lifecycle.use-case.ts
 * @modulo 02-projects-and-keys (Ciclo de Vida de Claves de API: Emision, Rotacion y Validacion)
 * @proposito
 *   Implementa la logica de emision de claves criptograficas (`pk_live_` / `sk_live_`),
 *   rotacion segura con ventana de gracia para evitar caidas en despliegues distribuidos,
 *   revocacion inmediata e indexacion en memoria sub-milisegundo. Aplica descarte local por
 *   checksum CRC32 para evitar computo y consultas a base de datos ante claves adulteradas.
 *
 * @resumen_contenido
 *   - `CreateApiKeyUseCase`: Generacion CSPRNG y persistencia exclusiva de digest SHA-256.
 *   - `RotateApiKeyUseCase`: Rotacion atómica con `grace_period_ends_at` (0h, 1h, 24h, 72h).
 *   - `RevokeApiKeyImmediatelyUseCase`: Ingestion de revocacion en BD y descarte de cache.
 *   - `ValidateSecretApiKeyUseCase`: Validacion de cabecera Bearer, CRC32, expiracion y scopes.
 *
 * @dependencias_internas
 *   - `@shared/infrastructure/database/rls-pool.ts`: Transacciones multi-tenant RLS.
 *   - `@shared/kernel/api-key.util.ts`: Formato oficial, CSPRNG y verificacion CRC32.
 *   - `@shared/kernel/crypto.util.ts`: Hashing SHA-256 e igualdad en tiempo constante.
 *   - `@shared/kernel/result-and-errors.ts`: Errores Unauthorized, Forbidden, NotFound.
 *   - `@shared/ports/core-modules.ports.ts`: Contrato oficial SecretKeyValidationSuccess.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `api_keys`.
 *   - Redis: `oa:apikey:sha256:<hash>`.
 */

import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { ApiKeyUtils } from '@shared/kernel/api-key.util';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  Result,
  toAppError,
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { SecretKeyValidationSuccess } from '@shared/ports/core-modules.ports';
import { ApiKeyEntity, CreateApiKeyInput, RotateApiKeyInput } from '../domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../infrastructure/postgres-projects-keys.repository';

/** Resultado de la creacion de una clave de API con entrega unica de la clave cruda. */
export interface GeneratedApiKeyDto {
  readonly apiKey: ApiKeyEntity;
  readonly rawKey: string;
}

/** Resultado de una rotacion de clave con la clave nueva cruda y la clave anterior actualizada. */
export interface RotateApiKeyResultDto {
  readonly oldKey: ApiKeyEntity;
  readonly newKey: ApiKeyEntity;
  readonly newRawKey: string;
}

/**
 * Caso de uso para emitir una nueva clave de API.
 */
export class CreateApiKeyUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(input: CreateApiKeyInput): Promise<Result<GeneratedApiKeyDto, AppError>> {
    try {
      const txCtx = {
        organizationId: input.organizationId,
        ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
      };

      const result = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, input.projectId);
        if (!project || project.organizationId !== input.organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${input.projectId}`);
        }

        const projectShortId = project.id.replace(/-/g, '').slice(0, 6).toLowerCase();
        const keyEnv = (input.environment.toLowerCase() === 'test' ? 'test' : 'live') as 'live' | 'test';

        // 1. Generar clave cruda con formato oficial y checksum CRC32
        const generated = ApiKeyUtils.generateApiKeyWithChecksum(input.keyType, keyEnv, projectShortId);

        // 2. Persistir unicamente los metadatos y el hash SHA-256
        const apiKey = await this.repository.createApiKey(
          client,
          input,
          generated.sha256Hash,
          generated.prefix,
          generated.lastFour
        );

        return { apiKey, rawKey: generated.rawKey };
      });
      return Result.ok(result);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para rotar una clave de API manteniendo una ventana de gracia opcional.
 */
export class RotateApiKeyUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(input: RotateApiKeyInput): Promise<Result<RotateApiKeyResultDto, AppError>> {
    const hours = Math.max(0, Math.min(input.gracePeriodHours, 72));
    const gracePeriodEndsAt = new Date(Date.now() + hours * 3600 * 1000);

    try {
      const txCtx = {
        organizationId: input.organizationId,
        ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
      };

      const result = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, input.projectId);
        if (!project || project.organizationId !== input.organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${input.projectId}`);
        }

        // Buscar la clave a rotar
        const keys = await this.repository.listApiKeysByProject(client, input.projectId);
        const oldKey = keys.find((k) => k.id === input.apiKeyId);
        if (!oldKey || oldKey.organizationId !== input.organizationId) {
          throw new NotFoundError(`Clave de API a rotar no encontrada: ${input.apiKeyId}`);
        }

        if (oldKey.revokedAt) {
          throw new ValidationError('No se puede rotar una clave de API que ya se encuentra revocada');
        }

        const projectShortId = project.id.replace(/-/g, '').slice(0, 6).toLowerCase();
        const keyEnv = (oldKey.environment.toLowerCase() === 'test' ? 'test' : 'live') as 'live' | 'test';

        // 1. Generar la clave de reemplazo
        const generated = ApiKeyUtils.generateApiKeyWithChecksum(oldKey.keyType, keyEnv, projectShortId);

        // 2. Ejecutar rotacion atómica
        const { oldKey: updatedOld, newKey: createdNew } = await this.repository.rotateApiKey(
          client,
          oldKey.id,
          {
            organizationId: input.organizationId,
            projectId: input.projectId,
            name: `${oldKey.name} (Rotada)`,
            keyType: oldKey.keyType,
            environment: oldKey.environment,
            scopes: oldKey.scopes,
            ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          },
          generated.sha256Hash,
          generated.prefix,
          generated.lastFour,
          gracePeriodEndsAt
        );

        return {
          oldKey: updatedOld,
          newKey: createdNew,
          newRawKey: generated.rawKey,
        };
      });
      return Result.ok(result);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para revocar inmediatamente una clave de API.
 */
export class RevokeApiKeyImmediatelyUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(
    organizationId: string,
    projectId: string,
    apiKeyId: string,
    revokedByUserId?: string
  ): Promise<Result<{ readonly revoked: boolean }, AppError>> {
    try {
      const txCtx = {
        organizationId,
        ...(revokedByUserId ? { userId: revokedByUserId } : {}),
      };

      const revoked = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, projectId);
        if (!project || project.organizationId !== organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${projectId}`);
        }
        return this.repository.revokeApiKey(client, apiKeyId, revokedByUserId);
      });
      return Result.ok({ revoked });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para validar una clave secreta (`sk_live_...` o `sk_test_...`) presentada en backend.
 */
export class ValidateSecretApiKeyUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(
    rawSecretKey: string,
    requiredScope?: string
  ): Promise<Result<SecretKeyValidationSuccess, AppError>> {
    // 1. Verificacion local del checksum CRC32 (sin base de datos ni Redis)
    const isValidFormat = ApiKeyUtils.verifyApiKeyChecksum(rawSecretKey);
    if (!isValidFormat) {
      return Result.fail(new UnauthorizedError('Clave de API malformada o checksum CRC32 invalido'));
    }

    // 2. Parseo estructural de la clave
    const parsed = ApiKeyUtils.parseApiKey(rawSecretKey);
    if (!parsed || parsed.type !== 'sk') {
      return Result.fail(
        new ValidationError('Se esperaba una clave secreta de backend (sk_...) pero se presento una clave publica')
      );
    }

    // 3. Calculo de digest SHA-256
    const keyHash = CryptoUtils.sha256Hex(rawSecretKey);

    try {
      // 4. Resolucion de identidad ANTES del contexto de inquilino, y lectura de la clave DENTRO de ese
      // contexto. La politica de aislamiento de `api_keys` exige conocer la organizacion propietaria
      // para leer la fila, y solo se conoce tras resolverla: leer por la via sin contexto devolvia cero
      // filas bajo el rol de aplicacion y dejaba la autenticacion inoperante.
      const owner = await this.rlsPool.withClient((client) => this.repository.resolveApiKeyOwnerByHash(client, keyHash));
      const apiKey =
        owner === null
          ? null
          : await this.rlsPool.runInTenantTransaction({ organizationId: owner.organizationId }, (client) =>
              this.repository.getApiKeyByHash(client, keyHash, owner.organizationId)
            );

      if (!apiKey) {
        return Result.fail(new UnauthorizedError('Clave de API inexistente o desconocida'));
      }

      // 5. Verificacion criptografica de igualdad en tiempo constante
      const hashMatches = CryptoUtils.timingSafeEqualHex(apiKey.keyHash, keyHash);
      if (!hashMatches) {
        return Result.fail(new UnauthorizedError('Fallo en la verificacion de integridad de la clave'));
      }

      // 6. Comprobar revocacion
      if (apiKey.revokedAt !== null) {
        return Result.fail(new UnauthorizedError('La clave de API ha sido revocada'));
      }

      // 7. Comprobar expiracion o fin del periodo de gracia
      const now = new Date();
      if (apiKey.expiresAt !== null && now > apiKey.expiresAt) {
        return Result.fail(new UnauthorizedError('La clave de API ha expirado'));
      }

      if (apiKey.gracePeriodEndsAt !== null && now > apiKey.gracePeriodEndsAt) {
        return Result.fail(
          new UnauthorizedError('El periodo de gracia de esta clave de API ha finalizado; use la clave rotada')
        );
      }

      // 8. Comprobar scopes si se requiere alguno
      if (requiredScope && !apiKey.scopes.includes(requiredScope) && !apiKey.scopes.includes('admin:all')) {
        return Result.fail(
          new ForbiddenError(`La clave de API carece del permiso requerido: ${requiredScope}`, {
            details: {
              requiredScope,
              grantedScopes: apiKey.scopes,
            },
          })
        );
      }

      return Result.ok({
        ok: true,
        organizationId: apiKey.organizationId,
        projectId: apiKey.projectId,
        apiKeyId: apiKey.id,
        scopes: apiKey.scopes,
        environment: apiKey.environment,
      });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
