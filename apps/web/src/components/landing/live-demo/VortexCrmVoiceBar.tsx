/**
 * @archivo apps/web/src/components/landing/live-demo/VortexCrmVoiceBar.tsx
 * @modulo apps/web/src/components/landing/live-demo (Barra de Voz del CRM Simulado)
 * @proposito
 *   Muestra la transcripción de voz reactiva y el ecualizador de ondas bioluminiscentes
 *   impulsado por la energía real del micrófono en la demo del CRM.
 *
 * @resumen_contenido
 *   - Visualización de estado (Escuchando, Respondiendo, Ejecutando en pantalla).
 *   - Transcripción de habla dinámica en tiempo real.
 *   - Barras de ecualización animadas según la potencia de audio del usuario.
 *
 * @dependencias_externas
 *   - `react` (`type ReactElement`).
 */

'use client';

import type { ReactElement } from 'react';

export interface VortexCrmVoiceBarProps {
  readonly isSpeaking: boolean;
  readonly isExecuting: boolean;
  readonly speechText: string;
  readonly barsEnergy?: readonly number[];
}

export function VortexCrmVoiceBar({
  isSpeaking,
  isExecuting,
  speechText,
  barsEnergy = [],
}: VortexCrmVoiceBarProps): ReactElement {
  const getBarHeight = (index: number, defaultH: number): number => {
    const energy = barsEnergy[index] ?? 0;
    return Math.min(20, Math.max(4, Math.round(energy * 20) || defaultH));
  };

  return (
    <div
      className="mt-2 bg-[#0a252c] text-white p-2 rounded-lg shadow-md flex items-center justify-between gap-2.5 border border-teal-500/20"
      data-purpose="voice-transcription-widget"
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded-md bg-[#6d3dfa]/30 border border-[#6d3dfa] flex items-center justify-center text-violet-300 shrink-0">
          <svg className="w-3 h-3 text-violet-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </div>
        <div className="text-[11px] truncate">
          <span className="text-teal-400 font-bold block text-[9px] tracking-wider uppercase">
            {isSpeaking ? 'Asistente respondiendo:' : isExecuting ? 'Ejecutando en pantalla:' : 'Escuchando usuario:'}
          </span>
          <p className="font-medium text-slate-100 italic truncate text-[10px] sm:text-[11px]">
            "{speechText.length > 0 ? speechText : 'Haz una prueba de voz o interactúa con el CRM...'}"
          </p>
        </div>
      </div>

      <div className="flex items-end gap-1 h-5 shrink-0 pr-1" aria-hidden="true">
        <span className="w-1 bg-teal-400 rounded-full transition-all duration-75" style={{ height: `${getBarHeight(0, 8)}px` }} />
        <span className="w-1 bg-teal-300 rounded-full transition-all duration-75" style={{ height: `${getBarHeight(4, 16)}px` }} />
        <span className="w-1 bg-[#6d3dfa] rounded-full transition-all duration-75" style={{ height: `${getBarHeight(8, 12)}px` }} />
        <span className="w-1 bg-teal-400 rounded-full transition-all duration-75" style={{ height: `${getBarHeight(12, 18)}px` }} />
        <span className="w-1 bg-teal-200 rounded-full transition-all duration-75" style={{ height: `${getBarHeight(16, 6)}px` }} />
      </div>
    </div>
  );
}
