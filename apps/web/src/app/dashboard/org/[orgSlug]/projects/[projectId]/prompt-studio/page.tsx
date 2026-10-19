/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/prompt-studio/page.tsx
 * @modulo 08-frontend-prompt-studio (Página del Estudio del Prompt del Asistente y Guardrails de Voz)
 * @proposito
 *   Ensambla el espacio de trabajo del Estudio del Prompt: configuración de motores acústicos
 *   en tiempo real (Gemini 3.8 Live / Qwen3.8-Omni), editor unificado del System Prompt con
 *   anclas RAG resaltadas en Ember (#f54e00), constructor visual de pasos secuenciales y
 *   guardarrailes de confirmación verbal previa a la ejecución de acciones en el DOM.
 *
 * @resumen_contenido
 *   - Barra de configuración de modelos, sensibilidad VAD y temperatura (`ModelAndVoiceConfigBar`).
 *   - Editor unificado en marco de ventana con pestañas Markdown, JSON y cURL (`UnifiedSystemPromptEditor`).
 *   - Constructor secuencial de pasos con condiciones DOM (`StepByStepFlowExtractorAndGuardrails`).
 *   - Sincronización inmutable contra `PUT /api/v1/projects/:id/prompt`.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *   - `useAssistantPromptStudio` (apps/web/src/components/prompt-studio/useAssistantPromptStudio.ts).
 *   - `ModelAndVoiceConfigBar` (apps/web/src/components/prompt-studio/ModelAndVoiceConfigBar.tsx).
 *   - `UnifiedSystemPromptEditor` (apps/web/src/components/prompt-studio/UnifiedSystemPromptEditor.tsx).
 *   - `StepByStepFlowExtractorAndGuardrails` (apps/web/src/components/prompt-studio/StepByStepFlowExtractorAndGuardrails.tsx).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `prompt_versions`.
 */

'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { DeveloperDashboardShell } from '@/components/dashboard-dev/DeveloperDashboardShell';
import { useAssistantPromptStudio } from '@/components/prompt-studio/useAssistantPromptStudio';
import { ModelAndVoiceConfigBar } from '@/components/prompt-studio/ModelAndVoiceConfigBar';
import { UnifiedSystemPromptEditor } from '@/components/prompt-studio/UnifiedSystemPromptEditor';
import { StepByStepFlowExtractorAndGuardrails } from '@/components/prompt-studio/StepByStepFlowExtractorAndGuardrails';

export default function PromptStudioPage() {
  const params = useParams();
  const orgSlug = String(params?.['orgSlug'] ?? 'default-org');
  const projectId = String(params?.['projectId'] ?? 'proj_default_live');

  const {
    config,
    extractedAnchors,
    isSaving,
    saveSuccess,
    saveError,
    isLoading,
    loadError,
    projectFound,
    updateConfig,
    savePromptConfig,
  } = useAssistantPromptStudio(projectId);

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      projectId={projectId}
      environment="LIVE"
      userRole="DEVELOPER"
    >
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Cabecera Principal */}
        <div className="border-b border-[#cdcdc9] pb-4">
          <h1 className="text-[26px] font-sans font-normal tracking-[-0.012em] text-[#26251e]">
            Estudio del Prompt y Secuencia del Asistente
          </h1>
          <p className="text-sm font-sans text-[#84847e] mt-1">
            Diseña las instrucciones del Asistente vocal, vincula elementos del Mapa RAG y fija guardarrailes de ejecución estricta.
          </p>
        </div>

        {/* Estado de carga real del proyecto (sin prompt de demostración por delante) */}
        {isLoading && (
          <div className="px-3 py-2 bg-[#f2f1ed] border border-[#cdcdc9] text-[12px] font-mono text-[#84847e]" style={{ borderRadius: '4px' }}>
            Cargando la configuración real del proyecto…
          </div>
        )}
        {!isLoading && !projectFound && (
          <div className="px-3 py-2 bg-[#cf2d56]/10 border border-[#cf2d56]/40 text-[12px] font-sans text-[#cf2d56]" style={{ borderRadius: '4px' }} role="status">
            {loadError ?? 'No se encontró el proyecto solicitado en tu organización.'}
          </div>
        )}

        {/* 1. Barra de Configuración de Modelos y Acústica */}
        <ModelAndVoiceConfigBar
          config={config}
          onChange={updateConfig}
        />

        {/* 2. Editor Unificado del System Prompt en Marco de Ventana */}
        <UnifiedSystemPromptEditor
          projectId={projectId}
          config={config}
          extractedAnchors={extractedAnchors}
          isSaving={isSaving}
          saveSuccess={saveSuccess}
          saveError={saveError}
          onChangePrompt={(prompt: string) => updateConfig('systemPrompt', prompt)}
          onSave={savePromptConfig}
        />

        {/* 3. Secuencia de Pasos y Guardarrailes */}
        <StepByStepFlowExtractorAndGuardrails
          config={config}
          onChangeConfig={updateConfig}
        />
      </div>
    </DeveloperDashboardShell>
  );
}
