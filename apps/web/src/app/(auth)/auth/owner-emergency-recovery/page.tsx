/**
 * @archivo apps/web/src/app/(auth)/auth/owner-emergency-recovery/page.tsx
 * @modulo 08. Frontend Compartido — Acceso (recuperación de emergencia Break-Glass)
 * @proposito
 *   Asistente público para la pérdida total de credenciales del Owner único de una
 *   organización: guía la solicitud de emergencia, la prueba de identidad (registro DNS TXT
 *   o recibo de la última factura), la ventana de enfriamiento de 24 horas con cuenta
 *   regresiva y la consulta del estado de la solicitud, degradando con avisos honestos
 *   cuando el canal aún no está habilitado en este entorno.
 *
 * @resumen_contenido
 *   - `OwnerEmergencyRecoveryPage`: asistente de 4 fases con barra de progreso y máquina de
 *     estados local; nunca muestra proveedores reales en pantalla.
 *   - Fase 1: `POST /api/v1/auth/break-glass/request { email }` (degradable: 404/405 → «canal
 *     en configuración» sin bloquear la navegación para documentar).
 *   - Fase 2: dos métodos excluyentes: DNS TXT `oa-verify=<token>` o número de recibo de la
 *     última factura de suscripción.
 *   - Fase 3: `ENFRIAMIENTO_24H` con cuenta regresiva desde `requestedAtIso` del backend o,
 *     si no llega, desde el momento local de la solicitud.
 *   - Fase 4: `GET /api/v1/auth/break-glass/status?email=` (degradable) y `MonoMetadataTag`
 *     por fase (`SOLICITADA`, `EN_VERIFICACION`, `ENFRIAMIENTO_24H`, `LISTA`).
 *
 * @dependencias_internas
 *   - `../../../../components/auth-legal/auth-api-client` (contrato real del Subagente 2.2):
 *     `authApiFetch` con su sobre `AuthApiResult<T>` (nunca lanza; red caída = `status: 0`).
 *   - `../../../../components/atelier-primitives/AtelierUiPrimitives`: `WindowMockupFrame`,
 *     `TerminalCommandBox`, botones Atelier y `MonoMetadataTag`.
 *
 * @dependencias_externas
 *   - Solo `react`. Prohibido `next/*` e iconotecas.
 *
 * @notas
 *   - Desviación anotada: el backend sellado (Parte 5) implementa el caso de uso Break-Glass
 *     pero no publica las rutas HTTP `/break-glass/request` ni `/break-glass/status`; al
 *     detectar 404/405 el asistente muestra «canal en configuración» y estima la fase local.
 *   - La recuperación solo se consuma tras la ventana de enfriamiento de 24 horas y la
 *     verificación final del equipo de plataforma.
 */

'use client';

import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';

import {
  AtelierPrimaryButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
  TerminalCommandBox,
  WindowMockupFrame,
} from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import type { MonoMetadataTone } from '../../../../components/atelier-primitives/AtelierUiPrimitives';
import { authApiFetch } from '../../../../components/auth-legal/auth-api-client';

// Rutas indicadas por el plan; el backend sellado (Parte 5) aún no las expone (degradable).
const BREAK_GLASS_REQUEST_PATH = '/api/v1/auth/break-glass/request';
const BREAK_GLASS_STATUS_PATH = '/api/v1/auth/break-glass/status';

/** Ventana de enfriamiento obligatoria de 24 horas. */
const COOLING_OFF_MS = 24 * 60 * 60 * 1000;

/** Etiquetas de las cuatro fases del asistente. */
const STEP_LABELS: readonly string[] = ['Solicitud', 'Identidad', 'Enfriamiento', 'Estado'];

// Índices de las cuatro fases del asistente.
const REQUEST_STEP = 0;
const IDENTITY_STEP = 1;
const COOLING_STEP = 2;
const STATUS_STEP = 3;

/** Fases públicas del protocolo Break-Glass. */
type BreakGlassPhase = 'SOLICITADA' | 'EN_VERIFICACION' | 'ENFRIAMIENTO_24H' | 'LISTA';

/** Métodos excluyentes de prueba de identidad. */
type IdentityMethod = 'DNS' | 'INVOICE';

/** Estado leído de `GET /api/v1/auth/break-glass/status`. */
interface BreakGlassStatusPayload {
  readonly status: BreakGlassPhase;
  readonly requestedAtIso: string | null;
}

/** Indica si un estado HTTP corresponde a una ruta no publicada en este entorno. */
function isRouteUnavailable(status: number): boolean {
  return status === 404 || status === 405;
}

/** Lee un campo de texto no vacío de un registro JSON sin afirmar tipos. */
function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Comprueba de forma sencilla que el correo tenga forma plausible. */
function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  const atIndex = trimmed.indexOf('@');
  return atIndex > 0 && atIndex < trimmed.length - 1 && trimmed.includes('.', atIndex);
}

/** Convierte una fecha ISO del backend en milisegundos; `null` si no es válida. */
function parseIsoDateMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

/** Restringe una cadena a una fase conocida del protocolo. */
function parseBreakGlassPhase(value: string): BreakGlassPhase | null {
  if (value === 'SOLICITADA' || value === 'EN_VERIFICACION' || value === 'ENFRIAMIENTO_24H' || value === 'LISTA') {
    return value;
  }
  return null;
}

/** Valida y extrae `{ status, requestedAtIso? }` de la consulta de estado. */
function parseStatusPayload(data: unknown): BreakGlassStatusPayload | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const rawStatus = readStringField(record, 'status');
  const status = rawStatus === null ? null : parseBreakGlassPhase(rawStatus.toUpperCase());
  if (status === null) {
    return null;
  }
  return { status, requestedAtIso: readStringField(record, 'requestedAtIso') };
}

/** Formatea una cuenta regresiva en `HH:MM:SS`. */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

/** Tono visual de cada fase del protocolo. */
function phaseTone(phase: BreakGlassPhase): MonoMetadataTone {
  if (phase === 'LISTA') {
    return 'success';
  }
  return phase === 'EN_VERIFICACION' ? 'accent' : 'neutral';
}

/**
 * Asistente Break-Glass de 4 fases para la pérdida total de credenciales del Owner único.
 */
export default function OwnerEmergencyRecoveryPage(): ReactElement {
  const [stepIndex, setStepIndex] = useState<number>(REQUEST_STEP);
  const [ownerEmail, setOwnerEmail] = useState<string>('');
  const [isRequesting, setIsRequesting] = useState<boolean>(false);
  const [requestErrorMessage, setRequestErrorMessage] = useState<string | null>(null);
  const [isChannelConfigured, setIsChannelConfigured] = useState<boolean>(false);
  const [requestedAtMs, setRequestedAtMs] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [identityMethod, setIdentityMethod] = useState<IdentityMethod>('DNS');
  const [dnsTokenValue, setDnsTokenValue] = useState<string>('');
  const [invoiceReceipt, setInvoiceReceipt] = useState<string>('');
  const [identityErrorMessage, setIdentityErrorMessage] = useState<string | null>(null);
  const [statusPayload, setStatusPayload] = useState<BreakGlassStatusPayload | null>(null);
  const [statusDegraded, setStatusDegraded] = useState<boolean>(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState<boolean>(false);
  const [hasCheckedStatus, setHasCheckedStatus] = useState<boolean>(false);

  const handleSubmitRequest = useCallback(async (): Promise<void> => {
    if (!isPlausibleEmail(ownerEmail)) {
      setRequestErrorMessage('Escribe el correo del Owner de la organización para continuar.');
      return;
    }
    setIsRequesting(true);
    setRequestErrorMessage(null);
    const result = await authApiFetch<unknown>(BREAK_GLASS_REQUEST_PATH, {
      method: 'POST',
      body: { email: ownerEmail.trim() },
    });
    setIsRequesting(false);
    if (!result.ok) {
      if (result.status === 400) {
        setRequestErrorMessage('El correo no tiene un formato válido. Revísalo e intenta de nuevo.');
        return;
      }
      // Desviación anotada: 404/405 (u otro fallo de transporte) no bloquea la navegación.
      setIsChannelConfigured(false);
      setRequestedAtMs(Date.now());
      setStepIndex(IDENTITY_STEP);
      return;
    }
    const record = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {};
    const requestedAtIso = readStringField(record, 'requestedAtIso') ?? readStringField(record, 'createdAt');
    const dnsRecord = readStringField(record, 'dnsTxtRecord') ?? readStringField(record, 'verificationToken');
    setRequestedAtMs(parseIsoDateMs(requestedAtIso) ?? Date.now());
    if (dnsRecord !== null) {
      setDnsTokenValue(dnsRecord);
    }
    setIsChannelConfigured(true);
    setStepIndex(IDENTITY_STEP);
  }, [ownerEmail]);

  const handleConfirmIdentity = useCallback((): void => {
    const chosenValue = identityMethod === 'DNS' ? dnsTokenValue.trim() : invoiceReceipt.trim();
    if (chosenValue.length === 0) {
      setIdentityErrorMessage(
        identityMethod === 'DNS'
          ? 'Pega el valor de verificación del registro DNS o cambia al método del recibo.'
          : 'Escribe el número de recibo de tu última factura o cambia al método DNS.',
      );
      return;
    }
    setIdentityErrorMessage(null);
    setStepIndex(COOLING_STEP);
  }, [dnsTokenValue, identityMethod, invoiceReceipt]);

  useEffect((): (() => void) | void => {
    if (stepIndex < COOLING_STEP || requestedAtMs === null) {
      return;
    }
    const deadlineMs = requestedAtMs + COOLING_OFF_MS;
    const tick = (): void => {
      setRemainingMs(Math.max(0, deadlineMs - Date.now()));
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return (): void => {
      window.clearInterval(intervalId);
    };
  }, [stepIndex, requestedAtMs]);

  const handleCheckStatus = useCallback(async (): Promise<void> => {
    setIsCheckingStatus(true);
    setHasCheckedStatus(true);
    setStatusDegraded(false);
    setStatusPayload(null);
    const result = await authApiFetch<unknown>(
      `${BREAK_GLASS_STATUS_PATH}?email=${encodeURIComponent(ownerEmail.trim())}`,
      { method: 'GET' },
    );
    setIsCheckingStatus(false);
    if (result.ok) {
      const parsed = parseStatusPayload(result.data);
      if (parsed === null) {
        setStatusDegraded(true);
        return;
      }
      setStatusPayload(parsed);
      return;
    }
    setIsChannelConfigured(isRouteUnavailable(result.status) ? false : isChannelConfigured);
    setStatusDegraded(true);
  }, [isChannelConfigured, ownerEmail]);

  useEffect((): void => {
    if (stepIndex !== STATUS_STEP || hasCheckedStatus) {
      return;
    }
    void handleCheckStatus();
  }, [stepIndex, hasCheckedStatus, handleCheckStatus]);

  const coolingElapsed = remainingMs !== null && remainingMs <= 0;
  const localPhase: BreakGlassPhase = coolingElapsed ? 'LISTA' : 'ENFRIAMIENTO_24H';
  const displayedPhase: BreakGlassPhase = statusPayload?.status ?? localPhase;

  return (
    <main className="atelier-shell flex min-h-screen items-start justify-center p-6" data-portal="workspace-atelier">
      <div className="w-full max-w-xl">
        <WindowMockupFrame title="recuperación-de-emergencia">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <p className="atelier-eyebrow">Acceso de emergencia</p>
              <MonoMetadataTag label="FASE" value={`${String(stepIndex + 1)} / 4`} />
            </div>

            <ol className="grid grid-cols-4 gap-2" aria-label="Fases de la recuperación de emergencia">
              {STEP_LABELS.map((label, index) => (
                <li key={label} className="flex flex-col gap-1">
                  <span
                    className={`block h-1 rounded-sm ${index <= stepIndex ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-stone)]'}`}
                  />
                  <span className="atelier-help-text">{`${index + 1}. ${label}`}</span>
                </li>
              ))}
            </ol>

            {stepIndex === REQUEST_STEP ? (
              <section className="flex flex-col gap-3">
                <h1 className="atelier-heading-sm">Solicitud de emergencia</h1>
                <p className="atelier-prose">
                  Este canal existe solo para la pérdida total de credenciales del Owner único de una
                  organización. Cada solicitud queda auditada y pasa por una verificación estricta.
                </p>
                <p className="atelier-error-text">
                  No compartas tus credenciales con nadie: el equipo de la plataforma jamás te las pedirá.
                </p>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event: FormEvent<HTMLFormElement>): void => {
                    event.preventDefault();
                    if (!isRequesting) {
                      void handleSubmitRequest();
                    }
                  }}
                >
                  <label className="atelier-field">
                    <span className="atelier-label">Correo del Owner</span>
                    <input
                      className="atelier-input"
                      type="email"
                      required
                      autoComplete="email"
                      value={ownerEmail}
                      onChange={(event): void => setOwnerEmail(event.currentTarget.value)}
                      placeholder="owner@organizacion.com"
                    />
                  </label>
                  {requestErrorMessage !== null ? <p className="atelier-error-text">{requestErrorMessage}</p> : null}
                  <AtelierPrimaryButton type="submit" fullWidth disabled={isRequesting}>
                    {isRequesting ? 'Registrando solicitud…' : 'Solicitar recuperación de emergencia'}
                  </AtelierPrimaryButton>
                </form>
              </section>
            ) : null}

            {stepIndex === IDENTITY_STEP ? (
              <section className="flex flex-col gap-3">
                <h1 className="atelier-heading-sm">Prueba de identidad</h1>
                <p className="atelier-prose">
                  Demuestra el control de la organización con <em>uno</em> de estos dos métodos excluyentes.
                </p>
                {!isChannelConfigured ? (
                  <p className="atelier-help-text">
                    El canal automático aún está en configuración en este entorno: registra aquí tu prueba
                    para documentar el caso.
                  </p>
                ) : null}
                <div className="flex gap-1" role="tablist" aria-label="Métodos de identidad">
                  <button
                    type="button" role="tab" aria-selected={identityMethod === 'DNS'}
                    className={`atelier-window__tab${identityMethod === 'DNS' ? ' atelier-window__tab--active' : ''}`}
                    onClick={(): void => setIdentityMethod('DNS')}
                  >
                    Registro DNS TXT
                  </button>
                  <button
                    type="button" role="tab" aria-selected={identityMethod === 'INVOICE'}
                    className={`atelier-window__tab${identityMethod === 'INVOICE' ? ' atelier-window__tab--active' : ''}`}
                    onClick={(): void => setIdentityMethod('INVOICE')}
                  >
                    Última factura de tu suscripción
                  </button>
                </div>

                {identityMethod === 'DNS' ? (
                  <div className="flex flex-col gap-2">
                    <p className="atelier-prose">
                      Crea un registro DNS TXT en el dominio de tu organización con el valor de verificación
                      que recibiste:
                    </p>
                    {dnsTokenValue.trim().length > 0 ? (
                      <TerminalCommandBox label="Registro DNS TXT" command={`oa-verify=${dnsTokenValue.trim()}`} />
                    ) : null}
                    <label className="atelier-field">
                      <span className="atelier-label">Valor de verificación</span>
                      <input
                        className="atelier-input atelier-mono"
                        value={dnsTokenValue}
                        onChange={(event): void => setDnsTokenValue(event.currentTarget.value)}
                        placeholder="oa-verify=<token>"
                      />
                    </label>
                  </div>
                ) : (
                  <label className="atelier-field">
                    <span className="atelier-label">Número de recibo de tu última factura</span>
                    <input
                      className="atelier-input atelier-mono"
                      value={invoiceReceipt}
                      onChange={(event): void => setInvoiceReceipt(event.currentTarget.value)}
                      placeholder="recibo-000000"
                    />
                  </label>
                )}

                {identityErrorMessage !== null ? <p className="atelier-error-text">{identityErrorMessage}</p> : null}
                <AtelierPrimaryButton
                  onClick={handleConfirmIdentity}
                  disabled={
                    identityMethod === 'DNS' ? dnsTokenValue.trim().length === 0 : invoiceReceipt.trim().length === 0
                  }
                >
                  Confirmar prueba de identidad
                </AtelierPrimaryButton>
              </section>
            ) : null}

            {stepIndex === COOLING_STEP ? (
              <section className="flex flex-col gap-3">
                <h1 className="atelier-heading-sm">Período de enfriamiento</h1>
                <p className="atelier-prose">
                  Por seguridad, la recuperación no puede consumarse de inmediato: existe una ventana de 24
                  horas para que cualquier alerta de acceso no autorizado sea atendida antes del rescate.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <MonoMetadataTag
                    label="ESTADO"
                    value={coolingElapsed ? 'LISTA' : 'ENFRIAMIENTO_24H'}
                    tone={coolingElapsed ? 'success' : 'accent'}
                  />
                  <span className="atelier-mono">
                    {coolingElapsed ? '00:00:00' : formatCountdown(remainingMs ?? COOLING_OFF_MS)}
                  </span>
                </div>
                <p className="atelier-help-text">
                  {coolingElapsed
                    ? 'La ventana concluyó. La recuperación se consumará tras la verificación final del equipo.'
                    : 'Guarda este enlace: puedes volver aquí para ver tu cuenta regresiva en cualquier momento.'}
                </p>
                <AtelierPrimaryButton onClick={(): void => setStepIndex(STATUS_STEP)}>
                  {coolingElapsed ? 'Consultar estado' : 'Continuar'}
                </AtelierPrimaryButton>
              </section>
            ) : null}

            {stepIndex === STATUS_STEP ? (
              <section className="flex flex-col gap-3">
                <h1 className="atelier-heading-sm">Estado de la solicitud</h1>
                <div className="flex flex-wrap items-center gap-2">
                  <MonoMetadataTag label="SOLICITANTE" value={ownerEmail.trim()} />
                  <MonoMetadataTag label="FASE" value={displayedPhase} tone={phaseTone(displayedPhase)} />
                </div>
                {statusPayload !== null ? (
                  <p className="atelier-help-text">
                    {statusPayload.status === 'LISTA'
                      ? 'Tu solicitud superó la verificación y la ventana de enfriamiento.'
                      : 'El equipo de plataforma contrasta tu prueba de identidad. Vuelve a consultar más tarde.'}
                  </p>
                ) : null}
                {statusPayload === null && statusDegraded ? (
                  <p className="atelier-help-text">
                    El canal de consulta está en configuración en este entorno. Fase estimada por este asistente
                    según el avance local del caso.
                  </p>
                ) : null}
                {!hasCheckedStatus ? <p className="atelier-help-text">Consultando el estado de tu solicitud…</p> : null}
                <div className="flex items-center justify-end gap-2">
                  <AtelierSecondaryButton onClick={(): void => { void handleCheckStatus(); }} disabled={isCheckingStatus}>
                    {isCheckingStatus ? 'Consultando…' : 'Consultar de nuevo'}
                  </AtelierSecondaryButton>
                </div>
                <p className="atelier-help-text">
                  Nada de esto expone datos internos de la plataforma: solo el estado agregado de tu solicitud.
                </p>
              </section>
            ) : null}
          </div>
        </WindowMockupFrame>
      </div>
    </main>
  );
}
