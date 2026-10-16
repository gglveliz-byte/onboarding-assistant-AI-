/**
 * @archivo tests/integration/training-dns-pinning.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de la Fijacion de Direcciones)
 * @proposito
 *   Verifica que la regla de fijacion de direcciones que calcula el escudo Anti-SSRF **llegue de
 *   verdad** a la especificacion del contenedor del navegador de entrenamiento.
 *
 *   Esta prueba existe por un defecto documentado y medido: el escudo calculaba la regla
 *   `MAP <host> <ip validada>` —la capa que neutraliza el **rebinding de DNS**— y la guardaba en la
 *   instantanea de la sesion, pero **nadie la consumia**: el contenedor recibia siempre el literal
 *   `EXCLUDE localhost`. La consecuencia era que el navegador resolvia el nombre por su cuenta y la
 *   ventana entre la validacion del escudo y la conexion del socket quedaba abierta: un dominio con
 *   tiempo de vida cero podia responder una direccion publica en la validacion y una direccion
 *   interna —los metadatos del proveedor de nube, por ejemplo— en la conexion real.
 *
 *   La suite anterior certificaba que la regla **se generaba**, que es una afirmacion distinta de que
 *   **se aplique**. Esta prueba comprueba la aplicacion, siguiendo la cadena completa desde el caso
 *   de uso hasta el argumento que recibe el motor de contenedores.
 *
 * @resumen_contenido
 *   - Funcion `verifyPinningRuleReachesContainer()`: La regla aplicada contiene la correspondencia.
 *   - Funcion `verifyPinningRulePinsValidatedAddress()`: La direccion fijada es la que valido el escudo.
 *   - Funcion `verifyLocalhostExclusionIsPreserved()`: La exclusion del bucle local no se pierde.
 *
 * @dependencias_internas
 *   - `LaunchTrainingBrowserUseCase` (`src/modules/03-visual-trainer-and-rag/application/training-session.use-case.ts`).
 *   - `PinnedDnsSsrfGuard` y `DnsAuthoritativeResolver` (infraestructura del modulo).
 *   - Dobles de contenedor y transporte (`tests/integration/support/trainer-doubles.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas).
 *   - Resolucion DNS real contra los resolutores declarados: es lo que hace demostrable que la
 *     direccion fijada procede de la validacion del escudo y no de una constante.
 *
 * @tablas_bd_o_redis
 *   - Ninguna. El repositorio de sesiones se sustituye por un doble en memoria.
 */

import * as assert from 'node:assert';
import { LaunchTrainingBrowserUseCase } from '../../src/modules/03-visual-trainer-and-rag/application/training-session.use-case';
import type { ActorContext } from '../../src/modules/03-visual-trainer-and-rag/application/training-session.types';
import { EphemeralChromiumCdpAdapter } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter';
import { PinnedDnsSsrfGuard } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';
import {
  FakeCdpTransport,
  createMockContainerRuntime,
  createSpiedOverlayAgent,
  installFakeTargetDiscovery,
  runtimeLog,
} from './support/trainer-doubles';

/** Presupuesto total de la prueba, para que un fallo de red se reporte como fallo y no como cuelgue. */
const PINNING_TEST_TIMEOUT_MS = 60000;

/** Destino publico de la prueba: se resuelve de verdad para que la direccion fijada sea autentica. */
const PUBLIC_TARGET_URL = 'https://example.com/onboarding';

/** Actor de la prueba. */
const TEST_ACTOR: ActorContext = { userId: 'usr-fijacion', organizationId: 'org-fijacion', projectId: 'prj-fijacion' };

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

/**
 * Construye el caso de uso con el escudo real, resolucion DNS real y los dobles de contenedor.
 *
 * @returns Caso de uso listo para iniciar una sesion, y la funcion que restaura la busqueda simulada.
 */
function buildUseCase(): {
  readonly useCase: LaunchTrainingBrowserUseCase;
  readonly restoreFetch: () => void;
} {
  // El escudo resuelve de verdad contra resolutores externos: es lo que hace que la direccion fijada
  // proceda de una validacion autentica y no de una constante de la prueba.
  const ssrfGuard = new PinnedDnsSsrfGuard({ externalResolvers: ['1.1.1.1', '8.8.8.8'], lookupTimeoutMs: 8000 });
  const transport = new FakeCdpTransport();
  const browserAdapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: createMockContainerRuntime(),
    ssrfGuard,
    containerImage: 'entrenador-aislado:1.0.0',
    sessionTtlSeconds: 300,
    transportFactory: () => transport,
  });

  const useCase = new LaunchTrainingBrowserUseCase({
    browserAdapter,
    ssrfGuard,
    overlayAgentFactory: () => createSpiedOverlayAgent(),
    sessionRepository: {
      createSession: async () => undefined,
      updateSessionMode: async () => undefined,
      finalizeSession: async () => undefined,
    },
    elementRepository: {
      saveTaggedElement: async () => ({ mapElementId: 'map-el-fijacion' }),
    },
    elementValidator: {
      validateElementAction: async () => ({ allowed: true }),
    },
  });

  return { useCase, restoreFetch: installFakeTargetDiscovery() };
}

/** Verifica que la regla de fijacion aplicada contiene la correspondencia nombre a direccion. */
async function verifyPinningRuleReachesContainer(): Promise<void> {
  runtimeLog.started.length = 0;
  const { useCase, restoreFetch } = buildUseCase();

  try {
    const snapshot = await useCase.startSession({
      actor: TEST_ACTOR,
      accessChannel: 'WEB_DASHBOARD',
      initialUrl: PUBLIC_TARGET_URL,
    });

    const spec = runtimeLog.started[0];
    check(spec !== undefined, 'El contenedor debe haberse creado');
    check(snapshot.pinningRule.length > 0, 'La instantanea de la sesion debe declarar la regla de fijacion');

    // LA ASERCION CENTRAL: la regla debe contener la correspondencia `MAP <host> <direccion>`. Si solo
    // contiene la exclusion del bucle local, la defensa contra el rebinding de DNS esta desconectada.
    check(
      spec?.hostResolverRules.includes('MAP ') === true,
      `El contenedor DEBE recibir la correspondencia de fijacion (obtenido: "${String(spec?.hostResolverRules)}")`
    );
    check(
      spec?.hostResolverRules === snapshot.pinningRule,
      'La regla que recibe el contenedor debe ser exactamente la que calculo el escudo'
    );
    check(
      spec?.hostResolverRules.includes('example.com') === true,
      'La correspondencia debe fijar el nombre de host navegado'
    );
  } finally {
    restoreFetch();
  }
}

/** Verifica que la direccion fijada sea la que el escudo valido, no una constante. */
async function verifyPinningRulePinsValidatedAddress(): Promise<void> {
  runtimeLog.started.length = 0;
  const { useCase, restoreFetch } = buildUseCase();

  try {
    const snapshot = await useCase.startSession({
      actor: TEST_ACTOR,
      accessChannel: 'WEB_DASHBOARD',
      initialUrl: PUBLIC_TARGET_URL,
    });

    const spec = runtimeLog.started[0];
    const direccionValidada = snapshot.pinnedIp;

    // La direccion fijada debe ser exactamente la que el escudo clasifico como segura y guardo en la
    // instantanea. Si difirieran, el navegador podria conectar a una direccion que nadie valido.
    check(
      spec?.hostResolverRules.includes(direccionValidada) === true,
      `La regla debe fijar la direccion que el escudo valido (${direccionValidada}); obtenido: "${String(spec?.hostResolverRules)}"`
    );
    check(
      /^MAP example\.com (\[[0-9a-fA-F:]+\]|[0-9.]+), EXCLUDE localhost$/u.test(spec?.hostResolverRules ?? ''),
      `La regla debe tener la forma exacta que espera el motor de contenedores (obtenido: "${String(spec?.hostResolverRules)}")`
    );
  } finally {
    restoreFetch();
  }
}

/** Verifica que la exclusion del bucle local se conserve junto con la correspondencia. */
async function verifyLocalhostExclusionIsPreserved(): Promise<void> {
  runtimeLog.started.length = 0;
  const { useCase, restoreFetch } = buildUseCase();

  try {
    await useCase.startSession({
      actor: TEST_ACTOR,
      accessChannel: 'WEB_DASHBOARD',
      initialUrl: PUBLIC_TARGET_URL,
    });

    const spec = runtimeLog.started[0];
    // La fijacion NO debe sustituir a la exclusion del bucle local: son dos defensas distintas y
    // perder la segunda dejaria al navegador resolviendo el bucle local por su cuenta.
    check(
      spec?.hostResolverRules.includes('EXCLUDE localhost') === true,
      'La regla debe conservar la exclusion del bucle local junto con la correspondencia'
    );
  } finally {
    restoreFetch();
  }
}

/** Ejecuta los tres bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE LA FIJACION DE DIRECCIONES EN EL CONTENEDOR DE ENTRENAMIENTO');
  console.log('='.repeat(96));

  await verifyPinningRuleReachesContainer();
  console.log('[1/3] La regla de fijacion llega a la especificacion del contenedor: APROBADO.');

  await verifyPinningRulePinsValidatedAddress();
  console.log('[2/3] La direccion fijada es la que valido el escudo: APROBADO.');

  await verifyLocalhostExclusionIsPreserved();
  console.log('[3/3] La exclusion del bucle local se conserva: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

const timeoutHandle = setTimeout(() => {
  console.error(`RESULTADO: FALLIDO. La prueba excedio ${PINNING_TEST_TIMEOUT_MS} ms.`);
  process.exit(1);
}, PINNING_TEST_TIMEOUT_MS);

void main()
  .then(() => {
    clearTimeout(timeoutHandle);
    process.exit(0);
  })
  .catch((error: unknown) => {
    clearTimeout(timeoutHandle);
    console.error('RESULTADO: FALLIDO.');
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });

