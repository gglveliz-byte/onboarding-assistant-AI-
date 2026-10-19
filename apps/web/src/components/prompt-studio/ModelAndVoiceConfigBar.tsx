/**
 * @archivo apps/web/src/components/prompt-studio/ModelAndVoiceConfigBar.tsx
 * @modulo 08-frontend-prompt-studio (Barra de Configuración de Modelos de Voz, VAD y Temperatura)
 * @proposito
 *   Provee los controles de hardware y acústica conversacional para el Asistente en tiempo real:
 *   orquestación dual de motores con failover automático, velocidad de síntesis, sensibilidad
 *   de interrupción acústica (VAD / Barge-in <50ms) y temperatura estocástica del modelo.
 *
 * @resumen_contenido
 *   - Selector de motor principal y motor de contingencia (Failover).
 *   - Control deslizante de velocidad vocal (0.8x a 1.25x).
 *   - Conmutador de sensibilidad VAD / Barge-in (LOW / MEDIUM / HIGH).
 *   - Control de temperatura (0.0 precisión matemática a 1.0 creatividad fluida).
 *
 * @dependencias_internas
 *   - `AssistantPromptConfig` (./useAssistantPromptStudio.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects.primary_voice_model`, `projects.vad_barge_in_sensitivity`.
 */

'use client';

import React from 'react';
import type { AssistantPromptConfig } from './useAssistantPromptStudio';

export interface ModelAndVoiceConfigBarProps {
  readonly config: AssistantPromptConfig;
  readonly onChange: <K extends keyof AssistantPromptConfig>(key: K, value: AssistantPromptConfig[K]) => void;
  readonly isReadOnly?: boolean;
}

export function ModelAndVoiceConfigBar({
  config,
  onChange,
  isReadOnly = false,
}: ModelAndVoiceConfigBarProps) {
  return (
    <div
      className="bg-[#f2f1ed] border border-[#cdcdc9] rounded p-4 space-y-4 select-none"
      style={{ borderRadius: '4px' }}
      data-testid="model-and-voice-config-bar"
    >
      <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-2">
        <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
          Motor Conversacional y Parámetros Acústicos
        </h2>
        <span className="text-[10px] font-mono text-[#34785c] bg-[#34785c]/10 px-2 py-0.5 rounded">
          Failover Activo
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-sans">
        {/* 1. Motor de Voz Principal */}
        <div className="space-y-1">
          <label className="text-[11px] font-sans text-[#84847e] uppercase tracking-wider block">
            Motor Primario (Tiempo Real)
          </label>
          <select
            disabled={isReadOnly}
            value={config.primaryVoiceModel}
            onChange={(e) => onChange('primaryVoiceModel', e.target.value)}
            className="w-full px-2.5 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
            style={{ borderRadius: '4px' }}
          >
            <option value="gemini-3.8-live">Gemini 3.8 Live · Bidi</option>
            <option value="qwen-3.8-omni">Qwen 3.8 Omni · Baja latencia</option>
          </select>
        </div>

        {/* 2. Motor de Contingencia / Failover */}
        <div className="space-y-1">
          <label className="text-[11px] font-sans text-[#84847e] uppercase tracking-wider block">
            Motor de Respaldo (Failover)
          </label>
          <select
            disabled={isReadOnly}
            value={config.fallbackVoiceModel}
            onChange={(e) => onChange('fallbackVoiceModel', e.target.value)}
            className="w-full px-2.5 py-1.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
            style={{ borderRadius: '4px' }}
          >
            <option value="qwen-3.8-omni">Qwen 3.8 Omni · Baja latencia</option>
            <option value="gemini-3.8-live">Gemini 3.8 Live · Bidi</option>
          </select>
        </div>

        {/* 3. Sensibilidad VAD / Barge-In */}
        <div className="space-y-1">
          <label className="text-[11px] font-sans text-[#84847e] uppercase tracking-wider block">
            Sensibilidad de Interrupción (Barge-in)
          </label>
          <div className="grid grid-cols-3 gap-1">
            {(['LOW', 'MEDIUM', 'HIGH'] as const).map((sens) => (
              <button
                key={sens}
                type="button"
                disabled={isReadOnly}
                onClick={() => onChange('vadBargeInSensitivity', sens)}
                className={`py-1 text-[11px] font-mono rounded border transition-colors ${
                  config.vadBargeInSensitivity === sens
                    ? 'bg-[#26251e] text-[#f7f7f4] border-[#26251e] font-medium'
                    : 'bg-[#f7f7f4] text-[#84847e] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '3px' }}
              >
                {sens}
              </button>
            ))}
          </div>
        </div>

        {/* 4. Velocidad Vocal y Temperatura */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-mono text-[#84847e]">
            <span>Velocidad:</span>
            <span className="text-[#26251e] font-semibold">{config.speechSpeed}x</span>
          </div>
          <input
            type="range"
            min="0.8"
            max="1.25"
            step="0.05"
            disabled={isReadOnly}
            value={config.speechSpeed}
            onChange={(e) => onChange('speechSpeed', parseFloat(e.target.value))}
            className="w-full accent-[#26251e] cursor-pointer"
          />

          <div className="flex items-center justify-between text-[11px] font-mono text-[#84847e]">
            <span>Temperatura:</span>
            <span className="text-[#26251e] font-semibold">{config.modelTemperature}</span>
          </div>
          <input
            type="range"
            min="0.0"
            max="1.0"
            step="0.1"
            disabled={isReadOnly}
            value={config.modelTemperature}
            onChange={(e) => onChange('modelTemperature', parseFloat(e.target.value))}
            className="w-full accent-[#26251e] cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
}
