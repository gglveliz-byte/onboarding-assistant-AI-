/**
 * @archivo src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts
 * @modulo 01-identity-and-rbac (Registro Multi-Tenant de Organizacion y Owner)
 * @proposito
 *   Orquesta el registro inicial de inquilinos B2B: crea usuario OWNER, organizacion,
 *   suscripcion inicial en whop_subscriptions y proyecto por defecto en una transaccion
 *   atomica, y emite Access Token EdDSA + Refresh Token rotativo. El identificador unico de la
 *   organizacion lo genera el sistema (slug derivado del nombre con sufijo automatico si ya esta
 *   ocupado), de modo que registrar nunca se rechaza por un identificador en uso. La autenticacion
 *   B2B (login, consentimiento legal pre-sesion y MFA) vive en `authenticate-user.use-case.ts`.
 *
 * @resumen_contenido
 *   - Interfaces de entrada/salida del registro.
 *   - Clase `RegisterOrganizationOwnerUseCase`:
 *       * Valida unicidad de correo y slug de organizacion.
 *       * Hashea contrasena con Argon2id OWASP.
 *       * Inicializa inquilino, membresia OWNER, suscripcion y proyecto base.
 *       * Valida y graba las aceptaciones legales obligatorias en la misma transaccion.
 *       * Genera dinamicamente el identificador unico de la organizacion a partir del nombre
 *         (con sufijo aleatorio si ya esta ocupado) para que el alta nunca falle por eso.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts).
 *   - `ConflictError`, `ValidationError` (src/shared/kernel/result-and-errors.ts).
 *   - `JwtEddsaSigner` (../infrastructure/jwt-eddsa.signer.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `PostgresAdvancedIdentityRepository` (../infrastructure/postgres-advanced-identity.repository.ts).
 *   - `ROLE_PERMISSIONS_MAP` (../domain/identity.entities.ts).
 *
 * @dependencias_externas
 *   - `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users`, `organizations`, `memberships`, `auth_sessions`, `whop_subscriptions`, `projects`, `legal_documents`, `user_legal_acceptances`.
 *   - Redis: `auth:user_tv:<user_id>`.
 */

import * as crypto from 'node:crypto';
import { ConflictError, ValidationError } from '@shared/kernel/result-and-errors';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import {
  type OrganizationEntity,
  ROLE_PERMISSIONS_MAP,
  type UserEntity,
} from '../domain/identity.entities';
import { JwtEddsaSigner } from '../infrastructure/jwt-eddsa.signer';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { PostgresAdvancedIdentityRepository } from '../infrastructure/postgres-advanced-identity.repository';

/**
 * Detecta la violacion de unicidad de PostgreSQL (`23505`).
 *
 * @param error - Error capturado de la base de datos.
 * @returns `true` cuando la escritura violo una restriccion `UNIQUE`.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Parametros para el registro de una nueva organizacion y su propietario. */
export interface RegisterOwnerInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly phone?: string;
  /**
   * Codigos de los instrumentos legales aceptados por el owner en el alta.
   * Es obligatorio declararlos: el servidor falla cerrado si no se envian, en lugar
   * de asumir un consentimiento que el usuario no otorgo explicitamente.
   */
  readonly acceptedLegalDocumentCodes?: readonly string[];
}

/** Resultado del registro inicial de organizacion y propietario. */
export interface RegisterOwnerOutput {
  readonly user: UserEntity;
  readonly organization: OrganizationEntity;
  readonly accessToken: string;
  readonly rawRefreshToken: string;
  readonly emailVerificationOtp: string;
  readonly acceptedLegalDocumentCodes: readonly string[];
}

/**
 * Caso de uso: Registra una nueva organizacion y a su usuario creador con rol OWNER.
 */
export class RegisterOrganizationOwnerUseCase {
  public constructor(
    private readonly rlsPool: RlsDatabasePool,
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly advancedRepo: PostgresAdvancedIdentityRepository
  ) {}

  /**
   * Normaliza un texto en un identificador de organizacion valido para la base de datos.
   *
   * @param raw - Nombre o identificador deseado por el cliente.
   * @returns Slug en minusculas separado por guiones, o cadena vacia si no hay caracteres utilizables.
   */
  private static slugify(raw: string): string {
    return raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  /**
   * Genera un sufijo aleatorio para desambiguar un identificador ya ocupado.
   *
   * @returns Sufijo hexadecimal de 8 caracteres producido con CSPRNG.
   */
  private static randomSlugSuffix(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  /**
   * Ejecuta el registro completo en una transaccion aislada.
   *
   * @param input - Datos de registro del propietario y de la organizacion.
   * @returns Entidades creadas, tokens emitidos y OTP de verificacion.
   */
  public async execute(input: RegisterOwnerInput): Promise<RegisterOwnerOutput> {
    const normalizedEmail = input.email.trim().toLowerCase();
    // El identificador unico lo genera el sistema a partir del nombre de la organizacion.
    // El valor enviado por el cliente es solo una preferencia: si ya esta ocupado, el sistema
    // anade un sufijo aleatorio en lugar de rechazar el alta.
    const preferredSlug =
      RegisterOrganizationOwnerUseCase.slugify(input.organizationSlug) ||
      RegisterOrganizationOwnerUseCase.slugify(input.organizationName);
    const baseSlug =
      preferredSlug.length > 0
        ? preferredSlug
        : `org-${RegisterOrganizationOwnerUseCase.randomSlugSuffix()}`;

    // 1. Validacion previa de unicidad del correo (el identificador de la organizacion se resuelve dentro de la transaccion)
    const existingUser = await this.identityRepo.findUserByEmail(normalizedEmail);
    if (existingUser) {
      throw new ConflictError('El correo electronico ya se encuentra registrado en la plataforma.');
    }

    // 2. Hasheo seguro de contrasena con Argon2id
    const passwordHash = await CryptoUtils.hashPasswordArgon2id(input.password);

    // 3. Generacion de OTP de 6 digitos para verificacion de correo
    const emailVerificationOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpSha256 = CryptoUtils.sha256Hex(emailVerificationOtp);
    const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

    // 4. Ejecucion transaccional para crear usuario, organizacion, membresia, suscripcion y proyecto base
    const { user, org, acceptedLegalDocumentCodes } = await this.rlsPool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.is_superadmin', 'true', true)");
      try {
        const mandatoryDocs = await this.advancedRepo.findActiveMandatoryLegalDocuments(client);
        if (mandatoryDocs.length === 0) {
          throw new Error('No hay documentos legales obligatorios activos; el alta no puede certificar el consentimiento.');
        }

        const mandatoryCodes = mandatoryDocs.map((doc) => doc.docType);
        const requestedCodes = input.acceptedLegalDocumentCodes;
        if (requestedCodes === undefined) {
          throw new ValidationError(
            'El alta debe declarar los documentos legales aceptados; no se puede asumir un consentimiento tacito.',
            ['acceptedLegalDocumentCodes']
          );
        }
        const acceptedCodes = Array.from(
          new Set(requestedCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))
        );

        const unknownCodes = acceptedCodes.filter((code) => !mandatoryCodes.includes(code));
        if (unknownCodes.length > 0) {
          throw new ValidationError(`Codigos legales desconocidos: ${unknownCodes.join(', ')}.`, ['acceptedLegalDocumentCodes']);
        }

        const missingCodes = mandatoryCodes.filter((code) => !acceptedCodes.includes(code));
        if (missingCodes.length > 0) {
          throw new ValidationError(`Faltan aceptaciones legales obligatorias: ${missingCodes.join(', ')}.`, ['acceptedLegalDocumentCodes']);
        }

        const phone = input.phone?.trim() || null;
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
            phoneNumber: phone,
          },
          client
        );

        // Resolucion dinamica del identificador unico de la organizacion, dentro de la misma
        // transaccion: si el identificador derivado del nombre ya esta ocupado, se anade un
        // sufijo aleatorio y se reintenta. El alta nunca se rechaza por un identificador ocupado.
        const created: { org: OrganizationEntity | null } = { org: null };
        let candidateSlug = baseSlug;
        for (let attempt = 0; attempt < 6 && created.org === null; attempt += 1) {
          const occupied = await client.query('SELECT 1 FROM organizations WHERE slug = $1 LIMIT 1', [
            candidateSlug,
          ]);
          if (occupied.rows.length > 0) {
            candidateSlug = `${baseSlug}-${RegisterOrganizationOwnerUseCase.randomSlugSuffix()}`;
            continue;
          }
          // El savepoint permite reintentar ante una colision de unicidad sin abortar la transaccion.
          await client.query('SAVEPOINT organization_slug');
          try {
            created.org = await this.identityRepo.createOrganization(
              {
                name: input.organizationName.trim(),
                slug: candidateSlug,
                enforceMfa: false,
                enforceSso: false,
                dpaSignedAt: new Date(),
                dpaClickwrapIp: input.ipAddress,
                phoneNumber: phone,
              },
              client
            );
            await client.query('RELEASE SAVEPOINT organization_slug');
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT organization_slug');
            if (!isUniqueViolation(error)) throw error;
            candidateSlug = `${baseSlug}-${RegisterOrganizationOwnerUseCase.randomSlugSuffix()}`;
          }
        }
        if (created.org === null) {
          throw new ConflictError(
            'No fue posible reservar un identificador unico para la organizacion; reintenta el alta.'
          );
        }
        const createdOrg = created.org;

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
          `INSERT INTO whop_subscriptions (organization_id, plan_code, status, current_period_start, current_period_end, period_included_minutes_quota, period_included_minutes_remaining, period_overage_minutes_used, current_period_overage_billed_usd, credit_balance_usd, auto_topup_enabled) VALUES ($1, 'PAYG', 'ACTIVE', NOW(), NOW() + INTERVAL '30 days', '0.000000', '0.000000', '0.000000', '0.000000', '0.000000', TRUE)`,
          [createdOrg.id]
        );

        // Insercion de proyecto por defecto
        await client.query(
          `INSERT INTO projects (organization_id, name, slug, environment, is_active, created_by_user_id) VALUES ($1, 'General', 'general', 'LIVE', TRUE, $2)`,
          [createdOrg.id, createdUser.id]
        );

        // Evidencia legal atomica: cada aceptacion se graba dentro de esta misma transaccion.
        // Si una insercion falla, el ROLLBACK deshace tambien usuario y organizacion, de modo que
        // nunca existe una cuenta sin el expediente legal que la autoriza.
        for (const doc of mandatoryDocs) {
          await this.advancedRepo.recordLegalAcceptance(
            {
              userId: createdUser.id,
              organizationId: createdOrg.id,
              legalDocumentId: doc.id,
              documentSha256Snapshot: doc.contentSha256,
              ipAddress: input.ipAddress,
              userAgent: input.userAgent,
            },
            client
          );
        }

        await client.query('COMMIT');
        return { user: createdUser, org: createdOrg, acceptedLegalDocumentCodes: acceptedCodes };
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
      acceptedLegalDocumentCodes,
    };
  }
}
