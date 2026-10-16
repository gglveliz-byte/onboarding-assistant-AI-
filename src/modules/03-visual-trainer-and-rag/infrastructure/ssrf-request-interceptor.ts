/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/ssrf-request-interceptor.ts
 * @modulo 03-visual-trainer-and-rag (Decisor de Interceptacion de Red del Navegador Efimero)
 * @proposito
 *   Decide la suerte de cada peticion de red que emite el navegador de entrenamiento. El navegador
 *   es un entorno hostil por definicion: la pagina que se esta entrenando puede intentar alcanzar
 *   los servicios de metadatos de la nube o la red interna del host mediante una imagen, un `fetch`
 *   o una hoja de estilo. Este decisor pasa CADA peticion por el escudo Anti-SSRF, acumula el
 *   contador de bloqueos de la sesion y devuelve la instruccion exacta que el canal aplicara.
 *
 * @resumen_contenido
 *   - Interface `InterceptionDecision`: Instruccion de permitir o abortar con su motivo.
 *   - Interface `InterceptionCounter`: Contador de bloqueos por sesion de entrenamiento.
 *   - Clase `SsrfRequestInterceptor`:
 *       * `decide()`: Evalua una peticion contra el escudo Anti-SSRF.
 *       * `blockedCountFor()`: Consulta los bloqueos acumulados de una sesion.
 *       * `resetCounters()`: Limpia los contadores al cerrar sesiones.
 *
 * @dependencias_internas
 *   - `PinnedDnsSsrfGuard` (`./pinned-dns-ssrf.guard.ts`) para la validacion de destinos.
 *   - `CdpInterceptedRequest` (`./cdp-websocket-connection.ts`) como forma de la peticion.
 *   - `SsrfBlockedIpError` (`src/shared/kernel/result-and-errors.ts`) para el motivo del bloqueo.
 *
 * @dependencias_externas
 *   - Ninguna (Logica pura de decision, sin transporte ni acceso a datos).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions.ssrf_blocked_attempts_count` (Contador por sesion).
 *   - PostgreSQL: `audit_logs` (El escudo registra cada bloqueo con severidad critica).
 */

import { SsrfBlockedIpError } from '../../../shared/kernel/result-and-errors';
import type { CdpInterceptedRequest } from './cdp-websocket-connection';
import type { PinnedDnsSsrfGuard } from './pinned-dns-ssrf.guard';

/** Instruccion que el canal de depuracion aplica sobre una peticion interceptada. */
export interface InterceptionDecision {
  /** Indica si la peticion debe continuar hacia la red. */
  readonly allow: boolean;
  /** Motivo de la decision, registrado en auditoria cuando se aborta. */
  readonly reason: string;
}

/** Contexto multi-tenant necesario para registrar los bloqueos con trazabilidad. */
export interface InterceptionContext {
  /** Organizacion propietaria de la sesion de entrenamiento. */
  readonly organizationId: string;
  /** Proyecto cuyo mapa funcional se esta entrenando. */
  readonly projectId: string;
  /** Identificador de la sesion de entrenamiento. */
  readonly trainingSessionId: string;
}

/**
 * Traduce el motivo del bloqueo al codigo de error de red que espera el navegador.
 * El codigo elegido determina como el sitio web percibe el bloqueo: una conexion rechazada para
 * puertos prohibidos y un acceso denegado para esquemas no autorizados.
 *
 * @param reason - Etiqueta del motivo del bloqueo.
 * @returns Codigo de error de red del protocolo de herramientas de desarrollo.
 */
export function mapBlockReasonToCdpError(reason: string): string {
  if (reason.includes('PUERTO')) {
    return 'ConnectionRefused';
  }
  if (reason.includes('ESQUEMA')) {
    return 'AccessDenied';
  }
  return 'AddressUnreachable';
}

/**
 * Decisor de interceptacion con contador de bloqueos por sesion.
 * Un bloqueo nunca lanza una excepcion hacia el canal: la peticion se aborta y la sesion continua,
 * porque abortar una imagen no debe interrumpir el trabajo del desarrollador.
 */
export class SsrfRequestInterceptor {
  private readonly ssrfGuard: PinnedDnsSsrfGuard;
  private readonly blockedCounters = new Map<string, number>();

  /**
   * @param ssrfGuard - Escudo Anti-SSRF que valida cada destino.
   */
  public constructor(ssrfGuard: PinnedDnsSsrfGuard) {
    this.ssrfGuard = ssrfGuard;
  }

  /**
   * Evalua una peticion interceptada contra el escudo Anti-SSRF.
   *
   * @param request - Peticion de red emitida por el navegador.
   * @param context - Organizacion, proyecto y sesion para el registro de auditoria.
   * @returns Decision de permitir o abortar con su motivo.
   */
  public async decide(request: CdpInterceptedRequest, context: InterceptionContext): Promise<InterceptionDecision> {
    // Los esquemas internos del navegador (`about:`, `data:`, `blob:`, `devtools:`) no salen a la
    // red: bloquearlos romperia la pagina sin aportar ninguna proteccion real.
    if (this.isInternalBrowserScheme(request.url)) {
      return { allow: true, reason: 'ESQUEMA_INTERNO_DEL_NAVEGADOR' };
    }

    try {
      const validated = await this.ssrfGuard.validateSecondaryRequest(request.url, {
        organizationId: context.organizationId,
        projectId: context.projectId,
      });

      if (validated !== null) {
        return { allow: true, reason: 'DESTINO_VALIDADO' };
      }

      this.incrementBlockedCounter(context.trainingSessionId);
      return { allow: false, reason: 'BLOQUEADO_POR_ESCUDO_ANTI_SSRF' };
    } catch (error) {
      this.incrementBlockedCounter(context.trainingSessionId);
      if (error instanceof SsrfBlockedIpError) {
        const reason = error.context.details?.['reason'];
        return { allow: false, reason: typeof reason === 'string' ? reason : 'DESTINO_PROHIBIDO' };
      }
      return { allow: false, reason: 'FALLO_DE_VALIDACION_DE_DESTINO' };
    }
  }

  /**
   * Consulta los bloqueos acumulados por una sesion de entrenamiento.
   *
   * @param trainingSessionId - Sesion consultada.
   * @returns Numero de peticiones bloqueadas desde el inicio de la sesion.
   */
  public blockedCountFor(trainingSessionId: string): number {
    return this.blockedCounters.get(trainingSessionId) ?? 0;
  }

  /**
   * Limpia el contador de una sesion cerrada para no acumular estado indefinidamente.
   *
   * @param trainingSessionId - Sesion cuyo contador se elimina.
   */
  public resetCounters(trainingSessionId: string): void {
    this.blockedCounters.delete(trainingSessionId);
  }

  /**
   * Determina si una URL pertenece a un esquema interno del navegador que nunca sale a la red.
   *
   * @param rawUrl - URL de la peticion.
   * @returns `true` cuando el esquema es interno del navegador.
   */
  private isInternalBrowserScheme(rawUrl: string): boolean {
    const normalized = rawUrl.trim().toLowerCase();
    return (
      normalized.startsWith('about:') ||
      normalized.startsWith('data:') ||
      normalized.startsWith('blob:') ||
      normalized.startsWith('devtools:') ||
      normalized.startsWith('chrome:') ||
      normalized.startsWith('chrome-extension:')
    );
  }

  /**
   * Incrementa el contador de bloqueos de una sesion.
   *
   * @param trainingSessionId - Sesion cuyo contador se incrementa.
   */
  private incrementBlockedCounter(trainingSessionId: string): void {
    this.blockedCounters.set(trainingSessionId, this.blockedCountFor(trainingSessionId) + 1);
  }
}
