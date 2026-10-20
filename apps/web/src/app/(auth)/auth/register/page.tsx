/**
 * @archivo apps/web/src/app/(auth)/auth/register/page.tsx
 * @modulo apps/web (Alta Directa de Organización — Registro Unificado Sin Fricción)
 * @proposito
 *   Vista `/auth/register`: formulario unificado en un solo panel para crear la organización B2B.
 *   El slug se autogenera en segundo plano sin exponer fricción al usuario; en su lugar se incluye
 *   un selector telefónico internacional con lista de países del mundo y código de área.
 *   Dispone de un checkbox maestro legal con enlaces directos en tipografía pequeña.
 */

'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  AtelierPrimaryButton,
  MonoMetadataTag,
  WindowMockupFrame,
} from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import { Logo } from '../../../../components/common/Logo';
import type {
  AuthApiResult,
  BackendPublicOrganization,
  BackendPublicUser,
} from '../../../../components/auth-legal/auth-api-client';
import {
  authApiFetch,
  buildSessionProfile,
  estimatePasswordEntropyBits,
} from '../../../../components/auth-legal/auth-api-client';
import { useAuthSession } from '../../../../components/auth-legal/useAuthSessionContext';

type RequestedPlanCode = 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50';
type LegalDocumentCode = 'TOS_B2B' | 'PRIVACY_POLICY' | 'DPA_ENTERPRISE' | 'AI_VOICE_AUP' | 'END_USER_VOICE_CONSENT';
type RegistrationErrorField = 'organizationName' | 'ownerPhone' | 'ownerFullName' | 'ownerEmail' | 'ownerPassword' | 'general';

interface RegistrationError { readonly field: RegistrationErrorField; readonly message: string; }
interface LegalConsentItem { readonly code: LegalDocumentCode; readonly title: string; readonly href: string; }
interface RegisterResponseBody { readonly accessToken?: string; readonly user?: unknown; readonly organization?: unknown; }
interface CheckoutSessionResponseBody { readonly signedUrl?: string; readonly gatewayCheckoutUrl?: string; }

import type { CountryDialData } from '../../../../components/auth-legal/country-dial-codes';
import { WORLD_COUNTRIES } from '../../../../components/auth-legal/country-dial-codes';
import { InternationalPhoneSelector } from '../../../../components/auth-legal/InternationalPhoneSelector';

const MINIMUM_PASSWORD_ENTROPY_BITS = 70;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUESTED_PLAN_CODES: readonly RequestedPlanCode[] = ['PAYG', 'PLAN_5', 'PLAN_10', 'PLAN_30', 'PLAN_50'];

const PLAN_DISPLAY_NAMES: Record<RequestedPlanCode, string> = {
  PAYG: 'Pago por uso',
  PLAN_5: 'Plan $5/mes',
  PLAN_10: 'Plan $10/mes',
  PLAN_30: 'Plan $30/mes',
  PLAN_50: 'Plan $50/mes',
};

const LEGAL_CONSENT_ITEMS: readonly LegalConsentItem[] = [
  { code: 'TOS_B2B', title: 'Términos del servicio B2B', href: '/legal/tos-b2b' },
  { code: 'PRIVACY_POLICY', title: 'Política de Privacidad', href: '/legal/privacy-policy' },
  { code: 'DPA_ENTERPRISE', title: 'Acuerdo DPA Empresarial', href: '/legal/dpa-enterprise' },
  { code: 'AI_VOICE_AUP', title: 'Uso Aceptable de Voz IA', href: '/legal/ai-voice-aup' },
  { code: 'END_USER_VOICE_CONSENT', title: 'Consentimiento de Voz de Usuarios Finales', href: '/legal/end-user-voice-consent' },
];

function slugifyOrganizationName(rawName: string): string {
  const base = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'org-' + Math.random().toString(36).substring(2, 8);
}

function isRequestedPlanCode(value: string | null): value is RequestedPlanCode {
  return value !== null && (REQUESTED_PLAN_CODES as readonly string[]).includes(value);
}

function isUnknownRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ParsedRegistration {
  readonly accessToken: string;
  readonly user: BackendPublicUser;
  readonly organization: BackendPublicOrganization | null;
}

function readRegisterPayload(payload: unknown): ParsedRegistration | null {
  if (!isUnknownRecord(payload)) return null;
  const token = payload['accessToken'];
  const raw = payload['user'];
  if (typeof token !== 'string' || !token || !isUnknownRecord(raw)) return null;
  const { id, email, fullName } = raw;
  if (typeof id !== 'string' || typeof email !== 'string' || typeof fullName !== 'string') return null;
  const user: BackendPublicUser = {
    id, email, fullName,
    emailVerified: raw['emailVerified'] === true,
    mfaTotpEnabled: raw['mfaTotpEnabled'] === true,
    mfaWebauthnEnabled: raw['mfaWebauthnEnabled'] === true,
    lastLoginAt: typeof raw['lastLoginAt'] === 'string' ? raw['lastLoginAt'] : null,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
  };
  return { accessToken: token, user, organization: readOrganizationPayload(payload['organization']) };
}

function readOrganizationPayload(payload: unknown): BackendPublicOrganization | null {
  if (!isUnknownRecord(payload)) return null;
  const { id, name, slug, status } = payload;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof slug !== 'string') return null;
  return { id, name, slug, status: typeof status === 'string' ? status : '' };
}

function readCheckoutUrl(p: unknown): string | null {
  if (!isUnknownRecord(p)) return null;
  const g = typeof p['gatewayCheckoutUrl'] === 'string' && p['gatewayCheckoutUrl'] ? p['gatewayCheckoutUrl'] : null;
  const s = typeof p['signedUrl'] === 'string' && p['signedUrl'] ? p['signedUrl'] : null;
  return g ?? s;
}

/** Formulario unificado de alta directa de organización con teléfono internacional. */
function OrganizationUnifiedSignUpForm(): ReactElement {
  const { completeAuthentication } = useAuthSession();
  const [organizationName, setOrganizationName] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<CountryDialData>(
    WORLD_COUNTRIES.find((c) => c.code === 'CO') ?? WORLD_COUNTRIES[0]!
  );
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [ownerFullName, setOwnerFullName] = useState<string>('');
  const [ownerEmail, setOwnerEmail] = useState<string>('');
  const [ownerPassword, setOwnerPassword] = useState<string>('');
  const [allLegalAccepted, setAllLegalAccepted] = useState<boolean>(false);
  const [showLegalDetails, setShowLegalDetails] = useState<boolean>(false);
  const [individualLegal, setIndividualLegal] = useState<Record<LegalDocumentCode, boolean>>({
    TOS_B2B: false, PRIVACY_POLICY: false, DPA_ENTERPRISE: false, AI_VOICE_AUP: false, END_USER_VOICE_CONSENT: false,
  });
  const [registrationError, setRegistrationError] = useState<RegistrationError | null>(null);
  const [isRegistering, setIsRegistering] = useState<boolean>(false);
  const [requestedPlan, setRequestedPlan] = useState<RequestedPlanCode | null>(null);
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | null>(null);

  useEffect((): void => {
    const searchParams = new URLSearchParams(window.location.search);
    const planParam = searchParams.get('plan');
    if (isRequestedPlanCode(planParam)) setRequestedPlan(planParam);
    const estimatedParam = Number.parseInt(searchParams.get('estimated_minutes') ?? '', 10);
    if (Number.isFinite(estimatedParam) && estimatedParam > 0) setEstimatedMinutes(estimatedParam);
  }, []);


  const passwordEntropyBits = estimatePasswordEntropyBits(ownerPassword);
  const entropyPercent = Math.min(100, Math.round((passwordEntropyBits / MINIMUM_PASSWORD_ENTROPY_BITS) * 100));
  const entropyToneColor = passwordEntropyBits >= MINIMUM_PASSWORD_ENTROPY_BITS ? 'var(--color-forest)' : passwordEntropyBits >= 50 ? 'var(--color-amber)' : 'var(--color-crimson)';
  const entropyStrengthLabel = passwordEntropyBits >= MINIMUM_PASSWORD_ENTROPY_BITS ? 'fuerte' : passwordEntropyBits >= 50 ? 'media' : 'débil';
  const emailFormatError = ownerEmail.length > 0 && !EMAIL_PATTERN.test(ownerEmail);
  const phoneClean = phoneNumber.replace(/[^0-9]/g, '');
  const phoneValid = phoneClean.length >= 7;
  // Vista previa del identificador unico: el sistema lo genera al crear la organizacion y,
  // si el nombre ya esta en uso, le anade un sufijo automaticamente. Aqui solo se anticipa la base.
  const slugPreview = organizationName.trim().length > 0 ? slugifyOrganizationName(organizationName) : '';

  const canSubmit = organizationName.trim().length > 0 &&
    ownerFullName.trim().length > 0 &&
    !emailFormatError &&
    phoneValid &&
    passwordEntropyBits >= MINIMUM_PASSWORD_ENTROPY_BITS &&
    (allLegalAccepted || LEGAL_CONSENT_ITEMS.every((item) => individualLegal[item.code]));

  function handleMasterCheckboxChange(checked: boolean): void {
    setAllLegalAccepted(checked);
    setIndividualLegal({ TOS_B2B: checked, PRIVACY_POLICY: checked, DPA_ENTERPRISE: checked, AI_VOICE_AUP: checked, END_USER_VOICE_CONSENT: checked });
  }

  function handleIndividualChange(code: LegalDocumentCode, checked: boolean): void {
    const next = { ...individualLegal, [code]: checked };
    setIndividualLegal(next);
    setAllLegalAccepted(LEGAL_CONSENT_ITEMS.every((item) => next[item.code]));
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || isRegistering) return;
    setIsRegistering(true);
    setRegistrationError(null);

    const generatedSlug = slugifyOrganizationName(organizationName);
    const fullPhone = `${selectedCountry.dial} ${phoneClean}`;

    const result = await authApiFetch<RegisterResponseBody>('/api/v1/auth/register', {
      method: 'POST', credentialsMode: 'include',
      body: {
        organizationName: organizationName.trim(),
        organizationSlug: generatedSlug,
        ownerFullName: ownerFullName.trim(),
        ownerEmail: ownerEmail.trim().toLowerCase(),
        ownerPassword,
        ownerPhone: fullPhone,
        acceptedLegalDocumentCodes: LEGAL_CONSENT_ITEMS
          .filter((item) => allLegalAccepted || individualLegal[item.code])
          .map((item) => item.code),
      },
    });

    if (!result.ok) {
      const err = `${result.errorCode ?? ''} ${result.errorMessage ?? ''}`.toLowerCase();
      const isEmail = result.status === 409 && (err.includes('correo') || err.includes('email'));
      const field: RegistrationErrorField = isEmail ? 'ownerEmail' : 'general';
      setRegistrationError({ field, message: result.errorMessage ?? 'No fue posible crear la organización.' });
      setIsRegistering(false);
      return;
    }

    const parsed = readRegisterPayload(result.data);
    if (!parsed) {
      setRegistrationError({ field: 'general', message: 'Respuesta inesperada del servidor. Inténtalo de nuevo.' });
      setIsRegistering(false);
      return;
    }

    completeAuthentication(parsed.accessToken, buildSessionProfile({
      user: parsed.user, organization: parsed.organization, role: 'OWNER', mfaSatisfied: false,
    }));

    const targetSlug = parsed.organization?.slug ?? generatedSlug;
    const dashboardUrl = targetSlug ? `/dashboard/org/${encodeURIComponent(targetSlug)}` : '/dashboard';

    if (requestedPlan) {
      const checkoutMode = requestedPlan === 'PAYG' ? 'PAY_AS_YOU_GO' : 'SUBSCRIPTION';
      const checkoutResult = await authApiFetch<CheckoutSessionResponseBody>('/api/v1/billing/checkout', {
        method: 'POST', credentialsMode: 'include', accessToken: parsed.accessToken,
        body: { planCode: requestedPlan, checkoutMode, redirectUrl: window.location.origin + dashboardUrl },
      });
      const checkoutUrl = checkoutResult.ok ? readCheckoutUrl(checkoutResult.data) : null;
      if (checkoutUrl) {
        window.location.assign(checkoutUrl);
        return;
      }
    }

    window.location.assign(dashboardUrl);
  }

  return (
    <WindowMockupFrame title={slugPreview.length > 0 ? slugPreview : 'alta-inmediata'}>
      <form onSubmit={(e): void => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {requestedPlan ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', borderRadius: 4, backgroundColor: 'var(--color-linen)' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-driftwood)' }}>Plan seleccionado para tu espacio:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {estimatedMinutes !== null ? (
                <span style={{ fontSize: '10px', color: 'var(--color-driftwood)' }}>≈ {estimatedMinutes} min/mes</span>
              ) : null}
              <MonoMetadataTag label={requestedPlan} value={PLAN_DISPLAY_NAMES[requestedPlan]} tone="accent" />
            </div>
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          <div className="atelier-field" style={{ gap: 2 }}>
            <label className="atelier-label" style={{ fontSize: '11px' }} htmlFor="reg-org-name">Nombre de organización</label>
            <input id="reg-org-name" className="atelier-input" type="text" value={organizationName} onChange={(e): void => setOrganizationName(e.target.value)} placeholder="Ej. Aurora Tech" disabled={isRegistering} />
            {slugPreview.length > 0 ? (
              <p style={{ fontSize: '10px', color: 'var(--color-driftwood)', margin: 0 }}>
                Identificador: <span className="atelier-mono">{slugPreview}</span> — el sistema lo genera al crear la organización y añade un sufijo si ya está en uso.
              </p>
            ) : null}
          </div>

          {/* Selector telefónico internacional dinámico con catálogo de todos los países del mundo */}
          <div className="atelier-field" style={{ gap: 2 }}>
            <label className="atelier-label" style={{ fontSize: '11px' }} htmlFor="reg-phone-number">Teléfono de contacto</label>
            <InternationalPhoneSelector
              country={selectedCountry}
              phoneNumber={phoneNumber}
              onCountryChange={setSelectedCountry}
              onPhoneNumberChange={setPhoneNumber}
              disabled={isRegistering}
            />
            {phoneNumber.length > 0 && !phoneValid ? (
              <p className="atelier-error-text" style={{ fontSize: '10px' }}>Ingresa al menos 7 dígitos válidos.</p>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          <div className="atelier-field" style={{ gap: 2 }}>
            <label className="atelier-label" style={{ fontSize: '11px' }} htmlFor="reg-owner-name">Tu nombre completo</label>
            <input id="reg-owner-name" className="atelier-input" type="text" autoComplete="name" value={ownerFullName} onChange={(e): void => setOwnerFullName(e.target.value)} placeholder="Ada Lovelace" disabled={isRegistering} />
          </div>
          <div className="atelier-field" style={{ gap: 2 }}>
            <label className="atelier-label" style={{ fontSize: '11px' }} htmlFor="reg-owner-email">Correo corporativo</label>
            <input id="reg-owner-email" className="atelier-input" type="email" autoComplete="email" value={ownerEmail} onChange={(e): void => setOwnerEmail(e.target.value)} placeholder="ada@empresa.com" disabled={isRegistering} />
            {emailFormatError ? <p className="atelier-error-text" style={{ fontSize: '10px' }}>Correo inválido.</p> : null}
            {registrationError?.field === 'ownerEmail' ? <p className="atelier-error-text" style={{ fontSize: '10px' }}>{registrationError.message}</p> : null}
          </div>
        </div>

        <div className="atelier-field" style={{ gap: 2 }}>
          <label className="atelier-label" style={{ fontSize: '11px' }} htmlFor="reg-owner-pass">Contraseña maestra</label>
          <input id="reg-owner-pass" className="atelier-input" type="password" autoComplete="new-password" value={ownerPassword} onChange={(e): void => setOwnerPassword(e.target.value)} placeholder="Mínimo 12 caracteres variados" disabled={isRegistering} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={entropyPercent} aria-label="Seguridad" style={{ height: 4, flex: 1, borderRadius: 999, backgroundColor: 'var(--color-linen)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${entropyPercent}%`, backgroundColor: entropyToneColor }} />
            </div>
            <span style={{ fontSize: '10.5px', color: entropyToneColor, whiteSpace: 'nowrap' }}>
              Fuerza {entropyStrengthLabel} ({Math.round(passwordEntropyBits)}/{MINIMUM_PASSWORD_ENTROPY_BITS} bits)
            </span>
          </div>
        </div>

        {/* Checkbox Maestro Legal Unificado */}
        <div style={{ border: '1px solid var(--color-stone)', borderRadius: 4, padding: '8px 10px', backgroundColor: 'var(--color-bone)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="atelier-checkbox-row" style={{ alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginTop: 2, cursor: 'pointer' }} checked={allLegalAccepted} onChange={(e): void => handleMasterCheckboxChange(e.target.checked)} />
            <span style={{ fontSize: '11px', lineHeight: 1.35, color: 'var(--color-ink)' }}>
              <strong>Acepto todos los acuerdos legales para mi organización:</strong>
              <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--color-driftwood)', marginTop: 2 }}>
                <a className="atelier-link" href="/legal/tos-b2b" target="_blank" rel="noreferrer">Términos B2B</a> ·{' '}
                <a className="atelier-link" href="/legal/privacy-policy" target="_blank" rel="noreferrer">Privacidad</a> ·{' '}
                <a className="atelier-link" href="/legal/dpa-enterprise" target="_blank" rel="noreferrer">DPA Empresarial</a> ·{' '}
                <a className="atelier-link" href="/legal/ai-voice-aup" target="_blank" rel="noreferrer">Uso Aceptable Voz IA</a> ·{' '}
                <a className="atelier-link" href="/legal/end-user-voice-consent" target="_blank" rel="noreferrer">Consentimiento de Voz de Usuarios Finales</a>
              </span>
            </span>
          </label>

          <button type="button" onClick={(): void => setShowLegalDetails(!showLegalDetails)} style={{ background: 'none', border: 'none', padding: 0, fontSize: '10px', color: 'var(--color-ash)', textAlign: 'left', cursor: 'pointer', textDecoration: 'underline', width: 'fit-content' }}>
            {showLegalDetails ? 'Ocultar detalle de acuerdos' : 'Ver y marcar acuerdos por separado'}
          </button>

          {showLegalDetails ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4, borderTop: '1px solid var(--border-hairline)' }}>
              {LEGAL_CONSENT_ITEMS.map((item) => (
                <label key={item.code} className="atelier-checkbox-row" style={{ gap: 5, fontSize: '10.5px' }}>
                  <input type="checkbox" checked={individualLegal[item.code]} onChange={(e): void => handleIndividualChange(item.code, e.target.checked)} />
                  <span>{item.title} (<a className="atelier-link" href={item.href} target="_blank" rel="noreferrer">leer</a>)</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <p style={{ margin: 0, fontSize: '10.5px', lineHeight: 1.45, color: 'var(--color-driftwood)' }}>
          <strong style={{ color: 'var(--color-ink)' }}>Compromiso con tus usuarios finales:</strong> antes de activar el micrófono deberás obtener su consentimiento de voz y certificarlo desde tu sistema. La{' '}
          <a className="atelier-link" href="/docs" target="_blank" rel="noreferrer">documentación para desarrolladores</a>{' '}
          describe el procedimiento; el aviso de consentimiento queda incluido en los acuerdos que aceptas aquí.
        </p>

        {registrationError?.field === 'general' ? (
          <p className="atelier-error-text" role="alert" style={{ fontSize: '11px', margin: 0 }}>{registrationError.message}</p>
        ) : null}

        <AtelierPrimaryButton type="submit" fullWidth disabled={!canSubmit || isRegistering}>
          {isRegistering ? 'Creando organización y configurando espacio…' : 'Crear cuenta y empezar'}
        </AtelierPrimaryButton>
      </form>
    </WindowMockupFrame>
  );
}

/** Página `/auth/register`: cascarón Atelier que monta el registro unificado directo. */
export default function RegisterOrganizationPage(): ReactElement {
  return (
    <main
      className="atelier-shell"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '20px 16px',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
        <Logo size={26} textTheme="dark" href="/" />
        <p className="atelier-eyebrow" style={{ margin: 0, fontSize: '9.5px' }}>Alta directa de organización</p>
        <h1 className="atelier-heading" style={{ fontSize: '18px', fontWeight: 500, margin: 0 }}>Crea tu espacio de trabajo</h1>
      </header>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <OrganizationUnifiedSignUpForm />
      </div>
      <p className="atelier-mono" style={{ margin: 0, fontSize: '11px' }}>
        ¿Ya tienes cuenta? <a className="atelier-link" href="/auth/login">Inicia sesión</a>
      </p>
    </main>
  );
}
