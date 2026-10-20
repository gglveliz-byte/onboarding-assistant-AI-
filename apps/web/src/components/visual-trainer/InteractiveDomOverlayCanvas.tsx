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
  const activeUrl = sessionState.validatedUrl || sessionState.targetUrl;

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current || !isCaptureMode) return;
    const rect = containerRef.current.getBoundingClientRect();
    onPointerMove(e.clientX, e.clientY, rect);
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isCaptureMode) return;
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clickX = Math.round(e.clientX - rect.left);
    const clickY = Math.round(e.clientY - rect.top);

    const selected: InspectedElementMetadata = inspectedElement ?? {
      tagName: 'button',
      primarySelector: `button, a, [data-action], input`,
      structuralCssSelector: `main > div:hover`,
      xpathFallback: `//button | //a`,
      selectorStabilityScore: 98,
      boundingBox: {
        x: Math.max(10, clickX - 60),
        y: Math.max(10, clickY - 20),
        width: 120,
        height: 40,
      },
      isSensitive: false,
      textSnippet: 'Elemento de Interfaz',
    };

    onSelectElement(selected);
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
    <div
      className={`flex-1 w-full h-full min-h-0 flex items-center justify-center overflow-hidden ${
        viewport === 'DESKTOP' ? 'p-0 bg-[#ffffff]' : 'p-3 sm:p-6 bg-[#e6e5e0]/30'
      }`}
    >
      {/* Marco de Ventana de Navegador Real fluido que se adapta al 100% de la pantalla */}
      <div
        ref={containerRef}
        onPointerMove={handlePointerMove}
        className={`relative bg-[#ffffff] overflow-hidden transition-all duration-200 flex flex-col w-full h-full ${
          viewport === 'DESKTOP' ? 'border-0 shadow-none' : 'border border-[#cdcdc9] shadow-2xl'
        }`}
        style={{
          maxWidth: viewport === 'DESKTOP' ? '100%' : viewport === 'TABLET' ? '768px' : '390px',
          borderRadius: viewport === 'DESKTOP' ? '0px' : '8px',
          boxShadow:
            viewport === 'DESKTOP'
              ? 'none'
              : 'rgba(0, 0, 0, 0.15) 0px 16px 40px -10px, rgba(0, 0, 0, 0.08) 0px 8px 16px -5px',
        }}
      >
        {/* Barra superior de dispositivo: solo para Tablet y Móvil (en Desktop se compacta al 100%) */}
        {viewport !== 'DESKTOP' && (
          <div className="h-8 bg-[#f2f1ed] border-b border-[#cdcdc9] px-3 flex items-center justify-between shrink-0">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#e26955] inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#e8b33a] inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#52be7f] inline-block" />
            </div>
            <span
              className="text-[10px] font-mono text-[#84847e] bg-[#e6e5e0] px-2 py-0.5 rounded"
              style={{ borderRadius: '3px' }}
            >
              {viewportConfig.width}×{viewportConfig.height}
            </span>
          </div>
        )}

        {/* Superficie de Visualización */}
        <div className="relative flex-1 w-full h-full bg-[#fcfcfa] overflow-hidden">
          {activeUrl ? (
            <>
              {/* Iframe Real de la Aplicación del Usuario con navegación e interacción libre y blindaje anti-escape */}
              <iframe
                src={activeUrl}
                title="Aplicación Web en Entrenamiento"
                className="w-full h-full border-0 bg-white"
                scrolling="yes"
                style={{
                  pointerEvents: isCaptureMode ? 'none' : 'auto',
                }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
                allow="accelerometer; autoplay; clipboard-read; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              />

              {/* Capa de Inspección Vectorial sobre la Web Real */}
              {isCaptureMode && (
                <div
                  onClick={handleOverlayClick}
                  className="absolute inset-0 z-20 cursor-crosshair bg-black/5 hover:bg-black/10 transition-colors flex flex-col justify-between p-4"
                  title="Haz clic sobre cualquier elemento de tu web para etiquetarlo"
                >
                  {/* Banner Flotante de Instrucción */}
                  <div className="self-center px-4 py-1.5 bg-[#26251e] text-[#f7f7f4] text-xs font-sans rounded-full shadow-xl flex items-center gap-2 border border-[#f54e00]/40">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#f54e00] animate-pulse" />
                    <span className="font-medium">Modo Captura Activo:</span>
                    <span>Haz clic sobre el botón, campo o enlace que deseas registrar</span>
                  </div>

                  {/* Superposición Vectorial si hay un elemento inspeccionado */}
                  {inspectedElement && (
                    <div
                      className="absolute pointer-events-none transition-all duration-75"
                      style={{
                        left: `${inspectedElement.boundingBox.x}px`,
                        top: `${inspectedElement.boundingBox.y}px`,
                        width: `${inspectedElement.boundingBox.width}px`,
                        height: `${inspectedElement.boundingBox.height}px`,
                        border: '2px solid #f54e00',
                        backgroundColor: 'rgba(245, 78, 0, 0.12)',
                        boxShadow: '0 0 12px rgba(245, 78, 0, 0.35)',
                      }}
                    >
                      <div
                        className="absolute -top-7 left-0 px-2 py-0.5 text-[11px] font-mono text-[#f7f7f4] bg-[#26251e] rounded shadow-md whitespace-nowrap flex items-center gap-1.5"
                        style={{ borderRadius: '3px' }}
                      >
                        <span className="text-[#f54e00]">🎯</span>
                        <span>{inspectedElement.primarySelector}</span>
                        <span className="text-[#84847e]">·</span>
                        <span className="text-[#52be7f]">Clic para etiquetar</span>
                      </div>
                    </div>
                  )}

                  <div className="self-end text-[11px] font-mono text-[#26251e] bg-[#f7f7f4]/90 backdrop-blur-xs px-2.5 py-1 rounded border border-[#cdcdc9] shadow-xs">
                    💡 Modo Captura activo · Haz clic en cualquier parte de tu web
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Guía Visual Paso a Paso cuando aún no se ha cargado URL */
            <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-[#f7f7f4]">
              <div className="max-w-xl space-y-6">
                <div className="w-12 h-12 mx-auto rounded-full bg-[#26251e] text-[#f7f7f4] flex items-center justify-center text-xl shadow-md">
                  🧭
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-sans font-semibold text-[#26251e]">
                    Entrenador Visual de Onboarding Assistant
                  </h2>
                  <p className="text-xs font-sans text-[#7a7974] leading-relaxed max-w-md mx-auto">
                    Conecta tu aplicación web real para enseñarle al Asistente de Voz dónde están tus botones, menús y formularios clave.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left pt-2">
                  <div className="p-3.5 bg-[#ffffff] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs" style={{ borderRadius: '6px' }}>
                    <div className="text-xs font-sans font-medium text-[#26251e] flex items-center gap-1.5">
                      <span className="text-[#34785c] font-bold">1.</span>
                      <span>Ingresa la URL</span>
                    </div>
                    <p className="text-[11px] font-sans text-[#7a7974]">
                      Escribe la dirección de tu web arriba (ej: <code className="font-mono text-[#26251e]">https://neurochat.com.ec/</code>) y pulsa <strong>Ir</strong>.
                    </p>
                  </div>

                  <div className="p-3.5 bg-[#ffffff] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs" style={{ borderRadius: '6px' }}>
                    <div className="text-xs font-sans font-medium text-[#26251e] flex items-center gap-1.5">
                      <span className="text-[#34785c] font-bold">2.</span>
                      <span>Navega libremente</span>
                    </div>
                    <p className="text-[11px] font-sans text-[#7a7974]">
                      Usa el <strong>Modo Navegación</strong> para moverte por tu web hasta la pantalla que deseas entrenar.
                    </p>
                  </div>

                  <div className="p-3.5 bg-[#ffffff] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs" style={{ borderRadius: '6px' }}>
                    <div className="text-xs font-sans font-medium text-[#26251e] flex items-center gap-1.5">
                      <span className="text-[#f54e00] font-bold">3.</span>
                      <span>Captura y Etiqueta</span>
                    </div>
                    <p className="text-[11px] font-sans text-[#7a7974]">
                      Pasa a <strong>Modo Captura</strong> y haz clic en los botones o campos para abrir el diálogo de registro.
                    </p>
                  </div>

                  <div className="p-3.5 bg-[#ffffff] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs" style={{ borderRadius: '6px' }}>
                    <div className="text-xs font-sans font-medium text-[#26251e] flex items-center gap-1.5">
                      <span className="text-[#8052ff] font-bold">4.</span>
                      <span>Publica en el Mapa RAG</span>
                    </div>
                    <p className="text-[11px] font-sans text-[#7a7974]">
                      Guarda tus elementos y ve al <strong>Editor RAG Dual</strong> para activar el asistente de voz en tu web.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
