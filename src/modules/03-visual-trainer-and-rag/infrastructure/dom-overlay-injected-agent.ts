/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-injected-agent.ts
 * @modulo 03-visual-trainer-and-rag (Agente Instrumentador Inyectado en el Navegador Remoto)
 * @proposito
 *   Orquesta la instrumentacion del Chromium efimero a traves del Protocolo de Herramientas de
 *   Desarrollo (CDP): instala el overlay en cada documento nuevo, lo activa y lo apaga, recolecta
 *   los elementos etiquetables con su cascada de selectores, prueba un selector en vivo y calcula
 *   las cajas geometricas en los tres viewports oficiales. El desarrollador senala sobre la pagina
 *   REAL y el sistema devuelve metadatos estructurados, en lugar de tomar capturas ciegas que
 *   obligarian a adivinar coordenadas y selectores.
 *
 * @resumen_contenido
 *   - Interface `CdpCommandClient`: Contrato minimo del cliente CDP (inyectar y ejecutar).
 *   - Interface `ElementCollectionResult`: Ruta activa y elementos recolectados.
 *   - Interface `CapturedElementMetadata`: Metadatos validados del modal de etiquetado.
 *   - Interface `MultiViewportBoxes`: Cajas del elemento en escritorio, tableta y movil.
 *   - Clase `DomOverlayInjectedAgent`:
 *       * `installOnNewDocuments()`: Registra el instalador en cada documento nuevo, en mundo aislado.
 *       * `activateOverlay()` y `deactivateOverlay()`: Ciclo del modo captura.
 *       * `collectLabelableElements()`: Recoleccion de elementos del documento actual.
 *       * `highlightSelector()`: Prueba en vivo de un selector.
 *       * `captureMultiViewportBoxes()`: Cajas en los tres viewports oficiales.
 *       * `buildElementMetadata()`: Metadatos del modal de etiquetado funcional.
 *   - Funcion `buildTrainingSessionEventScript()`: Emisor de eventos del puntero hacia el visor.
 *
 * @dependencias_internas
 *   - `dom-overlay-scripts.ts`: Scripts autocontenidos, marcadores sensibles y viewports oficiales.
 *   - `cdp-payload-parsers.ts`: Validacion y normalizacion de las respuestas del navegador.
 *   - `cdp-isolated-world.ts`: Mundo aislado en el que vive el agente, fuera del alcance de la pagina.
 *   - `cdp-transport.port.ts`: Contrato del canal y opciones de contexto de ejecucion (C1-49).
 *
 * @dependencias_externas
 *   - `node:vm` (Compilacion de control del instalador antes de enviarlo al navegador).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements` (`primary_selector`, `*_bbox_json`, `selector_stability_score`).
 *   - PostgreSQL: `training_browser_sessions` (Estado del modo navegacion o captura overlay).
 */

import * as vm from 'node:vm';
import { CdpPayloadParser, type CapturedRoute, type ElementBoundingBox, type MappedElementDescriptor } from './cdp-payload-parsers';
import { OVERLAY_ISOLATED_WORLD_NAME, resolveOverlayIsolatedWorldContextId } from './cdp-isolated-world';
import type { CdpEvaluateOptions } from './cdp-transport.port';
import {
  OVERLAY_RUNTIME_ACTIVATE_SCRIPT,
  OVERLAY_RUNTIME_COLLECT_SCRIPT,
  OVERLAY_RUNTIME_DEACTIVATE_SCRIPT,
  OVERLAY_RUNTIME_HIGHLIGHT_SCRIPT,
  SENSITIVE_FIELD_MARKERS,
  VIEWPORT_PRESETS,
  buildOverlayInstallScript,
} from './dom-overlay-scripts';

export type { CapturedRoute, ElementBoundingBox, MappedElementDescriptor } from './cdp-payload-parsers';

/** Contrato minimo del cliente CDP que necesita el agente instrumentador. */
export interface CdpCommandClient {
  /**
   * Ejecuta un comando CDP y devuelve su resultado.
   *
   * @param method - Nombre del metodo CDP (por ejemplo `Page.addScriptToEvaluateOnNewDocument`).
   * @param params - Parametros del comando.
   * @returns Resultado devuelto por el navegador.
   */
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;

  /**
   * Ejecuta una expresion JavaScript en el contexto de la pagina y devuelve su valor.
   *
   * @param expression - Codigo a ejecutar, con los argumentos serializados como JSON.
   * @param args - Argumentos que se interpolan en la llamada.
   * @param options - Contexto de ejecucion destino (mundo aislado del agente).
   * @returns Valor devuelto por la pagina, ya deserializado.
   */
  evaluate(expression: string, args?: readonly unknown[], options?: CdpEvaluateOptions): Promise<unknown>;
}

/** Resultado de una recoleccion de elementos etiquetables. */
export interface ElementCollectionResult {
  /** Ruta activa en el momento de la recoleccion. */
  readonly route: CapturedRoute;
  /** Elementos etiquetables detectados. */
  readonly elements: readonly MappedElementDescriptor[];
}

/** Metadatos capturados y validados desde el modal de etiquetado funcional. */
export interface CapturedElementMetadata {
  /** Titulo funcional asignado por el desarrollador. */
  readonly title: string;
  /** Descripcion funcional que explica que hace el elemento. */
  readonly functionalDescription: string;
  /** Indica si el elemento ejecuta una accion fisica. */
  readonly isActionable: boolean;
  /** Naturaleza de la accion: clic, escritura o ambas. */
  readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
  /** Selector principal validado en vivo antes de guardarse. */
  readonly primarySelector: string;
  /** Puntaje de estabilidad calculado por el agente. */
  readonly selectorStabilityScore: number;
}

/** Cajas geometricas de un mismo elemento en los tres viewports oficiales. */
export interface MultiViewportBoxes {
  /** Caja medida con el viewport de escritorio (1440x900). */
  readonly desktop: ElementBoundingBox;
  /** Caja medida con el viewport de tableta (768x1024). */
  readonly tablet: ElementBoundingBox;
  /** Caja medida con el viewport de movil (390x844). */
  readonly mobile: ElementBoundingBox;
}

/** Datos capturados en el modal de etiquetado funcional del desarrollador. */
export interface ElementTaggingInput {
  /** Titulo funcional asignado por el desarrollador. */
  readonly title: string;
  /** Descripcion funcional que explica que hace el elemento. */
  readonly functionalDescription: string;
  /** Indica si el elemento ejecuta una accion fisica. */
  readonly isActionable: boolean;
  /** Naturaleza de la accion: clic, escritura o ambas. */
  readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
}

/** Parametros de construccion del agente instrumentador. */
export interface DomOverlayInjectedAgentOptions {
  /** Cliente CDP del navegador remoto. */
  readonly cdpClient: CdpCommandClient;
  /** Limite maximo de elementos etiquetables por recoleccion. */
  readonly maxElementsPerCollection?: number;
}

/** Limite por omision de elementos etiquetables por recoleccion. */
const DEFAULT_MAX_ELEMENTS = 200;

/** Longitudes admitidas de los textos del modal de etiquetado. */
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MIN_LENGTH = 10;
const DESCRIPTION_MAX_LENGTH = 1200;

/** Script que mide la caja geometrica de un selector en el viewport activo. */
const MEASURE_SELECTOR_SCRIPT = `
(function measureForOnboardingAssistant(selector) {
  var element = document.querySelector(selector);
  if (!element) { return null; }
  var rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
})
`;

/**
 * Agente instrumentador del navegador remoto.
 * Encapsula todos los comandos CDP necesarios para operar el overlay y devuelve siempre datos
 * tipados y validados: si el navegador responde con una forma inesperada, se lanza un error
 * explicito en lugar de propagar `undefined` hacia los casos de uso.
 */
export class DomOverlayInjectedAgent {
  private readonly cdpClient: CdpCommandClient;
  private readonly maxElementsPerCollection: number;

  /**
   * @param options - Cliente CDP y limites de recoleccion.
   */
  public constructor(options: DomOverlayInjectedAgentOptions) {
    this.cdpClient = options.cdpClient;
    this.maxElementsPerCollection = options.maxElementsPerCollection ?? DEFAULT_MAX_ELEMENTS;
  }

  /**
   * Registra el instalador del overlay en cada documento nuevo y en el documento actual.
   * El registro debe ocurrir ANTES de navegar: de lo contrario la primera pagina no tendria overlay.
   * El instalador se registra en un MUNDO AISLADO (`worldName`): en el mundo principal la pagina
   * hostil podia leer el agente, sobrescribirlo y devolver metadatos falsos que el backend aceptaba
   * y persistia en el mapa funcional (C1-49).
   *
   * @returns Identificador del script registrado y numero de marcadores sensibles aplicados.
   * @throws Error cuando el instalador no compila, el navegador no confirma el registro o no puede
   *   crearse el mundo aislado del agente.
   */
  public async installOnNewDocuments(): Promise<{ readonly scriptIdentifier: string; readonly sensitiveMarkers: number }> {
    const installScript = buildOverlayInstallScript();

    // El codigo se compila en un contexto aislado antes de enviarlo: un error de sintaxis en el
    // instalador dejaria la sesion sin overlay y solo se detectaria al primer clic del usuario.
    const compiled = new vm.Script(installScript);
    void compiled;

    const response = await this.cdpClient.send('Page.addScriptToEvaluateOnNewDocument', {
      source: installScript,
      worldName: OVERLAY_ISOLATED_WORLD_NAME,
    });
    const scriptIdentifier = CdpPayloadParser.extractStringField(response, 'identifier');
    if (scriptIdentifier === null) {
      throw new Error('OVERLAY_INSTALACION_FALLIDA: el navegador no devolvio el identificador del script registrado.');
    }

    await this.evaluateInOverlayWorld(installScript);
    return { scriptIdentifier, sensitiveMarkers: SENSITIVE_FIELD_MARKERS.length };
  }

  /**
   * Activa el modo captura: dibuja los marcadores numerados sobre los elementos etiquetables.
   *
   * @returns Numero de marcadores dibujados y los elementos recolectados.
   * @throws Error cuando el agente no esta instalado en la pagina activa.
   */
  public async activateOverlay(): Promise<{ readonly rendered: number; readonly collection: ElementCollectionResult }> {
    const rawResult = await this.evaluateInOverlayWorld(OVERLAY_RUNTIME_ACTIVATE_SCRIPT, [this.maxElementsPerCollection]);
    const record = CdpPayloadParser.asRecord(rawResult);
    if (record?.['ok'] !== true) {
      throw new Error(`OVERLAY_ACTIVACION_FALLIDA: ${String(record?.['reason'] ?? 'el agente no esta instalado en esta pagina')}`);
    }

    const elements = CdpPayloadParser.parseElements(record['elements']);
    return {
      rendered: CdpPayloadParser.asNumber(record['rendered']) ?? elements.length,
      collection: { route: CdpPayloadParser.parseRoute(record['route']), elements },
    };
  }

  /**
   * Desactiva el modo captura y elimina los marcadores del documento.
   *
   * @throws Error cuando el agente no esta instalado en la pagina activa.
   */
  public async deactivateOverlay(): Promise<void> {
    const rawResult = await this.evaluateInOverlayWorld(OVERLAY_RUNTIME_DEACTIVATE_SCRIPT);
    if (CdpPayloadParser.asRecord(rawResult)?.['ok'] !== true) {
      throw new Error('OVERLAY_DESACTIVACION_FALLIDA: el agente no esta instalado en esta pagina.');
    }
  }

  /**
   * Recolecta los elementos etiquetables del documento actual sin dibujar marcadores.
   *
   * @returns Ruta activa y elementos detectados con su cascada de selectores.
   * @throws Error cuando el agente no esta instalado en la pagina activa.
   */
  public async collectLabelableElements(): Promise<ElementCollectionResult> {
    const rawResult = await this.evaluateInOverlayWorld(OVERLAY_RUNTIME_COLLECT_SCRIPT, [this.maxElementsPerCollection]);
    const record = CdpPayloadParser.asRecord(rawResult);
    if (record?.['ok'] !== true) {
      throw new Error(`OVERLAY_RECOLECCION_FALLIDA: ${String(record?.['reason'] ?? 'el agente no esta instalado en esta pagina')}`);
    }
    return { route: CdpPayloadParser.parseRoute(record['route']), elements: CdpPayloadParser.parseElements(record['elements']) };
  }

  /**
   * Resalta un selector durante dos segundos para validarlo en vivo.
   *
   * @param selector - Selector CSS a probar.
   * @returns Descriptor del elemento resaltado, o `null` si el selector no resuelve, es sensible o
   *   el agente no esta instalado.
   */
  public async highlightSelector(selector: string): Promise<MappedElementDescriptor | null> {
    const rawResult = await this.evaluateInOverlayWorld(OVERLAY_RUNTIME_HIGHLIGHT_SCRIPT, [selector]);
    const record = CdpPayloadParser.asRecord(rawResult);
    if (record?.['ok'] !== true) {
      return null;
    }
    return CdpPayloadParser.parseElements([record['descriptor']])[0] ?? null;
  }

  /**
   * Calcula las cajas geometricas del elemento en los tres viewports oficiales.
   * El viewport original se restaura SIEMPRE, incluso si una medicion falla, para no dejar la sesion
   * del desarrollador con una resolucion inesperada.
   *
   * @param selector - Selector estable del elemento a medir.
   * @param originalViewport - Dimensiones del viewport que debe restaurarse al terminar.
   * @returns Cajas medidas en escritorio, tableta y movil.
   * @throws Error cuando el selector no puede medirse en el viewport de escritorio.
   */
  public async captureMultiViewportBoxes(
    selector: string,
    originalViewport: { readonly width: number; readonly height: number }
  ): Promise<MultiViewportBoxes> {
    const measurements = new Map<string, ElementBoundingBox>();

    try {
      for (const preset of VIEWPORT_PRESETS) {
        await this.cdpClient.send('Emulation.setDeviceMetricsOverride', {
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: 1,
          mobile: preset.name === 'mobile',
        });
        const measured = await this.measureSelectorBox(selector);
        if (measured !== null) {
          measurements.set(preset.name, measured);
        }
      }
    } finally {
      await this.cdpClient.send('Emulation.setDeviceMetricsOverride', {
        width: originalViewport.width,
        height: originalViewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    const desktopBox = measurements.get('desktop');
    if (desktopBox === undefined) {
      throw new Error(`MEDICION_GEOMETRICA_FALLIDA: el selector "${selector}" no pudo medirse en el viewport de escritorio.`);
    }

    return {
      desktop: desktopBox,
      tablet: measurements.get('tablet') ?? desktopBox,
      mobile: measurements.get('mobile') ?? desktopBox,
    };
  }

  /**
   * Compone los metadatos del modal de etiquetado funcional del desarrollador.
   * Valida la coherencia entre la accion declarada y la accion deducida por el agente: un elemento
   * marcado como accionable debe declarar al menos una accion fisica y viceversa.
   *
   * @param input - Datos capturados en el modal.
   * @param descriptor - Descriptor del elemento seleccionado en el overlay.
   * @returns Metadatos validados y listos para persistir en `map_elements`.
   * @throws Error cuando los datos del modal son incoherentes.
   */
  public buildElementMetadata(input: ElementTaggingInput, descriptor: MappedElementDescriptor): CapturedElementMetadata {
    const title = input.title.trim();
    const functionalDescription = input.functionalDescription.trim();

    if (title.length < TITLE_MIN_LENGTH || title.length > TITLE_MAX_LENGTH) {
      throw new Error(
        `ETIQUETADO_INVALIDO: el titulo funcional debe tener entre ${TITLE_MIN_LENGTH} y ${TITLE_MAX_LENGTH} caracteres.`
      );
    }
    if (functionalDescription.length < DESCRIPTION_MIN_LENGTH || functionalDescription.length > DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `ETIQUETADO_INVALIDO: la descripcion funcional debe tener entre ${DESCRIPTION_MIN_LENGTH} y ${DESCRIPTION_MAX_LENGTH} caracteres.`
      );
    }
    if (input.isActionable && input.actionType === 'NONE') {
      throw new Error('ETIQUETADO_INVALIDO: un elemento accionable debe declarar clic, escritura o ambas.');
    }
    if (!input.isActionable && input.actionType !== 'NONE') {
      throw new Error('ETIQUETADO_INVALIDO: un elemento no accionable no puede declarar una accion fisica.');
    }

    return {
      title,
      functionalDescription,
      isActionable: input.isActionable,
      actionType: input.actionType,
      primarySelector: descriptor.primarySelector,
      selectorStabilityScore: descriptor.selectorStabilityScore,
    };
  }

  /**
   * Ejecuta una expresion DENTRO del mundo aislado del agente (C1-49).
   *
   * El mundo se resuelve en cada ejecucion porque su contexto cambia con cada navegacion. Si el
   * navegador no lo confirma, la ejecucion falla de forma explicita: degradar al mundo principal
   * devolveria el agente al alcance de la pagina hostil, que puede leerlo, sobrescribirlo y
   * devolver metadatos falsos que el backend aceptaria y persistiria.
   *
   * @param expression - Script autocontenido a ejecutar.
   * @param args - Argumentos que se anexan como llamada a la funcion.
   * @returns Valor devuelto por el mundo aislado, ya deserializado.
   * @throws Error cuando el navegador no puede crear el mundo aislado del agente.
   */
  private async evaluateInOverlayWorld(expression: string, args: readonly unknown[] = []): Promise<unknown> {
    const executionContextId = await resolveOverlayIsolatedWorldContextId(this.cdpClient);
    return this.cdpClient.evaluate(expression, args, { executionContextId });
  }

  /**
   * Mide la caja geometrica de un selector en el viewport activo.
   *
   * @param selector - Selector CSS a medir.
   * @returns Caja medida, o `null` si el selector no resuelve en la pagina.
   */
  private async measureSelectorBox(selector: string): Promise<ElementBoundingBox | null> {
    const rawResult = await this.evaluateInOverlayWorld(MEASURE_SELECTOR_SCRIPT, [selector]);
    if (rawResult === null || rawResult === undefined) {
      return null;
    }
    return CdpPayloadParser.parseBoundingBox(rawResult);
  }
}

/**
 * Construye el script que emite hacia el visor web los eventos del puntero del desarrollador.
 * El visor reenvia estas coordenadas al adaptador CDP, que las traduce a `Input.dispatchMouseEvent`.
 *
 * @returns Codigo JavaScript autocontenido para `Page.addScriptToEvaluateOnNewDocument`.
 */
export function buildTrainingSessionEventScript(): string {
  return `
(function bridgeOnboardingAssistantPointer() {
  if (window.__OA_POINTER_BRIDGE__) { return; }
  window.__OA_POINTER_BRIDGE__ = true;
  function notify(kind, event) {
    var payload = {
      kind: kind,
      clientX: Math.round(event.clientX || 0),
      clientY: Math.round(event.clientY || 0),
      routePath: window.location.pathname,
      occurredAtIso: new Date().toISOString(),
    };
    if (window.__OA_EMIT__) { window.__OA_EMIT__(payload); }
  }
  document.addEventListener('click', function (event) { notify('CLICK', event); }, true);
  document.addEventListener('input', function (event) {
    var target = event.target;
    if (target && target.getAttribute && target.getAttribute('data-oa-sensitive') === 'true') { return; }
    if (target && target.type === 'password') { return; }
    notify('INPUT', event);
  }, true);
  document.addEventListener('scroll', function () { notify('SCROLL', { clientX: 0, clientY: window.scrollY }); }, { passive: true });
})();
`.trim();
}
