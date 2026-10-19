/**
 * @archivo apps/web/src/components/prompt-studio/StepByStepFlowExtractorAndGuardrails.tsx
 * @modulo 08-frontend-prompt-studio (Constructor Secuencial de Pasos y Guardarrailes de Voz)
 * @proposito
 *   Permite estructurar visualmente la secuencia de pasos del onboarding asistido
 *   (Paso 1 -> Paso 2 -> Paso 3), asignando a cada paso su condición de completitud DOM
 *   (`element_clicked`, `input_filled`, `route_reached`) y configurando los guardarrailes
 *   de enforcement estricto y confirmación verbal antes de enviar formularios.
 *
 * @resumen_contenido
 *   - Controles de guardarrailes de ciberseguridad y diálogo (`strict_step_enforcement`).
 *   - Lista secuencial de pasos con reordenamiento, adición y remoción.
 *   - Asignación de selectores y rutas SPA esperadas para la transición de paso.
 *
 * @dependencias_internas
 *   - `OnboardingStep`, `AssistantPromptConfig` (./useAssistantPromptStudio.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects.strict_step_enforcement`, `projects.onboarding_steps_json`.
 */

'use client';

import React, { useState } from 'react';
import type { OnboardingStep, AssistantPromptConfig } from './useAssistantPromptStudio';

export interface StepByStepFlowExtractorAndGuardrailsProps {
  readonly config: AssistantPromptConfig;
  readonly onChangeConfig: <K extends keyof AssistantPromptConfig>(key: K, value: AssistantPromptConfig[K]) => void;
  readonly isReadOnly?: boolean;
}

export function StepByStepFlowExtractorAndGuardrails({
  config,
  onChangeConfig,
  isReadOnly = false,
}: StepByStepFlowExtractorAndGuardrailsProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newInstruction, setNewInstruction] = useState('');
  const [newCondition, setNewCondition] = useState<'element_clicked' | 'input_filled' | 'route_reached'>('element_clicked');
  const [newRoute, setNewRoute] = useState('/dashboard');

  const handleAddStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const newStep: OnboardingStep = {
      id: `step_${Date.now()}`,
      stepNumber: config.onboardingSteps.length + 1,
      title: newTitle.trim(),
      instruction: newInstruction.trim(),
      targetRoutePattern: newRoute.trim(),
      completionCondition: newCondition,
    };

    onChangeConfig('onboardingSteps', [...config.onboardingSteps, newStep]);
    setNewTitle('');
    setNewInstruction('');
  };

  const handleRemoveStep = (stepId: string) => {
    const filtered = config.onboardingSteps
      .filter((s) => s.id !== stepId)
      .map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    onChangeConfig('onboardingSteps', filtered);
  };

  return (
    <div
      className="bg-[#f2f1ed] border border-[#cdcdc9] rounded p-5 space-y-6 select-none"
      style={{ borderRadius: '4px' }}
      data-testid="step-by-step-flow-and-guardrails"
    >
      {/* 1. Sección de Guardarrailes Estrictos */}
      <div className="space-y-3 border-b border-[#cdcdc9] pb-4">
        <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
          Guardarrailes de Seguridad Conversacional
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans">
          <label className="p-3 bg-[#f7f7f4] border border-[#cdcdc9] rounded flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              id="strict_step_enforcement"
              disabled={isReadOnly}
              checked={config.strictStepEnforcement}
              onChange={(e) => onChangeConfig('strictStepEnforcement', e.target.checked)}
              className="mt-0.5 rounded border-[#cdcdc9] accent-[#34785c] focus:ring-0"
            />
            <div className="space-y-0.5">
              <span className="font-medium text-[#26251e] block">Secuencia Estricta (Strict Enforcement)</span>
              <span className="text-[#84847e] text-[11px] leading-relaxed block">
                Prohíbe a la IA saltar al siguiente paso hasta que el usuario complete la acción física en el DOM.
              </span>
            </div>
          </label>

          <label className="p-3 bg-[#f7f7f4] border border-[#cdcdc9] rounded flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              id="ask_confirmation_before_submit"
              disabled={isReadOnly}
              checked={config.askConfirmationBeforeSubmit}
              onChange={(e) => onChangeConfig('askConfirmationBeforeSubmit', e.target.checked)}
              className="mt-0.5 rounded border-[#cdcdc9] accent-[#34785c] focus:ring-0"
            />
            <div className="space-y-0.5">
              <span className="font-medium text-[#26251e] block">Confirmación Verbal Previa a Submit</span>
              <span className="text-[#84847e] text-[11px] leading-relaxed block">
                Exige un &quot;¿Deseas enviar este formulario?&quot; explícito antes de despachar eventos destructivos.
              </span>
            </div>
          </label>
        </div>
      </div>

      {/* 2. Lista de Pasos Secuenciales */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
            Secuencia Guiada ({config.onboardingSteps.length} Pasos)
          </h2>
          <span className="text-[10px] font-mono text-[#84847e]">
            Flujo determinista asistido
          </span>
        </div>

        <div className="space-y-2">
          {config.onboardingSteps.map((step) => (
            <div
              key={step.id}
              className="p-3.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              style={{ borderRadius: '4px' }}
            >
              <div className="flex items-start gap-3">
                <span
                  className="w-6 h-6 rounded-full bg-[#26251e] text-[#f7f7f4] font-mono text-[11px] flex items-center justify-center flex-shrink-0"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {step.stepNumber}
                </span>
                <div className="space-y-1">
                  <div className="font-medium text-[#26251e]">{step.title}</div>
                  <div className="text-[#84847e] text-[11px] leading-relaxed">{step.instruction}</div>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[10px] font-mono text-[#7a7974]">
                    <span>Ruta: {step.targetRoutePattern}</span>
                    <span>•</span>
                    <span className="text-[#34785c]">Condición: {step.completionCondition}</span>
                  </div>
                </div>
              </div>

              {!isReadOnly && (
                <button
                  type="button"
                  onClick={() => handleRemoveStep(step.id)}
                  className="self-end sm:self-center px-2 py-1 text-[11px] font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 rounded transition-colors"
                  style={{ borderRadius: '3px' }}
                >
                  Eliminar Paso
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 3. Formulario para Añadir Nuevo Paso */}
      {!isReadOnly && (
        <form onSubmit={handleAddStep} className="pt-2 border-t border-[#cdcdc9] space-y-3">
          <div className="text-xs font-sans font-medium text-[#26251e]">Añadir Nuevo Paso al Flujo</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <input
              type="text"
              required
              placeholder="Título del paso (ej. Configurar Métodos de Pago)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="px-3 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
              style={{ borderRadius: '4px' }}
            />
            <input
              type="text"
              placeholder="Ruta esperada (ej. /dashboard/settings/billing)"
              value={newRoute}
              onChange={(e) => setNewRoute(e.target.value)}
              className="px-3 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] font-mono focus:outline-none"
              style={{ borderRadius: '4px' }}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <input
              type="text"
              placeholder="Instrucción verbal guiada..."
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
              className="sm:col-span-2 px-3 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
              style={{ borderRadius: '4px' }}
            />
            <select
              value={newCondition}
              onChange={(e) => setNewCondition(e.target.value as any)}
              className="px-3 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
              style={{ borderRadius: '4px' }}
            >
              <option value="element_clicked">Click en elemento</option>
              <option value="input_filled">Llenado de campo</option>
              <option value="route_reached">Ruta alcanzada</option>
            </select>
          </div>

          <button
            type="submit"
            className="px-4 py-1.5 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] rounded transition-colors"
            style={{ borderRadius: '4px' }}
          >
            + Agregar Paso a la Secuencia
          </button>
        </form>
      )}
    </div>
  );
}
