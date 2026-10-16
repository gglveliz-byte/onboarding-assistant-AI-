/**
 * @archivo src/bootstrap/auth-essential-http.routes.ts
 * @modulo Bootstrap (Rutas Esenciales de Identidad HTTP - C1-36)
 * @proposito
 *   Publica las rutas HTTP esenciales de identidad que faltaban en el ensamblaje de la plataforma:
 *     1. `POST /api/v1/auth/mfa/verify`: Canjea el reto efimero `mfaChallengeToken` (202 MFA_REQUIRED)
 *        validando TOTP o codigo de respaldo y emite tokens de sesion con mfaSatisfied=true.
 *     2. `POST /api/v1/auth/password-reset/request`: Solicita recuperacion de contrasena con piso
 *        anti-enumeracion sin exponer nunca el token crudo en la respuesta HTTP (C1-41).
 *     3. `POST /api/v1/auth/password-reset/confirm`: Valida el token y actualiza la contrasena con Argon2id.
 *     4. `POST /api/v1/auth/invitations/accept`: Acepta una invitacion formal de membresia en la organizacion.
 *
 * @resumen_contenido
 *   - Funcion `registerAuthEssentialRoutes()`: Conecta los cuatro endpoints en el `HttpRouterRegistry`.
 *
 * @dependencias_internas
 *   - `@shared/container/di-container`: Resolucion de pools y clientes.
 *   - `@shared/infrastructure/http/http-server.types`: Tipos del enrutador HTTP.
 *   - `@shared/kernel/result-and-errors`: Manejo uniforme de errores de validacion y autorizacion.
 *   - `@shared/kernel/crypto.util`: Generacion criptografica y hashing.
 *   - `../modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer`: Firma y verificacion EdDSA.
 *   - `../modules/01-identity-and-rbac/domain/identity.entities`: Roles, permisos y entidades.
 */

import * as crypto from 'node:crypto';
import type { DependencyContainer } from '@shared/container/di-container';
import { DI_TOKENS } from '@shared/container/di-container';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRequestLike,
  HttpRouteHandler,
  HttpRouterRegistry,
} from '@shared/infrastructure/http/http-server.types';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import {
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { PostgresIdentityRepository } from '../modules/01-identity-and-rbac/infrastructure/postgres-identity.repository';
import { PostgresAdvancedIdentityRepository } from '../modules/01-identity-and-rbac/infrastructure/postgres-advanced-identity.repository';
import { JwtEddsaSigner } from '../modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import {
  TotpMfaUseCase,
  MfaRecoveryAndBreakGlassUseCase,
} from '../modules/01-identity-and-rbac/application/mfa-and-webauthn.use-case';
import {
  RequestPasswordResetUseCase,
  ConfirmPasswordResetUseCase,
  ManageOrganizationInvitationsUseCase,
} from '../modules/01-identity-and-rbac/application/password-reset-and-invites.use-case';
import {
  ROLE_PERMISSIONS_MAP,
  type OrganizationEntity,
  type RbacRole,
} from '../modules/01-identity-and-rbac/domain/identity.entities';

/**
 * Adaptador utilitario para registrar manejadores HTTP tipados.
 */
function wrapHandler(
  fn: (req: HttpRequestLike, ctx: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return fn as unknown as HttpRouteHandler<never>;
}

/**
 * Registra en el enrutador HTTP las rutas esenciales de identidad (MFA, recuperacion e invitaciones).
 *
 * @param container - Contenedor de dependencias del sistema.
 * @param router - Enrutador HTTP del monolito modular.
 */
export function registerAuthEssentialRoutes(
  container: DependencyContainer,
  router: HttpRouterRegistry
): void {
  const rlsPool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redis = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;

  const identityRepo = new PostgresIdentityRepository(rlsPool, redis);
  const advancedRepo = new PostgresAdvancedIdentityRepository(rlsPool);

  const totpUseCase = new TotpMfaUseCase(identityRepo, advancedRepo);
  const recoveryUseCase = new MfaRecoveryAndBreakGlassUseCase(advancedRepo, identityRepo);
  const requestPwdResetUseCase = new RequestPasswordResetUseCase(identityRepo, advancedRepo);
  const confirmPwdResetUseCase = new ConfirmPasswordResetUseCase(identityRepo, advancedRepo);
  const invitationsUseCase = new ManageOrganizationInvitationsUseCase(identityRepo, advancedRepo);

  // ---------------------------------------------------------------------------
  // 1. POST /api/v1/auth/mfa/verify
  // Canjea el reto efimero de segundo factor (mfaChallengeToken) y emite tokens finales.
  // ---------------------------------------------------------------------------
  router.register({
    method: 'POST',
    path: '/api/v1/auth/mfa/verify',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const challengeToken = typeof b['mfaChallengeToken'] === 'string' ? b['mfaChallengeToken'].trim() : '';
      const code = typeof b['code'] === 'string' ? b['code'].trim() : '';
      const method = typeof b['method'] === 'string' ? b['method'].toUpperCase() : 'TOTP';

      if (!challengeToken) {
        throw new ValidationError('El token de reto MFA (mfaChallengeToken) es requerido.');
      }
      if (!code) {
        throw new ValidationError('El código de verificación es requerido.');
      }

      // Valida la firma EdDSA del token efimero y su proposito
      const claims = await JwtEddsaSigner.verifyEphemeralToken(challengeToken, 'MFA_CHALLENGE');

      const user = await identityRepo.findUserById(claims.userId);
      if (!user) {
        throw new UnauthorizedError('Usuario no encontrado o sesión expirada.');
      }

      const clientIp = req.clientIp || '127.0.0.1';

      if (method === 'RECOVERY_CODE') {
        await recoveryUseCase.consumeRecoveryCode(user.id, code, clientIp);
      } else {
        // Metodo TOTP
        let secretBase32 = '';
        if (user.mfaTotpSecretEnc) {
          secretBase32 = user.mfaTotpSecretEnc.toString('utf8');
        }

        if (!secretBase32) {
          throw new ValidationError('El usuario no posee un secreto TOTP activo.');
        }

        const isValid = totpUseCase.verifyTotpCode(secretBase32, code);
        if (!isValid) {
          throw new UnauthorizedError('El código TOTP es inválido o ha expirado.');
        }
      }

      // Resolver organizacion y rol activo
      let targetOrg: OrganizationEntity | null = null;
      let targetRole: RbacRole = 'VIEWER';

      if (claims.organizationId) {
        targetOrg = await identityRepo.findOrganizationById(claims.organizationId);
        const memberships = await identityRepo.findUserActiveMemberships(user.id);
        const match = memberships.find((m) => m.organizationId === claims.organizationId);
        if (match) {
          targetRole = match.role;
        }
      } else {
        const memberships = await identityRepo.findUserActiveMemberships(user.id);
        if (memberships.length > 0 && memberships[0]) {
          targetRole = memberships[0].role;
          targetOrg = await identityRepo.findOrganizationById(memberships[0].organizationId);
        }
      }

      if (user.isPlatformSuperadmin) {
        targetRole = 'SUPERADMIN';
      }

      const scopes = ROLE_PERMISSIONS_MAP[targetRole] ?? [];
      const orgId = targetOrg ? targetOrg.id : '';

      // Emite Access Token con mfaSatisfied = true
      const accessToken = await JwtEddsaSigner.signAccessToken({
        userId: user.id,
        organizationId: orgId,
        role: targetRole,
        scopes,
        tokenVersion: user.tokenVersion,
        mfaSatisfied: true,
      });

      // Emite Refresh Token rotativo
      const rawRefreshToken = CryptoUtils.generateCsprngToken(32);
      const refreshTokenSha256 = CryptoUtils.sha256Hex(rawRefreshToken);
      const tokenFamilyId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await identityRepo.createAuthSession({
        userId: user.id,
        organizationId: orgId.length > 0 ? orgId : null,
        tokenFamilyId,
        refreshTokenSha256,
        tokenVersionSnapshot: user.tokenVersion,
        ipAddress: clientIp,
        userAgent: (typeof req.headers['user-agent'] === 'string' && req.headers['user-agent']) ? req.headers['user-agent'] : 'unknown',
        expiresAt,
      });

      return {
        status: 200,
        body: {
          status: 'AUTHENTICATED',
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            isPlatformSuperadmin: user.isPlatformSuperadmin,
          },
          organization: targetOrg
            ? {
                id: targetOrg.id,
                name: targetOrg.name,
                slug: targetOrg.slug,
                status: targetOrg.status,
              }
            : null,
          role: targetRole,
          accessToken,
          refreshToken: rawRefreshToken,
        },
      };
    }),
  });

  // ---------------------------------------------------------------------------
  // 2. POST /api/v1/auth/password-reset/request
  // Solicita restablecimiento de contrasena. NUNCA devuelve el token en la respuesta (C1-41).
  // ---------------------------------------------------------------------------
  router.register({
    method: 'POST',
    path: '/api/v1/auth/password-reset/request',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof b['email'] === 'string' ? b['email'].trim() : '';

      if (!email) {
        throw new ValidationError('El correo electrónico es requerido.');
      }

      const clientIp = req.clientIp || '127.0.0.1';
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

      // El caso de uso aplica el piso temporal anti-enumeracion de 350ms
      await requestPwdResetUseCase.execute(email, clientIp, userAgent);

      // C1-41: El token se omite de forma estricta de la respuesta HTTP
      return {
        status: 200,
        body: {
          ok: true,
          message: 'Si el correo electrónico existe en nuestra plataforma, se enviarán las instrucciones para restablecer la contraseña.',
        },
      };
    }),
  });

  // ---------------------------------------------------------------------------
  // 3. POST /api/v1/auth/password-reset/confirm
  // Confirma el restablecimiento de contrasena actualizando el hash Argon2id y revocando sesiones.
  // ---------------------------------------------------------------------------
  router.register({
    method: 'POST',
    path: '/api/v1/auth/password-reset/confirm',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike): Promise<HttpHandlerResult> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const token = typeof b['token'] === 'string' ? b['token'].trim() : '';
      const newPassword = typeof b['newPassword'] === 'string' ? b['newPassword'] : '';

      if (!token) {
        throw new ValidationError('El token de restablecimiento es requerido.');
      }
      if (!newPassword || newPassword.length < 8) {
        throw new ValidationError('La nueva contraseña debe tener al menos 8 caracteres.');
      }

      await confirmPwdResetUseCase.execute(token, newPassword);

      return {
        status: 200,
        body: {
          ok: true,
          message: 'Contraseña actualizada exitosamente. Inicie sesión con sus nuevas credenciales.',
        },
      };
    }),
  });

  // ---------------------------------------------------------------------------
  // 4. POST /api/v1/auth/invitations/accept
  // Acepta una invitacion a una organizacion B2B.
  // ---------------------------------------------------------------------------
  router.register({
    method: 'POST',
    path: '/api/v1/auth/invitations/accept',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: '01-identity-and-rbac',
    requiresRawBody: false,
    handler: wrapHandler(async (req: HttpRequestLike, ctx: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const token = typeof b['token'] === 'string' ? b['token'].trim() : '';
      const userId = ctx.principal?.userId ?? (typeof b['userId'] === 'string' ? b['userId'].trim() : '');

      if (!token) {
        throw new ValidationError('El token de invitación es requerido.');
      }
      if (!userId) {
        throw new ValidationError('Se requiere una sesión activa o el identificador de usuario para aceptar la invitación.');
      }

      const result = await invitationsUseCase.acceptInvitation(token, userId);

      return {
        status: 200,
        body: {
          ok: true,
          organizationId: result.organizationId,
          role: result.role,
          message: 'Invitación aceptada exitosamente.',
        },
      };
    }),
  });
}
