/**
 * @archivo src/bootstrap/public-demo-tool-dispatch.ts
 * @modulo Bootstrap (Despacho de Herramientas de la Demostracion Publica)
 * @proposito
 *   Instancia el despachador de herramientas fisicas del camino demo con dos piezas aisladas: la
 *   barrera del mapa funcional sintetico (solo autoriza los elementos del CRM simulado de la
 *   landing) y un repositorio de sesiones anulado que evita TODA escritura en PostgreSQL para una
 *   visita anonima. La organizacion sintetica `public-demo` no existe en la base a proposito: sin
 *   este repositorio, el alta de `action_events` fallaria por llave foranea y el motor se quedaria
 *   sin respuesta de herramienta a mitad de la demostracion. El camino SDK normal no se toca: el
 *   despachador real conserva su repositorio y su barrera de base de datos.
 *
 * @resumen_contenido
 *   - Clase `PublicDemoVoiceSessionRepository`: persistencia anulada del camino demo.
 *   - Funcion `createPublicDemoToolDispatchUseCase()`: ensambla el despachador con el mapa demo.
 *
 * @dependencias_internas
 *   - `PostgresVoiceSessionRepository` y `CreateActionEventData`
 *     (`../modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository`).
 *   - `ActionExecutionStatusInput`
 *     (`../modules/05-voice-realtime-gateway/infrastructure/voice-session-row-mapping`).
 *   - `DispatchDomToolUseCase` y su fabrica
 *     (`../modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case`).
 *   - `ActionEventEntity` (`../modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types`).
 *   - Sistema ensamblado (`./module-autoloader`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de las firmas heredadas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: ninguna (el repositorio anulado intercepta `voice_sessions` y `action_events`).
 *   - Redis: ninguna (la sesion efimera ya vive en `oa:demo:session:*`, administrada por el borde).
 */

import type { PoolClient } from 'pg';
import type { RedisClusterClient } from '../shared/infrastructure/redis/redis-cluster.client';
import type { IVisualRagAndPromptPort } from '../shared/ports/core-modules.ports';
import type { ActionEventEntity } from '../modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types';
import {
  createDispatchDomToolUseCase,
  type DispatchDomToolUseCase,
} from '../modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case';
import {
  PostgresVoiceSessionRepository,
  type CreateActionEventData,
} from '../modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository';
import type { ActionExecutionStatusInput } from '../modules/05-voice-realtime-gateway/infrastructure/voice-session-row-mapping';
import type { BootstrappedSystem } from './module-autoloader';

/**
 * Repositorio de sesiones anulado del camino demo.
 * La visita anonima no factura, no persiste sesiones y no deja rastro contable; sus eventos de
 * accion se simulan en memoria con identificadores sinteticos para que el despachador conserve su
 * flujo completo (alta, acuse y estado final) sin tocar la base de datos. El contador de llamadas
 * de herramienta se devuelve como cero porque no existe fila de sesion que incrementar.
 */
export class PublicDemoVoiceSessionRepository extends PostgresVoiceSessionRepository {
  private syntheticEventCounter = 0;

  /**
   * @param redisClient - Cliente unico de Redis; el repositorio heredado lo recibe aunque la demo
   *   no sincronice estado de sesion en el cluster de voz.
   */
  public constructor(redisClient: RedisClusterClient) {
    super(redisClient);
  }

  /** Sin incremento contable: no hay fila de sesion de voz que actualizar. */
  public override async incrementToolCallsCount(_client: PoolClient, _sessionId: string): Promise<number> {
    return 0;
  }

  /** Evento de accion sintetico en memoria, con la misma forma que la entidad persistida. */
  public override async createActionEvent(
    _client: PoolClient,
    data: CreateActionEventData
  ): Promise<ActionEventEntity> {
    this.syntheticEventCounter += 1;
    return {
      id: `public-demo-action-${this.syntheticEventCounter}`,
      organizationId: data.organizationId,
      projectId: data.projectId,
      voiceSessionId: data.voiceSessionId,
      mapElementId: data.mapElementId ?? null,
      providerToolCallId: data.providerToolCallId,
      toolName: data.toolName,
      routePathAtExecution: data.routePathAtExecution,
      selectorUsed: data.selectorUsed,
      actionPayloadRedactedJson: data.actionPayloadRedactedJson,
      executionStatus: 'DISPATCHED',
      executionLatencyMs: null,
      errorCode: null,
      dispatchedAt: new Date(),
      acknowledgedAt: null,
    };
  }

  /** Sin actualizacion de trazabilidad: el evento sintetico no vive en PostgreSQL. */
  public override async updateActionEventStatus(
    _client: PoolClient,
    _actionEventId: string,
    _status: ActionExecutionStatusInput,
    _latencyMs?: number,
    _errorCode?: string
  ): Promise<void> {
    // Intencionadamente vacio.
  }
}

/**
 * Ensambla el despachador de herramientas del camino demo.
 *
 * @param system - Sistema ensamblado (pool con RLS y Redis).
 * @param demoRagPort - Puerto RAG de la demostracion: su barrera autoriza solo el mapa sintetico.
 * @returns Despachador listo para inyectarse en los puertos demo del borde de voz.
 */
export function createPublicDemoToolDispatchUseCase(
  system: BootstrappedSystem,
  demoRagPort: IVisualRagAndPromptPort
): DispatchDomToolUseCase {
  return createDispatchDomToolUseCase({
    // La transaccion con contexto RLS si se abre (el llamador la administra), pero el repositorio
    // anulado jamas escribe: la organizacion `public-demo` no necesito existir en la base.
    pool: system.databasePool,
    sessionRepository: new PublicDemoVoiceSessionRepository(system.redisClient),
    ragPort: demoRagPort,
  });
}
