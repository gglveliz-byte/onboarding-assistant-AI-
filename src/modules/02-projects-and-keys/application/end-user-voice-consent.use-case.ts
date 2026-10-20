/**
 * @archivo src/modules/02-projects-and-keys/application/end-user-voice-consent.use-case.ts
 * @modulo 02-projects-and-keys (Certificacion de Consentimiento de Voz de Usuarios Finales)
 * @proposito
 *   Permite que el cliente B2B certifique, con su clave secreta `sk_live_...`, que obtuvo el
 *   consentimiento de voz de un usuario final antes de activar el microfono. La evidencia queda
 *   versionada contra el documento legal vigente (`END_USER_VOICE_CONSENT`) con snapshot SHA-256,
 *   IP hasheada y metadatos aportados por el cliente. El owner acepta el instrumento marco en el
 *   alta; este caso de uso cubre la certificacion individual y revocable de cada usuario final.
 *
 * @resumen_contenido
 *   - Interfaces `RecordEndUserVoiceConsentInput` y `RecordEndUserVoiceConsentOutput`.
 *   - Clase `RecordEndUserVoiceConsentUseCase`:
 *       * Valida la clave secreta y el scope `voice:consent:write`.
 *       * Resuelve la version activa del aviso de consentimiento de voz.
 *       * Hace upsert idempotente en `end_user_voice_consents` dentro de RLS de organizacion.
 *       * Devuelve la evidencia registrada sin exponer datos internos del inquilino.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts).
 *   - `ValidateSecretApiKeyUseCase` (./api-key-lifecycle.use-case.ts).
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ForbiddenError`, `NotFoundError`, `ValidationError` (src/shared/kernel/result-and-errors.ts).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `legal_documents` (lectura), `end_user_voice_consents` (upsert con RLS).
 *   - Redis: cache de claves de API consumida por `ValidateSecretApiKeyUseCase`.
 */

import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/kernel/result-and-errors';
import { ValidateSecretApiKeyUseCase } from './api-key-lifecycle.use-case';

/** Scope exigido a la clave secreta para certificar consentimientos de voz. */
const REQUIRED_SCOPE = 'voice:consent:write';

/** Tamano maximo de la evidencia adicional aceptada por el endpoint. */
const MAX_EVIDENCE_BYTES = 8 * 1024;

/** Parametros para certificar el consentimiento de un usuario final. */
export interface RecordEndUserVoiceConsentInput {
  /** Clave secreta de backend (`sk_live_...` o `sk_test_...`). */
  readonly secretKey: string;
  /** Identificador pseudonimo del usuario final en el sistema del cliente. */
  readonly externalEndUserId: string;
  /** `true` si el usuario final otorgo el consentimiento; `false` si lo revoco. */
  readonly consentGranted: boolean;
  /** Instante en que el usuario final otorgo o revoco el consentimiento (ISO 8601). */
  readonly grantedAt?: string;
  /** Proyecto opcional; si se envia debe coincidir con el proyecto de la clave. */
  readonly projectId?: string;
  /** Evidencia adicional aportada por el cliente (origen, texto mostrado, metadatos). */
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** IP de origen de la peticion; se almacena unicamente su SHA-256. */
  readonly clientIp: string;
  /** User-Agent de la peticion para trazabilidad. */
  readonly userAgent: string;
}

/** Resultado de la certificacion del consentimiento. */
export interface RecordEndUserVoiceConsentOutput {
  readonly consentId: string;
  readonly externalEndUserId: string;
  readonly consentGranted: boolean;
  readonly documentVersion: string;
  readonly grantedAt: string;
  readonly recordedAt: string;
}

/**
 * Caso de uso: certifica el consentimiento de voz de un usuario final para una organizacion.
 */
export class RecordEndUserVoiceConsentUseCase {
  public constructor(
    private readonly rlsPool: RlsDatabasePool,
    private readonly validateSecretKeyUseCase: ValidateSecretApiKeyUseCase
  ) {}

  /**
   * Ejecuta la certificacion dentro de una transaccion aislada por organizacion.
   *
   * @param input - Clave secreta, identidad externa y evidencia del consentimiento.
   * @returns Evidencia registrada con la version documental aplicada.
   */
  public async execute(input: RecordEndUserVoiceConsentInput): Promise<RecordEndUserVoiceConsentOutput> {
    // 1. Autenticacion de la clave secreta y verificacion de scope.
    const keyResult = await this.validateSecretKeyUseCase.execute(input.secretKey, REQUIRED_SCOPE);
    if (!keyResult.ok) {
      throw keyResult.error;
    }
    const apiKey = keyResult.value;

    // 2. Validacion del proyecto declarado contra el proyecto de la clave.
    if (input.projectId !== undefined && input.projectId !== apiKey.projectId) {
      throw new ForbiddenError('La clave secreta no pertenece al proyecto indicado.');
    }

    // 3. Validacion de la identidad externa y de la evidencia.
    const externalEndUserId = input.externalEndUserId.trim();
    if (externalEndUserId.length === 0 || externalEndUserId.length > 255) {
      throw new ValidationError('`externalEndUserId` debe tener entre 1 y 255 caracteres.', ['externalEndUserId']);
    }
    const evidence = input.evidence ?? {};
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_EVIDENCE_BYTES) {
      throw new ValidationError(`La evidencia no puede superar ${MAX_EVIDENCE_BYTES} bytes.`, ['evidence']);
    }

    // 4. Normalizacion temporal: no se aceptan fechas futuras fuera del margen de reloj.
    const grantedAt = input.grantedAt === undefined ? new Date() : new Date(input.grantedAt);
    if (Number.isNaN(grantedAt.getTime())) {
      throw new ValidationError('`grantedAt` debe ser una fecha ISO 8601 valida.', ['grantedAt']);
    }
    if (grantedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new ValidationError('`grantedAt` no puede estar en el futuro.', ['grantedAt']);
    }

    const clientIpHash = CryptoUtils.sha256Hex(input.clientIp.trim() || 'unknown');
    const userAgent = input.userAgent.trim().slice(0, 1024) || 'Unknown';

    // 5. Upsert idempotente en el contexto RLS de la organizacion propietaria de la clave.
    return this.rlsPool.runInTenantTransaction(
      { organizationId: apiKey.organizationId },
      async (client) => {
        const docResult = await client.query<{
          id: string;
          version_tag: string;
          content_sha256: string;
        }>(
          `SELECT id, version_tag, content_sha256
             FROM legal_documents
            WHERE doc_type = 'END_USER_VOICE_CONSENT' AND is_active = TRUE
            ORDER BY published_at DESC
            LIMIT 1`
        );
        const document = docResult.rows[0];
        if (!document) {
          throw new NotFoundError('No hay una version activa del aviso de consentimiento de voz para usuarios finales.');
        }

        const upsert = await client.query<{
          id: string;
          granted_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO end_user_voice_consents (
             organization_id, project_id, api_key_id, external_end_user_id,
             legal_document_id, document_version_tag, document_sha256_snapshot,
             consent_granted, granted_at, client_ip_hash, user_agent, evidence_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           ON CONFLICT (organization_id, project_id, external_end_user_id, legal_document_id)
           DO UPDATE SET
             api_key_id = EXCLUDED.api_key_id,
             document_version_tag = EXCLUDED.document_version_tag,
             document_sha256_snapshot = EXCLUDED.document_sha256_snapshot,
             consent_granted = EXCLUDED.consent_granted,
             granted_at = EXCLUDED.granted_at,
             client_ip_hash = EXCLUDED.client_ip_hash,
             user_agent = EXCLUDED.user_agent,
             evidence_json = EXCLUDED.evidence_json
           RETURNING id, granted_at, updated_at`,
          [
            apiKey.organizationId,
            apiKey.projectId,
            apiKey.apiKeyId,
            externalEndUserId,
            document.id,
            document.version_tag,
            document.content_sha256,
            input.consentGranted,
            grantedAt,
            clientIpHash,
            userAgent,
            JSON.stringify(evidence),
          ]
        );
        const row = upsert.rows[0];
        if (!row) {
          throw new Error('No fue posible registrar la evidencia de consentimiento.');
        }

        return {
          consentId: row.id,
          externalEndUserId,
          consentGranted: input.consentGranted,
          documentVersion: document.version_tag,
          grantedAt: row.granted_at.toISOString(),
          recordedAt: row.updated_at.toISOString(),
        };
      }
    );
  }
}
