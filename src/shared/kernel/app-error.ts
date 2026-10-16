/**
 * @archivo src/shared/kernel/app-error.ts
 * @modulo 00-kernel (Clase Base de Errores, Codigos Estables y Traduccion HTTP/WebSocket)
 * @proposito
 *   Declara el contrato de fallo de toda la plataforma: la clase abstracta `AppError`, que
 *   traduce cada codigo de negocio a estado HTTP, codigo de cierre del socket binario de voz y
 *   severidad de auditoria, junto con los mapas canonicos que hacen determinista esa traduccion.
 *   Vive en su propio archivo, separado del catalogo de errores concretos, para garantizar que
 *   la clase base siempre se evalue antes que sus subclases y evitar ciclos de inicializacion.
 *
 * @resumen_contenido
 *   - Tipo `AppErrorCode` con los 15 codigos estables y `AuditSeverity`.
 *   - Mapas `HTTP_STATUS_BY_ERROR_CODE`, `WS_CLOSE_CODE_BY_ERROR_CODE` y `AUDIT_SEVERITY_BY_ERROR_CODE`.
 *   - Interfaces `AppErrorContext` y `SerializedAppError`.
 *   - Clase abstracta `AppError` con `httpStatus`, `wsCloseCode`, `auditSeverity` y `toJSON()`.
 *   - Funcion `isAppError()`: Guarda de tipo para discriminacion en bloques `catch`.
 *
 * @dependencias_internas
 *   - Ninguna (Raiz absoluta de la jerarquia de errores: no importa ningun otro modulo).
 *
 * @dependencias_externas
 *   - Ninguna (Sin acoplamiento a librerias de terceros).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (La `auditSeverity` clasifica el registro del evento).
 *   - Redis: `rl:tb:<scope>` (El codigo de cuota excedida informa los segundos de espera).
 */

/** Codigos de error unicos y estables del sistema (contrato publico con el SDK y los paneles). */
export type AppErrorCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_VERSION_REVOKED'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TENANT_SUSPENDED'
  | 'LEGAL_CONSENT_OUTDATED'
  | 'DPA_NOT_SIGNED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'SSRF_BLOCKED_IP'
  | 'INSUFFICIENT_FUNDS'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Severidad con la que el error debe registrarse en `audit_logs`. */
export type AuditSeverity = 'INFO' | 'WARN' | 'CRITICAL_SECURITY';

/** Mapa canonico de codigo de error a estado HTTP de respuesta. */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<AppErrorCode, number>> = {
  UNAUTHORIZED: 401,
  TOKEN_VERSION_REVOKED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TENANT_SUSPENDED: 403,
  LEGAL_CONSENT_OUTDATED: 403,
  DPA_NOT_SIGNED: 403,
  ORIGIN_NOT_ALLOWED: 403,
  SSRF_BLOCKED_IP: 400,
  INSUFFICIENT_FUNDS: 402,
  RATE_LIMIT_EXCEEDED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * Mapa canonico de codigo de error al codigo de cierre del socket binario de voz.
 * `1008` es el codigo estandar de "policy violation"; el rango 4000-4999 es de uso privado
 * de la aplicacion y permite al SDK distinguir el motivo del corte sin leer texto libre.
 */
export const WS_CLOSE_CODE_BY_ERROR_CODE: Readonly<Record<AppErrorCode, number>> = {
  UNAUTHORIZED: 4001,
  TOKEN_VERSION_REVOKED: 4001,
  FORBIDDEN: 1008,
  VALIDATION_FAILED: 1008,
  NOT_FOUND: 1008,
  CONFLICT: 1008,
  TENANT_SUSPENDED: 4003,
  LEGAL_CONSENT_OUTDATED: 4004,
  DPA_NOT_SIGNED: 4004,
  ORIGIN_NOT_ALLOWED: 4005,
  SSRF_BLOCKED_IP: 4006,
  INSUFFICIENT_FUNDS: 4002,
  RATE_LIMIT_EXCEEDED: 4007,
  PROVIDER_UNAVAILABLE: 4008,
  INTERNAL_ERROR: 1011,
};

/** Mapa canonico de codigo de error a severidad de auditoria. */
export const AUDIT_SEVERITY_BY_ERROR_CODE: Readonly<Record<AppErrorCode, AuditSeverity>> = {
  UNAUTHORIZED: 'WARN',
  TOKEN_VERSION_REVOKED: 'CRITICAL_SECURITY',
  FORBIDDEN: 'WARN',
  VALIDATION_FAILED: 'INFO',
  NOT_FOUND: 'INFO',
  CONFLICT: 'WARN',
  TENANT_SUSPENDED: 'WARN',
  LEGAL_CONSENT_OUTDATED: 'WARN',
  DPA_NOT_SIGNED: 'WARN',
  ORIGIN_NOT_ALLOWED: 'CRITICAL_SECURITY',
  SSRF_BLOCKED_IP: 'CRITICAL_SECURITY',
  INSUFFICIENT_FUNDS: 'WARN',
  RATE_LIMIT_EXCEEDED: 'WARN',
  PROVIDER_UNAVAILABLE: 'WARN',
  INTERNAL_ERROR: 'WARN',
};

/** Metadatos opcionales de trazabilidad multi-tenant asociados a un error. */
export interface AppErrorContext {
  /** Organizacion (tenant) en cuyo contexto ocurrio el fallo. */
  readonly organizationId?: string;
  /** Usuario autenticado que origino la operacion. */
  readonly userId?: string;
  /** Recurso afectado (por ejemplo `usage_ledger:<uuid>`). */
  readonly resource?: string;
  /** Detalle adicional estructurado, ya depurado de datos sensibles. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Cuerpo JSON con el que todo error de la plataforma responde a un cliente HTTP. */
export interface SerializedAppError {
  readonly error: {
    readonly code: AppErrorCode;
    readonly message: string;
    readonly httpStatus: number;
    readonly wsCloseCode: number;
    readonly auditSeverity: AuditSeverity;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

/**
 * Clase base abstracta de todos los errores controlados de la plataforma.
 * Traduce de forma determinista el codigo de negocio a estado HTTP, cierre de socket y
 * severidad de auditoria, evitando que cada modulo invente su propio mapeo.
 */
export abstract class AppError extends Error {
  /** Codigo unico y estable del error. */
  public abstract readonly code: AppErrorCode;

  /** Contexto opcional de trazabilidad (tenant, usuario y recurso). */
  public readonly context: AppErrorContext;

  /** Momento exacto de creacion del error, usado en la bitacora de auditoria. */
  public readonly occurredAt: Date;

  /**
   * Construye un error controlado de la plataforma.
   *
   * @param message - Mensaje tecnico en espanol apto para logs y respuesta de API.
   * @param context - Metadatos opcionales de tenant, usuario y recurso afectado.
   */
  protected constructor(message: string, context: AppErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
    this.occurredAt = new Date();
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }

  /** Estado HTTP recomendado para responder a un cliente REST o al SDK. */
  public get httpStatus(): number {
    return HTTP_STATUS_BY_ERROR_CODE[this.code];
  }

  /** Codigo de cierre recomendado para el socket binario del Gateway de Voz. */
  public get wsCloseCode(): number {
    return WS_CLOSE_CODE_BY_ERROR_CODE[this.code];
  }

  /** Severidad con la que el evento debe registrarse en `audit_logs`. */
  public get auditSeverity(): AuditSeverity {
    return AUDIT_SEVERITY_BY_ERROR_CODE[this.code];
  }

  /**
   * Serializa el error al contrato JSON publico de la plataforma.
   * Nunca incluye la traza de pila ni detalles internos del motor de base de datos.
   *
   * @returns Cuerpo JSON apto para enviar al cliente.
   */
  public toJSON(): SerializedAppError {
    return {
      error: {
        code: this.code,
        message: this.message,
        httpStatus: this.httpStatus,
        wsCloseCode: this.wsCloseCode,
        auditSeverity: this.auditSeverity,
        details: this.context.details ?? {},
      },
    };
  }
}

/**
 * Determina si un valor desconocido es un error controlado de la plataforma.
 *
 * @param candidate - Valor a inspeccionar.
 * @returns `true` cuando el valor es una instancia de `AppError`.
 */
export function isAppError(candidate: unknown): candidate is AppError {
  return candidate instanceof AppError;
}
