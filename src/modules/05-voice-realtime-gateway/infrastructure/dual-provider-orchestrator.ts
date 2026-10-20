/**
 * @archivo src/modules/05-voice-realtime-gateway/infrastructure/dual-provider-orchestrator.ts
 * @modulo 05-voice-realtime-gateway (Orquestador Dual y Conmutador de Failover en <800ms)
 * @proposito
 *   Selecciona el proveedor de voz en tiempo real adecuado segun la configuracion del proyecto
 *   (Gemini 3.8 Live vs Qwen3.8-Omni), comprueba el estado del Kill-Switch de SuperAdmin y
 *   ejecuta una conmutacion por Failover Dual en menos de 800ms si el proveedor primario no
 *   responde o experimenta fallos de conexion.
 *
 * @resumen_contenido
 *   - Clase `DualProviderOrchestrator`: Orquesta la apertura y conmutacion de canales de voz.
 *   - Interfaces de configuracion y telemetria de conmutacion.
 *
 * @dependencias_internas
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Interfaces `IVoiceRealtimeProvider`, `IActiveProviderStream`.
 *   - `@shared/ports/core-modules.ports.ts`: Fallos tipados `PortFailure`.
 *
 * @tablas_bd_o_redis
 *   - Redis: Opcionalmente lee marcas de Kill-Switch de SuperAdmin.
 */

import {
  IActiveProviderStream,
  IVoiceRealtimeProvider,
  VoiceProviderEventHandlers,
  VoiceProviderKind,
  VoiceStreamOpenRequest,
} from '@shared/ports/billing-voice-admin.ports';
import { PortFailure } from '@shared/ports/core-modules.ports';

/** Resultado de la orquestacion de un canal de streaming de voz. */
export interface OrchestratedStreamResult {
  readonly ok: true;
  readonly stream: IActiveProviderStream;
  readonly activeProviderKind: VoiceProviderKind;
  readonly wasFailoverTriggered: boolean;
  readonly failoverReason?: string;
  readonly connectionLatencyMs: number;
}

/** Opciones del orquestador dual de proveedores. */
export interface DualProviderOrchestratorOptions {
  readonly primaryProvider: IVoiceRealtimeProvider;
  readonly fallbackProvider: IVoiceRealtimeProvider;
  readonly failoverBudgetMs?: number;
}

/** Traza de servidor para auditoria de seleccion/failover de motor. Silenciable con `VOICE_DEBUG=0`. */
const ORCH_DEBUG_ON = (process.env['VOICE_DEBUG'] ?? '1') !== '0';
function orchLog(event: string, meta?: Record<string, unknown>): void {
  if (!ORCH_DEBUG_ON) return;
  // eslint-disable-next-line no-console
  console.info(`[voice-gw orquestador] ${event}${meta ? ' ' + JSON.stringify(meta) : ''}`);
}

/**
 * Orquestador dual con soporte de Failover automatico en tiempo sub-segundo (<800ms).
 */
export class DualProviderOrchestrator {
  private readonly primaryProvider: IVoiceRealtimeProvider;
  private readonly fallbackProvider: IVoiceRealtimeProvider;
  private readonly failoverBudgetMs: number;

  /** Marcas en memoria del Kill-Switch global por proveedor (activable por SuperAdmin). */
  private readonly killSwitches: Map<VoiceProviderKind, boolean> = new Map([
    ['QWEN', false],
    ['GEMINI', false],
  ]);

  public constructor(options: DualProviderOrchestratorOptions) {
    this.primaryProvider = options.primaryProvider;
    this.fallbackProvider = options.fallbackProvider;
    this.failoverBudgetMs = options.failoverBudgetMs ?? 800;
  }

  /**
   * Activa o desactiva el Kill-Switch de un motor de voz (utilizado por el SuperAdmin).
   *
   * @param provider - Motor a gobernar ('QWEN' o 'GEMINI').
   * @param disabled - Si es true, el motor no sera utilizado y las peticiones iran a fallback.
   */
  public setKillSwitch(provider: VoiceProviderKind, disabled: boolean): void {
    this.killSwitches.set(provider, disabled);
  }

  /**
   * Consulta si un motor de voz tiene activo el Kill-Switch de plataforma.
   */
  public isKillSwitchActive(provider: VoiceProviderKind): boolean {
    return this.killSwitches.get(provider) === true;
  }

  /**
   * Abre un canal de streaming seleccionando el proveedor adecuado y aplicando failover si se requiere.
   *
   * @param request - Solicitud de apertura con prompt y parametros de sesion.
   * @param handlers - Manejadores de eventos de la sesion.
   * @param preferredProviderKind - Proveedor preferido del proyecto o null para usar el configurado por defecto.
   */
  public async orchestrateStream(
    request: VoiceStreamOpenRequest,
    handlers: VoiceProviderEventHandlers,
    preferredProviderKind?: VoiceProviderKind
  ): Promise<OrchestratedStreamResult | PortFailure> {
    const startTime = Date.now();

    // 1. Determinar el orden de preferencia (primario y secundario)
    let firstChoice = this.primaryProvider;
    let secondChoice = this.fallbackProvider;

    if (preferredProviderKind) {
      if (this.primaryProvider.providerKind === preferredProviderKind) {
        firstChoice = this.primaryProvider;
        secondChoice = this.fallbackProvider;
      } else if (this.fallbackProvider.providerKind === preferredProviderKind) {
        firstChoice = this.fallbackProvider;
        secondChoice = this.primaryProvider;
      }
    }

    // 2. Verificar Kill-Switch del primer candidato
    if (this.isKillSwitchActive(firstChoice.providerKind)) {
      // El proveedor primario esta deshabilitado administrativamente: conmutacion preventiva a respaldo
      return this.tryOpenStream(
        secondChoice,
        request,
        handlers,
        true,
        `Proveedor primario (${firstChoice.providerKind}) deshabilitado por Kill-Switch administrativo`,
        startTime
      );
    }

    // 3. Intento de apertura con el primer candidato dentro del presupuesto de tiempo
    orchLog('intentando proveedor', { intento: firstChoice.providerKind, respaldo: secondChoice.providerKind, preferido: preferredProviderKind ?? '(entorno)', presupuestoMs: this.failoverBudgetMs });
    const openPromise = firstChoice.openStream(request, handlers);
    const timeoutPromise = new Promise<{ readonly ok: false; readonly isTimeout: true }>((resolve) => {
      setTimeout(() => resolve({ ok: false, isTimeout: true }), this.failoverBudgetMs);
    });

    const primaryAttempt = await Promise.race([openPromise, timeoutPromise]);

    if ('isTimeout' in primaryAttempt) {
      // Expiro el presupuesto: activar Failover Dual hacia el segundo candidato
      orchLog('TIMEOUT de apertura: FAILOVER al respaldo', { intento: firstChoice.providerKind, presupuestoMs: this.failoverBudgetMs, iraA: secondChoice.providerKind });
      return this.tryOpenStream(
        secondChoice,
        request,
        handlers,
        true,
        `Proveedor primario (${firstChoice.providerKind}) supero el presupuesto de timeout de ${this.failoverBudgetMs}ms`,
        startTime
      );
    }

    if (primaryAttempt.ok) {
      const elapsed = Date.now() - startTime;
      orchLog('proveedor activo OK', { proveedor: firstChoice.providerKind, latenciaMs: elapsed });
      return {
        ok: true,
        stream: primaryAttempt.stream,
        activeProviderKind: firstChoice.providerKind,
        wasFailoverTriggered: false,
        connectionLatencyMs: elapsed,
      };
    }

    // El primer candidato respondio con error: intentar segundo candidato
    if (this.isKillSwitchActive(secondChoice.providerKind)) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: `Fallo el proveedor primario (${primaryAttempt.reason}) y el de respaldo esta bajo Kill-Switch`,
        retryable: true,
      };
    }

    return this.tryOpenStream(
      secondChoice,
      request,
      handlers,
      true,
      `Fallo del proveedor primario: ${primaryAttempt.reason}`,
      startTime
    );
  }

  private async tryOpenStream(
    provider: IVoiceRealtimeProvider,
    request: VoiceStreamOpenRequest,
    handlers: VoiceProviderEventHandlers,
    wasFailover: boolean,
    failoverReason: string,
    startTime: number
  ): Promise<OrchestratedStreamResult | PortFailure> {
    const isAvail = await provider.isAvailable();
    if (!isAvail) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: `Proveedor de respaldo (${provider.providerKind}) no disponible en este momento`,
        retryable: true,
      };
    }

    const res = await provider.openStream(request, handlers);
    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      return res;
    }

    return {
      ok: true,
      stream: res.stream,
      activeProviderKind: provider.providerKind,
      wasFailoverTriggered: wasFailover,
      failoverReason,
      connectionLatencyMs: elapsed,
    };
  }
}
