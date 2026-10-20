/**
 * @archivo src/modules/01-identity-and-rbac/application/authenticate-user.use-case.ts
 * @modulo 01-identity-and-rbac (Autenticacion B2B, Consentimiento Legal Pre-Sesion y MFA)
 * @proposito
 *   Autentica credenciales con ejecucion de tiempo constante (piso de 350 ms anti-enumeracion),
 *   controla el bloqueo temporal por fuerza bruta, resuelve el inquilino activo y exige el
 *   consentimiento legal vigente mediante un reto efimero pre-sesion: si faltan instrumentos,
 *   devuelve `LEGAL_CONSENT_REQUIRED` con un token de renovacion en lugar de un 403 sin salida.
 *   Resuelve el segundo factor MFA y emite Access Token EdDSA + Refresh Token rotativo.
 *
 * @resumen_contenido
 *   - Tipos `AuthenticateUserInput`, `AuthenticateSuccessOutput`, `AuthenticateMfaRequiredOutput`,
 *     `AuthenticateLegalConsentRequiredOutput` y `AuthenticateOutput`.
 *   - Clase `AuthenticateUserUseCase`: login con tiempo constante, bloqueo, consentimiento legal,
 *     MFA y emision de tokens; auditoria best-effort de fallos y fail-closed del exito.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ForbiddenError`, `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *   - `JwtEddsaSigner` (../infrastructure/jwt-eddsa.signer.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - Entidades y matriz RBAC (../domain/identity.entities.ts).
 *
 * @dependencias_externas
 *   - `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users`, `organizations`, `memberships`, `auth_sessions`,
 *     `legal_documents`, `user_legal_acceptances`.
 *   - Redis: `auth:user_tv:<user_id>`.
 */

import * as crypto from 'node:crypto';
import { ForbiddenError, UnauthorizedError } from '@shared/kernel/result-and-errors';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { getEnvConfig } from '@config/env.schema';
import {
  assertCanAttemptLogin,
  type OrganizationEntity,
  type PendingMandatoryLegalDocument,
  type RbacRole,
  ROLE_PERMISSIONS_MAP,
  type UserEntity,
} from '../domain/identity.entities';
import { JwtEddsaSigner } from '../infrastructure/jwt-eddsa.signer';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { IdentityAuditLogger, IdentityAuthAuditEvent } from '../infrastructure/identity-audit.logger';

/** Vigencia del token efimero que habilita la renovacion legal antes de emitir sesion. */
const LEGAL_CONSENT_CHALLENGE_TTL_SECONDS = 600;

/** Parametros de entrada para autenticar a un usuario. */
export interface AuthenticateUserInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly organizationSlug?: string | null;
}

/** Resultado exitoso de autenticacion completa. */
export interface AuthenticateSuccessOutput {
  readonly status: 'AUTHENTICATED';
  readonly user: UserEntity;
  readonly organization: OrganizationEntity;
  readonly role: RbacRole;
  readonly accessToken: string;
  readonly rawRefreshToken: string;
}

/** Resultado cuando se requiere resolver un segundo factor (MFA). */
export interface AuthenticateMfaRequiredOutput {
  readonly status: 'MFA_REQUIRED';
  readonly userId: string;
  readonly mfaChallengeToken: string;
  readonly availableFactors: readonly ('TOTP' | 'WEBAUTHN')[];
}

/** Resultado cuando el usuario debe renovar el consentimiento legal antes de emitir sesion. */
export interface AuthenticateLegalConsentRequiredOutput {
  readonly status: 'LEGAL_CONSENT_REQUIRED';
  readonly userId: string;
  readonly consentChallengeToken: string;
  readonly pendingDocuments: readonly PendingMandatoryLegalDocument[];
  readonly expiresInSeconds: number;
}

export type AuthenticateOutput = AuthenticateSuccessOutput | AuthenticateMfaRequiredOutput | AuthenticateLegalConsentRequiredOutput;

/**
 * Caso de uso: Autentica credenciales con ejecucion en tiempo constante (350ms anti-enumeracion).
 *
 * Cuando faltan instrumentos legales obligatorios devuelve un reto efimero pre-sesion
 * (`LEGAL_CONSENT_REQUIRED`) en lugar de un 403 sin salida: el usuario renueva desde el login
 * y reintenta. Emite auditoria C1-38 en `audit_logs`: `LOGIN_FAILED` y `ACCOUNT_LOCKED` son
 * best-effort (jamas ocultan el error principal); `LOGIN_SUCCEEDED` es fail-closed.
 */
export class AuthenticateUserUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Registra un evento de observacion sin ocultar jamas el error principal.
   *
   * @param event - Evento forense de observacion (fallo o bloqueo).
   */
  private async auditBestEffort(event: IdentityAuthAuditEvent): Promise<void> {
    try {
      await this.auditLogger?.recordAuthEvent(event);
    } catch {
      // Best-effort deliberado: un fallo de auditoria no oculta el error de autenticacion.
    }
  }

  /**
   * Ejecuta la verificacion de credenciales y resuelve la sesion del usuario.
   *
   * @param input - Credenciales y metadatos de conexion.
   * @returns Sesion autenticada o reto MFA requerido.
   */
  public async execute(input: AuthenticateUserInput): Promise<AuthenticateOutput> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // 1. Busqueda del usuario por correo
    const user = await this.identityRepo.findUserByEmail(normalizedEmail);

    // 2. Verificacion en tiempo constante con el piso del contrato (falla cerrado si falta o esta fuera de rango).
    const timingFloorMs = getEnvConfig().ARGON2_TIMING_FLOOR_MS;
    if (!Number.isInteger(timingFloorMs) || timingFloorMs < 0 || timingFloorMs > 5000) throw new Error('CONFIGURACION_ENTORNO_INVALIDA: ARGON2_TIMING_FLOOR_MS ausente o fuera de rango (0-5000).');
    const verification = await CryptoUtils.verifyPasswordConstantTime(
      user ? user.passwordHash : null,
      input.password,
      timingFloorMs
    );

    // 3. Comprobacion de bloqueo previo por fuerza bruta
    if (user) {
      try {
        assertCanAttemptLogin(user);
      } catch (lockedError) {
        await this.auditBestEffort({
          organizationId: null,
          actorUserId: user.id,
          actorRole: null,
          eventCategory: 'AUTHENTICATION',
          eventAction: 'ACCOUNT_LOCKED',
          severity: 'WARN',
          targetResourceType: 'USER',
          targetResourceId: user.id,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          details: { reason: 'ATTEMPT_WHILE_LOCKED', lockedUntil: user.lockedUntil?.toISOString() ?? null },
        });
        throw lockedError;
      }
    }

    // 4. Si la contrasena no coincide o el usuario no existe
    if (!verification.matches || !user) {
      if (user) {
        const outcome = await this.identityRepo.recordFailedLoginAttempt(user.id, user.failedLoginAttempts);
        if (outcome.lockedUntil !== null) {
          await this.auditBestEffort({
            organizationId: null,
            actorUserId: user.id,
            actorRole: null,
            eventCategory: 'AUTHENTICATION',
            eventAction: 'ACCOUNT_LOCKED',
            severity: 'CRITICAL_SECURITY',
            targetResourceType: 'USER',
            targetResourceId: user.id,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            details: { reason: 'BRUTE_FORCE_THRESHOLD', failedAttempts: outcome.attempts },
          });
        } else {
          await this.auditBestEffort({
            organizationId: null,
            actorUserId: user.id,
            actorRole: null,
            eventCategory: 'AUTHENTICATION',
            eventAction: 'LOGIN_FAILED',
            severity: 'WARN',
            targetResourceType: 'USER',
            targetResourceId: user.id,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            details: { reason: 'INVALID_CREDENTIALS', failedAttempts: outcome.attempts },
          });
        }
      } else {
        await this.auditBestEffort({
          organizationId: null,
          actorUserId: null,
          actorRole: null,
          eventCategory: 'AUTHENTICATION',
          eventAction: 'LOGIN_FAILED',
          severity: 'WARN',
          targetResourceType: 'USER',
          targetResourceId: null,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          details: { reason: 'UNKNOWN_EMAIL', attemptedEmail: normalizedEmail },
        });
      }
      throw new UnauthorizedError('Credenciales incorrectas o cuenta no autorizada.');
    }

    // 5. Restablecimiento de contador de intentos fallidos tras login valido
    await this.identityRepo.resetFailedLoginAttempts(user.id, input.ipAddress);

    // 6. Resolucion del inquilino u organizacion activa
    let targetOrg: OrganizationEntity | null = null;
    let targetRole: RbacRole = 'DEVELOPER';

    if (input.organizationSlug) {
      targetOrg = await this.identityRepo.findOrganizationBySlug(input.organizationSlug);
      if (!targetOrg) {
        throw new UnauthorizedError('La organizacion solicitada no existe.');
      }
      const membership = await this.identityRepo.findMembership(targetOrg.id, user.id);
      if (!membership && !user.isPlatformSuperadmin) {
        throw new ForbiddenError('El usuario no pertenece a la organizacion solicitada.');
      }
      targetRole = user.isPlatformSuperadmin ? 'SUPERADMIN' : (membership?.role ?? 'VIEWER');
    } else {
      const memberships = await this.identityRepo.findUserActiveMemberships(user.id);
      if (memberships.length > 0 && memberships[0]) {
        const primary = memberships[0];
        targetOrg = await this.identityRepo.findOrganizationById(primary.organizationId);
        targetRole = user.isPlatformSuperadmin ? 'SUPERADMIN' : primary.role;
      } else if (user.isPlatformSuperadmin) {
        targetRole = 'SUPERADMIN';
      } else {
        throw new ForbiddenError('El usuario no cuenta con membresias activas en ninguna organizacion.');
      }
    }

    // 7. Verificacion de obligatoriedad de SSO federado
    if (targetOrg && targetOrg.enforceSso && !user.isPlatformSuperadmin) {
      throw new ForbiddenError('Esta organizacion exige iniciar sesion mediante inicio de sesion unico (SSO corporativo).');
    }

    // 8. Consentimiento legal: si faltan instrumentos obligatorios se emite un reto efimero
    //    pre-sesion en lugar de un 403 sin salida; el usuario renueva desde el login y reintenta.
    const pendingLegalDocs = await this.identityRepo.findPendingMandatoryLegalDocs(
      user.id,
      targetOrg ? targetOrg.id : null
    );
    if (pendingLegalDocs.length > 0) {
      const consentChallengeToken = await JwtEddsaSigner.signEphemeralToken(
        { userId: user.id, organizationId: targetOrg ? targetOrg.id : null, purpose: 'LEGAL_CONSENT_CHALLENGE' },
        LEGAL_CONSENT_CHALLENGE_TTL_SECONDS
      );
      return {
        status: 'LEGAL_CONSENT_REQUIRED',
        userId: user.id,
        consentChallengeToken,
        pendingDocuments: pendingLegalDocs,
        expiresInSeconds: LEGAL_CONSENT_CHALLENGE_TTL_SECONDS,
      };
    }

    // 9. Comprobacion de requerimiento de segundo factor (MFA)
    //
    // El SuperAdmin NO esta exento. Antes lo estaba —`mfaRequired && !user.isPlatformSuperadmin`— con
    // el razonamiento de que su cuenta se protege por otras vias, y el resultado medido por la auditoria
    // fue justo el contrario del pretendido: **la cuenta de gobierno de toda la plataforma quedaba
    // protegida por una sola credencial**, de modo que quien obtuviera su contrasena alcanzaba a la vez
    // el rol de gobierno y la marca de segundo factor satisfecho. Es exactamente la cuenta que mas
    // merece el segundo factor, no la que menos.
    const mfaRequired = user.mfaTotpEnabled || user.mfaWebauthnEnabled || (targetOrg ? targetOrg.enforceMfa : false);
    if (mfaRequired) {
      const availableFactors: ('TOTP' | 'WEBAUTHN')[] = [];
      if (user.mfaTotpEnabled) {
        availableFactors.push('TOTP');
      }
      if (user.mfaWebauthnEnabled) {
        availableFactors.push('WEBAUTHN');
      }

      const mfaChallengeToken = await JwtEddsaSigner.signEphemeralToken(
        {
          userId: user.id,
          organizationId: targetOrg ? targetOrg.id : null,
          purpose: 'MFA_CHALLENGE',
        },
        300
      );

      return {
        status: 'MFA_REQUIRED',
        userId: user.id,
        mfaChallengeToken,
        availableFactors,
      };
    }

    // 10. Emision de Access Token y Refresh Token rotativo
    const scopes = ROLE_PERMISSIONS_MAP[targetRole];
    const organizationId = targetOrg ? targetOrg.id : '';

    const accessToken = await JwtEddsaSigner.signAccessToken({
      userId: user.id,
      organizationId,
      role: targetRole,
      scopes,
      tokenVersion: user.tokenVersion,
      mfaSatisfied: false,
    });

    const rawRefreshToken = CryptoUtils.generateCsprngToken(32);
    const refreshTokenSha256 = CryptoUtils.sha256Hex(rawRefreshToken);
    const tokenFamilyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.identityRepo.createAuthSession({
      userId: user.id,
      organizationId: organizationId.length > 0 ? organizationId : null,
      tokenFamilyId,
      refreshTokenSha256,
      tokenVersionSnapshot: user.tokenVersion,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
    });

    return {
      status: 'AUTHENTICATED',
      user,
      organization: targetOrg ?? {
        id: '', name: 'Plataforma', slug: 'platform', status: 'ACTIVE',
        enforceMfa: false, enforceSso: false, optInSessionTranscripts: false,
        createdAt: new Date(), updatedAt: new Date(),
      },
      role: targetRole,
      accessToken,
      rawRefreshToken,
    };
  }
}
