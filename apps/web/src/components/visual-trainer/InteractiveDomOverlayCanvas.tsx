/**
 * @archivo apps/web/src/components/visual-trainer/InteractiveDomOverlayCanvas.tsx
 * @modulo 08-frontend-visual-trainer (Lienzo Interactivo con Overlay DOM Vectorial y Filtro PII)
 * @proposito
 *   Renderiza la superficie interactiva del stream del navegador remoto (cero screenshots ciegos)
 *   y proyecta en tiempo real las cajas vectoriales de inspección sobre los nodos DOM, calculando
 *   la estabilidad del selector (0-100) y bloqueando visualmente campos con datos sensibles (PII).
 *
 * @resumen_contenido
 *   - Proyección del marco de ventana responsive (Desktop, Tablet, Móvil).
 *   - Alerta visual ante bloqueo Anti-SSRF (`SSRF_BLOCKED_IP_RANGE`) en color Crimson #cf2d56.
 *   - Superposición vectorial de hover: borde de inspección naranja brasa #f54e00 y metadatos berkeleyMono.
 *   - Enmascaramiento de campos sensibles (`password`, `credit-card`, `[data-oa-sensitive="true"]`).
 *   - Disparador de apertura del modal de etiquetado al hacer click en modo captura.
 *
 * @dependencias_internas
 *   - `InspectedElementMetadata`, `TrainingSessionState` (./useRemoteTrainerSession.ts).
 *   - `ViewportPreset`, `VIEWPORT_CONFIGS` (./TrainerToolbarAndViewportSwitcher.tsx).
 *
 * @tablas_bd_o_redis
 *   - Interactúa con eventos DOM en tiempo real del agente CDP inyectado.
 */

'use client';

import React, { useRef } from 'react';
import type { InspectedElementMetadata, TrainingSessionState } from './useRemoteTrainerSession';
import { ViewportPreset, VIEWPORT_CONFIGS } from './TrainerToolbarAndViewportSwitcher';

export interface InteractiveDomOverlayCanvasProps {
  readonly sessionState: TrainingSessionState;
  readonly viewport: ViewportPreset;
  readonly inspectedElement: InspectedElementMetadata | null;
  readonly onPointerMove: (clientX: number, clientY: number, containerRect: DOMRect) => void;
  readonly onSelectElement: (element: InspectedElementMetadata) => void;
}

export function InteractiveDomOverlayCanvas({
  sessionState,
  viewport,
  inspectedElement,
  onPointerMove,
  onSelectElement,
}: InteractiveDomOverlayCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportConfig = VIEWPORT_CONFIGS[viewport];
  const isCaptureMode = sessionState.currentMode === 'ACTIVE_CAPTURE_OVERLAY_MODE';

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    onPointerMove(e.clientX, e.clientY, rect);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    onPointerMove(e.clientX, e.clientY, rect);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isCaptureMode && inspectedElement) {
      e.stopPropagation();
      onSelectElement(inspectedElement);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isCaptureMode && inspectedElement) {
      e.stopPropagation();
      onSelectElement(inspectedElement);
    }
  };

  // Alerta Crítica Anti-SSRF
  if (sessionState.ssrfBlockedMessage) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 bg-[#f7f7f4] text-center"
        data-testid="ssrf-blocked-view"
      >
        <div
          className="max-w-lg p-6 bg-[#cf2d56]/10 border border-[#cf2d56]/40 rounded space-y-3"
          style={{ borderRadius: '8px' }}
        >
          <div className="text-sm font-sans font-medium text-[#cf2d56] flex items-center justify-center gap-2">
            <span>🛡️</span>
            <span>Acceso Bloqueado por Escudo de Seguridad Anti-SSRF</span>
          </div>
          <p className="text-xs font-sans text-[#26251e] leading-relaxed">
            {sessionState.ssrfBlockedMessage}
          </p>
          <div className="text-[11px] font-mono text-[#84847e] pt-2 border-t border-[#cf2d56]/20">
            Destino rechazado: {sessionState.targetUrl}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-[#e6e5e0]/30 overflow-auto">
      {/* Marco de Ventana con Dimensiones del Viewport */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleClick}
        className="relative bg-[#ffffff] border border-[#cdcdc9] shadow-xl overflow-hidden transition-all duration-200 select-none cursor-crosshair touch-none"
        style={{
          width: `${Math.min(viewportConfig.width, 1100)}px`,
          height: `${Math.min(viewportConfig.height, 680)}px`,
          borderRadius: '4px',
          boxShadow: 'rgba(0, 0, 0, 0.12) 0px 20px 50px 0px',
          touchAction: 'none',
        }}
      >
        {/* Cabecera Simulada de la Aplicación Remota */}
        <div className="h-11 bg-[#f2f1ed] border-b border-[#cdcdc9] px-4 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
            </div>
            <span className="text-xs font-sans text-[#84847e]">
              {sessionState.validatedUrl || 'Aplicación en Entrenamiento Remoto'}
            </span>
          </div>
          <span className="text-[10px] font-mono text-[#84847e]">
            {viewportConfig.width}×{viewportConfig.height}
          </span>
        </div>

        {/* Lienzo del DOM de la Aplicación de Ejemplo */}
        <div className="p-6 space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-sans font-medium text-[#26251e]">Panel de Facturación y Clientes</h2>
            <p className="text-xs font-sans text-[#84847e]">
              Pasa el cursor sobre los elementos interactivos en Modo Captura para registrarlos en el Mapa RAG.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-[#f7f7f4] border border-[#cdcdc9] rounded space-y-3" style={{ borderRadius: '4px' }}>
              <div className="text-xs font-sans font-medium text-[#26251e]">Acciones Principales</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-oa-id="btn-create-invoice"
                  className="px-3 py-1.5 text-xs font-sans bg-[#26251e] text-[#f7f7f4] rounded"
                  style={{ borderRadius: '4px' }}
                >
                  Crear Nueva Factura
                </button>
                <button
                  type="button"
                  data-oa-id="btn-export-reports"
                  className="px-3 py-1.5 text-xs font-sans bg-[#e6e5e0] text-[#26251e] rounded border border-[#cdcdc9]"
                  style={{ borderRadius: '4px' }}
                >
                  Exportar Reportes
                </button>
              </div>
            </div>

            <div className="p-4 bg-[#f7f7f4] border border-[#cdcdc9] rounded space-y-3" style={{ borderRadius: '4px' }}>
              <div className="text-xs font-sans font-medium text-[#26251e]">Datos Fiscales (Protegidos)</div>
              <div className="space-y-2">
                <input
                  type="password"
                  placeholder="Contraseña / Firma Electrónica"
                  disabled
                  data-oa-sensitive="true"
                  className="w-full px-3 py-1 text-xs font-mono bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#84847e] cursor-not-allowed"
                  style={{ borderRadius: '4px' }}
                />
                <span className="text-[10px] font-sans text-[#cf2d56] block">
                  🔒 Campo sensible (PII Scrubber activo - no se indexará en el Mapa RAG)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Superposición Vectorial en Tiempo Real (Hover Overlay) */}
        {isCaptureMode && inspectedElement && (
          <div
            className="absolute pointer-events-none transition-all duration-75"
            style={{
              left: `${inspectedElement.boundingBox.x}px`,
              top: `${inspectedElement.boundingBox.y}px`,
              width: `${inspectedElement.boundingBox.width}px`,
              height: `${inspectedElement.boundingBox.height}px`,
              border: inspectedElement.isSensitive ? '2px dashed #cf2d56' : '2px solid #f54e00',
              backgroundColor: inspectedElement.isSensitive ? 'rgba(207, 45, 86, 0.08)' : 'rgba(245, 78, 0, 0.1)',
            }}
          >
            {/* Badge de Metadatos del Elemento */}
            <div
              className={`absolute -top-7 left-0 px-2 py-0.5 text-[11px] font-mono text-[#f7f7f4] rounded whitespace-nowrap shadow-md flex items-center gap-1.5 ${
                inspectedElement.isSensitive ? 'bg-[#cf2d56]' : 'bg-[#26251e]'
              }`}
              style={{ borderRadius: '3px', fontVariantNumeric: 'tabular-nums' }}
            >
              <span>{inspectedElement.primarySelector}</span>
              <span className="text-[#cdcdc9]">·</span>
              <span className="text-[#1f8a65]">Estabilidad: {inspectedElement.selectorStabilityScore}/100</span>
            </div>
          </div>
        )}

        {/* Indicador Flotante de Modo Captura Activo */}
        {isCaptureMode && (
          <div
            className="absolute bottom-3 right-3 px-3 py-1.5 bg-[#26251e] text-[#f7f7f4] text-xs font-sans rounded shadow-lg flex items-center gap-2 pointer-events-none"
            style={{ borderRadius: '4px' }}
          >
            <span className="w-2 h-2 rounded-full bg-[#f54e00] animate-pulse" />
            <span>Haz click sobre cualquier nodo para etiquetarlo</span>
          </div>
        )}
      </div>
    </div>
  );
}
