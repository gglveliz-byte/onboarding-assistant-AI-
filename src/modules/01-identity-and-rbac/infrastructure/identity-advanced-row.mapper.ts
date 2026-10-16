/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/identity-advanced-row.mapper.ts
 * @modulo 01-identity-and-rbac (Mapeador de Tipos y DTOs para Identidad Avanzada, MFA y Legal)
 * @proposito
 *   Desacopla los tipos, interfaces y funciones de transformacion de filas SQL snake_case
 *   a tipos de dominio camelCase para el repositorio avanzado de identidad, garantizando
 *   que ningun archivo de persistencia supere el limite de 500 lineas.
 *
 * @resumen_contenido
 *   - Interfaces de registros: `LegalDocumentRecord`, `UserLegalAcceptanceRecord`,
 *     `MembershipInvitationRecord`, `BreakGlassRequestRecord`.
 *   - Clase utilitaria `IdentityAdvancedRowMapper` con funciones estaticas puras de mapeo.
 *
 * @dependencias_internas
 *   - Ninguna (Puras definiciones y mapeo).
 */

/** Registro de documento legal persistido. */
export interface LegalDocumentRecord {
  readonly id: string;
  readonly docType: string;
  readonly versionTag: string;
  readonly title: string;
  readonly contentMarkdown: string;
  readonly contentSha256: string;
  readonly isMandatory: boolean;
  readonly isActive: boolean;
  readonly publishedAt: Date;
}

/** Registro de aceptacion legal por usuario y organizacion. */
export interface UserLegalAcceptanceRecord {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string | null;
  readonly legalDocumentId: string;
  readonly documentSha256Snapshot: string;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly acceptedAt: Date;
}

/** Registro de invitacion pendiente o activa. */
export interface MembershipInvitationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly invitedByUserId: string | null;
  readonly invitationTokenSha256: string | null;
  readonly invitationExpiresAt: Date | null;
  readonly invitationAcceptedAt: Date | null;
  readonly isActive: boolean;
}

/** Registro de solicitud Break-Glass de Owner. */
export interface BreakGlassRequestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly status: string;
  readonly dnsTxtVerificationToken: string;
  readonly whopLastReceiptIdVerified: string | null;
  readonly challengeVerifiedAt: Date | null;
  readonly coolingOffEndsAt: Date | null;
  readonly approvedBySuperadminId: string | null;
  readonly resolvedAt: Date | null;
  readonly requestIp: string;
  readonly createdAt: Date;
}

/**
 * Mapeador de filas SQL de identidad avanzada.
 */
export class IdentityAdvancedRowMapper {
  public static mapBreakGlassRow(row: Record<string, unknown>): BreakGlassRequestRecord {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      userId: String(row['user_id']),
      status: String(row['status']),
      dnsTxtVerificationToken: String(row['dns_txt_verification_token']),
      whopLastReceiptIdVerified: row['whop_last_receipt_id_verified'] ? String(row['whop_last_receipt_id_verified']) : null,
      challengeVerifiedAt: row['challenge_verified_at'] ? new Date(String(row['challenge_verified_at'])) : null,
      coolingOffEndsAt: row['cooling_off_ends_at'] ? new Date(String(row['cooling_off_ends_at'])) : null,
      approvedBySuperadminId: row['approved_by_superadmin_id'] ? String(row['approved_by_superadmin_id']) : null,
      resolvedAt: row['resolved_at'] ? new Date(String(row['resolved_at'])) : null,
      requestIp: String(row['request_ip']),
      createdAt: new Date(String(row['created_at'])),
    };
  }

  public static mapMembershipRow(row: Record<string, unknown>): MembershipInvitationRecord {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      userId: String(row['user_id']),
      role: String(row['role']),
      invitedByUserId: row['invited_by_user_id'] ? String(row['invited_by_user_id']) : null,
      invitationTokenSha256: row['invitation_token_sha256'] ? String(row['invitation_token_sha256']) : null,
      invitationExpiresAt: row['invitation_expires_at'] ? new Date(String(row['invitation_expires_at'])) : null,
      invitationAcceptedAt: row['invitation_accepted_at'] ? new Date(String(row['invitation_accepted_at'])) : null,
      isActive: Boolean(row['is_active']),
    };
  }

  public static mapLegalDocRow(row: Record<string, unknown>): LegalDocumentRecord {
    return {
      id: String(row['id']),
      docType: String(row['doc_type']),
      versionTag: String(row['version_tag']),
      title: String(row['title']),
      contentMarkdown: String(row['content_markdown']),
      contentSha256: String(row['content_sha256']),
      isMandatory: Boolean(row['is_mandatory']),
      isActive: Boolean(row['is_active']),
      publishedAt: new Date(String(row['published_at'])),
    };
  }
}
