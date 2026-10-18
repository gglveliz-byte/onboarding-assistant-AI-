/**
 * @archivo src/modules/01-identity-and-rbac/domain/identity.entities.ts
 * @modulo 01-identity-and-rbac (Identidad Core, Entidades de Dominio y Matriz RBAC)
 * @proposito
 *   Define los modelos puros de dominio, tipos de valor y la Matriz de Control de Acceso
 *   Basado en Roles (RBAC) con los 29 permisos granulares de la plataforma SaaS.
 *   Ninguna regla de negocio depende de infraestructura ni de base de datos directamente;
 *   toda asercion sobre cuentas bloqueadas, jerarquias de rol y autorizacion reside aqui.
 *
 * @resumen_contenido
 *   - Tipo `RbacRole`: Los 5 roles reconocidos ('SUPERADMIN', 'OWNER', 'DEVELOPER', 'BILLING', 'VIEWER').
 *   - Tipo `RbacPermission`: Los 29 permisos granulares de la arquitectura.
 *   - Constante `ROLE_PERMISSIONS_MAP`: Catalogo inmutable que asigna permisos exactos por rol.
 *   - Funciones `hasPermission()` y `assertHasPermission()`: Evaluacion pura de privilegios.
 *   - Entidades: `OrganizationEntity`, `UserEntity`, `MembershipEntity`, `AuthSessionEntity`.
 *   - Funciones de dominio: `isAccountTemporarilyLocked()`, `assertCanAttemptLogin()`.
 *
 * @dependencias_internas
 *   - `ForbiddenError`, `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *
 * @dependencias_externas
 *   - Ninguna (Cero dependencias externas; entidades de dominio puro).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `memberships`, `auth_sessions`.
 */

import { ForbiddenError, UnauthorizedError } from '@shared/kernel/result-and-errors';

/**
 * Roles reconocidos por la plataforma para el control de acceso en inquilinos y gobierno.
 */
export type RbacRole = 'SUPERADMIN' | 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';

/**
 * Los 29 permisos granulares de la arquitectura que gobiernan todas las operaciones del backend.
 */
export type RbacPermission =
  // Organizacion
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  // Miembros y gobernanza interna
  | 'member:read'
  | 'member:invite'
  | 'member:update_role'
  | 'member:remove'
  // Proyectos y entornos
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'project:delete'
  // Claves de API criptograficas
  | 'apikey:create'
  | 'apikey:read'
  | 'apikey:rotate'
  | 'apikey:revoke'
  // Dominios permitidos (CORS / SDK Handshake)
  | 'domain:create'
  | 'domain:read'
  | 'domain:delete'
  // Entrenamiento visual y Mapa RAG
  | 'trainer:launch'
  | 'trainer:publish_map'
  | 'trainer:read_map'
  | 'trainer:edit_prompt'
  // Facturacion y suscripciones
  | 'billing:read'
  | 'billing:manage_sub'
  | 'billing:export_invoice'
  // Sesiones de voz y telemetria
  | 'voice:session_read'
  | 'voice:session_kill'
  // Auditoria forense
  | 'audit:read'
  // Gobierno de plataforma (exclusivo SuperAdmin)
  | 'admin:govern_tenants'
  | 'admin:manage_pricing'
  | 'admin:override_discount';

const SUPERADMIN_PERMISSIONS: readonly RbacPermission[] = [
  'org:read', 'org:update', 'org:delete',
  'member:read', 'member:invite', 'member:update_role', 'member:remove',
  'project:create', 'project:read', 'project:update', 'project:delete',
  'apikey:create', 'apikey:read', 'apikey:rotate', 'apikey:revoke',
  'domain:create', 'domain:read', 'domain:delete',
  'trainer:launch', 'trainer:publish_map', 'trainer:read_map', 'trainer:edit_prompt',
  'billing:read', 'billing:manage_sub', 'billing:export_invoice',
  'voice:session_read', 'voice:session_kill',
  'audit:read',
  'admin:govern_tenants', 'admin:manage_pricing', 'admin:override_discount',
];

const OWNER_PERMISSIONS: readonly RbacPermission[] = [
  'org:read', 'org:update', 'org:delete',
  'member:read', 'member:invite', 'member:update_role', 'member:remove',
  'project:create', 'project:read', 'project:update', 'project:delete',
  'apikey:create', 'apikey:read', 'apikey:rotate', 'apikey:revoke',
  'domain:create', 'domain:read', 'domain:delete',
  'trainer:launch', 'trainer:publish_map', 'trainer:read_map', 'trainer:edit_prompt',
  'billing:read', 'billing:manage_sub', 'billing:export_invoice',
  'voice:session_read', 'voice:session_kill',
  'audit:read',
];

const DEVELOPER_PERMISSIONS: readonly RbacPermission[] = [
  'org:read', 'member:read',
  'project:create', 'project:read', 'project:update',
  'apikey:create', 'apikey:read', 'apikey:rotate',
  'domain:create', 'domain:read',
  'trainer:launch', 'trainer:publish_map', 'trainer:read_map', 'trainer:edit_prompt',
  'voice:session_read',
];

const BILLING_PERMISSIONS: readonly RbacPermission[] = [
  'org:read', 'member:read',
  'billing:read', 'billing:manage_sub', 'billing:export_invoice',
];

const VIEWER_PERMISSIONS: readonly RbacPermission[] = [
  'org:read', 'member:read',
  'project:read', 'apikey:read', 'domain:read',
  'trainer:read_map', 'billing:read', 'voice:session_read',
];

/**
 * Catalogo inmutable que mapea cada rol con su lista exacta de permisos granulares.
 */
export const ROLE_PERMISSIONS_MAP: Readonly<Record<RbacRole, readonly RbacPermission[]>> = Object.freeze({
  SUPERADMIN: SUPERADMIN_PERMISSIONS,
  OWNER: OWNER_PERMISSIONS,
  DEVELOPER: DEVELOPER_PERMISSIONS,
  BILLING: BILLING_PERMISSIONS,
  VIEWER: VIEWER_PERMISSIONS,
});

/**
 * Evalua de forma pura si un rol dispone de un permiso especifico.
 *
 * @param role - Rol activo en el contexto.
 * @param permission - Permiso a verificar.
 * @returns `true` si el rol contiene el permiso solicitado.
 */
export function hasPermission(role: RbacRole, permission: RbacPermission): boolean {
  const permissions = ROLE_PERMISSIONS_MAP[role];
  return permissions.includes(permission);
}

/**
 * Valida la posesion de un permiso y lanza una excepcion de dominio si no esta autorizado.
 *
 * @param role - Rol a evaluar.
 * @param permission - Permiso exigido.
 * @throws ForbiddenError cuando el rol no posee el permiso.
 */
export function assertHasPermission(role: RbacRole, permission: RbacPermission): void {
  if (!hasPermission(role, permission)) {
    throw new ForbiddenError(`Acceso denegado: el rol ${role} no posee el permiso requerido [${permission}].`);
  }
}

/**
 * Estado del inquilino u organizacion B2B.
 */
export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION';

/**
 * Entidad de dominio que representa una organizacion o tenant B2B.
 */
export interface OrganizationEntity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: OrganizationStatus;
  readonly enforceMfa: boolean;
  readonly enforceSso: boolean;
  readonly ssoIdpMetadataXml?: string | null;
  readonly ssoIdpEntrypointUrl?: string | null;
  readonly ssoIdpX509Cert?: string | null;
  readonly ssoEmailDomain?: string | null;
  readonly optInSessionTranscripts: boolean;
  readonly dpaSignedAt?: Date | null;
  readonly dpaClickwrapIp?: string | null;
  readonly suspendedReason?: string | null;
  readonly suspendedAt?: Date | null;
  readonly suspendedByUserId?: string | null;
  readonly phoneNumber?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Entidad de dominio que representa a un usuario del sistema (B2B o SuperAdmin).
 */
export interface UserEntity {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phoneNumber?: string | null;
  readonly passwordHash: string | null;
  readonly tokenVersion: number;
  readonly isPlatformSuperadmin: boolean;
  readonly emailVerifiedAt?: Date | null;
  readonly emailVerificationOtpSha256?: string | null;
  readonly emailVerificationExpiresAt?: Date | null;
  readonly mfaTotpEnabled: boolean;
  readonly mfaTotpSecretEnc?: Buffer | null;
  readonly mfaWebauthnEnabled: boolean;
  readonly mfaWebauthnCredentialsJson?: unknown;
  readonly oauthGoogleSub?: string | null;
  readonly oauthGithubId?: string | null;
  readonly oauthMicrosoftOid?: string | null;
  readonly failedLoginAttempts: number;
  readonly lockedUntil?: Date | null;
  readonly lastLoginAt?: Date | null;
  readonly lastLoginIp?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Entidad de dominio que representa la membresia de un usuario dentro de una organizacion.
 */
export interface MembershipEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: RbacRole;
  readonly invitedByUserId?: string | null;
  readonly invitationTokenSha256?: string | null;
  readonly invitationExpiresAt?: Date | null;
  readonly invitationAcceptedAt?: Date | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Entidad de dominio que modela una sesion de autenticacion con Refresh Token rotativo.
 */
export interface AuthSessionEntity {
  readonly id: string;
  readonly userId: string;
  readonly organizationId?: string | null;
  readonly tokenFamilyId: string;
  readonly refreshTokenSha256: string;
  readonly parentTokenSha256?: string | null;
  readonly tokenVersionSnapshot: number;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly consumedAt?: Date | null;
  readonly revokedAt?: Date | null;
  readonly revocationReason?: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * Evalua si la cuenta de usuario se encuentra temporalmente bloqueada por exceso de intentos fallidos.
 *
 * @param user - Usuario a evaluar.
 * @returns `true` si la cuenta tiene un bloqueo activo en el tiempo actual.
 */
export function isAccountTemporarilyLocked(user: UserEntity): boolean {
  if (!user.lockedUntil) {
    return false;
  }
  return user.lockedUntil.getTime() > Date.now();
}

/**
 * Verifica si el usuario puede iniciar sesion o si su cuenta se encuentra restringida.
 *
 * @param user - Usuario a validar.
 * @throws UnauthorizedError si la cuenta se encuentra temporalmente bloqueada.
 */
export function assertCanAttemptLogin(user: UserEntity): void {
  if (isAccountTemporarilyLocked(user)) {
    const minutosRestantes = Math.ceil(((user.lockedUntil?.getTime() ?? 0) - Date.now()) / 60000);
    throw new UnauthorizedError(
      `Cuenta bloqueada temporalmente por multiples intentos fallidos. Intente nuevamente en ${minutosRestantes} minutos.`
    );
  }
}

/**
 * Asercion completa que el navegador presenta al autenticarse con una llave fisica.
 *
 * Se modela como un objeto y no como una sola cadena porque **la verificacion necesita todas sus
 * partes**: sin los datos del autenticador y sin la firma no puede comprobarse que quien responde posee
 * realmente la llave. La version anterior de la verificacion recibia unicamente los datos del cliente
 * —que el propio servidor contribuye a construir— y eso hacia imposible la comprobacion: bastaba con
 * conocer el reto para superar el segundo factor sin poseer la llave.
 */
export interface WebAuthnAssertionInput {
  /** Datos del cliente, codificados por el navegador en base64url: contienen el reto, el origen y el tipo de ceremonia. */
  readonly clientDataJsonBase64Url: string;
  /**
   * Datos del autenticador, codificados en base64url.
   *
   * Incluyen el resumen del identificador de la parte confiable y los indicadores de presencia y
   * verificacion del usuario, que es lo que acredita que una persona interactuo con la llave.
   */
  readonly authenticatorDataBase64Url: string;
  /** Firma de la asercion, codificada en base64url, verificable con la clave publica registrada. */
  readonly signatureBase64Url: string;
  /** Identificador de la credencial empleada, para localizar su clave publica. */
  readonly credentialId: string;
}
