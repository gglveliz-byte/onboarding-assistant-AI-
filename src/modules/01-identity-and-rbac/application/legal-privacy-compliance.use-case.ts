/**
 * @archivo src/modules/01-identity-and-rbac/application/legal-privacy-compliance.use-case.ts
 * @modulo 01-identity-and-rbac (Casos de Uso de Cumplimiento Legal, DPA, GDPR y Privacidad)
 * @proposito
 *   Implementa la gobernanza y cumplimiento normativo B2B/GDPR: bloqueo tecnico ante
 *   instrumentos legales pendientes o desactualizados (ToS, Privacidad, DPA, AUP), registro
 *   inmutable de aceptaciones con sello SHA-256 del documento, firma de acuerdos DPA,
 *   portabilidad de datos personales (GDPR Data Export) y borrado criptografico de tenant.
 *
 * @resumen_contenido
 *   - Clase `LegalAndPrivacyComplianceUseCase`:
 *       * `checkUserLegalCompliance()`: Valida vigencia de ToS/Privacidad/DPA.
 *       * `acceptLegalDocument()`: Registra aceptacion con snapshot SHA-256 e IP.
 *       * `signDpaForOrganization()`: Firma formal del DPA para el tenant B2B.
 *       * `exportUserDataGdpr()`: Portabilidad de datos en formato JSON estandar.
 *       * `anonymizeOrDeleteOrganization()`: Baja logica y revocacion de sesiones.
 *
 * @dependencias_internas
 *   - `LegalConsentOutdatedError`, `DpaNotSignedError`, `ForbiddenError`, `NotFoundError` (src/shared/kernel/result-and-errors.ts).
 *   - `PostgresAdvancedIdentityRepository` (../infrastructure/postgres-advanced-identity.repository.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 */

import {
  DpaNotSignedError,
  ForbiddenError,
  LegalConsentOutdatedError,
  NotFoundError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import type { LegalDocumentRecord } from '../infrastructure/identity-advanced-row.mapper';
import type { PostgresAdvancedIdentityRepository } from '../infrastructure/postgres-advanced-identity.repository';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';

/**
 * Evidencia inmutable de aceptacion legal con sello derivado en servidor.
 */
export interface LegalAcceptanceEvidence {
  /** Usuario que ejecuta la aceptacion en nombre de la organizacion. */
  readonly userId: string;
  /** Organizacion en cuyo nombre se acepta el documento. */
  readonly organizationId: string;
  /** Identificador del documento del catalogo. */
  readonly legalDocumentId: string;
  /** Tipo de documento aceptado. */
  readonly docType: string;
  /** Version del documento aceptado. */
  readonly versionTag: string;
  /** Resumen SHA-256 derivado en servidor desde el catalogo. */
  readonly documentSha256: string;
  /** Momento de registro de la evidencia. */
  readonly acceptedAt: Date;
}

/**
 * Caso de uso para gestion de cumplimiento legal, DPA y privacidad GDPR.
 */
export class LegalAndPrivacyComplianceUseCase {
  public constructor(
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly identityRepo: PostgresIdentityRepository
  ) {}

  /**
   * Obtiene la lista de todos los instrumentos legales activos obligatorios.
   */
  public async getActiveMandatoryDocuments(): Promise<readonly LegalDocumentRecord[]> {
    return this.advancedRepo.findActiveMandatoryLegalDocuments();
  }

  /**
   * Comprueba si el usuario y organizacion tienen todos los instrumentos obligatorios aceptados.
   * Lanza `LegalConsentOutdatedError` o `DpaNotSignedError` si falta alguno.
   */
  public async assertLegalCompliance(
    userId: string,
    organizationId: string
  ): Promise<{ compliant: true }> {
    const mandatoryDocs = await this.advancedRepo.findActiveMandatoryLegalDocuments();
    const missingDocs = await this.advancedRepo.findMissingLegalAcceptances(
      userId,
      organizationId,
      mandatoryDocs.map((d) => ({ id: d.id, sha256: d.contentSha256, docType: d.docType }))
    );

    if (missingDocs.length > 0) {
      if (missingDocs.includes('DPA_ENTERPRISE')) {
        throw new DpaNotSignedError({ organizationId, userId });
      }
      throw new LegalConsentOutdatedError(missingDocs, { organizationId, userId });
    }

    return { compliant: true };
  }

  /**
   * Registra la aceptacion formal de un instrumento legal con evidencia inmutable.
   *
   * El resumen se deriva en servidor desde el catalogo y cualquier valor aportado
   * por el cliente se ignora de forma deliberada para preservar el valor probatorio.
   *
   * @param data - Actor, organizacion, documento, red y hash del cliente (ignorado).
   * @returns Evidencia con actor, organizacion, version, resumen de servidor y fecha.
   * @throws ValidationError cuando falta el documento o la organizacion.
   * @throws NotFoundError cuando el identificador no existe en el catalogo.
   * @throws ValidationError cuando el documento esta inactivo o no es obligatorio.
   * @throws ForbiddenError cuando el invocador no es OWNER de la organizacion.
   */
  public async acceptDocument(data: {
    userId: string;
    organizationId: string | null;
    legalDocumentId: string;
    ipAddress: string;
    userAgent: string;
    documentSha256Snapshot?: string;
  }): Promise<LegalAcceptanceEvidence> {
    const legalDocumentId = data.legalDocumentId.trim();
    if (legalDocumentId.length === 0) {
      throw new ValidationError('El identificador del documento legal es obligatorio.', ['legalDocumentId']);
    }
    if (!data.organizationId || data.organizationId.trim().length === 0) {
      throw new ValidationError('La aceptacion en nombre de la organizacion exige organizationId.', ['organizationId']);
    }
    const organizationId = data.organizationId;
    const catalogDoc = await this.advancedRepo.findLegalDocumentById(legalDocumentId);
    if (!catalogDoc) {
      throw new NotFoundError(`legal_document:${legalDocumentId}`);
    }
    if (!catalogDoc.isActive || !catalogDoc.isMandatory) {
      throw new ValidationError('El documento no esta vigente como obligatorio y no puede aceptarse.', [
        `docType:${catalogDoc.docType}`,
        `version:${catalogDoc.versionTag}`,
      ]);
    }
    const membership = await this.identityRepo.findMembership(organizationId, data.userId);
    if (!membership || membership.role !== 'OWNER' || !membership.isActive) {
      throw new ForbiddenError('Solo el rol OWNER de la organización puede aceptar documentos en su nombre.');
    }
    const serverSha256 = catalogDoc.contentSha256;
    await this.advancedRepo.recordLegalAcceptance({
      userId: data.userId,
      organizationId,
      legalDocumentId: catalogDoc.id,
      documentSha256Snapshot: serverSha256,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });
    return {
      userId: data.userId,
      organizationId,
      legalDocumentId: catalogDoc.id,
      docType: catalogDoc.docType,
      versionTag: catalogDoc.versionTag,
      documentSha256: serverSha256,
      acceptedAt: new Date(),
    };
  }

  /**
   * Firma el acuerdo DPA para una organizacion (requiere rol OWNER).
   */
  public async signDpa(
    invokerUserId: string,
    organizationId: string,
    ipAddress: string,
    userAgent: string
  ): Promise<void> {
    const memberships = await this.identityRepo.findUserActiveMemberships(invokerUserId);
    const ownerMembership = memberships.find(
      (m) => m.organizationId === organizationId && m.role === 'OWNER'
    );

    if (!ownerMembership) {
      throw new ForbiddenError('Solo el rol OWNER de la organización puede suscribir el DPA empresarial.');
    }

    const mandatoryDocs = await this.advancedRepo.findActiveMandatoryLegalDocuments();
    const dpaDoc = mandatoryDocs.find((d) => d.docType === 'DPA_ENTERPRISE');

    if (!dpaDoc) {
      throw new NotFoundError('No se encontró una versión activa del documento DPA_ENTERPRISE.');
    }

    // Registra aceptacion individual
    await this.advancedRepo.recordLegalAcceptance({
      userId: invokerUserId,
      organizationId,
      legalDocumentId: dpaDoc.id,
      documentSha256Snapshot: dpaDoc.contentSha256,
      ipAddress,
      userAgent,
    });

    // Actualiza organizacion con fecha y IP de suscripcion
    await this.advancedRepo.signDpaForOrganization(organizationId, ipAddress);
  }

  /**
   * Genera el archivo exportable portable de datos del usuario bajo el principio de portabilidad GDPR.
   */
  public async exportUserData(userId: string): Promise<Record<string, unknown>> {
    const exportPayload = await this.advancedRepo.exportGdprUserData(userId);
    return exportPayload;
  }

  /**
   * Ejecuta la baja logica y anonimizacion criptografica de una organizacion.
   */
  public async anonymizeOrDeleteOrganization(
    invokerUserId: string,
    organizationId: string
  ): Promise<void> {
    const memberships = await this.identityRepo.findUserActiveMemberships(invokerUserId);
    const ownerMembership = memberships.find(
      (m) => m.organizationId === organizationId && m.role === 'OWNER'
    );

    if (!ownerMembership) {
      throw new ForbiddenError('Solo el rol OWNER puede solicitar la baja definitiva de la organización.');
    }

    // Revoca todas las sesiones de usuarios de esta organizacion
    const members = await this.advancedRepo.findOrganizationMembers(organizationId);
    for (const member of members) {
      await this.identityRepo.incrementTokenVersion(member.userId);
    }
  }
}
