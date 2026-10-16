/**
 * @archivo src/modules/03-visual-trainer-and-rag/application/training-session.types.ts
 * @modulo 03-visual-trainer-and-rag (Tipos de la Sesion de Entrenamiento del Navegador Remoto)
 * @proposito
 *   Declara el contrato tipado del entrenamiento visual: los modos de trabajo, la forma de un
 *   elemento etiquetado, el resultado del guardado de un elemento y la instantanea de una sesion
 *   activa. Separar los tipos de los casos de uso permite que la capa de transporte (paneles,
 *   tunel de linea de comandos y SDK) los consuma sin arrastrar la logica de orquestacion.
 *
 * @resumen_contenido
 *   - Tipos `TrainingAccessChannel` y `TrainingSessionMode`.
 *   - Interface `ActorContext`: Identidad y organizacion del solicitante.
 *   - Interface `StartTrainingSessionInput` y `ActiveTrainingSessionSnapshot`.
 *   - Interface `TaggedElementInput` y `PersistedTaggedElement`.
 *   - Interface `TrainingElementValidator`: Validacion contra el mapa y los guardarrailes.
 *   - Interface `TrainingElementRepository`: Persistencia de los elementos etiquetados.
 *   - Interface `TrainingSessionRepository`: Persistencia del ciclo de vida de la sesion.
 *
 * @dependencias_internas
 *   - `ElementBoundingBox` y `CapturedElementMetadata` (`../infrastructure/dom-overlay-injected-agent.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Contratos puros de aplicacion, sin acoplamiento a frameworks).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` y `map_elements` (Tablas gobernadas por estos tipos).
 *   - Redis: `rag_map:proj:<id>:meta` (Invalidacion de cache tras etiquetar un elemento).
 */

import type { ElementBoundingBox, CapturedElementMetadata } from '../infrastructure/dom-overlay-injected-agent';

/** Canal desde el que se solicito la sesion de entrenamiento. */
export type TrainingAccessChannel = 'WEB_DASHBOARD' | 'CLI_TUNNEL';

/** Modo de trabajo de la sesion de entrenamiento. */
export type TrainingSessionMode = 'ACTIVE_NAVIGATION_MODE' | 'ACTIVE_CAPTURE_OVERLAY_MODE';

/** Identidad y organizacion del solicitante de la operacion. */
export interface ActorContext {
  /** Usuario autenticado que solicita la operacion. */
  readonly userId: string;
  /** Organizacion activa del solicitante. */
  readonly organizationId: string;
  /** Proyecto sobre el que se opera. */
  readonly projectId: string;
}

/** Datos de entrada para iniciar una sesion de entrenamiento. */
export interface StartTrainingSessionInput {
  /** Actor autenticado que inicia la sesion. */
  readonly actor: ActorContext;
  /** Canal de acceso usado para iniciar la sesion. */
  readonly accessChannel: TrainingAccessChannel;
  /** URL inicial que debe cargar el navegador efimero. */
  readonly initialUrl: string;
  /** Identificador de la sesion persistida; se genera uno nuevo cuando no se declara. */
  readonly trainingSessionId?: string;
}

/** Instantanea de una sesion de entrenamiento activa. */
export interface ActiveTrainingSessionSnapshot {
  /** Identificador de la sesion de entrenamiento. */
  readonly trainingSessionId: string;
  /** Identificador del contenedor efimero creado. */
  readonly containerId: string;
  /** Modo de trabajo vigente. */
  readonly mode: TrainingSessionMode;
  /** URL validada que carga el navegador. */
  readonly validatedUrl: string;
  /** Direccion IP fijada por el escudo Anti-SSRF para esa URL. */
  readonly pinnedIp: string;
  /** Momento de inicio de la sesion en formato ISO 8601. */
  readonly startedAtIso: string;
  /** Momento en el que la sesion se destruye obligatoriamente, en formato ISO 8601. */
  readonly expiresAtIso: string;
  /** Etiqueta aplicada por el escudo a los destinos publicos validados. */
  readonly pinningRule: string;
}

/** Datos del elemento etiquetado que el desarrollador confirma en el modal. */
export interface TaggedElementInput {
  /** Sesion de entrenamiento en la que se etiqueta el elemento. */
  readonly trainingSessionId: string;
  /** Clave estable del elemento dentro de la sesion. */
  readonly elementKey: string;
  /** Titulo funcional asignado por el desarrollador. */
  readonly title: string;
  /** Descripcion funcional que explica que hace el elemento. */
  readonly functionalDescription: string;
  /** Indica si el elemento ejecuta una accion fisica. */
  readonly isActionable: boolean;
  /** Naturaleza de la accion: clic, escritura o ambas. */
  readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
}

/** Elemento etiquetado ya validado y listo para persistirse. */
export interface PersistedTaggedElement {
  /** Identificador asignado al elemento en la base de datos. */
  readonly mapElementId: string;
  /** Clave estable del elemento dentro de la sesion. */
  readonly elementKey: string;
  /** Selector principal validado en vivo. */
  readonly primarySelector: string;
  /** Puntaje de estabilidad del selector, de 0 a 100. */
  readonly selectorStabilityScore: number;
  /** Ruta sobre la que se etiqueto el elemento. */
  readonly routePath: string;
  /** Cajas geometricas medidas en los tres viewports oficiales. */
  readonly boxes: {
    readonly desktop: ElementBoundingBox;
    readonly tablet: ElementBoundingBox;
    readonly mobile: ElementBoundingBox;
  };
  /** Metadatos funcionales confirmados por el desarrollador. */
  readonly metadata: CapturedElementMetadata;
}

/**
 * Validacion de un elemento contra el mapa funcional y las barreras de seguridad.
 * Se declara como puerto para que la Parte 8 (publicacion del mapa) lo implemente sin que esta
 * capa conozca todavia la estructura de la tabla de elementos.
 */
export interface TrainingElementValidator {
  /**
   * Comprueba que el elemento respete el mapa y las barreras de seguridad configuradas.
   *
   * @param projectId - Proyecto al que pertenece el elemento.
   * @param functionalMapId - Version inmutable del mapa que sirve de contexto.
   * @param elementKey - Clave del elemento a validar.
   * @param actionType - Accion fisica declarada por el desarrollador.
   * @returns Resultado de la validacion con el motivo del rechazo cuando corresponde.
   */
  validateElementAction(
    projectId: string,
    functionalMapId: string,
    elementKey: string,
    actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH'
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
}

/** Persistencia de los elementos etiquetados durante la sesion. */
export interface TrainingElementRepository {
  /**
   * Guarda un elemento etiquetado en el mapa funcional en borrador del proyecto.
   *
   * @param projectId - Proyecto al que pertenece el elemento.
   * @param element - Elemento ya validado.
   * @param metadata - Metadatos funcionales confirmados por el desarrollador.
   * @returns Identificador asignado al elemento persistido.
   */
  saveTaggedElement(
    projectId: string,
    element: {
      readonly elementKey: string;
      readonly primarySelector: string;
      readonly selectorStabilityScore: number;
      readonly routePath: string;
      readonly boxes: PersistedTaggedElement['boxes'];
    },
    metadata: CapturedElementMetadata
  ): Promise<{ readonly mapElementId: string }>;
}

/** Persistencia del ciclo de vida de la sesion de entrenamiento. */
export interface TrainingSessionRepository {
  /**
   * Registra el inicio de una sesion de entrenamiento.
   *
   * @param session - Instantanea de la sesion recien creada.
   * @param actor - Actor que inicio la sesion.
   * @param accessChannel - Canal de acceso usado.
   * @param initialUrl - URL inicial validada.
   */
  createSession(
    session: ActiveTrainingSessionSnapshot,
    actor: ActorContext,
    accessChannel: TrainingAccessChannel,
    initialUrl: string
  ): Promise<void>;

  /**
   * Actualiza el modo de trabajo de una sesion activa.
   *
   * @param trainingSessionId - Sesion actualizada.
   * @param mode - Modo de trabajo vigente.
   */
  updateSessionMode(trainingSessionId: string, mode: TrainingSessionMode): Promise<void>;

  /**
   * Marca una sesion como finalizada de forma limpia.
   *
   * @param trainingSessionId - Sesion finalizada.
   * @param terminationReason - Motivo del cierre.
   * @param blockedAttemptsCount - Numero de intentos bloqueados por el escudo Anti-SSRF.
   */
  finalizeSession(trainingSessionId: string, terminationReason: string, blockedAttemptsCount: number): Promise<void>;
}
