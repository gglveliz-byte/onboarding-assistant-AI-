/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/cdp-target-discovery.ts
 * @modulo 03-visual-trainer-and-rag (Descubrimiento del Punto de Depuracion del Navegador)
 * @proposito
 *   Consulta el punto de depuracion HTTP que expone el navegador efimero para localizar la pestana
 *   que se va a gobernar. Sin este paso no es posible abrir el canal del Protocolo de Herramientas
 *   de Desarrollo: el contenedor publica un puerto aleatorio y la URL del WebSocket de cada pestana
 *   solo se conoce tras preguntar al propio navegador. Se a isla en su propio modulo para que el
 *   transporte del protocolo no dependa del descubrimiento ni viceversa.
 *
 * @resumen_contenido
 *   - Interface `CdpTargetInfo`: Descripcion del punto de depuracion de una pestana.
 *   - Funcion `discoverActiveCdpTarget()`: Localiza la primera pestana inspeccionable.
 *   - Funcion `listCdpTargets()`: Enumera todos los destinos disponibles para diagnostico.
 *
 * @dependencias_internas
 *   - `ProviderUnavailableError` (`src/shared/kernel/result-and-errors.ts`) para fallos de canal.
 *
 * @dependencias_externas
 *   - `fetch` nativo del runtime (Consulta HTTP al punto de depuracion del navegador).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (El destino descubierto sostiene la sesion activa).
 */

import { ProviderUnavailableError } from '../../../shared/kernel/result-and-errors';

/** Descripcion del punto de depuracion de una pestana del navegador. */
export interface CdpTargetInfo {
  /** Identificador interno de la pestana. */
  readonly targetId: string;
  /** Tipo de destino (`page`, `iframe`, `worker`). */
  readonly type: string;
  /** Titulo del documento cargado. */
  readonly title: string;
  /** URL cargada en el destino. */
  readonly url: string;
  /** URL del WebSocket de depuracion del destino. */
  readonly webSocketDebuggerUrl: string;
}

/** Tiempo maximo de espera de la consulta al punto de depuracion, en milisegundos. */
const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Enumera todos los destinos de depuracion que expone el navegador.
 *
 * @param debuggerBaseUrl - URL base del punto de depuracion (por ejemplo `http://127.0.0.1:9222`).
 * @returns Lista de destinos disponibles, ordenada tal como la entrega el navegador.
 * @throws ProviderUnavailableError cuando el punto de depuracion no responde o devuelve un error.
 */
export async function listCdpTargets(debuggerBaseUrl: string): Promise<readonly CdpTargetInfo[]> {
  let response: Response;
  try {
    response = await fetch(`${debuggerBaseUrl.replace(/\/$/u, '')}/json/list`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      'PRIMARY',
      `el punto de depuracion no respondio: ${error instanceof Error ? error.message : 'error de red'}`
    );
  }

  if (!response.ok) {
    throw new ProviderUnavailableError('PRIMARY', `el punto de depuracion respondio con el estado ${response.status}`);
  }

  const rawTargets = (await response.json()) as readonly Record<string, unknown>[];
  return rawTargets.map((target) => ({
    targetId: typeof target['id'] === 'string' ? target['id'] : 'desconocido',
    type: typeof target['type'] === 'string' ? target['type'] : 'desconocido',
    title: typeof target['title'] === 'string' ? target['title'] : '',
    url: typeof target['url'] === 'string' ? target['url'] : 'about:blank',
    webSocketDebuggerUrl: typeof target['webSocketDebuggerUrl'] === 'string' ? target['webSocketDebuggerUrl'] : '',
  }));
}

/**
 * Localiza la primera pestana inspeccionable del navegador efimero.
 *
 * @param debuggerBaseUrl - URL base del punto de depuracion.
 * @returns Informacion de la pestana que se va a gobernar.
 * @throws ProviderUnavailableError cuando no hay ninguna pestana con canal de depuracion utilizable.
 */
export async function discoverActiveCdpTarget(debuggerBaseUrl: string): Promise<CdpTargetInfo> {
  const targets = await listCdpTargets(debuggerBaseUrl);
  const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl.length > 0);

  if (pageTarget === undefined) {
    throw new ProviderUnavailableError('PRIMARY', 'el navegador no expone ninguna pestana inspeccionable con canal de depuracion');
  }
  return pageTarget;
}
