/**
 * @archivo src/bootstrap/voice-pool-session-registry.ts
 * @modulo 05-voice-realtime-gateway (Registro y Topes de Concurrencia de Sesiones Vivas)
 * @proposito
 *   Mantiene el inventario de sesiones de voz vivas atendidas por el proceso del Gateway,
 *   garantizando el control de drenado en apagado ordenado, el corte masivo de sesiones
 *   por suspension de tenant y los topes de concurrencia obligatorios:
 *   - [C1-59]: Tope maximo de sesiones por organizacion (evita monopolizar el pool transaccional).
 *   - [C1-59]: Tope global de sesiones en el nodo de sockets con rechazo explicito (codigo 4007).
 *
 * @dependencias_internas
 *   - `VOICE_CLOSE_CODES` (`../modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol.ts`).
 *   - `VoiceSessionClosingStatus` (`../modules/05-voice-realtime-gateway/application/voice-websocket.contracts.ts`).
 *   - `VoiceWebSocketSession` (`../modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case.ts`).
 *
 * @dependencias_externas
 *   - `ws` (`WebSocket`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Estado de concurrencia activo en memoria del proceso con drenado hacia `usage_ledger`).
 */

import type { WebSocket } from 'ws';
import { VOICE_CLOSE_CODES } from '../modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import type { VoiceSessionClosingStatus } from '../modules/05-voice-realtime-gateway/application/voice-websocket.contracts';
import type { VoiceWebSocketSession } from '../modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case';

/** Sesion de voz viva en el pool, con su socket y su ciclo de vida. */
export interface LiveVoiceSession {
  /** Organizacion propietaria, usada para el corte masivo por gobierno y limite por tenant. */
  readonly organizationId: string;
  /** Identificador de la sesion persistida. */
  readonly voiceSessionId: string;
  /** Ciclo de vida de la sesion. */
  readonly session: VoiceWebSocketSession;
  /** Socket del navegador del usuario final. */
  readonly socket: WebSocket;
  /** Momento de apertura, para medir la duracion. */
  readonly openedAtMs: number;
}

/** Limites de concurrencia de sesiones en el gateway (C1-59). */
export interface VoicePoolSessionCaps {
  /** Maximo de sesiones simultaneas para una misma organizacion (por omision 10). */
  readonly maxSessionsPerOrg: number;
  /** Tope global de sesiones simultaneas en el servidor de sockets (por omision 100). */
  readonly maxGlobalSessions: number;
}

/**
 * Registro de sesiones de voz vivas del proceso con limites de concurrencia por organizacion y globales.
 */
export class VoicePoolSessionRegistry {
  private readonly sessions = new Map<string, LiveVoiceSession>();
  public readonly maxSessionsPerOrg: number;
  public readonly maxGlobalSessions: number;

  public constructor(caps: Partial<VoicePoolSessionCaps> = {}) {
    this.maxSessionsPerOrg = caps.maxSessionsPerOrg ?? 10;
    this.maxGlobalSessions = caps.maxGlobalSessions ?? 100;
  }

  /**
   * Devuelve el estado de cierre que corresponde a un codigo de socket.
   */
  private static resolveClosingStatus(closeCode: number): VoiceSessionClosingStatus {
    if (closeCode === VOICE_CLOSE_CODES.TENANT_SUSPENDED) {
      return 'TERMINATED_TENANT_SUSPENDED';
    }
    if (closeCode === VOICE_CLOSE_CODES.PAYMENT_REQUIRED) {
      return 'TERMINATED_INSUFFICIENT_FUNDS';
    }
    return 'COMPLETED_NORMAL';
  }

  /**
   * Comprueba si se puede admitir una nueva sesion respetando los topes globales y por organizacion (C1-59).
   */
  public canAcceptSession(organizationId: string): {
    readonly allowed: boolean;
    readonly closeCode?: number;
    readonly reason?: string;
  } {
    if (this.sessions.size >= this.maxGlobalSessions) {
      return {
        allowed: false,
        closeCode: VOICE_CLOSE_CODES.RATE_LIMITED,
        reason: 'Se excedio el limite global de sesiones simultaneas del gateway de voz.',
      };
    }

    const orgSessionCount = this.countForOrg(organizationId);
    if (orgSessionCount >= this.maxSessionsPerOrg) {
      return {
        allowed: false,
        closeCode: VOICE_CLOSE_CODES.RATE_LIMITED,
        reason: 'Se excedio el limite de sesiones de voz simultaneas para su organizacion.',
      };
    }

    return { allowed: true };
  }

  /**
   * Cuenta las sesiones activas de una organizacion especifica.
   */
  public countForOrg(organizationId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.organizationId === organizationId) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Incorpora una sesion viva al registro.
   */
  public add(liveSession: LiveVoiceSession): void {
    this.sessions.set(liveSession.voiceSessionId, liveSession);
  }

  /**
   * Retira una sesion del registro.
   */
  public remove(voiceSessionId: string): boolean {
    return this.sessions.delete(voiceSessionId);
  }

  /**
   * Indica si una sesion sigue viva.
   */
  public has(voiceSessionId: string): boolean {
    return this.sessions.has(voiceSessionId);
  }

  /**
   * Devuelve el numero total de sesiones vivas.
   */
  public count(): number {
    return this.sessions.size;
  }

  /**
   * Devuelve las sesiones vivas para su drenado.
   */
  public list(): readonly LiveVoiceSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Cierra todas las sesiones de una organizacion con el codigo indicado.
   */
  public async closeOrganizationSessions(organizationId: string, closeCode: number, reason: string): Promise<number> {
    let closedCount = 0;
    for (const liveSession of this.sessions.values()) {
      if (liveSession.organizationId !== organizationId) {
        continue;
      }
      await this.closeSession(liveSession.voiceSessionId, closeCode, reason);
      closedCount += 1;
    }
    return closedCount;
  }

  /**
   * Cierra una sesion concreta liquidando su consumo y cerrando su socket.
   */
  public async closeSession(voiceSessionId: string, closeCode: number, reason: string): Promise<boolean> {
    const liveSession = this.sessions.get(voiceSessionId);
    if (liveSession === undefined) {
      return false;
    }
    this.sessions.delete(voiceSessionId);

    const status = VoicePoolSessionRegistry.resolveClosingStatus(closeCode);
    try {
      if (liveSession.session.isSessionOpen()) {
        await liveSession.session.close(status, reason);
      }
    } catch {
      // La sesion ya cerro
    }

    try {
      if (liveSession.socket.readyState === liveSession.socket.OPEN) {
        liveSession.socket.close(closeCode, reason.slice(0, 120));
      }
    } catch {
      liveSession.socket.terminate();
    }
    return true;
  }

  /**
   * Cierra todas las sesiones vivas con motivo de apagado o emergencia.
   */
  public async closeAll(reason: string = 'Apagado ordenado del pool de voz.'): Promise<number> {
    let closedCount = 0;
    for (const voiceSessionId of [...this.sessions.keys()]) {
      await this.closeSession(voiceSessionId, 1001, reason);
      closedCount += 1;
    }
    return closedCount;
  }
}
