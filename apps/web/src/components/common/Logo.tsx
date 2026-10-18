/**
 * @archivo apps/web/src/components/common/Logo.tsx
 * @modulo apps/web/src/components/common (identidad de marca visual)
 * @proposito
 *   Componente de Logotipo e Isotipo vectorial ultra-nítido con fondo 100% transparente
 *   para la plataforma SaaS "Onboarding Assistant AI" (Sistema de Diseño de Tema Claro).
 *   Construido con geometría de prisma neuronal facetado, acentos en Electric Iris (#8052ff),
 *   gradientes Deep Verdant (#15846e) y chispa central Saffron Spark (#ffb829).
 *   Altamente adaptable a superficies claras (Blanco #ffffff, Pergamino #f7f7f4) o fondos contrastados.
 *
 * @resumen_contenido
 *   - `Logo`: componente maestro adaptable que renderiza isotipo vectorial y tipografía opcional.
 *   - `LogoIcon`: isotipo hexagonal de prisma neuronal aislado para navbars, favicons o avatares.
 *   - `LogoProps`: interfaz TypeScript tipada con control de tamaño, variantes y temas.
 *
 * @dependencias_internas
 *   - Ninguna (cero acoplamiento, 100% autónomo y portable).
 *
 * @dependencias_externas
 *   - `react` (JSX, memo).
 */

import React, { memo } from 'react';

export interface LogoProps {
  /** Tamaño del isotipo en píxeles (ancho y alto). Por defecto 32 */
  readonly size?: number;
  /** Modo de visualización: 'full' (icono + texto), 'icon' (solo isotipo), 'compact' (icono + sigla) */
  readonly variant?: 'full' | 'icon' | 'compact';
  /** Clase CSS adicional para el contenedor */
  readonly className?: string;
  /** Ocultar texto en pantallas móviles estrechas */
  readonly hideTextOnMobile?: boolean;
  /** Tema para el texto: 'dark' (tinta mineral para fondos claros, por defecto), 'light' (blanco para fondos oscuros), o 'auto' */
  readonly textTheme?: 'light' | 'dark' | 'auto';
  /** Si debe tener enlace hacia la raíz '/' u otra URL. Si es null o no se define, se renderiza sin etiqueta <a> */
  readonly href?: string | null;
}

/**
 * Isotipo vectorial aislado del prisma hexagonal neuronal.
 * Renderiza facetas geométricas transparentes con gradientes vectoriales
 * Electric Iris (#8052ff), Deep Verdant (#15846e) y núcleo Saffron Spark (#ffb829).
 */
export const LogoIcon = memo(function LogoIcon({
  size = 32,
  className = '',
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  const gradientPrefix = React.useId().replace(/:/g, '');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 transition-transform duration-300 hover:scale-105 ${className}`}
      aria-label="Isotipo Onboarding Assistant AI"
      role="img"
    >
      <defs>
        {/* Gradiente Superior: Electric Iris Violet */}
        <linearGradient id={`${gradientPrefix}-violet`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#9b72ff" />
          <stop offset="50%" stopColor="#8052ff" />
          <stop offset="100%" stopColor="#5d2bf6" />
        </linearGradient>

        {/* Gradiente Inferior: Deep Verdant Emerald */}
        <linearGradient id={`${gradientPrefix}-verdant`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00b894" />
          <stop offset="60%" stopColor="#15846e" />
          <stop offset="100%" stopColor="#095445" />
        </linearGradient>

        {/* Gradiente Núcleo: Saffron Spark Golden Glow */}
        <radialGradient id={`${gradientPrefix}-spark`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffe680" />
          <stop offset="40%" stopColor="#ffb829" />
          <stop offset="100%" stopColor="#e59400" />
        </radialGradient>

        {/* Brillo sutil de aristas */}
        <linearGradient id={`${gradientPrefix}-wire`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Facetas Superiores Violeta (Electric Iris) */}
      <polygon
        points="50,6 88,28 72,50 50,22"
        fill={`url(#${gradientPrefix}-violet)`}
        fillOpacity="0.92"
      />
      <polygon
        points="50,6 12,28 28,50 50,22"
        fill={`url(#${gradientPrefix}-violet)`}
        fillOpacity="0.75"
      />
      <polygon
        points="50,6 72,50 28,50"
        fill="#8052ff"
        fillOpacity="0.4"
      />

      {/* Facetas Inferiores Esmeralda (Deep Verdant) */}
      <polygon
        points="50,94 88,72 72,50 50,78"
        fill={`url(#${gradientPrefix}-verdant)`}
        fillOpacity="0.9"
      />
      <polygon
        points="50,94 12,72 28,50 50,78"
        fill={`url(#${gradientPrefix}-verdant)`}
        fillOpacity="0.8"
      />
      <polygon
        points="50,94 72,50 28,50"
        fill="#15846e"
        fillOpacity="0.45"
      />

      {/* Facetas Laterales de Transición Cromática */}
      <polygon
        points="12,28 28,50 12,72"
        fill="#297775"
        fillOpacity="0.85"
      />
      <polygon
        points="88,28 72,50 88,72"
        fill="#6653c7"
        fillOpacity="0.85"
      />

      {/* Núcleo Central: Diamante Radiante Saffron Spark */}
      <polygon
        points="50,22 72,50 50,78 28,50"
        fill={`url(#${gradientPrefix}-spark)`}
      />

      {/* Malla Vectorial de Aristas Cónicas Blancas Ultra-Nítidas */}
      <g stroke={`url(#${gradientPrefix}-wire)`} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
        {/* Contorno Hexagonal Exterior */}
        <polygon points="50,6 88,28 88,72 50,94 12,72 12,28" fill="none" />
        {/* Líneas Interiores del Prisma */}
        <line x1="50" y1="6" x2="50" y2="22" />
        <line x1="50" y1="94" x2="50" y2="78" />
        <line x1="12" y1="28" x2="28" y2="50" />
        <line x1="12" y1="72" x2="28" y2="50" />
        <line x1="88" y1="28" x2="72" y2="50" />
        <line x1="88" y1="72" x2="72" y2="50" />
        <line x1="50" y1="22" x2="72" y2="50" />
        <line x1="72" y1="50" x2="50" y2="78" />
        <line x1="50" y1="78" x2="28" y2="50" />
        <line x1="28" y1="50" x2="50" y2="22" />
        <line x1="28" y1="50" x2="72" y2="50" strokeOpacity="0.5" />
      </g>
    </svg>
  );
});

/**
 * Logotipo Principal con Tipografía de Tema Claro Monolítica.
 * Soporta enlace automático, adaptabilidad de temas y responsive.
 */
export const Logo = memo(function Logo({
  size = 30,
  variant = 'full',
  className = '',
  hideTextOnMobile = false,
  textTheme = 'dark',
  href = null,
}: LogoProps) {
  const textColorClass =
    textTheme === 'light'
      ? 'text-[#ffffff]'
      : textTheme === 'dark'
      ? 'text-[#121619]'
      : 'text-[#121619] dark:text-white';

  const content = (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <LogoIcon size={size} />

      {variant !== 'icon' && (
        <div className={`flex flex-col leading-none ${hideTextOnMobile ? 'hidden sm:flex' : 'flex'}`}>
          {variant === 'compact' ? (
            <span
              className={`font-semibold tracking-wider uppercase text-[13px] ${textColorClass}`}
              style={{ letterSpacing: '0.08em' }}
            >
              OA<span className="text-[#8052ff]">.</span>AI
            </span>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span
                  className={`font-medium tracking-tight text-[15px] ${textColorClass}`}
                  style={{ letterSpacing: '-0.02em' }}
                >
                  Onboarding Assistant
                </span>
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold tracking-wider uppercase bg-[#8052ff]/15 text-[#8052ff] border border-[#8052ff]/30">
                  AI
                </span>
              </div>
              <span
                className={`text-[10px] uppercase tracking-widest font-normal mt-0.5 ${textTheme === 'light' ? 'text-[#9a9a9a]' : 'text-[#23534F]'}`}
                style={{ letterSpacing: '0.12em' }}
              >
                Realtime Voice Engine
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );

  if (typeof href === 'string' && href.length > 0) {
    return (
      <a
        href={href}
        className="inline-flex items-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8052ff] rounded-lg"
        title="Onboarding Assistant AI"
      >
        {content}
      </a>
    );
  }

  return content;
});

export default Logo;
