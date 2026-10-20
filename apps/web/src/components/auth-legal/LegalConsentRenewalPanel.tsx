/**
 * @archivo apps/web/src/components/auth-legal/LegalConsentRenewalPanel.tsx
 * @modulo apps/web (Autenticación B2B — Renovación del Consentimiento Legal Pre-Sesión)
 * @proposito
 *   Panel interactivo del login para renovar el consentimiento legal sin sesión: recibe el reto
 *   `LEGAL_CONSENT_REQUIRED` emitido tras verificar credenciales, registra la aceptación de los
 *   documentos pendientes contra `POST /api/v1/legal/accept-pre-session` y devuelve el control al
 *   formulario para reintentar el inicio de sesión. Incluye el panel informativo heredado del
 *   bloqueo 403 para respuestas antiguas del plano de control.
 *
 * @resumen_contenido
 *   - `PendingLegalDocument`: proyección del documento pendiente (id, tipo, título, versión).
 *   - `LegalConsentChallenge`: token efímero y documentos que exige el servidor.
 *   - `LegalConsentRenewalPanel`: checkboxes, enlaces al visor legal y aceptación con evidencia.
 *   - `LegalConsentBlockedPanel`: fallback informativo para códigos 403 heredados.
 *
 * @dependencias_internas
 *   - `authApiFetch` (`./auth-api-client`).
 *   - `AtelierPrimaryButton` (`../atelier-primitives/AtelierUiPrimitives`).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks).
 */

'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { AtelierPrimaryButton } from '../atelier-primitives/AtelierUiPrimitives';
import { authApiFetch } from './auth-api-client';

/** Documento obligatorio pendiente devuelto por el reto de login. */
export interface PendingLegalDocument {
  readonly id: string;
  readonly docType: string;
  readonly title: string;
  readonly versionTag: string;
}

/** Reto efímero pre-sesión que habilita la renovación del consentimiento. */
export interface LegalConsentChallenge {
  readonly consentChallengeToken: string;
  readonly pendingDocuments: readonly PendingLegalDocument[];
}

/** Enlace público del visor legal por tipo de documento. */
const LEGAL_DOCUMENT_PATHS: Readonly<Record<string, string>> = {
  TOS_B2B: '/legal/tos-b2b',
  PRIVACY_POLICY: '/legal/privacy-policy',
  DPA_ENTERPRISE: '/legal/dpa-enterprise',
  AI_VOICE_AUP: '/legal/ai-voice-aup',
  END_USER_VOICE_CONSENT: '/legal/end-user-voice-consent',
};

/** Ruta del plano de control que registra la aceptación antes de emitir sesión. */
const ACCEPT_PRE_SESSION_PATH = '/api/v1/legal/accept-pre-session';

/** Convierte el código técnico en una etiqueta legible si el servidor no enviara título. */
function fallbackDocumentTitle(docType: string): string {
  return docType.split('_').join(' ').toLowerCase();
}

/**
 * Panel interactivo de renovación legal pre-sesión.
 *
 * @param props - Reto vigente, estado del reintento de login y callbacks de éxito/cancelación.
 * @returns Tarjeta Atelier con documentos, aceptación explícita y acción de continuar.
 */
export function LegalConsentRenewalPanel(props: {
  readonly challenge: LegalConsentChallenge;
  readonly isRetrying: boolean;
  readonly onAccepted: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { challenge, isRetrying, onAccepted, onCancel } = props;
  const [hasAccepted, setHasAccepted] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleAccept = async (): Promise<void> => {
    if (isSubmitting || isRetrying || !hasAccepted) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await authApiFetch<{ accepted?: boolean; pendingDocuments?: readonly PendingLegalDocument[] }>(
      ACCEPT_PRE_SESSION_PATH,
      {
        method: 'POST',
        body: {
          consentChallengeToken: challenge.consentChallengeToken,
          legalDocumentIds: challenge.pendingDocuments.map((document) => document.id),
        },
      }
    );
    setIsSubmitting(false);
    if (!result.ok) {
      setErrorMessage(
        result.status === 401
          ? 'La ventana de renovación expiró. Vuelve a ingresar tus credenciales para generar un reto nuevo.'
          : result.errorMessage ?? 'No fue posible registrar el consentimiento. Inténtalo de nuevo.'
      );
      return;
    }
    const remainingDocuments = result.data?.pendingDocuments ?? [];
    if (remainingDocuments.length > 0) {
      setErrorMessage('Aún quedan documentos pendientes. Vuelve a ingresar tus credenciales para generar un reto nuevo.');
      return;
    }
    onAccepted();
  };

  const isBusy = isSubmitting || isRetrying;

  return (
    <section className="atelier-card" role="alert" style={{ borderColor: 'var(--color-crimson)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <p className="atelier-eyebrow" style={{ color: 'var(--color-crimson)', margin: 0 }}>Consentimiento legal pendiente</p>
      <h2 className="atelier-heading-sm" style={{ color: 'var(--color-crimson)' }}>Renueva el consentimiento para continuar</h2>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood)' }}>
        Tus credenciales son correctas. Antes de emitir la sesión, acepta la versión vigente de los documentos que tu organización aún no ha registrado:
      </p>
      <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {challenge.pendingDocuments.map((document): ReactElement => {
          const href = LEGAL_DOCUMENT_PATHS[document.docType];
          return (
            <li key={document.id} style={{ fontSize: '13px', color: 'var(--color-ink)' }}>
              {href === undefined ? (
                <span>{document.title || fallbackDocumentTitle(document.docType)}</span>
              ) : (
                <a className="atelier-link" href={href} target="_blank" rel="noreferrer">
                  {document.title || fallbackDocumentTitle(document.docType)}
                </a>
              )}
              <span className="atelier-mono" style={{ marginLeft: '6px', fontSize: '10.5px', color: 'var(--color-driftwood)' }}>{document.versionTag}</span>
            </li>
          );
        })}
      </ul>
      <label className="atelier-checkbox-row" style={{ alignItems: 'flex-start', gap: '6px', cursor: 'pointer' }}>
        <input type="checkbox" style={{ marginTop: '2px', cursor: 'pointer' }} checked={hasAccepted} disabled={isBusy} onChange={(event): void => setHasAccepted(event.currentTarget.checked)} />
        <span style={{ fontSize: '12px' }}>
          He leído y acepto los documentos pendientes en nombre de mi organización. La aceptación queda sellada con SHA-256, fecha, IP y agente del navegador.
        </span>
      </label>
      {errorMessage === null ? null : <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{errorMessage}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
        <AtelierPrimaryButton type="button" disabled={isBusy || !hasAccepted} onClick={(): void => void handleAccept()}>
          {isSubmitting ? 'Registrando consentimiento…' : isRetrying ? 'Reintentando sesión…' : 'Aceptar y continuar'}
        </AtelierPrimaryButton>
        <button type="button" className="atelier-link" disabled={isBusy} onClick={onCancel}>Cancelar</button>
      </div>
      <p className="atelier-help-text" style={{ margin: 0 }}>
        Al continuar, la plataforma reintenta el inicio de sesión automáticamente. Si tu cuenta exige segundo factor, se solicitará a continuación.
      </p>
    </section>
  );
}

/** Bloqueo legal 403 (fallback heredado): enlaces al visor legal público y nota de renovación. */
export function LegalConsentBlockedPanel(props: { readonly errorCode: 'LEGAL_CONSENT_OUTDATED' | 'DPA_NOT_SIGNED' }): ReactElement {
  return (
    <section className="atelier-card" role="alert" style={{ borderColor: 'var(--color-crimson)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <p className="atelier-eyebrow" style={{ color: 'var(--color-crimson)', margin: 0 }}>Consentimiento legal pendiente</p>
      <h2 className="atelier-heading-sm" style={{ color: 'var(--color-crimson)' }}>Tu organización debe renovar el consentimiento</h2>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood)' }}>
        Para continuar, tu organización necesita aceptar la versión vigente de los documentos legales. Puedes consultarlos aquí:
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <a className="atelier-link" href="/legal/tos-b2b">Condiciones del servicio B2B</a>
        <a className="atelier-link" href="/legal/privacy-policy">Política de privacidad</a>
        {props.errorCode === 'DPA_NOT_SIGNED' ? <a className="atelier-link" href="/legal/dpa-enterprise">Acuerdo de tratamiento de datos (DPA)</a> : null}
      </div>
      <p className="atelier-help-text" style={{ margin: 0 }}>
        Un responsable de tu organización debe firmar la renovación; después podrás iniciar sesión con normalidad.
      </p>
    </section>
  );
}
