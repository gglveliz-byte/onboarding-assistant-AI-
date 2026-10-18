/**
 * @archivo apps/web/src/components/atelier-primitives/AtelierUiPrimitives.tsx
 * @modulo 08. Frontend Compartido — Primitivas Atelier
 * @proposito
 *   Contrato visual congelado "Cursor Light — Warm Parchment Atelier": componentes de
 *   presentación reutilizables (botones, marco de ventana macOS, caja de terminal y
 *   etiquetas mono de metadatos) que consumen exclusivamente las clases del archivo
 *   `apps/web/src/styles/dashboard-docs-cursor-atelier.css`.
 *
 * @resumen_contenido
 *   - `AtelierButtonProps` + botones primario (ink), secundario (linen), acción técnica
 *     (amber), confirmación estructural (forest) y peligro (crimson), con base común que
 *     respeta `disabled`, ancho completo y clase de extensión.
 *   - `WindowMockupFrameProps` + `WindowMockupFrame`: marco de ventana macOS con tres
 *     puntos neutros, título mono y pestañas opcionales (clicables solo si hay manejador).
 *   - `TerminalCommandBoxProps` + `TerminalCommandBox`: bloque de terminal con prompt,
 *     comando monoespaciado y copiado al portapapeles con confirmación de ~1500 ms.
 *   - `MonoMetadataTone` + `MonoMetadataTagProps` + `MonoMetadataTag`: etiqueta mono 12px
 *     con números tabulares y tonos neutral/success/danger/accent.
 *
 * @dependencias_internas
 *   - `apps/web/src/styles/dashboard-docs-cursor-atelier.css` (clases `.atelier-*`).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `ReactElement`/`ReactNode`; hooks `useCallback` y `useState`).
 *     Prohibido importar `next/*`, iconotecas o utilidades externas de clases.
 *
 * @notas
 *   - Componentes de presentación puros: sin acceso a red, sin estado global y sin
 *     estilos inline; soportan `exactOptionalPropertyTypes` y `noUncheckedIndexedAccess`.
 */

'use client';

import type { ReactElement, ReactNode } from 'react';
import { useCallback, useState } from 'react';

/**
 * Une fragmentos de clase descartando los ausentes o vacíos.
 */
function joinClassNames(...fragments: ReadonlyArray<string | undefined>): string {
  return fragments
    .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.length > 0)
    .join(' ');
}

/**
 * Propiedades compartidas por los cinco botones de la familia Atelier.
 */
export interface AtelierButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * Base interna compartida: aplica variante, estado deshabilitado, ancho completo,
 * etiqueta accesible opcional y clase de extensión; jamás dispara `onClick` si
 * el botón está deshabilitado.
 */
function AtelierButtonBase(props: AtelierButtonProps & { variantClassName: string }): ReactElement {
  const { children, onClick, disabled, type, fullWidth, className, ariaLabel, variantClassName } = props;

  const handleClick = useCallback((): void => {
    if (disabled === true) {
      return;
    }
    if (onClick !== undefined) {
      onClick();
    }
  }, [disabled, onClick]);

  const resolvedClassName = joinClassNames(
    'atelier-btn',
    variantClassName,
    fullWidth === true ? 'atelier-btn--full' : undefined,
    className,
  );

  return (
    <button
      type={type ?? 'button'}
      className={resolvedClassName}
      onClick={handleClick}
      disabled={disabled === true}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
    >
      {children}
    </button>
  );
}

/** Botón principal: fondo tinta con texto pergamino. */
export function AtelierPrimaryButton(props: AtelierButtonProps): ReactElement {
  return <AtelierButtonBase {...props} variantClassName="atelier-btn--primary" />;
}

/** Botón secundario: fondo lino con borde piedra y texto tinta. */
export function AtelierSecondaryButton(props: AtelierButtonProps): ReactElement {
  return <AtelierButtonBase {...props} variantClassName="atelier-btn--secondary" />;
}

/** Botón de acción técnica: fondo ámbar con texto pergamino. */
export function AtelierAmberActionButton(props: AtelierButtonProps): ReactElement {
  return <AtelierButtonBase {...props} variantClassName="atelier-btn--amber" />;
}

/** Botón de confirmación estructural: fondo bosque con texto pergamino. */
export function AtelierForestConfirmButton(props: AtelierButtonProps): ReactElement {
  return <AtelierButtonBase {...props} variantClassName="atelier-btn--forest" />;
}

/** Botón destructivo: contorno carmesí con texto carmesí sobre fondo transparente. */
export function AtelierCrimsonDangerButton(props: AtelierButtonProps): ReactElement {
  return <AtelierButtonBase {...props} variantClassName="atelier-btn--crimson" />;
}

/**
 * Propiedades del marco de ventana macOS decorativo.
 */
export interface WindowMockupFrameProps {
  title?: string;
  tabs?: readonly string[];
  activeTab?: string;
  onSelectTab?: (tab: string) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Pestaña individual del marco: botón real si existe manejador; texto inerte si no.
 */
function renderWindowTab(
  tab: string,
  activeTab: string | undefined,
  onSelectTab: ((tab: string) => void) | undefined,
): ReactElement {
  const isActive = activeTab !== undefined && tab === activeTab;
  const tabClassName = joinClassNames(
    'atelier-window__tab',
    isActive ? 'atelier-window__tab--active' : undefined,
  );

  if (onSelectTab === undefined) {
    return (
      <span key={tab} className={tabClassName}>
        {tab}
      </span>
    );
  }

  const handleSelect = onSelectTab;
  return (
    <button
      key={tab}
      type="button"
      role="tab"
      aria-selected={isActive}
      className={tabClassName}
      onClick={(): void => handleSelect(tab)}
    >
      {tab}
    </button>
  );
}

/**
 * Marco de ventana estilo macOS: tres puntos grises mate, título monoespaciado,
 * barra de pestañas clicable solo cuando se recibe `onSelectTab` y cuerpo con
 * los hijos sobre pergamino.
 */
export function WindowMockupFrame(props: WindowMockupFrameProps): ReactElement {
  const { title, tabs, activeTab, onSelectTab, children, className } = props;
  const tabList: readonly string[] = tabs ?? [];
  const hasTabs = tabList.length > 0;

  return (
    <section className={joinClassNames('atelier-window', className)}>
      <div className="atelier-window__bar">
        <span className="atelier-window__dots" aria-hidden="true">
          <span className="atelier-window__dot" />
          <span className="atelier-window__dot" />
          <span className="atelier-window__dot" />
        </span>
        {title === undefined ? null : <span className="atelier-window__title">{title}</span>}
        {hasTabs ? (
          <div
            className="atelier-window__tabs"
            {...(onSelectTab === undefined ? {} : { role: 'tablist' })}
          >
            {tabList.map((tab) => renderWindowTab(tab, activeTab, onSelectTab))}
          </div>
        ) : null}
      </div>
      <div className="atelier-window__body">{children}</div>
    </section>
  );
}

/**
 * Propiedades de la caja de terminal copiable.
 */
export interface TerminalCommandBoxProps {
  command: string;
  prompt?: string;
  label?: string;
  className?: string;
}

/**
 * Intenta copiar `text` al portapapeles con respaldo silencioso: primero
 * `navigator.clipboard` y, si no está disponible o falla, el mecanismo heredado
 * con un área de texto temporal fuera de pantalla.
 *
 * @param text - Cadena exacta que se desea copiar.
 * @returns `true` si el texto quedó en el portapapeles; `false` en caso contrario.
 */
async function writeTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard !== 'undefined') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* Respaldo silencioso: se intenta el mecanismo heredado a continuación. */
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const stagingArea = document.createElement('textarea');
    stagingArea.value = text;
    stagingArea.setAttribute('readonly', '');
    stagingArea.style.position = 'fixed';
    stagingArea.style.opacity = '0';
    document.body.appendChild(stagingArea);
    stagingArea.select();
    const didCopy = document.execCommand('copy');
    document.body.removeChild(stagingArea);
    return didCopy;
  } catch {
    return false;
  }
}

/**
 * Bloque de terminal con prompt, comando monoespaciado y botón que copia el comando
 * mostrando "Copiado" durante ~1500 ms tras una copia exitosa.
 */
export function TerminalCommandBox(props: TerminalCommandBoxProps): ReactElement {
  const { command, prompt, label, className } = props;
  const [wasCopiedRecently, setWasCopiedRecently] = useState<boolean>(false);

  const handleCopyRequest = useCallback((): void => {
    void writeTextToClipboard(command).then((didCopy): void => {
      if (!didCopy) {
        return;
      }
      setWasCopiedRecently(true);
      window.setTimeout((): void => {
        setWasCopiedRecently(false);
      }, 1500);
    });
  }, [command]);

  return (
    <div className={joinClassNames('atelier-terminal', className)}>
      {label === undefined ? null : <p className="atelier-terminal__label">{label}</p>}
      <div className="atelier-terminal__row">
        <span className="atelier-terminal__prompt" aria-hidden="true">
          {prompt ?? '$'}
        </span>
        <code className="atelier-terminal__command">{command}</code>
        <button type="button" className="atelier-terminal__copy" onClick={handleCopyRequest}>
          {wasCopiedRecently ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

/**
 * Tonos semánticos de las etiquetas mono de metadatos.
 */
export type MonoMetadataTone = 'neutral' | 'success' | 'danger' | 'accent';

/**
 * Propiedades de la etiqueta mono de metadatos.
 */
export interface MonoMetadataTagProps {
  label: string;
  value?: string;
  tone?: MonoMetadataTone;
  className?: string;
}

const MONO_TAG_TONE_CLASS_NAMES: Record<MonoMetadataTone, string> = {
  neutral: 'atelier-mono-tag--neutral',
  success: 'atelier-mono-tag--success',
  danger: 'atelier-mono-tag--danger',
  accent: 'atelier-mono-tag--accent',
};

/**
 * Etiqueta mono de 12px con números tabulares: renderiza `label` y, si existe,
 * `value` separado por un espacio.
 */
export function MonoMetadataTag(props: MonoMetadataTagProps): ReactElement {
  const { label, value, tone, className } = props;
  const resolvedTone = tone ?? 'neutral';
  const displayText = value === undefined || value.length === 0 ? label : `${label} ${value}`;

  return (
    <span className={joinClassNames('atelier-mono-tag', MONO_TAG_TONE_CLASS_NAMES[resolvedTone], className)}>
      {displayText}
    </span>
  );
}
