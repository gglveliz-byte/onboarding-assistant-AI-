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

import React, { useState, useEffect } from 'react';
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
  readonly capturedElementsCount: number;
  readonly isElementsDrawerOpen: boolean;
  readonly onToggleElementsDrawer: () => void;
  readonly onUrlChange: (newUrl: string) => void;
  readonly onReload: (url: string) => void;
  readonly onModeChange: (mode: TrainingSessionMode) => void;
  readonly onViewportChange: (viewport: ViewportPreset) => void;
  readonly onToggleAutoRecalculate: (enabled: boolean) => void;
  readonly onAddManualSelector?: () => void;
  readonly onEndSession?: () => void;
}

export function TrainerToolbarAndViewportSwitcher({
  sessionState,
  currentViewport,
  autoRecalculateResponsive,
  capturedElementsCount,
  isElementsDrawerOpen,
  onToggleElementsDrawer,
  onUrlChange,
  onReload,
  onModeChange,
  onViewportChange,
  onToggleAutoRecalculate,
  onAddManualSelector,
}: TrainerToolbarProps) {
  const [inputUrl, setInputUrl] = useState(sessionState.targetUrl);

  useEffect(() => {
    if (sessionState.targetUrl) {
      setInputUrl(sessionState.targetUrl);
    }
  }, [sessionState.targetUrl]);

  // Detección de dominio base para resolución y accesos directos a sub-rutas
  const activeBaseUrl = sessionState.validatedUrl || sessionState.targetUrl;
  let currentHost = '';
  try {
    if (activeBaseUrl && (activeBaseUrl.startsWith('http://') || activeBaseUrl.startsWith('https://'))) {
      currentHost = new URL(activeBaseUrl).hostname;
    }
  } catch {
    // Formato de URL aún en digitación
  }

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl.trim()) {
      onReload(inputUrl.trim());
    }
  };

  return (
    <div
      className="h-11 bg-[#f2f1ed] border-b border-[#cdcdc9] px-2 sm:px-3 flex items-center justify-between gap-2 select-none shrink-0 overflow-x-auto min-w-0"
      data-testid="trainer-toolbar"
    >
      {/* 1. URL Remota y Modo Operativo */}
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 max-w-2xl">
        <form onSubmit={handleUrlSubmit} className="flex items-center gap-1.5 flex-1 min-w-[180px] max-w-md">
          <div
            className="flex items-center gap-1.5 px-2 py-1 bg-[#ffffff] border border-[#cdcdc9] rounded flex-1 min-w-0 shadow-2xs"
            style={{ borderRadius: '4px' }}
          >
            <span className="text-[#34785c] text-xs" title="Escudo Anti-Escape de Ventana activo">🛡️</span>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => {
                setInputUrl(e.target.value);
                onUrlChange(e.target.value);
              }}
              placeholder={currentHost ? `${currentHost} o ruta /auth/login` : 'https://app.tuempresa.com o /login'}
              className="flex-1 min-w-0 text-xs font-mono bg-transparent text-[#26251e] placeholder:text-[#a1a19f] focus:outline-none"
            />
            {sessionState.pinnedIp && (
              <span
                className="hidden xl:inline text-[9px] font-mono text-[#84847e] bg-[#e6e5e0] px-1 py-0.5 rounded"
                title="IP fijada por DNS Pinning Anti-SSRF"
              >
                {sessionState.pinnedIp}
              </span>
            )}
          </div>
          <button
            type="submit"
            className="px-2.5 py-1 text-xs font-sans font-medium bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors cursor-pointer shrink-0"
            style={{ borderRadius: '4px' }}
            disabled={sessionState.isConnecting}
          >
            {sessionState.isConnecting ? '...' : 'Ir'}
          </button>
          <button
            type="button"
            onClick={() => onReload(inputUrl.trim() || sessionState.targetUrl)}
            className="p-1 text-[#84847e] hover:text-[#26251e] bg-[#ffffff] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors cursor-pointer shrink-0"
            style={{ borderRadius: '4px' }}
            title="Recargar página"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </form>

        {/* Atajos de Rutas Rápidas (Login, Registro, Inicio) sin romper el contenedor */}
        {currentHost && (
          <div className="hidden md:flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onReload('/auth/login')}
              className="px-2 py-0.5 text-[11px] font-sans font-medium bg-[#ffffff] hover:bg-[#e6e5e0] text-[#26251e] border border-[#cdcdc9] rounded transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
              style={{ borderRadius: '3px' }}
              title="Cargar página de inicio de sesión (/auth/login)"
            >
              <span>🔑</span>
              <span>Login</span>
            </button>
            <button
              type="button"
              onClick={() => onReload('/auth/register')}
              className="px-2 py-0.5 text-[11px] font-sans font-medium bg-[#ffffff] hover:bg-[#e6e5e0] text-[#26251e] border border-[#cdcdc9] rounded transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
              style={{ borderRadius: '3px' }}
              title="Cargar página de registro (/auth/register)"
            >
              <span>📝</span>
              <span>Registro</span>
            </button>
            <button
              type="button"
              onClick={() => onReload('/')}
              className="px-1.5 py-0.5 text-[11px] font-sans font-medium bg-[#ffffff] hover:bg-[#e6e5e0] text-[#7a7974] hover:text-[#26251e] border border-[#cdcdc9] rounded transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
              style={{ borderRadius: '3px' }}
              title="Regresar al inicio (/)"
            >
              <span>🏠</span>
            </button>
          </div>
        )}

        {/* Conmutador de Modo: Navegación vs Captura */}
        <div
          className="inline-flex p-0.5 bg-[#e6e5e0] border border-[#cdcdc9] rounded shrink-0"
          style={{ borderRadius: '4px' }}
        >
          <button
            type="button"
            onClick={() => onModeChange('ACTIVE_NAVIGATION_MODE')}
            className={`px-2 sm:px-2.5 py-1 text-xs font-sans rounded transition-colors whitespace-nowrap cursor-pointer ${
              sessionState.currentMode === 'ACTIVE_NAVIGATION_MODE'
                ? 'bg-[#26251e] text-[#f7f7f4] font-medium shadow-xs'
                : 'text-[#84847e] hover:text-[#26251e]'
            }`}
            style={{ borderRadius: '3px' }}
            title="Navega normalmente en tu web hasta la pantalla a entrenar"
          >
            <span className="sm:hidden">Navegar</span>
            <span className="hidden sm:inline">Modo Navegación</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange('ACTIVE_CAPTURE_OVERLAY_MODE')}
            className={`px-2 sm:px-2.5 py-1 text-xs font-sans rounded transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              sessionState.currentMode === 'ACTIVE_CAPTURE_OVERLAY_MODE'
                ? 'bg-[#26251e] text-[#f7f7f4] font-medium shadow-xs'
                : 'text-[#84847e] hover:text-[#26251e]'
            }`}
            style={{ borderRadius: '3px' }}
            title="Haz clic sobre botones o enlaces para registrarlos en el mapa RAG"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#f54e00] animate-pulse" />
            <span className="sm:hidden">Capturar</span>
            <span className="hidden sm:inline">Modo Captura</span>
          </button>
        </div>
      </div>

      {/* 2. Viewports, Telemetría y Acceso a Elementos Registrados */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* Selector de Viewports */}
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
                className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[#ffffff] text-[#26251e] font-medium border border-[#cdcdc9] shadow-2xs'
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

        {/* Auto Responsive Checkbox */}
        <label
          className="hidden xl:flex items-center gap-1 text-[11px] font-sans text-[#84847e] cursor-pointer"
          title="Recalcula automáticamente coordenadas en Desktop, Tablet y Móvil"
        >
          <input
            type="checkbox"
            id="toggle_auto_responsive_recalculation"
            checked={autoRecalculateResponsive}
            onChange={(e) => onToggleAutoRecalculate(e.target.checked)}
            className="rounded border-[#cdcdc9] accent-[#34785c] focus:ring-0"
          />
          <span>Auto Resp.</span>
        </label>

        {/* Latencia en vivo */}
        <span
          className="text-[10px] font-mono text-[#1f8a65] bg-[#1f8a65]/10 px-1.5 py-0.5 rounded border border-[#1f8a65]/20 hidden sm:inline"
          style={{ fontVariantNumeric: 'tabular-nums' }}
          title="Latencia de respuesta de inspección vectorial"
        >
          {sessionState.simulationMode ? '—' : `${sessionState.lastInspectLatencyMs}ms`}
        </span>

        {/* Botón rápido para selector manual */}
        {onAddManualSelector && (
          <button
            type="button"
            onClick={onAddManualSelector}
            className="px-2 py-1 text-xs font-sans bg-[#ffffff] hover:bg-[#e6e5e0] text-[#26251e] border border-[#cdcdc9] rounded transition-colors cursor-pointer shadow-2xs"
            style={{ borderRadius: '4px' }}
            title="Añadir selector CSS manualmente"
          >
            <span>➕</span>
          </button>
        )}

        {/* Botón trigger para Drawer de Elementos Registrados */}
        <button
          type="button"
          onClick={onToggleElementsDrawer}
          className={`px-2.5 py-1 text-xs font-sans rounded border transition-colors flex items-center gap-1.5 cursor-pointer shadow-2xs whitespace-nowrap ${
            isElementsDrawerOpen
              ? 'bg-[#26251e] text-[#f7f7f4] border-[#26251e] font-medium'
              : 'bg-[#ffffff] text-[#26251e] border-[#cdcdc9] hover:bg-[#e6e5e0]'
          }`}
          style={{ borderRadius: '4px' }}
          title={isElementsDrawerOpen ? 'Cerrar panel de elementos' : 'Ver elementos registrados'}
        >
          <span>🏷️ Elementos</span>
          <span
            className={`px-1.5 py-0.2 text-[10px] font-mono rounded-full ${
              isElementsDrawerOpen
                ? 'bg-[#f7f7f4] text-[#26251e] font-semibold'
                : 'bg-[#1f8a65] text-[#ffffff] font-medium'
            }`}
          >
            {capturedElementsCount}
          </span>
        </button>
      </div>
    </div>
  );
}
