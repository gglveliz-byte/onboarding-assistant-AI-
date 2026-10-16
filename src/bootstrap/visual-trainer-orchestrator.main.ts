/**
 * @archivo src/bootstrap/visual-trainer-orchestrator.main.ts
 * @modulo Bootstrap (Entrypoint del Node Pool `visual-trainer-orchestrator`)
 * @proposito
 *   Arranca el pool que gestiona los navegadores efimeros de entrenamiento visual. Es el unico pool
 *   que vive en la red DMZ y su obligacion propia, la razon por la que este entrypoint existe
 *   separado, es la **destruccion garantizada de los contenedores**: un navegador de entrenamiento
 *   olvidado sigue consumiendo CPU y memoria de la cuenta, y ademas conserva en su interior la
 *   sesion autenticada del usuario final sobre la que se entreno. Por eso el cierre libera los
 *   recursos antes que la infraestructura y deja constancia de cuantos contenedores quedaron vivos:
 *   la unica prueba de que la limpieza ocurrio es haberla contado.
 *
 * @resumen_contenido
 *   - Constantes `POOL_ROLE` y `TRAINER_HEALTH_PATH`.
 *   - Clase `TrainerContainerRegistry`: Seguimiento y destruccion de contenedores efimeros.
 *   - Funcion `startVisualTrainerOrchestrator()`: Ensamblaje, escucha y limpieza ordenada.
 *
 * @dependencias_internas
 *   - `bootstrapBackendSystem()` (`./module-autoloader.ts`) e `installGracefulShutdown()` (`./bootstrap-runtime.ts`).
 *   - `registerVisualTrainerRagModule()` (`src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest.ts`).
 *   - `createDockerBrowserRuntime()` (`src/modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime.ts`).
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para el endpoint de la DMZ.
 *
 * @dependencias_externas
 *   - `node:http` (Servidor nativo: el pool solo expone salud y metricas internas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` y `functional_maps` (Estado del entrenamiento).
 *   - Redis: `oa:training:*` (Sesiones de entrenamiento activas y bloqueos de contenedor).
 */

import { createServer, type Server } from 'node:http';
import { bootstrapBackendSystem, describeAssembly, type BootstrappedSystem } from './module-autoloader';
import { installGracefulShutdown, registerHttpRouteSummaryLog, type NodePoolRuntime } from './bootstrap-runtime';
import { DockerCliBrowserContainerRuntime } from '../modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime';
import { EphemeralChromiumCdpAdapter } from '../modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter';
import { PinnedDnsSsrfGuard } from '../modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';

/** Rol del pool que ejecuta este entrypoint. */
const POOL_ROLE = 'VISUAL_TRAINER_ORCHESTRATOR';

/** Camino del endpoint de salud del orquestador de entrenamiento. */
const TRAINER_HEALTH_PATH = '/salud';

/**
 * Sesion de entrenamiento viva en el pool.
 *
 * El pool no gestiona contenedores sueltos sino SESIONES: el adaptador de Chromium efimero ya
 * garantiza que cada sesion tenga su propio contenedor aislado con el escudo Anti-SSRF, y expone
 * `destroySession()` y `sweepExpiredSessions()` como unicas vias autorizadas de limpieza. Duplicar
 * esa contabilidad aqui abriria contenedores que nadie rastrearia.
 */
interface LiveTrainerSession {
  /** Sesion de entrenamiento que solicito el navegador. */
  readonly trainingSessionId: string;
  /** Organizacion propietaria del entrenamiento. */
  readonly organizationId: string;
  /** Momento de creacion, usado para detectar sesiones que excedieron su vida util. */
  readonly createdAtMs: number;
  /** Adaptador del navegador efimero, con sus metodos de destruccion y barrido. */
  readonly browser: EphemeralChromiumCdpAdapter;
}

/**
 * Registro de contenedores de navegador vivos en el proceso.
 *
 * Su razon de existir es que un contenedor de navegador NO se libera solo: si el proceso muere sin
 * destruirlo, queda consumiendo recursos de la cuenta y conservando la sesion del usuario final
 * dentro. El registro permite contarlos, detectar los que excedieron su vida util y destruirlos
 * todos durante el apagado.
 */
export class TrainerContainerRegistry {
  private readonly containers = new Map<string, LiveTrainerSession>();
  private readonly maxLifetimeMs: number;

  /**
   * @param maxLifetimeMs - Vida maxima de un contenedor antes de considerarse huerfano.
   */
  public constructor(maxLifetimeMs: number) {
    this.maxLifetimeMs = maxLifetimeMs;
  }

  /**
   * Incorpora un contenedor vivo al registro.
   *
   * @param container - Contenedor con su adaptador y su sesion.
   */
  public add(container: LiveTrainerSession): void {
    this.containers.set(container.trainingSessionId, container);
  }

  /**
   * Retira un contenedor del registro sin destruirlo.
   *
   * @param containerId - Identificador del contenedor.
   * @returns `true` cuando el contenedor estaba registrado.
   */
  public forget(trainingSessionId: string): boolean {
    return this.containers.delete(trainingSessionId);
  }

  /**
   * Devuelve el numero de contenedores vivos.
   *
   * @returns Cantidad de contenedores activos.
   */
  public count(): number {
    return this.containers.size;
  }

  /**
   * Identifica los contenedores que excedieron su vida maxima.
   *
   * @param nowMs - Instante de referencia.
   * @returns Contenedores que deberian destruirse por antiguedad.
   */
  public findExpiredSessions(nowMs: number = Date.now()): readonly LiveTrainerSession[] {
    return [...this.containers.values()].filter((session) => nowMs - session.createdAtMs >= this.maxLifetimeMs);
  }

  /**
   * Destruye un contenedor concreto liberando sus recursos.
   *
   * @param containerId - Identificador del contenedor.
   * @returns `true` cuando el contenedor se destruyo.
   */
  public async destroySession(trainingSessionId: string): Promise<boolean> {
    const container = this.containers.get(trainingSessionId);
    if (container === undefined) {
      return false;
    }
    this.containers.delete(trainingSessionId);

    try {
      // `destroySession()` es la unica via autorizada de limpieza del adaptador: cierra el socket
      // CDP, destruye el contenedor y purga el audio residente en memoria.
      await container.browser.destroySession(trainingSessionId);
    } catch {
      // Un fallo al destruir ordenadamente no exime de liberar. El barrido del adaptador reintenta
      // la limpieza de las sesiones que excedieron su vida util, de modo que el contenedor no queda
      // huerfano aunque esta llamada falle.
      await container.browser.sweepExpiredSessions().catch(() => []);
    }
    return true;
  }

  /**
   * Destruye todos los contenedores vivos, usado durante el apagado del nodo.
   *
   * @returns Recuento con los contenedores destruidos y los que fallaron.
   */
  public async destroyAll(): Promise<{ readonly destroyedCount: number; readonly failedCount: number }> {
    const containerIds = [...this.containers.keys()];
    let destroyedCount = 0;
    let failedCount = 0;

    for (const containerId of containerIds) {
      const stillRegistered = this.containers.has(containerId);
      const destroyed = await this.destroySession(containerId);
      if (destroyed) {
        destroyedCount += 1;
      } else if (stillRegistered) {
        failedCount += 1;
      }
    }

    // El conteo final es la unica prueba de que la limpieza ocurrio: si quedara algun contenedor
    // registrado, no se destruyo.
    const remaining = this.containers.size;
    return { destroyedCount, failedCount: failedCount + remaining };
  }
}

/**
 * Arranca el orquestador de entrenamiento visual: ensambla, escucha en el puerto de la DMZ y prepara
 * la destruccion garantizada de contenedores al apagarse.
 *
 * @param portOverride - Puerto alternativo, usado por las pruebas.
 * @returns Servidor, registro de contenedores y la funcion de cierre bajo demanda.
 */
export async function startVisualTrainerOrchestrator(portOverride?: number): Promise<{
  readonly registry: TrainerContainerRegistry;
  readonly system: BootstrappedSystem;
  readonly shutdown: (signal: string) => Promise<unknown>;
  readonly port: number;
  readonly getListeningPort: () => number;
}> {
  const startedAtMs = Date.now();
  const system = bootstrapBackendSystem({ nodePoolRole: POOL_ROLE });
  const port = portOverride ?? system.environment.TRAINER_WS_PORT;

  const log = (message: string, metadata?: Readonly<Record<string, unknown>>): void => {
    process.stdout.write(`[${POOL_ROLE}] ${message}${metadata === undefined ? '' : ` ${JSON.stringify(metadata)}`}\n`);
  };

  log(describeAssembly(system));

  // La vida maxima del contenedor se deriva del limite de duracion de sesion configurado: un
  // navegador de entrenamiento no puede vivir mas que la sesion que lo solicito.
  const registry = new TrainerContainerRegistry(system.environment.VOICE_SESSION_MAX_MINUTES * 60 * 1000);
  // El runtime de contenedores habla con el motor de contenedores por su interfaz de linea de
  // comandos, y el adaptador de Chromium efimero lo consume para abrir y destruir un contenedor
  // aislado por sesion de entrenamiento, con el escudo Anti-SSRF validando cada peticion de red del
  // navegador: el navegador de entrenamiento navega sitios de terceros y es la superficie de ataque
  // mas expuesta de toda la plataforma.
  const ssrfGuard = new PinnedDnsSsrfGuard({
    externalResolvers: system.environment.EXTERNAL_DNS_RESOLVERS,
    lookupTimeoutMs: system.environment.SSRF_DNS_LOOKUP_TIMEOUT_MS,
    allowPrivateNetworks: system.environment.SSRF_ALLOW_PRIVATE_NETWORKS,
  });
  const browserRuntime = new DockerCliBrowserContainerRuntime();
  const browserAdapter = new EphemeralChromiumCdpAdapter({
    containerRuntime: browserRuntime,
    ssrfGuard,
    containerImage: system.environment.CHROMIUM_CONTAINER_IMAGE,
    sessionTtlSeconds: system.environment.CHROMIUM_SESSION_TTL_SECONDS,
  });

  const httpServer: Server = createServer((request, response) => {
    if (request.url === TRAINER_HEALTH_PATH) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          status: 'ok',
          pool: POOL_ROLE,
          activeContainers: registry.count(),
          dmzEndpoint: system.environment.CHROMIUM_DMZ_ENDPOINT,
        })
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'El orquestador de entrenamiento no expone APIs publicas.' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const runtime: NodePoolRuntime = {
    nodePoolRole: POOL_ROLE,
    system,
    listeningPorts: [port],
    startedAtMs,
  };
  registerHttpRouteSummaryLog(runtime, log);
  log(`Orquestador de entrenamiento escuchando en el puerto ${port}.`);

  const shutdown = installGracefulShutdown(
    runtime,
    {
      stopAcceptingConnections: async () => {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          if (typeof httpServer.closeAllConnections === 'function') {
            httpServer.closeAllConnections();
          }
        });
      },
      releaseOwnedResources: async () => {
        // Los contenedores se destruyen ANTES de cerrar el pool: destruirlos despues perderia el
        // contexto transaccional necesario para marcar las sesiones de entrenamiento como terminadas.
        const expiredSessions = registry.findExpiredSessions();
        for (const expiredSession of expiredSessions) {
          log('Destruyendo una sesion de entrenamiento que excedio su vida util.', {
            trainingSessionId: expiredSession.trainingSessionId,
          });
          await registry.destroySession(expiredSession.trainingSessionId);
        }

        const destruction = await registry.destroyAll();
        if (destruction.failedCount > 0) {
          log('ATENCION: quedaron contenedores sin destruir; requieren limpieza de la DMZ.', {
            destroyedCount: destruction.destroyedCount,
            failedCount: destruction.failedCount,
          });
          return;
        }
        log(`${destruction.destroyedCount} contenedor(es) de navegador destruidos sin dejar residuos.`);
      },
    },
    log
  );

  // El runtime de contenedores NO se vuelve a registrar: el manifiesto del modulo 03 ya resolvio
  // `DI_TOKENS.VisualTrainerPort` con sus propios adaptadores, y registrarlo de nuevo lanza
  // `DEPENDENCIA_DUPLICADA` —cada servicio se registra una sola vez por diseno—. El orquestador
  // conserva sus instancias para el barrido de sesiones expiradas al apagarse.

  return {
    registry,
    system,
    shutdown,
    port,
    getListeningPort: (): number => {
      const address = httpServer.address();
      return address !== null && typeof address === 'object' ? address.port : port;
    },
  };
}

/** Punto de entrada cuando el archivo se ejecuta directamente. */
if (require.main === module) {
  void startVisualTrainerOrchestrator().catch((error: unknown) => {
    process.stderr.write(`[${POOL_ROLE}] Fallo al arrancar: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}






