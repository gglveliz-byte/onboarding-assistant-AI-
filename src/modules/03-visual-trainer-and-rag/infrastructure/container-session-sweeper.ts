/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/container-session-sweeper.ts
 * @modulo 03-visual-trainer-and-rag (Barrido Periodico de Contenedores de Navegador Vencidos)
 * @proposito
 *   Mantiene viva la obligacion propia de este modulo: **un contenedor de navegador nunca debe
 *   sobrevivir a su tiempo maximo de vida**. El navegador efimero conserva dentro la sesion
 *   autenticada del usuario final que se estaba entrenando, de modo que un contenedor olvidado no es
 *   solo CPU y memoria desperdiciadas: es una sesion autenticada viva que nadie volvio a mirar.
 *
 *   El adaptador del navegador ya sabe destruir una sesion vencida, pero ese conocimiento solo servia
 *   de algo si alguien lo invocaba. Esta pieza es ese alguien: un temporizador que se arma con la
 *   primera sesion registrada y dispara el barrido por su cuenta, sin esperar a que la peticion del
 *   desarrollador ocurra ni a que el pool se apague. El temporizador se marca como `unref()` para no
 *   retener el bucle de eventos del proceso: su funcion es liberar contenedores, nunca impedir que un
 *   proceso termine.
 *
 * @resumen_contenido
 *   - Interface `ExpiredContainerSweeperPort`: Contrato minimo del adaptador que se barre.
 *   - Interface `ActiveContainerSweeper`: Superficie publica del barrido (armar, detener, estado).
 *   - Funcion `createActiveContainerSweeper()`: Construye el barrido con su temporizador interno.
 *
 * @dependencias_internas
 *   - Ninguna. El puerto se declara aqui y el adaptador del navegador lo satisface estructuralmente,
 *     de modo que esta pieza no importa el adaptador y no se crea un ciclo de dependencias.
 *
 * @dependencias_externas
 *   - `setInterval` del runtime (Unica dependencia: un temporizador que no bloquea la salida).
 *
 * @tablas_bd_o_redis
 *   - Ninguna. El barrido actua sobre el registro en memoria del adaptador; la sesion persistida en
 *     `training_browser_sessions` la marca el caso de uso, no este temporizador.
 */

/**
 * Contrato minimo que debe ofrecer el registro de contenedores vivos para poder ser barrido.
 *
 * Se declara como puerto y no como referencia directa al adaptador para que el barrido no dependa de
 * la clase que lo consume: cualquier registro capaz de contar sus sesiones y de destruir una sesion
 * concreta puede ser barrido sin cambio alguno.
 */
export interface ExpiredContainerSweeperPort {
  /**
   * Numero de sesiones (y por tanto de contenedores) registradas como vivas.
   *
   * Se declara como funcion y no como propiedad de solo lectura para que el registro pueda
   * implementarla con su propio contador, que cambia con el tiempo.
   *
   * @returns Cantidad de sesiones vivas en el registro.
   */
  activeSessionCount(): number;

  /**
   * Destruye todas las sesiones que superaron su tiempo de vida.
   *
   * @returns Identificadores de las sesiones efectivamente destruidas.
   */
  destroyExpiredSessions(): Promise<readonly string[]>;
}

/** Superficie publica del barrido periodico de contenedores vencidos. */
export interface ActiveContainerSweeper {
  /** Indica si el temporizador del barrido esta armado. */
  readonly isRunning: boolean;

  /** Periodo del barrido en milisegundos; es la ventana maxima de supervivencia de un contenedor. */
  readonly intervalMs: number;

  /**
   * Arma el temporizador del barrido. Es idempotente: armarlo dos veces no duplica los disparos.
   *
   * @param intervalMs - Periodo del barrido en milisegundos.
   */
  start(intervalMs: number): void;

  /** Detiene el temporizador y libera su manejador. Es idempotente y no destruye ninguna sesion. */
  stop(): void;

  /**
   * Ejecuta un barrido inmediato sin esperar al siguiente disparo del temporizador.
   *
   * @returns Identificadores de las sesiones destruidas en este barrido.
   */
  sweepNow(): Promise<readonly string[]>;
}

/**
 * Construye el barrido periodico de contenedores vencidos sobre un registro de sesiones vivas.
 *
 * @param port - Registro de contenedores que se va a barrer.
 * @returns Barrido listo para ser armado con `start()`.
 */
export function createActiveContainerSweeper(port: ExpiredContainerSweeperPort): ActiveContainerSweeper {
  let timer: ReturnType<typeof setInterval> | undefined;
  let intervalMs = 0;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const runSweep = async (): Promise<readonly string[]> => {
    // Un fallo al destruir un contenedor no debe matar el temporizador: si el barrido muriera con el
    // primer error, el contenedor que no pudo destruirse no se reintentaria jamas y quedaria vivo con
    // la sesion autenticada dentro. El siguiente disparo vuelve a intentarlo.
    try {
      // Sin sesiones registradas el barrido no tiene nada que hacer: se evita asi una invocacion por
      // disparo cuando el orquestador esta en reposo.
      if (port.activeSessionCount() === 0) {
        return [];
      }
      return await port.destroyExpiredSessions();
    } catch {
      return [];
    }
  };

  return {
    get isRunning(): boolean {
      return timer !== undefined;
    },
    get intervalMs(): number {
      return intervalMs;
    },
    start(requestedIntervalMs: number): void {
      clearTimer();
      intervalMs = requestedIntervalMs;
      timer = setInterval(() => {
        void runSweep();
      }, requestedIntervalMs);
      // El temporizador NO debe retener el bucle de eventos: su razon de existir es liberar
      // contenedores, no impedir que el proceso termine. Sin esta marca, un pool en reposo jamas
      // cerraria y el apagado ordenado quedaria esperando a un temporizador que no tiene nada que
      // vigilar.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        timer.unref();
      }
    },
    stop(): void {
      clearTimer();
    },
    sweepNow: runSweep,
  };
}
