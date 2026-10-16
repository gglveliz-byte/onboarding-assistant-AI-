/**
 * @archivo src/bootstrap/bootstrap-runtime.ts
 * @modulo Bootstrap (Ciclo de Vida Comun de los Tres Node Pools)
 * @proposito
 *   Concentra lo que los tres entrypoints de despliegue comparten: el arranque del sistema
 *   ensamblado, la instalacion de los manejadores de cierre elegante y el cierre ordenado de la
 *   infraestructura. Se aisla aqui por una razon concreta: si cada entrypoint implementara su propio
 *   cierre, el del pool de voz podria olvidar liquidar el consumo pendiente y el de entrenamiento
 *   podria dejar contenedores de navegador huerfanos consumiendo recursos facturados. Un unico
 *   camino de cierre garantiza que ninguno de los tres olvide su obligacion propia.
 *
 * @resumen_contenido
 *   - Constante `DEFAULT_SHUTDOWN_GRACE_MS` y `GRACEFUL_SIGNALS`.
 *   - Interfaces `NodePoolRuntime`, `PoolLifecycleHooks` y `ShutdownReport`.
 *   - Funcion `installGracefulShutdown()`: Cierre ordenado e idempotente ante senales.
 *   - Funcion `closeBootstrappedSystem()`: Liberacion de la infraestructura compartida.
 *   - Funcion `registerHttpRouteSummaryLog()`: Bitacora de arranque con el mapa de rutas.
 *
 * @dependencias_internas
 *   - `BootstrappedSystem` (`./module-autoloader.ts`).
 *   - `DomainEventBus`, `RlsDatabasePool` y `RedisClusterClient` (kernel de infraestructura).
 *
 * @dependencias_externas
 *   - `node:process` (Senales del sistema operativo para el cierre elegante).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `RlsDatabasePool` (Se cierra al final, despues de liquidar el consumo pendiente).
 *   - Redis: `RedisClusterClient` (Se cierra despues de publicar los eventos de terminacion).
 */

import type { BootstrappedSystem } from './module-autoloader';

/** Tiempo maximo que se concede al cierre ordenado antes de forzar la salida. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 15000;

/** Senales que disparan el cierre ordenado de un Node Pool. */
export const GRACEFUL_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGTERM', 'SIGINT']);

/** Runtime de un Node Pool en ejecucion. */
export interface NodePoolRuntime {
  /** Rol del pool declarado en el contrato de entorno. */
  readonly nodePoolRole: string;
  /** Sistema ensamblado con los 18 tokens resueltos. */
  readonly system: BootstrappedSystem;
  /** Puertos en los que el pool escucha, para la bitacora de arranque. */
  readonly listeningPorts: readonly number[];
  /** Marca temporal del arranque, para calcular el tiempo de actividad al cerrar. */
  readonly startedAtMs: number;
}

/**
 * Obligaciones PROPIAS de cada pool que deben completarse antes de liberar la infraestructura.
 * Cada entrypoint declara las suyas: el pool de voz drena sus sesiones y liquida el consumo, el de
 * entrenamiento destruye sus contenedores de navegador, y el de API deja de aceptar peticiones.
 */
export interface PoolLifecycleHooks {
  /** Detiene la aceptacion de conexiones nuevas. */
  readonly stopAcceptingConnections?: () => Promise<void>;
  /** Espera a que terminen los trabajos en curso, dentro del presupuesto concedido. */
  readonly drainInFlightWork?: (graceMs: number) => Promise<void>;
  /** Libera los recursos propios del pool, como contenedores o sockets abiertos. */
  readonly releaseOwnedResources?: () => Promise<void>;
}

/** Resultado del cierre ordenado, usado en la bitacora de apagado. */
export interface ShutdownReport {
  /** Indica si el cierre se completo dentro del presupuesto. */
  readonly completedWithinBudget: boolean;
  /** Tiempo total que tardo el cierre, en milisegundos. */
  readonly elapsedMs: number;
  /** Tiempo de actividad del proceso antes de cerrarse, en milisegundos. */
  readonly uptimeMs: number;
  /** Senal que origino el cierre. */
  readonly signal: string;
  /** Errores capturados durante el cierre, uno por obligacion fallida. */
  readonly errors: readonly string[];
}

/**
 * Instala los manejadores de cierre elegante y garantiza que solo se ejecute una vez.
 *
 * El cierre es **idempotente** porque el sistema operativo puede entregar `SIGTERM` y despues
 * `SIGINT`, y ejecutar la liquidacion dos veces duplicaria el asiento contable del consumo final.
 *
 * @param runtime - Runtime del pool con su sistema ensamblado.
 * @param hooks - Obligaciones propias del pool.
 * @param log - Escritor de bitacora del proceso.
 * @param graceMs - Presupuesto de tiempo para el cierre ordenado.
 * @returns Funcion que ejecuta el cierre bajo demanda, usada por las pruebas.
 */
export function installGracefulShutdown(
  runtime: NodePoolRuntime,
  hooks: PoolLifecycleHooks,
  log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void,
  graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS
): (signal: string) => Promise<ShutdownReport> {
  /**
   * Promesa del cierre en curso, o `null` cuando aun no se ha iniciado.
   *
   * Se guarda la PROMESA y no una marca booleana: una senal repetida debe poder esperar al cierre que
   * ya corre y recibir su informe real, en lugar de fabricar uno propio que indique exito falso.
   */
  let inFlightShutdown: Promise<ShutdownReport> | null = null;

  const shutdown = async (signal: string): Promise<ShutdownReport> => {
    // Una segunda senal durante el cierre NO debe iniciar otro cierre ni devolver un informe propio:
    // debe esperar al que ya esta en curso. Devolver un informe con `errors` no vacio liberaba al
    // manejador de senales para ejecutar `process.exit(1)`, y ese `exit` mataba el proceso **a mitad
    // del drenado** de la primera senal: las liquidaciones contables en curso quedaban abortadas y las
    // sesiones de voz se cortaban sin registrar su consumo. En un despliegue real esto ocurre a
    // diario, porque el orquestador envia `SIGTERM`, espera un periodo de gracia y despues envia un
    // segundo `SIGTERM` o `SIGKILL` si la instancia aun no ha terminado.
    if (inFlightShutdown !== null) {
      log('Cierre ya en curso: la senal repetida se atiende esperando al cierre en curso.', { signal });
      return inFlightShutdown;
    }

    inFlightShutdown = performShutdown(signal);
    return inFlightShutdown;
  };

  /**
   * Ejecuta la secuencia de cierre una sola vez.
   *
   * @param signal - Senal que origino el cierre.
   * @returns Informe del cierre con sus incidencias.
   */
  const performShutdown = async (signal: string): Promise<ShutdownReport> => {
    const startedAtMs = Date.now();
    const errors: string[] = [];

    log(`Iniciando cierre ordenado del pool ${runtime.nodePoolRole}.`, { signal, graceMs });

    // 1. Dejar de aceptar trabajo nuevo antes que nada: seguir aceptando conexiones mientras se
    //    drena haria imposible terminar.
    if (hooks.stopAcceptingConnections !== undefined) {
      await runHook('stopAcceptingConnections', hooks.stopAcceptingConnections, errors, log);
    }

    // 2. Drenar el trabajo en curso dentro del presupuesto. Es el paso que evita cortar una
    //    conversacion de usuario a mitad de frase.
    if (hooks.drainInFlightWork !== undefined) {
      const remainingMs = Math.max(0, graceMs - (Date.now() - startedAtMs));
      await runHook('drainInFlightWork', () => hooks.drainInFlightWork?.(remainingMs), errors, log);
    }

    // 3. Liberar los recursos propios ANTES que la infraestructura compartida: los contenedores y
    //    las liquidaciones necesitan el pool y el cliente de Redis vivos.
    if (hooks.releaseOwnedResources !== undefined) {
      await runHook('releaseOwnedResources', hooks.releaseOwnedResources, errors, log);
    }

    // 4. Liberar la infraestructura compartida, siempre y en este orden.
    try {
      runtime.system.eventBus.close();
    } catch (error) {
      errors.push(`eventBus.close: ${describeError(error)}`);
    }
    try {
      await runtime.system.redisClient.close();
    } catch (error) {
      errors.push(`redisClient.close: ${describeError(error)}`);
    }
    try {
      await runtime.system.databasePool.close();
    } catch (error) {
      errors.push(`databasePool.close: ${describeError(error)}`);
    }

    const elapsedMs = Date.now() - startedAtMs;
    const report: ShutdownReport = Object.freeze({
      completedWithinBudget: elapsedMs <= graceMs,
      elapsedMs,
      uptimeMs: Date.now() - runtime.startedAtMs,
      signal,
      errors: Object.freeze(errors),
    });

    log(
      `Cierre del pool ${runtime.nodePoolRole} completado en ${elapsedMs} ms ` +
        `(${report.completedWithinBudget ? 'dentro' : 'fuera'} del presupuesto de ${graceMs} ms).`,
      { uptimeMs: report.uptimeMs, errorCount: errors.length }
    );
    if (errors.length > 0) {
      log('Incidencias registradas durante el cierre.', { errors: errors.join(' | ') });
    }

    return report;
  };

  for (const signal of GRACEFUL_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal).then((report) => {
        // El codigo de salida distingue un cierre limpio de uno con incidencias, para que el
        // orquestador de despliegue pueda decidir si la instancia se reemplazo correctamente.
        process.exit(report.errors.length === 0 ? 0 : 1);
      });
    });
  }

  return shutdown;
}

/**
 * Registra en la bitacora el mapa de rutas y canales declarados por el ensamblaje.
 * Saber que el proceso levanto no significa que declarara lo que debia: un manifiesto que no se
 * ejecuto deja el servicio incompleto sin producir ningun error.
 *
 * @param runtime - Runtime del pool con su sistema ensamblado.
 * @param log - Escritor de bitacora del proceso.
 * @returns Resumen del ensamblaje que quedo registrado.
 */
export function registerHttpRouteSummaryLog(
  runtime: NodePoolRuntime,
  log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
): {
  readonly routeCount: number;
  readonly channelCount: number;
  readonly tokenCount: number;
  readonly routesByModule: Readonly<Record<string, number>>;
} {
  const routesByModule = runtime.system.httpRouter.countByOwnerModule();
  const summary = {
    routeCount: runtime.system.httpRouter.count(),
    channelCount: runtime.system.wsRegistry.count(),
    tokenCount: runtime.system.container.listRegisteredTokens().length,
    routesByModule,
  };

  log(
    `Pool ${runtime.nodePoolRole} listo: ${summary.routeCount} ruta(s), ${summary.channelCount} canal(es) ` +
      `y ${summary.tokenCount} token(s) en ${runtime.system.assemblyTimingsMs['total'] ?? 0} ms.`,
    { listeningPorts: runtime.listeningPorts.join(','), routesByModule: JSON.stringify(routesByModule) }
  );

  for (const [moduleName, routeCount] of Object.entries(routesByModule).sort(([left], [right]) => left.localeCompare(right))) {
    log(`  ${moduleName}: ${routeCount} ruta(s)`);
  }
  for (const channel of runtime.system.wsRegistry.list()) {
    log(`  canal ${channel.path} (${channel.dataFormat}) propiedad de ${channel.ownerModule}`);
  }

  return summary;
}

/**
 * Ejecuta una obligacion de cierre capturando su fallo sin abortar el resto.
 *
 * Un fallo al drenar no debe impedir liberar la infraestructura: si el cierre se interrumpiera a la
 * primera incidencia, el proceso quedaria vivo consumiendo conexiones y el orquestador lo mataria
 * por la fuerza tras el periodo de gracia.
 *
 * @param hookName - Nombre de la obligacion, para la bitacora.
 * @param hook - Obligacion a ejecutar.
 * @param errors - Acumulador de incidencias.
 * @param log - Escritor de bitacora del proceso.
 */
async function runHook(
  hookName: string,
  hook: () => Promise<void> | undefined,
  errors: string[],
  log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
): Promise<void> {
  try {
    await hook();
  } catch (error) {
    const description = `${hookName}: ${describeError(error)}`;
    errors.push(description);
    log(`Fallo durante el cierre en ${hookName}.`, { error: describeError(error) });
  }
}

/**
 * Describe un error capturado de forma legible para la bitacora.
 *
 * @param error - Error capturado.
 * @returns Descripcion del error.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

