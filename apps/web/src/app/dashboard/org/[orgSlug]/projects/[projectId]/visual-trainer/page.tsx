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
  const rawProjectId = String(params?.['projectId'] ?? 'proj_default_live');
  const projectId = rawProjectId.replace(/\/+$/, '');

  const {
    state,
    inspectedElement,
    capturedElements,
    startSession,
    switchMode,
    sendPointerCoordinates,
    testSelector,
    saveTaggedElement,
    removeTaggedElement,
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

  const handleAddManualElement = () => {
    setActiveModalElement({
      tagName: 'button',
      primarySelector: '#btn-accion-principal',
      structuralCssSelector: 'button',
      xpathFallback: '//button',
      selectorStabilityScore: 100,
      boundingBox: { x: 50, y: 50, width: 140, height: 40 },
      isSensitive: false,
      textSnippet: 'Elemento Manual',
    });
  };

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      projectId={projectId}
      environment={environment}
      userRole={userRole}
    >
      <div className="flex flex-col h-full w-full bg-[#f7f7f4] overflow-hidden min-h-0">
        {/* Barra de Herramientas Superior Compactada */}
        <TrainerToolbarAndViewportSwitcher
          sessionState={state}
          currentViewport={currentViewport}
          autoRecalculateResponsive={autoRecalculate}
          capturedElementsCount={capturedElements.length}
          isElementsDrawerOpen={isElementsDrawerOpen}
          onToggleElementsDrawer={() => setIsElementsDrawerOpen((prev) => !prev)}
          onAddManualSelector={handleAddManualElement}
          onUrlChange={() => {}}
          onReload={(url: string) => startSession(url)}
          onModeChange={switchMode}
          onViewportChange={setCurrentViewport}
          onToggleAutoRecalculate={setAutoRecalculate}
        />

        {/* Errores de operación (si los hubiera) */}
        {operationError !== null && (
          <div
            className="px-3 py-1.5 bg-[#cf2d56]/10 border-b border-[#cf2d56]/30 text-[11px] font-sans text-[#cf2d56] shrink-0"
            role="alert"
          >
            {operationError}
          </div>
        )}

        {/* Lienzo Principal a Pantalla Completa + Drawer Deslizable */}
        <div className="flex-1 flex overflow-hidden relative min-h-0 w-full h-full">
          {/* Lienzo Interactivo con Overlay y Web Real */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#ffffff] overflow-hidden relative min-h-0 h-full w-full">
            <InteractiveDomOverlayCanvas
              sessionState={state}
              viewport={currentViewport}
              inspectedElement={inspectedElement}
              onPointerMove={sendPointerCoordinates}
              onSelectElement={handleSelectElement}
            />
          </div>

          {/* Backdrop oscurecido para el Drawer de Elementos */}
          {isElementsDrawerOpen && (
            <div
              className="fixed inset-0 bg-[#26251e]/30 z-40 transition-opacity backdrop-blur-[1px]"
              onClick={() => setIsElementsDrawerOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* Drawer Deslizable de Elementos Registrados (Overlay sin robar ancho al lienzo) */}
          <aside
            className={`
              fixed inset-y-0 right-0 z-50
              w-80 sm:w-96 max-w-[90vw] border-l border-[#cdcdc9] bg-[#f2f1ed]
              flex flex-col justify-between select-none shadow-2xl
              transition-transform duration-200 ease-in-out shrink-0 h-full min-h-0 overflow-hidden
              ${isElementsDrawerOpen ? 'translate-x-0' : 'translate-x-full'}
            `}
          >
            <div className="p-3.5 border-b border-[#cdcdc9] space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e] font-semibold">
                    Elementos Registrados ({capturedElements.length})
                  </h2>
                  <p className="text-[11px] text-[#34785c] font-sans mt-0.5">
                    ● Sesión Activa
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsElementsDrawerOpen(false)}
                  className="p-1 text-[#84847e] hover:text-[#26251e] rounded text-xs cursor-pointer border border-transparent hover:border-[#cdcdc9]"
                  aria-label="Cerrar panel de elementos"
                >
                  ✕ Cerrar
                </button>
              </div>

              {/* Botón para añadir elemento directamente por selector */}
              <button
                type="button"
                onClick={handleAddManualElement}
                className="w-full py-1.5 px-2.5 text-xs font-sans bg-[#ffffff] hover:bg-[#eae8e3] text-[#26251e] rounded border border-[#cdcdc9] flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                style={{ borderRadius: '4px' }}
              >
                <span>➕</span>
                <span>Añadir Selector Manualmente</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {capturedElements.length === 0 ? (
                <div className="text-center py-8 px-4 text-[#84847e] text-xs font-sans space-y-2">
                  <div className="text-2xl">🎯</div>
                  <p className="text-[#26251e] font-medium">Aún no hay elementos registrados</p>
                  <p className="text-[11px] text-[#7a7974] leading-relaxed">
                    Activa el <strong>Modo Captura</strong> y haz clic sobre los botones de tu web, o pulsa el botón de arriba para registrar un selector directamente.
                  </p>
                </div>
              ) : (
                capturedElements.map((el: TaggedElementPayload, idx: number) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#f7f7f4] border border-[#cdcdc9] rounded space-y-1.5 shadow-xs relative group"
                    style={{ borderRadius: '4px' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-sans font-medium text-[#26251e] truncate max-w-[170px]">
                        {el.title}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="px-1.5 py-0.2 text-[10px] font-mono bg-[#34785c]/10 text-[#34785c] rounded"
                          style={{ borderRadius: '2px' }}
                        >
                          {el.actionType}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeTaggedElement(idx)}
                          title="Eliminar elemento"
                          className="text-[#84847e] hover:text-[#cf2d56] text-xs px-1 cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="text-[11px] font-mono text-[#84847e] truncate" title={el.primarySelector}>
                      {el.primarySelector}
                    </div>
                    <div className="text-[10px] font-mono text-[#7a7974]">
                      {el.functionalDescription}
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
