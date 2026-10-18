/**
 * @archivo apps/web/src/components/auth-legal/MfaChallengeAndEnrollmentModal.tsx
 * @modulo 08. Frontend Compartido — Acceso y Cumplimiento (reto MFA y enrolamiento)
 * @proposito
 *   Resuelve en el cliente el estado 202 `mfa_required` del backend: presenta el reto de
 *   segundo factor (aplicación autenticadora TOTP, código de recuperación y llave física
 *   FIDO2 degradable) y un asistente de enrolamiento guiado que nunca fabrica secretos ni
 *   códigos de recuperación en el navegador.
 *
 * @resumen_contenido
 *   - `MfaChallengeAndEnrollmentModalProps`: contrato congelado que consume el Subagente 2.3.
 *   - `MfaChallengeAndEnrollmentModal`: modal de radio 8px (`.atelier-modal-overlay` +
 *     `.atelier-modal`), pestañas de factor, auto-envío del TOTP de 6 dígitos, limpieza y
 *     aviso tras 3 fallos, envío unificado a `POST /api/v1/auth/mfa/verify` (que emite la
 *     sesión completa) y asistente «Configurar segundo factor» hacia
 *     `POST /api/v1/auth/mfa/enroll/totp` (degradable) con su cuadrícula de 10 códigos.
 *
 * @dependencias_internas
 *   - `./auth-api-client` (contrato real del Subagente 2.2, verificado en integración):
 *     `authApiFetch` con su sobre `AuthApiResult<T>` (nunca lanza), `buildSessionProfile` y
 *     los tipos `AuthSessionUserProfile`, `BackendPublicUser` y `BackendPublicOrganization`.
 *   - `../atelier-primitives/AtelierUiPrimitives`: botones Atelier y `MonoMetadataTag`.
 *
 * @dependencias_externas
 *   - Solo `react` (`ReactElement`, `FormEvent` y hooks). Prohibido `next/*` e iconotecas.
 *
 * @notas
 *   - Desviación: el backend sellado (Parte 5) no expone `/mfa/webauthn/challenge` ni
 *     `/mfa/enroll/totp`; ante 404/405 la interfaz degrada con un aviso honesto.
 *   - El backend emite códigos `XXXX-XXXX` (8 alfanuméricos base62); el normalizador acepta
 *     8 o 12 alfanuméricos, fuerza mayúsculas y auto-guiona cada 4.
 */

'use client';

import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtelierPrimaryButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
} from '../atelier-primitives/AtelierUiPrimitives';
import {
  authApiFetch,
  buildSessionProfile,
  type AuthSessionUserProfile,
  type BackendPublicOrganization,
  type BackendPublicUser,
} from './auth-api-client';

// Rutas del contrato real del backend y de las rutas degradables del plan.
const MFA_VERIFY_PATH = '/api/v1/auth/mfa/verify';
const MFA_ENROLL_PATH = '/api/v1/auth/mfa/enroll/totp';
const WEBAUTHN_CHALLENGE_PATH = '/api/v1/auth/mfa/webauthn/challenge';

// Constantes de formato y umbrales de la experiencia.
const TOTP_CODE_LENGTH = 6;
const RECOVERY_CODE_MIN_ALPHANUMERIC = 8;
const RECOVERY_CODE_MAX_ALPHANUMERIC = 12;
const FAILURE_WARNING_THRESHOLD = 3;
const RECOVERY_CODES_TOTAL = 10;

/** Método de canje aceptado por `POST /api/v1/auth/mfa/verify`. */
type MfaVerifyMethod = 'TOTP' | 'RECOVERY_CODE';
/** Pestaña activa del reto: métodos de canje más la llave física degradable. */
type MfaTabMethod = MfaVerifyMethod | 'WEBAUTHN';
/** Estado del intento con llave física (FIDO2). */
type WebAuthnAttemptState = 'IDLE' | 'RUNNING' | 'UNAVAILABLE' | 'FAILED';
/** Emisión del enrolamiento cuando el canal está habilitado. */
interface MfaEnrollmentIssue {
  readonly secretBase32: string;
  readonly recoveryCodes: readonly string[];
}

/** Propiedades del modal de reto MFA y enrolamiento (contrato congelado para el Subagente 2.3). */
export interface MfaChallengeAndEnrollmentModalProps {
  readonly isOpen: boolean;
  readonly mfaChallengeToken: string | null;
  readonly availableFactors: readonly ('TOTP' | 'WEBAUTHN')[];
  readonly onVerified: (payload: { readonly accessToken: string; readonly user: AuthSessionUserProfile }) => void;
  readonly onCancel: () => void;
}

/** Lee un campo de texto no vacío de un registro JSON sin afirmar tipos. */
function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
/** Normaliza el código TOTP: solo dígitos, máximo 6. */
function normalizeTotpDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, TOTP_CODE_LENGTH);
}
/** Divide una cadena limpia en grupos del tamaño dado unidos por un separador. */
function chunkEvery(input: string, separator: string): string {
  const groups: string[] = [];
  for (let index = 0; index < input.length; index += 4) {
    groups.push(input.slice(index, index + 4));
  }
  return groups.join(separator);
}
/** Normaliza el código de recuperación a mayúsculas alfanuméricas con guion cada 4. */
function normalizeRecoveryCode(raw: string): string {
  return chunkEvery(raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, RECOVERY_CODE_MAX_ALPHANUMERIC), '-');
}
/** Indica si el código de recuperación alcanza la longitud real del backend. */
function isRecoveryCodeComplete(code: string): boolean {
  return code.replace(/-/g, '').length >= RECOVERY_CODE_MIN_ALPHANUMERIC;
}
/** Agrupa un secreto base32 en bloques de 4 para su lectura manual. */
function groupSecretInFours(secret: string): string {
  return chunkEvery(secret.toUpperCase().replace(/\s+/g, ''), ' ');
}
/** Restringe el rol recibido a la unión conocida del backend sin `any`. */
function narrowPlatformRole(value: string): 'SUPERADMIN' | 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER' | null {
  switch (value) {
    case 'SUPERADMIN':
    case 'OWNER':
    case 'DEVELOPER':
    case 'BILLING':
    case 'VIEWER':
      return value;
    default:
      return null;
  }
}
/** Canjea una respuesta exitosa del reto en el perfil de sesión RAM del contexto. */
function completeMfaSession(
  data: unknown,
  onVerified: (payload: { readonly accessToken: string; readonly user: AuthSessionUserProfile }) => void,
): 'SUCCESS' | 'INVALID_SHAPE' | 'INVALID_ROLE' {
  if (typeof data !== 'object' || data === null) return 'INVALID_SHAPE';
  const record = data as Record<string, unknown>;
  const accessToken = readStringField(record, 'accessToken');
  const roleValue = readStringField(record, 'role');
  const userRaw = record['user'];
  if (accessToken === null || roleValue === null || typeof userRaw !== 'object' || userRaw === null) return 'INVALID_SHAPE';
  const userRecord = userRaw as Record<string, unknown>;
  const userId = readStringField(userRecord, 'id');
  const email = readStringField(userRecord, 'email');
  const fullName = readStringField(userRecord, 'fullName');
  if (userId === null || email === null || fullName === null) return 'INVALID_SHAPE';
  const role = narrowPlatformRole(roleValue);
  if (role === null) return 'INVALID_ROLE';
  let organization: BackendPublicOrganization | null = null;
  const organizationRaw = record['organization'];
  if (typeof organizationRaw === 'object' && organizationRaw !== null) {
    const organizationRecord = organizationRaw as Record<string, unknown>;
    const organizationId = readStringField(organizationRecord, 'id');
    const organizationName = readStringField(organizationRecord, 'name');
    const organizationSlug = readStringField(organizationRecord, 'slug');
    if (organizationId !== null && organizationName !== null && organizationSlug !== null) {
      organization = { id: organizationId, name: organizationName, slug: organizationSlug, status: readStringField(organizationRecord, 'status') ?? '' };
    }
  }
  // La respuesta real 200 del backend no incluye la proyección pública completa del usuario:
  // se completa con valores neutros; `buildSessionProfile` solo consume `id`, `email` y `fullName`.
  const user: BackendPublicUser = {
    id: userId, email, fullName,
    emailVerified: userRecord['emailVerified'] === true,
    mfaTotpEnabled: userRecord['mfaTotpEnabled'] === true,
    mfaWebauthnEnabled: userRecord['mfaWebauthnEnabled'] === true,
    lastLoginAt: readStringField(userRecord, 'lastLoginAt'),
    createdAt: readStringField(userRecord, 'createdAt') ?? '',
  };
  const profile = buildSessionProfile({ user, organization, role, mfaSatisfied: true });
  onVerified({ accessToken, user: profile });
  return 'SUCCESS';
}
/** Valida y extrae `{ secretBase32, recoveryCodes[] }` de la emisión del enrolamiento. */
function parseEnrollmentIssue(data: unknown): MfaEnrollmentIssue | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const secretBase32 = readStringField(record, 'secretBase32');
  if (secretBase32 === null) return null;
  const recoveryCodes: string[] = [];
  const codesRaw = record['recoveryCodes'];
  if (Array.isArray(codesRaw)) {
    for (const candidate of codesRaw as readonly unknown[]) {
      const code = typeof candidate === 'string' ? candidate.trim() : '';
      if (code.length > 0 && recoveryCodes.length < RECOVERY_CODES_TOTAL) recoveryCodes.push(code);
    }
  }
  return { secretBase32, recoveryCodes };
}
/** Intenta la aserción FIDO2 contra la ruta degradable; 404/405 se degrada a `UNAVAILABLE`. */
async function performWebAuthnAssertion(): Promise<
  { readonly outcome: 'VERIFIED'; readonly data: unknown } | { readonly outcome: 'UNAVAILABLE' | 'FAILED' }
> {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
    return { outcome: 'UNAVAILABLE' };
  }
  const result = await authApiFetch<unknown>(WEBAUTHN_CHALLENGE_PATH, { method: 'POST', body: { purpose: 'MFA_ASSERTION' } });
  if (result.ok) {
    return { outcome: 'VERIFIED', data: result.data };
  }
  return { outcome: result.status === 404 || result.status === 405 ? 'UNAVAILABLE' : 'FAILED' };
}
/** Cuadrícula de los 10 códigos de recuperación; el estado vacío solo explica, jamás genera. */
function RecoveryCodesGrid({ codes }: { readonly codes: readonly string[] }): ReactElement {
  const slots: readonly (string | null)[] = Array.from({ length: RECOVERY_CODES_TOTAL }, (_unused, index) => codes[index] ?? null);
  return (
    <div className="grid grid-cols-2 gap-2">
      {slots.map((code, index) => (
        <span
          key={`recovery-code-${String(index)}`}
          className="atelier-mono rounded-sm border border-dashed border-[var(--color-stone)] px-2 py-1 text-center"
        >
          {code ?? '····-····'}
        </span>
      ))}
    </div>
  );
}
/** Mensajes visibles del intento con llave física. */
const WEBAUTHN_STATE_MESSAGES: Readonly<Record<'RUNNING' | 'UNAVAILABLE' | 'FAILED', string>> = {
  RUNNING: 'Esperando la confirmación de tu llave física…',
  UNAVAILABLE: 'La verificación con llave física no está disponible en este entorno. Usa tu aplicación autenticadora o un código de recuperación.',
  FAILED: 'No pudimos completar la verificación con la llave física. Intenta de nuevo o usa otro método.',
};

/** Cuerpo del modal: se monta solo al abrir, de modo que su estado se reinicia al reabrir. */
function MfaChallengeModalBody(props: MfaChallengeAndEnrollmentModalProps): ReactElement {
  const { mfaChallengeToken, availableFactors, onVerified, onCancel } = props;
  const hasTotpFactor = availableFactors.includes('TOTP');
  const hasWebAuthnFactor = availableFactors.includes('WEBAUTHN');

  const [isEnrollmentView, setIsEnrollmentView] = useState<boolean>(false);
  const [activeMethod, setActiveMethod] = useState<MfaTabMethod>(hasTotpFactor ? 'TOTP' : 'RECOVERY_CODE');
  const [code, setCode] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [failureCount, setFailureCount] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [webAuthnState, setWebAuthnState] = useState<WebAuthnAttemptState>('IDLE');
  const [deviceName, setDeviceName] = useState<string>('');
  const [isEnrollmentRequesting, setIsEnrollmentRequesting] = useState<boolean>(false);
  const [enrollmentNotice, setEnrollmentNotice] = useState<string | null>(null);
  const [enrollmentIssue, setEnrollmentIssue] = useState<MfaEnrollmentIssue | null>(null);
  const autoSubmitGuardRef = useRef<string | null>(null);

  const submitChallenge = useCallback(
    async (method: MfaVerifyMethod, rawCode: string): Promise<void> => {
      if (mfaChallengeToken === null) {
        setErrorMessage('El reto de segundo factor expiró. Vuelve a iniciar sesión para obtener uno nuevo.');
        return;
      }
      setIsSubmitting(true);
      setErrorMessage(null);
      const result = await authApiFetch<unknown>(MFA_VERIFY_PATH, {
        method: 'POST',
        body: { mfaChallengeToken, code: rawCode, method },
      });
      setIsSubmitting(false);
      if (result.ok) {
        const completion = completeMfaSession(result.data, onVerified);
        if (completion !== 'SUCCESS') {
          setErrorMessage(
            completion === 'INVALID_ROLE'
              ? 'Tu rol activo no pudo resolverse. Contacta a tu administrador.'
              : 'La respuesta del servidor no tiene el formato esperado. Intenta de nuevo.',
          );
        }
        return;
      }
      setFailureCount((current) => current + 1);
      setCode('');
      autoSubmitGuardRef.current = null;
      if (result.status === 401) {
        setErrorMessage('El código es inválido o ya expiró. Verifica tu aplicación autenticadora e intenta de nuevo.');
        return;
      }
      if (result.status === 400) {
        setErrorMessage('Revisa el formato del código: no pudimos procesarlo.');
        return;
      }
      setErrorMessage('No pudimos verificar el código en este momento. Intenta de nuevo en unos segundos.');
    },
    [mfaChallengeToken, onVerified],
  );

  useEffect((): void => {
    if (isEnrollmentView || activeMethod !== 'TOTP' || isSubmitting) return;
    if (code.length !== TOTP_CODE_LENGTH || autoSubmitGuardRef.current === code) return;
    autoSubmitGuardRef.current = code;
    void submitChallenge('TOTP', code);
  }, [isEnrollmentView, activeMethod, isSubmitting, code, submitChallenge]);

  const isChallengeReady = activeMethod === 'TOTP' ? code.length === TOTP_CODE_LENGTH : isRecoveryCodeComplete(code);

  const handleSelectTab = useCallback(
    (method: MfaTabMethod): void => {
      setActiveMethod(method);
      setErrorMessage(null);
      setCode('');
      autoSubmitGuardRef.current = null;
      if (method !== 'WEBAUTHN') return;
      setWebAuthnState('RUNNING');
      void performWebAuthnAssertion().then((result): void => {
        if (result.outcome !== 'VERIFIED') {
          setWebAuthnState(result.outcome);
          return;
        }
        setWebAuthnState('IDLE');
        const completion = completeMfaSession(result.data, onVerified);
        if (completion !== 'SUCCESS') {
          setErrorMessage('La llave física respondió, pero el canje de sesión no está disponible en este entorno.');
        }
      });
    },
    [onVerified],
  );

  const handleRequestEnrollment = useCallback(async (): Promise<void> => {
    setIsEnrollmentRequesting(true);
    setEnrollmentNotice(null);
    const result = await authApiFetch<unknown>(MFA_ENROLL_PATH, { method: 'POST', body: { deviceName: deviceName.trim() } });
    setIsEnrollmentRequesting(false);
    if (result.ok) {
      const issue = parseEnrollmentIssue(result.data);
      if (issue === null) {
        setEnrollmentNotice('No pudimos iniciar el enrolamiento. Intenta de nuevo en unos minutos.');
        return;
      }
      setEnrollmentIssue(issue);
      return;
    }
    const isRouteMissing = result.status === 404 || result.status === 405 || result.status === 0;
    setEnrollmentNotice(
      isRouteMissing
        ? 'El enrolamiento guiado aún no está habilitado en este entorno. Cuando el canal esté activo, verás aquí tu secreto y tus códigos de recuperación una única vez.'
        : 'No pudimos iniciar el enrolamiento. Intenta de nuevo en unos minutos.',
    );
  }, [deviceName]);

  const fallbackTab: MfaTabMethod = hasTotpFactor ? 'TOTP' : 'RECOVERY_CODE';
  const factorTabs: readonly { readonly id: MfaTabMethod; readonly label: string }[] = [
    ...(hasTotpFactor ? [{ id: 'TOTP' as const, label: 'Aplicación autenticadora (TOTP)' }] : []),
    ...(hasWebAuthnFactor ? [{ id: 'WEBAUTHN' as const, label: 'Llave física (FIDO2)' }] : []),
    { id: 'RECOVERY_CODE' as const, label: 'Código de recuperación' },
  ];

  return (
    <div className="atelier-modal-overlay" data-portal="workspace-atelier">
      <div className="atelier-modal" role="dialog" aria-modal="true" aria-label="Verificación en dos pasos">
        <div className="flex items-center justify-between gap-4">
          <h2 className="atelier-modal__title">{isEnrollmentView ? 'Configurar segundo factor' : 'Verificación en dos pasos'}</h2>
          <MonoMetadataTag label="MFA" value={isEnrollmentView ? 'ENROLAMIENTO' : 'REQUERIDO'} tone="accent" />
        </div>
        <div className="atelier-modal__body">
          {isEnrollmentView ? (
            <div className="flex flex-col gap-4">
              <label className="atelier-field">
                <span className="atelier-label">Nombre del dispositivo</span>
                <input className="atelier-input" value={deviceName} placeholder="ej. Teléfono de trabajo"
                  onChange={(event): void => setDeviceName(event.currentTarget.value)} />
                <span className="atelier-help-text">Solo organiza tus dispositivos: el secreto siempre se emite desde el servidor.</span>
              </label>
              {enrollmentNotice !== null ? <p className="atelier-help-text">{enrollmentNotice}</p> : null}
              {enrollmentIssue !== null ? (
                <div className="flex flex-col gap-3">
                  <div className="atelier-terminal">
                    <p className="atelier-terminal__label">Secreto base32 · se muestra una única vez</p>
                    <code className="atelier-mono break-all">{groupSecretInFours(enrollmentIssue.secretBase32)}</code>
                  </div>
                  <p className="atelier-error-text">Guárdalos ahora: se muestran una única vez.</p>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <p className="atelier-label">Tus 10 códigos de recuperación</p>
                <RecoveryCodesGrid codes={enrollmentIssue?.recoveryCodes ?? []} />
                <span className="atelier-help-text">Los genera el servidor al enrolar; este navegador jamás los inventa ni los almacena.</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <AtelierSecondaryButton disabled={isEnrollmentRequesting} onClick={(): void => { void handleRequestEnrollment(); }}>
                  {isEnrollmentRequesting ? 'Solicitando…' : 'Solicitar secreto al servidor'}
                </AtelierSecondaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {hasTotpFactor || hasWebAuthnFactor ? (
                <div className="flex flex-wrap gap-1" role="tablist" aria-label="Métodos de verificación">
                  {factorTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeMethod === tab.id}
                      className={`atelier-window__tab${activeMethod === tab.id ? ' atelier-window__tab--active' : ''}`}
                      onClick={(): void => handleSelectTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <form
                className="flex flex-col gap-4"
                onSubmit={(event: FormEvent<HTMLFormElement>): void => {
                  event.preventDefault();
                  if (isSubmitting || !isChallengeReady || activeMethod === 'WEBAUTHN') return;
                  void submitChallenge(activeMethod, code);
                }}
              >
                {activeMethod === 'TOTP' ? (
                  <label className="atelier-field">
                    <span className="atelier-label">Código de 6 dígitos de tu aplicación autenticadora</span>
                    <input
                      className="atelier-input atelier-mono text-center tracking-[0.3em]"
                      value={code}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={TOTP_CODE_LENGTH}
                      autoFocus
                      onChange={(event): void => setCode(normalizeTotpDigits(event.currentTarget.value))}
                    />
                    <span className="atelier-help-text">Se envía automáticamente al completar los 6 dígitos.</span>
                  </label>
                ) : null}
                {activeMethod === 'RECOVERY_CODE' ? (
                  <label className="atelier-field">
                    <span className="atelier-label">Código de recuperación de un solo uso</span>
                    <input
                      className="atelier-input atelier-mono text-center tracking-[0.2em]"
                      value={code}
                      placeholder="ABCD-EFGH"
                      autoComplete="off"
                      autoFocus
                      onChange={(event): void => setCode(normalizeRecoveryCode(event.currentTarget.value))}
                    />
                    <span className="atelier-help-text">Escríbelo tal como lo guardaste; los guiones se añaden automáticamente.</span>
                  </label>
                ) : null}
                {activeMethod === 'WEBAUTHN' ? (
                  <div className="flex flex-col gap-2">
                    {webAuthnState !== 'IDLE' ? (
                      <p className={webAuthnState === 'RUNNING' ? 'atelier-help-text' : 'atelier-error-text'}>
                        {WEBAUTHN_STATE_MESSAGES[webAuthnState]}
                      </p>
                    ) : null}
                    <button type="button" className="atelier-link self-start" onClick={(): void => handleSelectTab(fallbackTab)}>
                      Usar {fallbackTab === 'TOTP' ? 'aplicación autenticadora' : 'código de recuperación'}
                    </button>
                  </div>
                ) : null}
                {errorMessage !== null ? <p className="atelier-error-text">{errorMessage}</p> : null}
                {failureCount >= FAILURE_WARNING_THRESHOLD ? (
                  <p className="atelier-error-text">Si el problema continúa, usa un código de recuperación o solicita ayuda a tu administrador.</p>
                ) : null}
                {activeMethod !== 'WEBAUTHN' ? (
                  <AtelierPrimaryButton type="submit" fullWidth disabled={isSubmitting || !isChallengeReady}>
                    {isSubmitting ? 'Verificando…' : 'Verificar'}
                  </AtelierPrimaryButton>
                ) : null}
              </form>
            </div>
          )}
        </div>
        <div className="atelier-modal__actions">
          {!isEnrollmentView ? (
            <button type="button" className="atelier-link" onClick={(): void => setIsEnrollmentView(true)}>
              Configurar
            </button>
          ) : (
            <button type="button" className="atelier-link" onClick={(): void => setIsEnrollmentView(false)}>
              Volver al desafío
            </button>
          )}
          <AtelierSecondaryButton onClick={onCancel}>Cancelar</AtelierSecondaryButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Modal que resuelve el estado 202 `mfa_required` y el enrolamiento del segundo factor.
 * Solo se cierra con «Cancelar»; no existe botón de cierre adicional.
 */
export function MfaChallengeAndEnrollmentModal(props: MfaChallengeAndEnrollmentModalProps): ReactElement | null {
  if (!props.isOpen) return null;
  return <MfaChallengeModalBody {...props} />;
}
