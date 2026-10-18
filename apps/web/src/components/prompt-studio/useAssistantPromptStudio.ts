/**
 * @archivo apps/web/src/components/prompt-studio/useAssistantPromptStudio.ts
 * @modulo 08-frontend-prompt-studio (Hook de Administración del Prompt del Asistente y Guardrails)
 * @proposito
 *   Administra el estado y la sincronización del System Prompt unificado, la configuración
 *   de motores de voz dual (Gemini 3.8 Live / Qwen3.8-Omni), los guardarrailes de ejecución
 *   estricta y el extractor de pasos secuenciales contra `PUT /api/v1/projects/:id/prompt`.
 *
 * @resumen_contenido
 *   - Interfaces: `OnboardingStep`, `AssistantPromptConfig`, `ExtractedRagAnchor`.
 *   - Función `extractRagAnchorsFromPrompt`: Parsea menciones `@[Título Elemento](id)`.
 *   - Hook `useAssistantPromptStudio`:
 *       * Sincronización bidireccional de configuración y pasos de onboarding.
 *       * Mutación segura contra el backend con feedback de guardado.
 *       * Extracción reactiva de anclas RAG presentes en el texto del prompt.
 *
 * @dependencias_internas
 *   - Ninguna (Lógica de estado y sincronización HTTP pura).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `prompt_versions`.
 */

'use client';

import { useState, useCallback, useMemo } from 'react';

export interface OnboardingStep {
  readonly id: string;
  readonly stepNumber: number;
  readonly title: string;
  readonly instruction: string;
  readonly targetElementId?: string;
  readonly targetRoutePattern: string;
  readonly completionCondition: 'element_clicked' | 'input_filled' | 'route_reached';
}

export interface AssistantPromptConfig {
  readonly primaryVoiceModel: string;
  readonly fallbackVoiceModel: string;
  readonly speechSpeed: number;
  readonly vadBargeInSensitivity: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly modelTemperature: number;
  readonly systemPrompt: string;
  readonly onboardingSteps: readonly OnboardingStep[];
  readonly strictStepEnforcement: boolean;
  readonly askConfirmationBeforeSubmit: boolean;
}

export interface ExtractedRagAnchor {
  readonly title: string;
  readonly elementId: string;
}

/**
 * Extrae todas las menciones a elementos RAG en formato @[Título Elemento](id).
 */
export function extractRagAnchorsFromPrompt(text: string): ExtractedRagAnchor[] {
  const regex = /@\[([^\]]+)\]\(([^)]+)\)/g;
  const matches: ExtractedRagAnchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[1] && m[2]) {
      matches.push({ title: m[1], elementId: m[2] });
    }
  }
  return matches;
}

export function useAssistantPromptStudio(projectId: string) {
  const initialConfig: AssistantPromptConfig = useMemo(
    () => ({
      primaryVoiceModel: 'gemini-3.8-live',
      fallbackVoiceModel: 'qwen-3.8-omni',
      speechSpeed: 1.0,
      vadBargeInSensitivity: 'MEDIUM',
      modelTemperature: 0.2,
      systemPrompt: `# Rol del Asistente
Eres el Guía Inteligente de Onboarding de la plataforma. Tu objetivo es acompañar al usuario paso a paso con voz natural, cálida y ejecutiva.

## Reglas de Interacción
1. Saluda al usuario por su nombre {{user.name}} de la empresa {{company.name}}.
2. Para crear una factura, indícale presionar @[Botón Crear Factura](elem_factura_btn).
3. Cuando el modal se abra, solicita el RFC en @[Campo Identificación Fiscal / RFC](elem_rfc_input).
4. Jamás solicites contraseñas ni números completos de tarjetas de crédito.`,
      onboardingSteps: [
        {
          id: 'step_01',
          stepNumber: 1,
          title: 'Iniciar Emisión de Factura',
          instruction: 'Haz click en el botón de Crear Factura para comenzar.',
          targetElementId: 'elem_factura_btn',
          targetRoutePattern: '/dashboard/invoices',
          completionCondition: 'element_clicked',
        },
        {
          id: 'step_02',
          stepNumber: 2,
          title: 'Llenado de Identificación Fiscal',
          instruction: 'Escribe el RFC o identificación fiscal del cliente.',
          targetElementId: 'elem_rfc_input',
          targetRoutePattern: '/dashboard/invoices/new',
          completionCondition: 'input_filled',
        },
      ],
      strictStepEnforcement: true,
      askConfirmationBeforeSubmit: true,
    }),
    []
  );

  const [config, setConfig] = useState<AssistantPromptConfig>(initialConfig);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Anclas RAG extraídas en tiempo real del prompt
  const extractedAnchors = useMemo(
    () => extractRagAnchorsFromPrompt(config.systemPrompt),
    [config.systemPrompt]
  );

  const updateConfig = useCallback(<K extends keyof AssistantPromptConfig>(key: K, value: AssistantPromptConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSaveSuccess(false);
  }, []);

  const savePromptConfig = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const response = await fetch(`/api/v1/projects/${projectId}/prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: config.systemPrompt,
          onboardingStepsJson: config.onboardingSteps,
          primaryVoiceModel: config.primaryVoiceModel,
          fallbackVoiceModel: config.fallbackVoiceModel,
          modelTemperature: config.modelTemperature,
          strictStepEnforcement: config.strictStepEnforcement,
          askConfirmationBeforeSubmit: config.askConfirmationBeforeSubmit,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Error al actualizar el System Prompt');
      }

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err: any) {
      setSaveError(err.message || 'Error de red al guardar');
    } finally {
      setIsSaving(false);
    }
  }, [config, projectId]);

  return {
    config,
    extractedAnchors,
    isSaving,
    saveSuccess,
    saveError,
    updateConfig,
    savePromptConfig,
  };
}
