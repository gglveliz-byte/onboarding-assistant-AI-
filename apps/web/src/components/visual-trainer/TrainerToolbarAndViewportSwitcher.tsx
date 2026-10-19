/**
 * @archivo apps/web/src/components/visual-trainer/TrainerToolbarAndViewportSwitcher.tsx
 * @modulo 08-frontend-visual-trainer (Barra de Instrumentación y Conmutador de Viewports Responsive)
 * @proposito
 *   Provee los controles superiores del visor de entrenamiento visual: barra de navegación
 *   de URL con escudo Anti-SSRF, conmutador segmentado entre Modo Navegación y Modo Captura
 *   con Overlay DOM, selector de resoluciones Responsive (Desktop 1440x900, Tablet 768x1024,
 *   Mobile 390x844) y toggle de recálculo multi-viewport automático.
 *
 * @resumen_contenido
 *   - Controles de URL remota con botón de recarga e indicador de IP fijada (DNS Pinning).
 *   - Conmutador segmentado de modos de sesión (Navegación vs Captura).
 *   - Selector de viewports normalizados para cálculo de bounding boxes.
 *   - Barra adaptable con etiquetas compactas y controles con wrap en móvil.
 *   - Telemetría en tiempo real: latencia DataChannel/WebSocket en berkeleyMono.
 *
 * @dependencias_internas
 *   - `TrainingSessionMode`, `TrainingSessionState` (./useRemoteTrainerSession.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions`.
 */

'use client';

import React, { useState } from 'react';
import type { TrainingSessionMode, TrainingSessionState } from './useRemoteTrainerSession';

export type ViewportPreset = 'DESKTOP' | 'TABLET' | 'MOBILE';

export interface ViewportDimensions {
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

export const VIEWPORT_CONFIGS: Record<ViewportPreset, ViewportDimensions> = {
  DESKTOP: { width: 1440, height: 900, label: 'Desktop 1440×900' },
  TABLET: { width: 768, height: 1024, label: 'Tablet 768×1024' },
  MOBILE: { width: 390, height: 844, label: 'Mobile 390×844' },
};

export interface TrainerToolbarProps {
  readonly sessionState: TrainingSessionState;
  readonly currentViewport: ViewportPreset;
  readonly autoRecalculateResponsive: boolean;
  readonly onUrlChange: (newUrl: string) => void;
  readonly onReload: (url: string) => void;
  readonly onModeChange: (mode: TrainingSessionMode) => void;
  readonly onViewportChange: (viewport: ViewportPreset) => void;
  readonly onToggleAutoRecalculate: (enabled: boolean) => void;
  readonly onEndSession: () => void;
}

export function TrainerToolbarAndViewportSwitcher({
  sessionState,
  currentViewport,
  autoRecalculateResponsive,
  onUrlChange,
  onReload,
  onModeChange,
  onViewportChange,
  onToggleAutoRecalculate,
  onEndSession,
}: TrainerToolbarProps) {
  const [inputUrl, setInputUrl] = useState(sessionState.targetUrl);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl.trim()) {
      onReload(inputUrl.trim());
    }
  };

  return (
    <div
      className="bg-[#f2f1ed] border-b border-[#cdcdc9] px-3 sm:px-4 py-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-3 select-none"
      data-testid="trainer-toolbar"
    >
      {/* 1. Barra de URL y Navegador */}
      <form onSubmit={handleUrlSubmit} className="flex items-center gap-2 flex-1 min-w-0 max-w-xl">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-[#f7f7f4] border border-[#cdcdc9] rounded flex-1 min-w-0" style={{ borderRadius: '4px' }}>
          <span className="text-[#34785c] text-xs">🔒</span>
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => {
              setInputUrl(e.target.value);
              onUrlChange(e.target.value);
            }}
            placeholder="https://app.tuempresa.com"
            className="flex-1 min-w-0 text-xs font-mono bg-transparent text-[#26251e] placeholder:text-[#a1a19f] focus:outline-none"
          />
          {sessionState.pinnedIp && (
            <span
              className="hidden sm:inline text-[10px] font-mono text-[#84847e] bg-[#e6e5e0] px-1.5 py-0.5 rounded"
              title="IP fijada por DNS Pinning Anti-SSRF"
            >
              {sessionState.pinnedIp}
            </span>
          )}
        </div>
        <button
          type="submit"
          className="px-3 py-1 text-xs font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors"
          style={{ borderRadius: '4px' }}
          disabled={sessionState.isConnecting}
        >
          {sessionState.isConnecting ? 'Conectando...' : 'Ir'}
        </button>
      </form>

      {/* 2. Conmutador de Modo: Navegación vs Captura */}
      <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
        <div
          className="inline-flex p-0.5 bg-[#e6e5e0] border border-[#cdcdc9] rounded"
          style={{ borderRadius: '4px' }}
        >
          <button
            type="button"
            onClick={() => onModeChange('ACTIVE_NAVIGATION_MODE')}
            className={`px-2 sm:px-3 py-1 text-xs font-sans rounded transition-colors whitespace-nowrap ${
              sessionState.currentMode === 'ACTIVE_NAVIGATION_MODE'
                ? 'bg-[#26251e] text-[#f7f7f4] font-medium shadow-xs'
                : 'text-[#84847e] hover:text-[#26251e]'
            }`}
            style={{ borderRadius: '3px' }}
          >
            <span className="sm:hidden">Navegación</span>
            <span className="hidden sm:inline">Modo Navegación</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange('ACTIVE_CAPTURE_OVERLAY_MODE')}
            className={`px-2 sm:px-3 py-1 text-xs font-sans rounded transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              sessionState.currentMode === 'ACTIVE_CAPTURE_OVERLAY_MODE'
                ? 'bg-[#26251e] text-[#f7f7f4] font-medium shadow-xs'
                : 'text-[#84847e] hover:text-[#26251e]'
            }`}
            style={{ borderRadius: '3px' }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#f54e00]" />
            <span className="sm:hidden">Captura</span>
            <span className="hidden sm:inline">Modo Captura Overlay</span>
          </button>
        </div>

        {/* 3. Selector de Viewport Responsive */}
        <div
          className="inline-flex p-0.5 bg-[#e6e5e0] border border-[#cdcdc9] rounded"
          style={{ borderRadius: '4px' }}
        >
          {(['DESKTOP', 'TABLET', 'MOBILE'] as ViewportPreset[]).map((preset) => {
            const isSelected = currentViewport === preset;
            const config = VIEWPORT_CONFIGS[preset];
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onViewportChange(preset)}
                className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors ${
                  isSelected
                    ? 'bg-[#f7f7f4] text-[#26251e] font-medium border border-[#cdcdc9]'
                    : 'text-[#84847e] hover:text-[#26251e]'
                }`}
                style={{ borderRadius: '3px', fontVariantNumeric: 'tabular-nums' }}
                title={config.label}
              >
                {preset === 'DESKTOP' ? '🖥 Desktop' : preset === 'TABLET' ? '📱 Tablet' : '📱 Móvil'}
              </button>
            );
          })}
        </div>

        {/* 4. Toggle de Auto-Recálculo Responsive */}
        <label
          className="hidden lg:flex items-center gap-1.5 text-[11px] font-sans text-[#84847e] cursor-pointer"
          title="Recalcula automáticamente las coordenadas en Desktop, Tablet y Móvil"
        >
          <input
            type="checkbox"
            id="toggle_auto_responsive_recalculation"
            checked={autoRecalculateResponsive}
            onChange={(e) => onToggleAutoRecalculate(e.target.checked)}
            className="rounded border-[#cdcdc9] accent-[#34785c] focus:ring-0"
          />
          <span>Auto Responsive</span>
        </label>

        {/* 5. Latencia DataChannel & Botón Salir */}
        <div className="flex items-center gap-2 md:pl-2 md:border-l border-[#cdcdc9]">
          <span
            className="text-[11px] font-mono text-[#1f8a65] bg-[#1f8a65]/10 px-2 py-0.5 rounded"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            title={sessionState.simulationMode
              ? 'Sin DataChannel: no hay medición real de latencia en modo simulación'
              : 'Latencia de respuesta de inspección vectorial'}
          >
            {sessionState.simulationMode ? '—' : `${sessionState.lastInspectLatencyMs}ms`}
          </span>
          <button
            type="button"
            onClick={onEndSession}
            className="px-2.5 py-1 text-xs font-sans text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/30 rounded transition-colors whitespace-nowrap"
            style={{ borderRadius: '4px' }}
            title="Terminar contenedor efímero"
          >
            <span className="sm:hidden">Salir</span>
            <span className="hidden sm:inline">Cerrar Sesión</span>
          </button>
        </div>
      </div>
    </div>
  );
}
