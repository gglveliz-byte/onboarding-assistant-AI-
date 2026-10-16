/**
 * @archivo src/bootstrap/api-control-plane.main.ts
 * @modulo Bootstrap (Entrypoint del Node Pool `api-control-plane`)
 * @proposito
 *   Arranca el pool que atiende las APIs REST de la plataforma: ensambla el monolito con sus siete
 *   manifiestos, levanta el servidor HTTP sobre las 42 rutas declaradas y deja instalado el cierre
 *   elegante. El servidor en si vive en `./api-control-plane.server.ts`; este archivo solo orquesta
 *   el ciclo de vida del proceso.
 *
 * @resumen_contenido
 *   - Constante `POOL_ROLE`.
 *   - Funcion `startApiControlPlane()`: Ensamblaje, escucha y cierre elegante.
 *
 * @dependencias_internas
 *   - `bootstrapBackendSystem()` y `describeAssembly()` (`./module-autoloader.ts`).
 *   - `installGracefulShutdown()` y `registerHttpRouteSummaryLog()` (`./bootstrap-runtime.ts`).
 *   - `ApiControlPlaneServer` (`./api-control-plane.server.ts`).
 *
 * @dependencias_externas
 *   - `node:process` (Senales del sistema operativo para el cierre elegante).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `RlsDatabasePool` (Una conexion por peticion, con contexto RLS del tenant).
 *   - Redis: `RedisClusterClient` (Cuotas, sesiones y publicacion de eventos de dominio).
 */

import { bootstrapBackendSystem, describeAssembly, type BootstrappedSystem } from './module-autoloader';
import { installGracefulShutdown, registerHttpRouteSummaryLog, type NodePoolRuntime } from './bootstrap-runtime';
import { ApiControlPlaneServer } from './api-control-plane.server';

/** Rol del pool que ejecuta este entrypoint. */
const POOL_ROLE = 'API_CONTROL_PLANE';

/**
 * Arranca el plano de control: ensambla el sistema, escucha y deja listo el cierre elegante.
 *
 * @param portOverride - Puerto alternativo, usado por las pruebas para no chocar con el configurado.
 * @returns Servidor en escucha y la funcion de cierre bajo demanda.
 */
export async function startApiControlPlane(portOverride?: number): Promise<{
  readonly server: ApiControlPlaneServer;
  readonly system: BootstrappedSystem;
  readonly shutdown: (signal: string) => Promise<unknown>;
  readonly port: number;
}> {
  const startedAtMs = Date.now();
  const system = bootstrapBackendSystem({ nodePoolRole: POOL_ROLE });
  const port = portOverride ?? system.environment.PORT;

  const log = (message: string, metadata?: Readonly<Record<string, unknown>>): void => {
    process.stdout.write(`[${POOL_ROLE}] ${message}${metadata === undefined ? '' : ` ${JSON.stringify(metadata)}`}\n`);
  };

  log(describeAssembly(system));
  const server = new ApiControlPlaneServer(system, log);
  await server.listen(port);

  const runtime: NodePoolRuntime = {
    nodePoolRole: POOL_ROLE,
    system,
    listeningPorts: [port],
    startedAtMs,
  };
  registerHttpRouteSummaryLog(runtime, log);

  const shutdown = installGracefulShutdown(
    runtime,
    {
      stopAcceptingConnections: () => server.stopAcceptingConnections(2000),
      releaseOwnedResources: async () => {
        const openConnections = server.getOpenConnectionCount();
        if (openConnections > 0) {
          log(`Cerrando ${openConnections} conexion(es) keep-alive pendientes.`);
        }
      },
    },
    log
  );

  return { server, system, shutdown, port };
}

/** Punto de entrada cuando el archivo se ejecuta directamente. */
if (require.main === module) {
  void startApiControlPlane().catch((error: unknown) => {
    process.stderr.write(`[${POOL_ROLE}] Fallo al arrancar: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}


