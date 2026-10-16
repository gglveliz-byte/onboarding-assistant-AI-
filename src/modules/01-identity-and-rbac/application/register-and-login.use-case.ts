/**
 * @archivo src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts
 * @modulo 01-identity-and-rbac (Registro Multi-Tenant y Login con Tiempo Constante)
 * @proposito
 *   Orquesta el registro inicial de inquilinos B2B (creando usuario OWNER, organizacion,
 *   suscripcion inicial en whop_subscriptions y proyecto por defecto en una transaccion
 *   atomica) y la autenticacion de usuarios con ejecucion de tiempo constante
 *   (piso de 350ms anti-enumeracion), bloqueo temporal por fuerza bruta y emision
 *   de tokens JWT EdDSA (15m) + Refresh Token rotativo.
 *
 * @resumen_contenido
 *   - Interfaces de entrada/salida para registro y autenticacion.
 *   - Clase `RegisterOrganizationOwnerUseCase`:
 *       * Valida unicidad de correo y slug de organizacion.
 *       * Hashea contrasena con Argon2id OWASP.
 *       * Inicializa inquilino, membresia OWNER, suscripcion y proyecto base.
 *   - Clase `AuthenticateUserUseCase`:
 *       * Descubre inquilino o valida slug provisto.
 *       * Ejecuta verificacion en 350ms exactos (`CryptoUtils.verifyPasswordConstantTime`).
 *       * Controla umbral de 5 intentos fallidos con bloqueo de 15 minutos.
 *       * Verifica cumplimiento legal (`LegalConsentOutdatedError` si falta).
 *       * Retorna reto MFA (202 Accepted) o emite par de tokens JWT EdDSA / Refresh.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts).
 *   - `ConflictError`, `ForbiddenError`, `LegalConsentOutdatedError`, `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *   - `JwtEddsaSigner` (../infrastructure/jwt-eddsa.signer.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `ROLE_PERMISSIONS_MAP`, `assertCanAttemptLogin` (../domain/identity.entities.ts).
 *
 * @dependencias_externas
 *   - `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users`, `organizations`, `memberships`, `auth_sessions`, `whop_subscriptions`, `projects`.
 *   - Redis: `auth:user_tv:<user_id>`.
 */

import * as crypto from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  LegalConsentOutdatedError,
  UnauthorizedError,
} from '@shared/kernel/result-and-errors';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { getEnvConfig } from '@config/env.schema';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import {
  assertCanAttemptLogin,
  type OrganizationEntity,
  type RbacRole,
  ROLE_PERMISSIONS_MAP,
  type UserEntity,
} from '../domain/identity.entities';
import { JwtEddsaSigner } from '../infrastructure/jwt-eddsa.signer';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { IdentityAuditLogger, IdentityAuthAuditEvent } from '../infrastructure/identity-audit.logger';

/** Parametros para el registro de una nueva organizacion y su propietario. */
export interface RegisterOwnerInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly ipAddress: string;
  readonly userAgent: string;
}

/** Resultado del registro inicial de organizacion y propietario. */
export interface RegisterOwnerOutput {
  readonly user: UserEntity;
  readonly organization: OrganizationEntity;
  readonly accessToken: string;
  readonly rawRefreshToken: string;
  readonly emailVerificationOtp: string;
}

/**
 * Caso de uso: Registra una nueva organizacion y a su usuario creador con rol OWNER.
 */
export class RegisterOrganizationOwnerUseCase {
  public constructor(
    private readonly rlsPool: RlsDatabasePool,
    private readonly identityRepo: PostgresIdentityRepository
  ) {}

  /**
   * Ejecuta el registro completo en una transaccion aislada.
   *
   * @param input - Datos de registro del propietario y de la organizacion.
   * @returns Entidades creadas, tokens emitidos y OTP de verificacion.
   */
  public async execute(input: RegisterOwnerInput): Promise<RegisterOwnerOutput> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const normalizedSlug = input.organizationSlug.trim().toLowerCase();

    // 1. Validaciones previas de unicidad
    const existingUser = await this.identityRepo.findUserByEmail(normalizedEmail);
    if (existingUser) {
      throw new ConflictError('El correo electronico ya se encuentra registrado en la plataforma.');
    }

    const existingOrg = await this.identityRepo.findOrganizationBySlug(normalizedSlug);
    if (existingOrg) {
      throw new ConflictError('El identificador unico (slug) de la organizacion ya esta en uso.');
    }

    // 2. Hasheo seguro de contrasena con Argon2id
    const passwordHash = await CryptoUtils.hashPasswordArgon2id(input.password);

    // 3. Generacion de OTP de 6 digitos para verificacion de correo
    const emailVerificationOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpSha256 = CryptoUtils.sha256Hex(emailVerificationOtp);
    const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

    // 4. Ejecucion transaccional para crear usuario, organizacion, membresia, suscripcion y proyecto base
    const { user, org } = await this.rlsPool.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        // Insercion de usuario
        const createdUser = await this.identityRepo.createUser(
          {
            email: normalizedEmail,
            fullName: input.fullName.trim(),
            passwordHash,
            tokenVersion: 1,
            isPlatformSuperadmin: false,
            otpSha256,
            otpExpiresAt,
          },
          client
        );

        // Insercion de organizacion
        const createdOrg = await this.identityRepo.createOrganization(
          {
            name: input.organizationName.trim(),
            slug: normalizedSlug,
            enforceMfa: false,
            enforceSso: false,
            dpaSignedAt: new Date(),
            dpaClickwrapIp: input.ipAddress,
          },
          client
        );

        // Insercion de membresia OWNER
        await this.identityRepo.createMembership(
          {
            organizationId: createdOrg.id,
            userId: createdUser.id,
            role: 'OWNER',
            isActive: true,
          },
          client
        );

        // Insercion de suscripcion base en whop_subscriptions
        await client.query(
          `INSERT INTO whop_subscriptions (
            organization_id, plan_code, status, current_period_start, current_period_end,
            period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used,
            current_period_overage_billed_usd, credit_balance_usd, auto_topup_enabled
          ) VALUES ($1, 'PAYG', 'ACTIVE', NOW(), NOW() + INTERVAL '30 days', '0.000000', '0.000000', '0.000000', '0.000000', '0.000000', TRUE)`,
          [createdOrg.id]
        );

        // Insercion de proyecto por defecto
        await client.query(
          `INSERT INTO projects (
            organization_id, name, slug, description, environment, status
          ) VALUES ($1, 'General', 'general', 'Proyecto principal de onboarding y asistentes', 'LIVE', 'ACTIVE')`,
          [createdOrg.id]
        );

        await client.query('COMMIT');
        return { user: createdUser, org: createdOrg };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });

    // 5. Emision de Access Token y Refresh Token rotativo
    const scopes = ROLE_PERMISSIONS_MAP['OWNER'];
    const accessToken = await JwtEddsaSigner.signAccessToken({
      userId: user.id,
      organizationId: org.id,
      role: 'OWNER',
      scopes,
      tokenVersion: user.tokenVersion,
      mfaSatisfied: false,
    });

    const rawRefreshToken = CryptoUtils.generateCsprngToken(32);
    const refreshTokenSha256 = CryptoUtils.sha256Hex(rawRefreshToken);
    const tokenFamilyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

    await this.identityRepo.createAuthSession({
      userId: user.id,
      organizationId: org.id,
      tokenFamilyId,
      refreshTokenSha256,
      tokenVersionSnapshot: user.tokenVersion,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
    });

    return {
      user,
      organization: org,
      accessToken,
      rawRefreshToken,
      emailVerificationOtp,
    };
  }
}

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

export type AuthenticateOutput = AuthenticateSuccessOutput | AuthenticateMfaRequiredOutput;

/**
 * Caso de uso: Autentica credenciales con ejecucion en tiempo constante (350ms anti-enumeracion).
 *
 * Emite auditoria C1-38 en `audit_logs`: `LOGIN_FAILED` y `ACCOUNT_LOCKED` son best-effort
 * (jamas ocultan el error principal); `LOGIN_SUCCEEDED` es fail-closed (si la auditoria
 * critica se pierde, la operacion no se confirma como exitosa).
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
        targetRole = primary.role;
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

    // 8. Verificacion de aceptacion legal de documentos obligatorios
    const legalAccepted = await this.identityRepo.hasAcceptedMandatoryLegalDocs(user.id, targetOrg ? targetOrg.id : null);
    if (!legalAccepted) {
      throw new LegalConsentOutdatedError(['TOS_B2B', 'PRIVACY_POLICY']);
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
        id: '',
        name: 'Plataforma',
        slug: 'platform',
        status: 'ACTIVE',
        enforceMfa: false,
        enforceSso: false,
        optInSessionTranscripts: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      role: targetRole,
      accessToken,
      rawRefreshToken,
    };
  }
}
