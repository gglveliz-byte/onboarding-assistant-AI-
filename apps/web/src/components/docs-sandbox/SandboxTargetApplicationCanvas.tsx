/**
 * @archivo apps/web/src/components/docs-sandbox/SandboxTargetApplicationCanvas.tsx
 * @modulo 08. Landing de Documentación & Sandbox — Panel Central (Lienzo de Aplicación)
 * @proposito
 *   Panel central del Sandbox de `/docs/sandbox`: monta un "CRM de ejemplo" dentro de un
 *   marco de ventana con conmutador de viewport responsive (Desktop 1440x900, Tablet
 *   768x1024 y Mobile 390x844) y escala visual para encajar en el panel. Cada elemento
 *   instrumentado (`data-oa-id`) emite sondas realistas de cascada de selectores al
 *   enfocarse o pulsarse; el campo trampa `input[type="password"]` cancela todo intento
 *   de escritura y reporta el bloqueo por privacidad, mostrando candado, borde carmesí
 *   y la etiqueta `ACTION_BLOCKED_SENSITIVE_FIELD` cuando ya existe un intento.
 *
 * @resumen_contenido
 *   - `SandboxTargetApplicationCanvasProps` + `SandboxTargetApplicationCanvas`.
 *   - Helpers de instrumentación: `buildSelectorCascade()`, `buildDiscriminantSelector()`
 *     y `buildAncestorPath()` (cascada de 2 a 3 selectores desde el DOM en vivo).
 *   - `LockGlyph`: candado monolineal 14px (ceniza en reposo, carmesí tras el bloqueo).
 *   - Toast interno sobrio tras simular `click_element` sobre «Crear factura» y
 *     mini-modal `.atelier-modal` de «Ver detalles».
 *
 * @dependencias_internas
 *   - `SANDBOX_VIEWPORT_PRESETS`, `SandboxElementProbeResult`, `SandboxViewportId`
 *     (./sandbox-contracts.types.ts).
 *   - `AtelierPrimaryButton`, `AtelierSecondaryButton`, `MonoMetadataTag` y
 *     `WindowMockupFrame` (../atelier-primitives/AtelierUiPrimitives.tsx).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `ReactElement`/`SyntheticEvent`; hooks `useCallback`, `useRef`
 *     y `useState`). Prohibido importar `next/*` o iconotecas.
 *
 * @notas
 *   - El campo sensible usa `readOnly` + `value` vacío + `preventDefault()`: es
 *     imposible escribir en él desde el teclado o el pegado.
 *   - El borde de depuración de elementos instrumentados usa `.atelier-hairline`
 *     únicamente al pasar el cursor (hover), nunca de forma permanente.
 */

'use client';

import type { ReactElement, SyntheticEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AtelierPrimaryButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
  WindowMockupFrame,
} from '../atelier-primitives/AtelierUiPrimitives';
import { SANDBOX_VIEWPORT_PRESETS } from './sandbox-contracts.types';
import type { SandboxElementProbeResult, SandboxViewportId } from './sandbox-contracts.types';

/** Escala visual fija por preset para encajar el lienzo dentro del panel central. */
const VIEWPORT_SCALE_BY_ID: Record<SandboxViewportId, number> = {
  desktop: 0.36,
  tablet: 0.62,
  mobile: 1,
};

/** Etiqueta mono del bloqueo por privacidad que muestra el lienzo tras un intento. */
const BLOCKED_SENSITIVE_FIELD_LABEL = 'ACTION_BLOCKED_SENSITIVE_FIELD';

/**
 * Construye la cascada realista de 2 a 3 selectores para un elemento instrumentado:
 * 1) ancla `[data-oa-id]`, 2) selector discriminante y 3) ruta ascendente del DOM.
 */
function buildSelectorCascade(element: HTMLElement): readonly string[] {
  const cascade: string[] = [];
  const oaId = element.getAttribute('data-oa-id') ?? '';
  if (oaId.length > 0) {
    cascade.push(`[data-oa-id="${oaId}"]`);
  }
  cascade.push(buildDiscriminantSelector(element));
  cascade.push(buildAncestorPath(element));
  return cascade;
}

/** Selector secundario: `#id` si existe; si no, `tag[name]`, `tag[type]` o el tag puro. */
function buildDiscriminantSelector(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const idAttribute = element.getAttribute('id');
  const nameAttribute = element.getAttribute('name');
  const typeAttribute = element.getAttribute('type');
  if (idAttribute !== null && idAttribute.length > 0) return `#${idAttribute}`;
  if (nameAttribute !== null && nameAttribute.length > 0) return `${tag}[name="${nameAttribute}"]`;
  if (typeAttribute !== null && typeAttribute.length > 0) return `${tag}[type="${typeAttribute}"]`;
  return tag;
}

/** Ruta ascendente del elemento (hasta 3 segmentos: abuelo > padre > tag propio). */
function buildAncestorPath(element: HTMLElement): string {
  const segments: string[] = [element.tagName.toLowerCase()];
  let cursor = element.parentElement;
  while (cursor !== null && segments.length < 3) {
    segments.unshift(cursor.tagName.toLowerCase());
    cursor = cursor.parentElement;
  }
  return segments.join(' > ');
}

/** Candado monolineal 14px: ceniza en reposo y carmesí cuando el bloqueo ya ocurrió. */
function LockGlyph(props: { readonly isBlocked: boolean }): ReactElement {
  const strokeColor = props.isBlocked ? 'var(--color-crimson)' : 'var(--color-ash)';
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" />
      <rect x="3.5" y="7" width="9" height="6" rx="1" fill="none" stroke={strokeColor} strokeWidth="1.5" />
    </svg>
  );
}

/** Props del lienzo central con la aplicación de prueba responsive. */
export interface SandboxTargetApplicationCanvasProps {
  readonly viewport: SandboxViewportId;
  readonly onViewportChange: (viewport: SandboxViewportId) => void;
  readonly onProbeElement: (probe: SandboxElementProbeResult) => void;
  readonly sensitiveAttemptCount: number;
  readonly onSensitiveFieldAttempt: () => void;
}

/**
 * Lienzo central del Sandbox: CRM de ejemplo instrumentado con conmutador de viewport,
 * sondas de selectores al enfocar o pulsar cada `data-oa-id` y bloqueo total del campo
 * sensible (contraseña) con su reporte visual de privacidad.
 */
export function SandboxTargetApplicationCanvas(
  props: SandboxTargetApplicationCanvasProps,
): ReactElement {
  const { viewport, onViewportChange, onProbeElement, sensitiveAttemptCount, onSensitiveFieldAttempt } = props;

  const [hoveredOaId, setHoveredOaId] = useState<string | null>(null);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState<boolean>(false);
  const [isInvoiceNoticeVisible, setIsInvoiceNoticeVisible] = useState<boolean>(false);
  const noticeTimeoutRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  useEffect((): (() => void) => {
    const element = containerRef.current;
    if (element === null) {
      return (): void => {};
    }
    const updateWidth = (): void => {
      setContainerWidth(element.clientWidth);
    };
    updateWidth();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries): void => {
        for (const entry of entries) {
          const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          setContainerWidth(width);
        }
      });
      observer.observe(element);
      return (): void => observer.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return (): void => window.removeEventListener('resize', updateWidth);
  }, []);

  const activePreset = SANDBOX_VIEWPORT_PRESETS.find((preset) => preset.id === viewport) ?? {
    id: viewport,
    label: viewport,
    widthPx: 1024,
    heightPx: 768,
  };
  const presetBaseScale = VIEWPORT_SCALE_BY_ID[viewport];
  const availableContentWidth = containerWidth > 32 ? containerWidth - 32 : containerWidth;
  const viewportScale = availableContentWidth > 0
    ? Math.min(presetBaseScale, Math.min(1, availableContentWidth / activePreset.widthPx))
    : presetBaseScale;

  const handleProbeEvent = useCallback((event: SyntheticEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    if (element.getAttribute('data-oa-sensitive') === 'true') {
      return;
    }
    const oaId = element.getAttribute('data-oa-id');
    if (oaId === null || oaId.length === 0) {
      return;
    }
    onProbeElement({ oaId, selectorCascade: buildSelectorCascade(element), isSensitive: false });
  }, [onProbeElement]);

  const handleHoverStart = useCallback((event: SyntheticEvent<HTMLElement>): void => {
    setHoveredOaId(event.currentTarget.getAttribute('data-oa-id'));
  }, []);

  const handleHoverEnd = useCallback((): void => {
    setHoveredOaId(null);
  }, []);

  const outlineClassNameFor = useCallback((oaId: string): string | undefined => {
    return hoveredOaId === oaId ? 'atelier-hairline' : undefined;
  }, [hoveredOaId]);

  const handleSensitiveInteraction = useCallback((event: SyntheticEvent<HTMLElement>): void => {
    event.preventDefault();
    onSensitiveFieldAttempt();
  }, [onSensitiveFieldAttempt]);

  const handleCreateInvoiceClick = useCallback((): void => {
    setIsInvoiceNoticeVisible(true);
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout((): void => {
      setIsInvoiceNoticeVisible(false);
      noticeTimeoutRef.current = null;
    }, 3200);
  }, []);

  const handleOpenDetails = useCallback((): void => {
    setIsDetailsModalOpen(true);
  }, []);

  const handleCloseDetails = useCallback((): void => {
    setIsDetailsModalOpen(false);
  }, []);

  const handleBackdropClick = useCallback((event: SyntheticEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      setIsDetailsModalOpen(false);
    }
  }, []);

  const handleFormSubmit = useCallback((event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
  }, []);

  const probeEventHandlers = { onFocus: handleProbeEvent, onClick: handleProbeEvent };
  const hoverEventHandlers = { onMouseEnter: handleHoverStart, onMouseLeave: handleHoverEnd };

  return (
    <article className="atelier-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <p className="atelier-eyebrow" style={{ margin: 0 }}>lienzo de aplicación de prueba</p>
          <h3 className="atelier-heading-sm" style={{ fontSize: '18px' }}>CRM de ejemplo · facturación</h3>
        </div>
        <div role="group" aria-label="Resolución del lienzo" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {SANDBOX_VIEWPORT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={preset.id === viewport}
              className={preset.id === viewport ? 'atelier-btn atelier-btn--primary' : 'atelier-btn atelier-btn--secondary'}
              onClick={(): void => onViewportChange(preset.id)}
            >
              {`${preset.label} ${preset.widthPx}x${preset.heightPx}`}
            </button>
          ))}
          <MonoMetadataTag label="zoom" value={`${Math.round(viewportScale * 100)}%`} />
        </div>
      </header>

      <div style={{ position: 'relative' }}>
        <div ref={containerRef} className="atelier-scrollarea" style={{ overflow: 'auto', maxHeight: '460px', padding: '16px', border: '1px solid var(--color-stone)', borderRadius: '4px', backgroundColor: 'var(--color-parchment)' }}>
          <div style={{ width: `${activePreset.widthPx * viewportScale}px`, height: `${activePreset.heightPx * viewportScale}px`, maxWidth: '100%', overflow: 'hidden' }}>
            <div style={{ width: `${activePreset.widthPx}px`, height: `${activePreset.heightPx}px`, transform: `scale(${viewportScale})`, transformOrigin: 'top left' }}>
              <WindowMockupFrame title="app-de-prueba" tabs={['crm.tsx']}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '8px', minHeight: `${activePreset.heightPx - 84}px` }}>
                  <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <p className="atelier-eyebrow" style={{ margin: 0 }}>crm-de-ejemplo · módulo de facturación</p>
                    <h4 className="atelier-heading-sm" style={{ fontSize: '18px' }}>Nueva factura de cliente</h4>
                  </header>

                  <form style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '420px' }} onSubmit={handleFormSubmit}>
                    <div className={outlineClassNameFor('input-nombre-cliente')}>
                      <div className="atelier-field">
                        <label className="atelier-label" htmlFor="sandbox-nombre-cliente">Nombre del cliente</label>
                        <input
                          id="sandbox-nombre-cliente" name="customerName" type="text" className="atelier-input"
                          placeholder="Ana Torres" data-oa-id="input-nombre-cliente"
                          {...hoverEventHandlers} {...probeEventHandlers}
                        />
                      </div>
                    </div>

                    <div className={outlineClassNameFor('input-empresa')}>
                      <div className="atelier-field">
                        <label className="atelier-label" htmlFor="sandbox-empresa">Empresa</label>
                        <input
                          id="sandbox-empresa" name="companyName" type="text" className="atelier-input"
                          placeholder="Grupo Andino S.A." data-oa-id="input-empresa"
                          {...hoverEventHandlers} {...probeEventHandlers}
                        />
                      </div>
                    </div>

                    <div className={outlineClassNameFor('select-metodo-pago')}>
                      <div className="atelier-field">
                        <label className="atelier-label" htmlFor="sandbox-metodo-pago">Método de pago</label>
                        <select
                          id="sandbox-metodo-pago" name="paymentMethod" className="atelier-select" defaultValue="transferencia"
                          data-oa-id="select-metodo-pago" {...hoverEventHandlers} {...probeEventHandlers}
                        >
                          <option value="tarjeta">Tarjeta de crédito</option>
                          <option value="transferencia">Transferencia bancaria</option>
                          <option value="efectivo">Efectivo en caja</option>
                        </select>
                      </div>
                    </div>

                    <div className="atelier-field">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <LockGlyph isBlocked={sensitiveAttemptCount > 0} />
                        <label className="atelier-label" htmlFor="sandbox-tarjeta-bloqueada">Campo sensible (bloqueado por privacidad)</label>
                      </div>
                      <input
                        id="sandbox-tarjeta-bloqueada" name="cardSecret" type="password" className="atelier-input"
                        value="" readOnly autoComplete="off" placeholder="••••••••"
                        data-oa-id="input-tarjeta-bloqueada" data-oa-sensitive="true"
                        aria-describedby="sandbox-nota-campo-sensible"
                        style={sensitiveAttemptCount > 0 ? { borderColor: 'var(--color-crimson)' } : undefined}
                        onFocus={handleSensitiveInteraction} onKeyDown={handleSensitiveInteraction}
                        onChange={handleSensitiveInteraction}
                      />
                      <p id="sandbox-nota-campo-sensible" className="atelier-help-text" style={{ margin: 0 }}>
                        El asistente nunca escribe en contraseñas, tarjetas ni CVV; el intento se cancela en el origen.
                      </p>
                      {sensitiveAttemptCount > 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <MonoMetadataTag label={BLOCKED_SENSITIVE_FIELD_LABEL} value={String(sensitiveAttemptCount)} tone="danger" />
                          <span className="atelier-error-text">Intento descartado por el scrubber de privacidad.</span>
                        </div>
                      ) : null}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span
                        data-oa-id="btn-crear-factura"
                        className={outlineClassNameFor('btn-crear-factura')}
                        style={{ display: 'inline-flex' }}
                        {...hoverEventHandlers} {...probeEventHandlers}
                      >
                        <AtelierPrimaryButton onClick={handleCreateInvoiceClick}>Crear factura</AtelierPrimaryButton>
                      </span>
                      <span
                        data-oa-id="btn-ver-detalles"
                        className={outlineClassNameFor('btn-ver-detalles')}
                        style={{ display: 'inline-flex' }}
                        {...hoverEventHandlers} {...probeEventHandlers}
                      >
                        <AtelierSecondaryButton onClick={handleOpenDetails}>Ver detalles</AtelierSecondaryButton>
                      </span>
                    </div>

                    {isInvoiceNoticeVisible ? (
                      <div role="status" className="atelier-mono" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', border: '1px solid var(--color-stone)', borderRadius: '4px', backgroundColor: 'var(--color-linen)', color: 'var(--color-ink)' }}>
                        <MonoMetadataTag label="tool.execution.ack" value="SUCCESS" tone="success" />
                        <span>Acción simulada: la factura se marcó como creada sin efectos reales.</span>
                      </div>
                    ) : null}
                  </form>
                </div>
              </WindowMockupFrame>
            </div>
          </div>
        </div>

        {isDetailsModalOpen ? (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', backgroundColor: 'color-mix(in oklab, #26251e 32%, transparent)' }} onClick={handleBackdropClick}>
            <div style={{ width: '100%', maxWidth: '420px' }} className={outlineClassNameFor('modal-detalles')}>
              <div
                className="atelier-modal"
                data-oa-id="modal-detalles"
                style={{ maxWidth: '100%', padding: '20px' }}
                {...hoverEventHandlers}
                onClick={handleProbeEvent}
              >
                <h3 className="atelier-modal__title" style={{ fontSize: '18px' }}>Detalles de la factura</h3>
                <div className="atelier-modal__body" style={{ padding: '12px 0' }}>
                  <p className="atelier-mono" style={{ margin: 0 }}>folio INV-2026-0042 · total $128.40 USD · estado borrador</p>
                  <p className="atelier-mono" style={{ margin: '4px 0 0' }}>cliente: Ana Torres · empresa: Grupo Andino S.A.</p>
                </div>
                <div className="atelier-modal__actions">
                  <AtelierSecondaryButton onClick={handleCloseDetails}>Cerrar</AtelierSecondaryButton>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <p className="atelier-help-text" style={{ margin: 0 }}>
        Cada elemento `data-oa-id` emite su cascada de selectores al enfocarlo o pulsarlo; el campo sensible bloquea cualquier intento desde el origen.
      </p>
    </article>
  );
}
