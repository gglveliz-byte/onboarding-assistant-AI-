/**
 * @archivo apps/web/src/components/landing/PublicCommercialChrome.tsx
 * @modulo apps/web/src/components/landing (chrome de la landing comercial Auros Light)
 * @proposito
 *   Encabezado sticky y pie de página de la landing pública comercial: navegación de anclas
 *   hacia las secciones del producto, accesos de autenticación, indicador de voz en vivo con acento #43E7DB,
 *   botón CTA con gradiente #43E7DB a #8052FF, drawer móvil retráctil con áreas táctiles accesibles
 *   (>= 40px) y pie editorial con cuatro columnas y barra de copyright.
 *
 * @resumen_contenido
 *   - `PublicCommercialHeader()`: barra sticky translúcida sobre #F2FAF8/90 con backdrop-blur,
 *     borde inferior #C5E8E1, Logotipo neuronal transparente, enlaces en #245954 con hover a #062D2A
 *     (13-14px, tracking suave), indicador de voz en vivo (#43E7DB), botón CTA con gradiente (#43E7DB a #8052FF)
 *     y drawer móvil accesible con fondo #F2FAF8 y bordes #C5E8E1.
 *   - `PublicCommercialFooter()`: pie sobre superficie secundaria #EAF7F4 con bordes #C5E8E1,
 *     columnas en microtipografía editorial (#547B76 y #245954) y barra inferior de copyright.
 *
 * @dependencias_internas
 *   - `apps/web/src/components/common/Logo.tsx` (`Logo` transparente adaptativo).
 *
 * @dependencias_externas
 *   - `react` (`useState`, tipo `ReactElement`). Prohibido `next/*` (se usan anclas `<a>` simples).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascarón de presentación pura: no accede a datos).
 */

'use client';

import { useState, type ReactElement } from 'react';
import { Logo } from '../common/Logo';

/** Enlace simple del chrome comercial: ancla interna de sección o ruta del producto. */
interface CommercialChromeLink {
  readonly href: string;
  readonly label: string;
  readonly emphasized?: boolean;
}

/** Navegación central del encabezado hacia las secciones comerciales y la documentación. */
const PRIMARY_NAVIGATION_LINKS: readonly CommercialChromeLink[] = [
  { href: '#plataforma', label: 'Producto' },
  { href: '#demo-en-vivo', label: 'Demo en vivo' },
  { href: '#precios', label: 'Precios' },
  { href: '/docs', label: 'Docs' },
];

/** Navegación móvil dentro del drawer desplegable (< md), incluyendo acceso a sesión. */
const MOBILE_NAVIGATION_LINKS: readonly CommercialChromeLink[] = [
  { href: '#plataforma', label: 'Producto' },
  { href: '#demo-en-vivo', label: 'Demo en vivo' },
  { href: '#precios', label: 'Precios' },
  { href: '/docs', label: 'Docs' },
  { href: '/auth/login', label: 'Iniciar sesión' },
];

/** Columna "Producto" del pie: mismas anclas y documentación que la navegación central. */
const FOOTER_PRODUCT_LINKS: readonly CommercialChromeLink[] = [
  { href: '#plataforma', label: 'Producto' },
  { href: '#demo-en-vivo', label: 'Demo en vivo' },
  { href: '#precios', label: 'Precios' },
  { href: '/docs', label: 'Docs' },
];

/** Columna "Cuenta" del pie: acceso a sesión y CTA de creación de cuenta. */
const FOOTER_ACCOUNT_LINKS: readonly CommercialChromeLink[] = [
  { href: '/auth/login', label: 'Iniciar sesión' },
  { href: '/auth/register', label: 'Crear cuenta', emphasized: true },
];

/** Columna "Legal" del pie: documentos públicos de términos, privacidad y DPA. */
const FOOTER_LEGAL_LINKS: readonly CommercialChromeLink[] = [
  { href: '/legal/tos-b2b', label: 'Términos del servicio' },
  { href: '/legal/privacy-policy', label: 'Privacidad' },
  { href: '/legal/dpa-enterprise', label: 'DPA Enterprise' },
];

/** Enlace de navegación en reposo sobre tinta secundaria #245954 (13-14px, tracking suave), con realce a tinta principal #062D2A. */
function renderHeaderNavLinkClassName(): string {
  return 'text-[15px] font-medium text-[#123944] hover:text-[#08252d] transition-colors duration-200';
}

/** Clase de estilo del botón CTA píldora púrpura (#7346f6). */
const CTA_GRADIENT_BUTTON_CLASS =
  'inline-flex min-h-[34px] sm:min-h-[38px] items-center justify-center rounded-full bg-[#7346f6] px-3.5 sm:px-5 py-1.5 sm:py-2 text-[12px] sm:text-[14px] font-medium tracking-wide text-white transition-all shadow-sm hover:bg-[#6335ea] active:scale-[0.98]';

/** Columna del pie con título en microtipografía editorial (#547B76) y enlaces en #245954. */
function FooterLinkColumn(props: {
  readonly title: string;
  readonly links: readonly CommercialChromeLink[];
}): ReactElement {
  return (
    <nav aria-label={props.title} className="flex flex-col gap-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#547B76]">{props.title}</p>
      {props.links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className={
            link.emphasized === true
              ? 'inline-flex min-h-[30px] items-center justify-center rounded-[6px] border border-[#C5E8E1] bg-[linear-gradient(135deg,#43E7DB_0%,#8052FF_100%)] px-3 py-1 text-[11px] font-semibold text-[#062D2A] transition-all hover:brightness-105'
              : 'w-fit text-[13px] font-medium tracking-[-0.01em] text-[#245954] transition-colors hover:text-[#062D2A]'
          }
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Encabezado comercial: barra sticky translúcida sobre el lienzo claro #F2FAF8/90 con borde
 * inferior #C5E8E1, contenedor amplio max-w-[1240px], altura h-16, logotipo adaptativo,
 * navegación en 15px con realce a #08252d, botón CTA en píldora púrpura (#7346f6),
 * y botón hamburguesa accesible con drawer móvil desplegable.
 */
export function PublicCommercialHeader(): ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-100 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8">
        <a href="/" className="flex shrink-0 items-center gap-2 text-[#062D2A] transition-opacity hover:opacity-90">
          <Logo size={26} textTheme="dark" variant="icon" href={null} />
          <span className="text-[14px] sm:text-[15px] font-semibold tracking-tight text-[#08252d]">
            Onboarding Assistant
          </span>
        </a>
        <nav aria-label="Navegación principal" className="hidden items-center gap-7 lg:gap-9 md:flex">
          {PRIMARY_NAVIGATION_LINKS.map((link) => (
            <a key={link.href} href={link.href} className={renderHeaderNavLinkClassName()}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3 sm:gap-6">
          <a href="/auth/login" className={`hidden md:inline-block ${renderHeaderNavLinkClassName()}`}>
            Iniciar sesión
          </a>
          <a
            href="/auth/register"
            className={CTA_GRADIENT_BUTTON_CLASS}
          >
            Crear cuenta
          </a>
          <button
            type="button"
            onClick={() => setIsMenuOpen((prev) => !prev)}
            aria-label={isMenuOpen ? 'Cerrar menú de navegación' : 'Abrir menú de navegación'}
            aria-expanded={isMenuOpen}
            aria-controls="oa-mobile-drawer"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[#C5E8E1] bg-[#F2FAF8] text-[#062D2A] transition-colors hover:bg-[#DDF3EE] focus-visible:outline-2 focus-visible:outline-[#15846E] md:hidden"
          >
            {isMenuOpen ? (
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Drawer móvil retráctil con fondo #F2FAF8 y bordes #C5E8E1, con áreas táctiles accesibles (>= 40px) */}
      {isMenuOpen && (
        <div
          id="oa-mobile-drawer"
          className="border-t border-[#C5E8E1] bg-[#F2FAF8] px-4 py-4 md:hidden"
        >
          <nav aria-label="Navegación móvil" className="flex flex-col gap-1.5">
            {MOBILE_NAVIGATION_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setIsMenuOpen(false)}
                className="flex min-h-[42px] items-center rounded-[6px] px-3.5 py-2 text-[13px] font-medium tracking-[-0.01em] text-[#245954] transition-colors hover:bg-[#DDF3EE] hover:text-[#062D2A]"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}

/**
 * Pie comercial: cuatro columnas sobre la superficie secundaria #EAF7F4 con bordes #C5E8E1,
 * microtipografía editorial (#547B76 y #245954), logotipo oficial, enlaces y barra inferior de copyright.
 */
export function PublicCommercialFooter(): ReactElement {
  return (
    <footer className="relative z-10 border-t border-[#C5E8E1] bg-[#EAF7F4]">
      <div className="mx-auto w-full max-w-[1140px] px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-2.5">
            <a href="/" className="flex items-center gap-2 text-[#062D2A]">
              <Logo size={28} textTheme="dark" variant="icon" href={null} />
              <span className="text-[14px] font-medium tracking-[-0.02em] text-[#062D2A]">Onboarding Assistant</span>
            </a>
            <p className="max-w-[280px] text-[13px] leading-relaxed text-[#245954]">
              El asistente de voz autónomo que guía a usuarios y opera tu interfaz en tiempo real.
            </p>
          </div>
          <FooterLinkColumn title="Producto" links={FOOTER_PRODUCT_LINKS} />
          <FooterLinkColumn title="Cuenta" links={FOOTER_ACCOUNT_LINKS} />
          <FooterLinkColumn title="Legal" links={FOOTER_LEGAL_LINKS} />
        </div>
        <div className="mt-8 flex flex-col gap-2 border-t border-[#C5E8E1] pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-[#547B76]">© 2026 Onboarding Assistant</p>
          <p className="text-[12px] text-[#547B76]">Plataforma de voz en tiempo real</p>
        </div>
      </div>
    </footer>
  );
}
