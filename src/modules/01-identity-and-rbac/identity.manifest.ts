/**
 * @archivo src/modules/01-identity-and-rbac/identity.manifest.ts
 * @modulo 01-identity-and-rbac (Manifiesto Oficial y Auto-Wiring del Modulo de Identidad y RBAC)
 * @proposito
 *   Conecta e inicializa todos los repositorios, casos de uso, middlewares y endpoints HTTP
 *   del Módulo 01 (Autenticación B2B, EdDSA, RBAC, MFA TOTP/FIDO2, SAML, CLI Device y Legal).
 *   Implementa el patron de auto-conexion (Auto-Wiring) registrando el puerto oficial
 *   `IIdentityAuthPort` en el contenedor DI y publicando sus rutas en `HttpRouterRegistry`.
 *
 * @resumen_contenido
 *   - Middlewares de autorizacion RBAC y SuperAdmin FIDO2.
 *   - `IdentityAuditLoggerAdapter`: bitacora C1-38 en `audit_logs` inyectada en los casos de uso.
 *   - Funcion `registerIdentityModule()`:
 *       * Resolucion perezosa de dependencias del Kernel y Redis.
 *       * Publicacion de `IdentityAuthPortAdapter` en `DI_TOKENS.IdentityAuthPort`.
 *       * Enrutamiento de endpoints REST `/api/v1/auth/*` y `/api/v1/legal/*`.
 *
 * @dependencias_internas
 *   - `DependencyContainer`, `DI_TOKENS` (src/shared/container/di-container.ts).
 *   - `HttpRouterRegistry`, `WsRouteRegistry` (src/shared/infrastructure/http/http-server.types.ts).
 *   - `ForbiddenError`, `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *   - `ROLE_PERMISSIONS_MAP`, `RbacPermission` (./domain/identity.entities.ts).
 *   - Casos de uso y repositorios del Módulo 01.
 */

import type { DependencyContainer } from '@shared/container/di-container';
import { DI_TOKENS } from '@shared/container/di-container';
import type {
  AuthenticatedPrincipal,
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRouteHandler,
  HttpRouterRegistry,
  HttpRequestLike,
  WsRouteRegistry,
} from '@shared/infrastructure/http/http-server.types';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@shared/kernel/result-and-errors';
import { ROLE_PERMISSIONS_MAP, type RbacPermission } from './domain/identity.entities';
import { PostgresIdentityRepository } from './infrastructure/postgres-identity.repository';
import { PostgresAdvancedIdentityRepository } from './infrastructure/postgres-advanced-identity.repository';
import { JwtEddsaSigner } from './infrastructure/jwt-eddsa.signer';
import { AuthenticateUserUseCase } from './application/authenticate-user.use-case';
import { RegisterOrganizationOwnerUseCase } from './application/register-and-login.use-case';
import {
  IdentityAuthPortAdapter,
  RevokeAllUserSessionsUseCase,
  RotateRefreshTokenUseCase,
} from './application/refresh-and-revoke-session.use-case';
import { MfaRecoveryAndBreakGlassUseCase, TotpMfaUseCase, WebAuthnFido2UseCase } from './application/mfa-and-webauthn.use-case';
import { ConfirmPasswordResetUseCase, ManageOrganizationInvitationsUseCase, RequestPasswordResetUseCase } from './application/password-reset-and-invites.use-case';
import { CliDeviceFlowUseCase, SsoSamlUseCase } from './application/sso-saml-and-cli-device.use-case';
import { LegalAndPrivacyComplianceUseCase } from './application/legal-privacy-compliance.use-case';
import { IdentityAuditLoggerAdapter } from './infrastructure/identity-audit.logger';
import { toPublicUser, toPublicOrganization } from './application/identity-public-projections';

/**
 * Valida que la peticion cuente con un principal autenticado valido.
 */
export function requireAuthPrincipal(context: AuthenticatedRequestContext): AuthenticatedPrincipal {
  if (!context.principal) {
    throw new UnauthorizedError('Se requiere un token de acceso válido para ejecutar esta acción.');
  }
  return context.principal;
}

/**
 * Valida que el rol del usuario contenga el permiso granular exigido.
 */
export function requirePermission(principal: AuthenticatedPrincipal, permission: RbacPermission): void {
  const allowedPermissions = ROLE_PERMISSIONS_MAP[principal.role];
  if (!allowedPermissions || !allowedPermissions.includes(permission)) {
    throw new ForbiddenError(`Tu rol [${principal.role}] no cuenta con el permiso requerido [${permission}].`);
  }
}

/**
 * Exige que la solicitud provenga de un operador SuperAdmin con segundo factor FIDO2 acreditado.
 */
export function requireSuperAdminFido2(principal: AuthenticatedPrincipal): void {
  if (principal.role !== 'SUPERADMIN') {
    throw new ForbiddenError('Esta operación requiere privilegios exclusivos de SuperAdmin de plataforma.');
  }
  if (!principal.mfaSatisfied) {
    throw new ForbiddenError('Esta acción crítica de SuperAdmin exige verificación biométrica WebAuthn FIDO2.');
  }
}

/** Adaptador utilitario para registrar manejadores HTTP tipados. */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/**
 * Registra y auto-conecta el modulo completo de Identidad y RBAC.
 */
/**
 * Nombre de la cookie HttpOnly que transporta el refresh token.
 * El navegador no puede leerla (ni enviar su valor en un cuerpo JSON), por lo que el refresco
 * silencioso del frente depende de que el backend la lea de la propia solicitud.
 */
const REFRESH_COOKIE_NAME = '__Host-oa_rt';

/**
 * Extrae el valor de una cookie del encabezado `Cookie` de la solicitud.
 *
 * @param cookieHeader - Valor crudo de la cabecera `Cookie` (o su array, según el servidor).
 * @param cookieName - Nombre exacto de la cookie buscada.
 * @returns El valor decodificado de la cookie o `''` si no está presente.
 */
export function readCookieValue(
  cookieHeader: string | readonly string[] | undefined,
  cookieName: string
): string {
  if (cookieHeader === undefined) {
    return '';
  }
  const headerText = typeof cookieHeader === 'string' ? cookieHeader : cookieHeader.join('; ');
  if (headerText.length === 0) {
    return '';
  }
  for (const part of headerText.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name !== cookieName) {
      continue;
    }
    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return '';
}

export function registerIdentityModule(
  container: DependencyContainer,
  router: HttpRouterRegistry,
  _wsRegistry: WsRouteRegistry
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redis = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;

  // Instanciacion de Infraestructura
  const identityRepo = new PostgresIdentityRepository(rlsPool, redis);
  const advancedRepo = new PostgresAdvancedIdentityRepository(rlsPool);
  const jwtSigner = new JwtEddsaSigner(redis);
  // Bitacora de auditoria de autenticacion C1-38 (tabla existente `audit_logs`, sin migracion).
  const identityAuditLogger = new IdentityAuditLoggerAdapter(rlsPool);

  // Instanciacion de Casos de Uso
  const registerUseCase = new RegisterOrganizationOwnerUseCase(rlsPool, identityRepo, advancedRepo);
  const authUseCase = new AuthenticateUserUseCase(identityRepo, identityAuditLogger);
  const rotateRefreshUseCase = new RotateRefreshTokenUseCase(identityRepo, identityAuditLogger);
  const revokeSessionsUseCase = new RevokeAllUserSessionsUseCase(identityRepo, identityAuditLogger);
  const totpUseCase = new TotpMfaUseCase(identityRepo, advancedRepo, identityAuditLogger);
  const webauthnUseCase = new WebAuthnFido2UseCase(redis, identityAuditLogger);
  const recoveryUseCase = new MfaRecoveryAndBreakGlassUseCase(advancedRepo, identityRepo, identityAuditLogger);
  const requestPwdResetUseCase = new RequestPasswordResetUseCase(identityRepo, advancedRepo, identityAuditLogger);
  const confirmPwdResetUseCase = new ConfirmPasswordResetUseCase(identityRepo, advancedRepo, identityAuditLogger);
  const invitationsUseCase = new ManageOrganizationInvitationsUseCase(identityRepo, advancedRepo, identityAuditLogger);
  const ssoUseCase = new SsoSamlUseCase(advancedRepo, redis);
  const cliDeviceUseCase = new CliDeviceFlowUseCase(redis, jwtSigner);
  const legalUseCase = new LegalAndPrivacyComplianceUseCase(advancedRepo, identityRepo);

  // Adaptador oficial del puerto IIdentityAuthPort
  const portAdapter = new IdentityAuthPortAdapter(identityRepo, redis);
  if (!container.has(DI_TOKENS.IdentityAuthPort)) {
    container.registerInstance(DI_TOKENS.IdentityAuthPort, portAdapter);
  }

  // --- REGISTRO DE RUTAS HTTP REST --------------------------------------------

  // POST /api/v1/auth/register (Registro de Tenant B2B)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/register',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      const rawAcceptedCodes = body['acceptedLegalDocumentCodes'];
      if (rawAcceptedCodes !== undefined && !Array.isArray(rawAcceptedCodes)) {
        throw new ValidationError('`acceptedLegalDocumentCodes` debe ser un arreglo de codigos legales.', ['acceptedLegalDocumentCodes']);
      }
      const acceptedLegalDocumentCodes = Array.isArray(rawAcceptedCodes)
        ? rawAcceptedCodes.filter((code): code is string => typeof code === 'string')
        : undefined;
      const result = await registerUseCase.execute({
        email: String(body['ownerEmail'] ?? body['email'] ?? ''),
        fullName: String(body['ownerFullName'] ?? body['fullName'] ?? ''),
        password: String(body['ownerPassword'] ?? body['password'] ?? ''),
        organizationName: String(body['organizationName'] ?? ''),
        organizationSlug: String(body['organizationSlug'] ?? ''),
        phone: String(body['ownerPhone'] ?? body['phoneNumber'] ?? body['phone'] ?? '').trim(),
        ...(acceptedLegalDocumentCodes !== undefined ? { acceptedLegalDocumentCodes } : {}),
        ipAddress: req.clientIp,
        userAgent,
      });
      // Se responde con una PROYECCION EXPLICITA y no con el resultado del caso de uso. Devolverlo
      // entero exponia el hash de la contrasena, el secreto del segundo factor, el codigo de
      // verificacion por correo **en claro** y el token de renovacion: material suficiente para romper
      // la contrasena fuera de linea, para verificar correos ajenos y para anular el segundo factor.
      return {
        status: 201,
        body: {
          user: toPublicUser(result.user),
          organization: toPublicOrganization(result.organization),
          accessToken: result.accessToken,
          emailVerificationRequired: true,
          legalAcceptancesRecorded: result.acceptedLegalDocumentCodes,
        },
        headers: {
          'Set-Cookie': `__Host-oa_rt=${result.rawRefreshToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        },
      };
    }),
  });

  // POST /api/v1/auth/login (Login B2B con piso constante 350ms)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/login',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      const result = await authUseCase.execute({
        email: String(body['email'] ?? ''),
        password: String(body['password'] ?? ''),
        ipAddress: req.clientIp,
        userAgent,
        ...(body['organizationSlug'] ? { organizationSlug: String(body['organizationSlug']) } : {}),
      });

      if (result.status === 'MFA_REQUIRED' || result.status === 'LEGAL_CONSENT_REQUIRED') {
        return { status: 202, body: result };
      }

      return {
        status: 200,
        body: {
          accessToken: result.accessToken,
          // Proyeccion explicita: la entidad completa exponia el hash de la contrasena, el secreto del
          // segundo factor y las credenciales de llave fisica en CADA inicio de sesion.
          user: toPublicUser(result.user),
          organization: toPublicOrganization(result.organization),
          role: result.role,
        },
        headers: {
          'Set-Cookie': `__Host-oa_rt=${result.rawRefreshToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        },
      };
    }),
  });

  // POST /api/v1/auth/refresh (Rotacion de Refresh Token con ventana de gracia)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/refresh',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Fuente primaria: la cookie HttpOnly `__Host-oa_rt` (el navegador no puede copiar su valor
      // al cuerpo). Fuente de respaldo: el cuerpo JSON, para clientes no navegador.
      const cookieToken = readCookieValue(req.headers['cookie'], REFRESH_COOKIE_NAME);
      const bodyToken = String(body['refreshToken'] ?? '');
      const rawToken = cookieToken.length > 0 ? cookieToken : bodyToken;
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      const result = await rotateRefreshUseCase.execute({
        rawRefreshToken: rawToken,
        ipAddress: req.clientIp,
        userAgent,
      });
      return {
        status: 200,
        body: {
          accessToken: result.accessToken,
          user: toPublicUser(result.user),
          organization: toPublicOrganization(result.organization),
        },
        headers: {
          'Set-Cookie': `__Host-oa_rt=${result.rawRefreshToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        },
      };
    }),
  });

  // POST /api/v1/auth/logout (Revocacion de sesiones)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/logout',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = requireAuthPrincipal(ctx);
      await revokeSessionsUseCase.execute(principal.userId, 'USER_REQUESTED_LOGOUT', {
        organizationId: principal.organizationId,
        ipAddress: _req.clientIp,
        userAgent: String(_req.headers['user-agent'] ?? 'Unknown'),
      });
      return { status: 200, body: { revoked: true } };
    }),
  });

  // POST /api/v1/auth/cli-device/code (Inicio de Device Flow)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/cli-device/code',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (): Promise<HttpHandlerResult> => {
      const result = await cliDeviceUseCase.initiateDeviceFlow();
      return { status: 200, body: result };
    }),
  });

  // POST /api/v1/auth/cli-device/poll (Sondeo desde CLI)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/cli-device/poll',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceCode = String(body['deviceCode'] ?? '');
      const result = await cliDeviceUseCase.pollDeviceStatus(deviceCode);
      return { status: 200, body: result };
    }),
  });

  // POST /api/v1/auth/cli-device/confirm (Confirmacion web desde sesion activa)
  router.register({
    method: 'POST',
    path: '/api/v1/auth/cli-device/confirm',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = requireAuthPrincipal(ctx);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userCode = String(body['userCode'] ?? '');
      const confirmed = await cliDeviceUseCase.confirmDeviceAuthorization(
        userCode,
        principal.userId,
        principal.organizationId,
        principal.role,
        principal.tokenVersion
      );
      return { status: confirmed ? 200 : 400, body: { confirmed } };
    }),
  });

  // GET /api/v1/legal/documents (Listado de documentos obligatorios vigentes)
  router.register({
    method: 'GET',
    path: '/api/v1/legal/documents',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (): Promise<HttpHandlerResult> => {
      const docs = await legalUseCase.getActiveMandatoryDocuments();
      return { status: 200, body: { documents: docs } };
    }),
  });

  // POST /api/v1/legal/accept-pre-session (Renovacion de consentimiento antes de emitir sesion)
  router.register({
    method: 'POST',
    path: '/api/v1/legal/accept-pre-session',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawDocumentIds = Array.isArray(body['legalDocumentIds']) ? body['legalDocumentIds'] : [];
      const legalDocumentIds = rawDocumentIds.filter((value): value is string => typeof value === 'string');
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      const result = await legalUseCase.acceptPendingDocumentsWithChallenge({
        consentChallengeToken: String(body['consentChallengeToken'] ?? ''),
        legalDocumentIds,
        ipAddress: req.clientIp,
        userAgent,
      });
      return {
        status: 200,
        body: {
          accepted: true,
          acceptedDocumentIds: result.acceptedDocumentIds,
          pendingDocuments: result.pendingDocuments,
        },
      };
    }),
  });

  // POST /api/v1/legal/accept (Aceptacion formal con snapshot SHA-256 derivado en servidor)
  router.register({
    method: 'POST',
    path: '/api/v1/legal/accept',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = requireAuthPrincipal(ctx);
      if (principal.role !== 'OWNER') {
        throw new ForbiddenError('Solo el rol OWNER de la organización puede aceptar documentos en su nombre.');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      // El resumen aportado por el cliente se ignora: el sello se deriva en servidor desde el catalogo.
      const legalDocumentId = String(body['legalDocumentId'] ?? body['documentId'] ?? '');
      const evidence = await legalUseCase.acceptDocument({
        userId: principal.userId,
        organizationId: principal.organizationId,
        legalDocumentId,
        ipAddress: req.clientIp,
        userAgent,
      });
      return { status: 200, body: { accepted: true, evidence } };
    }),
  });

  // POST /api/v1/legal/dpa/sign (Suscripcion empresarial de DPA por OWNER)
  router.register({
    method: 'POST',
    path: '/api/v1/legal/dpa/sign',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = requireAuthPrincipal(ctx);
      if (principal.role !== 'OWNER') {
        throw new ForbiddenError('Solo el rol OWNER de la organización puede suscribir el DPA empresarial.');
      }
      const userAgent = String(req.headers['user-agent'] ?? 'Unknown');
      await legalUseCase.signDpa(principal.userId, principal.organizationId, req.clientIp, userAgent);
      return { status: 200, body: { dpaSigned: true } };
    }),
  });

  // GET /api/v1/legal/gdpr/export (Portabilidad de datos personales GDPR)
  router.register({
    method: 'GET',
    path: '/api/v1/legal/gdpr/export',
    access: 'TENANT_SESSION',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (_req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = requireAuthPrincipal(ctx);
      const exportData = await legalUseCase.exportUserData(principal.userId);
      return { status: 200, body: exportData };
    }),
  });
}

