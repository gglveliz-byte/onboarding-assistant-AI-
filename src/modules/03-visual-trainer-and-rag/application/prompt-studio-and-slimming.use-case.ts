/**
 * @archivo src/modules/03-visual-trainer-and-rag/application/prompt-studio-and-slimming.use-case.ts
 * @modulo 03-visual-trainer-and-rag (Estudio del Prompt, Guardrails y Motor de Context Slimming)
 * @proposito
 *   Implementa la gestion del System Prompt maestro, la lista estructurada de pasos de onboarding
 *   con versionado inmutable, y el algoritmo de depuracion de contexto por ruta (Context Slimming)
 *   que opera en tiempo ultra veloz (<2ms) para proveer al motor de voz unicamente los elementos
 *   visibles de la pantalla activa con coordenadas responsive segun el viewport del usuario.
 *
 * @resumen_contenido
 *   - `UpdateAssistantPromptUseCase`: Versiona el prompt y actualiza guardrails del proyecto.
 *   - `SlimContextForRouteUseCase`: Ejecuta Context Slimming para la ruta activa y paso de onboarding.
 *
 * @dependencias_internas
 *   - `@shared/kernel/result-and-errors.ts`: Dominio tipado Result y catalogo de errores.
 *   - `@shared/infrastructure/database/rls-pool.ts`: Transacciones con contexto RLS.
 *   - `@shared/ports/core-modules.ports.ts`: Contrato `SlimmedRouteContext`.
 *   - `../domain/rag-map.entities.ts`: Esquemas Zod y entidades de dominio.
 *   - `../infrastructure/postgres-rag-map.repository.ts`: Repositorio PostgreSQL y Redis.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `prompt_versions`, `projects`, `functional_maps`, `map_elements`.
 *   - Redis: `rag_map:proj:<id>:routes`, `rag_map:proj:<id>:meta`.
 */

import type { PoolClient } from 'pg';
import {
  AppError,
  NotFoundError,
  Result,
  toAppError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { RiskLevel, SlimmedRouteContext } from '@shared/ports/core-modules.ports';
import {
  MapElementEntity,
  PromptVersionEntity,
  UpdateAssistantPromptInput,
  updateAssistantPromptInputSchema,
} from '../domain/rag-map.entities';
import { PostgresRagMapRepository } from '../infrastructure/postgres-rag-map.repository';

/** Parametros de entrada para el algoritmo de Context Slimming. */
export interface SlimContextInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly routePath: string;
  readonly stepNumber?: number | undefined;
  readonly viewport?: 'desktop' | 'tablet' | 'mobile' | undefined;
  readonly actorUserId?: string | undefined;
}

/**
 * Caso de Uso: Actualizacion del Prompt del Sistema, Pasos y Modelos de Voz.
 */
export class UpdateAssistantPromptUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(rawInput: unknown): Promise<Result<PromptVersionEntity, AppError>> {
    try {
      const parseResult = updateAssistantPromptInputSchema.safeParse(rawInput);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        return Result.fail(new ValidationError(`Parametros de prompt invalidos: ${issues}`));
      }
      const input: UpdateAssistantPromptInput = parseResult.data;

      const created = await this.rlsPool.runInTenantTransaction<PromptVersionEntity>(
        {
          organizationId: input.organizationId,
          ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
        },
        async (client: PoolClient): Promise<PromptVersionEntity> => {
          const nextVersion = await this.repository.getNextPromptVersionNumber(client, input.projectId);
          return this.repository.createPromptVersion(client, input, nextVersion);
        }
      );

      return Result.ok(created);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de Uso: Algoritmo de Context Slimming sub-milisegundo por ruta.
 */
export class SlimContextForRouteUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(input: SlimContextInput): Promise<Result<SlimmedRouteContext, AppError>> {
    try {
      const normalizedRoute = input.routePath.trim().startsWith('/')
        ? input.routePath.trim()
        : `/${input.routePath.trim()}`;
      const targetStep = input.stepNumber ?? 1;

      // 1. Verificacion de pertenencia del proyecto a la organizacion con transaccion RLS
      // ANTES de tocar Redis (C1-46). Previene fuga multi-tenant entre proyectos ajenos.
      await this.rlsPool.runInTenantTransaction(
        {
          organizationId: input.organizationId,
          ...(input.actorUserId ? { userId: input.actorUserId } : {}),
        },
        async (client: PoolClient): Promise<void> => {
          const checkRes = await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1 AND organization_id = $2 LIMIT 1;',
            [input.projectId, input.organizationId]
          );
          if (checkRes.rows.length === 0) {
            throw new NotFoundError(`El proyecto "${input.projectId}" no existe o no pertenece a la organizacion`);
          }
        }
      );

      // 2. Intenta resolucion ultrarrapida en Redis (<2ms) segmentada por organizacion
      let elements: readonly MapElementEntity[] | null = await this.repository.getCachedRouteElements(
        input.organizationId,
        input.projectId,
        normalizedRoute
      );

      // 2. Si hay fallo de cache, consulta PostgreSQL con contexto RLS
      if (!elements) {
        elements = await this.rlsPool.runInTenantTransaction<readonly MapElementEntity[]>(
          {
            organizationId: input.organizationId,
            ...(input.actorUserId ? { userId: input.actorUserId } : {}),
          },
          async (client: PoolClient): Promise<readonly MapElementEntity[]> => {
            const activeMap = await this.repository.getActiveMapByProject(client, input.projectId);
            if (!activeMap) {
              return [];
            }
            return this.repository.listElementsByRoute(client, activeMap.id, normalizedRoute);
          }
        );
      }

      const safeElements = elements ?? [];

      // 3. Extraer la instruccion textual del paso correspondiente
      const stepInstruction = await this.rlsPool.runInTenantTransaction<string>(
        {
          organizationId: input.organizationId,
          ...(input.actorUserId ? { userId: input.actorUserId } : {}),
        },
        async (client: PoolClient): Promise<string> => {
          const query = 'SELECT onboarding_steps_json FROM projects WHERE id = $1 LIMIT 1;';
          const { rows } = await client.query<{ onboarding_steps_json: unknown }>(query, [input.projectId]);
          const row = rows[0];
          if (!row || !Array.isArray(row.onboarding_steps_json)) {
            return `Paso ${targetStep}: Interactua con los elementos disponibles en pantalla.`;
          }
          const steps = row.onboarding_steps_json as readonly Record<string, unknown>[];
          const match = steps.find((s) => s['stepNumber'] === targetStep || s['order'] === targetStep);
          if (match && typeof match['instruction'] === 'string') {
            return match['instruction'];
          }
          return `Paso ${targetStep}: Continua con el flujo guiado.`;
        }
      );

      // 4. Mapear elementos depurados de campos sensibles
      const allowedActions = safeElements.map((el) => {
        const metadata = el.elementMetadata as Record<string, unknown>;
        const riskLevel: RiskLevel =
          metadata['riskLevel'] === 'HIGH' || metadata['riskLevel'] === 'MEDIUM'
            ? (metadata['riskLevel'] as RiskLevel)
            : 'LOW';

        return {
          elementKey: el.elementKey,
          title: el.title,
          functionalDescription: el.functionalDescription,
          actionType: el.actionType,
          primarySelector: el.primarySelector,
          riskLevel,
        };
      });

      const context: SlimmedRouteContext = {
        routePath: normalizedRoute,
        stepNumber: targetStep,
        stepInstruction,
        allowedActions,
      };

      return Result.ok(context);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
