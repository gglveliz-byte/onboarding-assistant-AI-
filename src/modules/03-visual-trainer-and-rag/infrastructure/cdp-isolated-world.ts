/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/cdp-isolated-world.ts
 * @modulo 03-visual-trainer-and-rag (Mundo Aislado del Agente Instrumentador - C1-49)
 * @proposito
 *   Saca al agente instrumentador del mundo principal de la pagina entrenada. El instalador se
 *   registraba sin `worldName` y todas las ejecuciones viajaban con `Runtime.evaluate` sin contexto,
 *   de modo que el agente vivia en el MISMO mundo JavaScript que la pagina hostil: la pagina podia
 *   leer `window.__OA_TRAINER__`, sobrescribirlo y devolver metadatos falsos que el backend aceptaba
 *   y persistia en el mapa funcional. Este modulo resuelve el identificador del contexto de
 *   ejecucion de un mundo aislado para que el instalador y cada ejecucion del agente ocurran en un
 *   mundo propio, invisible e insobrescribible desde el JavaScript del sitio.
 *
 *   Aislamiento conseguido: un mundo aislado comparte el DOM (el agente sigue midiendo cajas y
 *   leyendo atributos reales) pero NO comparte los objetos JavaScript de la pagina; por eso la
 *   pagina no puede ver ni reemplazar al agente, y `grantUniveralAccess: false` impide ademas que el
 *   mundo del agente alcance las variables del mundo principal.
 *
 * @resumen_contenido
 *   - Constante `OVERLAY_ISOLATED_WORLD_NAME`: Nombre canonico del mundo aislado del overlay.
 *   - Interface `CdpIsolatedWorldClient`: Contrato minimo del canal (enviar comandos).
 *   - Funcion `resolveOverlayIsolatedWorldContextId()`: Resuelve el contexto de ejecucion aislado.
 *
 * @dependencias_internas
 *   - `CdpPayloadParser` (`./cdp-payload-parsers.ts`): Analisis defensivo de la respuesta del navegador.
 *
 * @dependencias_externas
 *   - Ninguna (Solo comandos del protocolo de depuracion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements` (Los metadatos persistidos dejan de ser falsificables por la pagina).
 */

import { CdpPayloadParser } from './cdp-payload-parsers';

/**
 * Nombre canonico del mundo aislado en el que vive el agente instrumentador.
 * Se usa en `Page.addScriptToEvaluateOnNewDocument` (registro por documento nuevo) y en
 * `Page.createIsolatedWorld` (contexto del documento actual): ambos deben coincidir para que el
 * agente instalado y las ejecuciones posteriores sean el mismo mundo.
 */
export const OVERLAY_ISOLATED_WORLD_NAME = '__oa_trainer_isolated_world__';

/** Contrato minimo del canal de depuracion que necesita la resolucion del mundo aislado. */
export interface CdpIsolatedWorldClient {
  /**
   * Envia un comando del protocolo de depuracion y devuelve su resultado.
   *
   * @param method - Nombre del metodo del protocolo.
   * @param params - Parametros del comando.
   * @returns Resultado devuelto por el navegador.
   */
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Resuelve el identificador del contexto de ejecucion del mundo aislado del overlay.
 *
 * Se resuelve en cada uso, y no una sola vez, porque el identificador de contexto cambia con cada
 * navegacion del documento: cachearlo haria que las ejecuciones posteriores a una navegacion
 * apuntaran a un contexto destruido o, peor, cayera al mundo principal. Si el navegador no confirma
 * la creacion del mundo aislado se falla de forma explicita: degradar al mundo principal devolveria
 * el agente al alcance de la pagina, que es justo el defecto que esta funcion corrige.
 *
 * @param client - Canal de depuracion del navegador de la sesion.
 * @returns Identificador del contexto de ejecucion aislado.
 * @throws Error cuando el navegador no expone el marco o no crea el mundo aislado.
 */
export async function resolveOverlayIsolatedWorldContextId(client: CdpIsolatedWorldClient): Promise<number> {
  const frameTreeResponse = await client.send('Page.getFrameTree');
  const frameTree = CdpPayloadParser.asRecord(CdpPayloadParser.asRecord(frameTreeResponse)?.['frameTree']);
  const frameId = CdpPayloadParser.extractStringField(frameTree?.['frame'], 'id');
  if (frameId === null) {
    throw new Error(
      'MUNDO_AISLADO_NO_RESUELTO: el navegador no informo el marco activo, de modo que no puede crearse el mundo aislado del agente.'
    );
  }

  const createdWorld = await client.send('Page.createIsolatedWorld', {
    frameId,
    worldName: OVERLAY_ISOLATED_WORLD_NAME,
    grantUniveralAccess: false,
  });

  const executionContextId = CdpPayloadParser.asNumber(CdpPayloadParser.asRecord(createdWorld)?.['executionContextId']);
  if (executionContextId === null) {
    throw new Error(
      'MUNDO_AISLADO_NO_RESUELTO: el navegador no devolvio el contexto del mundo aislado; el agente no se ejecuta en el mundo principal de la pagina.'
    );
  }

  return executionContextId;
}
