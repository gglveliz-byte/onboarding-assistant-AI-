/**
 * @archivo src/modules/03-visual-trainer-and-rag/application/training-session.use-case.ts
 * @modulo 03-visual-trainer-and-rag (Casos de Uso del Entrenamiento Visual Remoto)
 * @proposito
 *   Orquesta la sesion completa de entrenamiento visual: valida la URL inicial con el escudo
 *   Anti-SSRF antes de crear nada, levanta el contenedor efimero, permite conmutar entre el modo
 *   de navegacion libre y el modo de captura con overlay, prueba un selector en vivo, captura los
 *   metadatos funcionales del modal y persiste el elemento con sus cajas en los tres viewports.
 *   Es la unica puerta de entrada del entrenamiento, tanto desde el panel web como desde el tunel
 *   de linea de comandos, de modo que las dos vias aplican exactamente las mismas validaciones.
 *
 * @resumen_contenido
 *   - Interface `TrainingSessionUseCaseDependencies`: Dependencias inyectadas del caso de uso.
 *   - Clase `LaunchTrainingBrowserUseCase`:
 *       * `startSession()`: Valida la URL, levanta el navegador e instala el overlay.
 *       * `switchMode()`: Conmuta entre navegacion libre y captura con overlay.
 *       * `testSelector()`: Prueba un selector en vivo y devuelve su descriptor.
 *       * `saveTaggedElement()`: Captura las cajas y persiste el elemento etiquetado.
 *       * `endSession()`: Destruye el contenedor y finaliza la sesion.
 *   - Funcion `createTrainingSessionUseCase()`: Ensamblado desde las dependencias del modulo.
 *
 * @dependencias_internas
 *   - `TrainingSessionUseCaseDependencies` y tipos (`./training-session.types.ts`).
 *   - `EphemeralChromiumCdpAdapter` (`../infrastructure/ephemeral-chromium-cdp.adapter.ts`).
 *   - `DomOverlayInjectedAgent` (`../infrastructure/dom-overlay-injected-agent.ts`).
 *   - `PinnedDnsSsrfGuard` (`../infrastructure/pinned-dns-ssrf.guard.ts`).
 *   - `ValidationError` y `NotFoundError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `node:crypto` (Generacion del identificador de la sesion de entrenamiento).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (Ciclo de vida y modo de la sesion).
 *   - PostgreSQL: `map_elements` (Elementos etiquetados con sus selectores y cajas).
 *   - Redis: `rag_map:proj:<id>:meta` (Se invalida al etiquetar para refrescar el contexto RAG).
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { EphemeralChromiumCdpAdapter } from '../infrastructure/ephemeral-chromium-cdp.adapter';
import type { DomOverlayInjectedAgent, MappedElementDescriptor } from '../infrastructure/dom-overlay-injected-agent';
import type { PinnedDnsSsrfGuard } from '../infrastructure/pinned-dns-ssrf.guard';
import type {
  ActiveTrainingSessionSnapshot,
  ActorContext,
  PersistedTaggedElement,
  StartTrainingSessionInput,
  TaggedElementInput,
  TrainingElementRepository,
  TrainingElementValidator,
  TrainingSessionMode,
  TrainingSessionRepository,
} from './training-session.types';

/** Dependencias inyectadas del caso de uso del entrenamiento visual. */
export interface TrainingSessionUseCaseDependencies {
  /** Adaptador del contenedor efimero y del canal de depuracion. */
  readonly browserAdapter: EphemeralChromiumCdpAdapter;
  /** Escudo Anti-SSRF que valida la URL inicial y cada peticion secundaria. */
  readonly ssrfGuard: PinnedDnsSsrfGuard;
  /** Fabrica del agente instrumentador para una sesion concreta. */
  readonly overlayAgentFactory: (trainingSessionId: string) => DomOverlayInjectedAgent;
  /** Repositorio del ciclo de vida de las sesiones. */
  readonly sessionRepository: TrainingSessionRepository;
  /** Repositorio de los elementos etiquetados. */
  readonly elementRepository: TrainingElementRepository;
  /** Validador del elemento contra el mapa funcional y los guardarrailes. */
  readonly elementValidator: TrainingElementValidator;
}

/**
 * Caso de uso que gobierna una sesion de entrenamiento visual remoto.
 * Mantiene el estado minimo de la sesion (modo vigente y metadatos) y delega todo el trabajo
 * pesado en el adaptador del navegador y en el agente instrumentador.
 */
export class LaunchTrainingBrowserUseCase {
  private readonly dependencies: TrainingSessionUseCaseDependencies;
  private readonly sessionModes = new Map<string, TrainingSessionMode>();
  private readonly sessionValidatedUrls = new Map<string, string>();

  /**
   * @param dependencies - Adaptador, escudo, fabrica del agente y repositorios.
   */
  public constructor(dependencies: TrainingSessionUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Inicia una sesion de entrenamiento: valida la URL, levanta el contenedor efimero, instala el
   * overlay en cada documento nuevo y registra la sesion en la base de datos.
   *
   * @param input - Actor, canal de acceso y URL inicial solicitada.
   * @returns Instantanea de la sesion activa con la IP fijada y su expiracion.
   * @throws ValidationError cuando la URL inicial es invalida o apunta a un destino prohibido.
   */
  public async startSession(input: StartTrainingSessionInput): Promise<ActiveTrainingSessionSnapshot> {
    const trainingSessionId = input.trainingSessionId ?? `trn_${randomUUID()}`;

    // La URL se valida ANTES de crear el contenedor: un destino prohibido no debe llegar siquiera
    // a levantar un navegador, y menos a consumir recursos del host.
    const pinnedTarget = await this.dependencies.ssrfGuard.assertSafeUrl(input.initialUrl, {
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
    });

    const browserSession = await this.dependencies.browserAdapter.launchSession(
      trainingSessionId,
      {
        organizationId: input.actor.organizationId,
        projectId: input.actor.projectId,
      },
      // La regla la calculo el escudo para ESTE destino y se pasa al contenedor para que el navegador
      // no pueda volver a resolver el nombre y obtener una direccion distinta entre la validacion y la
      // conexion del socket. Calcularla y no aplicarla dejaba la defensa contra el rebinding de DNS
      // escrita pero desconectada: la ventana entre la validacion y el socket quedaba abierta.
      pinnedTarget.chromiumPinningRule
    );

    const overlayAgent = this.dependencies.overlayAgentFactory(trainingSessionId);
    await overlayAgent.installOnNewDocuments();

    const snapshot: ActiveTrainingSessionSnapshot = {
      trainingSessionId,
      containerId: browserSession.containerId,
      mode: 'ACTIVE_NAVIGATION_MODE',
      validatedUrl: pinnedTarget.url,
      pinnedIp: pinnedTarget.pinnedIp.canonical,
      startedAtIso: new Date(browserSession.createdAtMs).toISOString(),
      expiresAtIso: new Date(browserSession.expiresAtMs).toISOString(),
      pinningRule: pinnedTarget.chromiumPinningRule,
    };

    this.sessionModes.set(trainingSessionId, snapshot.mode);
    this.sessionValidatedUrls.set(trainingSessionId, snapshot.validatedUrl);
    await this.dependencies.sessionRepository.createSession(snapshot, input.actor, input.accessChannel, input.initialUrl);

    return snapshot;
  }

  /**
   * Conmuta el modo de trabajo de una sesion activa.
   * Al entrar en modo captura se dibuja el overlay; al volver a navegacion se limpia por completo
   * para no interferir con la pagina que se esta entrenando.
   *
   * @param trainingSessionId - Sesion a conmutar.
   * @param mode - Modo de trabajo destino.
   * @returns Numero de marcadores dibujados cuando el modo destino es el de captura.
   * @throws NotFoundError cuando la sesion no esta registrada como activa.
   */
  public async switchMode(trainingSessionId: string, mode: TrainingSessionMode): Promise<{ readonly renderedMarkers: number }> {
    this.requireKnownSession(trainingSessionId);
    const overlayAgent = this.dependencies.overlayAgentFactory(trainingSessionId);

    let renderedMarkers = 0;
    if (mode === 'ACTIVE_CAPTURE_OVERLAY_MODE') {
      const activated = await overlayAgent.activateOverlay();
      renderedMarkers = activated.rendered;
    } else {
      await overlayAgent.deactivateOverlay();
    }

    this.sessionModes.set(trainingSessionId, mode);
    await this.dependencies.sessionRepository.updateSessionMode(trainingSessionId, mode);
    return { renderedMarkers };
  }

  /**
   * Prueba un selector en vivo resaltandolo durante dos segundos en la pagina remota.
   *
   * @param trainingSessionId - Sesion sobre la que se prueba.
   * @param selector - Selector CSS a validar.
   * @returns Descriptor del elemento resaltado, o `null` si el selector no resuelve o es sensible.
   */
  public async testSelector(trainingSessionId: string, selector: string): Promise<MappedElementDescriptor | null> {
    this.requireKnownSession(trainingSessionId);
    if (selector.trim().length === 0) {
      throw new ValidationError('El selector a probar no puede estar vacio.');
    }
    const overlayAgent = this.dependencies.overlayAgentFactory(trainingSessionId);
    return overlayAgent.highlightSelector(selector.trim());
  }

  /**
   * Captura los metadatos funcionales de un elemento y lo persiste con sus cajas en los tres
   * viewports oficiales, previa validacion contra el mapa funcional y los guardarrailes.
   *
   * @param actor - Actor autenticado que etiqueta el elemento.
   * @param input - Datos confirmados en el modal de etiquetado.
   * @param descriptor - Descriptor del elemento seleccionado en el overlay.
   * @returns Elemento etiquetado con su identificador persistido.
   * @throws NotFoundError cuando la sesion no esta registrada como activa.
   * @throws ValidationError cuando los datos del modal son incoherentes o el elemento no cumple el mapa.
   */
  public async saveTaggedElement(
    actor: ActorContext,
    input: TaggedElementInput,
    descriptor: MappedElementDescriptor
  ): Promise<PersistedTaggedElement> {
    this.requireKnownSession(input.trainingSessionId);
    const overlayAgent = this.dependencies.overlayAgentFactory(input.trainingSessionId);

    const metadata = overlayAgent.buildElementMetadata(
      {
        title: input.title,
        functionalDescription: input.functionalDescription,
        isActionable: input.isActionable,
        actionType: input.actionType,
      },
      descriptor
    );

    const validation = await this.dependencies.elementValidator.validateElementAction(
      actor.projectId,
      input.trainingSessionId,
      input.elementKey,
      input.actionType
    );
    if (!validation.allowed) {
      throw new ValidationError(`El elemento no cumple las reglas del mapa funcional: ${validation.reason}`);
    }

    const boxes = await overlayAgent.captureMultiViewportBoxes(descriptor.primarySelector, {
      width: descriptor.bbox.viewportWidth,
      height: descriptor.bbox.viewportHeight,
    });

    const saved = await this.dependencies.elementRepository.saveTaggedElement(
      actor.projectId,
      {
        elementKey: input.elementKey,
        primarySelector: descriptor.primarySelector,
        selectorStabilityScore: descriptor.selectorStabilityScore,
        routePath: this.sessionValidatedUrls.get(input.trainingSessionId) ?? '/',
        boxes,
      },
      metadata
    );

    return {
      mapElementId: saved.mapElementId,
      elementKey: input.elementKey,
      primarySelector: descriptor.primarySelector,
      selectorStabilityScore: descriptor.selectorStabilityScore,
      routePath: this.sessionValidatedUrls.get(input.trainingSessionId) ?? '/',
      boxes,
      metadata,
    };
  }

  /**
   * Finaliza la sesion destruyendo el contenedor de forma incondicional y registrando el cierre.
   *
   * @param trainingSessionId - Sesion a finalizar.
   * @param terminationReason - Motivo del cierre, registrado en la bitacora.
   */
  public async endSession(trainingSessionId: string, terminationReason: string): Promise<void> {
    const blockedAttemptsCount = this.dependencies.browserAdapter.countBlockedRequests(trainingSessionId);
    await this.dependencies.browserAdapter.destroySession(trainingSessionId);
    await this.dependencies.sessionRepository.finalizeSession(trainingSessionId, terminationReason, blockedAttemptsCount);
    this.sessionModes.delete(trainingSessionId);
    this.sessionValidatedUrls.delete(trainingSessionId);
  }

  /**
   * Consulta el modo de trabajo vigente de una sesion.
   *
   * @param trainingSessionId - Sesion consultada.
   * @returns Modo vigente, o `null` si la sesion no esta registrada.
   */
  public getSessionMode(trainingSessionId: string): TrainingSessionMode | null {
    return this.sessionModes.get(trainingSessionId) ?? null;
  }

  /**
   * Verifica que una sesion este registrada como activa en este proceso.
   *
   * @param trainingSessionId - Sesion a verificar.
   * @throws NotFoundError cuando la sesion no esta registrada.
   */
  private requireKnownSession(trainingSessionId: string): void {
    if (!this.sessionModes.has(trainingSessionId)) {
      throw new NotFoundError(`sesion de entrenamiento activa ${trainingSessionId}`);
    }
  }
}

/**
 * Ensambla el caso de uso del entrenamiento visual a partir de sus dependencias.
 *
 * @param dependencies - Adaptador, escudo, fabrica del agente y repositorios.
 * @returns Caso de uso listo para ser registrado en el contenedor de inyeccion.
 */
export function createTrainingSessionUseCase(dependencies: TrainingSessionUseCaseDependencies): LaunchTrainingBrowserUseCase {
  return new LaunchTrainingBrowserUseCase(dependencies);
}
