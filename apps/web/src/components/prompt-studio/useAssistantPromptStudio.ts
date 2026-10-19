/**
 * @archivo apps/web/src/components/prompt-studio/useAssistantPromptStudio.ts
 * @modulo 08-frontend-prompt-studio (Hook de Administración del Prompt del Asistente y Guardrails)
 * @proposito
 *   Administra el estado y la sincronización del System Prompt unificado, la configuración de
 *   motores de voz dual (Gemini 3.8 Live / Qwen3.8-Omni), los guardarrailes de ejecución estricta
 *   y el extractor de pasos secuenciales. La configuración SE LEE del proyecto real
 *   (`GET /api/v1/projects`) y se guarda con `PUT /api/v1/projects/:id/prompt`: no se siembran
 *   prompts ni pasos de demostración.
 *
 * @resumen_contenido
 *   - Interfaces: `OnboardingStep`, `AssistantPromptConfig`, `ExtractedRagAnchor`.
 *   - Función `extractRagAnchorsFromPrompt`: Parsea menciones `@[Título Elemento](id)`.
 *   - Hook `useAssistantPromptStudio`:
 *       * Carga la configuración real del proyecto (prompt, pasos, motores, VAD y guardarraíles).
 *       * Sincronización bidireccional de configuración y pasos de onboarding.
 *       * Mutación segura contra el backend con feedback de guardado.
 *       * Extracción reactiva de anclas RAG presentes en el texto del prompt.
 *
 * @dependencias_internas
 *   - `useProjects` (apps/web/src/components/dashboard-dev/useProjectsAndApiKeys.ts).
 *   - `backendFetch` (apps/web/src/lib/api-client/http-client.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects` (lectura), `prompt_versions` (escritura vía API REST).
 */

'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useProjects } from '../dashboard-dev/useProjectsAndApiKeys';
import { backendFetch } from '../../lib/api-client/http-client';

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

/** Traducción de los códigos de motor que devuelve la API a las etiquetas del selector. */
const VOICE_MODEL_BY_API_CODE: Readonly<Record<string, string>> = {
  GEMINI_3_8_LIVE: 'gemini-3.8-live',
  QWEN_3_8_OMNI_FLASH_REALTIME: 'qwen-3.8-omni',
  QWEN_3_8_OMNI: 'qwen-3.8-omni',
};

/** Traducción inversa: la API solo acepta los códigos canónicos del enum de PostgreSQL. */
const API_CODE_BY_UI_LABEL: Readonly<Record<string, string>> = {
  'gemini-3.8-live': 'GEMINI_3_8_LIVE',
  'qwen-3.8-omni': 'QWEN_3_8_OMNI_FLASH_REALTIME',
};

/** Traducción del nivel de sensibilidad VAD del selector al enum del backend (`BALANCED`, no `MEDIUM`). */
const VAD_BY_UI_LABEL: Readonly<Record<string, string>> = {
  LOW: 'LOW',
  MEDIUM: 'BALANCED',
  HIGH: 'HIGH',
};

/** Configuración vacía: se usa mientras el proyecto real todavía no ha llegado. */
const EMPTY_CONFIG: AssistantPromptConfig = {
  primaryVoiceModel: 'gemini-3.8-live',
  fallbackVoiceModel: 'qwen-3.8-omni',
  speechSpeed: 1,
  vadBargeInSensitivity: 'MEDIUM',
  modelTemperature: 0.2,
  systemPrompt: '',
  onboardingSteps: [],
  strictStepEnforcement: true,
  askConfirmationBeforeSubmit: true,
};

/** Determina si un valor desconocido es un registro JSON indexable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extrae todas las menciones a elementos RAG en formato @[Título Elemento](id).
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

/** Traduce el nivel de sensibilidad VAD del backend a la etiqueta del selector. */
function coerceVadSensitivity(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (value === 'LOW' || value === 'HIGH') {
    return value;
  }
  return 'MEDIUM';
}

/** Convierte un paso de onboarding almacenado por el backend a la forma de la interfaz. */
function coerceStep(raw: unknown, index: number): OnboardingStep | null {
  if (!isRecord(raw)) {
    return null;
  }
  const title = raw['title'];
  const instruction = raw['instruction'];
  if (typeof title !== 'string' || typeof instruction !== 'string') {
    return null;
  }
  const id = raw['id'];
  const stepNumber = raw['stepNumber'];
  const targetElementId = raw['targetElementId'];
  const targetRoutePattern = raw['targetRoutePattern'];
  const completionCondition = raw['completionCondition'];
  return {
    id: typeof id === 'string' && id.length > 0 ? id : `step_${index + 1}`,
    stepNumber: typeof stepNumber === 'number' ? stepNumber : index + 1,
    title,
    instruction,
    ...(typeof targetElementId === 'string' && targetElementId.length > 0 ? { targetElementId } : {}),
    targetRoutePattern: typeof targetRoutePattern === 'string' ? targetRoutePattern : '/',
    completionCondition: completionCondition === 'input_filled' || completionCondition === 'route_reached'
      ? completionCondition
      : 'element_clicked',
  };
}

/**
 * Hook de administración del Prompt del asistente y sus guardarrailes.
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 */
export function useAssistantPromptStudio(projectRef: string) {
  const { projects, loading: isLoadingProjects, error: projectsError } = useProjects();
  const [config, setConfig] = useState<AssistantPromptConfig>(EMPTY_CONFIG);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hydratedProjectIdRef = useRef<string | null>(null);

  const project = useMemo((): (typeof projects)[number] | undefined => {
    return projects.find((item) => item.id === projectRef || item.slug === projectRef);
  }, [projects, projectRef]);

  // Hidrata la configuración con los datos REALES del proyecto una sola vez por proyecto.
  useEffect((): void => {
    if (project === undefined) {
      return;
    }
    if (hydratedProjectIdRef.current === project.id) {
      return;
    }
    hydratedProjectIdRef.current = project.id;
    const primaryVoiceModel = project.primaryVoiceModel ?? '';
    const fallbackVoiceModel = project.fallbackVoiceModel ?? '';
    setConfig({
      primaryVoiceModel: VOICE_MODEL_BY_API_CODE[primaryVoiceModel] ?? (primaryVoiceModel.length > 0 ? primaryVoiceModel : EMPTY_CONFIG.primaryVoiceModel),
      fallbackVoiceModel: VOICE_MODEL_BY_API_CODE[fallbackVoiceModel] ?? (fallbackVoiceModel.length > 0 ? fallbackVoiceModel : EMPTY_CONFIG.fallbackVoiceModel),
      speechSpeed: typeof project.speechSpeed === 'number' ? project.speechSpeed : EMPTY_CONFIG.speechSpeed,
      vadBargeInSensitivity: coerceVadSensitivity(project.vadBargeInSensitivity),
      modelTemperature: typeof project.modelTemperature === 'number' ? project.modelTemperature : EMPTY_CONFIG.modelTemperature,
      systemPrompt: project.systemPrompt ?? '',
      onboardingSteps: (project.onboardingStepsJson ?? [])
        .map(coerceStep)
        .filter((step): step is OnboardingStep => step !== null),
      strictStepEnforcement: project.strictStepEnforcement ?? EMPTY_CONFIG.strictStepEnforcement,
      askConfirmationBeforeSubmit: project.askConfirmationBeforeSubmit ?? EMPTY_CONFIG.askConfirmationBeforeSubmit,
    });
  }, [project]);

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
    if (project === undefined) {
      setSaveError('No se pudo resolver el proyecto activo: la sesión no tiene proyectos disponibles.');
      return;
    }
    if (config.systemPrompt.trim().length < 10) {
      setSaveError('El System Prompt debe tener al menos 10 caracteres para poder publicarse.');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      await backendFetch<unknown>(`/api/v1/projects/${project.id}/prompt`, {
        method: 'PUT',
        body: {
          systemPrompt: config.systemPrompt,
          onboardingStepsJson: config.onboardingSteps,
          primaryVoiceModel: API_CODE_BY_UI_LABEL[config.primaryVoiceModel] ?? config.primaryVoiceModel,
          fallbackVoiceModel: API_CODE_BY_UI_LABEL[config.fallbackVoiceModel] ?? config.fallbackVoiceModel,
          modelTemperature: config.modelTemperature,
          strictStepEnforcement: config.strictStepEnforcement,
          askConfirmationBeforeSubmit: config.askConfirmationBeforeSubmit,
        },
      });

      // La velocidad de voz y la sensibilidad de interrupción no forman parte del contrato del
      // prompt: se guardan en la configuración del proyecto para no perderlas en silencio.
      await backendFetch<unknown>(`/api/v1/projects/${project.id}`, {
        method: 'PUT',
        body: {
          speechSpeed: config.speechSpeed,
          vadBargeInSensitivity: VAD_BY_UI_LABEL[config.vadBargeInSensitivity] ?? config.vadBargeInSensitivity,
        },
      });

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Error de red al guardar');
    } finally {
      setIsSaving(false);
    }
  }, [config, project]);

  return {
    config,
    extractedAnchors,
    isSaving,
    saveSuccess,
    saveError,
    isLoading: isLoadingProjects,
    loadError: projectsError,
    projectFound: project !== undefined,
    updateConfig,
    savePromptConfig,
  };
}
