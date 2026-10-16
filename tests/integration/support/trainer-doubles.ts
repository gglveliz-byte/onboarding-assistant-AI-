/**
 * @archivo tests/integration/support/trainer-doubles.ts
 * @modulo 03-visual-trainer-and-rag (Dobles de Prueba del Entrenamiento Visual)
 * @proposito
 *   Concentra los dobles que sustituyen los bordes externos del entrenamiento visual: el runtime de
 *   contenedores, el transporte del protocolo de desarrollo y los descriptores de elemento. El
 *   codigo de produccion bajo prueba (adaptador, decisor Anti-SSRF y casos de uso) se ejecuta intacto;
 *   solo se reemplaza lo que requeriria un motor de contenedores y un navegador reales.
 *
 * @resumen_contenido
 *   - Clase `FakeCdpTransport`: Transporte simulado con inyeccion de peticiones interceptadas.
 *   - Objeto `runtimeLog`: Registro de contenedores creados y destruidos.
 *   - Funcion `createMockContainerRuntime()`: Runtime de contenedores simulado.
 *   - Funcion `installFakeTargetDiscovery()`: Descubrimiento de pestana simulado.
 *   - Funcion `createMockOverlayDescriptor()`: Descriptor de elemento reutilizable.
 *   - Funcion `createSpiedOverlayAgent()`: Agente real con bordes de navegador espiados.
 *
 * @dependencias_internas
 *   - `CdpTransport` y `BrowserContainerRuntime` de los puertos del modulo de entrenamiento.
 *   - `DomOverlayInjectedAgent` y `SENSITIVE_FIELD_MARKERS` de la infraestructura del modulo.
 *
 * @dependencias_externas
 *   - `node:assert` no se usa aqui: los dobles no asertan, solo simulan.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Dobles de prueba: no acceden a datos reales).
 */

import type { ElementBoundingBox } from '../../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-payload-parsers';
import type {
  CdpEventSubscription,
  CdpInterceptedRequest,
  CdpInterceptionDecision,
  CdpTransport,
} from '../../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-transport.port';
import type {
  BrowserContainerRuntime,
  BrowserContainerSpec,
} from '../../../src/modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime';
import { DomOverlayInjectedAgent, type MappedElementDescriptor } from '../../../src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-injected-agent';
import { SENSITIVE_FIELD_MARKERS } from '../../../src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-scripts';

/** Transporte simulado que registra cada comando y permite inyectar peticiones interceptadas. */
export class FakeCdpTransport implements CdpTransport {
  /** Indica si el canal fue abierto por la aplicacion. */
  public isConnected = false;

  /** Metodos del protocolo invocados, en orden. */
  public readonly sentMethods: string[] = [];

  /** Indica si la aplicacion cerro el canal. */
  public closed = false;

  /** Interceptor registrado por el adaptador. */
  private interceptor: ((request: CdpInterceptedRequest) => Promise<CdpInterceptionDecision>) | undefined;

  /**
   * @param evaluateResult - Valor que devolvera `evaluate()` en cada llamada.
   */
  public constructor(private readonly evaluateResult: unknown = { ok: true, rendered: 3, elements: [] }) {}

  /** Abre el canal simulado. */
  public async connect(): Promise<void> {
    this.isConnected = true;
  }

  /**
   * Registra el comando enviado y devuelve una respuesta vacia.
   *
   * @param method - Nombre del metodo del protocolo.
   * @returns Resultado vacio del navegador simulado.
   */
  public async send(method: string): Promise<Record<string, unknown>> {
    this.sentMethods.push(method);
    return {};
  }

  /**
   * Devuelve el valor configurado para las ejecuciones de script.
   *
   * @returns Valor simulado de la ejecucion.
   */
  public async evaluate(): Promise<unknown> {
    return this.evaluateResult;
  }

  /**
   * Devuelve una suscripcion inerte.
   *
   * @returns Suscripcion sin efecto.
   */
  public onEvent(): CdpEventSubscription {
    return { eventName: 'sin-uso', cancel: (): void => undefined };
  }

  /**
   * Registra el interceptor Anti-SSRF del adaptador.
   *
   * @param interceptor - Funcion que decide si una peticion se permite o se aborta.
   */
  public async enableRequestInterception(
    interceptor: (request: CdpInterceptedRequest) => Promise<CdpInterceptionDecision>
  ): Promise<void> {
    this.interceptor = interceptor;
    this.sentMethods.push('Fetch.enable');
  }

  /** Registra el reenvio de un clic del desarrollador. */
  public async dispatchMouseClick(): Promise<void> {
    this.sentMethods.push('Input.dispatchMouseEvent');
  }

  /** Registra el reenvio de un texto del desarrollador. */
  public async dispatchKeyText(): Promise<void> {
    this.sentMethods.push('Input.insertText');
  }

  /** Cierra el canal simulado. */
  public async close(): Promise<void> {
    this.closed = true;
    this.isConnected = false;
  }

  /**
   * Inyecta una peticion interceptada y devuelve la decision tomada por el escudo.
   *
   * @param url - URL de la peticion simulada.
   * @returns Decision de permitir o abortar.
   * @throws Error cuando el adaptador aun no registro el interceptor.
   */
  public async simulateRequest(url: string): Promise<CdpInterceptionDecision> {
    if (this.interceptor === undefined) {
      throw new Error('El transporte simulado no tiene interceptor registrado.');
    }
    // El campo se llama `requestId`, que es el nombre que emite el navegador de verdad. Conviene
    // tener presente que este doble entrega la peticion DIRECTAMENTE al decisor del escudo: valida
    // las reglas de decision, pero **no** el camino del protocolo. Para eso existe
    // `tests/integration/cdp-interception-protocol.test.ts`, que ejercita la conexion real contra un
    // navegador simulado. Confiar solo en este doble fue lo que oculto que el escudo no llegaba a
    // decidir en produccion.
    return this.interceptor({ requestId: `int-${this.sentMethods.length}`, url, method: 'GET', resourceType: 'Other' });
  }
}

/** Registro de las operaciones realizadas por el runtime de contenedores simulado. */
export const runtimeLog: { started: BrowserContainerSpec[]; destroyed: string[] } = { started: [], destroyed: [] };

/** Limpia el registro de contenedores entre casos de prueba. */
export function resetRuntimeLog(): void {
  runtimeLog.started.length = 0;
  runtimeLog.destroyed.length = 0;
}

/**
 * Construye un runtime de contenedores simulado que registra cada operacion.
 * El identificador del contenedor es su propio nombre porque el adaptador destruye por nombre.
 *
 * @returns Runtime con los contenedores creados y destruidos accesibles para las aserciones.
 */
export function createMockContainerRuntime(): BrowserContainerRuntime {
  return {
    startContainer: async (spec: BrowserContainerSpec) => {
      runtimeLog.started.push(spec);
      return { containerId: spec.containerName, debuggerBaseUrl: 'http://127.0.0.1:9222' };
    },
    destroyContainer: async (containerId: string) => {
      runtimeLog.destroyed.push(containerId);
    },
  };
}

/**
 * Sustituye el descubrimiento del punto de depuracion por una respuesta simulada.
 *
 * @returns Funcion que restaura el comportamiento original de la red.
 */
export function installFakeTargetDiscovery(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'pagina-1', type: 'page', title: 'Pago', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/pagina-1' },
      ],
    }) as unknown as Response) as typeof fetch;
  return (): void => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Construye un descriptor de elemento reutilizable por las aserciones.
 *
 * @returns Descriptor de un boton accionable con selectores y caja completos.
 */
export function createMockOverlayDescriptor(): MappedElementDescriptor {
  return {
    elementKey: 'el_1_button',
    tagName: 'button',
    primarySelector: '#confirmar-pago',
    accessibilitySelector: 'button[name="Confirmar pago"]',
    structuralCssSelector: 'form > button:nth-of-type(1)',
    xpathFallback: '/html/body/form/button[1]',
    selectorStabilityScore: 85,
    actionType: 'CLICK',
    functionalDescription: 'Confirma el pago del pedido',
    bbox: { x: 100, y: 250, width: 160, height: 44, viewportWidth: 1440, viewportHeight: 900 },
    elementMetadata: { role: null, inputType: null, isDisabled: false, isRequired: false },
  };
}

/**
 * Construye un agente instrumentador real cuyos bordes de navegador se sustituyen por espias.
 * La validacion del modal (`buildElementMetadata`) es la implementacion de produccion: unicamente
 * se reemplazan la instalacion, el dibujo del overlay y la medicion geometrica, que requeririan un
 * navegador real.
 *
 * @returns Agente con validacion real y bordes simulados.
 */
export function createSpiedOverlayAgent(): DomOverlayInjectedAgent {
  const descriptor = createMockOverlayDescriptor();
  const box = (width: number, height: number): ElementBoundingBox => ({
    x: 10,
    y: 20,
    width,
    height,
    viewportWidth: width,
    viewportHeight: height,
  });

  const agent = new DomOverlayInjectedAgent({ cdpClient: { send: async () => ({}), evaluate: async () => null } });

  agent.installOnNewDocuments = async () => ({ scriptIdentifier: 'script-1', sensitiveMarkers: SENSITIVE_FIELD_MARKERS.length });
  agent.activateOverlay = async () => ({
    rendered: 3,
    collection: { route: { path: '/checkout', title: 'Pago', readyState: 'complete' }, elements: [descriptor] },
  });
  agent.deactivateOverlay = async () => undefined;
  agent.collectLabelableElements = async () => ({
    route: { path: '/checkout', title: 'Pago', readyState: 'complete' },
    elements: [descriptor],
  });
  agent.highlightSelector = async (selector: string) => (selector === '#confirmar-pago' ? descriptor : null);
  agent.captureMultiViewportBoxes = async () => ({ desktop: box(1440, 900), tablet: box(768, 1024), mobile: box(390, 844) });

  return agent;
}
