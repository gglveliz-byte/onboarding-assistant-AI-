/**
 * @archivo src/modules/01-identity-and-rbac/application/refresh-and-revoke-session.use-case.ts
 * @modulo 01-identity-and-rbac (Rotacion de Refresh Tokens, Deteccion de Robo y Adaptador de Puerto)
 * @proposito
 *   Implementa la rotacion criptografica de Refresh Tokens agrupados en familias
 *   (`token_family_id`) con ventana de gracia de 3 segundos contra condiciones de carrera,
 *   la deteccion de reutilizacion/robo de tokens (que revoca inmediatamente toda la familia
 *   e incrementa `token_version`), la revocacion global en <5ms y la implementacion
 *   concreta del puerto del nucleo `IIdentityAuthPort`.
 *
 * @resumen_contenido
 *   - Clase `RotateRefreshTokenUseCase`:
 *       * Valida hash SHA-256 del Refresh Token recibido.
 *       * Detecta reuso fuera de la ventana de gracia de 3s (revocando la familia completa).
 *       * Consume el token previo y emite el nuevo par Access Token (15m) + Refresh Token.
 *   - Clase `RevokeAllUserSessionsUseCase`:
 *       * Incrementa atomicamente `users.token_version` y revoca todas las filas en BD y Redis.
 *   - Clase `IdentityAuthPortAdapter`:
 *       * Implementa `IIdentityAuthPort` para el Gateway de Voz y demas modulos consumidores.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ForbiddenError`, `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *   - `IIdentityAuthPort`, `PortFailure` (src/shared/ports/core-modules.ports.ts).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `JwtEddsaSigner` (../infrastructure/jwt-eddsa.signer.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `ROLE_PERMISSIONS_MAP` (../domain/identity.entities.ts).
 *
 * @dependencias_externas
 *   - `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `auth_sessions`, `users`, `organizations`, `legal_documents`, `user_legal_acceptances`.
 *   - Redis: `auth:user_tv:<user_id>`.
 */

import * as crypto from 'node:crypto';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { ForbiddenError, UnauthorizedError } from '@shared/kernel/result-and-errors';
import type { IIdentityAuthPort, PortFailure } from '@shared/ports/core-modules.ports';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import {
  type OrganizationEntity,
  type RbacRole,
  ROLE_PERMISSIONS_MAP,
  type UserEntity,
} from '../domain/identity.entities';
import { JwtEddsaSigner } from '../infrastructure/jwt-eddsa.signer';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { IdentityAuditLogger } from '../infrastructure/identity-audit.logger';

/** Parametros de entrada para rotar un Refresh Token. */
export interface RotateRefreshTokenInput {
  readonly rawRefreshToken: string;
  readonly ipAddress: string;
  readonly userAgent: string;
}

/** Resultado exitoso de la rotacion de sesion. */
export interface RotateRefreshTokenOutput {
  readonly accessToken: string;
  readonly rawRefreshToken: string;
  readonly user: UserEntity;
  readonly organization: OrganizationEntity | null;
}

/**
 * Caso de uso: Rota el Refresh Token con deteccion estricta de reuso y ventana de gracia de 3s.
 *
 * Audita el robo/reuso detectado (`SESSION_REVOKED` critico) en modo best-effort: el error
 * original de reuso siempre se propaga aunque la auditoria falle.
 */
export class RotateRefreshTokenUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Ejecuta la rotacion del Refresh Token y verifica la validez de la familia.
   *
   * @param input - Refresh token en texto claro y metadatos del cliente.
   * @returns Nuevo par de tokens y datos de la sesion activa.
   */
  public async execute(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenOutput> {
    const tokenHash = CryptoUtils.sha256Hex(input.rawRefreshToken);
    const session = await this.identityRepo.findSessionByTokenHash(tokenHash);

    if (!session) {
      throw new UnauthorizedError('Sesion no encontrada o token invalido.');
    }

    // 1. Deteccion de Robo / Reuso de Token
    if (session.consumedAt !== null && session.consumedAt !== undefined) {
      const elapsedMs = Date.now() - session.consumedAt.getTime();
      const GRACE_PERIOD_MS = 3000; // Ventana de 3 segundos para peticiones concurrentes legitimas

      if (elapsedMs > GRACE_PERIOD_MS) {
        // ATAQUE DE REPETICION O ROBO DETECTADO: Revocacion total inmediata
        await this.identityRepo.revokeTokenFamily(session.tokenFamilyId, 'TOKEN_REUSE_DETECTED');
        await this.identityRepo.incrementTokenVersion(session.userId);

        try {
          await this.auditLogger?.recordAuthEvent({
            organizationId: session.organizationId ?? null,
            actorUserId: session.userId,
            actorRole: null,
            eventCategory: 'SESSION',
            eventAction: 'SESSION_REVOKED',
            severity: 'CRITICAL_SECURITY',
            targetResourceType: 'AUTH_SESSION',
            targetResourceId: session.tokenFamilyId,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            details: { reason: 'TOKEN_REUSE_DETECTED', tokenFamilyId: session.tokenFamilyId },
          });
        } catch {
          // Best-effort: la deteccion de robo se reporta igual aunque la auditoria falle.
        }

        throw new UnauthorizedError(
          'TOKEN_REUSE_DETECTED: Se detecto reutilizacion de un token de refresco ya consumido. ' +
            'Todas las sesiones activas han sido revocadas por seguridad.'
        );
      }
    }

    // 2. Comprobacion de revocacion explicita de la sesion
    if (session.revokedAt !== null && session.revokedAt !== undefined) {
      throw new UnauthorizedError(`La sesion fue revocada previamente. Motivo: ${session.revocationReason ?? 'Desconocido'}`);
    }

    // 3. Comprobacion de expiracion temporal
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('El Refresh Token ha expirado. Por favor inicie sesion nuevamente.');
    }

    // 4. Verificacion del usuario y de su token_version activo
    const user = await this.identityRepo.findUserById(session.userId);
    if (!user) {
      throw new UnauthorizedError('El usuario asociado a la sesion ya no existe.');
    }

    if (user.tokenVersion !== session.tokenVersionSnapshot) {
      throw new UnauthorizedError('TOKEN_VERSION_REVOKED: La version de sesion del usuario fue invalidada globalmente.');
    }

    // 5. Resolucion de la organizacion activa si aplica
    let organization: OrganizationEntity | null = null;
    let userRole: RbacRole = user.isPlatformSuperadmin ? 'SUPERADMIN' : 'VIEWER';

    if (session.organizationId) {
      organization = await this.identityRepo.findOrganizationById(session.organizationId);
      if (organization) {
        if (organization.status === 'SUSPENDED') {
          throw new ForbiddenError('La organizacion se encuentra suspendida.');
        }
        const membership = await this.identityRepo.findMembership(organization.id, user.id);
        if (membership) {
          userRole = membership.role;
        }
      }
    }

    // 6. Marcar la sesion actual como consumida
    await this.identityRepo.consumeSession(session.id);

    // 7. Generar nuevo Refresh Token dentro de la misma familia
    const newRawRefreshToken = CryptoUtils.generateCsprngToken(32);
    const newRefreshTokenSha256 = CryptoUtils.sha256Hex(newRawRefreshToken);
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.identityRepo.createAuthSession({
      userId: user.id,
      organizationId: organization ? organization.id : null,
      tokenFamilyId: session.tokenFamilyId,
      refreshTokenSha256: newRefreshTokenSha256,
      parentTokenSha256: session.refreshTokenSha256,
      tokenVersionSnapshot: user.tokenVersion,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt: newExpiresAt,
    });

    // 8. Emitir nuevo Access Token de 15 minutos firmado con EdDSA
    const scopes = ROLE_PERMISSIONS_MAP[userRole] ?? [];
    const accessToken = await JwtEddsaSigner.signAccessToken({
      userId: user.id,
      organizationId: organization ? organization.id : '',
      role: userRole,
      scopes,
      tokenVersion: user.tokenVersion,
      mfaSatisfied: false,
    });

    return {
      accessToken,
      rawRefreshToken: newRawRefreshToken,
      user,
      organization,
    };
  }
}

/**
 * Caso de uso: Cierra y revoca todas las sesiones de un usuario en sub-5ms.
 *
 * Audita `SESSION_REVOKED` en modo fail-closed: si la auditoria critica se pierde, la
 * operacion no se confirma como exitosa (la revocacion aplicada es idempotente y reintentable).
 */
export class RevokeAllUserSessionsUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Incrementa el `token_version` en base de datos y Redis y revoca las sesiones registradas.
   *
   * @param userId - Identificador del usuario cuyas sesiones se invalidan.
   * @param reason - Motivo auditable de la revocacion.
   * @param context - Contexto forense opcional (organizacion, IP y agente del solicitante).
   * @returns Nueva version de token y total de sesiones revocadas.
   */
  public async execute(
    userId: string,
    reason: string,
    context?: { organizationId?: string | null; ipAddress?: string | null; userAgent?: string | null }
  ): Promise<{ newTokenVersion: number; revokedSessionsCount: number }> {
    const newTokenVersion = await this.identityRepo.incrementTokenVersion(userId);
    const revokedSessionsCount = await this.identityRepo.revokeAllUserSessions(userId, reason);

    await this.auditLogger?.recordAuthEvent({
      organizationId: context?.organizationId ?? null,
      actorUserId: userId,
      actorRole: null,
      eventCategory: 'SESSION',
      eventAction: 'SESSION_REVOKED',
      severity: 'WARN',
      targetResourceType: 'USER',
      targetResourceId: userId,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      details: { reason, newTokenVersion, revokedSessionsCount },
    });

    return {
      newTokenVersion,
      revokedSessionsCount,
    };
  }
}

/**
 * Adaptador del puerto inmutable `IIdentityAuthPort` para consumo del Gateway de Voz y modulos.
 */
export class IdentityAuthPortAdapter implements IIdentityAuthPort {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly redis: RedisClusterClient
  ) {}

  /**
   * Verifica el Access Token JWT EdDSA y valida instantaneamente su `token_version` en Redis.
   */
  public async verifyAccessTokenAndVersion(
    accessToken: string
  ): Promise<{ readonly ok: true; readonly actor: import('@shared/ports/core-modules.ports').AuthenticatedActor } | PortFailure> {
    try {
      const claims = await JwtEddsaSigner.verifyAccessToken(accessToken);

      // Comprobacion en Redis de la version de token (<1ms)
      const isVersionValid = await JwtEddsaSigner.isTokenVersionValidInRedis(claims.userId, claims.tokenVersion, this.redis);
      if (!isVersionValid) {
        return {
          ok: false,
          code: 'TOKEN_VERSION_REVOKED',
          reason: 'El token de acceso fue revocado globalmente por un cambio de credenciales o cierre de sesion.',
          retryable: false,
        };
      }

      return {
        ok: true,
        actor: {
          userId: claims.userId,
          organizationId: claims.organizationId,
          role: claims.role,
          scopes: claims.scopes,
          tokenVersion: claims.tokenVersion,
          mfaSatisfied: claims.mfaSatisfied,
          tokenId: claims.tokenId,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'TOKEN_INVALID',
        reason: error instanceof Error ? error.message : 'Token de acceso no valido.',
        retryable: false,
      };
    }
  }

  /**
   * Comprueba que la organizacion este activa, con DPA firmado y aceptaciones legales vigentes.
   */
  public async assertOrganizationActive(
    organizationId: string,
    userId: string
  ): Promise<
    | { readonly ok: true; readonly dpaVersionTag: string; readonly organizationSlug: string }
    | PortFailure
  > {
    try {
      const org = await this.identityRepo.findOrganizationById(organizationId);
      if (!org) {
        return {
          ok: false,
          code: 'RESOURCE_NOT_FOUND',
          reason: 'La organizacion no existe.',
          retryable: false,
        };
      }

      if (org.status === 'SUSPENDED') {
        return {
          ok: false,
          code: 'TENANT_SUSPENDED',
          reason: org.suspendedReason ?? 'La organizacion se encuentra suspendida administrativamente.',
          retryable: false,
        };
      }

      if (!org.dpaSignedAt) {
        return {
          ok: false,
          code: 'DPA_NOT_SIGNED',
          reason: 'La organizacion no cuenta con el acuerdo de procesamiento de datos (DPA) firmado.',
          retryable: false,
        };
      }

      const hasLegal = await this.identityRepo.hasAcceptedMandatoryLegalDocs(userId, organizationId);
      if (!hasLegal) {
        return {
          ok: false,
          code: 'LEGAL_CONSENT_OUTDATED',
          reason: 'Existen documentos legales obligatorios pendientes de aceptacion.',
          retryable: false,
        };
      }

      return {
        ok: true,
        dpaVersionTag: 'v1.0.0',
        organizationSlug: org.slug,
      };
    } catch {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: 'Error de comunicacion con el repositorio de datos.',
        retryable: true,
      };
    }
  }
}
