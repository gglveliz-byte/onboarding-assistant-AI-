/**
 * @archivo apps/web/src/app/(auth)/auth/login/page.tsx
 * @modulo apps/web (Portal de Autenticación — Login B2B con Descubrimiento SSO)
 * @proposito
 *   Autenticación B2B: valida credenciales contra `POST /api/v1/auth/login`, abre el reto de
 *   segundo factor cuando el servidor responde 202, gestiona el bloqueo temporal con cuenta
 *   regresiva en vivo, muestra el panel informativo del bloqueo legal 403 —que ocurre antes de
 *   emitir sesión local— y conmuta a la vía corporativa SAML 2.0 cuando la organización la
 *   exige; la identidad de gobierno se redirige a su consola aislada (`/superadmin`).
 *
 * @resumen_contenido
 *   - Tipos del contrato real del login y del sondeo de inquilino por dominio.
 *   - Ayudas: `isEmailLike()`, `formatCountdown()`, `resolveLockedUntilEpochMs()`,
 *     `toSessionOrganization()` y `resolvePostAuthenticationPath()`.
 *   - Bloques: `LockedAccountCountdown` (banner con cuenta regresiva), `DomainDiscoveryEmailInput`
 *     (sondeo silencioso de `discover-tenant`), `SsoFederationPanel` (vía corporativa con aviso
 *     honesto si aún no está configurada) y `LegalConsentBlockedPanel`.
 *   - `B2BAuthenticationBoundary` (formulario, errores, reto MFA, destino) y `B2BLoginPage`.
 *
 * @dependencias_internas
 *   - `auth-api-client` y `useAuthSessionContext` (Subagente 2.2): `authApiFetch`,
 *     `buildSessionProfile`, tipos congelados y `useAuthSession`; el provider y la hoja Atelier
 *     los aporta el layout del grupo (`(auth)/layout.tsx`).
 *   - `MfaChallengeAndEnrollmentModal` (Subagente 2.4) y `AtelierPrimaryButton` (primitivas).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks). Sin `next/*`: navegación con `<a href>` y `window.location`.
 *
 * @notas
 *   - Desviación: `discover-tenant` y `sso/saml/start` no existen aún en el backend sellado de
 *     la Parte 5; la interfaz los sondea y degrada sin ruido.
 *   - El bloqueo legal 403 (sin sesión) NO reutiliza el modal del Subagente 2.5 (exige sesión):
 *     se informa con enlaces a `/legal/*`.
 */

'use client';

import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { AtelierPrimaryButton } from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import { MfaChallengeAndEnrollmentModal } from '../../../../components/auth-legal/MfaChallengeAndEnrollmentModal';
import { Logo } from '../../../../components/common/Logo';
import type { AuthApiResult, AuthSessionUserProfile, BackendPublicOrganization, BackendPublicUser } from '../../../../components/auth-legal/auth-api-client';
import { authApiFetch, buildSessionProfile } from '../../../../components/auth-legal/auth-api-client';
import { useAuthSession } from '../../../../components/auth-legal/useAuthSessionContext';

/* ---------- Rutas, umbrales y estilos ---------- */

/** Ruta real de inicio de sesión del plano de control. */
const LOGIN_PATH = '/api/v1/auth/login';

/** Ruta tentativa de descubrimiento de inquilino por dominio de correo (aún no publicada). */
const DISCOVERY_PATH = '/api/v1/auth/discover-tenant';

/** Ruta tentativa de inicio federado SAML 2.0 (aún no publicada). */
const SSO_START_PATH = '/api/v1/auth/sso/saml/start';

/** Destino de autorización del flujo de dispositivo RFC 8628 del CLI. */
const CLI_DEVICE_PATH = '/auth/cli-device';

/** Duración de respaldo del bloqueo por fuerza bruta cuando el servidor no informa ventana. */
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000;

/** Lienzo centrado de la página sobre el pergamino que aporta el layout del grupo `(auth)`. */
const PAGE_FRAME_STYLE: CSSProperties = { minHeight: '100dvh', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '24px 16px' };

/** Pila vertical estándar de tarjetas y formularios (separación de 12px). */
const COLUMN_STACK_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '12px' };

/* ---------- Tipos del contrato real de login ---------- */

/** Factor de segundo factor habilitado por el servidor para la cuenta. */
type MfaAvailableFactor = 'TOTP' | 'WEBAUTHN';

/** Proyección pública de usuario del login: la del backend más la bandera de gobierno. */
type LoginUserPayload = BackendPublicUser & { readonly isPlatformSuperadmin?: boolean };

/** Organización del login: la pública del backend con `status` posiblemente ausente. */
type LoginOrganizationPayload = Omit<BackendPublicOrganization, 'status'> & { readonly status?: string };

/** Cuerpo 200 de `POST /api/v1/auth/login` (sesión emitida, sin segundo factor pendiente). */
interface LoginAuthenticatedPayload { readonly status?: undefined; readonly accessToken: string; readonly user: LoginUserPayload; readonly organization: LoginOrganizationPayload | null; readonly role: string; }

/** Cuerpo 202 de `POST /api/v1/auth/login` (reto de segundo factor requerido). */
interface LoginMfaRequiredPayload { readonly status: 'MFA_REQUIRED'; readonly userId: string; readonly mfaChallengeToken: string; readonly availableFactors: readonly MfaAvailableFactor[]; }

/** Unión de las dos respuestas posibles del login. */
type LoginPayload = LoginAuthenticatedPayload | LoginMfaRequiredPayload;

/** Cuerpo tentativo del descubrimiento de inquilino por dominio. */
interface DiscoveryPayload { readonly sso_enforced?: boolean; readonly organizationSlug?: string | null; }

/** Cuerpo tentativo del inicio federado cuando la ruta llegue a publicarse. */
interface SsoStartPayload { readonly redirectUrl?: string; }

/* ---------- Ayudas puras ---------- */

/** Comprueba el formato mínimo de un correo antes de viajar al servidor. */
function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Formatea milisegundos restantes como `mm:ss` para la cuenta regresiva del bloqueo. */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(Math.ceil(remainingMs / 1000), 0);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
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

/** Coerciona la organización del login a la proyección que exige `buildSessionProfile`. */
function toSessionOrganization(organization: LoginOrganizationPayload | null): BackendPublicOrganization | null {
  return organization === null ? null : { id: organization.id, name: organization.name, slug: organization.slug, status: organization.status ?? '' };
}

/** Decide el destino posterior: CLI, consola de gobierno, panel de la organización o docs. */
function resolvePostAuthenticationPath(role: string, orgSlug: string, nextParam: string | null): string {
  if (nextParam === 'cli-device') {
    return CLI_DEVICE_PATH;
  }
  if (role === 'SUPERADMIN') {
    return '/superadmin';
  }
  return orgSlug.length > 0 ? `/dashboard/org/${encodeURIComponent(orgSlug)}` : '/docs';
}

/* ---------- Bloques visuales ---------- */

/** Banner carmesí de cuenta bloqueada con cuenta regresiva en vivo actualizada cada segundo. */
function LockedAccountCountdown(props: { readonly lockedUntilEpochMs: number | null }): ReactElement | null {
  const { lockedUntilEpochMs } = props;
  const [nowEpochMs, setNowEpochMs] = useState<number>(() => Date.now());

  useEffect((): (() => void) | undefined => {
    if (lockedUntilEpochMs === null) {
      return undefined;
    }
    setNowEpochMs(Date.now());
    const timerId = window.setInterval((): void => setNowEpochMs(Date.now()), 1000);
    return (): void => window.clearInterval(timerId);
  }, [lockedUntilEpochMs]);

  if (lockedUntilEpochMs === null) {
    return null;
  }
  const remainingMs = lockedUntilEpochMs - nowEpochMs;
  if (remainingMs <= 0) {
    return null;
  }
  return (
    <div role="alert" style={{ border: '1px solid var(--color-crimson)', borderRadius: '4px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '14px', color: 'var(--color-crimson)' }}>Cuenta bloqueada temporalmente por intentos fallidos.</span>
      <span className="atelier-mono" style={{ color: 'var(--color-crimson)' }}>NUEVO INTENTO DISPONIBLE EN {formatCountdown(remainingMs)}</span>
    </div>
  );
}

/**
 * Campo de correo con descubrimiento silencioso de inquilino al perder el foco: 404/405, red
 * caída o inquilino sin SSO no producen efecto visible; el login también puede forzar SSO.
 *
 * @param props - Valor controlado, manejadores de cambio y de SSO, y estado deshabilitado.
 * @returns Campo etiquetado con ayuda contextual.
 */
function DomainDiscoveryEmailInput(props: {
  readonly value: string;
  readonly onValueChange: (nextValue: string) => void;
  readonly onSsoEnforced: (organizationSlug: string | null) => void;
  readonly disabled: boolean;
}): ReactElement {
  const { value, onValueChange, onSsoEnforced, disabled } = props;
  const handleBlur = useCallback((): void => {
    const normalizedEmail = value.trim().toLowerCase();
    if (!isEmailLike(normalizedEmail)) {
      return;
    }
    void authApiFetch<DiscoveryPayload>(DISCOVERY_PATH, { method: 'POST', body: { email: normalizedEmail } }).then((result): void => {
      if (!result.ok || result.data === null || result.data.sso_enforced !== true) {
        return;
      }
      const slugCandidate = result.data.organizationSlug;
      onSsoEnforced(typeof slugCandidate === 'string' && slugCandidate.length > 0 ? slugCandidate : null);
    });
  }, [onSsoEnforced, value]);

  return (
    <label className="atelier-field">
      <span className="atelier-label">Correo corporativo</span>
      <input
        className="atelier-input" type="email" value={value} autoComplete="email"
        placeholder="tu@empresa.com" disabled={disabled}
        onChange={(event): void => onValueChange(event.currentTarget.value)} onBlur={handleBlur}
      />
      <span className="atelier-help-text">Si tu organización usa inicio de sesión corporativo, lo detectaremos automáticamente.</span>
    </label>
  );
}

/** Panel de la vía federada SAML 2.0: requisito, sondeo de la ruta real y retorno al formulario. */
function SsoFederationPanel(props: { readonly orgSlugHint: string | null; readonly onReturnToCredentials: () => void }): ReactElement {
  const { orgSlugHint, onReturnToCredentials } = props;
  const [notice, setNotice] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState<boolean>(false);

  const handleStart = useCallback(async (): Promise<void> => {
    if (isStarting) {
      return;
    }
    if (orgSlugHint === null) {
      setNotice('No pudimos determinar el identificador de tu organización. Solicita el enlace de acceso a tu administrador.');
      return;
    }
    setIsStarting(true);
    setNotice(null);
    const result = await authApiFetch<SsoStartPayload>(`${SSO_START_PATH}?orgSlug=${encodeURIComponent(orgSlugHint)}`, { method: 'GET' });
    setIsStarting(false);
    const redirectUrl = result.ok && result.data !== null ? result.data.redirectUrl : undefined;
    if (typeof redirectUrl === 'string' && redirectUrl.length > 0) {
      window.location.assign(redirectUrl);
      return;
    }
    setNotice('El inicio de sesión corporativo aún está pendiente de configuración por el administrador de tu organización.');
  }, [isStarting, orgSlugHint]);

  return (
    <section className="atelier-card" style={COLUMN_STACK_STYLE}>
      <p className="atelier-eyebrow" style={{ margin: 0 }}>Acceso corporativo federado</p>
      <h2 className="atelier-heading-sm">Tu organización exige inicio de sesión único</h2>
      <p className="atelier-prose" style={{ margin: 0 }}>
        Esta organización administra el acceso con su proveedor de identidad. Continúa con el inicio de sesión corporativo para verificarte con tu cuenta de trabajo.
      </p>
      <AtelierPrimaryButton fullWidth disabled={isStarting} onClick={(): void => void handleStart()}>
        {isStarting ? 'Contactando al proveedor…' : 'Continuar con el inicio de sesión corporativo'}
      </AtelierPrimaryButton>
      {notice === null ? null : <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{notice}</p>}
      <button type="button" className="atelier-link" onClick={onReturnToCredentials}>Volver al inicio de sesión</button>
    </section>
  );
}

/** Bloqueo legal 403 (sin sesión): enlaces al visor legal público y nota de renovación. */
function LegalConsentBlockedPanel(props: { readonly errorCode: 'LEGAL_CONSENT_OUTDATED' | 'DPA_NOT_SIGNED' }): ReactElement {
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

/* ---------- Frontera de autenticación y página ---------- */

/** Frontera B2B: formulario, descubrimiento SSO, bloqueos, reto MFA y destino final. */
function B2BAuthenticationBoundary(): ReactElement {
  const session = useAuthSession();
  const [emailValue, setEmailValue] = useState<string>('');
  const [passwordValue, setPasswordValue] = useState<string>('');
  const [advancedSlug, setAdvancedSlug] = useState<string>('');
  const [view, setView] = useState<'credentials' | 'sso'>('credentials');
  const [ssoOrgSlugHint, setSsoOrgSlugHint] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [legalBlockedCode, setLegalBlockedCode] = useState<'LEGAL_CONSENT_OUTDATED' | 'DPA_NOT_SIGNED' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isMfaModalOpen, setIsMfaModalOpen] = useState<boolean>(false);
  const [mfaFactors, setMfaFactors] = useState<readonly MfaAvailableFactor[]>([]);
  const [requestedNext] = useState<string | null>(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('next')));

  const handleSsoRequired = useCallback((organizationSlug: string | null): void => {
    const fallbackSlug = advancedSlug.trim();
    setSsoOrgSlugHint(organizationSlug ?? (fallbackSlug.length > 0 ? fallbackSlug : null));
    setErrorMessage(null);
    setView('sso');
  }, [advancedSlug]);

  const applyLoginFailure = (result: AuthApiResult<LoginPayload>, organizationSlugFallback: string): void => {
    if (result.lockedUntilIso !== null || result.status === 423 || (result.errorMessage ?? '').includes('bloqueada')) {
      session.markLocked(resolveLockedUntilEpochMs(result.lockedUntilIso, result.retryAfterSeconds));
      setErrorMessage(null);
      return;
    }
    if (result.errorCode === 'LEGAL_CONSENT_OUTDATED' || result.errorCode === 'DPA_NOT_SIGNED') {
      setLegalBlockedCode(result.errorCode);
      return;
    }
    if ((result.errorMessage ?? '').includes('SSO corporativo')) {
      setSsoOrgSlugHint(organizationSlugFallback.length > 0 ? organizationSlugFallback : null);
      setView('sso');
      return;
    }
    setErrorMessage(result.status === 401 ? 'Correo o contraseña incorrectos.' : result.errorMessage ?? 'No fue posible iniciar sesión. Inténtalo de nuevo.');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setErrorMessage(null);
    setLegalBlockedCode(null);
    const normalizedEmail = emailValue.trim().toLowerCase();
    if (!isEmailLike(normalizedEmail)) {
      setErrorMessage('Ingresa un correo electrónico válido.');
      return;
    }
    if (passwordValue.length === 0) {
      setErrorMessage('Ingresa tu contraseña.');
      return;
    }
    const advancedOrganizationSlug = advancedSlug.trim();
    const body: Record<string, string> = { email: normalizedEmail, password: passwordValue };
    if (advancedOrganizationSlug.length > 0) {
      body['organizationSlug'] = advancedOrganizationSlug;
    }
    setIsSubmitting(true);
    const result = await authApiFetch<LoginPayload>(LOGIN_PATH, { method: 'POST', body });
    setIsSubmitting(false);
    if (!result.ok) {
      applyLoginFailure(result, advancedOrganizationSlug);
      return;
    }
    const payload = result.data;
    if (payload === null) {
      setErrorMessage('El servidor devolvió una respuesta vacía. Inténtalo de nuevo.');
      return;
    }
    if (payload.status === 'MFA_REQUIRED') {
      setMfaFactors(payload.availableFactors);
      session.beginMfaChallenge(payload.mfaChallengeToken);
      setIsMfaModalOpen(true);
      return;
    }
    const profile = buildSessionProfile({ user: payload.user, organization: toSessionOrganization(payload.organization), role: payload.role, mfaSatisfied: false });
    session.completeAuthentication(payload.accessToken, profile);
    window.location.assign(resolvePostAuthenticationPath(profile.role, profile.orgSlug, requestedNext));
  };

  const handleMfaVerified = (verified: { readonly accessToken: string; readonly user: AuthSessionUserProfile }): void => {
    setIsMfaModalOpen(false);
    session.completeAuthentication(verified.accessToken, verified.user);
    window.location.assign(resolvePostAuthenticationPath(verified.user.role, verified.user.orgSlug, requestedNext));
  };

  const handleMfaCancel = (): void => {
    setIsMfaModalOpen(false);
    session.cancelMfaChallenge();
  };

  if (view === 'sso') {
    return <SsoFederationPanel orgSlugHint={ssoOrgSlugHint} onReturnToCredentials={(): void => setView('credentials')} />;
  }

  return (
    <div style={COLUMN_STACK_STYLE}>
      {requestedNext === 'cli-device' ? <p className="atelier-badge-ember" style={{ alignSelf: 'flex-start', margin: 0 }}>Inicia sesión para autorizar tu terminal CLI</p> : null}
      {legalBlockedCode === null ? null : <LegalConsentBlockedPanel errorCode={legalBlockedCode} />}
      <LockedAccountCountdown lockedUntilEpochMs={session.lockedUntilEpochMs} />
      <form
        className="atelier-card"
        style={{ ...COLUMN_STACK_STYLE, padding: '16px 18px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', backgroundColor: 'var(--color-bone, #f2f1ed)' }}
        onSubmit={(event): void => void handleSubmit(event)}
      >
        <DomainDiscoveryEmailInput value={emailValue} onValueChange={setEmailValue} onSsoEnforced={handleSsoRequired} disabled={isSubmitting} />
        <label className="atelier-field">
          <span className="atelier-label">Contraseña</span>
          <input
            className="atelier-input" type="password" value={passwordValue} autoComplete="current-password"
            placeholder="••••••••••••" disabled={isSubmitting}
            onChange={(event): void => setPasswordValue(event.currentTarget.value)}
          />
        </label>
        <details>
          <summary className="atelier-help-text" style={{ cursor: 'pointer', fontSize: '11px' }}>Opciones avanzadas</summary>
          <div style={{ paddingTop: '8px' }}>
            <label className="atelier-field">
              <span className="atelier-label" style={{ fontSize: '11px' }}>Organización específica (opcional)</span>
              <input
                className="atelier-input atelier-mono" value={advancedSlug} placeholder="mi-organizacion"
                autoComplete="off" disabled={isSubmitting}
                onChange={(event): void => setAdvancedSlug(event.currentTarget.value)}
              />
              <span className="atelier-help-text" style={{ fontSize: '10.5px' }}>Solo si perteneces a más de una organización y quieres elegir el espacio de trabajo.</span>
            </label>
          </div>
        </details>
        {errorMessage === null ? null : <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{errorMessage}</p>}
        <AtelierPrimaryButton type="submit" fullWidth disabled={isSubmitting}>{isSubmitting ? 'Verificando…' : 'Iniciar sesión'}</AtelierPrimaryButton>
      </form>
      <MfaChallengeAndEnrollmentModal
        isOpen={isMfaModalOpen}
        mfaChallengeToken={session.mfaChallengeToken}
        availableFactors={mfaFactors}
        onVerified={handleMfaVerified}
        onCancel={handleMfaCancel}
      />
    </div>
  );
}

/**
 * Página de inicio de sesión B2B: tarjeta centrada compacta de 360px sobre el lienzo pergamino, con
 * accesos a registro, recuperación y autorización del CLI, y aviso legal breve.
 *
 * @returns Vista completa del acceso B2B.
 */
export default function B2BLoginPage(): ReactElement {
  return (
    <main style={PAGE_FRAME_STYLE}>
      <div style={{ width: '100%', maxWidth: '360px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', textAlign: 'center' }}>
          <Logo size={26} textTheme="dark" href="/" />
          <p className="atelier-eyebrow" style={{ color: 'var(--color-ember)', margin: 0, fontSize: '9.5px' }}>Onboarding Assistant</p>
          <h1 className="atelier-heading" style={{ fontSize: '17px', fontWeight: 500, margin: 0 }}>Inicia sesión en tu espacio de trabajo</h1>
        </header>

        <B2BAuthenticationBoundary />

        <footer style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11.5px', color: 'var(--color-driftwood)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', justifyContent: 'center' }}>
            <span>¿Nuevo? <a className="atelier-link" href="/auth/register">Crear cuenta</a></span>
            <span><a className="atelier-link" href="/auth/recovery">¿Olvidaste tu contraseña?</a></span>
            <span><a className="atelier-link" href={CLI_DEVICE_PATH}>Autorizar CLI</a></span>
          </div>
          <p style={{ margin: 0, textAlign: 'center', fontSize: '11px', color: 'var(--color-mist)' }}>
            Al continuar aceptas las <a className="atelier-link" href="/legal/tos-b2b">Condiciones B2B</a> y la <a className="atelier-link" href="/legal/privacy-policy">Política de privacidad</a>.
          </p>
        </footer>
      </div>
    </main>
  );
}
