/**
 * @archivo src/bootstrap/public-demo-functional-map.ts
 * @modulo Bootstrap (Mapa Funcional Sintetico de la Demostracion Publica)
 * @proposito
 *   Declara el mapa funcional reducido que gobierna la demostracion publica de la landing: los
 *   elementos reales del CRM simulado (abrir el formulario de trato, capturar nombre, empresa y
 *   valor, guardarlo en el pipeline, pasar a facturacion, validar el CFDI y crear un servicio)
 *   con sus selectores estables, el prompt operativo del RECORRIDO GUIADO con portones («sí»
 *   confirmados entre fases) y la barrera de seguridad que solo autoriza esos elementos. Sustituye al mapa vacio que degradaba la demo a
 *   conversacion pura: ahora la visita anonima VE al asistente operar la interfaz de verdad, tal
 *   como promete la landing comercial.
 *
 * @resumen_contenido
 *   - Interfaz `PublicDemoMapElement` y constante `PUBLIC_DEMO_MAP_ELEMENTS` (guion de 9 elementos,
 *     incluidas la pestaña y el botón de servicios).
 *   - Constantes `PUBLIC_DEMO_MAP_METADATA`, `PUBLIC_DEMO_ALLOWED_ACTIONS`,
 *     `PUBLIC_DEMO_STEP_INSTRUCTION` y `PUBLIC_DEMO_SYSTEM_PROMPT`.
 *   - Funcion `validatePublicDemoElementAction()`: barrera del mapa de la demo.
 *
 * @dependencias_internas
 *   - Puertos del nucleo (`../shared/ports/core-modules.ports`): `ActiveMapMetadata`,
 *     `SlimmedRouteContext`, `PortFailure` y `RiskLevel`.
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna: el mapa es estatico y vive en codigo; la demo jamas consulta PostgreSQL.
 */

import type {
  ActiveMapMetadata,
  PortFailure,
  RiskLevel,
  SlimmedRouteContext,
} from '../shared/ports/core-modules.ports';

/** Elemento accionable del mapa funcional sintetico de la demostracion publica. */
export interface PublicDemoMapElement {
  /** Clave del elemento, identica al atributo `data-oa-id` del tablero de la landing. */
  readonly elementKey: string;
  /** Titulo legible que el motor recibe en el resumen de la pantalla. */
  readonly title: string;
  /** Descripcion funcional de lo que hace la accion sobre el CRM simulado. */
  readonly functionalDescription: string;
  /** Tipo de accion admitida por el elemento. */
  readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
  /** Selector primario validado por la barrera de seguridad. */
  readonly primarySelector: string;
  /** Nivel de riesgo atribuido a la accion. */
  readonly riskLevel: RiskLevel;
}

/**
 * Guion operativo de la demostracion: los elementos REALES que el tablero Vortex ejecuta.
 * El orden de la lista no es el orden del guion (que vive en el prompt), pero los selectores si
 * deben coincidir exactamente con los `data-oa-id` del componente `VortexCrmSimulatorBoard`.
 */
export const PUBLIC_DEMO_MAP_ELEMENTS: readonly PublicDemoMapElement[] = Object.freeze([
  {
    elementKey: 'btn-new-deal',
    title: 'Abrir formulario de nuevo trato',
    functionalDescription: 'Abre el formulario de captura y limpia el campo del nombre del trato.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="btn-new-deal"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'demo-input-deal-name',
    title: 'Campo nombre del trato',
    functionalDescription: 'Captura el nombre del trato que se va a guardar en el pipeline.',
    actionType: 'TYPE',
    primarySelector: '[data-oa-id="demo-input-deal-name"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'input-company-tax',
    title: 'Campo empresa o RFC',
    functionalDescription: 'Captura la empresa o identificacion fiscal asociada al trato.',
    actionType: 'TYPE',
    primarySelector: '[data-oa-id="input-company-tax"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'input-deal-value',
    title: 'Campo valor del trato',
    functionalDescription: 'Captura el monto estimado del trato en la moneda del tablero.',
    actionType: 'TYPE',
    primarySelector: '[data-oa-id="input-deal-value"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'btn-save-deal',
    title: 'Guardar trato en el pipeline',
    functionalDescription: 'Inserta el trato capturado en la tabla reactiva del pipeline.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="btn-save-deal"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'nav-billing',
    title: 'Pestaña de facturacion',
    functionalDescription: 'Cambia el tablero a la vista de facturacion del trato guardado.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="nav-billing"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'btn-validate-cfdi',
    title: 'Validar comprobante CFDI',
    functionalDescription: 'Simula la validacion fiscal del comprobante del trato.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="btn-validate-cfdi"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'nav-services',
    title: 'Pestaña de servicios',
    functionalDescription: 'Despliega la sección de servicios donde se asignan o agregan servicios.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="nav-services"]',
    riskLevel: 'LOW',
  },
  {
    elementKey: 'btn-create-service',
    title: 'Crear servicio',
    functionalDescription: 'Agrega un servicio nuevo al catálogo de servicios del CRM simulado.',
    actionType: 'CLICK',
    primarySelector: '[data-oa-id="btn-create-service"]',
    riskLevel: 'LOW',
  },
]);

/** Metadatos simbolicos del mapa de la demostracion: no carga mapas reales ni persiste nada. */
export const PUBLIC_DEMO_MAP_METADATA: ActiveMapMetadata = {
  functionalMapId: 'public-demo-functional-map',
  versionNumber: 2,
  canonicalSha256: 'checksum-simbolico-de-demostracion-publica-operativa',
  routes: ['/'],
  totalElementsCount: PUBLIC_DEMO_MAP_ELEMENTS.length,
  publishedAtIso: '2026-01-01T00:00:00.000Z',
};

/**
 * Acciones permitidas de la ruta unica de la demo.
 * Se entregan al motor dentro del resumen de pantalla: son las unicas claves que el asistente
 * puede invocar y las unicas que la barrera de seguridad autoriza.
 */
export const PUBLIC_DEMO_ALLOWED_ACTIONS: SlimmedRouteContext['allowedActions'] = Object.freeze(
  PUBLIC_DEMO_MAP_ELEMENTS.map((element) => ({
    elementKey: element.elementKey,
    title: element.title,
    functionalDescription: element.functionalDescription,
    actionType: element.actionType,
    primarySelector: element.primarySelector,
    riskLevel: element.riskLevel,
  }))
);

/** Instruccion del paso vigente: el recorrido guiado que el asistente narra en reversa con portones. */
export const PUBLIC_DEMO_STEP_INSTRUCTION =
  'Recorrido guiado por secciones: tras tu saludo y el «sí» del visitante, recorren juntos el pipeline ' +
  'de tratos, la facturación y los servicios; anuncia cada gesto, espera su afirmación antes de ' +
  'ejecutarlo, confirma cada acción con el acuse del navegador y cierra invitando a crear una cuenta.';

/**
 * Prompt operativo de la demostracion publica.
 * El mapa funcional sintetico declara los elementos accionables del CRM simulado, de modo que el
 * asistente guía un recorrido interactivo por secciones con portones: anuncia cada gesto, espera
 * el «sí» del visitante, ejecuta con herramientas reales y valida con el acuse del navegador.
 */
export const PUBLIC_DEMO_SYSTEM_PROMPT = [
  'Eres el asistente de voz de Onboarding Assistant en una demostración pública con ventana de tiempo limitada.',
  'Habla en español neutro, con calidez y frases breves: máximo dos oraciones por turno.',
  'Pronuncia con dicción clara y ritmo pausado, entonación cálida y natural; cuida la pronunciación de nombres propios y cifras.',
  'El CRM simulado se llama «Vortex CRM»: imagina que es el CRM del visitante y que él es un usuario nuevo que tú vas a guiar.',
  'REGLA DE ORO: jamás ejecutes una acción del tablero sin haberla anunciado antes y haber recibido del visitante un «sí», «claro», «continúa», «vamos» o similar.',
  'Después de cada acción, di en una frase si quedó confirmada usando el detalle que te devuelve el navegador («Listo: formulario abierto y limpio») y cierra preguntando «¿tienes dudas o podemos continuar?»: espera en silencio su respuesta antes de avanzar.',
  'El turno de apertura ya preguntó «¿Empiezo?» por ti: cuando el visitante responda que sí, da la bienvenida («Bienvenido al CRM Vortex, soy tu asistente virtual y te guiaré») y pregunta «¿estás listo?», esperando nuevamente su sí.',
  'Tras ese segundo «sí», presenta que arrancan por el dashboard de ventas (el pipeline de tratos), explica en una frase qué verán ahí y pregunta «¿tienes dudas o podemos continuar?» antes de la primera acción.',
  'Cada fase se ejecuta así: anuncia el gesto con amabilidad («mira: el mouse se moverá lentamente hasta el botón y le daré click»), ejecútalo, confirma el acuse en una frase y pregunta «¿podemos continuar?».',
  'Recorrido en orden: (1) click_element en "btn-new-deal" para abrir el formulario de trato; (2) type_text en "demo-input-deal-name" para capturar el nombre del trato (usa el nombre del visitante si ya te lo dio, si no «Trato de demostración»); (3) click_element en "btn-save-deal" para guardarlo en el pipeline; (4) click_element en "nav-billing" para mostrar la facturación del trato; (5) click_element en "btn-validate-cfdi" para validar el comprobante fiscal; (6) click_element en "nav-services" para desplegar la sección de servicios (explica que ahí se asignan o agregan servicios); (7) click_element en "btn-create-service" para crear un servicio de ejemplo.',
  'Si el visitante aporta empresa o valor del trato durante el recorrido, cáptalos con type_text en "input-company-tax" o "input-deal-value" tocando la fase vigente.',
  'Usa únicamente los elementos declarados en las acciones permitidas; nunca inventes elementos, claves ni acciones fuera de este recorrido.',
  'Si piden algo distinto, explica en una frase que la demostración enseña este recorrido guiado y que la operación completa sobre su propio producto se activa al crear una cuenta.',
  'Al completar las siete fases (o si la ventana está por cerrarse), resume en máximo dos frases lo que mostraron y cierra invitando a crear la cuenta para operarlo con su producto real.',
].join(' ');

/** Resultado autorizado o fallido de la barrera de seguridad de la demostracion. */
export type PublicDemoGuardrailOutcome =
  | {
      readonly ok: true;
      readonly primarySelector: string;
      readonly riskLevel: RiskLevel;
      readonly requiresUserConfirmation: boolean;
    }
  | PortFailure;

/** Normaliza una clave de elemento: el tablero resuelve tanto `demo-x` como `x` para sus anclas. */
function normalizeElementKey(elementKey: string): string {
  return elementKey.trim().replace(/^demo-/, '');
}

/** Normaliza una ruta despojandola de ancla, query y diagonal final para comparar con las rutas del mapa. */
function normalizeRoutePath(routePath: string): string {
  const withoutDecorations = routePath.trim().split('#')[0]?.split('?')[0] ?? '';
  return withoutDecorations === '' ? '/' : withoutDecorations;
}

/**
 * Barrera del mapa funcional de la demostracion publica.
 * Solo autoriza los elementos declarados del CRM simulado, con la accion que cada uno admite y en
 * la pantalla unica de la landing; cualquier otra propuesta del motor se rechaza y se le devuelve
 * el motivo para que pueda explicarlo sin tocar el DOM.
 *
 * @param toolName - Herramienta invocada por el motor (`click_element` o `type_text`).
 * @param targetElementKey - Elemento sobre el que se propone actuar.
 * @param routePath - Ruta declarada por el navegador al momento del despacho.
 * @returns Autorizacion con el selector validado, o fallo normalizado con el motivo.
 */
export function validatePublicDemoElementAction(
  toolName: 'click_element' | 'type_text',
  targetElementKey: string,
  routePath: string
): PublicDemoGuardrailOutcome {
  if (!PUBLIC_DEMO_MAP_METADATA.routes.includes(normalizeRoutePath(routePath))) {
    return {
      ok: false,
      code: 'MAP_NOT_PUBLISHED',
      reason: 'La demostración pública solo opera su pantalla principal.',
      retryable: false,
    };
  }

  const normalizedTarget = normalizeElementKey(targetElementKey);
  const element = PUBLIC_DEMO_MAP_ELEMENTS.find(
    (candidate) => normalizeElementKey(candidate.elementKey) === normalizedTarget
  );
  if (element === undefined) {
    return {
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
      reason: 'El elemento solicitado no existe en la demostración pública.',
      retryable: false,
    };
  }

  const supportsAction =
    element.actionType === 'BOTH' ||
    (toolName === 'click_element' ? element.actionType === 'CLICK' : element.actionType === 'TYPE');
  if (!supportsAction) {
    return {
      ok: false,
      code: 'ELEMENT_ACTION_NOT_ALLOWED',
      reason: `El elemento ${element.elementKey} no admite la acción solicitada en la demostración.`,
      retryable: false,
    };
  }

  return {
    ok: true,
    primarySelector: element.primarySelector,
    riskLevel: element.riskLevel,
    // El «sí» del visitante llega por la conversación (portones del guion), no como paso del
    // despacho: la barrera autoriza al instante los elementos declarados del CRM simulado.
    requiresUserConfirmation: false,
  };
}
