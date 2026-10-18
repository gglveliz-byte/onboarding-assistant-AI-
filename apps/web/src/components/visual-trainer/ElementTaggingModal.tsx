/**
 * @archivo apps/web/src/components/visual-trainer/ElementTaggingModal.tsx
 * @modulo 08-frontend-visual-trainer (Modal Flotante de Etiquetado DOM Semántico para RAG)
 * @proposito
 *   Despliega el diálogo modal flotante de radio 8px al seleccionar un elemento en el
 *   visor interactivo. Contiene los 4 campos semánticos oficiales requeridos para el
 *   entrenamiento del Asistente (Título, Descripción Funcional, Acción Sí/No, Tipo de Acción),
 *   junto con la previsualización de selectores estables y coordenadas multi-viewport.
 *
 * @resumen_contenido
 *   - Campo 1 `input_element_title`: Título semántico legible para el usuario.
 *   - Campo 2 `textarea_functional_description`: Descripción contextual para el Context Slimming.
 *   - Campo 3 `radio_is_actionable`: Conmutador segmentado de interacción permitida.
 *   - Campo 4 `select_action_type`: Desplegable condicional (CLICK / TYPE / BOTH).
 *   - Sub-panel técnico con cascada de selectores y coordenadas responsive en berkeleyMono.
 *   - Botón de confirmación estructural en verde bosque (#34785c Forest).
 *
 * @dependencias_internas
 *   - `InspectedElementMetadata`, `TaggedElementPayload` (./useRemoteTrainerSession.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements`.
 */

'use client';

import React, { useState } from 'react';
import type { InspectedElementMetadata, TaggedElementPayload } from './useRemoteTrainerSession';

export interface ElementTaggingModalProps {
  readonly inspectedElement: InspectedElementMetadata;
  readonly urlRoutePattern?: string;
  readonly onSave: (payload: TaggedElementPayload) => void;
  readonly onClose: () => void;
  readonly onTestHighlight?: (selector: string) => Promise<boolean>;
}

export function ElementTaggingModal({
  inspectedElement,
  urlRoutePattern = '/dashboard',
  onSave,
  onClose,
  onTestHighlight,
}: ElementTaggingModalProps) {
  const [title, setTitle] = useState(
    inspectedElement.textSnippet ? inspectedElement.textSnippet.trim() : 'Botón Acción'
  );
  const [description, setDescription] = useState(
    `Permite al usuario interactuar con el elemento ${inspectedElement.tagName} para completar el flujo.`
  );
  const [isActionable, setIsActionable] = useState<boolean>(true);
  const [actionType, setActionType] = useState<'CLICK' | 'TYPE' | 'BOTH'>('CLICK');
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleTestSelector = async () => {
    if (onTestHighlight) {
      const ok = await onTestHighlight(inspectedElement.primarySelector);
      setTestResult(ok ? '✓ Selector probado con éxito' : '✕ Error al probar selector');
      setTimeout(() => setTestResult(null), 3000);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const payload: TaggedElementPayload = {
      title: title.trim(),
      functionalDescription: description.trim(),
      isActionable,
      actionType: isActionable ? actionType : 'NONE',
      primarySelector: inspectedElement.primarySelector,
      ...(inspectedElement.accessibilitySelector ? { accessibilitySelector: inspectedElement.accessibilitySelector } : {}),
      structuralCssSelector: inspectedElement.structuralCssSelector,
      xpathFallback: inspectedElement.xpathFallback,
      urlRoutePattern,
      desktopBbox: inspectedElement.boundingBox,
      tabletBbox: {
        x: Math.round(inspectedElement.boundingBox.x * 0.8),
        y: Math.round(inspectedElement.boundingBox.y * 0.9),
        width: Math.round(inspectedElement.boundingBox.width * 0.9),
        height: inspectedElement.boundingBox.height,
      },
      mobileBbox: {
        x: Math.round(inspectedElement.boundingBox.x * 0.5),
        y: Math.round(inspectedElement.boundingBox.y * 1.1),
        width: Math.round(inspectedElement.boundingBox.width * 0.8),
        height: inspectedElement.boundingBox.height,
      },
    };

    onSave(payload);
  };

  return (
    <div className="fixed inset-0 bg-[#26251e]/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <div
        className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-xl w-full p-6 space-y-5 shadow-2xl overflow-y-auto max-h-[90vh]"
        style={{
          borderRadius: '8px',
          boxShadow: 'rgba(0, 0, 0, 0.16) 0px 24px 60px 0px, rgba(0, 0, 0, 0.08) 0px 8px 24px 0px',
        }}
        data-testid="element-tagging-modal"
      >
        {/* Cabecera del Modal */}
        <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#f54e00]" />
            <h2 className="text-sm font-sans font-medium text-[#26251e]">
              Etiquetar Elemento para Mapa RAG
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#84847e] hover:text-[#26251e] text-xs font-mono p-1"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="space-y-4 text-xs font-sans">
          {/* Campo 1: Título del Elemento */}
          <div className="space-y-1">
            <label className="block text-[11px] font-sans text-[#84847e] uppercase tracking-wider">
              1. Título del Elemento
            </label>
            <input
              type="text"
              id="input_element_title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="ej. Botón Crear Factura"
              className="w-full px-3 py-1.5 bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none focus:border-[#26251e]"
              style={{ borderRadius: '4px' }}
            />
          </div>

          {/* Campo 2: Descripción Funcional Semántica */}
          <div className="space-y-1">
            <label className="block text-[11px] font-sans text-[#84847e] uppercase tracking-wider">
              2. Descripción Funcional para el Asistente RAG
            </label>
            <textarea
              id="textarea_functional_description"
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe qué hace este elemento en la pantalla y qué debe guiar el asistente vocal..."
              className="w-full px-3 py-1.5 bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none focus:border-[#26251e] leading-relaxed"
              style={{ borderRadius: '4px' }}
            />
          </div>

          {/* Campo 3: Conmutador ¿Hacer Acción? */}
          <div className="space-y-1">
            <label className="block text-[11px] font-sans text-[#84847e] uppercase tracking-wider">
              3. ¿El Asistente Debe Ejecutar Acción Directa?
            </label>
            <div className="flex gap-2" id="radio_is_actionable">
              <button
                type="button"
                onClick={() => setIsActionable(true)}
                className={`flex-1 py-1.5 text-xs font-sans rounded border text-center transition-colors ${
                  isActionable
                    ? 'bg-[#26251e] text-[#f7f7f4] border-[#26251e] font-medium'
                    : 'bg-[#f2f1ed] text-[#84847e] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '4px' }}
              >
                Sí, es interactivo
              </button>
              <button
                type="button"
                onClick={() => setIsActionable(false)}
                className={`flex-1 py-1.5 text-xs font-sans rounded border text-center transition-colors ${
                  !isActionable
                    ? 'bg-[#26251e] text-[#f7f7f4] border-[#26251e] font-medium'
                    : 'bg-[#f2f1ed] text-[#84847e] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '4px' }}
              >
                No, solo referencial
              </button>
            </div>
          </div>

          {/* Campo 4: Selector de Tipo de Acción */}
          {isActionable && (
            <div className="space-y-1">
              <label className="block text-[11px] font-sans text-[#84847e] uppercase tracking-wider">
                4. Tipo de Acción DOM
              </label>
              <select
                id="select_action_type"
                value={actionType}
                onChange={(e) => setActionType(e.target.value as any)}
                className="w-full px-3 py-1.5 bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
                style={{ borderRadius: '4px' }}
              >
                <option value="CLICK">CLICK (Pulsar botón, enlace o toggle)</option>
                <option value="TYPE">TYPE (Escribir en input de texto o textarea)</option>
                <option value="BOTH">BOTH (Click para enfocar y escritura guiada)</option>
              </select>
            </div>
          )}

          {/* Sub-panel Técnico: Cascada de Selectores y Coordenadas */}
          <div
            className="p-3 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-2 font-mono text-[11px]"
            style={{ borderRadius: '4px' }}
          >
            <div className="flex items-center justify-between text-[#84847e] border-b border-[#cdcdc9]/60 pb-1">
              <span className="font-sans uppercase text-[10px]">Cascada de Selectores Vectoriales</span>
              <span className="text-[#1f8a65]">Estabilidad: {inspectedElement.selectorStabilityScore}/100</span>
            </div>
            <div className="text-[#26251e] truncate" title={inspectedElement.primarySelector}>
              <span className="text-[#84847e]">Primario: </span>
              {inspectedElement.primarySelector}
            </div>
            {inspectedElement.accessibilitySelector && (
              <div className="text-[#26251e] truncate" title={inspectedElement.accessibilitySelector}>
                <span className="text-[#84847e]">ARIA: </span>
                {inspectedElement.accessibilitySelector}
              </div>
            )}
            <div className="text-[#84847e] truncate text-[10px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
              Coordenadas Desktop: x:{inspectedElement.boundingBox.x}, y:{inspectedElement.boundingBox.y}, w:
              {inspectedElement.boundingBox.width}, h:{inspectedElement.boundingBox.height}
            </div>

            {testResult && (
              <div className="text-[11px] text-[#1f8a65] pt-1">{testResult}</div>
            )}
          </div>

          {/* Botones de Acción */}
          <div className="pt-3 flex items-center justify-between border-t border-[#cdcdc9]">
            <button
              type="button"
              onClick={handleTestSelector}
              className="px-3 py-1.5 text-xs font-mono bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors"
              style={{ borderRadius: '4px' }}
            >
              Probar Highlight
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-sans text-[#84847e] hover:bg-[#e6e5e0] rounded transition-colors"
                style={{ borderRadius: '4px' }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-sans font-medium bg-[#34785c] text-[#f7f7f4] hover:bg-[#2c654d] rounded transition-colors shadow-xs"
                style={{ borderRadius: '4px' }}
                data-testid="btn_save_to_rag_map"
              >
                Guardar en Mapa RAG
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
