/**
 * @archivo apps/web/src/components/landing/hero/AmbientVoiceVisualizer.tsx
 * @modulo apps/web/src/components/landing/hero (Ambient Voice Resonance Visualizer)
 * @proposito
 *   Visualizador de voz ambiental con resonancia acústica concéntrica, halo difuso,
 *   disco de cristal translúcido y ecualizador de 5 barras de frecuencia animadas
 *   para representar la comprensión activa del asistente en tiempo real.
 *
 * @resumen_contenido
 *   - `AmbientVoiceVisualizer`: componente responsivo con soporte para tamaño móvil ('sm')
 *     y versión completa de escritorio/tablet ('lg').
 *   - Ondas de resonancia concéntrica `pulse-ring-slow` y `pulse-ring-fast`.
 *   - 5 barras de ecualizador con degradados violeta (#693cf5), cyan (#2ec4b6) y turquesa (#2dd4bf).
 *
 * @dependencias_internas
 *   - Ninguna (autónomo y estilizado con Tailwind CSS y clases de globals.css).
 *
 * @dependencias_externas
 *   - `react` (memo, type `ReactElement`).
 */

'use client';

import { memo, type ReactElement } from 'react';

export interface AmbientVoiceVisualizerProps {
  /** Tamaño del visualizador: 'sm' para vista previa móvil centrada, 'lg' para tablet/escritorio */
  readonly size?: 'sm' | 'lg';
  /** Clases adicionales de estilo */
  readonly className?: string;
}

export const AmbientVoiceVisualizer = memo(function AmbientVoiceVisualizer({
  size = 'lg',
  className = '',
}: AmbientVoiceVisualizerProps): ReactElement {
  if (size === 'sm') {
    return (
      <div
        className={`relative w-[150px] h-[150px] flex items-center justify-center select-none pointer-events-none ${className}`}
        aria-hidden="true"
      >
        {/* Halo esmeralda difuso */}
        <div className="absolute inset-0 rounded-full bg-emerald-200/20 blur-lg" />
        {/* Onda concéntrica exterior */}
        <div className="absolute w-[136px] h-[136px] rounded-full border border-teal-300/30 pulse-ring-slow" />
        {/* Onda concéntrica interior */}
        <div className="absolute w-[100px] h-[100px] rounded-full border border-purple-300/25 pulse-ring-fast" />
        {/* Disco central de cristal */}
        <div className="absolute w-[70px] h-[70px] rounded-full bg-gradient-to-tr from-cyan-100/70 to-purple-100/50 backdrop-blur-sm border border-white/70 shadow-inner flex items-center justify-center">
          {/* Ecualizador de 5 barras de frecuencia de voz */}
          <div className="flex items-center gap-0.5 h-5">
            <span className="wave-bar wave-bar-1 w-0.5 h-2 bg-[#7346f6]/70 rounded-full" />
            <span className="wave-bar wave-bar-2 w-0.5 h-3.5 bg-[#7346f6]/80 rounded-full" />
            <span className="wave-bar wave-bar-3 w-0.5 h-5 bg-[#15846E]/80 rounded-full" />
            <span className="wave-bar wave-bar-4 w-0.5 h-3 bg-[#7346f6]/70 rounded-full" />
            <span className="wave-bar wave-bar-5 w-0.5 h-1.5 bg-[#2dd4bf]/70 rounded-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative w-[220px] h-[220px] sm:w-[260px] sm:h-[260px] lg:w-[300px] lg:h-[300px] flex items-center justify-center select-none pointer-events-none ${className}`}
      aria-hidden="true"
    >
      {/* Halo ambiental difuso esmeralda */}
      <div className="absolute inset-0 rounded-full bg-emerald-200/25 blur-2xl pointer-events-none" />

      {/* Anillo de onda concéntrica exterior lento */}
      <div className="absolute w-[200px] sm:w-[240px] lg:w-[270px] h-[200px] sm:h-[240px] lg:h-[270px] rounded-full border border-teal-300/35 pulse-ring-slow" />

      {/* Anillo de onda concéntrica interior rápido */}
      <div className="absolute w-[150px] sm:w-[180px] lg:w-[200px] h-[150px] sm:h-[180px] lg:h-[200px] rounded-full border border-purple-300/30 pulse-ring-fast" />

      {/* Disco central de cristal translúcido con gradiente suave */}
      <div className="relative w-[100px] sm:w-[115px] lg:w-[130px] h-[100px] sm:h-[115px] lg:h-[130px] rounded-full bg-gradient-to-tr from-cyan-100/60 to-purple-100/40 backdrop-blur-sm border border-white/80 shadow-inner flex items-center justify-center">
        {/* Ecualizador de 5 barras de actividad acústica */}
        <div
          aria-label="Visualizador de actividad acústica en tiempo real"
          className="flex items-center justify-center gap-1 sm:gap-1.5 h-9 lg:h-10"
        >
          {/* Barra 1 (Púrpura) */}
          <span className="wave-bar wave-bar-1 w-1 sm:w-1.5 h-3.5 lg:h-4 rounded-full bg-[#7042f8]" />
          {/* Barra 2 (Violeta a Azul) */}
          <span className="wave-bar wave-bar-2 w-1 sm:w-1.5 h-6 lg:h-7 rounded-full bg-gradient-to-t from-[#693cf5] to-[#407bff]" />
          {/* Barra 3 (Centro Verde Azulado / Cyan) */}
          <span className="wave-bar wave-bar-3 w-1 sm:w-1.5 h-8 lg:h-9 rounded-full bg-gradient-to-t from-[#2ec4b6] to-[#0ea5e9]" />
          {/* Barra 4 (Turquesa Claro) */}
          <span className="wave-bar wave-bar-4 w-1 sm:w-1.5 h-5 lg:h-6 rounded-full bg-gradient-to-t from-[#38bdf8] to-[#2dd4bf]" />
          {/* Barra 5 (Turquesa Suave) */}
          <span className="wave-bar wave-bar-5 w-1 sm:w-1.5 h-2.5 lg:h-3 rounded-full bg-[#2dd4bf]" />
        </div>
      </div>
    </div>
  );
});
