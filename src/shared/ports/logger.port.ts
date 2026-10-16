/**
 * @archivo src/shared/ports/logger.port.ts
 * @modulo 00-kernel (Puerto de Registro Estructurado)
 * @proposito
 *   Declara el contrato de logging que consume todo el backend. Los casos de uso nunca importan
 *   `pino` ni usan `console.log`: dependen de esta interfaz, de modo que una prueba pueda inyectar
 *   un logger espia y que el enmascaramiento de secretos se aplique en un unico adaptador. Los
 *   metadatos se tipan como `unknown` a proposito: el logger no necesita conocer el dominio, y
 *   esta decision evita dependencias cruzadas entre modulos que se construyen en paralelo.
 *
 * @resumen_contenido
 *   - Interface `LoggerPort`: Metodos de registro por severidad y logger hijo con contexto fijo.
 *   - Tipo `LogMetadata`: Mapa de metadatos estructurados anexados a cada entrada.
 *
 * @dependencias_internas
 *   - Ninguna (Contrato puro: es una hoja del grafo de dependencias).
 *
 * @dependencias_externas
 *   - Ninguna (El adaptador concreto con `pino` vive en la capa de infraestructura).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (La salida del logger se dirige a stdout estructurado y al colector de logs).
 */

/** Metadatos estructurados anexados a una entrada de registro. */
export type LogMetadata = Readonly<Record<string, unknown>>;

/**
 * Contrato de registro estructurado del backend.
 * Toda entrada debe incluir metadatos de trazabilidad (al menos el identificador de correlacion)
 * y jamas debe contener secretos: el adaptador concreto es responsable de enmascararlos.
 */
export interface LoggerPort {
  /**
   * Registra un evento de nivel fatal: el proceso no puede continuar.
   *
   * @param message - Mensaje en espanol describiendo la condicion.
   * @param metadata - Metadatos estructurados de contexto.
   */
  fatal(message: string, metadata?: LogMetadata): void;

  /**
   * Registra un fallo recuperable que requiere atencion operativa.
   *
   * @param message - Mensaje en espanol describiendo el fallo.
   * @param metadata - Metadatos estructurados de contexto.
   */
  error(message: string, metadata?: LogMetadata): void;

  /**
   * Registra una condicion anomala que no impide completar la operacion.
   *
   * @param message - Mensaje en espanol describiendo la advertencia.
   * @param metadata - Metadatos estructurados de contexto.
   */
  warn(message: string, metadata?: LogMetadata): void;

  /**
   * Registra un hito operativo normal del sistema.
   *
   * @param message - Mensaje en espanol describiendo el hito.
   * @param metadata - Metadatos estructurados de contexto.
   */
  info(message: string, metadata?: LogMetadata): void;

  /**
   * Registra informacion de diagnostico detallada.
   *
   * @param message - Mensaje en espanol de diagnostico.
   * @param metadata - Metadatos estructurados de contexto.
   */
  debug(message: string, metadata?: LogMetadata): void;

  /**
   * Crea un logger hijo con contexto fijo (organizacion, usuario o solicitud).
   *
   * @param boundContext - Metadatos que se anexaran a todas las entradas del logger hijo.
   * @returns Logger hijo con el contexto ya vinculado.
   */
  child(boundContext: LogMetadata): LoggerPort;
}
