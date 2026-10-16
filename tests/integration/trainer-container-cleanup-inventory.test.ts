/**
 * @archivo tests/integration/trainer-container-cleanup-inventory.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba del Inventario de Contenedores por Camino de Error)
 * @proposito
 *   Certifica la unica propiedad que no admite matices en el ciclo de vida del navegador de
 *   entrenamiento: **cada contenedor creado se destruye, en todos y cada uno de los caminos de error**
 *   de la puesta en marcha de la sesion.
 *
 *   Esta prueba existe por un defecto medido y reproducible: el contenedor se creaba y **despues** se
 *   obtenia el transporte de depuracion, y ambas operaciones estaban FUERA del bloque protegido cuyo
 *   manejador de error destruye el contenedor. Una excepcion en la fabrica del transporte producia
 *   1 contenedor creado, 0 destruidos y 0 sesiones rastreadas: el navegador sobrevivia con las cookies
 *   y la sesion autenticada del usuario final que se estaba entrenando, y nadie lo destruia despues
 *   porque el registro de contenedores no se poblaba en ningun punto.
 *
 *   La prueba no comprueba que "no se lanzo un error" —el error DEBE propagarse— sino el inventario
 *   resultante: cuantos contenedores se crearon, cuantos se destruyeron y cuantas sesiones quedaron
 *   rastreadas. Una prueba que pasara con y sin el defecto no protegeria nada, de modo que cada caso
 *   afirma explicitamente `created === destroyed` y el rastro no vacio del contenedor concreto.
 *
 * @resumen_contenido
 *   - Funcion `runErrorPathCase()`: Ejecuta un camino de error y verifica el inventario resultante.
 *   - Bloque `verifyEveryErrorPathDestroys()`: Los cinco caminos de error de la puesta en marcha.
 *   - Bloque `verifySweeperDestroysExpiredContainers()`: El barrido periodico interno destruye lo vencido.
 *   - Bloque `verifySweeperOnlyDestroysExpired()`: El barrido periodico NO destruye lo que sigue vigente.
 *   - Bloque `verifyGlobalCleanupPaths()`: Barrido a demanda y destruccion masiva.
 *
 * @dependencias_internas
 *   - Dobles de contenedor y transporte (`./support/trainer-doubles.ts`): `runtimeLog.started` y
 *     `runtimeLog.destroyed` son el inventario que esta prueba audita.
 *   - `EphemeralChromiumCdpAdapter` y `PinnedDnsSsrfGuard` del modulo de entrenamiento.
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna. El runtime de contenedores y el punto de depuracion se sustituyen por dobles: la prueba
 *     mide el inventario, no la infraestructura.
 */

import * as assert from 'node:assert';
import { EphemeralChromiumCdpAdapter } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter';
import { PinnedDnsSsrfGuard } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';
import {
  FakeCdpTransport,
  createMockContainerRuntime,
  installFakeTargetDiscovery,
  resetRuntimeLog,
  runtimeLog,
} from './support/trainer-doubles';

/** Contexto de entrenamiento usado por todos los casos. */
const TRAINING_CONTEXT = { organizationId: 'org-inventario', projectId: 'prj-inventario' };

/** Imagen del navegador efimero usada por todos los casos. */
const CONTAINER_IMAGE = 'entrenador-aislado:1.0.0';

/** Escudo Anti-SSRF inerte: esta prueba audita el ciclo de vida, no las decisiones de red. */
const ssrfGuard = new PinnedDnsSsrfGuard({ externalResolvers: ['1.1.1.1'], lookupTimeoutMs: 2000 });

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
 * Espera el numero de milisegundos indicado.
 *
 * @param milliseconds - Tiempo de espera.
 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Opciones de un caso de camino de error. */
interface ErrorPathCase {
  /** Nombre legible del camino de error auditado. */
  readonly label: string;
  /** Fabrica del transporte de gobierno, o la que debe provocar la excepcion. */
  readonly transportFactory?: () => FakeCdpTransport;
  /** Sustituye el descubrimiento del punto de depuracion por un fallo de red. */
  readonly failTargetDiscovery?: boolean;
  /** Provoca el fallo dentro del transporte simulado. */
  readonly transportFailure?: (transport: FakeCdpTransport) => void;
  /** Provoca el fallo dentro del runtime de contenedores. */
  readonly failContainerStart?: boolean;
}

/**
 * Ejecuta un camino de error de la puesta en marcha y audita el inventario de contenedores.
 *
 * Verifica las cuatro propiedades que hacen imposible el contenedor huerfano: el error se propaga,
 * el contenedor creado aparece destruido, no queda ninguna sesion rastreada y el inventario cuadra
 * (`creados === destruidos`). El transporte, cuando llego a existir, debe quedar cerrado.
 *
 * @param testCase - Camino de error que se va a provocar.
 * @returns Promesa resuelta cuando el caso termino y su inventario quedo verificado.
 */
async function runErrorPathCase(testCase: ErrorPathCase): Promise<void> {
  resetRuntimeLog();
  const restoreFetch = installFakeTargetDiscovery();
  const failingTransport = new FakeCdpTransport();
  if (testCase.transportFailure !== undefined) {
    testCase.transportFailure(failingTransport);
  }

  const containerRuntime = createMockContainerRuntime();
  const runtime = testCase.failContainerStart === true
    ? {
        startContainer: async (): Promise<never> => {
          throw new Error('MOTOR_DE_CONTAINERES_NO_DISPONIBLE: no fue posible crear el contenedor.');
        },
        destroyContainer: containerRuntime.destroyContainer,
      }
    : containerRuntime;

  const adapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: runtime,
    ssrfGuard,
    containerImage: CONTAINER_IMAGE,
    sessionTtlSeconds: 300,
    maxConcurrentSessions: 2,
    // Todos los casos inyectan un transporte SIMULADO; el que provoca el fallo concreto es
    // `transportFailure`. Dejar el valor por omision en un caso que espera fallar haria que la prueba
    // ejercitara el canal WebSocket real contra un puerto cerrado, que es un fallo distinto del que se
    // quiere auditar (y que ocultaria si el contenedor se destruye en el camino previsto).
    transportFactory: testCase.transportFactory ?? ((): FakeCdpTransport => failingTransport),
  });

  if (testCase.failTargetDiscovery === true) {
    globalThis.fetch = (async () => {
      throw new Error('PUNTO_DE_DEPURACION_INALCANZABLE');
    }) as typeof fetch;
  }

  let caughtError: unknown = null;
  try {
    await adapter.launchSession('trn-inventario', TRAINING_CONTEXT);
  } catch (error) {
    caughtError = error;
  } finally {
    restoreFetch();
    adapter.stopSessionSweeper();
  }

  check(caughtError instanceof Error, `[${testCase.label}] el fallo debe propagarse al llamador`);
  check(
    adapter.activeSessionCount === 0,
    `[${testCase.label}] no debe quedar ninguna sesion rastreada (obtenido: ${adapter.activeSessionCount})`
  );
  check(
    runtimeLog.started.length === runtimeLog.destroyed.length,
    `[${testCase.label}] el inventario debe cuadrar: ${runtimeLog.started.length} creado(s) frente a ${runtimeLog.destroyed.length} destruido(s)`
  );
  if (testCase.failContainerStart === true) {
    // Aqui el runtime no llego a crear nada: el caso legitimo es cero contenedores, no uno huerfano.
    check(
      runtimeLog.started.length === 0 && runtimeLog.destroyed.length === 0,
      `[${testCase.label}] un runtime que no crea el contenedor no debe dejar residuo alguno (creados: ${runtimeLog.started.length})`
    );
  } else {
    check(
      runtimeLog.started.length === 1,
      `[${testCase.label}] el contenedor debe haberse creado antes de fallar (creados: ${runtimeLog.started.length})`
    );
    check(
      runtimeLog.destroyed.includes('oa-trainer-trn-inventario'),
      `[${testCase.label}] el contenedor creado debe figurar como destruido (destruidos: ${JSON.stringify(runtimeLog.destroyed)})`
    );
    check(
      runtimeLog.destroyed.length === 1,
      `[${testCase.label}] exactamente un contenedor creado y un contenedor destruido (obtenido: ${runtimeLog.destroyed.length})`
    );
  }
  if (testCase.transportFailure !== undefined) {
    check(failingTransport.closed, `[${testCase.label}] el canal de depuracion abierto debe quedar cerrado`);
  }
}

/**
 * Verifica los cinco caminos de error de la puesta en marcha de la sesion.
 *
 * Cada caso corresponde a un paso que puede fallar antes de que la sesion quede utilizable: la
 * creacion del contenedor, la obtencion del transporte, el descubrimiento del objetivo de depuracion,
 * la conexion del canal y la habilitacion de la interceptacion. El de la obtencion del transporte es
 * el que estaba medido como defecto: era el unico que dejaba el contenedor vivo.
 */
async function verifyEveryErrorPathDestroys(): Promise<void> {
  await runErrorPathCase({
    label: 'creacion del contenedor',
    failContainerStart: true,
  });

  await runErrorPathCase({
    label: 'obtencion del transporte',
    transportFactory: (): FakeCdpTransport => {
      throw new Error('TRANSPORTE_DE_DEPURACION_NO_DISPONIBLE: la fabrica del canal fallo.');
    },
  });

  await runErrorPathCase({
    label: 'descubrimiento del objetivo de depuracion',
    failTargetDiscovery: true,
  });

  await runErrorPathCase({
    label: 'conexion del canal de depuracion',
    transportFailure: (transport): void => {
      transport.connect = async (): Promise<void> => {
        throw new Error('CANAL_DE_DEPURACION_RECHAZADO: el navegador no acepto la conexion.');
      };
    },
  });

  await runErrorPathCase({
    label: 'envio de la configuracion inicial',
    transportFailure: (transport): void => {
      transport.send = async (): Promise<never> => {
        throw new Error('COMANDO_INICIAL_RECHAZADO: el navegador rechazo la configuracion inicial.');
      };
    },
  });

  await runErrorPathCase({
    label: 'habilitacion de la interceptacion',
    transportFailure: (transport): void => {
      transport.enableRequestInterception = async (): Promise<never> => {
        throw new Error('INTERCEPCION_NO_HABILITABLE: el navegador rechazo la interceptacion.');
      };
    },
  });
}

/** Verifica que el barrido periodico interno destruya por su cuenta un contenedor vencido. */
async function verifySweeperDestroysExpiredContainers(): Promise<void> {
  resetRuntimeLog();
  const restoreFetch = installFakeTargetDiscovery();
  const adapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: createMockContainerRuntime(),
    ssrfGuard,
    containerImage: CONTAINER_IMAGE,
    sessionTtlSeconds: 1,
    sweepIntervalMs: 250,
    transportFactory: () => new FakeCdpTransport(),
  });

  try {
    await adapter.launchSession('trn-vencida', TRAINING_CONTEXT);
    check(adapter.isSweeperRunning, 'El barrido periodico debe armarse al registrar la primera sesion');

    // Nadie invoca el barrido: lo dispara el temporizador interno. Es exactamente la diferencia que
    // dejaba vivos a los contenedores vencidos cuando el barrido solo existia como metodo publico.
    await wait(2000);

    check(
      runtimeLog.destroyed.includes('oa-trainer-trn-vencida'),
      `El barrido periodico debe destruir el contenedor vencido sin que nadie lo invoque (destruidos: ${JSON.stringify(runtimeLog.destroyed)})`
    );
    check(adapter.activeSessionCount === 0, 'Tras el barrido periodico no debe quedar ninguna sesion rastreada');
  } finally {
    adapter.stopSessionSweeper();
    restoreFetch();
  }
}

/** Verifica que el barrido periodico no destruya un contenedor que sigue vigente. */
async function verifySweeperOnlyDestroysExpired(): Promise<void> {
  resetRuntimeLog();
  const restoreFetch = installFakeTargetDiscovery();
  const adapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: createMockContainerRuntime(),
    ssrfGuard,
    containerImage: CONTAINER_IMAGE,
    sessionTtlSeconds: 300,
    sweepIntervalMs: 200,
    transportFactory: () => new FakeCdpTransport(),
  });

  try {
    await adapter.launchSession('trn-vigente', TRAINING_CONTEXT);
    // El periodo del barrido es varias veces menor que la vida de la sesion: si el barrido destruyera
    // por disparo y no por vencimiento, este contenedor ya habria muerto.
    await wait(1200);

    check(adapter.activeSessionCount === 1, 'Una sesion vigente no debe ser destruida por el barrido periodico');
    check(runtimeLog.destroyed.length === 0, 'El barrido periodico no debe destruir contenedores vigentes');

    const swept = await adapter.sweepExpiredSessions();
    check(swept.length === 0, 'El barrido a demanda no debe reportar sesiones vigentes como destruidas');
  } finally {
    adapter.stopSessionSweeper();
    restoreFetch();
  }
}

/** Verifica la detencion del barrido, el barrido a demanda y la destruccion masiva. */
async function verifyGlobalCleanupPaths(): Promise<void> {
  resetRuntimeLog();
  const restoreFetch = installFakeTargetDiscovery();
  const adapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: createMockContainerRuntime(),
    ssrfGuard,
    containerImage: CONTAINER_IMAGE,
    sessionTtlSeconds: 300,
    sweepIntervalMs: 250,
    transportFactory: () => new FakeCdpTransport(),
  });

  try {
    await adapter.launchSession('trn-masiva-uno', TRAINING_CONTEXT);
    await adapter.launchSession('trn-masiva-dos', TRAINING_CONTEXT);
    check(adapter.activeSessionCount === 2, 'Las dos sesiones deben quedar registradas como vivas');

    adapter.stopSessionSweeper();
    check(!adapter.isSweeperRunning, 'Detener el barrido debe desarmar su temporizador');

    const destroyed = await adapter.destroyAllSessions();
    check(destroyed.length === 2, 'La destruccion masiva debe reportar las dos sesiones destruidas');
    check(adapter.activeSessionCount === 0, 'La destruccion masiva no debe dejar sesiones rastreadas');
    check(
      runtimeLog.started.length === runtimeLog.destroyed.length,
      `El inventario debe cuadrar tras la destruccion masiva: ${runtimeLog.started.length} creado(s) frente a ${runtimeLog.destroyed.length} destruido(s)`
    );
    check(
      runtimeLog.destroyed.includes('oa-trainer-trn-masiva-uno') && runtimeLog.destroyed.includes('oa-trainer-trn-masiva-dos'),
      'Los dos contenedores creados deben figurar como destruidos'
    );
  } finally {
    adapter.stopSessionSweeper();
    restoreFetch();
  }
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DEL INVENTARIO DE CONTENEDORES POR CAMINO DE ERROR (HALLAZGO C1-47)');
  console.log('='.repeat(96));

  await verifyEveryErrorPathDestroys();
  console.log('[1/4] Los seis caminos de error destruyen el contenedor y no rastrean sesion: APROBADO.');

  await verifySweeperDestroysExpiredContainers();
  console.log('[2/4] El barrido periodico destruye el contenedor vencido sin invocacion externa: APROBADO.');

  await verifySweeperOnlyDestroysExpired();
  console.log('[3/4] El barrido periodico respeta los contenedores vigentes: APROBADO.');

  await verifyGlobalCleanupPaths();
  console.log('[4/4] Detencion del barrido y destruccion masiva sin residuos: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
