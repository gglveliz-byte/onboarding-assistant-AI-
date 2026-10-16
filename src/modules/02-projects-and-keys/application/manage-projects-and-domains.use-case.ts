/**
 * @archivo src/modules/02-projects-and-keys/application/manage-projects-and-domains.use-case.ts
 * @modulo 02-projects-and-keys (Casos de Uso de Proyectos y Dominios Autorizados)
 * @proposito
 *   Gobierna el ciclo de vida de los proyectos de onboarding interactivo y su lista blanca
 *   de dominios permitidos para el SDK. Aplica validacion estricta de slugs, impide el
 *   registro inseguro de localhost en proyectos de produccion (LIVE) y aprovisiona
 *   automaticamente las claves iniciales (publica y secreta) al crear un proyecto.
 *
 * @resumen_contenido
 *   - `CreateProjectUseCase`: Validacion de slug, creacion transaccional y provision de claves.
 *   - `UpdateProjectUseCase`: Modificacion de parametros de voz, temperatura y guardrails.
 *   - `ListProjectsUseCase` y `GetProjectDetailsUseCase`: Consultas protegidas por RLS.
 *   - `CreateAllowedDomainUseCase`: Reglas de seguridad para orígenes CORS/SDK.
 *   - `DeleteAllowedDomainUseCase`: Revocacion de origenes y sincronizacion en Redis.
 *
 * @dependencias_internas
 *   - `@shared/infrastructure/database/rls-pool.ts`: Aislamiento transaccional RLS.
 *   - `@shared/kernel/api-key.util.ts`: Generacion de claves con formato y CRC32 oficial.
 *   - `@shared/kernel/crypto.util.ts`: Hashing SHA-256.
 *   - `@shared/kernel/result-and-errors.ts`: Errores de dominio (Conflict, Validation, NotFound).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `allowed_domains`, `api_keys`.
 *   - Redis: `oa:proj:<id>:allowed_domains`, `oa:apikey:sha256:<hash>`.
 */

import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { ApiKeyUtils } from '@shared/kernel/api-key.util';
import {
  AppError,
  ConflictError,
  NotFoundError,
  Result,
  toAppError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import {
  AllowedDomainEntity,
  CreateAllowedDomainInput,
  CreateProjectInput,
  ProjectEntity,
  UpdateProjectInput,
} from '../domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../infrastructure/postgres-projects-keys.repository';

/** Expresion regular oficial para formato de slug de proyecto. */
export const PROJECT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Resultado detallado de la creacion de un proyecto con sus claves iniciales. */
export interface CreateProjectResult {
  readonly project: ProjectEntity;
  readonly initialPublishableKey: {
    readonly rawKey: string;
    readonly keyPrefix: string;
    readonly lastFour: string;
  };
  readonly initialSecretKey: {
    readonly rawKey: string;
    readonly keyPrefix: string;
    readonly lastFour: string;
  };
}

/**
 * Caso de uso para crear un proyecto e inicializar sus credenciales criptograficas.
 */
export class CreateProjectUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(input: CreateProjectInput): Promise<Result<CreateProjectResult, AppError>> {
    const slug = input.slug.toLowerCase().trim();

    // 1. Validacion de formato de slug
    if (!PROJECT_SLUG_REGEX.test(slug)) {
      return Result.fail(
        new ValidationError('El slug del proyecto solo puede contener letras minusculas, numeros y guiones', [
          `Valor provisto: ${slug}`,
        ])
      );
    }

    try {
      const txCtx = {
        organizationId: input.organizationId,
        ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
      };

      const result = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        // 2. Comprobar que no exista otro proyecto con el mismo slug en la organizacion
        const existing = await this.repository.getProjectBySlug(client, input.organizationId, slug);
        if (existing) {
          throw new ConflictError(`Ya existe un proyecto con el slug "${slug}" en esta organizacion`, {
            details: { organizationId: input.organizationId, slug },
          });
        }

        // 3. Crear el proyecto
        const project = await this.repository.createProject(client, input);

        // 4. Derivar projectShortId de 6 caracteres Base62 para las claves
        const projectShortId = project.id.replace(/-/g, '').slice(0, 6).toLowerCase();
        const keyEnv = (project.environment.toLowerCase() === 'test' ? 'test' : 'live') as 'live' | 'test';

        // 5. Generar clave publica inicial para el SDK
        const pubKeyGen = ApiKeyUtils.generateApiKeyWithChecksum('pk', keyEnv, projectShortId);
        await this.repository.createApiKey(
          client,
          {
            organizationId: project.organizationId,
            projectId: project.id,
            name: 'Publishable Key Inicial',
            keyType: 'pk',
            environment: project.environment,
            scopes: ['sdk:realtime:read', 'sdk:realtime:execute'],
            ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          },
          pubKeyGen.sha256Hash,
          pubKeyGen.prefix,
          pubKeyGen.lastFour
        );

        // 6. Generar clave secreta inicial para backend
        const secKeyGen = ApiKeyUtils.generateApiKeyWithChecksum('sk', keyEnv, projectShortId);
        await this.repository.createApiKey(
          client,
          {
            organizationId: project.organizationId,
            projectId: project.id,
            name: 'Secret Key Inicial',
            keyType: 'sk',
            environment: project.environment,
            scopes: ['admin:all', 'rag:manage', 'telemetry:read'],
            ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          },
          secKeyGen.sha256Hash,
          secKeyGen.prefix,
          secKeyGen.lastFour
        );

        return {
          project,
          initialPublishableKey: {
            rawKey: pubKeyGen.rawKey,
            keyPrefix: pubKeyGen.prefix,
            lastFour: pubKeyGen.lastFour,
          },
          initialSecretKey: {
            rawKey: secKeyGen.rawKey,
            keyPrefix: secKeyGen.prefix,
            lastFour: secKeyGen.lastFour,
          },
        };
      });

      return Result.ok(result);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para modificar la configuracion de voz o comportamiento del asistente.
 */
export class UpdateProjectUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(
    organizationId: string,
    projectId: string,
    input: UpdateProjectInput,
    userId?: string
  ): Promise<Result<ProjectEntity, AppError>> {
    // Validaciones de limites numericos
    if (input.speechSpeed !== undefined && (input.speechSpeed < 0.5 || input.speechSpeed > 2.0)) {
      return Result.fail(new ValidationError('La velocidad de locucion debe estar entre 0.50 y 2.00'));
    }
    if (input.modelTemperature !== undefined && (input.modelTemperature < 0.0 || input.modelTemperature > 1.0)) {
      return Result.fail(new ValidationError('La temperatura del modelo debe estar entre 0.00 y 1.00'));
    }

    try {
      const txCtx = {
        organizationId,
        ...(userId ? { userId } : {}),
      };

      const updated = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, projectId);
        if (!project || project.organizationId !== organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${projectId}`);
        }
        const res = await this.repository.updateProject(client, projectId, input);
        if (!res) {
          throw new NotFoundError(`Error al actualizar el proyecto: ${projectId}`);
        }
        return res;
      });
      return Result.ok(updated);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para listar proyectos de una organizacion.
 */
export class ListProjectsUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(organizationId: string, userId?: string): Promise<Result<readonly ProjectEntity[], AppError>> {
    try {
      const txCtx = {
        organizationId,
        ...(userId ? { userId } : {}),
      };

      const projects = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        return this.repository.listProjectsByOrg(client, organizationId);
      });
      return Result.ok(projects);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para autorizar origenes de red en el Handshake del SDK.
 */
export class CreateAllowedDomainUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(input: CreateAllowedDomainInput): Promise<Result<AllowedDomainEntity, AppError>> {
    const rawPattern = input.originPattern.trim().toLowerCase();

    // 1. Validar que no sea un esquema peligroso o desconocido
    const isHttp = rawPattern.startsWith('http://');
    const isHttps = rawPattern.startsWith('https://');

    if (!isHttp && !isHttps) {
      return Result.fail(
        new ValidationError('El patron de origen debe comenzar obligatoriamente con https:// o http://', [
          `Patron: ${rawPattern}`,
        ])
      );
    }

    // 2. Control de localhost
    const isLocalhost =
      rawPattern.startsWith('http://localhost') ||
      rawPattern.startsWith('http://127.0.0.1');

    try {
      const txCtx = {
        organizationId: input.organizationId,
        ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
      };

      const domain = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, input.projectId);
        if (!project || project.organizationId !== input.organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${input.projectId}`);
        }

        // Impedir registrar localhost en proyectos LIVE si allowLocalhostDev no esta activo
        if (project.environment === 'LIVE' && isLocalhost && !input.allowLocalhostDev) {
          throw new ValidationError(
            'No se puede autorizar localhost en un proyecto en entorno LIVE sin habilitar allowLocalhostDev',
            [`Entorno: ${project.environment}`, `Patron: ${rawPattern}`]
          );
        }

        return this.repository.createAllowedDomain(client, input);
      });
      return Result.ok(domain);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de uso para revocar un origen de la lista blanca.
 */
export class DeleteAllowedDomainUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresProjectsKeysRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresProjectsKeysRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(
    organizationId: string,
    projectId: string,
    domainId: string,
    userId?: string
  ): Promise<Result<{ readonly deleted: boolean }, AppError>> {
    try {
      const txCtx = {
        organizationId,
        ...(userId ? { userId } : {}),
      };

      const deleted = await this.rlsPool.runInTenantTransaction(txCtx, async (client) => {
        const project = await this.repository.getProjectById(client, projectId);
        if (!project || project.organizationId !== organizationId) {
          throw new NotFoundError(`Proyecto no encontrado: ${projectId}`);
        }
        return this.repository.deleteAllowedDomain(client, domainId, projectId);
      });
      return Result.ok({ deleted });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
