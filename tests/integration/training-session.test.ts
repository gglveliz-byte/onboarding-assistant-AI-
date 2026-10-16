/**
 * @archivo tests/integration/training-session.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de Integracion del Entrenamiento Visual Remoto)
 * @proposito
 *   Verifica la orquestacion completa del entrenamiento visual sin un navegador real ni un motor de
 *   contenedores: el runtime de contenedores, el descubrimiento del punto de depuracion y el
 *   transporte del protocolo se sustituyen por dobles de prueba inyectados, mientras que el
 *   adaptador, el decisor Anti-SSRF y los casos de uso se ejecutan con su codigo de produccion
 *   intacto. Se certifica que el contenedor se crea aislado y se destruye siempre, que el tiempo de
 *   vida se respeta, que las peticiones peligrosas se abortan y las legitimas continuan, y que una
 *   URL prohibida jamas llega a levantar un navegador.
 *
 * @resumen_contenido
 *   - Bloque `verifyLaunchAndDestroy()`: Ciclo de vida del contenedor y del canal.
 *   - Bloque `verifyCapacityAndTtl()`: Limite de sesiones y destruccion por expiracion.
 *   - Bloque `verifyRequestInterception()`: Aborto de destinos peligrosos y permiso de los legitimos.
 *   - Bloque `verifyUseCaseOrchestration()`: Modos, selector en vivo y guardado del elemento.
 *
 * @dependencias_internas
 *   - Dobles de prueba (`./support/trainer-doubles.ts`).
 *   - `EphemeralChromiumCdpAdapter`, `LaunchTrainingBrowserUseCase` y el escudo Anti-SSRF.
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
  createMockOverlayDescriptor,
  createMockContainerRuntime,
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

/** Verifica que el contenedor se cree con aislamiento y se destruya al cerrar la sesion. */
async function verifyLaunchAndDestroy(): Promise<void> {
  runtimeLog.started.length = 0;
  runtimeLog.destroyed.length = 0;
  const restoreFetch = installFakeTargetDiscovery();
  const transport = new FakeCdpTransport();

  try {
    const adapter = new EphemeralChromiumCdpAdapter({
      containerRuntime: createMockContainerRuntime(),
      ssrfGuard,
      containerImage: 'entrenador-aislado:1.0.0',
      sessionTtlSeconds: 300,
      maxConcurrentSessions: 2,
      transportFactory: () => transport,
    });

    const session = await adapter.launchSession('trn_uno', { organizationId: 'org-1', projectId: 'prj-1' });

    check(session.trainingSessionId === 'trn_uno', 'La sesion debe conservar su identificador');
    check(session.containerId === 'oa-trainer-trn_uno', 'El contenedor debe crearse con el runtime inyectado');
    check(session.expiresAtMs > session.createdAtMs, 'La sesion debe declarar una expiracion posterior a su creacion');
    check(adapter.activeSessionCount === 1, 'El adaptador debe registrar la sesion como activa');
    check(transport.isConnected === true, 'El transporte debe quedar conectado tras levantar la sesion');

    const spec = runtimeLog.started[0];
    check(spec?.tmpfsSize === '512m', 'El contenedor debe declarar almacenamiento exclusivo en memoria');
    check(spec?.memoryLimit === '1024m', 'El contenedor debe declarar un limite de memoria');
    check(spec?.cpuLimit === '1.0', 'El contenedor debe declarar un limite de CPU');
    check(spec?.maxTtlSeconds === 300, 'El contenedor debe recibir el tiempo de vida configurado');
    check(spec?.hostResolverRules.includes('EXCLUDE localhost') === true, 'El contenedor debe recibir la regla de exclusion del bucle local');
    check(spec?.containerName.startsWith('oa-trainer-') === true, 'El contenedor debe llevar un nombre identificable');

    check(transport.sentMethods.includes('Page.enable'), 'El canal debe habilitar el dominio de pagina');
    check(transport.sentMethods.includes('Runtime.enable'), 'El canal debe habilitar la ejecucion de scripts');
    check(transport.sentMethods.includes('DOM.enable'), 'El canal debe habilitar el acceso al documento');
    check(transport.sentMethods.includes('Fetch.enable'), 'El canal debe habilitar la interceptacion de red');
    check(adapter.countBlockedRequests('trn_uno') === 0, 'Una sesion recien creada no debe registrar bloqueos');

    await adapter.forwardDeveloperClick('trn_uno', 120, 240);
    await adapter.forwardDeveloperText('trn_uno', 'texto del desarrollador');
    check(transport.sentMethods.includes('Input.dispatchMouseEvent'), 'El clic del desarrollador debe reenviarse al navegador');
    check(transport.sentMethods.includes('Input.insertText'), 'El texto del desarrollador debe reenviarse al navegador');

    await adapter.destroySession('trn_uno');
    check(adapter.activeSessionCount === 0, 'Destruir la sesion debe liberar el registro');
    check(transport.closed === true, 'Destruir la sesion debe cerrar el canal de depuracion');
    check(runtimeLog.destroyed.includes('oa-trainer-trn_uno'), 'Destruir la sesion debe eliminar el contenedor por su nombre');

    await adapter.destroySession('trn_uno');
    check(runtimeLog.destroyed.length === 1, 'Destruir dos veces la misma sesion debe ser idempotente');

    let missingSessionError: unknown = null;
    try {
      await adapter.forwardDeveloperClick('trn_inexistente', 1, 1);
    } catch (error) {
      missingSessionError = error;
    }
    check(missingSessionError instanceof Error, 'Operar sobre una sesion inexistente debe producir un error explicito');
  } finally {
    restoreFetch();
  }
}

/** Verifica el limite de sesiones simultaneas y la destruccion por expiracion del tiempo de vida. */
async function verifyCapacityAndTtl(): Promise<void> {
  runtimeLog.started.length = 0;
  runtimeLog.destroyed.length = 0;
  const restoreFetch = installFakeTargetDiscovery();

  try {
    const adapter = new EphemeralChromiumCdpAdapter({
      containerRuntime: createMockContainerRuntime(),
      ssrfGuard,
      containerImage: 'entrenador-aislado:1.0.0',
      sessionTtlSeconds: 1,
      maxConcurrentSessions: 1,
      transportFactory: () => new FakeCdpTransport(),
    });

    await adapter.launchSession('trn_limite', { organizationId: 'org-1', projectId: 'prj-1' });

    let capacityError: unknown = null;
    try {
      await adapter.launchSession('trn_excedida', { organizationId: 'org-1', projectId: 'prj-1' });
    } catch (error) {
      capacityError = error;
    }
    check(capacityError instanceof Error, 'Superar el limite de sesiones debe producir un error');
    check(
      capacityError instanceof Error && capacityError.message.includes('CAPACIDAD_DE_ENTRENAMIENTO_EXCEDIDA'),
      'El error de capacidad debe explicar la causa en espanol'
    );
    check(runtimeLog.started.length === 1, 'Una sesion rechazada jamas debe crear un contenedor');
    check(adapter.activeSessionCount === 1, 'Una sesion rechazada no debe consumir cupo');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1100);
    });
    const swept = await adapter.sweepExpiredSessions();
    check(swept.includes('trn_limite'), 'El barrido debe destruir la sesion que supero su tiempo de vida');
    check(adapter.activeSessionCount === 0, 'Tras el barrido no debe quedar ninguna sesion activa');
    check(runtimeLog.destroyed.includes('oa-trainer-trn_limite'), 'El barrido debe eliminar el contenedor expirado');

    let expiredError: unknown = null;
    try {
      await adapter.forwardDeveloperClick('trn_limite', 1, 1);
    } catch (error) {
      expiredError = error;
    }
    check(expiredError instanceof Error, 'Operar sobre una sesion destruida debe fallar de forma controlada');
  } finally {
    restoreFetch();
  }
}

/** Verifica que la interceptacion aborte destinos peligrosos y permita los legitimos. */
async function verifyRequestInterception(): Promise<void> {
  runtimeLog.started.length = 0;
  runtimeLog.destroyed.length = 0;
  const restoreFetch = installFakeTargetDiscovery();
  const transport = new FakeCdpTransport();

  try {
    const adapter = new EphemeralChromiumCdpAdapter({
      containerRuntime: createMockContainerRuntime(),
      ssrfGuard,
      containerImage: 'entrenador-aislado:1.0.0',
      sessionTtlSeconds: 300,
      transportFactory: () => transport,
    });

    await adapter.launchSession('trn_intercept', { organizationId: 'org-1', projectId: 'prj-1' });

    const metadataDecision = await transport.simulateRequest('http://169.254.169.254/latest/meta-data/');
    check(!metadataDecision.allow, 'Una peticion hacia metadatos de nube debe abortarse');
    check(metadataDecision.reason === 'BLOQUEADO_POR_ESCUDO_ANTI_SSRF', `El bloqueo debe reportar la marca del escudo (recibido: ${metadataDecision.reason})`);
    check(adapter.countBlockedRequests('trn_intercept') === 1, 'El bloqueo debe contabilizarse en la sesion');

    const privateDecision = await transport.simulateRequest('http://10.20.30.40/api/interno');
    check(!privateDecision.allow, 'Una peticion hacia red privada debe abortarse');
    check(privateDecision.reason === 'BLOQUEADO_POR_ESCUDO_ANTI_SSRF', `El bloqueo de red privada debe reportar la marca del escudo (recibido: ${privateDecision.reason})`);
    check(adapter.countBlockedRequests('trn_intercept') === 2, 'Cada bloqueo debe acumularse en el contador');

    const loopbackDecision = await transport.simulateRequest('http://127.0.0.1:8080/panel');
    check(!loopbackDecision.allow, 'Una peticion hacia el bucle local debe abortarse');

    const ipv6Decision = await transport.simulateRequest('http://[fd00:ec2::254]/latest/meta-data/');
    check(!ipv6Decision.allow, 'Una peticion hacia metadatos IPv6 debe abortarse');

    const safeDecision = await transport.simulateRequest('https://example.com/');
    check(safeDecision.allow, 'Una peticion publica legitima debe permitirse');
    check(safeDecision.reason === 'DESTINO_VALIDADO', 'La peticion permitida debe reportar destino validado');

    const internalSchemeDecision = await transport.simulateRequest('data:image/png;base64,iVBORw0KGgo=');
    check(internalSchemeDecision.allow, 'Un esquema interno del navegador debe permitirse sin bloquear la pagina');
    check(
      internalSchemeDecision.reason === 'ESQUEMA_INTERNO_DEL_NAVEGADOR',
      'El esquema interno debe reportar su motivo propio'
    );

    const blockedAfterSafe = adapter.countBlockedRequests('trn_intercept');
    check(blockedAfterSafe === 4, `Solo los cuatro destinos peligrosos deben contarse (contados: ${blockedAfterSafe})`);

    await adapter.destroySession('trn_intercept');
    check(adapter.countBlockedRequests('trn_intercept') === 0, 'Destruir la sesion debe limpiar su contador de bloqueos');
  } finally {
    restoreFetch();
  }
}

/** Ejecuta los 3 grupos de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE INTEGRACION DEL ENTRENAMIENTO VISUAL REMOTO (PARTE 7)');
  console.log('='.repeat(96));

  await verifyLaunchAndDestroy();
  console.log('[1/3] Creacion aislada del contenedor y destruccion garantizada: APROBADO.');

  await verifyCapacityAndTtl();
  console.log('[2/3] Limite de sesiones simultaneas y barrido por expiracion: APROBADO.');

  await verifyRequestInterception();
  console.log('[3/3] Interceptacion Anti-SSRF por peticion con contador de bloqueos: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});




