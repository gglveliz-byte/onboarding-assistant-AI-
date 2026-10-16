/**
 * @archivo src/shared/kernel/result-and-errors.ts
 * @modulo 00-kernel (Fachada del Kernel de Errores y Monada Result)
 * @proposito
 *   Punto de importacion unico del contrato de fallos de la plataforma. Reexporta la clase base
 *   `AppError`, los mapas de traduccion a HTTP/WebSocket/auditoria, el catalogo completo de los
 *   15 errores de dominio y anade la monada `Result<T, E>` para escribir flujos de aplicacion
 *   sin excepciones. Los modulos de los modulos 01 a 06 importan exclusivamente desde aqui.
 *
 * @resumen_contenido
 *   - Reexportacion del contrato base (`./app-error.ts`): tipos, mapas, `AppError` e `isAppError`.
 *   - Reexportacion del catalogo de errores (`./domain-error.catalog.ts`).
 *   - Clase `UnclassifiedInternalError`: Error de respaldo para fallos desconocidos.
 *   - Funcion `toAppError()`: Normalizacion de cualquier valor capturado en un `catch`.
 *   - Tipos `OkResult`, `FailResult` y `Result<T, E>` con el objeto `Result`.
 *
 * @dependencias_internas
 *   - `AppError` e `isAppError` (`./app-error.ts`), que no importa valores de ningun otro modulo.
 *   - Catalogo de errores (`./domain-error.catalog.ts`), que depende unicamente de `app-error.ts`.
 *
 * @dependencias_externas
 *   - Ninguna (Nucleo puro: es la base de la que dependen los demas modulos).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (Consume `auditSeverity` para clasificar el evento).
 *   - Redis: `rl:tb:<scope>` (El codigo `RATE_LIMIT_EXCEEDED` informa `retryAfterSeconds`).
 */

import { AppError, isAppError } from './app-error';

export {
  AUDIT_SEVERITY_BY_ERROR_CODE,
  AppError,
  HTTP_STATUS_BY_ERROR_CODE,
  WS_CLOSE_CODE_BY_ERROR_CODE,
  isAppError,
  type AppErrorCode,
  type AppErrorContext,
  type AuditSeverity,
  type SerializedAppError,
} from './app-error';
export {
  ConflictError,
  DpaNotSignedError,
  ForbiddenError,
  InsufficientFundsError,
  InternalError,
  LegalConsentOutdatedError,
  NotFoundError,
  OriginNotAllowedError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SsrfBlockedIpError,
  TenantSuspendedError,
  TokenVersionRevokedError,
  UnauthorizedError,
  ValidationError,
} from './domain-error.catalog';

/**
 * Error de respaldo utilizado exclusivamente por `toAppError()` para normalizar fallos
 * desconocidos sin introducir dependencias adicionales en la cadena de inicializacion.
 */
class UnclassifiedInternalError extends AppError {
  public readonly code = 'INTERNAL_ERROR' as const;

  /**
   * @param message - Mensaje original del fallo no clasificado.
   */
  public constructor(message: string) {
    super(message);
  }
}

/**
 * Normaliza cualquier valor capturado en un `catch` a un `AppError`.
 * Los fallos desconocidos conservan su mensaje original para la bitacora, pero nunca exponen
 * trazas de pila ni detalles internos al cliente.
 *
 * @param candidate - Valor capturado en el bloque `catch`.
 * @returns Error controlado listo para mapear a HTTP o al cierre del socket.
 */
export function toAppError(candidate: unknown): AppError {
  if (isAppError(candidate)) {
    return candidate;
  }
  if (candidate instanceof Error) {
    return new UnclassifiedInternalError(candidate.message);
  }
  return new UnclassifiedInternalError(typeof candidate === 'string' ? candidate : 'Fallo desconocido no serializable.');
}

/** Resultado exitoso de una operacion de aplicacion. */
export interface OkResult<T> {
  readonly ok: true;
  readonly value: T;
}

/** Resultado fallido de una operacion de aplicacion. */
export interface FailResult<E> {
  readonly ok: false;
  readonly error: E;
}

/** Union discriminada que representa el exito o el fallo explicito de una operacion. */
export type Result<T, E> = OkResult<T> | FailResult<E>;

/** Fabrica de resultados y utilidades de composicion de la monada `Result`. */
export const Result = {
  /**
   * Construye un resultado exitoso.
   *
   * @param value - Valor producido por la operacion.
   * @returns Resultado en estado exitoso.
   */
  ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
  },

  /**
   * Construye un resultado fallido.
   *
   * @param error - Error de dominio producido por la operacion.
   * @returns Resultado en estado fallido.
   */
  fail<E>(error: E): Result<never, E> {
    return { ok: false, error };
  },

  /**
   * Transforma el valor de un resultado exitoso conservando el fallo intacto.
   *
   * @param result - Resultado de entrada.
   * @param mapper - Funcion de transformacion del valor exitoso.
   * @returns Nuevo resultado con el valor transformado.
   */
  map<T, U, E>(result: Result<T, E>, mapper: (value: T) => U): Result<U, E> {
    return result.ok ? Result.ok(mapper(result.value)) : result;
  },

  /**
   * Encadena una operacion que a su vez devuelve otro resultado.
   *
   * @param result - Resultado de entrada.
   * @param mapper - Funcion que produce el siguiente resultado de la cadena.
   * @returns Resultado final de la cadena.
   */
  flatMap<T, U, E>(result: Result<T, E>, mapper: (value: T) => Result<U, E>): Result<U, E> {
    return result.ok ? mapper(result.value) : result;
  },

  /**
   * Extrae el valor exitoso o aplica un valor por omision ante el fallo.
   *
   * @param result - Resultado de entrada.
   * @param fallback - Valor devuelto cuando el resultado es fallido.
   * @returns Valor exitoso o el valor por omision.
   */
  unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
    return result.ok ? result.value : fallback;
  },

  /**
   * Reduce el resultado a un unico valor aplicando la funcion correspondiente a cada rama.
   *
   * @param result - Resultado de entrada.
   * @param handlers - Funciones de resolucion para las ramas exitosa y fallida.
   * @returns Valor resultante de la rama aplicada.
   */
  match<T, E, R>(result: Result<T, E>, handlers: { readonly ok: (value: T) => R; readonly fail: (error: E) => R }): R {
    return result.ok ? handlers.ok(result.value) : handlers.fail(result.error);
  },
} as const;
