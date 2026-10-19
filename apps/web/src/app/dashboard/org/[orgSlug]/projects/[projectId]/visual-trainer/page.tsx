/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/visual-trainer/page.tsx
 * @modulo 08-frontend-visual-trainer (Página del Espacio de Trabajo del Entrenador Visual Remoto)
 * @proposito
 *   Ensambla la consola completa de entrenamiento visual remoto: barra de herramientas,
 *   conmutador de resoluciones responsive, lienzo de inspección vectorial sobre stream Chromium,
 *   panel lateral de elementos capturados con coordenadas y modal flotante de etiquetado semántico.
 *
 * @resumen_contenido
 *   - Integración de `TrainerToolbarAndViewportSwitcher` e `InteractiveDomOverlayCanvas`.
 *   - Panel lateral con la lista acumulada de elementos DOM etiquetados en la sesión.
 *   - Modal interactivo `ElementTaggingModal` disparado al seleccionar nodos en modo captura.
 *   - Enlace directo hacia la publicación y canonización en el Editor RAG Dual.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *   - `useRemoteTrainerSession` (apps/web/src/components/visual-trainer/useRemoteTrainerSession.ts).
 *   - `TrainerToolbarAndViewportSwitcher` (apps/web/src/components/visual-trainer/TrainerToolbarAndViewportSwitcher.tsx).
 *   - `InteractiveDomOverlayCanvas` (apps/web/src/components/visual-trainer/InteractiveDomOverlayCanvas.tsx).
 *   - `ElementTaggingModal` (apps/web/src/components/visual-trainer/ElementTaggingModal.tsx).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions`, `map_elements`.
 */

'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { DeveloperDashboardShell } from '@/components/dashboard-dev/DeveloperDashboardShell';
import {
  useRemoteTrainerSession,
  type InspectedElementMetadata,
  type TaggedElementPayload,
} from '@/components/visual-trainer/useRemoteTrainerSession';
import { useDashboardSessionFacts } from '@/components/dashboard-dev/useDashboardWorkspace';
import { useResolvedProjectId } from '@/components/dashboard-dev/useProjectsAndApiKeys';
import {
  TrainerToolbarAndViewportSwitcher,
  type ViewportPreset,
} from '@/components/visual-trainer/TrainerToolbarAndViewportSwitcher';
import { InteractiveDomOverlayCanvas } from '@/components/visual-trainer/InteractiveDomOverlayCanvas';
import { ElementTaggingModal } from '@/components/visual-trainer/ElementTaggingModal';

export default function VisualTrainerPage() {
  const params = useParams();
  const router = useRouter();
  const orgSlug = String(params?.['orgSlug'] ?? 'default-org');
  const projectId = String(params?.['projectId'] ?? 'proj_default_live');

  const {
    state,
    inspectedElement,
    capturedElements,
    startSession,
    switchMode,
    sendPointerCoordinates,
    testSelector,
    saveTaggedElement,
    endSession,
    operationError,
  } = useRemoteTrainerSession(projectId);

  const [currentViewport, setCurrentViewport] = useState<ViewportPreset>('DESKTOP');
  const [autoRecalculate, setAutoRecalculate] = useState<boolean>(true);

  // Rol y entorno REALES: el rol viene del token de la sesión y el entorno del proyecto.
  const session = useDashboardSessionFacts();
  const userRole = session.role ?? 'DEVELOPER';
  const { projects } = useResolvedProjectId(projectId);
  const environment = projects.find((project) => project.id === projectId || project.slug === projectId)?.environment ?? 'LIVE';
  const [activeModalElement, setActiveModalElement] = useState<InspectedElementMetadata | null>(null);
  const [isElementsDrawerOpen, setIsElementsDrawerOpen] = useState<boolean>(false);

  const handleSelectElement = (element: InspectedElementMetadata) => {
    setActiveModalElement(element);
  };

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      projectId={projectId}
      environment={environment}
      userRole={userRole}
    >
      <div className="flex flex-col h-[calc(100vh-6rem)] -m-3 sm:-m-4 bg-[#f7f7f4]">
        {/* Barra de Herramientas Superior */}
        <TrainerToolbarAndViewportSwitcher
          sessionState={state}
          currentViewport={currentViewport}
          autoRecalculateResponsive={autoRecalculate}
          onUrlChange={() => {}}
          onReload={(url: string) => startSession(url)}
          onModeChange={switchMode}
          onViewportChange={setCurrentViewport}
          onToggleAutoRecalculate={setAutoRecalculate}
          onEndSession={endSession}
        />

        {/* Aviso explícito: el lienzo del visor es una simulación local */}
        {state.simulationMessage !== null ? (
          <div
            className="px-3 py-2 bg-[#c08532]/10 border border-[#c08532]/40 text-[12px] font-sans text-[#7a5a1f]"
            style={{ borderRadius: '4px' }}
            role="status"
            data-testid="trainer-simulation-notice"
          >
            {state.simulationMessage}
          </div>
        ) : (
          <div
            className="px-3 py-2 bg-[#f2f1ed] border border-[#cdcdc9] text-[11px] font-sans text-[#84847e]"
            style={{ borderRadius: '4px' }}
            role="note"
            data-testid="trainer-simulation-hint"
          >
            El backend todavía no expone la sesión de entrenamiento remoto
            (<span className="font-mono">POST /api/v1/projects/:id/training-sessions</span>): el lienzo y las
            inspecciones son sintéticas y no hay un Chromium remoto conectado.
          </div>
        )}

        {/* Errores de operación (guardado de elementos, cierre de sesión) */}
        {operationError !== null && (
          <div
            className="px-3 py-2 bg-[#cf2d56]/10 border border-[#cf2d56]/40 text-[12px] font-sans text-[#cf2d56]"
            style={{ borderRadius: '4px' }}
            role="alert"
            data-testid="trainer-operation-error"
          >
            {operationError}
          </div>
        )}

        {/* Cuerpo Principal Dividido: Lienzo de Stream + Panel de Elementos Retráctil */}
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
          {/* 1. Lienzo Interactivo con Overlay (evita colapsar a 0px en < 1024px) */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#e6e5e0]/20 overflow-auto relative">
            <InteractiveDomOverlayCanvas
              sessionState={state}
              viewport={currentViewport}
              inspectedElement={inspectedElement}
              onPointerMove={sendPointerCoordinates}
              onSelectElement={handleSelectElement}
            />

            {/* Botón flotante para abrir Drawer de Elementos en pantallas < lg */}
            <button
              type="button"
              onClick={() => setIsElementsDrawerOpen(true)}
              aria-label="Abrir panel de elementos etiquetados"
              className="lg:hidden absolute bottom-4 right-4 z-20 px-3 py-2 bg-[#26251e] text-[#f7f7f4] text-xs font-sans rounded shadow-lg flex items-center gap-2 border border-[#cdcdc9] cursor-pointer"
              style={{ borderRadius: '4px' }}
            >
              <span>Elementos ({capturedElements.length})</span>
              <span className="w-2 h-2 rounded-full bg-[#1f8a65]" />
            </button>
          </div>

          {/* Backdrop para Drawer Retráctil en < lg */}
          {isElementsDrawerOpen && (
            <div
              className="lg:hidden fixed inset-0 bg-black/40 z-30 transition-opacity"
              onClick={() => setIsElementsDrawerOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* 2. Barra Lateral / Drawer Retráctil de Elementos Capturados (w-80) */}
          <aside
            className={`
              fixed lg:static inset-y-0 right-0 z-40 lg:z-auto
              w-80 max-w-[85vw] border-l border-[#cdcdc9] bg-[#f2f1ed]
              flex flex-col justify-between select-none shadow-2xl lg:shadow-none
              transition-transform duration-200 ease-in-out shrink-0
              ${isElementsDrawerOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
            `}
          >
            <div className="p-4 border-b border-[#cdcdc9] flex items-center justify-between">
              <div>
                <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
                  Elementos Etiquetados ({capturedElements.length})
                </h2>
                <p className="text-[11px] text-[#84847e] font-sans mt-0.5">
                  {state.simulationMode
                    ? 'Sesión simulada (sin navegador remoto)'
                    : 'Sesión Activa de Entrenamiento'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${state.simulationMode ? 'bg-[#c08532]' : 'bg-[#1f8a65]'}`}
                  title={state.simulationMode
                    ? 'Sin Chromium remoto conectado: el lienzo es una simulación local'
                    : 'Contenedor Chromium en línea'}
                />
                <button
                  type="button"
                  onClick={() => setIsElementsDrawerOpen(false)}
                  className="lg:hidden p-1 text-[#84847e] hover:text-[#26251e] rounded text-xs cursor-pointer"
                  aria-label="Cerrar panel de elementos"
                >
                  ✕ Cerrar
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {capturedElements.length === 0 ? (
                <div className="text-center py-10 px-4 text-[#84847e] text-xs font-sans">
                  Activa el <span className="font-medium text-[#26251e]">Modo Captura</span> y haz click en un botón o input para etiquetarlo.
                </div>
              ) : (
                capturedElements.map((el: TaggedElementPayload, idx: number) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#f7f7f4] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs"
                    style={{ borderRadius: '4px' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-sans font-medium text-[#26251e] truncate max-w-[170px]">
                        {el.title}
                      </span>
                      <span
                        className="px-1.5 py-0.2 text-[10px] font-mono bg-[#34785c]/10 text-[#34785c] rounded"
                        style={{ borderRadius: '2px' }}
                      >
                        {el.actionType}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-[#84847e] truncate" title={el.primarySelector}>
                      {el.primarySelector}
                    </div>
                    <div className="text-[10px] font-mono text-[#7a7974]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      Bbox: {el.desktopBbox.width}×{el.desktopBbox.height}px
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Pie de Panel con Acceso al Editor RAG */}
            <div className="p-3 border-t border-[#cdcdc9] bg-[#e6e5e0]/30 space-y-2">
              <Link
                href={`/dashboard/org/${orgSlug}/projects/${projectId}/rag-map-editor`}
                className="w-full block text-center py-2 px-3 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] rounded transition-colors shadow-xs"
                style={{ borderRadius: '4px' }}
              >
                Abrir en Editor RAG Dual →
              </Link>
            </div>
          </aside>
        </div>

        {/* Modal Flotante de Etiquetado */}
        {activeModalElement && (
          <ElementTaggingModal
            inspectedElement={activeModalElement}
            onSave={(payload: TaggedElementPayload) => {
              // El guardado puede fallar (sin sesión remota real): el modal se cierra solo si
              // el backend aceptó el elemento.
              void saveTaggedElement(payload)
                .then(() => setActiveModalElement(null))
                .catch(() => undefined);
            }}
            onClose={() => setActiveModalElement(null)}
            onTestHighlight={testSelector}
          />
        )}
      </div>
    </DeveloperDashboardShell>
  );
}
