/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime.ts
 * @modulo 03-visual-trainer-and-rag (Runtime Real de Contenedores para el Navegador Efimero)
 * @proposito
 *   Implementa el puerto `BrowserContainerRuntime` sobre la interfaz de linea de comandos de un
 *   motor de contenedores. El contenedor se crea con almacenamiento exclusivamente en memoria RAM
 *   (sin volumenes de disco persistente), limites estrictos de memoria y CPU, red publicada solo en
 *   el bucle local y la regla de fijacion de resolucion DNS del escudo Anti-SSRF. Al terminar la
 *   sesion se destruye de forma forzosa junto con sus volumenes anonimos, de modo que ninguna
 *   sesion de entrenamiento pueda dejar rastro de navegacion entre clientes.
 *
 * @resumen_contenido
 *   - Interface `BrowserContainerSpec`: Especificacion del contenedor efimero.
 *   - Interface `BrowserContainerRuntime`: Puerto inyectable del runtime de contenedores.
 *   - Clase `DockerCliBrowserContainerRuntime`:
 *       * `startContainer()`: Crea el contenedor y resuelve su punto de depuracion.
 *       * `destroyContainer()`: Destruccion forzosa e idempotente.
 *       * `runDocker()`: Ejecucion controlada del subcomando con limite de tiempo.
 *   - Constantes `DEFAULT_TMPFS_SIZE`, `DEFAULT_MEMORY_LIMIT` y `DEFAULT_CPU_LIMIT`.
 *
 * @dependencias_internas
 *   - Ninguna (Adaptador de infraestructura puro sobre el motor de contenedores).
 *
 * @dependencias_externas
 *   - `node:child_process` (Ejecucion de la interfaz de linea de comandos del motor).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions` (El identificador del contenedor se persiste aqui).
 */

import { execFile } from 'node:child_process';

/** Especificacion completa del contenedor efimero de navegacion. */
export interface BrowserContainerSpec {
  /** Imagen versionada del contenedor. */
  readonly image: string;
  /** Etiqueta legible del contenedor, usada en diagnostico y auditoria. */
  readonly containerName: string;
  /** Tamano del almacenamiento en memoria RAM, por ejemplo `512m`. */
  readonly tmpfsSize: string;
  /** Limite de memoria del contenedor, por ejemplo `1024m`. */
  readonly memoryLimit: string;
  /** Limite de CPU expresado en nucleos, por ejemplo `1.0`. */
  readonly cpuLimit: string;
  /** Tiempo de vida maximo del contenedor en segundos. */
  readonly maxTtlSeconds: number;
  /** Puerto interno donde el navegador expone su punto de depuracion. */
  readonly debuggerPort: number;
  /** Regla de fijacion de resolucion DNS inyectada al navegador. */
  readonly hostResolverRules: string;
  /**
   * Red de contenedores a la que se conecta el navegador.
   *
   * Debe ser una red **dedicada y sin ruta a la red de datos**. Es la defensa que no depende del
   * navegador y, por tanto, la unica que cubre lo que la intercepcion de peticiones **no alcanza**: el
   * dominio de intercepcion del protocolo de depuracion no cubre el handshake de los sockets, de modo
   * que una pagina hostil puede abrir un canal persistente hacia la red interna —los metadatos del
   * proveedor de nube o el propio motor de base de datos— sin que el escudo vea jamas la direccion.
   */
  readonly networkName?: string;
}

/** Puerto del runtime de contenedores: permite sustituir el motor real por uno de pruebas. */
export interface BrowserContainerRuntime {
  /**
   * Inicia un contenedor a partir de la especificacion y devuelve su identificador.
   *
   * @param spec - Especificacion del contenedor a crear.
   * @returns Identificador del contenedor y URL base de su punto de depuracion.
   */
  startContainer(spec: BrowserContainerSpec): Promise<{ readonly containerId: string; readonly debuggerBaseUrl: string }>;

  /**
   * Destruye un contenedor de forma incondicional.
   *
   * @param containerId - Identificador o nombre del contenedor a destruir.
   */
  destroyContainer(containerId: string): Promise<void>;
}

/** Tamano por omision del almacenamiento en memoria RAM del contenedor. */
export const DEFAULT_TMPFS_SIZE = '512m';

/** Limite de memoria por omision del contenedor. */
export const DEFAULT_MEMORY_LIMIT = '1024m';

/** Limite de CPU por omision del contenedor. */
export const DEFAULT_CPU_LIMIT = '1.0';

/** Puerto por omision del punto de depuracion del navegador. */
export const DEFAULT_DEBUGGER_PORT = 9222;

/** Tiempo maximo de espera de cada subcomando del motor, en milisegundos. */
const DOCKER_COMMAND_TIMEOUT_MS = 60000;

/**
 * Runtime real de contenedores sobre la interfaz de linea de comandos.
 * Toda la configuracion de aislamiento se declara de forma explicita: sin ella, un navegador
 * efimero podria escribir en disco o alcanzar la red interna del host.
 */
export class DockerCliBrowserContainerRuntime implements BrowserContainerRuntime {
  private readonly dockerExecutable: string;

  /**
   * @param dockerExecutable - Ruta o nombre del ejecutable del motor de contenedores.
   */
  public constructor(dockerExecutable: string = 'docker') {
    this.dockerExecutable = dockerExecutable;
  }

  /**
   * Crea el contenedor del navegador con almacenamiento en RAM y puerto publicado en el bucle local.
   *
   * @param spec - Especificacion del contenedor.
   * @returns Identificador del contenedor y URL base de su punto de depuracion.
   * @throws Error cuando el motor falla o no publica el puerto de depuracion.
   */
  public async startContainer(spec: BrowserContainerSpec): Promise<{ readonly containerId: string; readonly debuggerBaseUrl: string }> {
    const containerId = (
      await this.runDocker(buildContainerArguments(spec))
    ).trim();

    const publishedPort = await this.runDocker(['port', containerId, `${spec.debuggerPort}/tcp`]);
    const portMatch = /:(\d+)\s*$/u.exec(publishedPort.trim());
    const hostPort = portMatch?.[1];
    if (hostPort === undefined) {
      await this.destroyContainer(containerId);
      throw new Error('CONTENEDOR_SIN_PUERTO_PUBLICADO: no se pudo resolver el puerto del punto de depuracion.');
    }

    return { containerId, debuggerBaseUrl: `http://127.0.0.1:${hostPort}` };
  }

  /**
   * Destruye el contenedor de forma forzosa e idempotente.
   * Un contenedor que ya expiro por su propia politica no es un fallo: la destruccion es efectiva.
   *
   * @param containerId - Identificador o nombre del contenedor a destruir.
   */
  public async destroyContainer(containerId: string): Promise<void> {
    try {
      await this.runDocker(['rm', '--force', '--volumes', containerId]);
    } catch {
      // El contenedor ya no existe o el motor lo elimino por su propia politica de expiracion.
    }
  }

  /**
   * Ejecuta un subcomando del motor de contenedores con limite de tiempo.
   *
   * @param args - Argumentos del subcomando.
   * @returns Salida estandar del comando.
   * @throws Error cuando el motor no esta disponible o el subcomando falla.
   */
  private async runDocker(args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(this.dockerExecutable, [...args], { timeout: DOCKER_COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error !== null) {
          reject(new Error(`MOTOR_DE_CONTENEDORES_FALLO: ${error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

/**
 * Construye el arreglo de argumentos con el que se crea el contenedor del navegador.
 *
 * Se extrae del metodo de arranque para poder **verificar el aislamiento sin lanzar un contenedor**:
 * una prueba puede comprobar que la red dedicada, la retirada de capacidades, la prohibicion de
 * escalada y el bloqueo del tiempo real llegan de verdad al motor, que es justo lo que ninguna prueba
 * comprobaba mientras el arreglo vivia embebido en una llamada que abre un proceso.
 *
 * @param spec - Especificacion del contenedor a crear.
 * @returns Argumentos completos para el subcomando de arranque del motor de contenedores.
 */
export function buildContainerArguments(spec: BrowserContainerSpec): readonly string[] {
  return [
      'run',
      '--detach',
      '--rm',
      '--name',
      spec.containerName,
      // Aislamiento de red: el navegador solo alcanza la red dedicada, que no tiene ruta a la red de
      // datos. Es la unica defensa que cubre el canal de sockets, que la intercepcion de peticiones no
      // alcanza, y tambien el tiempo real y la resolucion directa.
      ...(spec.networkName !== undefined ? ['--network', spec.networkName] : []),
      // Retirada de capacidades y prohibicion de escalada: el navegador no necesita ninguna capacidad
      // del nucleo, y un fallo de renderizado no debe poder convertirse en una escalada de privilegios.
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      spec.memoryLimit,
      '--cpus',
      spec.cpuLimit,
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,size=${spec.tmpfsSize}`,
      '--tmpfs',
      `/home/chrome:rw,noexec,nosuid,size=${spec.tmpfsSize}`,
      '--publish',
      // El punto de depuracion se publica UNICAMENTE en el bucle local: exponerlo en todas las
      // interfaces dejaria el control del navegador al alcance de cualquiera que alcanzara el host.
      `127.0.0.1::${spec.debuggerPort}`,
      spec.image,
      '--headless=new',
      '--remote-debugging-address=0.0.0.0',
      `--remote-debugging-port=${spec.debuggerPort}`,
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      // El tiempo real y la resolucion anticipada son vias de salida que no pasan por la intercepcion
      // de peticiones: se desactivan en el propio navegador como segunda capa.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-features=WebRtcHideLocalIpsWithMdns,PreconnectToSearch,NetworkPrediction',
      `--host-resolver-rules=${spec.hostResolverRules}`,
      'about:blank',
  ];
}
