/**
 * @archivo src/modules/01-identity-and-rbac/application/password-reset-and-invites.use-case.ts
 * @modulo 01-identity-and-rbac (Casos de Uso de Restablecimiento de Contrasena e Invitaciones)
 * @proposito
 *   Implementa el flujo seguro de recuperacion de contrasena con mitigacion estricta contra
 *   enumeracion de usuarios (piso temporal constante de 350ms y tokens efimeros SHA-256 de 15m),
 *   y la gestion de invitaciones multi-tenant para miembros con roles RBAC dentro de la organizacion.
 *
 * @resumen_contenido
 *   - Clase `RequestPasswordResetUseCase`: Emite token de reinicio con piso temporal de 350ms.
 *   - Clase `ConfirmPasswordResetUseCase`: Valida token, actualiza hash Argon2id y revoca sesiones.
 *   - Clase `ManageOrganizationInvitationsUseCase`: Emision y aceptacion de invitaciones RBAC.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ValidationError`, `UnauthorizedError`, `ForbiddenError` (src/shared/kernel/result-and-errors.ts).
 *   - `PostgresAdvancedIdentityRepository` (../infrastructure/postgres-advanced-identity.repository.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `RbacPermission` (../domain/identity.entities.ts).
 */

import { CryptoUtils } from '@shared/kernel/crypto.util';
import { getEnvConfig } from '@config/env.schema';
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import { assertHasPermission, type RbacRole } from '../domain/identity.entities';
import type { PostgresAdvancedIdentityRepository } from '../infrastructure/postgres-advanced-identity.repository';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { IdentityAuditLogger } from '../infrastructure/identity-audit.logger';

/**
 * Resuelve el piso temporal anti-enumeracion desde el contrato de entorno.
 *
 * Falla cerrado cuando la variable falta o queda fuera del rango 0-5000ms.
 *
 * @returns Piso temporal configurado en milisegundos (`ARGON2_TIMING_FLOOR_MS`).
 */
function resolvePasswordResetTimingFloorMs(): number {
  const floorMs = getEnvConfig().ARGON2_TIMING_FLOOR_MS;
  if (!Number.isInteger(floorMs) || floorMs < 0 || floorMs > 5000) {
    throw new Error(
      'CONFIGURACION_ENTORNO_INVALIDA: ARGON2_TIMING_FLOOR_MS ausente o fuera de rango (0-5000); revise el contrato de entorno.'
    );
  }
  return floorMs;
}

/**
 * Caso de uso para solicitar el restablecimiento de contrasena sin revelar existencia de cuenta.
 *
 * Audita `PASSWORD_RESET_REQUESTED` en modo best-effort en AMBAS ramas (exista o no el
 * usuario) para no introducir un oraculo de temporizacion: la respuesta es identica.
 */
export class RequestPasswordResetUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Genera un token efimero si el usuario existe, con piso temporal anti-enumeracion del contrato.
   *
   * El token en claro NUNCA se devuelve en el objeto de respuesta (C1-41): solo viaja por el
   * canal seguro que indique `deliverViaSecureChannel` (correo transaccional). La respuesta es
   * identica exista o no la cuenta, de modo que no revela su existencia ni por contenido ni por tiempo.
   *
   * @param email - Correo del usuario a recuperar.
   * @param requestIp - Direccion IP de la solicitud.
   * @param userAgent - Agente de usuario para auditoria.
   * @param deliverViaSecureChannel - Entrega opcional del token por canal seguro (email).
   * @returns Confirmacion generica de recepcion, sin material sensible.
   */
  public async execute(
    email: string,
    requestIp: string,
    userAgent?: string,
    deliverViaSecureChannel?: (rawToken: string, expiresAt: Date) => Promise<void> | void
  ): Promise<{ issued: boolean }> {
    const startMs = Date.now();
    let targetUserId: string | null = null;

    try {
      const user = await this.identityRepo.findUserByEmail(email);
      if (user && user.passwordHash) {
        // Token CSPRNG de 32 bytes en hex; en BD solo persiste su SHA-256
        const rawToken = CryptoUtils.generateCsprngToken(32);
        const tokenSha256 = CryptoUtils.sha256Hex(rawToken);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos de TTL

        await this.advancedRepo.createPasswordResetToken(
          user.id,
          tokenSha256,
          requestIp,
          userAgent,
          expiresAt
        );
        targetUserId = user.id;

        if (deliverViaSecureChannel) {
          await deliverViaSecureChannel(rawToken, expiresAt);
        }
      }
    } finally {
      // Piso temporal del contrato para prevenir ataques de temporizacion y enumeracion
      const elapsedMs = Date.now() - startMs;
      const remainingMs = resolvePasswordResetTimingFloorMs() - elapsedMs;
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
    }

    try {
      await this.auditLogger?.recordAuthEvent({
        organizationId: null,
        actorUserId: targetUserId,
        actorRole: null,
        eventCategory: 'RECOVERY',
        eventAction: 'PASSWORD_RESET_REQUESTED',
        severity: 'INFO',
        targetResourceType: 'PASSWORD_RESET',
        targetResourceId: targetUserId,
        ipAddress: requestIp,
        userAgent: userAgent ?? null,
        details: { issued: targetUserId !== null },
      });
    } catch {
      // Best-effort: la respuesta anti-enumeracion jamas cambia por un fallo de auditoria.
    }

    return { issued: true };
  }
}

/**
 * Caso de uso para confirmar el restablecimiento de contrasena e invalidar sesiones previas.
 *
 * Audita `PASSWORD_RESET_CONFIRMED` en modo fail-closed y `PASSWORD_RESET_CONFIRM_FAILED`
 * en modo best-effort (el error original de token invalido siempre se preserva).
 */
export class ConfirmPasswordResetUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Verifica el token, calcula el nuevo hash Argon2id y revoca todas las sesiones anteriores.
   *
   * El consumo del token es atomico (C1-41): una unica sentencia UPDATE condicional
   * (`token_sha256`, `used_at IS NULL`, `expires_at > NOW()`) dentro de una transaccion
   * garantiza un solo uso incluso ante confirmaciones concurrentes. El hash Argon2id se
   * calcula ANTES de abrir la transaccion para no retenerla durante el costo de CPU y para
   * que un token invalido cueste un tiempo similar al de uno valido.
   *
   * @param rawToken - Token en texto plano recibido por el usuario.
   * @param newPassword - Nueva contrasena en texto plano.
   */
  public async execute(rawToken: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new ValidationError('La nueva contraseña debe tener al menos 8 caracteres.');
    }
    if (!rawToken || rawToken.trim().length === 0) {
      throw new ValidationError('El token de restablecimiento es requerido.');
    }

    const tokenSha256 = CryptoUtils.sha256Hex(rawToken.trim());

    // Calcula el hash Argon2id seguro antes de abrir la transaccion
    const newPasswordHash = await CryptoUtils.hashPasswordArgon2id(newPassword);
    let confirmedUserId: string | null = null;

    await this.advancedRepo.runInAtomicTransaction(async (client) => {
      const resetRecord = await this.advancedRepo.consumePasswordResetTokenAtomically(tokenSha256, client);

      if (!resetRecord) {
        try {
          await this.auditLogger?.recordAuthEvent({
            organizationId: null,
            actorUserId: null,
            actorRole: null,
            eventCategory: 'RECOVERY',
            eventAction: 'PASSWORD_RESET_CONFIRM_FAILED',
            severity: 'WARN',
            targetResourceType: 'PASSWORD_RESET',
            targetResourceId: null,
            details: { reason: 'INVALID_OR_EXPIRED_TOKEN' },
          });
        } catch {
          // Best-effort: el rechazo del token invalido se preserva.
        }
        throw new UnauthorizedError('El enlace de restablecimiento es inválido o ha expirado.');
      }

      // Actualiza contrasena y revoca todas las sesiones existentes; el incremento de
      // version es la ultima sentencia para que su replica en Redis preceda al COMMIT
      await this.advancedRepo.updateUserPasswordHash(resetRecord.userId, newPasswordHash, client);
      await this.identityRepo.revokeAllUserSessions(resetRecord.userId, 'password_reset_confirm', client);
      await this.identityRepo.incrementTokenVersion(resetRecord.userId, client);
      confirmedUserId = resetRecord.userId;
    });

    // Fail-closed: la confirmacion no se da por buena si su rastro critico se pierde.
    await this.auditLogger?.recordAuthEvent({
      organizationId: null,
      actorUserId: confirmedUserId,
      actorRole: null,
      eventCategory: 'RECOVERY',
      eventAction: 'PASSWORD_RESET_CONFIRMED',
      severity: 'WARN',
      targetResourceType: 'PASSWORD_RESET',
      targetResourceId: confirmedUserId,
      details: { sessionsRevoked: true },
    });
  }
}

/**
 * Roles que pueden otorgarse dentro de un tenant. `SUPERADMIN` nunca es un rol de
 * organizacion (el esquema lo prohibe con `chk_no_tenant_superadmin`): el gobierno de
 * plataforma vive en `users.is_platform_superadmin` y no se delega por invitacion.
 */
const GRANTABLE_TENANT_ROLES: readonly RbacRole[] = ['OWNER', 'DEVELOPER', 'BILLING', 'VIEWER'];

/**
 * Jerarquia de privilegio entre roles de tenant. El rol otorgado nunca puede superar al
 * rol propio del invitador: un `DEVELOPER` no puede crear un `OWNER`.
 */
const TENANT_ROLE_RANK: Readonly<Record<RbacRole, number>> = {
  SUPERADMIN: 4,
  OWNER: 3,
  DEVELOPER: 2,
  BILLING: 1,
  VIEWER: 0,
};

/**
 * Normaliza un correo para comparaciones de identidad (minusculas y sin espacios).
 *
 * @param email - Correo en cualquier capitalizacion.
 * @returns Correo canonico para comparar destinatarios.
 */
function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Caso de uso para la gestion de invitaciones de miembros a organizaciones.
 *
 * Audita `INVITATION_CREATED` e `INVITATION_ACCEPTED` en modo fail-closed y los
 * intentos de aceptacion ilegitimos (`INVITATION_ACCEPT_FAILED`) en modo best-effort.
 */
export class ManageOrganizationInvitationsUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Registra un intento de aceptacion ilegitimo sin ocultar el error principal.
   *
   * @param acceptingUserId - Usuario que intento aceptar.
   * @param organizationId - Organizacion de la invitacion cuando se conoce.
   * @param reason - Motivo del rechazo.
   */
  private async auditAcceptFailed(
    acceptingUserId: string,
    organizationId: string | null,
    reason: string
  ): Promise<void> {
    try {
      await this.auditLogger?.recordAuthEvent({
        organizationId,
        actorUserId: acceptingUserId,
        actorRole: null,
        eventCategory: 'INVITATION',
        eventAction: 'INVITATION_ACCEPT_FAILED',
        severity: 'WARN',
        targetResourceType: 'INVITATION',
        targetResourceId: null,
        details: { reason },
      });
    } catch {
      // Best-effort: el rechazo original se preserva aunque la auditoria falle.
    }
  }

  /**
   * Emite una invitacion formal para que un colaborador se una a la organizacion.
   *
   * Autoriza con la matriz de permisos del dominio: el invitador necesita una membresia
   * activa en la organizacion con el permiso `member:invite` (solo `OWNER` lo posee) y
   * el rol otorgado debe pertenecer a la lista blanca sin superar el rol propio.
   * Falla cerrado ante roles arbitrarios o desconocidos.
   */
  public async createInvitation(data: {
    inviterUserId: string;
    organizationId: string;
    targetEmail: string;
    role: RbacRole;
  }): Promise<{ invitationToken: string; expiresAt: Date }> {
    if (data.role === 'SUPERADMIN') {
      throw new ForbiddenError('No está permitido invitar usuarios con el rol SUPERADMIN a un tenant.');
    }
    if (!GRANTABLE_TENANT_ROLES.includes(data.role)) {
      throw new ValidationError('El rol solicitado no es un rol otorgable dentro de la organización.');
    }

    const normalizedTargetEmail = normalizeIdentityEmail(data.targetEmail);
    if (normalizedTargetEmail.length === 0 || !normalizedTargetEmail.includes('@')) {
      throw new ValidationError('El correo del destinatario de la invitación no es válido.');
    }

    // El invitador debe pertenecer a la organizacion con una membresia activa.
    const memberships = await this.identityRepo.findUserActiveMemberships(data.inviterUserId);
    const inviterMembership = memberships.find((m) => m.organizationId === data.organizationId);

    if (!inviterMembership) {
      throw new ForbiddenError('No tienes permisos suficientes para invitar miembros a esta organización.');
    }

    // Autorizacion contra la matriz del dominio: solo quien posee `member:invite` invita.
    assertHasPermission(inviterMembership.role, 'member:invite');

    // El rol otorgado nunca supera al rol propio del invitador.
    if (TENANT_ROLE_RANK[data.role] > TENANT_ROLE_RANK[inviterMembership.role]) {
      throw new ForbiddenError('No puedes otorgar un rol superior a tu propio rol en la organización.');
    }

    // Busca o crea usuario de destino provisional con el correo ya normalizado.
    let targetUser = await this.identityRepo.findUserByEmail(normalizedTargetEmail);
    if (!targetUser) {
      targetUser = await this.identityRepo.createUser({
        email: normalizedTargetEmail,
        fullName: normalizedTargetEmail.split('@')[0] ?? 'Invitado',
        passwordHash: 'PROVISIONAL_INVITE_STUB',
        tokenVersion: 1,
        isPlatformSuperadmin: false,
      });
    }

    const rawToken = CryptoUtils.generateCsprngToken(32);
    const tokenSha256 = CryptoUtils.sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias de vigencia

    await this.advancedRepo.createOrganizationInvitation({
      organizationId: data.organizationId,
      userId: targetUser.id,
      role: data.role,
      invitedByUserId: data.inviterUserId,
      invitationTokenSha256: tokenSha256,
      invitationExpiresAt: expiresAt,
    });

    // Fail-closed: la invitacion no se confirma si su rastro critico se pierde.
    await this.auditLogger?.recordAuthEvent({
      organizationId: data.organizationId,
      actorUserId: data.inviterUserId,
      actorRole: inviterMembership.role,
      eventCategory: 'INVITATION',
      eventAction: 'INVITATION_CREATED',
      severity: 'INFO',
      targetResourceType: 'INVITATION',
      targetResourceId: targetUser.id,
      details: { targetEmail: normalizedTargetEmail, role: data.role },
    });

    return {
      invitationToken: rawToken,
      expiresAt,
    };
  }

  /**
   * Acepta una invitacion formal vinculando la membresia activa al usuario autenticado.
   *
   * Vincula al destinatario: el correo del usuario autenticado debe coincidir con el del
   * titular de la invitacion (comparacion normalizada sin distincion de mayusculas) y el
   * identificador debe ser el mismo; nunca se reescribe el titular con un aceptante ajeno.
   * Falla cerrado ante invitaciones invalidas, usuarios desconocidos o correos distintos.
   */
  public async acceptInvitation(rawToken: string, acceptingUserId: string): Promise<{ organizationId: string; role: string }> {
    const tokenSha256 = CryptoUtils.sha256Hex(rawToken.trim());
    const invitation = await this.advancedRepo.findInvitationByTokenSha256(tokenSha256);

    if (!invitation) {
      await this.auditAcceptFailed(acceptingUserId, null, 'INVALID_OR_EXPIRED_INVITATION');
      throw new UnauthorizedError('La invitación es inválida, ya fue utilizada o ha expirado.');
    }

    const acceptingUser = await this.identityRepo.findUserById(acceptingUserId);
    if (!acceptingUser) {
      await this.auditAcceptFailed(acceptingUserId, invitation.organizationId, 'ACCEPTING_USER_UNKNOWN');
      throw new ForbiddenError('La identidad que acepta la invitación no existe en el sistema.');
    }

    const titularUser = await this.identityRepo.findUserById(invitation.userId);
    if (!titularUser) {
      await this.auditAcceptFailed(acceptingUserId, invitation.organizationId, 'INVITATION_WITHOUT_RECIPIENT');
      throw new ForbiddenError('La invitación no tiene un destinatario válido y no puede aceptarse.');
    }

    if (normalizeIdentityEmail(acceptingUser.email) !== normalizeIdentityEmail(titularUser.email)) {
      await this.auditAcceptFailed(acceptingUserId, invitation.organizationId, 'RECIPIENT_MISMATCH');
      throw new ForbiddenError('Esta invitación fue emitida para otro destinatario y no puedes aceptarla.');
    }

    if (invitation.userId !== acceptingUserId) {
      await this.auditAcceptFailed(acceptingUserId, invitation.organizationId, 'RECIPIENT_ID_MISMATCH');
      throw new ForbiddenError('La invitación solo puede aceptarla su destinatario original.');
    }

    await this.advancedRepo.acceptOrganizationInvitation(invitation.id, acceptingUserId);

    // Fail-closed: la aceptacion no se confirma si su rastro critico se pierde.
    await this.auditLogger?.recordAuthEvent({
      organizationId: invitation.organizationId,
      actorUserId: acceptingUserId,
      actorRole: invitation.role,
      eventCategory: 'INVITATION',
      eventAction: 'INVITATION_ACCEPTED',
      severity: 'INFO',
      targetResourceType: 'INVITATION',
      targetResourceId: invitation.id,
      details: { role: invitation.role },
    });

    return {
      organizationId: invitation.organizationId,
      role: invitation.role,
    };
  }
}
