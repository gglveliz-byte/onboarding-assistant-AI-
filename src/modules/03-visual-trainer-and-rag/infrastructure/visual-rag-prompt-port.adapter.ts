/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/visual-rag-prompt-port.adapter.ts
 * @modulo 03-visual-trainer-and-rag (Adaptador del Puerto Oficial IVisualRagAndPromptPort)
 * @proposito
 *   Implementa el contrato IVisualRagAndPromptPort consumido por el Gateway de Voz en tiempo real
 *   para resolucion del System Prompt, Context Slimming por pantalla y guardrails de acciones DOM.
 *   - Resuelve dinamicamente la organizacion del proyecto para impedir fugas multi-tenant (C1-46).
 *   - Ejecuta Context Slimming sub-milisegundo (<2ms) segmentado por tenant.
 *   - Valida guardrails de acciones fisicas con evaluacion de riesgos y confirmacion del usuario.
 *
 * @dependencias_internas
 *   - `@shared/infrastructure/database/rls-pool.ts`: Transacciones RLS y consultas seguras.
 *   - `@shared/kernel/result-and-errors.ts`: Errores de dominio y conversion toAppError.
 *   - `@shared/ports/core-modules.ports.ts`: Contrato oficial `IVisualRagAndPromptPort`.
 *   - `../application/prompt-studio-and-slimming.use-case.ts`: Caso de uso `SlimContextForRouteUseCase`.
 *   - `./postgres-rag-map.repository.ts`: Repositorio de mapas y elementos.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `functional_maps`, `map_elements`.
 *   - Redis: `oa:rag_map:org:<orgId>:proj:<projId>:routes`.
 */

import type { PoolClient } from 'pg';
import { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import { toAppError } from '../../../shared/kernel/result-and-errors';
import {
  ActiveMapMetadata,
  IVisualRagAndPromptPort,
  PortFailure,
  RiskLevel,
  SlimmedRouteContext,
} from '../../../shared/ports/core-modules.ports';
import { SlimContextForRouteUseCase } from '../application/prompt-studio-and-slimming.use-case';
import { PostgresRagMapRepository } from './postgres-rag-map.repository';

/**
 * Adaptador oficial del puerto `IVisualRagAndPromptPort` del Core.
 */
export class VisualRagAndPromptPortAdapter implements IVisualRagAndPromptPort {
  private readonly rlsPool: RlsDatabasePool;
  private readonly repository: PostgresRagMapRepository;
  private readonly slimContextUseCase: SlimContextForRouteUseCase;

  public constructor(
    rlsPool: RlsDatabasePool,
    repository: PostgresRagMapRepository,
    slimContextUseCase: SlimContextForRouteUseCase
  ) {
    this.rlsPool = rlsPool;
    this.repository = repository;
    this.slimContextUseCase = slimContextUseCase;
  }

  public async getActiveProjectPromptAndMapMeta(
    projectId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly systemPrompt: string;
        readonly promptVersionNumber: number;
        readonly onboardingStepsJson: readonly unknown[];
        readonly primaryVoiceModel: string;
        readonly fallbackVoiceModel: string;
        readonly mapMetadata: ActiveMapMetadata;
      }
    | PortFailure
  > {
    try {
      const { organizationId } = await this.rlsPool.withClient(async (client) => {
        const res = await client.query<{ organization_id: string }>(
          'SELECT organization_id FROM projects WHERE id = $1 LIMIT 1;',
          [projectId]
        );
        return { organizationId: res.rows[0]?.organization_id ?? null };
      });

      if (!organizationId) {
        return {
          ok: false,
          code: 'RESOURCE_NOT_FOUND',
          reason: `Proyecto no encontrado: ${projectId}`,
          retryable: false,
        };
      }

      return await this.rlsPool.runInTenantTransaction(
        { organizationId },
        async (client: PoolClient) => {
          // 1. Obtener configuracion del proyecto
          const projQuery = `
            SELECT system_prompt, active_prompt_version_number, onboarding_steps_json,
                   primary_voice_model, fallback_voice_model, active_functional_map_id
            FROM projects WHERE id = $1 LIMIT 1;
          `;
          const { rows: projRows } = await client.query<{
            system_prompt: string;
            active_prompt_version_number: number;
            onboarding_steps_json: unknown;
            primary_voice_model: string;
            fallback_voice_model: string;
            active_functional_map_id: string | null;
          }>(projQuery, [projectId]);

          const proj = projRows[0];
          if (!proj) {
            return {
              ok: false,
              code: 'RESOURCE_NOT_FOUND',
              reason: `Proyecto no encontrado: ${projectId}`,
              retryable: false,
            };
          }

          if (!proj.active_functional_map_id) {
            return {
              ok: false,
              code: 'MAP_NOT_PUBLISHED',
              reason: `El proyecto ${projectId} no tiene ningun mapa funcional activo publicado`,
              retryable: false,
            };
          }

          // 2. Obtener metadatos del mapa activo
          const activeMap = await this.repository.getMapById(client, proj.active_functional_map_id);
          if (!activeMap) {
            return {
              ok: false,
              code: 'MAP_NOT_PUBLISHED',
              reason: `Mapa activo ${proj.active_functional_map_id} no encontrado en base de datos`,
              retryable: false,
            };
          }

          const elements = await this.repository.listElementsByMap(client, activeMap.id);
          const routes: readonly string[] = Array.from(new Set(elements.map((e) => e.urlRoutePattern)));

          const mapMetadata: ActiveMapMetadata = {
            functionalMapId: activeMap.id,
            versionNumber: activeMap.versionNumber,
            canonicalSha256: activeMap.contentSha256Hash,
            routes,
            totalElementsCount: elements.length,
            publishedAtIso: activeMap.publishedAt.toISOString(),
          };

          return {
            ok: true,
            systemPrompt: proj.system_prompt,
            promptVersionNumber: proj.active_prompt_version_number,
            onboardingStepsJson: (Array.isArray(proj.onboarding_steps_json)
              ? proj.onboarding_steps_json
              : []) as readonly unknown[],
            primaryVoiceModel: proj.primary_voice_model,
            fallbackVoiceModel: proj.fallback_voice_model,
            mapMetadata,
          };
        }
      );
    } catch (error) {
      const appErr = toAppError(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: appErr.message,
        retryable: true,
      };
    }
  }

  public async getSlimmedRouteContext(
    projectId: string,
    routePath: string,
    stepNumber: number
  ): Promise<{ readonly ok: true; readonly context: SlimmedRouteContext } | PortFailure> {
    try {
      // 1. Resolver la organizacion propietaria del proyecto para impedir comodines globales (C1-46)
      const { organizationId } = await this.rlsPool.withClient(async (client) => {
        const res = await client.query<{ organization_id: string }>(
          'SELECT organization_id FROM projects WHERE id = $1 LIMIT 1;',
          [projectId]
        );
        return { organizationId: res.rows[0]?.organization_id ?? null };
      });

      if (!organizationId) {
        return {
          ok: false,
          code: 'PERSISTENCE_UNAVAILABLE',
          reason: `No se encontro la organizacion para el proyecto ${projectId}`,
          retryable: false,
        };
      }

      // 2. Ejecutar Context Slimming pasando la organizacion real del proyecto
      const res = await this.slimContextUseCase.execute({
        organizationId,
        projectId,
        routePath,
        stepNumber,
      });

      if (!res.ok) {
        return {
          ok: false,
          code: 'PERSISTENCE_UNAVAILABLE',
          reason: res.error.message,
          retryable: true,
        };
      }

      return { ok: true, context: res.value };
    } catch (error) {
      const appErr = toAppError(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: appErr.message,
        retryable: true,
      };
    }
  }

  public async validateElementActionGuardrail(
    projectId: string,
    functionalMapId: string,
    toolName: 'click_element' | 'type_text',
    targetElementKey: string,
    routePath: string
  ): Promise<
    | {
        readonly ok: true;
        readonly primarySelector: string;
        readonly riskLevel: RiskLevel;
        readonly requiresUserConfirmation: boolean;
      }
    | PortFailure
  > {
    try {
      const { organizationId } = await this.rlsPool.withClient(async (client) => {
        const res = await client.query<{ organization_id: string }>(
          'SELECT organization_id FROM projects WHERE id = $1 LIMIT 1;',
          [projectId]
        );
        return { organizationId: res.rows[0]?.organization_id ?? null };
      });

      if (!organizationId) {
        return {
          ok: false,
          code: 'RESOURCE_NOT_FOUND',
          reason: `Proyecto no encontrado: ${projectId}`,
          retryable: false,
        };
      }

      return await this.rlsPool.runInTenantTransaction(
        { organizationId },
        async (client: PoolClient) => {
          // 1. Obtener proyecto para evaluar bandera ask_confirmation_before_submit
          const projRes = await client.query<{ ask_confirmation_before_submit: boolean }>(
            'SELECT ask_confirmation_before_submit FROM projects WHERE id = $1 LIMIT 1;',
            [projectId]
          );
          const askConfirmation = projRes.rows[0]?.ask_confirmation_before_submit ?? true;

          // 2. Buscar elemento en el mapa funcional
          const elements = await this.repository.listElementsByRoute(client, functionalMapId, routePath);
          const match = elements.find((e) => e.elementKey === targetElementKey);

          if (!match) {
            return {
              ok: false,
              code: 'ELEMENT_NOT_FOUND',
              reason: `El elemento "${targetElementKey}" no existe en el mapa de la ruta "${routePath}"`,
              retryable: false,
            };
          }

          if (!match.isActionable) {
            return {
              ok: false,
              code: 'ELEMENT_ACTION_NOT_ALLOWED',
              reason: `El elemento "${targetElementKey}" no es accionable segun el mapa funcional`,
              retryable: false,
            };
          }

          // 3. Validar correspondencia con toolName
          if (toolName === 'click_element' && match.actionType !== 'CLICK' && match.actionType !== 'BOTH') {
            return {
              ok: false,
              code: 'ELEMENT_ACTION_NOT_ALLOWED',
              reason: `El elemento "${targetElementKey}" no admite clics (configurado: ${match.actionType})`,
              retryable: false,
            };
          }

          if (toolName === 'type_text' && match.actionType !== 'TYPE' && match.actionType !== 'BOTH') {
            return {
              ok: false,
              code: 'ELEMENT_ACTION_NOT_ALLOWED',
              reason: `El elemento "${targetElementKey}" no admite escritura (configurado: ${match.actionType})`,
              retryable: false,
            };
          }

          const metadata = match.elementMetadata as Record<string, unknown>;
          const riskLevel: RiskLevel =
            metadata['riskLevel'] === 'HIGH' || metadata['riskLevel'] === 'MEDIUM'
              ? (metadata['riskLevel'] as RiskLevel)
              : 'LOW';

          return {
            ok: true,
            primarySelector: match.primarySelector,
            riskLevel,
            requiresUserConfirmation: askConfirmation || riskLevel === 'HIGH',
          };
        }
      );
    } catch (error) {
      const appErr = toAppError(error);
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: appErr.message,
        retryable: true,
      };
    }
  }
}
