/**
 * @archivo apps/web/src/app/(auth)/auth/cli-device/page.tsx
 * @modulo apps/web (Portal de Autenticación — Confirmación Web del Device Flow del CLI)
 * @proposito
 *   Confirmación en navegador del flujo de autorización de dispositivo RFC 8628: exige una
 *   sesión activa (rehidratada de forma silenciosa contra `POST /api/v1/auth/refresh`), recibe
 *   el código amigable `XXXX-XXXX` que muestra la terminal y lo confirma contra el campo exacto
 *   `userCode` de `POST /api/v1/auth/cli-device/confirm`. Presenta estados de éxito (verde
 *   forest con la instrucción «la CLI ya puede continuar»), código inválido o expirado
 *   (carmesí) y sesión vencida (corte inmediato a `/auth/login?next=cli-device`).
 *
 * @resumen_contenido
 *   - `CliDeviceAuthorizationBoundary`: comprobación de sesión, campo auto-formateado con el
 *     patrón `^[A-Z0-9]{4}-[A-Z0-9]{4}$`, envío con Bearer en memoria y máquina de estados.
 *   - `CliDeviceAuthorizationPage`: cabecera con `WindowMockupFrame` del sistema Atelier.
 *
 * @dependencias_internas
 *   - `components/auth-legal/auth-api-client` (Subagente 2.2): `authApiFetch` con Bearer opcional.
 *   - `components/auth-legal/useAuthSessionContext` (Subagente 2.2): sesión en memoria RAM; el
 *     `AuthSessionProvider` y la hoja Atelier los aporta el layout del grupo (`(auth)/layout.tsx`).
 *   - `components/atelier-primitives/AtelierUiPrimitives` (botón, etiqueta mono y marco de ventana).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks). Sin `next/*`: navegación con `<a href>` y `window.location`.
 *
 * @notas
 *   - El backend responde 200 con `{ confirmed: true }` y 400 con `{ confirmed: false }` para
 *     códigos inválidos o expirados (normaliza el código a mayúsculas por su cuenta).
 *   - La sesión vive en RAM: al recargar esta página se rehidrata una única vez con la cookie
 *     de refresco `__Host-oa_rt` (SameSite=Strict, HttpOnly) antes de declarar falta de sesión.
 */

'use client';

import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AtelierPrimaryButton, MonoMetadataTag, WindowMockupFrame } from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import { Logo } from '../../../../components/common/Logo';
import { authApiFetch } from '../../../../components/auth-legal/auth-api-client';
import { useAuthSession } from '../../../../components/auth-legal/useAuthSessionContext';

/* ---------- Rutas, patrón y estilos ---------- */

/** Ruta real de confirmación web del Device Flow (campo `userCode` en el cuerpo). */
const CLI_DEVICE_CONFIRM_PATH = '/api/v1/auth/cli-device/confirm';

/** Corte a login conservando el retorno automático a esta pantalla. */
const LOGIN_WITH_NEXT_PATH = '/auth/login?next=cli-device';

/** Patrón canónico del código de usuario emitido por el backend (`XXXX-XXXX`). */
const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Longitud máxima del campo con el guion incluido. */
const USER_CODE_MAX_LENGTH = 9;

/** Lienzo centrado de la página sobre el pergamino que aporta el layout del grupo `(auth)`. */
const PAGE_FRAME_STYLE: CSSProperties = { minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 'clamp(16px, 4vw, 40px) 16px' };

/** Pila vertical estándar del contenido del marco de ventana (separación de 12px). */
const WINDOW_STACK_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '12px' };

/* ---------- Tipos y ayudas ---------- */

/** Respuesta real de `POST /api/v1/auth/cli-device/confirm`. */
interface CliDeviceConfirmPayload { readonly confirmed?: boolean; }

/** Máquina de estados visual de la confirmación. */
type CliDeviceView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'success'; readonly userCode: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Normaliza la entrada del código a mayúsculas alfanuméricas con guion automático a los 4.
 *
 * @param raw - Texto crudo del campo.
 * @returns Código parcial o completo con formato `XXXX-XXXX`.
 */
function formatUserCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  return compact.length <= 4 ? compact : `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/* ---------- Frontera de autorización y página ---------- */

/**
 * Frontera de autorización: comprueba la sesión, captura el código y confirma contra el backend.
 *
 * @returns Formulario, aviso de sesión requerida, éxito forest o error carmesí.
 */
function CliDeviceAuthorizationBoundary(): ReactElement {
  const { accessToken, isAuthenticated, refreshAccessToken } = useAuthSession();
  const [userCode, setUserCode] = useState<string>('');
  const [view, setView] = useState<CliDeviceView>({ kind: 'idle' });
  const [isSessionCheckDone, setIsSessionCheckDone] = useState<boolean>(false);
  const didRequestRehydrateRef = useRef<boolean>(false);

  useEffect((): void => {
    if (isAuthenticated) {
      setIsSessionCheckDone(true);
      return;
    }
    if (didRequestRehydrateRef.current) {
      return;
    }
    didRequestRehydrateRef.current = true;
    void refreshAccessToken().then((): void => {
      setIsSessionCheckDone(true);
    });
  }, [isAuthenticated, refreshAccessToken]);

  const handleRetrySession = (): void => {
    setIsSessionCheckDone(false);
    void refreshAccessToken().then((): void => {
      setIsSessionCheckDone(true);
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (view.kind === 'submitting') {
      return;
    }
    if (!USER_CODE_PATTERN.test(userCode)) {
      setView({ kind: 'error', message: 'Revisa el código: usa el formato XXXX-XXXX.' });
      return;
    }
    setView({ kind: 'submitting' });
    const result = await authApiFetch<CliDeviceConfirmPayload>(CLI_DEVICE_CONFIRM_PATH, {
      method: 'POST',
      body: { userCode },
      ...(accessToken === null ? {} : { accessToken }),
    });
    if (!result.ok) {
      if (result.status === 401) {
        window.location.assign(LOGIN_WITH_NEXT_PATH);
        return;
      }
      setView({ kind: 'error', message: 'El código es inválido o ha expirado. Genera uno nuevo desde tu terminal.' });
      return;
    }
    if (result.data !== null && result.data.confirmed === true) {
      setView({ kind: 'success', userCode });
      return;
    }
    setView({ kind: 'error', message: 'El código es inválido o ha expirado. Genera uno nuevo desde tu terminal.' });
  };

  if (!isAuthenticated && !isSessionCheckDone) {
    return (
      <WindowMockupFrame title="oa-cli · autorización de dispositivo" tabs={['device.authorize']}>
        <p className="atelier-help-text" style={{ margin: 0 }}>Comprobando tu sesión…</p>
      </WindowMockupFrame>
    );
  }

  if (!isAuthenticated) {
    return (
      <WindowMockupFrame title="oa-cli · autorización de dispositivo" tabs={['device.authorize']}>
        <div style={WINDOW_STACK_STYLE}>
          <h2 className="atelier-heading-sm">Necesitas una sesión activa</h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood)' }}>Para autorizar tu terminal primero inicia sesión; volverás a esta pantalla automáticamente.</p>
          <a className="atelier-btn atelier-btn--primary atelier-btn--full" href={LOGIN_WITH_NEXT_PATH}>Iniciar sesión</a>
          <button type="button" className="atelier-link" onClick={handleRetrySession}>Ya inicié sesión: reintentar</button>
        </div>
      </WindowMockupFrame>
    );
  }

  if (view.kind === 'success') {
    return (
      <WindowMockupFrame title="oa-cli · autorización de dispositivo" tabs={['device.authorize']}>
        <div style={WINDOW_STACK_STYLE}>
          <MonoMetadataTag label="AUTORIZADO" value={view.userCode} tone="success" />
          <h2 className="atelier-heading-sm" style={{ color: 'var(--color-forest)' }}>La CLI ya puede continuar</h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood)' }}>Vuelve a tu terminal: la sesión se completará automáticamente en unos segundos. No necesitas hacer nada más.</p>
          <div style={{ display: 'flex', gap: '16px' }}>
            <button
              type="button"
              className="atelier-link"
              onClick={(): void => {
                setUserCode('');
                setView({ kind: 'idle' });
              }}
            >
              Autorizar otro dispositivo
            </button>
            <a className="atelier-link" href="/docs">Ir a la documentación</a>
          </div>
        </div>
      </WindowMockupFrame>
    );
  }

  return (
    <WindowMockupFrame title="oa-cli · autorización de dispositivo" tabs={['device.authorize']}>
      <form style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} onSubmit={(event): void => void handleSubmit(event)}>
        <p className="atelier-prose" style={{ margin: 0 }}>Tu terminal inició una sesión sin navegador. Escribe el código que muestra para vincularla a tu cuenta.</p>
        <label className="atelier-field">
          <span className="atelier-label">Código del dispositivo</span>
          <input
            className="atelier-input atelier-mono"
            style={{ textAlign: 'center', letterSpacing: '0.25em' }}
            value={userCode}
            placeholder="XXXX-XXXX"
            maxLength={USER_CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={view.kind === 'submitting'}
            onChange={(event): void => setUserCode(formatUserCode(event.currentTarget.value))}
          />
          <span className="atelier-help-text">Formato XXXX-XXXX; el código aparece en tu terminal y expira en 10 minutos.</span>
        </label>
        {view.kind === 'error' ? <p className="atelier-error-text" role="alert" style={{ margin: 0 }}>{view.message}</p> : null}
        <AtelierPrimaryButton type="submit" fullWidth disabled={view.kind === 'submitting' || !USER_CODE_PATTERN.test(userCode)}>
          {view.kind === 'submitting' ? 'Autorizando…' : 'Autorizar dispositivo'}
        </AtelierPrimaryButton>
      </form>
    </WindowMockupFrame>
  );
}

/**
 * Página de autorización del CLI: cabecera técnica con el marco de ventana macOS del sistema
 * Atelier y la tarjeta de confirmación del Device Flow.
 *
 * @returns Vista completa de la confirmación web del dispositivo.
 */
export default function CliDeviceAuthorizationPage(): ReactElement {
  return (
    <main style={PAGE_FRAME_STYLE}>
      <div style={{ width: '100%', maxWidth: '520px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center' }}>
          <Logo size={34} textTheme="dark" href="/" />
          <p className="atelier-eyebrow" style={{ color: 'var(--color-ember)', margin: 0 }}>Autorización de dispositivo CLI</p>
          <h1 className="atelier-heading">Autoriza tu terminal</h1>
        </header>

        <CliDeviceAuthorizationBoundary />
      </div>
    </main>
  );
}
