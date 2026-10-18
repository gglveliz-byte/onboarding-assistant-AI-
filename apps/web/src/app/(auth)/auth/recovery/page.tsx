/**
 * @archivo apps/web/src/app/(auth)/auth/recovery/page.tsx
 * @modulo 08. Frontend Compartido — Acceso (recuperación de cuenta e invitaciones)
 * @proposito
 *   Página pública de recuperación de cuenta que despacha por parámetros de consulta:
 *   solicitud de restablecimiento anti-enumeración (respuesta neutra exista o no la
 *   cuenta), confirmación con token efímero y medidor de entropía, y aceptación de
 *   invitaciones a organizaciones exigiendo sesión activa.
 *
 * @resumen_contenido
 *   - `AccountRecoveryPage`: lee `window.location.search` en `useEffect` y elige la vista.
 *   - `ForgotPasswordView`: `POST /api/v1/auth/password-reset/request { email }` con
 *     confirmación neutra («si el correo existe recibirás instrucciones»).
 *   - `ResetPasswordConfirmView`: contraseña x2 con `estimatePasswordEntropyBits`,
 *     mínimo real de 8 caracteres y recomendación de ≥70 bits; envía
 *     `POST /api/v1/auth/password-reset/confirm { token, newPassword }`.
 *   - `OrganizationInviteAcceptor`: exige sesión (`useAuthSession()`); sin sesión ofrece
 *     `/auth/login?next=invite&token=<valor>`; con sesión envía
 *     `POST /api/v1/auth/invitations/accept { token, userId }` y muestra organización y rol.
 *
 * @dependencias_internas
 *   - `../../../../components/auth-legal/auth-api-client` (contrato real del Subagente 2.2):
 *     `authApiFetch` (sobre `AuthApiResult<T>`, nunca lanza) y `estimatePasswordEntropyBits`.
 *   - `../../../../components/auth-legal/useAuthSessionContext`: `useAuthSession()`
 *     (`user: AuthSessionUserProfile | null`); el proveedor lo monta el layout `(auth)`.
 *   - `../../../../components/atelier-primitives/AtelierUiPrimitives`: botones y etiqueta mono.
 *
 * @dependencias_externas
 *   - Solo `react`. Prohibido `next/*` e iconotecas.
 *
 * @notas
 *   - El estado HTTP llega en `result.status` y el cuerpo en `result.data`; el cliente único
 *     nunca lanza por errores HTTP (red caída = `status: 0`).
 *   - Anti-enumeración: el estado de éxito de la solicitud es idéntico exista o no la cuenta.
 *   - En invitaciones el principal no viaja (ruta pública); el destinatario se identifica
 *     con el `userId` de la sesión en RAM, que el backend contrasta con la invitación.
 */

'use client';

import type { FormEvent, ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import {
  AtelierPrimaryButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
} from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import type { MonoMetadataTone } from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import {
  authApiFetch,
  estimatePasswordEntropyBits,
} from '../../../../components/auth-legal/auth-api-client';
import { useAuthSession } from '../../../../components/auth-legal/useAuthSessionContext';

// Rutas reales del backend sellado (Parte 5) consumidas por esta página.
const PASSWORD_RESET_REQUEST_PATH = '/api/v1/auth/password-reset/request';
const PASSWORD_RESET_CONFIRM_PATH = '/api/v1/auth/password-reset/confirm';
const INVITATIONS_ACCEPT_PATH = '/api/v1/auth/invitations/accept';

/** Mínimo real exigido por el backend para la contraseña nueva. */
const MIN_PASSWORD_LENGTH = 8;

/** Entropía mínima recomendada por el equipo de seguridad (bits estimados). */
const RECOMMENDED_ENTROPY_BITS = 70;

/** Parámetros de consulta reconocidos por la página de recuperación. */
interface RecoveryQuery {
  readonly token: string | null;
  readonly invite: string | null;
}

/** Resultado legible de la aceptación de una invitación. */
interface InvitationAcceptance {
  readonly organizationId: string;
  readonly role: string;
  readonly message: string;
}

/** Lee un campo de texto no vacío de un registro JSON sin afirmar tipos. */
function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Parsea `window.location.search` en los parámetros soportados (`token`, `invite`). */
function parseRecoveryQuery(search: string): RecoveryQuery {
  const params = new URLSearchParams(search);
  const readParam = (key: string): string | null => {
    const value = params.get(key);
    return value !== null && value.trim().length > 0 ? value.trim() : null;
  };
  return { token: readParam('token'), invite: readParam('invite') };
}

/** Valida y extrae `{ organizationId, role, message }` de la respuesta real del backend. */
function parseInvitationAcceptance(data: unknown): InvitationAcceptance | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const organizationId = readStringField(record, 'organizationId');
  const role = readStringField(record, 'role');
  if (organizationId === null || role === null) {
    return null;
  }
  const message = readStringField(record, 'message') ?? 'Invitación aceptada exitosamente.';
  return { organizationId, role, message };
}

/** Marco visual centrado de las vistas de recuperación sobre pergamino cálido. */
function RecoveryCardFrame(props: { readonly eyebrow: string; readonly children: ReactNode }): ReactElement {
  const { eyebrow, children } = props;
  return (
    <main className="atelier-shell flex min-h-screen items-center justify-center p-6" data-portal="workspace-atelier">
      <section className="atelier-card flex w-full max-w-md flex-col gap-4">
        <p className="atelier-eyebrow">{eyebrow}</p>
        {children}
      </section>
    </main>
  );
}

/** Medidor de entropía estimada: barra y sello mono con el valor en bits. */
function PasswordEntropyMeter(props: { readonly password: string }): ReactElement {
  const { password } = props;
  const bits = password.length === 0 ? 0 : Math.max(0, Math.round(estimatePasswordEntropyBits(password)));
  const percentFill = password.length === 0 ? 0 : Math.max(6, Math.min(100, bits));
  const tone: MonoMetadataTone = bits >= RECOMMENDED_ENTROPY_BITS ? 'success' : bits >= 40 ? 'accent' : 'danger';
  const barClassName =
    tone === 'success'
      ? 'bg-[var(--color-verdant)]'
      : tone === 'accent'
        ? 'bg-[var(--color-amber)]'
        : 'bg-[var(--color-crimson)]';

  return (
    <div className="flex flex-col gap-2">
      <div className="h-1 w-full overflow-hidden rounded-sm bg-[var(--color-linen)]">
        <div className={barClassName} style={{ width: `${percentFill}%`, height: '100%' }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="atelier-help-text">Entropía estimada (recomendado ≥ {RECOMMENDED_ENTROPY_BITS} bits)</span>
        <MonoMetadataTag label="BITS" value={String(bits)} tone={tone} />
      </div>
    </div>
  );
}

/** Vista de solicitud de restablecimiento: respuesta neutra idéntica exista o no la cuenta. */
function ForgotPasswordView(): ReactElement {
  const [email, setEmail] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [wasRequested, setWasRequested] = useState<boolean>(false);

  const handleRequestReset = useCallback(async (): Promise<void> => {
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await authApiFetch<unknown>(PASSWORD_RESET_REQUEST_PATH, {
      method: 'POST',
      body: { email: email.trim() },
    });
    setIsSubmitting(false);
    if (result.ok) {
      setWasRequested(true);
      return;
    }
    if (result.status === 429 || result.retryAfterSeconds !== null) {
      setErrorMessage('Demasiados intentos recientes. Espera unos minutos antes de volver a intentarlo.');
      return;
    }
    setErrorMessage('No pudimos registrar la solicitud en este momento. Intenta de nuevo en unos segundos.');
  }, [email]);

  if (wasRequested) {
    return (
      <RecoveryCardFrame eyebrow="Recuperación de cuenta">
        <h1 className="atelier-heading-sm">Revisa tu correo</h1>
        <p className="atelier-prose">
          Si el correo existe en nuestra plataforma, recibirás las instrucciones para restablecer tu contraseña.
          Revisa también tu carpeta de correo no deseado.
        </p>
        <MonoMetadataTag label="SOLICITUD" value="RECIBIDA" tone="success" />
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="atelier-link" onClick={(): void => setWasRequested(false)}>
            Probar con otro correo
          </button>
          <a className="atelier-link" href="/auth/login">Volver a iniciar sesión</a>
        </div>
      </RecoveryCardFrame>
    );
  }

  return (
    <RecoveryCardFrame eyebrow="Recuperación de cuenta">
      <h1 className="atelier-heading-sm">Restablecer contraseña</h1>
      <p className="atelier-prose">
        Escribe el correo de tu cuenta y te enviaremos las instrucciones para crear una contraseña nueva.
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          if (!isSubmitting && email.trim().length > 0) {
            void handleRequestReset();
          }
        }}
      >
        <label className="atelier-field">
          <span className="atelier-label">Correo electrónico</span>
          <input
            className="atelier-input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event): void => setEmail(event.currentTarget.value)}
            placeholder="tu@empresa.com"
          />
        </label>
        {errorMessage !== null ? <p className="atelier-error-text">{errorMessage}</p> : null}
        <AtelierPrimaryButton type="submit" fullWidth disabled={isSubmitting || email.trim().length === 0}>
          {isSubmitting ? 'Enviando…' : 'Enviar instrucciones'}
        </AtelierPrimaryButton>
      </form>
      <a className="atelier-link" href="/auth/login">Volver a iniciar sesión</a>
    </RecoveryCardFrame>
  );
}

/** Vista de confirmación con token efímero: contraseña nueva x2, entropía y envío al backend. */
function ResetPasswordConfirmView(props: { readonly token: string }): ReactElement {
  const { token } = props;
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmation, setConfirmation] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [wasConfirmed, setWasConfirmed] = useState<boolean>(false);

  const passwordsMatch = newPassword.length > 0 && newPassword === confirmation;
  const meetsMinimum = newPassword.length >= MIN_PASSWORD_LENGTH;

  const handleConfirmReset = useCallback(async (): Promise<void> => {
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await authApiFetch<unknown>(PASSWORD_RESET_CONFIRM_PATH, {
      method: 'POST',
      body: { token, newPassword },
    });
    setIsSubmitting(false);
    if (result.ok) {
      setWasConfirmed(true);
      return;
    }
    if (result.status === 401) {
      setErrorMessage('El enlace de restablecimiento es inválido o ha expirado. Solicita uno nuevo.');
      return;
    }
    if (result.status === 400) {
      setErrorMessage('La contraseña no cumple los requisitos mínimos de seguridad.');
      return;
    }
    setErrorMessage('No pudimos actualizar la contraseña en este momento. Intenta de nuevo.');
  }, [newPassword, token]);

  if (wasConfirmed) {
    return (
      <RecoveryCardFrame eyebrow="Recuperación de cuenta">
        <h1 className="atelier-heading-sm">Contraseña actualizada</h1>
        <p className="atelier-prose">
          Ya puedes iniciar sesión con tus nuevas credenciales. Por seguridad, cerramos las sesiones anteriores.
        </p>
        <MonoMetadataTag label="ESTADO" value="CONFIRMADA" tone="success" />
        <AtelierPrimaryButton fullWidth onClick={(): void => { window.location.assign('/auth/login'); }}>
          Ir a iniciar sesión
        </AtelierPrimaryButton>
      </RecoveryCardFrame>
    );
  }

  return (
    <RecoveryCardFrame eyebrow="Recuperación de cuenta">
      <h1 className="atelier-heading-sm">Crea tu contraseña nueva</h1>
      <p className="atelier-prose">
        El enlace es de un solo uso y caduca pronto. Usa una contraseña larga y única para tu cuenta.
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          if (isSubmitting || !meetsMinimum || !passwordsMatch) {
            return;
          }
          void handleConfirmReset();
        }}
      >
        <label className="atelier-field">
          <span className="atelier-label">Contraseña nueva</span>
          <input
            className="atelier-input"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event): void => setNewPassword(event.currentTarget.value)}
          />
        </label>
        <PasswordEntropyMeter password={newPassword} />
        <label className="atelier-field">
          <span className="atelier-label">Repite la contraseña</span>
          <input
            className="atelier-input"
            type="password"
            required
            autoComplete="new-password"
            value={confirmation}
            onChange={(event): void => setConfirmation(event.currentTarget.value)}
          />
        </label>
        {newPassword.length > 0 && !meetsMinimum ? (
          <p className="atelier-error-text">La contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres.</p>
        ) : null}
        {confirmation.length > 0 && !passwordsMatch ? (
          <p className="atelier-error-text">Las dos contraseñas no coinciden.</p>
        ) : null}
        {errorMessage !== null ? <p className="atelier-error-text">{errorMessage}</p> : null}
        <AtelierPrimaryButton type="submit" fullWidth disabled={isSubmitting || !meetsMinimum || !passwordsMatch}>
          {isSubmitting ? 'Actualizando…' : 'Actualizar contraseña'}
        </AtelierPrimaryButton>
      </form>
      <a className="atelier-link" href="/auth/recovery">Solicitar un enlace nuevo</a>
    </RecoveryCardFrame>
  );
}

/** Vista de aceptación de invitación: exige sesión activa y confirma organización y rol. */
function OrganizationInviteAcceptor(props: { readonly inviteToken: string }): ReactElement {
  const { inviteToken } = props;
  const { user } = useAuthSession();
  const [isMounted, setIsMounted] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acceptance, setAcceptance] = useState<InvitationAcceptance | null>(null);

  useEffect((): void => {
    setIsMounted(true);
  }, []);

  const handleAcceptInvitation = useCallback(async (): Promise<void> => {
    if (user === null) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await authApiFetch<unknown>(INVITATIONS_ACCEPT_PATH, {
      method: 'POST',
      body: { token: inviteToken, userId: user.userId },
    });
    setIsSubmitting(false);
    if (!result.ok) {
      if (result.status === 401) {
        setErrorMessage('La invitación es inválida, ya fue utilizada o ha expirado.');
        return;
      }
      if (result.status === 403) {
        setErrorMessage('Esta invitación fue emitida para otra cuenta y no puedes aceptarla con la sesión actual.');
        return;
      }
      setErrorMessage('No pudimos aceptar la invitación en este momento. Intenta de nuevo.');
      return;
    }
    const parsed = parseInvitationAcceptance(result.data);
    if (parsed === null) {
      setErrorMessage('La respuesta del servidor no tiene el formato esperado. Intenta de nuevo.');
      return;
    }
    setAcceptance(parsed);
  }, [inviteToken, user]);

  if (!isMounted) {
    return (
      <RecoveryCardFrame eyebrow="Invitación a organización">
        <p className="atelier-help-text">Comprobando tu sesión…</p>
      </RecoveryCardFrame>
    );
  }

  if (acceptance !== null) {
    return (
      <RecoveryCardFrame eyebrow="Invitación a organización">
        <h1 className="atelier-heading-sm">Bienvenido a tu organización</h1>
        <p className="atelier-prose">{acceptance.message}</p>
        <div className="flex flex-wrap items-center gap-2">
          <MonoMetadataTag label="ROL" value={acceptance.role} tone="success" />
          <MonoMetadataTag label="ORG" value={acceptance.organizationId} />
        </div>
        <a className="atelier-link" href="/auth/login">Ir a iniciar sesión</a>
      </RecoveryCardFrame>
    );
  }

  if (user === null) {
    return (
      <RecoveryCardFrame eyebrow="Invitación a organización">
        <h1 className="atelier-heading-sm">Acepta tu invitación</h1>
        <p className="atelier-prose">
          Para unirte a la organización solo falta confirmar tu identidad: inicia sesión (o crea tu cuenta con el
          correo invitado) y volverás aquí automáticamente.
        </p>
        <a
          className="atelier-btn atelier-btn--primary atelier-btn--full"
          href={`/auth/login?next=invite&token=${encodeURIComponent(inviteToken)}`}
        >
          Iniciar sesión para aceptar
        </a>
      </RecoveryCardFrame>
    );
  }

  return (
    <RecoveryCardFrame eyebrow="Invitación a organización">
      <h1 className="atelier-heading-sm">Acepta tu invitación</h1>
      <p className="atelier-prose">
        Todo listo: confirma la invitación y quedarás vinculado a la organización con el rol que te asignaron.
      </p>
      <p className="atelier-mono">Sesión activa: {user.email}</p>
      {errorMessage !== null ? <p className="atelier-error-text">{errorMessage}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <AtelierSecondaryButton onClick={(): void => { window.location.assign('/auth/login'); }}>
          Cambiar de cuenta
        </AtelierSecondaryButton>
        <AtelierPrimaryButton onClick={(): void => { void handleAcceptInvitation(); }} disabled={isSubmitting}>
          {isSubmitting ? 'Aceptando…' : 'Aceptar invitación'}
        </AtelierPrimaryButton>
      </div>
    </RecoveryCardFrame>
  );
}

/**
 * Página de recuperación: despacha por consulta (`?token=`, `?invite=`) tras leer
 * `window.location.search` en el cliente.
 */
export default function AccountRecoveryPage(): ReactElement {
  const [query, setQuery] = useState<RecoveryQuery | null>(null);

  useEffect((): void => {
    setQuery(parseRecoveryQuery(window.location.search));
  }, []);

  if (query === null) {
    return (
      <RecoveryCardFrame eyebrow="Recuperación de cuenta">
        <p className="atelier-help-text">Preparando el formulario…</p>
      </RecoveryCardFrame>
    );
  }

  if (query.token !== null) {
    return <ResetPasswordConfirmView token={query.token} />;
  }

  if (query.invite !== null) {
    return <OrganizationInviteAcceptor inviteToken={query.invite} />;
  }

  return <ForgotPasswordView />;
}
