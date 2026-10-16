/**
 * @archivo src/bootstrap/session-auth.middleware.ts
 * @modulo Bootstrap (Middleware de Sesion y Control de Acceso HTTP - C2-05)
 * @proposito
 *   Evalua el nivel de acceso exigido por cada ruta declarada antes de delegar en su manejador,
 *   resolviendo de raiz el hallazgo C2-05 (borde respondiendo 503 por falta de middleware):
 *     1. Rutas PUBLIC: Permite paso irrestricto sin identidad obligatoria.
 *     2. Rutas SDK_HANDSHAKE: Exige encabezado Origin no vacio.
 *     3. Rutas TENANT_SESSION y SUPERADMIN: Extrae token Bearer, delega en IIdentityAuthPort
 *        para verificar firma Ed25519 y revocacion por token_version, valida permisos RBAC
 *        y construye el principal autenticado para el contexto de la solicitud.
 *
 * @resumen_contenido
 *   - Type `RouteAccessRejection`: Estructura tipada de rechazo HTTP (status, code, message).
 *   - Type `RouteAccessSuccess`: Contexto autenticado resuelto (principal, organizationId).
 *   - Type `RouteAccessEvaluationResult`: Union discriminada de exito o rechazo.
 *   - Funcion `evaluateRouteAccess()`: Orquesta la inspeccion y verificacion de credenciales.
 *
 * @dependencias_internas
 *   - `IIdentityAuthPort` (`@shared/ports/core-modules.ports`).
 *   - `HttpRouteRegistration`, `HttpRequestLike`, `AuthenticatedPrincipal` (`@shared/infrastructure/http/http-server.types`).
 */

import type { IIdentityAuthPort } from '../shared/ports/core-modules.ports';
import type {
  AuthenticatedPrincipal,
  HttpRequestLike,
  HttpRouteRegistration,
} from '../shared/infrastructure/http/http-server.types';

/** Rechazo HTTP estructurado para devolver al cliente antes de ejecutar el caso de uso. */
export interface RouteAccessRejection {
  readonly allowed: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Exito de evaluacion de acceso con el principal resuelto. */
export interface RouteAccessSuccess {
  readonly allowed: true;
  readonly principal: AuthenticatedPrincipal | null;
  readonly organizationId: string | null;
}

export type RouteAccessEvaluationResult = RouteAccessRejection | RouteAccessSuccess;

const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
});

/**
 * Evalua el nivel de acceso de una ruta declarada contra la peticion HTTP entrante.
 *
 * @param route - Registro de la ruta coincidente.
 * @param request - Peticion HTTP normalizada.
 * @param authVerifier - Puerto de identidad y verificacion de sesion (C1-35).
 * @returns Resultado de la evaluacion: exito con identidad o rechazo con codigo HTTP.
 */
export async function evaluateRouteAccess(
  route: HttpRouteRegistration,
  request: HttpRequestLike,
  authVerifier: IIdentityAuthPort
): Promise<RouteAccessEvaluationResult> {
  // 1. Rutas publicas: no requieren credenciales
  if (route.access === 'PUBLIC') {
    return { allowed: true, principal: null, organizationId: null };
  }

  // 2. Handshake del SDK: exige presencia del origen para CORS / verificacion
  if (route.access === 'SDK_HANDSHAKE') {
    const originHeader = request.headers['origin'];
    const hasOrigin = typeof originHeader === 'string' && originHeader.trim().length > 0;
    if (!hasOrigin) {
      return {
        allowed: false,
        status: HTTP_STATUS.FORBIDDEN,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'El handshake exige el encabezado Origin.',
      };
    }
    return { allowed: true, principal: null, organizationId: null };
  }

  // 3. Rutas autenticadas (TENANT_SESSION o SUPERADMIN): exigen cabecera Authorization: Bearer <token>
  const authorizationHeader = request.headers['authorization'];
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
    return {
      allowed: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      code: 'UNAUTHORIZED',
      message: 'Esta operacion exige una sesion autenticada.',
    };
  }

  const token = authorizationHeader.slice(7).trim();
  if (token.length === 0) {
    return {
      allowed: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      code: 'UNAUTHORIZED',
      message: 'Token de autorizacion vacio.',
    };
  }

  // 4. Verificacion de firma EdDSA y vigencia del token_version (C1-35)
  const authResult = await authVerifier.verifyAccessTokenAndVersion(token);
  if (!authResult.ok) {
    return {
      allowed: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      code: authResult.code,
      message: authResult.reason,
    };
  }

  const { actor } = authResult;

  // 5. Restriccion de rol para rutas de gobierno SuperAdmin
  if (route.access === 'SUPERADMIN' && actor.role !== 'SUPERADMIN') {
    return {
      allowed: false,
      status: HTTP_STATUS.FORBIDDEN,
      code: 'FORBIDDEN',
      message: 'Se requiere rol SuperAdmin de plataforma para acceder a esta ruta.',
    };
  }

  // 6. Validacion de permisos finos exigidos por la ruta (si fueron declarados)
  if (route.requiredScopes && route.requiredScopes.length > 0 && actor.role !== 'SUPERADMIN') {
    const actorScopeSet = new Set(actor.scopes);
    const hasAllScopes = route.requiredScopes.every((scope) => actorScopeSet.has(scope));
    if (!hasAllScopes) {
      return {
        allowed: false,
        status: HTTP_STATUS.FORBIDDEN,
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Credenciales carecen de los permisos requeridos para esta operacion.',
      };
    }
  }

  const principal: AuthenticatedPrincipal = {
    userId: actor.userId,
    organizationId: actor.organizationId,
    role: actor.role,
    scopes: actor.scopes,
    tokenVersion: actor.tokenVersion,
    mfaSatisfied: actor.mfaSatisfied,
    tokenId: actor.tokenId,
  };

  return {
    allowed: true,
    principal,
    organizationId: actor.organizationId,
  };
}
