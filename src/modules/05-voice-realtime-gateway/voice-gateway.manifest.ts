/**
 * @archivo src/modules/05-voice-realtime-gateway/voice-gateway.manifest.ts
 * @modulo 05-voice-realtime-gateway (Manifiesto, Puerto de Control del Gateway y Kill-Switch Global)
 * @proposito
 *   Manifiesto autonomo del modulo 05. Implementa el puerto oficial `IVoiceGatewayControlPort` que
 *   consume la consola de gobierno para cortar el servicio de una organizacion sin conocer los
 *   detalles del socket, se suscribe al bus de eventos global para reaccionar a la suspension de un
 *   tenant en todos los nodos del plano de voz, y registra los dos adaptadores y el orquestador dual
 *   en el contenedor de inyeccion. Ademas expone el conmutador global de motor, que permite a la
 *   plataforma pasar todas las sesiones nuevas al motor de respaldo sin desplegar codigo.
 *
 * @resumen_contenido
 *   - Clase `VoiceGatewayControlAdapter`: implementa `IVoiceGatewayControlPort` y gobierna el
 *     registro de sesiones activas por organizacion.
 *   - Funcion `createVoiceGatewayControlAdapter()`.
 *   - Funcion `registerVoiceGatewayModule()`: registro en DI y suscripcion al bus de eventos.
 *
 * @dependencias_internas
 *   - `IVoiceGatewayControlPort` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `DualProviderOrchestrator` y adaptadores (`./infrastructure/`).
 *   - `DependencyContainer`, `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *   - `ApplicationEventName` (`src/shared/kernel/application-event.catalog.ts`).
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para las credenciales de los dos motores.
 *
 * @dependencias_externas
 *   - Ninguna (El transporte y la persistencia llegan por el contenedor de inyeccion).
 *
 * @tablas_bd_o_redis
 *   - Redis: Canal de eventos del bus para propagar la suspension a todos los nodos de voz.
 *   - PostgreSQL: `voice_sessions` (Las sesiones cerradas se marcan con su motivo de terminacion).
 */

import { getEnvConfig } from '../../config/env.schema';
import { DependencyContainer, DI_TOKENS } from '../../shared/container/di-container';
import { RlsDatabasePool } from '../../shared/infrastructure/database/rls-pool';
import type { DomainEventBus } from '../../shared/infrastructure/event-bus/domain-event-bus';
import type { ApplicationEventName } from '../../shared/kernel/application-event.catalog';
import type {
  IVoiceGatewayControlPort,
  MassTerminationResult,
  VoiceProviderKind,
} from '../../shared/ports/billing-voice-admin.ports';
import type { IVisualRagAndPromptPort } from '../../shared/ports/core-modules.ports';
import { DualProviderOrchestrator } from './infrastructure/dual-provider-orchestrator';
import { Qwen38OmniAdapter } from './infrastructure/qwen-38-omni.adapter';
import { Gemini38LiveAdapter } from './infrastructure/gemini-38-live.adapter';
import { PostgresVoiceSessionRepository } from './infrastructure/postgres-voice-session.repository';
import { createVoiceSessionMeteringStore } from './infrastructure/voice-session-metering.store';
import { createDispatchDomToolUseCase } from './application/dispatch-dom-tool.use-case';
import { createVoiceSessionMeteringService } from './application/voice-session-metering.service';
import { VOICE_CLOSE_CODES } from './infrastructure/voice-frame.protocol';
import { createLazyBillingPort } from './infrastructure/billing-port.lazy-proxy';

/** Nombre con el que el modulo se identifica en la bitacora y los diagnosticos. */
const OWNER_MODULE = '05-voice-realtime-gateway';

/** Cierre de una sesion viva, con su codigo y su motivo. */
interface LiveSessionHandle {
  /** Organizacion propietaria de la sesion. */
  readonly organizationId: string;
  /** Cierre forzado de la sesion con su codigo de socket y su motivo. */
  readonly terminate: (closeCode: number, reason: string) => Promise<void>;
}

/**
 * Adaptador oficial del puerto de control del gateway de voz.
 * Mantiene el registro de sesiones activas por organizacion para poder cortarlas de inmediato.
 */
export class VoiceGatewayControlAdapter implements IVoiceGatewayControlPort {
  private readonly orchestrator: DualProviderOrchestrator;
  private readonly liveSessions = new Map<string, LiveSessionHandle>();

  /**
   * @param orchestrator - Orquestador dual, usado por el conmutador global de motor.
   */
  public constructor(orchestrator: DualProviderOrchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Registra una sesion viva para que el gobierno pueda cortarla.
   *
   * @param voiceSessionId - Identificador de la sesion.
   * @param organizationId - Organizacion propietaria.
   * @param terminate - Cierre forzado de la sesion.
   */
  public registerLiveSession(voiceSessionId: string, organizationId: string, terminate: LiveSessionHandle['terminate']): void {
    this.liveSessions.set(voiceSessionId, { organizationId, terminate });
  }

  /**
   * Retira una sesion del registro de sesiones vivas.
   *
   * @param voiceSessionId - Identificador de la sesion.
   * @returns `true` cuando la sesion estaba registrada.
   */
  public unregisterLiveSession(voiceSessionId: string): boolean {
    return this.liveSessions.delete(voiceSessionId);
  }

  /**
   * Devuelve cuantas sesiones vivas tiene una organizacion.
   *
   * @param organizationId - Organizacion consultada.
   * @returns Numero de sesiones activas.
   */
  public countOrganizationSessions(organizationId: string): number {
    let count = 0;
    for (const [, handle] of this.liveSessions) {
      if (handle.organizationId === organizationId) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Cierra de inmediato todas las sesiones de voz activas de una organizacion.
   *
   * @param organizationId - Organizacion cuyas sesiones se cierran.
   * @param reason - Motivo del cierre, registrado en auditoria.
   * @param closeCode - Codigo de cierre del socket que recibe el navegador.
   * @returns Resumen de la terminacion masiva.
   */
  public async terminateAllOrgSessionsImmediately(
    organizationId: string,
    reason: string,
    closeCode: number
  ): Promise<MassTerminationResult> {
    const targets: { readonly voiceSessionId: string; readonly handle: LiveSessionHandle }[] = [];
    for (const [voiceSessionId, handle] of this.liveSessions) {
      if (handle.organizationId === organizationId) {
        targets.push({ voiceSessionId, handle });
      }
    }

    let terminatedSessionCount = 0;
    for (const target of targets) {
      try {
        await target.handle.terminate(closeCode, reason);
        this.liveSessions.delete(target.voiceSessionId);
        terminatedSessionCount += 1;
      } catch {
        // Una sesion que no puede cerrarse ordenadamente se retira igualmente del registro: dejarla
        // contabilizada como viva confundiria al monitor de infraestructura.
        this.liveSessions.delete(target.voiceSessionId);
      }
    }

    return { terminatedSessionCount, organizationId, reason };
  }

  /**
   * Cambia el motor de voz que atiende las sesiones nuevas.
   * El cambio se aplica en memoria y el bus de eventos lo propaga al resto de nodos del plano de voz.
   *
   * @param providerKind - Motor que pasara a atender las sesiones nuevas.
   * @param switchedBySuperAdminId - Operador de gobierno que autoriza el cambio.
   * @returns Confirmacion del cambio con la marca temporal de aplicacion.
   */
  public async switchGlobalDefaultAiProvider(
    providerKind: VoiceProviderKind,
    switchedBySuperAdminId: string
  ): Promise<
    | { readonly ok: true; readonly appliedAtIso: string; readonly previousProviderKind: VoiceProviderKind }
    | { readonly ok: false; readonly code: 'PERSISTENCE_UNAVAILABLE'; readonly reason: string; readonly retryable: boolean }
  > {
    const previousProviderKind: VoiceProviderKind = this.orchestrator.isKillSwitchActive('GEMINI') ? 'QWEN' : 'GEMINI';
    const disabledProvider: VoiceProviderKind = providerKind === 'GEMINI' ? 'QWEN' : 'GEMINI';

    // Se deshabilita el motor no elegido en lugar de reordenar el orquestador: el Kill-Switch ya
    // desvia todo el trafico al otro motor y es la palanca que el gobierno conoce.
    this.orchestrator.setKillSwitch(disabledProvider, true);
    this.orchestrator.setKillSwitch(providerKind, false);

    if (switchedBySuperAdminId.trim().length === 0) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'El cambio de motor exige el operador de gobierno que lo autoriza.',
        retryable: false,
      };
    }

    return { ok: true, appliedAtIso: new Date().toISOString(), previousProviderKind };
  }

  /**
   * Aplica el Kill-Switch de un motor sin pasar por el conmutador global.
   *
   * @param providerKind - Motor gobernado.
   * @param disabled - Indica si el motor queda deshabilitado.
   */
  public setProviderKillSwitch(providerKind: VoiceProviderKind, disabled: boolean): void {
    this.orchestrator.setKillSwitch(providerKind, disabled);
  }
}

/**
 * Construye los dos adaptadores y el orquestador dual con la configuracion del entorno.
 *
 * @returns Orquestador listo para atender sesiones con failover automatico.
 */
export function buildDualProviderOrchestrator(): DualProviderOrchestrator {
  const environment = getEnvConfig();

  // Los dos motores se construyen siempre y el orden de preferencia lo decide la configuracion del
  // entorno, de modo que invertir el primario sea un cambio de variable y no de codigo.
  const qwenAdapter = new Qwen38OmniAdapter({
    wsUrl: environment.QWEN_REALTIME_WS_URL,
    apiKey: environment.QWEN_API_KEY,
    providerRole: environment.VOICE_PROVIDER_PRIMARY === 'QWEN' ? 'PRIMARY' : 'FAILOVER',
    bargeInBudgetMs: environment.VOICE_BARGE_IN_BUDGET_MS,
    // Cada fragmento canonico son 20 ms: la capacidad se declara en milisegundos de audio.
    ringBufferCapacityMs: environment.VOICE_RING_BUFFER_MAX_FRAMES * 20,
  });
  const geminiAdapter = new Gemini38LiveAdapter({
    wsUrl: environment.GEMINI_LIVE_WS_URL,
    apiKey: environment.GEMINI_API_KEY,
    providerRole: environment.VOICE_PROVIDER_PRIMARY === 'GEMINI' ? 'PRIMARY' : 'FAILOVER',
  });

  const primaryProvider = environment.VOICE_PROVIDER_PRIMARY === 'QWEN' ? qwenAdapter : geminiAdapter;
  const fallbackProvider = environment.VOICE_PROVIDER_PRIMARY === 'QWEN' ? geminiAdapter : qwenAdapter;

  return new DualProviderOrchestrator({
    primaryProvider,
    fallbackProvider,
    failoverBudgetMs: environment.VOICE_PROVIDER_FAILOVER_BUDGET_MS,
  });
}

/**
 * Registra el Modulo 05 en el contenedor de dependencias y lo suscribe al bus de eventos.
 *
 * @param container - Contenedor de inyeccion de dependencias del monolito.
 * @param eventBus - Bus de eventos para propagar la suspension de tenants.
 * @returns Adaptador de control registrado, para que el servidor de sockets anuncie sus sesiones.
 */
export function registerVoiceGatewayModule(container: DependencyContainer, eventBus: DomainEventBus): VoiceGatewayControlAdapter {
  const pool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const ragPort = container.get(DI_TOKENS.RagMapQueryPort) as IVisualRagAndPromptPort;

  const orchestrator = buildDualProviderOrchestrator();
  const sessionRepository = new PostgresVoiceSessionRepository();
  const meteringStore = createVoiceSessionMeteringStore(pool);
  const dispatchToolUseCase = createDispatchDomToolUseCase({ pool, sessionRepository, ragPort });
  const meteringService = createVoiceSessionMeteringService({
    // El puerto de facturacion lo registra el Modulo 04 y es la UNICA ruta autorizada de deduccion.
    // Se resuelve de forma PEREZOSA: asi el arranque del gateway no depende de que el manifiesto de
    // cobros se haya ejecutado antes, y no hay que afirmar el tipo para silenciar el compilador.
    billingPort: createLazyBillingPort(container),
    meteringStore,
  });

  const controlAdapter = new VoiceGatewayControlAdapter(orchestrator);
  container.registerInstance(DI_TOKENS.VoiceRealtimeProvider, orchestrator);
  container.registerInstance(DI_TOKENS.VoiceGatewayControlPort, controlAdapter);

  // La suspension de un tenant debe cortar sus sesiones de voz en TODOS los nodos del plano de voz,
  // por lo que la suscripcion es global (a traves de Redis) y no local al proceso.
  void eventBus.subscribeGlobal('organization.suspended' as ApplicationEventName, async (payload: unknown) => {
    const organizationId = readOrganizationId(payload);
    if (organizationId === null) {
      return;
    }
    await controlAdapter.terminateAllOrgSessionsImmediately(
      organizationId,
      `Organizacion suspendida por el gobierno de la plataforma (${OWNER_MODULE}).`,
      VOICE_CLOSE_CODES.TENANT_SUSPENDED
    );
  });

  return controlAdapter;
}

/**
 * Extrae el identificador de organizacion de la carga util de un evento del bus.
 *
 * @param payload - Carga util cruda del evento.
 * @returns Identificador de la organizacion, o `null` cuando no es interpretable.
 */
function readOrganizationId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const rawValue = (payload as Record<string, unknown>)['organizationId'];
  return typeof rawValue === 'string' && rawValue.length > 0 ? rawValue : null;
}

/** Reexportacion del cierre con el que se corta una sesion por suspension de la organizacion. */
export { VOICE_CLOSE_CODES };
export type { MassTerminationResult };


