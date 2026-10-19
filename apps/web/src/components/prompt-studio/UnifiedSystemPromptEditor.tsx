/**
 * @archivo apps/web/src/components/prompt-studio/UnifiedSystemPromptEditor.tsx
 * @modulo 08-frontend-prompt-studio (Editor Unificado de System Prompt con Anclas RAG)
 * @proposito
 *   Editor de texto multilínea con marco de ventana y pestañas en `berkeleyMono 12px`
 *   (`system-prompt.md`, `steps-schema.json`, `api-curl-snippet.sh`). Resalta anclas RAG
 *   en color Ember #f54e00 y provee inserción rápida de variables de contexto.
 *
 * @resumen_contenido
 *   - Marco de ventana en #f2f1ed con 3 puntos decorativos y pestañas de archivo (adaptable en móvil).
 *   - Pestaña 1: Editor markdown del System Prompt con variables dinámicas.
 *   - Pestaña 2: Visualizador del esquema JSON de pasos del flujo.
 *   - Pestaña 3: Snippet ejecutable cURL para actualizar el prompt vía API REST.
 *   - Botón de acción estructural Forest (#34785c) para guardar la versión del prompt.
 *
 * @dependencias_internas
 *   - `AssistantPromptConfig`, `ExtractedRagAnchor` (./useAssistantPromptStudio.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects.system_prompt`, `prompt_versions`.
 */

'use client';

import React, { useState } from 'react';
import type { AssistantPromptConfig, ExtractedRagAnchor } from './useAssistantPromptStudio';

export interface UnifiedSystemPromptEditorProps {
  readonly projectId: string;
  readonly config: AssistantPromptConfig;
  readonly extractedAnchors: readonly ExtractedRagAnchor[];
  readonly isSaving: boolean;
  readonly saveSuccess: boolean;
  readonly saveError: string | null;
  readonly onChangePrompt: (newPrompt: string) => void;
  readonly onSave: () => void;
  readonly isReadOnly?: boolean;
}

type TabKey = 'system-prompt.md' | 'steps-schema.json' | 'api-curl-snippet.sh';

export function UnifiedSystemPromptEditor({
  projectId,
  config,
  extractedAnchors,
  isSaving,
  saveSuccess,
  saveError,
  onChangePrompt,
  onSave,
  isReadOnly = false,
}: UnifiedSystemPromptEditorProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('system-prompt.md');

  const insertVariable = (variableTag: string) => {
    onChangePrompt(`${config.systemPrompt}\n${variableTag}`);
  };

  const curlSnippet = `curl -X PUT "https://api.tuonboarding.com/api/v1/projects/${projectId}/prompt" \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "primaryVoiceModel": "${config.primaryVoiceModel}",
    "modelTemperature": ${config.modelTemperature},
    "systemPrompt": ${JSON.stringify(config.systemPrompt)}
  }'`;

  return (
    <div
      className="bg-[#f2f1ed] border border-[#cdcdc9] rounded shadow-lg overflow-hidden flex flex-col"
      style={{ borderRadius: '4px' }}
      data-testid="unified-system-prompt-editor"
    >
      {/* Barra de Ventana (Window Mockup Frame) */}
      <div className="bg-[#e6e5e0] border-b border-[#cdcdc9] px-3 sm:px-4 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 select-none flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="hidden sm:flex gap-1.5 flex-shrink-0">
            <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#cdcdc9]" />
          </div>

          {/* Pestañas en berkeleyMono */}
          <div className="flex gap-1 text-[10px] sm:text-[11px] font-mono overflow-x-auto min-w-0">
            {(['system-prompt.md', 'steps-schema.json', 'api-curl-snippet.sh'] as TabKey[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`px-2 sm:px-3 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === tab
                    ? 'bg-[#f7f7f4] text-[#26251e] font-medium border-t-2 border-[#26251e]'
                    : 'text-[#84847e] hover:text-[#26251e]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Anclas Detectadas */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="hidden sm:inline text-[11px] font-mono text-[#84847e]">
            Anclas RAG vinculadas:
          </span>
          <span className="sm:hidden text-[10px] font-mono text-[#84847e]">
            Anclas RAG:
          </span>
          <span className="text-[10px] font-mono px-2 py-0.5 bg-[#f54e00]/10 text-[#f54e00] rounded font-semibold whitespace-nowrap">
            {extractedAnchors.length} activas
          </span>
        </div>
      </div>

      {/* Barra de Inserción Rápida de Variables */}
      {activeTab === 'system-prompt.md' && !isReadOnly && (
        <div className="px-4 py-2 bg-[#f7f7f4] border-b border-[#cdcdc9] flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[#84847e] text-[11px] font-sans">Variables:</span>
          <button
            type="button"
            onClick={() => insertVariable('{{user.name}}')}
            className="px-2 py-0.5 text-[11px] font-mono bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9]"
            style={{ borderRadius: '3px' }}
          >
            + {'{{user.name}}'}
          </button>
          <button
            type="button"
            onClick={() => insertVariable('{{company.name}}')}
            className="px-2 py-0.5 text-[11px] font-mono bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9]"
            style={{ borderRadius: '3px' }}
          >
            + {'{{company.name}}'}
          </button>
          <button
            type="button"
            onClick={() => insertVariable('@[Nombre del Elemento](id_del_elemento)')}
            className="px-2 py-0.5 text-[11px] font-mono bg-[#f54e00]/10 text-[#f54e00] hover:bg-[#f54e00]/20 rounded border border-[#f54e00]/30"
            style={{ borderRadius: '3px' }}
            title="Inserta una ancla con la sintaxis @[Título](id). Sustituye el título y el id por los del mapa funcional real de tu proyecto."
          >
            + Ancla @[Elemento]
          </button>
        </div>
      )}

      {/* Contenido según la pestaña activa */}
      <div className="p-4 bg-[#f7f7f4] flex-1 min-h-[340px]">
        {activeTab === 'system-prompt.md' && (
          <textarea
            disabled={isReadOnly}
            value={config.systemPrompt}
            onChange={(e) => onChangePrompt(e.target.value)}
            rows={14}
            className="w-full text-xs font-mono bg-[#f7f7f4] text-[#26251e] focus:outline-none resize-y leading-relaxed"
            style={{
              fontFamily: "'berkeleyMono', monospace",
              tabSize: 2,
            }}
          />
        )}

        {activeTab === 'steps-schema.json' && (
          <pre
            className="text-xs font-mono text-[#26251e] overflow-auto max-h-[340px] leading-relaxed"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {JSON.stringify(config.onboardingSteps, null, 2)}
          </pre>
        )}

        {activeTab === 'api-curl-snippet.sh' && (
          <pre
            className="text-xs font-mono text-[#26251e] overflow-auto max-h-[340px] leading-relaxed bg-[#f2f1ed] p-3 rounded border border-[#cdcdc9]"
            style={{ borderRadius: '4px' }}
          >
            {curlSnippet}
          </pre>
        )}
      </div>

      {/* Barra de Estado y Botón de Publicación */}
      <div className="p-3 bg-[#e6e5e0]/60 border-t border-[#cdcdc9] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="min-w-0">
          {saveSuccess && (
            <span className="text-xs font-mono text-[#1f8a65] flex items-center gap-1.5">
              <span>✓</span>
              <span>System Prompt y pasos publicados exitosamente en PostgreSQL</span>
            </span>
          )}
          {saveError && (
            <span className="text-xs font-mono text-[#cf2d56] flex items-center gap-1.5">
              <span>✕</span>
              <span>{saveError}</span>
            </span>
          )}
          {!saveSuccess && !saveError && (
            <span className="text-[11px] font-sans text-[#84847e]">
              Los cambios en el prompt se versionan de forma inmutable al guardar.
            </span>
          )}
        </div>

        {!isReadOnly && (
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className="px-4 py-1.5 text-xs font-sans font-medium bg-[#34785c] text-[#f7f7f4] hover:bg-[#2a644c] disabled:opacity-40 rounded transition-colors shadow-xs self-end sm:self-auto flex-shrink-0 whitespace-nowrap"
            style={{ borderRadius: '4px' }}
            data-testid="btn_save_system_prompt"
          >
            {isSaving ? 'Guardando Versión...' : 'Publicar Versión del Prompt'}
          </button>
        )}
      </div>
    </div>
  );
}
