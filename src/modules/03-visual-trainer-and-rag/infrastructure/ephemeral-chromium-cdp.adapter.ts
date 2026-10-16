/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter.ts
 * @modulo 03-visual-trainer-and-rag (Ciclo de Vida del Navegador Efimero e Interceptacion SSRF)
 * @proposito
 *   Gestiona el ciclo de vida completo del contenedor de navegacion efimero: lo crea con
 *   almacenamiento exclusivamente en memoria RAM, le impone un tiempo de vida maximo, lo destruye
 *   de forma incondicional al cerrar y valida CADA peticion de red que emite el navegador mediante
 *   el decisor Anti-SSRF. El runtime del contenedor se inyecta como dependencia para que la logica
 *   de seguridad y el ciclo de vida sean verificables sin un motor de contenedores disponible, y
 *   para que el mismo codigo opere en produccion y en las pruebas automatizadas.
 *
 * @resumen_contenido
 *   - Interface `EphemeralBrowserSession`: Sesion activa con su contenedor y su expiracion.
 *   - Clase `TrainingCapacityExceededError`: Limite de sesiones simultaneas alcanzado.
 *   - Clase `EphemeralChromiumCdpAdapter`:
 *       * `launchSession()`: Crea el contenedor, conecta CDP y habilita la interceptacion SSRF bajo
 *         una unica proteccion de error: cualquier fallo —creacion, descubrimiento, conexion,
 *         comandos iniciales o interceptacion— destruye el contenedor antes de propagar.
 *       * `forwardDeveloperClick()` y `forwardDeveloperText()`: Puente de entrada del visor.
 *       * `destroySession()` y `destroyAllSessions()`: Destruccion incondicional del contenedor.
 *       * `sweepExpiredSessions()`: Barrido de sesiones que superaron su tiempo de vida.
 *       * `stopSessionSweeper()`: Detencion del barrido periodico durante el apagado ordenado.
 *       * `countBlockedRequests()`: Bloqueos Anti-SSRF acumulados por la sesion.
 *   - Constante `MAX_CONTAINER_TTL_SECONDS`: Techo absoluto de vida de un contenedor (30 minutos).
 *
 * @dependencias_internas
 *   - `BrowserContainerRuntime` (`./docker-browser-runtime.ts`): Puerto del runtime de contenedores.
 *   - `PinnedDnsSsrfGuard` (`./pinned-dns-ssrf.guard.ts`) y `SsrfRequestInterceptor`.
 *   - `CdpWebSocketConnection` y `discoverActiveCdpTarget` (`./cdp-target-discovery.ts`).
 *   - `createActiveContainerSweeper` (`./container-session-sweeper.ts`): Barrido periodico interno.
 *
 * @dependencias_externas
 *   - Ninguna (El acceso al motor de contenedores queda aislado en el runtime inyectado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (`container_id`, `status`, `hard_ttl_expires_at`).
 *   - PostgreSQL: `audit_logs` (Los bloqueos del escudo se registran con severidad critica).
 */

import { CdpWebSocketConnection } from './cdp-websocket-connection';
import { discoverActiveCdpTarget } from './cdp-target-discovery';
import type { CdpTransport, CdpTransportFactory } from './cdp-transport.port';
import { createActiveContainerSweeper, type ActiveContainerSweeper } from './container-session-sweeper';
import {
  DEFAULT_CPU_LIMIT,
  DEFAULT_DEBUGGER_PORT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_TMPFS_SIZE,
  type BrowserContainerRuntime,
  type BrowserContainerSpec,
} from './docker-browser-runtime';
import type { PinnedDnsSsrfGuard } from './pinned-dns-ssrf.guard';
import { SsrfRequestInterceptor } from './ssrf-request-interceptor';

/** Tiempo de vida maximo absoluto del contenedor efimero, en segundos (30 minutos). */
export const MAX_CONTAINER_TTL_SECONDS = 1800;

/** Sesion de navegacion efimera activa. */
export interface EphemeralBrowserSession {
  /** Identificador de la sesion de entrenamiento persistida. */
  readonly trainingSessionId: string;
  /** Identificador del contenedor creado. */
  readonly containerId: string;
  /** URL base del punto de depuracion del contenedor. */
  readonly debuggerBaseUrl: string;
  /** Momento de creacion de la sesion, en milisegundos desde el epoch. */
  readonly createdAtMs: number;
  /** Momento en el que la sesion debe destruirse obligatoriamente. */
  readonly expiresAtMs: number;
  /** Numero de peticiones bloqueadas por el escudo Anti-SSRF durante la sesion. */
  readonly blockedRequestCount: number;
}

/** Parametros de construccion del adaptador. */
export interface EphemeralChromiumCdpAdapterOptions {
  /** Runtime de contenedores que crea y destruye el navegador. */
  readonly containerRuntime: BrowserContainerRuntime;
  /** Escudo Anti-SSRF que valida cada peticion de red del navegador. */
  readonly ssrfGuard: PinnedDnsSsrfGuard;
  /** Imagen versionada del navegador efimero. */
  readonly containerImage: string;
  /** Tiempo de vida maximo de una sesion, en segundos. */
  readonly sessionTtlSeconds: number;
  /** Limite del numero de sesiones de navegador simultaneas. */
  readonly maxConcurrentSessions?: number;
  /** Fabrica del transporte de gobierno; por omision, el canal WebSocket real. */
  readonly transportFactory?: CdpTransportFactory;
  /**
   * Red dedicada a la que se conecta el contenedor del navegador.
   *
   * Debe carecer de ruta hacia la red de datos. Es la unica defensa que cubre las salidas que la
   * intercepcion de peticiones **no** alcanza —el canal de sockets, el tiempo real y la resolucion
   * directa—, de modo que omitirla deja abierta una via hacia los metadatos del proveedor de nube y
   * hacia el propio motor de base de datos.
   */
  readonly networkName?: string;
  /**
   * Periodo del barrido que destruye las sesiones vencidas, en milisegundos.
   *
   * Es la ventana maxima durante la cual un contenedor vencido puede seguir vivo con la sesion
   * autenticada del usuario final dentro. Si se omite, se deriva del tiempo de vida de la sesion:
   * un tercio de ese tiempo, nunca menos de un segundo ni mas de un minuto.
   */
  readonly sweepIntervalMs?: number;
}

/** Estado interno de una sesion activa administrada por el adaptador. */
interface ActiveSessionState {
  readonly containerId: string;
  readonly debuggerBaseUrl: string;
  readonly transport: CdpTransport;
  readonly expiresAtMs: number;
}

/** Limite por omision de sesiones de navegador simultaneas. */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;

/** Periodo minimo del barrido de sesiones vencidas, en milisegundos. */
const MIN_SWEEP_INTERVAL_MS = 1000;

/** Periodo maximo del barrido de sesiones vencidas, en milisegundos. */
const MAX_SWEEP_INTERVAL_MS = 60000;

/**
 * Deriva el periodo del barrido a partir del tiempo de vida configurado para la sesion.
 *
 * La regla es un tercio de la vida de la sesion: garantiza que un contenedor vencido se destruya como
 * mucho en la tercera parte de su propio tiempo de vida, sin barrer con una frecuencia que no aporte
 * nada. El resultado queda acotado entre un segundo y un minuto.
 *
 * @param sessionTtlSeconds - Tiempo de vida de la sesion de entrenamiento, en segundos.
 * @returns Periodo del barrido en milisegundos.
 */
function deriveSweepIntervalMs(sessionTtlSeconds: number): number {
  const derived = Math.ceil((sessionTtlSeconds * 1000) / 3);
  return Math.min(Math.max(derived, MIN_SWEEP_INTERVAL_MS), MAX_SWEEP_INTERVAL_MS);
}

/**
 * Regla de resolucion por omision cuando el llamador no aporta la del escudo.
 *
 * Excluye el bucle local, que es el minimo imprescindible, pero **no** fija la direccion validada: un
 * contenedor que arranque con esta regla deja abierta la ventana de rebinding de DNS. La unica
 * llamada legitima a este valor por omision es una prueba; en produccion, el caso de uso del
 * entrenamiento **siempre** pasa la regla que calculo el escudo para el destino ya validado.
 */
const DEFAULT_HOST_RESOLVER_RULES = 'EXCLUDE localhost';

/** Error lanzado cuando se alcanza el limite de sesiones simultaneas. */
export class TrainingCapacityExceededError extends Error {
  /** Numero maximo de sesiones simultaneas configurado. */
  public readonly maxConcurrentSessions: number;

  /**
   * @param maxConcurrentSessions - Limite configurado de sesiones simultaneas.
   */
  public constructor(maxConcurrentSessions: number) {
    super(
      `CAPACIDAD_DE_ENTRENAMIENTO_EXCEDIDA: se alcanzo el limite de ${maxConcurrentSessions} sesiones de navegador simultaneas. ` +
        'Cierre una sesion en curso antes de iniciar otra.'
    );
    this.name = 'TrainingCapacityExceededError';
    this.maxConcurrentSessions = maxConcurrentSessions;
  }
}

/**
 * Adaptador del navegador efimero con interceptacion Anti-SSRF de cada peticion de red.
 */
export class EphemeralChromiumCdpAdapter {
  private readonly containerRuntime: BrowserContainerRuntime;
  private readonly ssrfInterceptor: SsrfRequestInterceptor;
  private readonly containerImage: string;
  private readonly sessionTtlSeconds: number;
  private readonly maxConcurrentSessions: number;
  private readonly transportFactory: CdpTransportFactory;
  /** Red dedicada del contenedor, o undefined cuando no se declaro una. */
  private readonly networkName: string | undefined;
  private readonly sweepIntervalMs: number;
  /**
   * Registro de contenedores vivos: es el rastro de lo que este adaptador creo y todavia no destruyo.
   * Toda sesion que crea un contenedor se inscribe aqui, y toda sesion que lo destruye se retira.
   */
  private readonly activeSessions = new Map<string, ActiveSessionState>();
  /** Barrido periodico que destruye por su cuenta las sesiones que superaron su tiempo de vida. */
  private readonly containerSweeper: ActiveContainerSweeper;

  /**
   * @param options - Runtime de contenedores, escudo Anti-SSRF y limites de sesion.
   * @throws Error cuando el tiempo de vida solicitado excede el maximo absoluto de 30 minutos.
   */
  public constructor(options: EphemeralChromiumCdpAdapterOptions) {
    if (options.sessionTtlSeconds <= 0 || options.sessionTtlSeconds > MAX_CONTAINER_TTL_SECONDS) {
      throw new Error(`TIEMPO_DE_VIDA_INVALIDO: la sesion de entrenamiento debe durar entre 1 y ${MAX_CONTAINER_TTL_SECONDS} segundos.`);
    }
    this.containerRuntime = options.containerRuntime;
    this.ssrfInterceptor = new SsrfRequestInterceptor(options.ssrfGuard);
    this.containerImage = options.containerImage;
    this.sessionTtlSeconds = options.sessionTtlSeconds;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.transportFactory = options.transportFactory ?? ((): CdpTransport => new CdpWebSocketConnection());
    this.networkName = options.networkName;
    this.sweepIntervalMs = options.sweepIntervalMs ?? deriveSweepIntervalMs(options.sessionTtlSeconds);
    this.containerSweeper = createActiveContainerSweeper({
      activeSessionCount: () => this.activeSessionCount,
      destroyExpiredSessions: async (): Promise<readonly string[]> => this.sweepExpiredSessions(),
    });
  }

  /** Numero de sesiones de navegador actualmente activas. */
  public get activeSessionCount(): number {
    return this.activeSessions.size;
  }

  /** Indica si el barrido periodico de sesiones vencidas esta armado. */
  public get isSweeperRunning(): boolean {
    return this.containerSweeper.isRunning;
  }

  /**
   * Detiene el barrido periodico de sesiones vencidas y libera su temporizador.
   *
   * Es la via de limpieza que debe invocar el punto de entrada del pool durante su apagado ordenado.
   * Detener el barrido **no** destruye ninguna sesion: la destruccion de los contenedores vivos sigue
   * siendo responsabilidad de `destroySession()` y de `destroyAllSessions()`.
   */
  public stopSessionSweeper(): void {
    this.containerSweeper.stop();
  }

  /**
   * Crea el contenedor efimero, conecta el protocolo de depuracion y habilita la interceptacion de
   * red con el escudo Anti-SSRF.
   *
   * @param trainingSessionId - Identificador de la sesion de entrenamiento persistida.
   * @param context - Organizacion y proyecto para el registro de auditoria de bloqueos.
   * @param hostResolverRules - Regla de fijacion de direcciones que calculo el escudo para el destino
   *   ya validado, en el formato que espera el motor del navegador. Es la capa que neutraliza el
   *   **rebinding de DNS**: fija el nombre a la direccion que el escudo **ya valido**, de modo que el
   *   navegador no pueda volver a resolver y obtener una direccion interna distinta entre la
   *   validacion y la conexion. Si no se pasa, el contenedor usa solo la exclusion del bucle local y
   *   **queda abierta la ventana entre la validacion y el socket**.
   * @returns Sesion activa con su identificador de contenedor y su tiempo de expiracion.
   * @throws TrainingCapacityExceededError cuando se alcanza el limite de sesiones simultaneas.
   * @throws Error del runtime o del escudo cuando falla cualquier paso de la puesta en marcha. En ese
   *   caso **no queda ningun contenedor vivo**: la creacion, la obtencion del transporte, el
   *   descubrimiento del objetivo de depuracion, la conexion, los comandos iniciales y la habilitacion
   *   de la interceptacion estan bajo la misma proteccion, y el error original se propaga intacto.
   */
  public async launchSession(
    trainingSessionId: string,
    context: { readonly organizationId: string; readonly projectId: string },
    hostResolverRules?: string
  ): Promise<EphemeralBrowserSession> {
    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      throw new TrainingCapacityExceededError(this.maxConcurrentSessions);
    }

    const spec: BrowserContainerSpec = {
      image: this.containerImage,
      containerName: `oa-trainer-${trainingSessionId.slice(0, 20)}`,
      tmpfsSize: DEFAULT_TMPFS_SIZE,
      memoryLimit: DEFAULT_MEMORY_LIMIT,
      cpuLimit: DEFAULT_CPU_LIMIT,
      maxTtlSeconds: this.sessionTtlSeconds,
      debuggerPort: DEFAULT_DEBUGGER_PORT,
      // La regla de fijacion llega del escudo con la direccion YA VALIDADA. Antes se enviaba un
      // literal que solo excluia el bucle local: la capa contra el rebinding de DNS estaba escrita
      // pero no conectada, de modo que el navegador resolvia por su cuenta y la ventana entre la
      // validacion y el socket quedaba abierta.
      hostResolverRules: hostResolverRules ?? DEFAULT_HOST_RESOLVER_RULES,
      // La red dedicada se declara de forma EXPLICITA cuando el adaptador la recibe: sin ella el
      // contenedor comparte la red del host con el motor de base de datos, y el canal de sockets queda
      // como una via abierta que ninguna otra capa del escudo inspecciona.
      ...(this.networkName !== undefined ? { networkName: this.networkName } : {}),
    };

    // La creacion del contenedor vive DENTRO del bloque protegido, igual que todo lo que depende de
    // ella. Antes se creaba fuera y la obtencion del transporte quedaba tambien fuera: una excepcion
    // al obtener el transporte saltaba el manejador de error, el contenedor sobrevivia con la sesion
    // autenticada del usuario final dentro y nadie lo destruia despues. Poner la adquisicion entera
    // bajo la misma proteccion elimina la ventana entera en lugar de tapar un solo camino.
    let containerId: string | undefined;
    let transport: CdpTransport | undefined;

    try {
      const started = await this.containerRuntime.startContainer(spec);
      containerId = started.containerId;
      transport = this.transportFactory();

      const target = await discoverActiveCdpTarget(started.debuggerBaseUrl);
      await transport.connect(target.webSocketDebuggerUrl);
      await transport.send('Page.enable');
      await transport.send('Runtime.enable');
      await transport.send('DOM.enable');
      await transport.enableRequestInterception(async (request) =>
        this.ssrfInterceptor.decide(request, {
          organizationId: context.organizationId,
          projectId: context.projectId,
          trainingSessionId,
        })
      );

      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + this.sessionTtlSeconds * 1000;
      // La sesion se inscribe en el registro en cuanto el contenedor y el canal estan en pie: es el
      // rastro de lo que esta vivo, y el barrido periodico solo puede destruir lo que esta inscrito.
      this.activeSessions.set(trainingSessionId, {
        containerId: started.containerId,
        debuggerBaseUrl: started.debuggerBaseUrl,
        transport,
        expiresAtMs,
      });
      this.containerSweeper.start(this.sweepIntervalMs);

      return {
        trainingSessionId,
        containerId: started.containerId,
        debuggerBaseUrl: started.debuggerBaseUrl,
        createdAtMs,
        expiresAtMs,
        blockedRequestCount: 0,
      };
    } catch (error) {
      // El cierre del canal puede fallar por su cuenta: no debe impedir la destruccion del contenedor,
      // que es la unica operacion cuya omision deja un navegador autenticado vivo.
      if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
      if (containerId !== undefined) {
        await this.containerRuntime.destroyContainer(containerId);
      }
      throw error;
    }
  }

  /**
   * Reenvia al contenedor un clic realizado por el desarrollador en el visor web.
   *
   * @param trainingSessionId - Sesion de entrenamiento destino.
   * @param x - Coordenada horizontal del clic.
   * @param y - Coordenada vertical del clic.
   * @throws Error cuando la sesion no existe o ya expiro.
   */
  public async forwardDeveloperClick(trainingSessionId: string, x: number, y: number): Promise<void> {
    const session = this.requireActiveSession(trainingSessionId);
    await session.transport.dispatchMouseClick(x, y, 'left');
  }

  /**
   * Reenvia al contenedor un texto escrito por el desarrollador en el visor web.
   *
   * @param trainingSessionId - Sesion de entrenamiento destino.
   * @param text - Texto a insertar en el elemento con foco.
   * @throws Error cuando la sesion no existe o ya expiro.
   */
  public async forwardDeveloperText(trainingSessionId: string, text: string): Promise<void> {
    const session = this.requireActiveSession(trainingSessionId);
    await session.transport.dispatchKeyText(text);
  }

  /**
   * Destruye la sesion de forma incondicional: cierra el canal y elimina el contenedor.
   * Es idempotente: destruir una sesion ya cerrada no produce error.
   *
   * @param trainingSessionId - Sesion de entrenamiento a destruir.
   */
  public async destroySession(trainingSessionId: string): Promise<void> {
    const session = this.activeSessions.get(trainingSessionId);
    if (session === undefined) {
      return;
    }
    this.activeSessions.delete(trainingSessionId);
    this.ssrfInterceptor.resetCounters(trainingSessionId);
    await session.transport.close().catch(() => undefined);
    await this.containerRuntime.destroyContainer(session.containerId);
  }

  /**
   * Destruye todos los contenedores vivos de este adaptador.
   *
   * Es la limpieza de fondo que corresponde al apagado del pool: el barrido periodico retira lo que
   * vence, pero un contenedor cuya sesion aun no expiro tambien debe morir si el proceso se apaga, o
   * sobrevivira conservando la sesion autenticada del usuario final.
   *
   * @returns Identificadores de las sesiones destruidas.
   */
  public async destroyAllSessions(): Promise<readonly string[]> {
    const liveSessionIds = [...this.activeSessions.keys()];
    for (const trainingSessionId of liveSessionIds) {
      await this.destroySession(trainingSessionId);
    }
    return liveSessionIds;
  }

  /**
   * Destruye todas las sesiones cuyo tiempo de vida haya expirado.
   * Debe invocarse periodicamente: el navegador nunca debe sobrevivir a su tiempo maximo, ni
   * siquiera si el desarrollador abandono la pestana sin cerrar la sesion.
   *
   * @returns Identificadores de las sesiones destruidas en este barrido.
   */
  public async sweepExpiredSessions(): Promise<readonly string[]> {
    const nowMs = Date.now();
    const expiredSessionIds = [...this.activeSessions.entries()]
      .filter(([, session]) => session.expiresAtMs <= nowMs)
      .map(([trainingSessionId]) => trainingSessionId);

    for (const trainingSessionId of expiredSessionIds) {
      await this.destroySession(trainingSessionId);
    }
    return expiredSessionIds;
  }

  /**
   * Numero de peticiones bloqueadas por el escudo durante una sesion.
   *
   * @param trainingSessionId - Sesion consultada.
   * @returns Numero de bloqueos acumulados, o 0 si la sesion no existe.
   */
  public countBlockedRequests(trainingSessionId: string): number {
    return this.ssrfInterceptor.blockedCountFor(trainingSessionId);
  }

  /**
   * Recupera una sesion activa verificando que no haya expirado.
   *
   * @param trainingSessionId - Sesion solicitada.
   * @returns Estado interno de la sesion activa.
   * @throws Error cuando la sesion no existe o supero su tiempo de vida.
   */
  private requireActiveSession(trainingSessionId: string): ActiveSessionState {
    const session = this.activeSessions.get(trainingSessionId);
    if (session === undefined) {
      throw new Error(`SESION_DE_ENTRENAMIENTO_INEXISTENTE: no hay una sesion activa con el identificador ${trainingSessionId}.`);
    }
    if (session.expiresAtMs <= Date.now()) {
      throw new Error(`SESION_DE_ENTRENAMIENTO_EXPIRADA: la sesion ${trainingSessionId} supero su tiempo de vida.`);
    }
    return session;
  }
}



