/**
 * @archivo src/modules/03-visual-trainer-and-rag/application/publish-and-edit-rag-map.use-case.ts
 * @modulo 03-visual-trainer-and-rag (Publicacion Inmutable RFC 8785 y Rollback del Mapa RAG)
 * @proposito
 *   Gobierna el ciclo de vida de los Mapas Funcionales: validacion de esquemas Zod,
 *   canonicalizacion determinista RFC 8785 (JCS), sellado criptografico con SHA-256,
 *   persistencia transaccional con RLS, precalentamiento en Redis y reversion rapida (Rollback).
 *   Implementa ademas los puertos de persistencia y validacion de elementos del navegador efimero.
 *
 * @resumen_contenido
 *   - `PublishImmutableMapUseCase`: Publica una nueva version inmutable N+1 con sello SHA-256.
 *   - `RollbackFunctionalMapVersionUseCase`: Revierte la version activa en tiempo constante (<50ms).
 *   - `TrainingElementRepositoryAdapter`: Implementa `TrainingElementRepository`.
 *   - `TrainingElementValidatorAdapter`: Implementa `TrainingElementValidator`.
 *
 * @dependencias_internas
 *   - `@shared/kernel/crypto.util.ts`: Canonicalizacion RFC 8785 y digest SHA-256.
 *   - `@shared/kernel/result-and-errors.ts`: Dominio tipado Result y catalogo de errores.
 *   - `@shared/infrastructure/database/rls-pool.ts`: Transacciones con contexto RLS.
 *   - `../domain/rag-map.entities.ts`: Esquemas Zod y entidades de dominio.
 *   - `../infrastructure/postgres-rag-map.repository.ts`: Repositorio PostgreSQL y Redis.
 *   - `./training-session.types.ts`: Contratos del navegador de entrenamiento.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`, `projects`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

import type { PoolClient } from 'pg';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import {
  AppError,
  ConflictError,
  NotFoundError,
  Result,
  toAppError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import {
  FunctionalMapEntity,
  MapElementEntity,
  MapElementInput,
  PublishFunctionalMapInput,
  publishFunctionalMapInputSchema,
} from '../domain/rag-map.entities';
import { PostgresRagMapRepository } from '../infrastructure/postgres-rag-map.repository';
import type {
  CapturedElementMetadata,
  ElementBoundingBox,
} from '../infrastructure/dom-overlay-injected-agent';
import type {
  TrainingElementRepository,
  TrainingElementValidator,
} from './training-session.types';

/** Resultado de la publicacion del mapa funcional. */
export interface PublishMapResult {
  readonly map: FunctionalMapEntity;
  readonly elements: readonly MapElementEntity[];
  readonly isIdempotentMatch: boolean;
}

/**
 * Caso de Uso: Publicacion de una version inmutable del Mapa Funcional con sello SHA-256.
 */
export class PublishImmutableMapUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(rawInput: unknown): Promise<Result<PublishMapResult, AppError>> {
    try {
      // 1. Validacion estricta de esquema Zod
      const parseResult = publishFunctionalMapInputSchema.safeParse(rawInput);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        return Result.fail(new ValidationError(`Esquema de mapa funcional invalido: ${issues}`));
      }
      const input: PublishFunctionalMapInput = parseResult.data;

      // 2. Canonicalizacion determinista RFC 8785 y computo de hash SHA-256
      const canonicalPayload = {
        projectId: input.projectId,
        elements: input.elements.map((el) => ({
          elementKey: el.elementKey,
          urlRoutePattern: el.urlRoutePattern,
          title: el.title,
          functionalDescription: el.functionalDescription,
          isActionable: el.isActionable,
          actionType: el.actionType,
          stepOrderHint: el.stepOrderHint ?? null,
          primarySelector: el.primarySelector,
          accessibilitySelector: el.accessibilitySelector ?? null,
          structuralCssSelector: el.structuralCssSelector ?? null,
          xpathFallback: el.xpathFallback ?? null,
          selectorStabilityScore: el.selectorStabilityScore,
          desktopBbox: el.desktopBbox,
          tabletBbox: el.tabletBbox,
          mobileBbox: el.mobileBbox,
          elementMetadata: el.elementMetadata,
        })),
      };

      const { canonicalJson, sha256Hash } = CryptoUtils.computeCanonicalMapSha256(canonicalPayload);

      // 3. Ejecucion transaccional con RLS
      const result = await this.rlsPool.runInTenantTransaction<{
        readonly map: FunctionalMapEntity;
        readonly elements: readonly MapElementEntity[];
        readonly isIdempotentMatch: boolean;
      }>(
        {
          organizationId: input.organizationId,
          ...(input.publishedByUserId ? { userId: input.publishedByUserId } : {}),
        },
        async (client: PoolClient) => {
          // 3.1 Comprobar si ya existe un mapa identico (idempotencia perfecta)
          const existing = await this.repository.getMapByContentHash(client, input.projectId, sha256Hash);
          if (existing) {
            await this.repository.setActiveMap(client, input.projectId, existing.id);
            const elements = await this.repository.listElementsByMap(client, existing.id);
            return { map: existing, elements, isIdempotentMatch: true };
          }

          // 3.2 Crear nueva version inmutable N + 1
          const nextVersion = await this.repository.getNextMapVersionNumber(client, input.projectId);
          const map = await this.repository.createFunctionalMap(client, {
            organizationId: input.organizationId,
            projectId: input.projectId,
            versionNumber: nextVersion,
            versionLabel: input.versionLabel,
            sourceMode: input.sourceMode,
            canonicalMapJson: JSON.parse(canonicalJson) as Record<string, unknown>,
            contentSha256Hash: sha256Hash,
            totalElementsCount: input.elements.length,
            publishedByUserId: input.publishedByUserId,
          });

          // 3.3 Insertar elementos asociados
          const elements = await this.repository.insertMapElements(
            client,
            input.organizationId,
            input.projectId,
            map.id,
            input.elements
          );

          // 3.4 Conmutar mapa activo en PostgreSQL
          await this.repository.setActiveMap(client, input.projectId, map.id);

          return { map, elements, isIdempotentMatch: false };
        }
      );

      // 4. Precalentar Redis para resolucion sub-milisegundo (<2ms)
      const elementsByRoute: Record<string, MapElementEntity[]> = {};
      const routesSet = new Set<string>();

      for (const el of result.elements) {
        routesSet.add(el.urlRoutePattern);
        if (!elementsByRoute[el.urlRoutePattern]) {
          elementsByRoute[el.urlRoutePattern] = [];
        }
        elementsByRoute[el.urlRoutePattern]!.push(el);
      }

      await this.repository.warmUpMapCacheInRedis(
        input.organizationId,
        input.projectId,
        {
          functionalMapId: result.map.id,
          versionNumber: result.map.versionNumber,
          canonicalSha256: result.map.contentSha256Hash,
          routes: Array.from(routesSet),
          totalElementsCount: result.elements.length,
          publishedAtIso: result.map.publishedAt.toISOString(),
        },
        elementsByRoute
      );

      return Result.ok(result);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Caso de Uso: Rollback de version del Mapa Funcional en tiempo constante (<50ms).
 */
export class RollbackFunctionalMapVersionUseCase {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async execute(
    organizationId: string,
    projectId: string,
    targetVersionNumber: number,
    actorUserId?: string
  ): Promise<Result<FunctionalMapEntity, AppError>> {
    try {
      const rolledBackMap = await this.rlsPool.runInTenantTransaction<{
        readonly target: FunctionalMapEntity;
        readonly elements: readonly MapElementEntity[];
      }>(
        {
          organizationId,
          ...(actorUserId ? { userId: actorUserId } : {}),
        },
        async (client: PoolClient) => {
          const target = await this.repository.getMapByVersion(client, projectId, targetVersionNumber);
          if (!target) {
            throw new NotFoundError(
              `No existe la version ${targetVersionNumber} del mapa funcional para el proyecto ${projectId}`
            );
          }

          // Conmuta la version activa
          await this.repository.setActiveMap(client, projectId, target.id);
          const elements = await this.repository.listElementsByMap(client, target.id);

          return { target, elements };
        }
      );

      // Precalentar Redis con la version restaurada
      const elementsByRoute: Record<string, MapElementEntity[]> = {};
      const routesSet = new Set<string>();

      for (const el of rolledBackMap.elements) {
        routesSet.add(el.urlRoutePattern);
        if (!elementsByRoute[el.urlRoutePattern]) {
          elementsByRoute[el.urlRoutePattern] = [];
        }
        elementsByRoute[el.urlRoutePattern]!.push(el);
      }

      await this.repository.warmUpMapCacheInRedis(
        organizationId,
        projectId,
        {
          functionalMapId: rolledBackMap.target.id,
          versionNumber: rolledBackMap.target.versionNumber,
          canonicalSha256: rolledBackMap.target.contentSha256Hash,
          routes: Array.from(routesSet),
          totalElementsCount: rolledBackMap.elements.length,
          publishedAtIso: rolledBackMap.target.publishedAt.toISOString(),
        },
        elementsByRoute
      );

      return Result.ok(rolledBackMap.target);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/**
 * Adaptador de `TrainingElementRepository` para persistir elementos capturados desde el Overlay.
 */
export class TrainingElementRepositoryAdapter implements TrainingElementRepository {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async saveTaggedElement(
    projectId: string,
    element: {
      readonly elementKey: string;
      readonly primarySelector: string;
      readonly selectorStabilityScore: number;
      readonly routePath: string;
      readonly boxes: {
        readonly desktop: ElementBoundingBox;
        readonly tablet: ElementBoundingBox;
        readonly mobile: ElementBoundingBox;
      };
    },
    metadata: CapturedElementMetadata
  ): Promise<{ readonly mapElementId: string }> {
    const { organizationId } = await this.rlsPool.withClient(async (client) => {
      const res = await client.query<{ organization_id: string }>(
        'SELECT organization_id FROM projects WHERE id = $1 LIMIT 1',
        [projectId]
      );
      return { organizationId: res.rows[0]?.organization_id ?? '00000000-0000-0000-0000-000000000000' };
    });

    return this.rlsPool.runInTenantTransaction(
      { organizationId },
      async (client: PoolClient) => {
        // Obtiene o crea el mapa borrador/activo
        let activeMap = await this.repository.getActiveMapByProject(client, projectId);
        if (!activeMap) {
          activeMap = await this.repository.createFunctionalMap(client, {
            organizationId,
            projectId,
            versionNumber: 1,
            versionLabel: 'Mapa Inicial de Entrenamiento',
            sourceMode: 'VISUAL_TRAINER',
            canonicalMapJson: {},
            contentSha256Hash: CryptoUtils.sha256Hex(`init-${projectId}`),
            totalElementsCount: 0,
            publishedByUserId: undefined,
          });
          await this.repository.setActiveMap(client, projectId, activeMap.id);
        }

        const toBox = (b: ElementBoundingBox) => ({
          top: b.y,
          left: b.x,
          width: b.width,
          height: b.height,
        });

        const input: MapElementInput = {
          elementKey: element.elementKey,
          urlRoutePattern: element.routePath,
          title: metadata.title,
          functionalDescription: metadata.functionalDescription,
          isActionable: metadata.isActionable,
          actionType: metadata.actionType,
          primarySelector: element.primarySelector,
          selectorStabilityScore: element.selectorStabilityScore,
          desktopBbox: toBox(element.boxes.desktop),
          tabletBbox: toBox(element.boxes.tablet),
          mobileBbox: toBox(element.boxes.mobile),
          elementMetadata: {},
        };

        const [persisted] = await this.repository.insertMapElements(
          client,
          organizationId,
          projectId,
          activeMap.id,
          [input]
        );

        if (!persisted) {
          throw new ConflictError('No se pudo guardar el elemento etiquetado en el mapa');
        }

        return { mapElementId: persisted.id };
      }
    );
  }
}

/**
 * Adaptador de `TrainingElementValidator` para verificar coherencia de acciones.
 */
export class TrainingElementValidatorAdapter implements TrainingElementValidator {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;

  public constructor(rlsPool: RlsDatabasePool, repository: PostgresRagMapRepository) {
    this.rlsPool = rlsPool;
    this.repository = repository;
  }

  public async validateElementAction(
    projectId: string,
    functionalMapId: string,
    elementKey: string,
    actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH'
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }> {
    const { organizationId } = await this.rlsPool.withClient(async (client) => {
      const res = await client.query<{ organization_id: string }>(
        'SELECT organization_id FROM projects WHERE id = $1 LIMIT 1',
        [projectId]
      );
      return { organizationId: res.rows[0]?.organization_id ?? '00000000-0000-0000-0000-000000000000' };
    });

    return this.rlsPool.runInTenantTransaction(
      { organizationId },
      async (client: PoolClient) => {
        const elements = await this.repository.listElementsByMap(client, functionalMapId);
        const match = elements.find((e) => e.elementKey === elementKey);
        if (!match) {
          return { allowed: false, reason: `Elemento "${elementKey}" no encontrado en el mapa` };
        }
        if (!match.isActionable) {
          return { allowed: false, reason: `El elemento "${elementKey}" esta marcado como NO accionable` };
        }
        if (actionType !== 'NONE' && match.actionType !== 'BOTH' && match.actionType !== actionType) {
          return {
            allowed: false,
            reason: `Accion "${actionType}" no autorizada para el elemento "${elementKey}" (configurado: ${match.actionType})`,
          };
        }
        return { allowed: true };
      }
    );
  }
}
