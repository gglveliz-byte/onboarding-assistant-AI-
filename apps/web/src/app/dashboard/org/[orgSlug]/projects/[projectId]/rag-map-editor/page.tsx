/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/rag-map-editor/page.tsx
 * @modulo 08-frontend-rag-editor (Página del Editor Dual del Mapa RAG con Partición 50/50 y SHA-256)
 * @proposito
 *   Ensambla la consola de edición dual del Mapa Funcional RAG: barra superior de sellado
 *   inmutable SHA-256, panel izquierdo (50%) con árbol de rutas y tarjetas editables,
 *   y panel derecho (50%) con editor de código JSON canónico RFC 8785 y numeración tabular.
 *
 * @resumen_contenido
 *   - Integración de `MapVersionHistoryAndShaBar` con sello `SHA-256 VERIFIED`.
 *   - Panel visual izquierdo 50%: `VisualMapTreeAndCardEditor`.
 *   - Panel de código derecho 50%: `CanonicalJsonCodeEditor`.
 *   - Sincronización bidireccional reactiva orquestada por `useFunctionalMapDualEditor`.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *   - `useFunctionalMapDualEditor` (apps/web/src/components/rag-editor/useFunctionalMapDualEditor.ts).
 *   - `MapVersionHistoryAndShaBar` (apps/web/src/components/rag-editor/MapVersionHistoryAndShaBar.tsx).
 *   - `VisualMapTreeAndCardEditor` (apps/web/src/components/rag-editor/VisualMapTreeAndCardEditor.tsx).
 *   - `CanonicalJsonCodeEditor` (apps/web/src/components/rag-editor/CanonicalJsonCodeEditor.tsx).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { DeveloperDashboardShell } from '@/components/dashboard-dev/DeveloperDashboardShell';
import { useFunctionalMapDualEditor } from '@/components/rag-editor/useFunctionalMapDualEditor';
import { MapVersionHistoryAndShaBar } from '@/components/rag-editor/MapVersionHistoryAndShaBar';
import { VisualMapTreeAndCardEditor } from '@/components/rag-editor/VisualMapTreeAndCardEditor';
import { CanonicalJsonCodeEditor } from '@/components/rag-editor/CanonicalJsonCodeEditor';

export default function RagMapEditorPage() {
  const params = useParams();
  const router = useRouter();
  const orgSlug = String(params?.['orgSlug'] ?? 'default-org');
  const projectId = String(params?.['projectId'] ?? 'proj_default_live');
  const [mobileTab, setMobileTab] = useState<'visual' | 'json'>('visual');

  const {
    elements,
    jsonCode,
    sha256Hash,
    syntaxError,
    isPublishing,
    publishError,
    publishedVersions,
    updateElementFromTree,
    removeElementFromTree,
    updateFromJsonCode,
    formatJson,
    publishMapVersion,
    rollbackToVersion,
  } = useFunctionalMapDualEditor(projectId);

  const handleReopenInTrainer = (_elementId: string, _route: string) => {
    router.push(`/dashboard/org/${orgSlug}/projects/${projectId}/visual-trainer`);
  };

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      projectId={projectId}
      environment="LIVE"
      userRole="DEVELOPER"
    >
      <div className="flex flex-col h-[calc(100vh-6rem)] -m-3 sm:-m-4 bg-[#f7f7f4] overflow-hidden">
        {/* Barra Superior con Digest SHA-256 e Historial */}
        <MapVersionHistoryAndShaBar
          currentSha256={sha256Hash}
          publishedVersions={publishedVersions}
          isPublishing={isPublishing}
          onPublish={publishMapVersion}
          onRollback={rollbackToVersion}
        />

        {/* Avisos honestos del editor: mapa vacío de partida y errores de publicación */}
        <div className="px-3 py-2 bg-[#f2f1ed] border-b border-[#cdcdc9] text-[11px] font-sans text-[#84847e] flex flex-col gap-1">
          <span>
            El editor arranca vacío: el backend todavía no expone la lectura del mapa publicado ni su
            historial de versiones, así que no se muestran elementos de ejemplo.
          </span>
          {publishError !== null && (
            <span className="text-[#cf2d56]">{publishError}</span>
          )}
        </div>

        {/* Conmutador de Pestañas Segmentadas en Móvil (< md) para evitar aplastar paneles */}
        <div className="md:hidden flex items-center p-2.5 bg-[#f2f1ed] border-b border-[#cdcdc9] shrink-0">
          <div className="flex w-full bg-[#e6e5e0] p-1 rounded" style={{ borderRadius: '4px' }}>
            <button
              type="button"
              onClick={() => setMobileTab('visual')}
              className={`flex-1 py-1.5 text-xs font-sans rounded transition-all cursor-pointer ${
                mobileTab === 'visual'
                  ? 'bg-[#f7f7f4] text-[#26251e] font-medium shadow-xs'
                  : 'text-[#84847e] hover:text-[#26251e]'
              }`}
              style={{ borderRadius: '3px' }}
            >
              Árbol Visual
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('json')}
              className={`flex-1 py-1.5 text-xs font-sans rounded transition-all cursor-pointer ${
                mobileTab === 'json'
                  ? 'bg-[#f7f7f4] text-[#26251e] font-medium shadow-xs'
                  : 'text-[#84847e] hover:text-[#26251e]'
              }`}
              style={{ borderRadius: '3px' }}
            >
              JSON RFC 8785
            </button>
          </div>
        </div>

        {/* Cuerpo Dual 50/50: Panel Visual (Izquierda) + Editor JSON (Derecha) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
          {/* Panel Izquierdo 50%: Árbol de Rutas y Tarjetas */}
          <div
            className={`w-full md:w-1/2 h-full min-w-0 overflow-hidden ${
              mobileTab === 'visual' ? 'block' : 'hidden md:block'
            }`}
          >
            <VisualMapTreeAndCardEditor
              elements={elements}
              onUpdateElement={updateElementFromTree}
              onRemoveElement={removeElementFromTree}
              onReopenInVisualTrainer={handleReopenInTrainer}
            />
          </div>

          {/* Panel Derecho 50%: Editor de Código JSON Canónico */}
          <div
            className={`w-full md:w-1/2 h-full min-w-0 overflow-hidden ${
              mobileTab === 'json' ? 'block' : 'hidden md:block'
            }`}
          >
            <CanonicalJsonCodeEditor
              jsonCode={jsonCode}
              syntaxError={syntaxError}
              onChangeJson={updateFromJsonCode}
              onFormatJson={formatJson}
            />
          </div>
        </div>
      </div>
    </DeveloperDashboardShell>
  );
}
