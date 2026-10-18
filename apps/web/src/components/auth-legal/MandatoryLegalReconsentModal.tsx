/**
 * @archivo apps/web/src/components/auth-legal/MandatoryLegalReconsentModal.tsx
 * @modulo apps/web (Cumplimiento Legal Bloqueante de Auth y Paneles)
 * @proposito
 *   Modal BLOQUEANTE de re-consentimiento ToS/DPA que detiene toda la aplicación cuando el
 *   backend responde `LEGAL_CONSENT_OUTDATED` o `DPA_NOT_SIGNED`: carga el catálogo público
 *   (`GET /api/v1/legal/documents`), presenta cada documento con su sello SHA-256 y registra
 *   la aceptación formal (`POST /api/v1/legal/accept` con `{ legalDocumentId }` o
 *   `POST /api/v1/legal/dpa/sign`). Única salida: aceptar con checkbox o «Cerrar sesión».
 *
 * @resumen_contenido
 *   - Exports congelados: `LegalReconsentOutcome`, `MandatoryLegalReconsentModalProps`,
 *     `isLegalReconsentErrorCode()` y `MandatoryLegalReconsentModal` (estado «inicia sesión
 *     para firmar», checkbox obligatoria y sello derivado en servidor).
 *
 * @dependencias_internas
 *   - `LegalDocumentBody`, `abbreviateSha256`, `parseLegalDocumentsEnvelope` y `LegalDocumentDto`
 *     (`./LegalDocumentViewer`): modelo y render editorial compartidos de la familia legal.
 *   - `AtelierForestConfirmButton`, `AtelierSecondaryButton`, `MonoMetadataTag`
 *     (`../atelier-primitives/AtelierUiPrimitives`) y clases `.atelier-*` del CSS Atelier.
 *
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks). Prohibido `next/*` y librerías de Markdown.
 *
 * @tablas_bd_o_redis
 *   - Consume endpoints legales del módulo 01-identity-and-rbac (TENANT_SESSION, rol OWNER).
 */

'use client';

import type { ChangeEvent, CSSProperties, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  AtelierForestConfirmButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
} from '../atelier-primitives/AtelierUiPrimitives';
import {
  LegalDocumentBody,
  abbreviateSha256,
  parseLegalDocumentsEnvelope,
  type LegalDocumentDto,
} from './LegalDocumentViewer';

/** Resultado inmutable de una re-aceptación legal exitosa. Contrato congelado. */
export interface LegalReconsentOutcome {
  readonly acceptedDocumentCodes: readonly string[];
  readonly acceptedAtIso: string;
}

/** Propiedades del modal bloqueante de re-consentimiento. Contrato congelado. */
export interface MandatoryLegalReconsentModalProps {
  readonly isOpen: boolean;
  readonly outdatedDocumentCodes: readonly string[];
  readonly failureMode: 'LEGAL_CONSENT_OUTDATED' | 'DPA_NOT_SIGNED';
  readonly accessToken: string | null;
  readonly organizationId: string | null;
  readonly onAccepted: (outcome: LegalReconsentOutcome) => void;
  readonly onSignOut: () => void;
}

/**
 * Indica si un código de error del backend exige el modal de re-consentimiento legal.
 *
 * @param code - Código público devuelto por el backend (o `null`).
 * @returns `true` para `LEGAL_CONSENT_OUTDATED`, `DPA_NOT_SIGNED` y el alias `DPAS_NOT_SIGNED`.
 */
export function isLegalReconsentErrorCode(code: string | null): boolean {
  return code === 'LEGAL_CONSENT_OUTDATED' || code === 'DPA_NOT_SIGNED' || code === 'DPAS_NOT_SIGNED';
}

/** Evidencia de aceptación devuelta por `POST /api/v1/legal/accept`. */
interface LegalAcceptanceEvidenceDto {
  readonly documentSha256: string | null;
  readonly acceptedAtIso: string | null;
}

/** Documento pendiente emparejado (o no) contra el catálogo vigente. */
interface PendingLegalDocument {
  readonly code: string;
  readonly document: LegalDocumentDto | null;
}

/** Resultado tipado de un intento de firma (aceptación individual o DPA). */
type LegalSignAttempt =
  | { readonly kind: 'accepted'; readonly documentSha256: string | null; readonly acceptedAtIso: string | null }
  | { readonly kind: 'signed' }
  | { readonly kind: 'rejected'; readonly message: string };

/** Constantes de estilo compartidas por los paneles y tarjetas del modal. */
const PANEL_BASE_STYLE: CSSProperties = {
  border: '1px solid var(--color-stone, #cdcdc9)',
  borderRadius: '4px',
  padding: '12px',
  marginTop: '16px',
};
const PANEL_NOTICE_STYLE: CSSProperties = { ...PANEL_BASE_STYLE, backgroundColor: 'var(--color-linen, #e6e5e0)' };
const PANEL_ALERT_STYLE: CSSProperties = { ...PANEL_BASE_STYLE, borderColor: 'var(--color-crimson, #cf2d56)' };
const PANEL_SUCCESS_STYLE: CSSProperties = { ...PANEL_BASE_STYLE, borderColor: 'var(--color-forest, #34785c)' };
const CARD_STYLE: CSSProperties = { padding: '14px' };
const META_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginTop: '8px' };
const DOCUMENT_LIST_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '36vh', overflowY: 'auto', overscrollBehavior: 'contain', marginTop: '14px', paddingRight: '4px', WebkitOverflowScrolling: 'touch' };
const MONO_HASH_STYLE: CSSProperties = { margin: '8px 0 0', color: 'var(--color-driftwood, #84847e)', overflowWrap: 'anywhere' };
const SUCCESS_HASH_STYLE: CSSProperties = { margin: '8px 0 0', color: 'var(--color-driftwood, #84847e)' };

/** Verifica si un valor JSON es un objeto indexable no nulo. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lee un campo de texto de un objeto JSON; devuelve `null` si no es cadena. */
function readStringField(record: Readonly<Record<string, unknown>>, fieldName: string): string | null {
  const value = record[fieldName];
  return typeof value === 'string' ? value : null;
}

/** Parsea la evidencia `{ evidence: {...} }` de `POST /api/v1/legal/accept`. */
function parseAcceptanceEvidence(payload: unknown): LegalAcceptanceEvidenceDto {
  const ev = isRecord(payload) && isRecord(payload['evidence']) ? payload['evidence'] : null;
  return { documentSha256: ev ? readStringField(ev, 'documentSha256') : null, acceptedAtIso: ev ? readStringField(ev, 'acceptedAt') : null };
}

/** Extrae el mensaje legible del sobre estándar de error del backend. */
function extractBackendErrorMessage(payload: unknown, fallbackMessage: string): string {
  const err = isRecord(payload) && isRecord(payload['error']) ? payload['error'] : null;
  return err ? (readStringField(err, 'message') ?? fallbackMessage) : fallbackMessage;
}

/** Intenta leer el cuerpo JSON de una respuesta sin propagar errores de parseo. */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Carga el catálogo público de documentos obligatorios vigentes. */
async function fetchActiveLegalDocuments(accessToken: string | null): Promise<readonly LegalDocumentDto[]> {
  const headers: Record<string, string> = accessToken === null
    ? { Accept: 'application/json' }
    : { Accept: 'application/json', Authorization: `Bearer ${accessToken}` };
  const response = await fetch('/api/v1/legal/documents', { method: 'GET', headers, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`El catálogo legal respondió con estado ${response.status}.`);
  }
  return parseLegalDocumentsEnvelope(await response.json());
}

/**
 * Registra la aceptación de un documento. DTO exacto del manifest: `{ legalDocumentId }`
 * (la organización y el sello SHA-256 se derivan en servidor desde la sesión y el catálogo).
 */
async function postLegalDocumentAcceptance(accessToken: string, legalDocumentId: string): Promise<LegalSignAttempt> {
  const response = await fetch('/api/v1/legal/accept', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ legalDocumentId }),
  });
  const payload: unknown = await readJsonSafely(response);
  if (!response.ok) {
    const fallbackMessage = `No fue posible registrar la aceptación (estado ${response.status}).`;
    return { kind: 'rejected', message: extractBackendErrorMessage(payload, fallbackMessage) };
  }
  const evidence = parseAcceptanceEvidence(payload);
  return { kind: 'accepted', documentSha256: evidence.documentSha256, acceptedAtIso: evidence.acceptedAtIso };
}

/**
 * Firma el DPA empresarial: el manifest ignora el cuerpo (organización, rol OWNER y sello se
 * derivan en servidor) y la respuesta exitosa es `{ dpaSigned: true }`.
 */
async function postDpaEnterpriseSignature(accessToken: string): Promise<LegalSignAttempt> {
  const response = await fetch('/api/v1/legal/dpa/sign', {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const payload: unknown = await readJsonSafely(response);
    const fallbackMessage = `No fue posible firmar el DPA (estado ${response.status}).`;
    return { kind: 'rejected', message: extractBackendErrorMessage(payload, fallbackMessage) };
  }
  return { kind: 'signed' };
}

/**
 * Modal bloqueante de re-consentimiento legal: sin botón de cierre, checkbox obligatoria,
 * acción principal según `failureMode` y sello SHA-256 derivado en servidor.
 */
export function MandatoryLegalReconsentModal(props: MandatoryLegalReconsentModalProps): ReactElement | null {
  const [documents, setDocuments] = useState<readonly LegalDocumentDto[] | null>(null);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(null);
  const [acceptedOutcome, setAcceptedOutcome] = useState<LegalReconsentOutcome | null>(null);
  const [sealSha256, setSealSha256] = useState<string | null>(null);

  const outdatedCodesKey = props.outdatedDocumentCodes.join('|');

  // Al cambiar los códigos pendientes (nueva oleada de documentos) se reinicia la firma.
  useEffect(() => {
    setHasAcceptedTerms(false);
    setSubmitErrorMessage(null);
    setAcceptedOutcome(null);
    setSealSha256(null);
  }, [outdatedCodesKey, props.failureMode]);

  // Carga única del catálogo público; el reintento se controla con `loadErrorMessage`.
  useEffect(() => {
    let isCancelled = false;
    if (props.isOpen && documents === null && loadErrorMessage === null) {
      void fetchActiveLegalDocuments(props.accessToken)
        .then((loadedDocuments) => {
          if (!isCancelled) {
            setDocuments(loadedDocuments);
          }
        })
        .catch((error: unknown) => {
          if (!isCancelled) {
            setDocuments([]);
            setLoadErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar el catálogo legal.');
          }
        });
    }
    return (): void => {
      isCancelled = true;
    };
  }, [props.isOpen, props.accessToken, documents, loadErrorMessage]);

  const pendingDocuments: readonly PendingLegalDocument[] = (props.outdatedDocumentCodes.length > 0
    ? props.outdatedDocumentCodes
    : props.failureMode === 'DPA_NOT_SIGNED'
      ? ['DPA_ENTERPRISE']
      : []
  ).map((code): PendingLegalDocument => {
    const catalog = documents ?? [];
    return { code, document: catalog.find((item) => item.docType === code) ?? null };
  });

  const hasResolvableDocuments = pendingDocuments.some((pending) => pending.document !== null);

  const canSubmit = props.accessToken !== null && hasAcceptedTerms && !isSubmitting &&
    acceptedOutcome === null && (props.failureMode === 'DPA_NOT_SIGNED' || hasResolvableDocuments);

  /** Reintenta la carga del catálogo reiniciando los estados de carga y error. */
  const handleReloadCatalog = (): void => {
    setDocuments(null);
    setLoadErrorMessage(null);
  };

  /** Actualiza el consentimiento explícito del checkbox obligatorio. */
  const handleCheckboxChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setHasAcceptedTerms(event.target.checked);
  };

  /** Orquesta la firma según `failureMode` y entrega el resultado al consumidor del contrato. */
  const handleSubmitAcceptance = (): void => {
    const accessToken = props.accessToken;
    if (!canSubmit || accessToken === null) {
      return;
    }
    setIsSubmitting(true);
    setSubmitErrorMessage(null);

    const executeAcceptance = async (): Promise<void> => {
      if (props.failureMode === 'DPA_NOT_SIGNED') {
        const dpaAttempt = await postDpaEnterpriseSignature(accessToken);
        if (dpaAttempt.kind === 'rejected') {
          setSubmitErrorMessage(dpaAttempt.message);
          return;
        }
        // El endpoint DPA no devuelve marca temporal ni sello: se anota la hora local.
        const outcome: LegalReconsentOutcome = {
          acceptedDocumentCodes: ['DPA_ENTERPRISE'],
          acceptedAtIso: new Date().toISOString(),
        };
        setSealSha256(null);
        setAcceptedOutcome(outcome);
        props.onAccepted(outcome);
        return;
      }

      if (!hasResolvableDocuments) {
        setSubmitErrorMessage('No fue posible resolver los documentos pendientes en el catálogo legal vigente.');
        return;
      }

      const acceptedCodes: string[] = [];
      let lastAcceptedAtIso: string | null = null;
      let lastSealSha256: string | null = null;

      for (const pending of pendingDocuments) {
        const legalDocument = pending.document;
        if (legalDocument === null) {
          continue;
        }
        const attempt = await postLegalDocumentAcceptance(accessToken, legalDocument.id);
        if (attempt.kind === 'rejected') {
          setSubmitErrorMessage(attempt.message);
          return;
        }
        if (attempt.kind === 'accepted') {
          acceptedCodes.push(pending.code);
          lastAcceptedAtIso = attempt.acceptedAtIso ?? lastAcceptedAtIso;
          lastSealSha256 = attempt.documentSha256 ?? lastSealSha256;
        }
      }

      // El servidor devuelve `acceptedAt`; si faltara, se anota la marca local.
      const outcome: LegalReconsentOutcome = {
        acceptedDocumentCodes: acceptedCodes,
        acceptedAtIso: lastAcceptedAtIso ?? new Date().toISOString(),
      };
      setSealSha256(lastSealSha256);
      setAcceptedOutcome(outcome);
      props.onAccepted(outcome);
    };

    void executeAcceptance().finally((): void => {
      setIsSubmitting(false);
    });
  };

  const renderPendingDocument = (pending: PendingLegalDocument): ReactElement => {
    const legalDocument = pending.document;
    if (legalDocument === null) {
      return (
        <article key={pending.code} className="atelier-card" style={{ ...CARD_STYLE, padding: '12px' }}>
          <h3 className="atelier-heading-sm" style={{ fontSize: '15px', fontWeight: 400 }}>{pending.code}</h3>
          <p className="atelier-help-text" style={{ margin: '6px 0 0', color: 'var(--color-driftwood, #84847e)' }}>
            No hay una versión vigente disponible en el catálogo público para este instrumento.
          </p>
        </article>
      );
    }
    return (
      <article key={pending.code} className="atelier-card" style={{ ...CARD_STYLE, padding: '12px' }}>
        <details {...(pendingDocuments.length <= 1 ? { open: true } : {})} style={{ cursor: 'pointer' }}>
          <summary style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <h3 className="atelier-heading-sm" style={{ fontSize: '15px', fontWeight: 400, margin: 0 }}>{legalDocument.title}</h3>
            <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>Detalles ▼</span>
          </summary>
          <div style={META_ROW_STYLE}>
            <MonoMetadataTag label="Código" value={legalDocument.docType} />
            {legalDocument.versionTag === null ? null : (
              <MonoMetadataTag label="Versión" value={legalDocument.versionTag} />
            )}
            {legalDocument.contentSha256 === null ? null : (
              <MonoMetadataTag label="SHA-256" value={abbreviateSha256(legalDocument.contentSha256)} tone="accent" />
            )}
          </div>
          <div
            className="atelier-scrollarea"
            style={{
              marginTop: '10px',
              maxHeight: '120px',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              WebkitOverflowScrolling: 'touch',
              padding: '10px',
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
            }}
          >
            <LegalDocumentBody markdown={legalDocument.contentMarkdown} />
          </div>
          {legalDocument.contentSha256 === null ? (
            <p className="atelier-help-text" style={{ margin: '8px 0 0', color: 'var(--color-driftwood, #84847e)' }}>
              El sello SHA-256 se emitirá en la firma.
            </p>
          ) : (
            <p className="atelier-mono" style={{ ...MONO_HASH_STYLE, margin: '8px 0 0' }}>{legalDocument.contentSha256}</p>
          )}
        </details>
      </article>
    );
  };

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className="atelier-modal-overlay">
      <section
        className="atelier-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atelier-legal-reconsent-title"
        style={{
          maxWidth: '640px',
          maxHeight: 'calc(100dvh - 32px)',
          display: 'flex',
          flexDirection: 'column',
          padding: 'clamp(14px, 3vw, 24px)',
        }}
      >
        <header>
          <p className="atelier-eyebrow" style={{ marginBottom: '6px' }}>Cumplimiento legal obligatorio</p>
          <h2 id="atelier-legal-reconsent-title" className="atelier-modal__title">
            Actualización de instrumentos legales
          </h2>
        </header>

        <div className="atelier-modal__body" style={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: '1 1 auto', minHeight: 0 }}>
          <p className="atelier-prose" style={{ marginTop: 0 }}>
            {props.failureMode === 'DPA_NOT_SIGNED'
              ? 'La organización requiere firmar el Acuerdo de Procesamiento de Datos (DPA) vigente para continuar. La firma quedará registrada con evidencia de auditoría.'
              : 'Los instrumentos legales fueron actualizados. Revisa y acepta las versiones vigentes para continuar usando la plataforma.'}
          </p>
          {props.organizationId === null ? null : (
            <p className="atelier-help-text" style={{ margin: '8px 0 0' }}>
              Firma en nombre de la organización{' '}
              <span className="atelier-mono" style={{ overflowWrap: 'anywhere' }}>{props.organizationId}</span>.
            </p>
          )}

          {props.accessToken === null ? (
            <div role="status" style={PANEL_NOTICE_STYLE}>
              <p className="atelier-mono" style={{ margin: 0 }}>SESIÓN REQUERIDA — inicia sesión para firmar.</p>
              <p className="atelier-help-text" style={{ margin: '6px 0 0' }}>
                La aceptación requiere una sesión activa con rol OWNER de la organización; este cuadro
                nunca captura credenciales.
              </p>
            </div>
          ) : null}

          {loadErrorMessage === null ? null : (
            <div role="alert" style={PANEL_ALERT_STYLE}>
              <p className="atelier-error-text" style={{ margin: 0 }}>{loadErrorMessage}</p>
              <div style={{ marginTop: '8px' }}>
                <AtelierSecondaryButton onClick={handleReloadCatalog}>Reintentar carga</AtelierSecondaryButton>
              </div>
            </div>
          )}

          {documents === null || loadErrorMessage !== null ? null : (
            <div className="atelier-scrollarea" style={DOCUMENT_LIST_STYLE}>
              {pendingDocuments.length === 0 ? (
                <p className="atelier-help-text" style={{ margin: 0 }}>
                  No hay documentos pendientes por resolver con el catálogo vigente.
                </p>
              ) : (
                pendingDocuments.map((pending) => renderPendingDocument(pending))
              )}
            </div>
          )}

          {acceptedOutcome === null ? null : (
            <div role="status" style={PANEL_SUCCESS_STYLE}>
              <p style={{ margin: 0, color: 'var(--color-forest, #34785c)' }}>Aceptación registrada correctamente.</p>
              {sealSha256 === null ? null : <MonoMetadataTag label="SHA-256" value={sealSha256} tone="accent" />}
              <p className="atelier-mono" style={SUCCESS_HASH_STYLE}>
                {sealSha256 === null ? 'Sello registrado en servidor.' : `document_sha256_snapshot: ${sealSha256}`}
              </p>
              <p className="atelier-help-text" style={{ margin: '4px 0 0' }}>
                Registrado en {acceptedOutcome.acceptedAtIso}
              </p>
            </div>
          )}

          {submitErrorMessage === null ? null : (
            <p role="alert" className="atelier-error-text" style={{ margin: '12px 0 0' }}>{submitErrorMessage}</p>
          )}

          {props.accessToken === null || acceptedOutcome !== null ? null : (
            <label className="atelier-checkbox-row" style={{ marginTop: '16px', padding: '10px 12px', backgroundColor: 'var(--color-bone, #f2f1ed)', border: '1px solid var(--color-stone, #cdcdc9)', borderRadius: '4px' }}>
              <input type="checkbox" checked={hasAcceptedTerms} onChange={handleCheckboxChange} style={{ accentColor: 'var(--color-ink, #26251e)' }} />
              <span style={{ fontSize: '14px', lineHeight: 1.4, color: 'var(--color-ink, #26251e)' }}>
                {props.failureMode === 'DPA_NOT_SIGNED'
                  ? 'He leído y acepto firmar el DPA vigente en nombre de la organización.'
                  : 'He leído y acepto los documentos legales vigentes mostrados arriba.'}
              </span>
            </label>
          )}
        </div>

        <footer className="atelier-modal__actions" style={{ flexShrink: 0, marginTop: '12px', display: 'flex', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', gap: '8px' }}>
          <AtelierSecondaryButton onClick={props.onSignOut}>Cerrar sesión</AtelierSecondaryButton>
          <AtelierForestConfirmButton onClick={handleSubmitAcceptance} disabled={!canSubmit}>
            {isSubmitting ? 'Firmando…' : acceptedOutcome === null ? 'Firmar y continuar' : 'Aceptación registrada'}
          </AtelierForestConfirmButton>
        </footer>
      </section>
    </div>
  );
}
