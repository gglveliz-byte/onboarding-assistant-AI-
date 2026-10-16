/**
 * @archivo tests/integration/training-use-case.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de Integracion de los Casos de Uso del Entrenamiento)
 * @proposito
 *   Verifica la orquestacion de los casos de uso del entrenamiento visual con el adaptador y el
 *   escudo Anti-SSRF reales: que una URL inicial prohibida impida levantar el navegador, que los
 *   modos de navegacion y captura conmuten correctamente, que la prueba de un selector en vivo
 *   devuelva su descriptor y que el etiquetado capture las cajas de los tres viewports y persista
 *   el elemento con sus metadatos funcionales validados.
 *
 * @resumen_contenido
 *   - Bloque `verifyUseCaseOrchestration()`: Modos, selector en vivo y guardado del elemento.
 *   - Bloque de arranque: informa el resultado consolidado y falla con codigo 1 si algo no cumple.
 *
 * @dependencias_internas
 *   - Dobles de prueba (`./support/trainer-doubles.ts`).
 *   - `LaunchTrainingBrowserUseCase` y `EphemeralChromiumCdpAdapter` del modulo de entrenamiento.
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` y `map_elements` (Simulados en memoria por la prueba).
 */

import * as assert from 'node:assert';
import { LaunchTrainingBrowserUseCase } from '../../src/modules/03-visual-trainer-and-rag/application/training-session.use-case';
import type {
  ActiveTrainingSessionSnapshot,
  ActorContext,
  PersistedTaggedElement,
  TrainingSessionMode,
} from '../../src/modules/03-visual-trainer-and-rag/application/training-session.types';
import { EphemeralChromiumCdpAdapter } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter';
import { PinnedDnsSsrfGuard } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';
import {
  FakeCdpTransport,
  createMockContainerRuntime,
  createMockOverlayDescriptor,
  createSpiedOverlayAgent,
  installFakeTargetDiscovery,
  resetRuntimeLog,
  runtimeLog,
} from './support/trainer-doubles';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** Escudo Anti-SSRF con resolutores externos reales usado por el adaptador bajo prueba. */
const ssrfGuard = new PinnedDnsSsrfGuard({ externalResolvers: ['1.1.1.1', '8.8.8.8'], lookupTimeoutMs: 4000 });

/** Verifica la orquestacion de los casos de uso del entrenamiento visual. */
async function verifyUseCaseOrchestration(): Promise<void> {
  runtimeLog.started.length = 0;
  runtimeLog.destroyed.length = 0;
  const restoreFetch = installFakeTargetDiscovery();

  try {
    const adapter = new EphemeralChromiumCdpAdapter({
      containerRuntime: createMockContainerRuntime(),
      ssrfGuard,
      containerImage: 'entrenador-aislado:1.0.0',
      sessionTtlSeconds: 120,
      maxConcurrentSessions: 3,
      transportFactory: () => new FakeCdpTransport(),
    });

    const createdSessions: ActiveTrainingSessionSnapshot[] = [];
    const modeChanges: TrainingSessionMode[] = [];
    const finalizedSessions: { id: string; reason: string; blocked: number }[] = [];
    const savedElements: PersistedTaggedElement[] = [];

    const useCase = new LaunchTrainingBrowserUseCase({
      browserAdapter: adapter,
      ssrfGuard,
      overlayAgentFactory: () => createSpiedOverlayAgent(),
      sessionRepository: {
        createSession: async (session: ActiveTrainingSessionSnapshot) => {
          createdSessions.push(session);
        },
        updateSessionMode: async (_trainingSessionId: string, mode: TrainingSessionMode) => {
          modeChanges.push(mode);
        },
        finalizeSession: async (trainingSessionId: string, terminationReason: string, blockedAttemptsCount: number) => {
          finalizedSessions.push({ id: trainingSessionId, reason: terminationReason, blocked: blockedAttemptsCount });
        },
      },
      elementRepository: {
        saveTaggedElement: async (_projectId, element, metadata) => {
          savedElements.push({
            mapElementId: 'map-el-1',
            elementKey: element.elementKey,
            primarySelector: element.primarySelector,
            selectorStabilityScore: element.selectorStabilityScore,
            routePath: element.routePath,
            boxes: element.boxes,
            metadata,
          });
          return { mapElementId: 'map-el-1' };
        },
      },
      elementValidator: {
        validateElementAction: async () => ({ allowed: true }),
      },
    });

    const actor: ActorContext = { userId: 'usr-1', organizationId: 'org-1', projectId: 'prj-1' };

    let blockedStart: unknown = null;
    try {
      await useCase.startSession({ actor, accessChannel: 'WEB_DASHBOARD', initialUrl: 'http://169.254.169.254/' });
    } catch (error) {
      blockedStart = error;
    }
    check(blockedStart instanceof Error, 'Una URL inicial prohibida debe impedir el inicio de la sesion');
    check(runtimeLog.started.length === 0, 'Una URL prohibida jamas debe llegar a crear un contenedor');

    const snapshot = await useCase.startSession({
      actor,
      accessChannel: 'WEB_DASHBOARD',
      initialUrl: 'https://example.com/checkout',
      trainingSessionId: 'trn_flujo',
    });

    check(createdSessions.length === 1, 'El inicio de sesion debe persistirse una sola vez');
    check(snapshot.mode === 'ACTIVE_NAVIGATION_MODE', 'Una sesion nueva debe iniciar en modo navegacion');
    check(snapshot.pinnedIp.length > 0, 'La instantanea debe exponer la direccion IP fijada');
    check(snapshot.pinningRule.includes('EXCLUDE localhost'), 'La instantanea debe exponer la regla de fijacion');
    check(snapshot.containerId === 'oa-trainer-trn_flujo', 'La instantanea debe exponer el contenedor creado');
    check(useCase.getSessionMode('trn_flujo') === 'ACTIVE_NAVIGATION_MODE', 'El modo vigente debe poder consultarse');

    const captureSwitch = await useCase.switchMode('trn_flujo', 'ACTIVE_CAPTURE_OVERLAY_MODE');
    check(captureSwitch.renderedMarkers === 3, 'El modo captura debe dibujar los marcadores del overlay');
    check(modeChanges.includes('ACTIVE_CAPTURE_OVERLAY_MODE'), 'El cambio de modo debe persistirse');

    const navigationSwitch = await useCase.switchMode('trn_flujo', 'ACTIVE_NAVIGATION_MODE');
    check(navigationSwitch.renderedMarkers === 0, 'Volver a navegacion no debe dibujar marcadores');

    let unknownModeError: unknown = null;
    try {
      await useCase.switchMode('trn_inexistente', 'ACTIVE_CAPTURE_OVERLAY_MODE');
    } catch (error) {
      unknownModeError = error;
    }
    check(unknownModeError instanceof Error, 'Conmutar el modo de una sesion desconocida debe fallar');

    const highlighted = await useCase.testSelector('trn_flujo', '#confirmar-pago');
    check(highlighted?.elementKey === 'el_1_button', 'La prueba en vivo debe devolver el descriptor del elemento');
    check((await useCase.testSelector('trn_flujo', '#inexistente')) === null, 'Un selector sin coincidencia debe devolver null');

    let emptySelectorError: unknown = null;
    try {
      await useCase.testSelector('trn_flujo', '   ');
    } catch (error) {
      emptySelectorError = error;
    }
    check(emptySelectorError instanceof Error, 'Un selector vacio debe rechazarse');

    const saved = await useCase.saveTaggedElement(
      actor,
      {
        trainingSessionId: 'trn_flujo',
        elementKey: 'el_1_button',
        title: 'Confirmar el pago',
        functionalDescription: 'Confirma el pago del pedido y avanza al paso siguiente',
        isActionable: true,
        actionType: 'CLICK',
      },
      createMockOverlayDescriptor()
    );

    check(saved.mapElementId === 'map-el-1', 'El elemento guardado debe exponer su identificador persistido');
    check(saved.boxes.desktop.viewportWidth === 1440, 'La caja de escritorio debe medirse en 1440 de ancho');
    check(saved.boxes.tablet.viewportWidth === 768, 'La caja de tableta debe medirse en 768 de ancho');
    check(saved.boxes.mobile.viewportWidth === 390, 'La caja de movil debe medirse en 390 de ancho');
    check(saved.metadata.selectorStabilityScore === 85, 'Los metadatos deben conservar el puntaje de estabilidad');
    check(savedElements.length === 1, 'El elemento debe persistirse exactamente una vez');

    let shortTitleError: unknown = null;
    try {
      await useCase.saveTaggedElement(
        actor,
        {
          trainingSessionId: 'trn_flujo',
          elementKey: 'el_1_button',
          title: 'ab',
          functionalDescription: 'Descripcion suficientemente larga para pasar la validacion',
          isActionable: true,
          actionType: 'CLICK',
        },
        createMockOverlayDescriptor()
      );
    } catch (error) {
      shortTitleError = error;
    }
    check(shortTitleError instanceof Error, 'Un titulo demasiado corto debe rechazarse');

    await useCase.endSession('trn_flujo', 'CIERRE_SOLICITADO_POR_EL_DESARROLLADOR');
    check(finalizedSessions.length === 1, 'El cierre debe registrarse en el repositorio de sesiones');
    check(finalizedSessions[0]?.reason === 'CIERRE_SOLICITADO_POR_EL_DESARROLLADOR', 'El motivo del cierre debe conservarse');
    check(useCase.getSessionMode('trn_flujo') === null, 'Tras el cierre la sesion debe dejar de estar activa');
    check(runtimeLog.destroyed.length === 1, 'El cierre debe destruir exactamente un contenedor');
  } finally {
    restoreFetch();
  }
}


/** Ejecuta la orquestacion de los casos de uso e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE INTEGRACION DE LOS CASOS DE USO DEL ENTRENAMIENTO (PARTE 7)');
  console.log('='.repeat(96));

  await verifyUseCaseOrchestration();
  console.log('[1/1] Orquestacion de modos, selector en vivo y guardado del elemento: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
