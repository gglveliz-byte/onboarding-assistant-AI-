/**
 * @archivo apps/web/src/components/landing/hero/HeroArchitectureShowcase.tsx
 * @modulo apps/web/src/components/landing/hero (Hero Editorial · Minimalist Pure White)
 * @proposito
 *   Hero principal de la landing comercial con estética editorial de alta costura:
 *   titular monumental híbrido (Cormorant Garamond + Caveat script para "producto" con
 *   subrayado SVG delicado), párrafo editorial generoso, botón píldora púrpura (#7346f6),
 *   caja terminal de instalación y lienzo despejado completamente blanco a la derecha.
 *
 * @resumen_contenido
 *   - `HeroArchitectureShowcase`: layout editorial amplio con tipografía de alto impacto,
 *     CTA táctil y terminal CLI interactivo con copiado al portapapeles.
 *
 * @dependencias_internas
 *   - Ninguna en este componente.
 *
 * @dependencias_externas
 *   - `react` (`useEffect`, `useRef`, `useState`, type `ReactElement`).
 */

'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';

const TRAINING_CLI_COMMAND = 'npx @onboarding-assistant/cli train';
const COPY_FEEDBACK_MS = 2000;

export function HeroArchitectureShowcase(): ReactElement {
  const [copiado, setCopiado] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(TRAINING_CLI_COMMAND);
      setCopiado(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiado(false);
        copyResetTimerRef.current = null;
      }, COPY_FEEDBACK_MS);
    } catch {
      setCopiado(false);
    }
  };

  return (
    <section
      id="plataforma"
      className="relative scroll-mt-20 px-4 pt-6 pb-10 sm:px-8 sm:pt-14 sm:pb-20 lg:px-12 w-full overflow-hidden"
    >
      <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        {/* Columna izquierda con contenido editorial ampliado para llenar la pantalla */}
        <div
          className="lg:col-span-8 flex flex-col items-start text-left z-10 w-full"
          data-purpose="hero-content"
        >
          {/* Titular híbrido elegante de gran impacto visual */}
          <h1 className="font-display text-[30px] sm:text-[44px] md:text-[58px] lg:text-[68px] xl:text-[74px] leading-[1.12] sm:leading-[1.05] tracking-[-0.025em] text-[#08252d] font-medium mb-3 sm:mb-6">
            El asistente de voz que{' '}
            <span className="italic font-normal">entiende</span> tu{' '}
            <span className="font-script text-[1.22em] text-[#08252d] font-bold tracking-normal inline-block transform -rotate-1 align-baseline relative">
              producto
              {/* Trazo decorativo de subrayado manuscrito */}
              <svg
                className="absolute -bottom-1.5 left-0 w-full h-2.5 sm:h-3 text-[#7346f6] opacity-40 pointer-events-none"
                fill="none"
                preserveAspectRatio="none"
                viewBox="0 0 100 12"
                aria-hidden="true"
              >
                <path
                  d="M2,8 C25,2 75,3 98,7"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2.5"
                />
              </svg>
            </span>
            <br className="inline" /> y lo ejecuta por ti.
          </h1>

          {/* Subtítulo explicativo con tipografía cómoda y legible */}
          <p className="font-sans-editorial text-[#3d616c] text-[15px] sm:text-[17px] md:text-[19px] font-normal leading-relaxed max-w-xl lg:max-w-2xl mb-4 sm:mb-8">
            Habla con tu producto y el asistente lo opera por ti: entiende cada pantalla, completa
            los pasos y se detiene en cuanto lo interrumpes.
          </p>

          {/* Fila de acciones: Botón CTA y caja de terminal */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-5 w-full sm:w-auto">
            {/* Botón de acción principal (CTA) */}
            <a
              href="#demo-en-vivo"
              className="w-full sm:w-auto inline-flex min-h-[44px] items-center justify-center gap-2 px-7 py-3 rounded-full bg-[#7346f6] text-white text-[12px] sm:text-[13px] tracking-wider uppercase font-bold hover:bg-[#6335ea] active:scale-[0.98] transition-all shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#7346f6] focus:ring-offset-2"
            >
              <span>PROBAR ASISTENTE EN VIVO</span>
              <span className="text-sm font-semibold inline-block transform translate-y-[1px]">↓</span>
            </a>

            {/* Píldora de comando CLI de instalación */}
            <div
              className="w-full sm:w-auto inline-flex items-center justify-between max-w-full px-4 py-2 sm:px-5 sm:py-2.5 rounded-full bg-white/90 border border-[#cbebe5] text-[#123944] shadow-xs hover:border-[#b1ded6] transition-all"
              data-purpose="terminal-code-pill"
            >
              <div className="flex items-center gap-2 overflow-x-auto text-[13px] sm:text-[14px] font-mono tracking-tight select-all whitespace-nowrap">
                <span className="text-[#7346f6] font-semibold">$</span>
                <code>{TRAINING_CLI_COMMAND}</code>
              </div>
              <button
                type="button"
                onClick={handleCopyCommand}
                aria-label="Copiar comando al portapapeles"
                title="Copiar comando"
                className={`ml-3 p-1.5 rounded-lg border transition-all flex items-center justify-center shrink-0 group ${
                  copiado
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700 hover:text-[#08252d]'
                }`}
              >
                <svg
                  className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <line x1="7" y1="17" x2="17" y2="7" />
                  <polyline points="7 7 17 7 17 17" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Columna derecha completamente blanca y despejada */}
        <div
          className="lg:col-span-4 hidden lg:block"
          aria-hidden="true"
        />
      </div>
    </section>
  );
}
