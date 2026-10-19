/**
 * @archivo apps/web/src/components/rag-editor/VisualMapTreeAndCardEditor.tsx
 * @modulo 08-frontend-rag-editor (Panel Izquierdo: Editor Visual de Tarjetas y Árbol de Rutas RAG)
 * @proposito
 *   Renderiza el 50% izquierdo del editor dual. Agrupa los elementos DOM por su ruta URL
 *   (`urlRoutePattern`), ofrece edición visual de títulos, descripciones funcionales y
 *   acciones interactivas, y provee el enlace de retorno para re-inspeccionar cualquier nodo
 *   directamente dentro del Visor de Entrenamiento Remoto.
 *
 * @resumen_contenido
 *   - Agrupación dinámica por patrón de ruta SPA (`/dashboard`, `/invoices/*`).
 *   - Tarjetas editables en `#f2f1ed` con radios de `4px` y borde de `1px solid #cdcdc9`.
 *   - Selectores de tipo de acción (`CLICK`, `TYPE`, `BOTH`, `NONE`).
 *   - Botón `btn_reopen_in_visual_trainer` para abrir el elemento en el navegador remoto.
 *   - Conteo de elementos y métricas de coordenadas responsive.
 *
 * @dependencias_internas
 *   - `FunctionalMapElement` (./useFunctionalMapDualEditor.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements`.
 */

'use client';

import React, { useState } from 'react';
import type { FunctionalMapElement } from './useFunctionalMapDualEditor';

export interface VisualMapTreeAndCardEditorProps {
  readonly elements: readonly FunctionalMapElement[];
  readonly onUpdateElement: (element: FunctionalMapElement) => void;
  readonly onRemoveElement: (elementId: string) => void;
  readonly onReopenInVisualTrainer?: (elementId: string, urlRoutePattern: string) => void;
}

export function VisualMapTreeAndCardEditor({
  elements,
  onUpdateElement,
  onRemoveElement,
  onReopenInVisualTrainer,
}: VisualMapTreeAndCardEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  // Agrupar elementos por urlRoutePattern
  const groupedByRoute = elements.reduce<Record<string, FunctionalMapElement[]>>((acc, el) => {
    const route = el.urlRoutePattern || '/';
    if (!acc[route]) {
      acc[route] = [];
    }
    acc[route]!.push(el);
    return acc;
  }, {});

  const routes = Object.keys(groupedByRoute).sort();

  return (
    <div
      className="h-full flex flex-col bg-[#f7f7f4] border-r border-[#cdcdc9] overflow-hidden select-none"
      data-testid="visual-map-tree-and-card-editor"
    >
      {/* Cabecera del Panel Izquierdo */}
      <div className="p-4 bg-[#f2f1ed] border-b border-[#cdcdc9] flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
            Estructura Visual del Mapa RAG
          </h2>
          <p className="text-[11px] text-[#26251e] font-sans mt-0.5">
            {elements.length} nodos interactivos organizados en {routes.length} ruta(s)
          </p>
        </div>
        <span className="hidden md:inline text-xs font-mono text-[#84847e] bg-[#e6e5e0] px-2 py-0.5 rounded" style={{ borderRadius: '3px' }}>
          50% Vista Visual
        </span>
      </div>

      {/* Contenedor con Scroll de Rutas y Tarjetas */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {routes.length === 0 ? (
          <div className="text-center py-16 text-[#84847e] text-xs font-sans">
            No hay elementos registrados en el mapa. Agrega elementos desde el Visor Trainer o escribe en el editor JSON.
          </div>
        ) : (
          routes.map((route) => {
            const routeElements = groupedByRoute[route] ?? [];
            return (
              <div key={route} className="space-y-3">
                {/* Cabecera de Ruta SPA */}
                <div className="flex items-center gap-2 text-xs font-mono text-[#26251e] border-b border-[#cdcdc9]/70 pb-1.5">
                  <span className="text-[#34785c]">🌐 Ruta:</span>
                  <span className="font-semibold">{route}</span>
                  <span className="text-[#84847e] text-[10px]">({routeElements.length} elementos)</span>
                </div>

                {/* Tarjetas de Elementos de esta Ruta */}
                <div className="space-y-2.5">
                  {routeElements.map((el) => {
                    const isEditing = editingId === el.id;

                    return (
                      <div
                        key={el.id}
                        className="bg-[#f2f1ed] border border-[#cdcdc9] rounded p-3.5 space-y-2 shadow-xs transition-colors hover:border-[#84847e]"
                        style={{ borderRadius: '4px' }}
                      >
                        {/* Fila Superior: Título, ID y Acciones */}
                        <div className="flex items-center justify-between gap-2">
                          {isEditing ? (
                            <input
                              type="text"
                              value={el.title}
                              onChange={(e) => onUpdateElement({ ...el, title: e.target.value })}
                              className="px-2 py-1 text-xs font-sans font-medium bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] flex-1"
                              style={{ borderRadius: '3px' }}
                            />
                          ) : (
                            <span className="text-xs font-sans font-medium text-[#26251e] truncate">
                              {el.title}
                            </span>
                          )}

                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                                el.actionType === 'CLICK'
                                  ? 'bg-[#34785c]/10 text-[#34785c]'
                                  : el.actionType === 'TYPE'
                                  ? 'bg-[#c08532]/10 text-[#c08532]'
                                  : el.actionType === 'BOTH'
                                  ? 'bg-[#f54e00]/10 text-[#f54e00]'
                                  : 'bg-[#84847e]/10 text-[#84847e]'
                              }`}
                              style={{ borderRadius: '3px' }}
                            >
                              {el.actionType}
                            </span>
                            <button
                              type="button"
                              onClick={() => setEditingId(isEditing ? null : el.id)}
                              className="px-2 py-0.5 text-[10px] font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded transition-colors"
                              style={{ borderRadius: '3px' }}
                            >
                              {isEditing ? 'Listo' : 'Editar'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (confirm(`¿Eliminar ${el.title} del mapa RAG?`)) {
                                  onRemoveElement(el.id);
                                }
                              }}
                              className="px-1.5 py-0.5 text-[10px] font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 rounded"
                              title="Eliminar elemento"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* Descripción Funcional Semántica */}
                        {isEditing ? (
                          <textarea
                            rows={2}
                            value={el.functionalDescription}
                            onChange={(e) => onUpdateElement({ ...el, functionalDescription: e.target.value })}
                            className="w-full px-2 py-1 text-xs font-sans bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] leading-relaxed"
                            style={{ borderRadius: '3px' }}
                          />
                        ) : (
                          <p className="text-xs font-sans text-[#84847e] leading-relaxed line-clamp-2">
                            {el.functionalDescription}
                          </p>
                        )}

                        {/* Selector Principal y Coordenadas */}
                        <div className="pt-1 border-t border-[#cdcdc9]/60 flex flex-wrap items-center justify-between text-[11px] font-mono text-[#84847e] gap-2">
                          <span className="truncate max-w-[220px]" title={el.primarySelector}>
                            {el.primarySelector}
                          </span>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {el.desktopBbox.width}×{el.desktopBbox.height}px
                          </span>
                        </div>

                        {/* Botón Reabrir en Visor Trainer */}
                        {onReopenInVisualTrainer && (
                          <div className="pt-1 flex justify-end">
                            <button
                              type="button"
                              onClick={() => onReopenInVisualTrainer(el.id, route)}
                              className="text-[10px] font-sans text-[#f54e00] hover:underline flex items-center gap-1"
                              data-testid={`btn_reopen_in_visual_trainer_${el.id}`}
                            >
                              <span>Re-inspeccionar en Visor Trainer</span>
                              <span>↗</span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
