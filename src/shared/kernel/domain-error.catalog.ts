/**
 * @archivo src/shared/kernel/domain-error.catalog.ts
 * @modulo 00-kernel (Catalogo Unico de Errores de Dominio y Seguridad)
 * @proposito
 *   Declara las 15 clases de error controlado que los modulos de aplicacion lanzan y que el
 *   middleware de transporte traduce automaticamente a respuestas HTTP y a codigos de cierre
 *   del socket binario de voz. Cada clase fija su codigo estable y, cuando corresponde, aporta
 *   los detalles estructurados que el cliente necesita para reaccionar (documentos legales
 *   pendientes, segundos de espera de la cuota o direccion IP bloqueada por el escudo Anti-SSRF).
 *
 * @resumen_contenido
 *   - Errores de acceso: `UnauthorizedError`, `TokenVersionRevokedError`, `ForbiddenError`.
 *   - Errores de entrada y estado: `ValidationError`, `NotFoundError`, `ConflictError`.
 *   - Errores de cumplimiento: `TenantSuspendedError`, `LegalConsentOutdatedError`, `DpaNotSignedError`.
 *   - Errores de seguridad: `OriginNotAllowedError`, `SsrfBlockedIpError`.
 *   - Errores de negocio y disponibilidad: `InsufficientFundsError`, `RateLimitExceededError`,
 *     `ProviderUnavailableError`, `InternalError`.
 *
 * @dependencias_internas
 *   - `AppError` y `AppErrorContext` (`./app-error.ts`) como clase base y contrato comun.
 *     La dependencia apunta a la raiz de la jerarquia para evitar ciclos de inicializacion.
 *
 * @dependencias_externas
 *   - Ninguna (Jerarquia pura del dominio, sin acoplamiento a librerias externas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (La severidad de cada error define el registro de auditoria).
 *   - Redis: `rl:tb:<scope>` (El error de cuota informa los segundos de espera al cliente).
 */

import { AppError, type AppErrorContext } from './app-error';

/** Fallo de autenticacion: credenciales ausentes, invalidas o expiradas. */
export class UnauthorizedError extends AppError {
  public readonly code = 'UNAUTHORIZED' as const;

  /**
   * @param message - Motivo del rechazo (nunca debe revelar si el usuario existe).
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message = 'Credenciales invalidas o ausentes.', context: AppErrorContext = {}) {
    super(message, context);
  }
}

/** Revocacion global por `token_version`: el token es criptograficamente valido pero obsoleto. */
export class TokenVersionRevokedError extends AppError {
  public readonly code = 'TOKEN_VERSION_REVOKED' as const;

  /**
   * @param message - Motivo del rechazo por version de token desactualizada.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message = 'La sesion fue revocada globalmente; vuelva a iniciar sesion.', context: AppErrorContext = {}) {
    super(message, context);
  }
}

/** Falta de permisos RBAC sobre el recurso solicitado. */
export class ForbiddenError extends AppError {
  public readonly code = 'FORBIDDEN' as const;

  /**
   * @param message - Recurso o accion denegada.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message = 'No tiene permisos para ejecutar esta accion.', context: AppErrorContext = {}) {
    super(message, context);
  }
}

/** Fallo de validacion de esquema de entrada (DTO, trama WebSocket o JSON Schema). */
export class ValidationError extends AppError {
  public readonly code = 'VALIDATION_FAILED' as const;

  /**
   * @param message - Descripcion legible del incumplimiento de esquema.
   * @param issues - Listado de rutas y motivos por campo invalido.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message: string, issues: readonly string[] = [], context: AppErrorContext = {}) {
    super(message, { ...context, details: { ...context.details, issues } });
  }
}

/** Recurso inexistente o no visible bajo el contexto de organizacion activo. */
export class NotFoundError extends AppError {
  public readonly code = 'NOT_FOUND' as const;

  /**
   * @param resource - Identificador o nombre del recurso no encontrado.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(resource: string, context: AppErrorContext = {}) {
    super(`Recurso no encontrado: ${resource}.`, { ...context, resource });
  }
}

/** Colision de estado: recursos duplicados o transiciones no permitidas. */
export class ConflictError extends AppError {
  public readonly code = 'CONFLICT' as const;

  /**
   * @param message - Descripcion del conflicto detectado.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message: string, context: AppErrorContext = {}) {
    super(message, context);
  }
}

/** Organizacion suspendida por el SuperAdmin: se corta el servicio de inmediato. */
export class TenantSuspendedError extends AppError {
  public readonly code = 'TENANT_SUSPENDED' as const;

  /**
   * @param reason - Motivo de la suspension registrado por gobierno.
   * @param context - Metadatos de la organizacion afectada.
   */
  public constructor(reason = 'Organizacion suspendida por la administracion de la plataforma.', context: AppErrorContext = {}) {
    super(reason, context);
  }
}

/** El usuario no ha aceptado la version vigente de los documentos legales obligatorios. */
export class LegalConsentOutdatedError extends AppError {
  public readonly code = 'LEGAL_CONSENT_OUTDATED' as const;

  /**
   * @param pendingDocuments - Documentos legales pendientes de aceptacion.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(pendingDocuments: readonly string[] = [], context: AppErrorContext = {}) {
    super('Debe aceptar la version vigente de los documentos legales para continuar.', {
      ...context,
      details: { ...context.details, pendingDocuments },
    });
  }
}

/** La organizacion no tiene firmado el Acuerdo de Procesamiento de Datos (DPA). */
export class DpaNotSignedError extends AppError {
  public readonly code = 'DPA_NOT_SIGNED' as const;

  /**
   * @param context - Metadatos de la organizacion afectada.
   */
  public constructor(context: AppErrorContext = {}) {
    super('La organizacion no tiene firmado el Acuerdo de Procesamiento de Datos vigente.', context);
  }
}

/** El origen HTTP (`Origin`) no figura en `allowed_domains` del proyecto. */
export class OriginNotAllowedError extends AppError {
  public readonly code = 'ORIGIN_NOT_ALLOWED' as const;

  /**
   * @param origin - Origen recibido que fue rechazado.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(origin: string, context: AppErrorContext = {}) {
    super(`El origen "${origin}" no esta autorizado para este proyecto.`, {
      ...context,
      details: { ...context.details, origin },
    });
  }
}

/** El escudo Anti-SSRF bloqueo una direccion IP de destino prohibida. */
export class SsrfBlockedIpError extends AppError {
  public readonly code = 'SSRF_BLOCKED_IP' as const;

  /**
   * @param hostname - Nombre de host solicitado por el usuario.
   * @param resolvedIp - Direccion IP resuelta que fue bloqueada.
   * @param reason - Clasificacion del bloqueo (metadatos de nube, bucle local, RFC 1918).
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(hostname: string, resolvedIp: string, reason: string, context: AppErrorContext = {}) {
    super(`Destino bloqueado por el escudo Anti-SSRF: ${hostname} resuelve a ${resolvedIp} (${reason}).`, {
      ...context,
      details: { ...context.details, hostname, resolvedIp, reason },
    });
  }
}

/** Saldo de minutos o credito insuficiente: la sesion de voz debe cerrarse con corte controlado. */
export class InsufficientFundsError extends AppError {
  public readonly code = 'INSUFFICIENT_FUNDS' as const;

  /**
   * @param availableMinutes - Minutos incluidos disponibles al momento del corte.
   * @param creditBalanceUsd - Saldo de credito en USD disponible.
   * @param context - Metadatos de la organizacion y la sesion afectada.
   */
  public constructor(availableMinutes: string, creditBalanceUsd: string, context: AppErrorContext = {}) {
    super('Saldo insuficiente para continuar la sesion en tiempo real.', {
      ...context,
      details: { ...context.details, availableMinutes, creditBalanceUsd },
    });
  }
}

/** Cuota de peticiones excedida por el Token Bucket de Redis. */
export class RateLimitExceededError extends AppError {
  public readonly code = 'RATE_LIMIT_EXCEEDED' as const;

  /**
   * @param retryAfterSeconds - Segundos que el cliente debe esperar antes de reintentar.
   * @param scope - Ambito de la cuota aplicada (por ejemplo `login:ip` o `demo:origin`).
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(retryAfterSeconds: number, scope: string, context: AppErrorContext = {}) {
    super(`Cuota de peticiones excedida para el ambito "${scope}".`, {
      ...context,
      details: { ...context.details, retryAfterSeconds, scope },
    });
  }
}

/** El motor externo de un proveedor no responde: habilita la ruta de conmutacion por failover. */
export class ProviderUnavailableError extends AppError {
  public readonly code = 'PROVIDER_UNAVAILABLE' as const;

  /**
   * @param providerRole - Rol del proveedor afectado (`PRIMARY` o `FAILOVER`).
   * @param reason - Motivo tecnico del fallo.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(providerRole: 'PRIMARY' | 'FAILOVER', reason: string, context: AppErrorContext = {}) {
    super(`El motor de ${providerRole === 'PRIMARY' ? 'primario' : 'respaldo'} no esta disponible: ${reason}`, {
      ...context,
      details: { ...context.details, providerRole, reason },
    });
  }
}

/** Fallo interno no clasificado: siempre debe registrarse para analisis forense. */
export class InternalError extends AppError {
  public readonly code = 'INTERNAL_ERROR' as const;

  /**
   * @param message - Descripcion interna del fallo.
   * @param context - Metadatos opcionales de trazabilidad.
   */
  public constructor(message = 'Error interno del servidor.', context: AppErrorContext = {}) {
    super(message, context);
  }
}
