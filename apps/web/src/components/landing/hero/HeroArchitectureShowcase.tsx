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
      className="relative scroll-mt-20 px-4 pt-6 pb-10 sm:px-6 sm:pt-12 sm:pb-16 lg:px-8 w-full overflow-hidden"
    >
      <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        {/* Columna izquierda con contenido editorial ampliado para llenar la pantalla */}
        <div
          className="lg:col-span-8 flex flex-col items-start text-left z-10 w-full"
          data-purpose="hero-content"
        >
          {/* Titular híbrido elegante de gran impacto visual */}
          <h1 className="font-display text-[28px] xs:text-[34px] sm:text-[46px] md:text-[56px] lg:text-[66px] xl:text-[74px] leading-[1.14] sm:leading-[1.05] tracking-[-0.025em] text-[#08252d] font-medium mb-3 sm:mb-6 [text-wrap:balance]">
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
            </span>{' '}
            <span className="inline xl:block">y lo ejecuta por ti.</span>
          </h1>

          {/* Subtítulo explicativo con tipografía cómoda y legible */}
          <p className="font-sans-editorial text-[#3d616c] text-[15px] sm:text-[17px] md:text-[19px] font-normal leading-relaxed max-w-xl lg:max-w-2xl mb-4 sm:mb-8 [text-wrap:pretty]">
            Habla con tu producto y el asistente lo opera por ti: entiende cada pantalla, completa
            los pasos y se detiene en cuanto lo interrumpes.
          </p>

          {/* Fila de acciones: Botón CTA y caja de terminal */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-4 w-full sm:w-auto">
            {/* Botón de acción principal (CTA) */}
            <a
              href="#demo-en-vivo"
              className="w-full sm:w-auto inline-flex min-h-[44px] items-center justify-center gap-2 px-7 py-3 rounded-full bg-[#7346f6] text-white text-[12px] sm:text-[13px] tracking-wider uppercase font-bold hover:bg-[#6335ea] active:scale-[0.98] transition-all shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#7346f6] focus:ring-offset-2 shrink-0"
            >
              <span>PROBAR ASISTENTE EN VIVO</span>
              <span className="text-sm font-semibold inline-block transform translate-y-[1px]">↓</span>
            </a>

            {/* Píldora de comando CLI de instalación con enlace a Docs y botón de copiado */}
            <div
              className="w-full sm:w-auto inline-flex items-center justify-between max-w-full min-w-0 px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-full bg-white/95 border border-[#cbebe5] text-[#123944] shadow-xs hover:border-[#7346f6]/60 hover:bg-white transition-all group/pill"
              data-purpose="terminal-code-pill"
            >
              <a
                href="/docs#cli"
                className="flex items-center gap-2 overflow-x-auto min-w-0 text-[12px] sm:text-[14px] font-mono tracking-tight text-[#123944] hover:text-[#7346f6] transition-colors whitespace-nowrap focus:outline-none"
                title="Ver documentación del comando CLI de entrenamiento"
              >
                <span className="text-[#7346f6] font-semibold">$</span>
                <code>{TRAINING_CLI_COMMAND}</code>
                <span className="text-slate-400 group-hover/pill:text-[#7346f6] text-xs font-sans transition-all inline-block transform group-hover/pill:translate-x-0.5 group-hover/pill:-translate-y-0.5">
                  ↗
                </span>
              </a>

              <button
                type="button"
                onClick={handleCopyCommand}
                aria-label="Copiar comando al portapapeles"
                title={copiado ? '¡Comando copiado al portapapeles!' : 'Copiar comando'}
                className={`ml-2.5 px-2.5 py-1 rounded-md text-[11px] font-sans font-medium border transition-all flex items-center gap-1 shrink-0 ${
                  copiado
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 hover:bg-slate-100 text-slate-600 hover:text-[#08252d]'
                }`}
              >
                {copiado ? (
                  <>
                    <svg className="w-3.5 h-3.5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>Copiado</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>Copiar</span>
                  </>
                )}
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
