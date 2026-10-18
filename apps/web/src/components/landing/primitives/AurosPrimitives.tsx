/**
 * @archivo apps/web/src/components/landing/primitives/AurosPrimitives.tsx
 * @modulo 12. Landing Publica Comercial: primitivas Auros Light (Subagente 1.3)
 * @proposito
 *   Contrato visual congelado de la Landing Publica Comercial: cuatro primitivas de
 *   presentacion (componentes de servidor, puros, sin hooks) que consumen exclusivamente
 *   las clases semanticas `.oa-*` publicadas por `apps/web/src/styles/landing-auros-light.css`
 *   y armonizadas con los tokens del sistema Auros Light Premium.
 *
 * @resumen_contenido
 *   - `AuroraGradientButtonProps` + `AuroraGradientButton`: CTA principal con gradiente
 *     turquesa a violeta (#43E7DB -> #8052FF), texto oscuro #062D2A, borde sutil 1px
 *     y area tactil accesible (>= 40px); renderiza `<a>` cuando recibe `href` y `<button>` si no.
 *   - `DiagonalArrowSquareButtonProps` + `DiagonalArrowSquareButton`: boton cuadrado accesible
 *     de 32x32 con flecha diagonal SVG inline de 14x14 y `label` obligatorio (aria-label).
 *   - `UppercaseTrackedKickerProps` + `UppercaseTrackedKicker`: etiqueta editorial de
 *     instrumentacion en mayusculas con tracking amplio (0.12em) y color secundario.
 *   - `LagoonSurfaceCardProps` + `LagoonSurfaceCard`: tarjeta liquida de seccion con
 *     modificadores de tono kelp/lift/deep sobre superficies claras sin sombras.
 *   - Helper local `mergeClassNames`: une fragmentos de clase descartando ausentes o vacios.
 *
 * @dependencias_internas
 *   - `apps/web/src/styles/landing-auros-light.css` (clases `.oa-gradient-button`,
 *     `.oa-arrow-square`, `.oa-kicker` y `.oa-liquid-card` mas modificadores).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `ReactElement` y `ReactNode`). Sin `next/*`, sin iconotecas
 *     y sin utilidades externas de composicion de clases.
 *
 * @notas
 *   - Componente servidor compatible: sin `'use client'`, sin hooks y sin estado.
 *   - Props inmutables (`readonly`), retornos `ReactElement` y compatibilidad estricta
 *     con `exactOptionalPropertyTypes`; cero `any`, cero sombras y cero estilos inline.
 */

import type { ReactElement, ReactNode } from 'react';

/**
 * Une fragmentos de clase descartando los ausentes o vacios.
 */
function mergeClassNames(...fragments: ReadonlyArray<string | undefined>): string {
  return fragments
    .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.length > 0)
    .join(' ');
}

/**
 * Propiedades del CTA principal con gradiente aurora / turquesa a violeta.
 */
export interface AuroraGradientButtonProps {
  readonly children: ReactNode;
  readonly href?: string;
  readonly onClick?: () => void;
  readonly type?: 'button' | 'submit';
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * CTA principal: con `href` se comporta como enlace; sin el, como boton de formulario.
 * Garantiza area tactil accesible (>= 40px), sin sombras y con gradiente de alta elegancia.
 */
export function AuroraGradientButton(props: AuroraGradientButtonProps): ReactElement {
  const { children, href, onClick, type, disabled, className } = props;
  const resolvedClassName = mergeClassNames('oa-gradient-button', className);

  if (href !== undefined) {
    return (
      <a href={href} className={resolvedClassName}>
        {children}
      </a>
    );
  }

  return (
    <button
      type={type ?? 'button'}
      className={resolvedClassName}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Trazo SVG compartido: flecha diagonal noreste de 14x14 sobre rejilla de 16x16. */
const DIAGONAL_ARROW_GLYPH: ReactElement = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4.5 11.5 L11 5" />
    <path d="M5.5 4.5 H11.5 V10.5" />
  </svg>
);

/**
 * Propiedades del boton cuadrado con flecha diagonal.
 */
export interface DiagonalArrowSquareButtonProps {
  readonly href?: string;
  readonly onClick?: () => void;
  readonly label: string;
  readonly className?: string;
}

/**
 * Cuadrado accesible de 32x32 con flecha diagonal: enlace si recibe `href`; boton si no.
 * `label` es obligatorio y alimenta el `aria-label` accesible.
 */
export function DiagonalArrowSquareButton(props: DiagonalArrowSquareButtonProps): ReactElement {
  const { href, onClick, label, className } = props;
  const resolvedClassName = mergeClassNames('oa-arrow-square', className);

  if (href !== undefined) {
    return (
      <a href={href} aria-label={label} className={resolvedClassName}>
        {DIAGONAL_ARROW_GLYPH}
      </a>
    );
  }

  return (
    <button type="button" aria-label={label} className={resolvedClassName} onClick={onClick}>
      {DIAGONAL_ARROW_GLYPH}
    </button>
  );
}

/**
 * Propiedades del kicker en mayusculas con tracking amplio.
 */
export interface UppercaseTrackedKickerProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * Etiqueta de instrumentacion que introduce cada seccion de la landing.
 */
export function UppercaseTrackedKicker(props: UppercaseTrackedKickerProps): ReactElement {
  const { children, className } = props;
  return <p className={mergeClassNames('oa-kicker', className)}>{children}</p>;
}

/**
 * Propiedades de la tarjeta liquida de seccion.
 */
export interface LagoonSurfaceCardProps {
  readonly children: ReactNode;
  readonly tone?: 'kelp' | 'lift' | 'deep';
  readonly className?: string;
}

/**
 * Tarjeta de superficie Auros: kelp por defecto y modificador de tono opcional
 * (`kelp`, `lift` o `deep`) segun la profundidad de la capa de agua.
 */
export function LagoonSurfaceCard(props: LagoonSurfaceCardProps): ReactElement {
  const { children, tone, className } = props;
  const toneClassName = tone === undefined ? undefined : `oa-liquid-card--${tone}`;
  return (
    <section className={mergeClassNames('oa-liquid-card', toneClassName, className)}>
      {children}
    </section>
  );
}
