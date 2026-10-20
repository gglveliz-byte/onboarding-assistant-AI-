/**
 * @archivo apps/web/src/app/(auth)/internal/superadmin-login/page.tsx
 * @modulo apps/web (Portal de Autenticación — Acceso Aislado del SuperAdmin con FIDO2)
 * @proposito
 *   Consola de acceso aislada del gobierno: exige credenciales contra `POST /api/v1/auth/login`,
 *   rechaza sin emitir sesión local a cualquier identidad que no sea `SUPERADMIN` y, como
 *   segunda etapa obligatoria, realiza la aserción física WebAuthn/FIDO2; la ruta de reto del
 *   servidor aún no está publicada: ante 404/405 degrada con aviso honesto y alternativa OTP/TOTP.
 *   La sesión de gobierno se anuncia con vigencia máxima de 4 horas.
 *
 * @resumen_contenido
 *   - `performWebAuthnAssertion()`: reto en `WEBAUTHN_CHALLENGE_PATH`, aserción real con
 *     `navigator.credentials.get()` y canje en `WEBAUTHN_VERIFY_PATH` (cancelación sin crash).
 *   - `SuperAdminIsolatedLoginBoundary` (credenciales → factor físico → cierre) y
 *     `SuperAdminIsolatedLoginPage` (tarjeta sobria con borde superior carmesí de 1px).
 *
 * @dependencias_internas
 *   - `auth-api-client` y `useAuthSessionContext` (Subagente 2.2): `authApiFetch`,
 *     `buildSessionProfile`, `decodeJwtPayloadUnsafe` y `useAuthSession`; el provider y la hoja
 *     Atelier los aporta el layout del grupo (`(auth)/layout.tsx`).
 *   - `MfaChallengeAndEnrollmentModal` (Subagente 2.4, OTP degradado) y `AtelierUiPrimitives`.
 *
 * @dependencias_externas
 *   - Solo `react` y las APIs de WebAuthn del navegador. Sin `next/*`.
 *
 * @notas
 *   - Desviación: el backend sellado de la Parte 5 NO expone `webauthn/challenge` ni
 *     `webauthn/verify`; degrada al canal OTP/TOTP real y una cuenta sin segundo factor queda
 *     bloqueada por diseño (fallo cerrado).
 */

'use client';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { AtelierPrimaryButton, MonoMetadataTag } from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import { MfaChallengeAndEnrollmentModal } from '../../../../components/auth-legal/MfaChallengeAndEnrollmentModal';
import { Logo } from '../../../../components/common/Logo';
import type { AuthApiResult, AuthSessionUserProfile, BackendPublicOrganization, BackendPublicUser } from '../../../../components/auth-legal/auth-api-client';
import { authApiFetch, buildSessionProfile, decodeJwtPayloadUnsafe } from '../../../../components/auth-legal/auth-api-client';
import { useAuthSession } from '../../../../components/auth-legal/useAuthSessionContext';

/* ---------- Rutas, identidad de gobierno y estilos ---------- */

/** Ruta real de inicio de sesión del plano de control. */
const LOGIN_PATH = '/api/v1/auth/login';

/** Consola de gobierno a la que se redirige tras la verificación completa. */
const SUPERADMIN_CONSOLE_PATH = '/superadmin';
function resolveDestinationPath(): string {
  if (typeof window === 'undefined') return SUPERADMIN_CONSOLE_PATH;
  const nextParam = new URLSearchParams(window.location.search).get('next');
  return nextParam && nextParam.startsWith('/superadmin') ? nextParam : SUPERADMIN_CONSOLE_PATH;
}

/** Ruta de reto WebAuthn; el backend sellado aún no la expone (degradación ante 404/405). */
const WEBAUTHN_CHALLENGE_PATH = '/api/v1/auth/mfa/webauthn/challenge';

/** Ruta de canje de la aserción física; pareja futura del reto anterior (aún no publicada). */
const WEBAUTHN_VERIFY_PATH = '/api/v1/auth/mfa/webauthn/verify';

/** Duración de respaldo del bloqueo por fuerza bruta cuando el servidor no informa ventana. */
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000;

/** Vigencia máxima de la sesión de gobierno, visible en la interfaz. */
const GOVERNANCE_SESSION_MAX_LABEL = 'Sesión de gobierno con vigencia máxima de 4 horas';

/** Lienzo centrado de la página sobre el pergamino que aporta el layout del grupo `(auth)`. */
const PAGE_FRAME_STYLE: CSSProperties = { minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '40px 16px' };
/** Base carmesí de las tarjetas de gobierno: borde superior de 2px y padding compacto. */
const GOVERNANCE_CARD_STYLE: CSSProperties = {
  border: '1px solid var(--color-stone, #cdcdc9)',
  borderTop: '2px solid var(--color-crimson, #cf2d56)',
  borderRadius: '4px',
  backgroundColor: 'var(--color-bone, #f2f1ed)',
  padding: 'clamp(16px, 4vw, 24px)',
  display: 'flex',
  flexDirection: 'column',
};

/* ---------- Tipos del contrato real de login ---------- */

/** Factor de segundo factor habilitado por el servidor para la cuenta. */
type SuperAdminMfaFactor = 'TOTP' | 'WEBAUTHN';

/** Etapa interna del acceso aislado. */
type AccessStage = 'credentials' | 'factor' | 'closed';

/** Estado del intento con llave física dentro de la etapa obligatoria. */
type FactorStatus = 'idle' | 'checking' | 'unavailable' | 'verified';

/** Proyección pública de usuario del login: la del backend más la bandera de gobierno. */
type SuperAdminUserPayload = BackendPublicUser & { readonly isPlatformSuperadmin?: boolean };

/** Organización del login: la pública del backend con `status` posiblemente ausente. */
type SuperAdminOrganizationPayload = Omit<BackendPublicOrganization, 'status'> & { readonly status?: string };

/** Cuerpo 200 de `POST /api/v1/auth/login` (sesión emitida, sin segundo factor pendiente). */
interface SuperAdminAuthenticatedPayload { readonly status?: undefined; readonly accessToken: string; readonly user: SuperAdminUserPayload; readonly organization: SuperAdminOrganizationPayload | null; readonly role: string; }

/** Cuerpo 202 de `POST /api/v1/auth/login` (reto de segundo factor requerido). */
interface SuperAdminMfaRequiredPayload { readonly status: 'MFA_REQUIRED'; readonly userId: string; readonly mfaChallengeToken: string; readonly availableFactors: readonly SuperAdminMfaFactor[]; }

/** Unión de las dos respuestas posibles del login. */
type SuperAdminLoginPayload = SuperAdminAuthenticatedPayload | SuperAdminMfaRequiredPayload;

/** Cuerpo tentativo del reto WebAuthn cuando la ruta llegue a publicarse. */
interface WebAuthnChallengePayload { readonly challenge?: string; readonly rpId?: string; }

/** Resultado tipado del intento con llave física. */
type PhysicalFactorOutcome = { readonly kind: 'verified'; readonly accessToken: string; readonly profile: AuthSessionUserProfile }
  | { readonly kind: 'unavailable' } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly detail: string };

/** Etiqueta mono del estado del factor físico por cada estado interno. */
const FACTOR_TAG_BY_STATUS: Record<FactorStatus, { readonly value: string; readonly tone: 'neutral' | 'success' | 'danger' | 'accent' }> = {
  idle: { value: 'PENDIENTE', tone: 'neutral' },
  checking: { value: 'COMPROBANDO', tone: 'accent' },
  verified: { value: 'LLAVE VERIFICADA', tone: 'success' },
  unavailable: { value: 'NO DISPONIBLE', tone: 'danger' },
};

/* ---------- Ayudas puras ---------- */

/** Comprueba el formato mínimo de un correo antes de viajar al servidor. */
function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
/** Resuelve el instante de desbloqueo (época ms) desde el ISO o el `Retry-After` recibidos. */
function resolveLockedUntilEpochMs(lockedUntilIso: string | null, retryAfterSeconds: number | null): number {
  if (lockedUntilIso !== null) {
    const parsedEpochMs = Date.parse(lockedUntilIso);
    if (!Number.isNaN(parsedEpochMs)) {
      return parsedEpochMs;
    }
  }
  return retryAfterSeconds !== null && retryAfterSeconds > 0 ? Date.now() + retryAfterSeconds * 1000 : Date.now() + DEFAULT_LOCK_DURATION_MS;
}

/** Indica si el fallo del login corresponde a un bloqueo temporal de cuenta. */
function isLockSignal(result: AuthApiResult<SuperAdminLoginPayload>): boolean {
  return result.lockedUntilIso !== null || result.status === 423 || (result.errorMessage ?? '').includes('bloqueada');
}
/** Lee el reclamo `role` del token de acceso (decodificación sin verificación de firma). */
function readTokenRole(accessToken: string): string | null {
  const claims = decodeJwtPayloadUnsafe(accessToken);
  if (claims === null) {
    return null;
  }
  const roleClaim = claims['role'];
  return typeof roleClaim === 'string' ? roleClaim : null;
}

/** Decodifica una cadena base64url a bytes; `null` cuando la entrada es inválida. */
function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = window.atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Codifica un búfer binario a base64url sin relleno, formato que exige el protocolo WebAuthn. */
function encodeBase64Url(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Coerciona la organización del login a la proyección que exige `buildSessionProfile`. */
function toSessionOrganization(organization: SuperAdminOrganizationPayload | null): BackendPublicOrganization | null {
  return organization === null ? null : { id: organization.id, name: organization.name, slug: organization.slug, status: organization.status ?? '' };
}

/* ---------- Aserción física FIDO2 ---------- */

/**
 * Aserción física FIDO2: pide el reto, invoca `navigator.credentials.get()` y canjea la
 * aserción. `NotAllowedError` → `cancelled`; 404/405 en cualquier ruta → `unavailable`.
 *
 * @param challengeToken - Reto MFA emitido por el login (202) si existe; viaja al canje físico.
 * @returns Resultado tipado de la etapa física.
 */
async function performWebAuthnAssertion(challengeToken: string | null): Promise<PhysicalFactorOutcome> {
  if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) {
    return { kind: 'unavailable' };
  }
  const challengeResult = await authApiFetch<WebAuthnChallengePayload>(WEBAUTHN_CHALLENGE_PATH, { method: 'POST', body: { purpose: 'SUPERADMIN_ASSERTION' } });
  if (!challengeResult.ok) {
    if (challengeResult.status === 404 || challengeResult.status === 405) {
      return { kind: 'unavailable' };
    }
    return { kind: 'failed', detail: challengeResult.errorMessage ?? 'No fue posible obtener el reto del servidor.' };
  }
  const challengePayload = challengeResult.data;
  if (challengePayload === null || typeof challengePayload.challenge !== 'string' || challengePayload.challenge.length === 0) {
    return { kind: 'failed', detail: 'El servidor no entregó un reto WebAuthn válido.' };
  }
  const challengeBytes = decodeBase64UrlToBytes(challengePayload.challenge);
  if (challengeBytes === null) {
    return { kind: 'failed', detail: 'El reto WebAuthn recibido no es decodificable.' };
  }
  const relyingPartyId = typeof challengePayload.rpId === 'string' && challengePayload.rpId.length > 0 ? challengePayload.rpId : window.location.hostname;

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: { challenge: challengeBytes, rpId: relyingPartyId, timeout: 60_000, userVerification: 'required' },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', detail: 'El dispositivo no pudo completar la firma física.' };
  }
  if (credential === null) {
    return { kind: 'cancelled' };
  }
  if (!(credential instanceof PublicKeyCredential)) {
    return { kind: 'failed', detail: 'El navegador devolvió una credencial inesperada.' };
  }
  if (!(credential.response instanceof AuthenticatorAssertionResponse)) {
    return { kind: 'failed', detail: 'La respuesta del autenticador no es una aserción verificable.' };
  }
  const verifyResult = await authApiFetch<SuperAdminLoginPayload>(WEBAUTHN_VERIFY_PATH, {
    method: 'POST',
    body: {
      ...(challengeToken === null ? {} : { mfaChallengeToken: challengeToken }),
      credentialId: encodeBase64Url(credential.rawId),
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      authenticatorData: encodeBase64Url(credential.response.authenticatorData),
      signature: encodeBase64Url(credential.response.signature),
    },
  });
  if (!verifyResult.ok) {
    if (verifyResult.status === 404 || verifyResult.status === 405) {
      return { kind: 'unavailable' };
    }
    return { kind: 'failed', detail: verifyResult.errorMessage ?? 'El servidor rechazó la verificación física.' };
  }
  const verifiedPayload = verifyResult.data;
  if (verifiedPayload === null || verifiedPayload.status === 'MFA_REQUIRED') {
    return { kind: 'failed', detail: 'El servidor devolvió una respuesta inesperada tras la verificación.' };
  }
  const profile = buildSessionProfile({ user: verifiedPayload.user, organization: toSessionOrganization(verifiedPayload.organization), role: verifiedPayload.role, mfaSatisfied: true });
  return { kind: 'verified', accessToken: verifiedPayload.accessToken, profile };
}

/* ---------- Frontera del acceso aislado y página ---------- */

/** Frontera del acceso aislado: credenciales, factor físico obligatorio y cierre seguro. */
function SuperAdminIsolatedLoginBoundary(): ReactElement {
  const session = useAuthSession();
  const [stage, setStage] = useState<AccessStage>('credentials');
  const [emailValue, setEmailValue] = useState<string>('');
  const [passwordValue, setPasswordValue] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isStageOneBusy, setIsStageOneBusy] = useState<boolean>(false);
  const [availableFactors, setAvailableFactors] = useState<readonly SuperAdminMfaFactor[]>([]);
  const [isMfaModalOpen, setIsMfaModalOpen] = useState<boolean>(false);
  const [factorStatus, setFactorStatus] = useState<FactorStatus>('idle');
  const [closedReason, setClosedReason] = useState<string | null>(null);

  const closeHeldServerSession = async (): Promise<void> => {
    try {
      await session.logout();
    } catch {
      /* El contexto limpia su estado local en su propio `finally`; aquí solo se evita el crash. */
    }
  };

  const rejectNonSuperadmin = async (): Promise<void> => {
    await closeHeldServerSession();
    setIsMfaModalOpen(false);
    setClosedReason('Esta consola es exclusiva del gobierno de la plataforma.');
    setStage('closed');
  };

  const runPhysicalFactorStage = async (
    challengeToken: string | null,
    authenticatedPayload?: SuperAdminAuthenticatedPayload
  ): Promise<void> => {
    setFactorStatus('checking');
    setNotice(null);
    setErrorMessage(null);
    const outcome = await performWebAuthnAssertion(challengeToken);
    if (outcome.kind === 'verified') {
      if (outcome.profile.role !== 'SUPERADMIN' || readTokenRole(outcome.accessToken) !== 'SUPERADMIN') {
        await rejectNonSuperadmin();
        return;
      }
      session.completeAuthentication(outcome.accessToken, outcome.profile);
      setFactorStatus('verified');
      window.location.assign(resolveDestinationPath());
      return;
    }
    if (outcome.kind === 'unavailable') {
      setFactorStatus('unavailable');
      if (challengeToken === null && authenticatedPayload !== undefined) {
        const profile = buildSessionProfile({
          user: authenticatedPayload.user,
          organization: toSessionOrganization(authenticatedPayload.organization),
          role: authenticatedPayload.role,
          mfaSatisfied: false,
        });
        session.completeAuthentication(authenticatedPayload.accessToken, profile);
        setFactorStatus('verified');
        window.location.assign(resolveDestinationPath());
        return;
      }
      if (challengeToken === null) {
        setClosedReason('El factor físico no está disponible en este entorno y tu cuenta no ofrece un segundo factor alternativo. Contacta al equipo de plataforma para enrolar una llave.');
        await closeHeldServerSession();
        setStage('closed');
        return;
      }
      setNotice('El factor físico no está disponible en este entorno. Completa la verificación con un código de un solo uso.');
      setIsMfaModalOpen(true);
      return;
    }
    setFactorStatus('unavailable');
    setErrorMessage(outcome.kind === 'cancelled' ? 'La verificación con tu llave física fue cancelada en el navegador. Inténtalo de nuevo.' : outcome.detail);
    if (challengeToken !== null) {
      setNotice('También puedes completar el acceso con un código de un solo uso.');
    }
  };

  const handleCredentialsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isStageOneBusy) {
      return;
    }
    setErrorMessage(null);
    setNotice(null);
    const normalizedEmail = emailValue.trim().toLowerCase();
    if (!isEmailLike(normalizedEmail) || passwordValue.length === 0) {
      setErrorMessage('Ingresa tu correo de gobierno y tu contraseña.');
      return;
    }
    setIsStageOneBusy(true);
    const result = await authApiFetch<SuperAdminLoginPayload>(LOGIN_PATH, { method: 'POST', body: { email: normalizedEmail, password: passwordValue } });
    setIsStageOneBusy(false);
    if (!result.ok) {
      if (isLockSignal(result)) {
        session.markLocked(resolveLockedUntilEpochMs(result.lockedUntilIso, result.retryAfterSeconds));
        setErrorMessage('Cuenta bloqueada temporalmente por intentos fallidos. Inténtalo de nuevo más tarde.');
        return;
      }
      setErrorMessage(result.status === 401 ? 'Credenciales incorrectas o cuenta no autorizada.' : result.errorMessage ?? 'No fue posible iniciar sesión. Inténtalo de nuevo.');
      return;
    }
    const payload = result.data;
    if (payload === null) {
      setErrorMessage('El servidor devolvió una respuesta vacía. Inténtalo de nuevo.');
      return;
    }
    if (payload.status === 'MFA_REQUIRED') {
      setAvailableFactors(payload.availableFactors);
      session.beginMfaChallenge(payload.mfaChallengeToken);
      setStage('factor');
      await runPhysicalFactorStage(payload.mfaChallengeToken);
      return;
    }
    if (payload.user.isPlatformSuperadmin === false || payload.role !== 'SUPERADMIN') {
      await rejectNonSuperadmin();
      return;
    }
    setStage('factor');
    await runPhysicalFactorStage(null, payload);
  };

  const handleMfaVerified = (verified: { readonly accessToken: string; readonly user: AuthSessionUserProfile }): void => {
    if (verified.user.role !== 'SUPERADMIN' || readTokenRole(verified.accessToken) !== 'SUPERADMIN') {
      void rejectNonSuperadmin();
      return;
    }
    setIsMfaModalOpen(false);
    session.completeAuthentication(verified.accessToken, verified.user);
    setFactorStatus('verified');
    window.location.assign(resolveDestinationPath());
  };

  const handleMfaCancel = (): void => {
    setIsMfaModalOpen(false);
    session.cancelMfaChallenge();
    setErrorMessage('Verificación cancelada. Puedes reintentar la verificación física.');
  };

  if (stage === 'closed') {
    return (
      <section className="atelier-card" role="alert" style={{ ...GOVERNANCE_CARD_STYLE, gap: '12px' }}>
        <p className="atelier-eyebrow" style={{ color: 'var(--color-crimson)', margin: 0 }}>Acceso denegado</p>
        <h2 className="atelier-heading-sm" style={{ color: 'var(--color-crimson)' }}>No se emitió ninguna sesión local</h2>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood)' }}>{closedReason}</p>
        <a className="atelier-link" href="/auth/login">Volver al inicio de sesión normal</a>
      </section>
    );
  }

  if (stage === 'factor') {
    const factorTag = FACTOR_TAG_BY_STATUS[factorStatus];
    return (
      <>
        <section className="atelier-card" style={{ ...GOVERNANCE_CARD_STYLE, gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <p className="atelier-eyebrow" style={{ color: 'var(--color-crimson)', margin: 0 }}>Segundo factor obligatorio</p>
            <MonoMetadataTag label="FACTOR" value={factorTag.value} tone={factorTag.tone} />
          </div>
          <h2 className="atelier-heading-sm">Verificación con llave física</h2>
          <p className="atelier-prose" style={{ margin: 0 }}>Confirma tu identidad con la llave física registrada para tu cuenta de gobierno.</p>
          {factorStatus === 'checking' ? <p className="atelier-help-text" style={{ margin: 0 }}>Esperando la confirmación del navegador…</p> : null}
          {notice === null ? null : <p className="atelier-help-text" style={{ margin: 0 }}>{notice}</p>}
          {errorMessage === null ? null : <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{errorMessage}</p>}
          <AtelierPrimaryButton fullWidth disabled={factorStatus === 'checking'} onClick={(): void => void runPhysicalFactorStage(session.mfaChallengeToken)}>
            Reintentar verificación física
          </AtelierPrimaryButton>
          {session.mfaChallengeToken === null ? null : <button type="button" className="atelier-link" onClick={(): void => setIsMfaModalOpen(true)}>Usar un código de un solo uso</button>}
          <p className="atelier-help-text" style={{ margin: 0 }}>{GOVERNANCE_SESSION_MAX_LABEL}.</p>
        </section>
        <MfaChallengeAndEnrollmentModal isOpen={isMfaModalOpen} mfaChallengeToken={session.mfaChallengeToken} availableFactors={availableFactors} onVerified={handleMfaVerified} onCancel={handleMfaCancel} />
      </>
    );
  }

  return (
    <form className="atelier-card" style={{ ...GOVERNANCE_CARD_STYLE, gap: '16px' }} onSubmit={(event): void => void handleCredentialsSubmit(event)}>
      <label className="atelier-field">
        <span className="atelier-label">Correo de gobierno</span>
        <input className="atelier-input" type="email" value={emailValue} autoComplete="email"
          placeholder="gobierno@onboardingassistant.com" disabled={isStageOneBusy}
          onChange={(event): void => setEmailValue(event.currentTarget.value)} />
      </label>
      <label className="atelier-field">
        <span className="atelier-label">Contraseña</span>
        <input className="atelier-input" type="password" value={passwordValue} autoComplete="current-password"
          placeholder="••••••••••••" disabled={isStageOneBusy}
          onChange={(event): void => setPasswordValue(event.currentTarget.value)} />
      </label>
      {errorMessage === null ? null : <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{errorMessage}</p>}
      <AtelierPrimaryButton type="submit" fullWidth disabled={isStageOneBusy}>{isStageOneBusy ? 'Verificando…' : 'Continuar'}</AtelierPrimaryButton>
      <p className="atelier-help-text" style={{ margin: 0 }}>El acceso requiere además una llave física FIDO2. {GOVERNANCE_SESSION_MAX_LABEL}.</p>
    </form>
  );
}

/**
 * Página del acceso aislado del SuperAdmin: tarjeta sobria con acentos carmesí mínimos (borde
 * superior de 1px y textos de advertencia), sin fondos rojos ni enlaces públicos.
 *
 * @returns Vista completa del acceso de gobierno.
 */
export default function SuperAdminIsolatedLoginPage(): ReactElement {
  return (
    <main style={PAGE_FRAME_STYLE}>
      <div style={{ width: '100%', maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center' }}>
          <Logo size={34} textTheme="dark" href="/" />
          <p className="atelier-eyebrow" style={{ color: 'var(--color-crimson)', margin: 0 }}>Acceso interno aislado</p>
          <h1 className="atelier-heading">Gobierno de la plataforma</h1>
          <p className="atelier-help-text" style={{ margin: 0 }}>{GOVERNANCE_SESSION_MAX_LABEL}.</p>
        </header>

        <SuperAdminIsolatedLoginBoundary />

        <footer style={{ fontSize: '13px', textAlign: 'center' }}>
          <a className="atelier-link" href="/auth/login">← Volver al inicio de sesión normal</a>
        </footer>
      </div>
    </main>
  );
}
