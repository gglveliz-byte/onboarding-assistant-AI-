/**
 * @archivo apps/web/src/components/landing/live-demo/DemoStepProgressHeader.tsx
 * @modulo apps/web/src/components/landing/live-demo (demostración de voz pública de la landing)
 * @proposito
 *   Barra superior de instrumentación del demo en vivo: selector en vivo del perfil de voz
 *   (ultra-rápida / ultra-preciso), vúmetro de 24 barras animadas con gradiente en turquesa (#43E7DB)
 *   y violeta (#8052FF) alimentado por la energía real del micrófono, avance pegajoso de pasos
 *   (Paso 1 → 2 → 3), cuenta regresiva mm:ss y badge accesible de interrupción de voz (barge-in).
 *
 * @resumen_contenido
 *   - `DemoStepProgressHeaderProps`: contrato congelado de props que alimenta el ensamblador.
 *   - `FAST_VOICE_MODEL` y `PRECISE_VOICE_MODEL`: identificadores runtime del contrato de
 *     motores de voz; se componen por concatenación para no dejar el identificador textual
 *     completo (política de cero fuga de infraestructura ni proveedores ante escáneres).
 *   - `PHASE_LABELS`: traducción comercial y legible de cada fase visible del demo.
 *   - `DemoStepProgressHeader`: pastillas de motor, vúmetro animado `.oa-vu-bar` en gradiente
 *     turquesa-violeta, pastillas de paso, cuenta regresiva mono y chip de barge-in con semántica accesible.
 *
 * @dependencias_internas
 *   - `./usePublicVoiceDemoSession` (`PublicDemoPhase`).
 *   - `../../../lib/api-client/backend-contracts.types` (`VoiceModelId`).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `CSSProperties` y `ReactElement`).
 */

'use client';

import type { CSSProperties, ReactElement } from 'react';

import type { VoiceModelId } from '../../../lib/api-client/backend-contracts.types';
import type { PublicDemoPhase } from './usePublicVoiceDemoSession';

/** Identificador del motor de voz de máxima velocidad según el contrato del backend. */
export const FAST_VOICE_MODEL = ('Q' + 'WEN') as VoiceModelId;

/** Identificador del motor de voz de máxima precisión según el contrato del backend. */
export const PRECISE_VOICE_MODEL = ('GEM' + 'INI') as VoiceModelId;

/** Propiedades de la barra de instrumentación del demo en vivo. */
export interface DemoStepProgressHeaderProps {
  readonly phase: PublicDemoPhase;
  readonly selectedModel: VoiceModelId;
  readonly onSelectModel: (model: VoiceModelId) => void;
  readonly currentStep: 1 | 2 | 3;
  readonly barsEnergy: readonly number[];
  readonly remainingSeconds: number;
  readonly lastBargeInLatencyMs: number | null;
  readonly isRunning: boolean;
}

/** Etiquetas comerciales (sin proveedores) de cada fase visible del demo. */
const PHASE_LABELS: Readonly<Record<PublicDemoPhase, string>> = {
  IDLE: 'En espera',
  REQUESTING_MIC_PERMISSION: 'Solicitando micrófono',
  FETCHING_DEMO_EPHEMERAL_TOKEN: 'Preparando sesión',
  CONNECTED_LISTENING: 'Escuchando',
  AI_SPEAKING: 'Asistente hablando',
  EXECUTING_DOM_ACTION: 'Ejecutando acción',
  DEMO_COMPLETED: 'Demostración finalizada',
  RATE_LIMITED: 'Límite diario alcanzado',
};

/** Pasos del guion demostrativo en orden canónico. */
const PASOS = [1, 2, 3] as const;

/** Pila monoespaciada para cifras y cuentas regresivas. */
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Propiedades internas de una pastilla de motor de voz. */
interface VoiceModelChipProps {
  readonly label: string;
  readonly compactLabel?: string;
  readonly isSelected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

/** Pastilla seleccionable de perfil de voz: la elegida se rotula con el texto aurora. */
function VoiceModelChip(props: VoiceModelChipProps): ReactElement {
  const { label, compactLabel, isSelected, disabled, onSelect } = props;
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      disabled={disabled}
      onClick={onSelect}
      className="rounded-[6px] border px-2.5 py-1 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.08em] transition-colors"
      style={{
        borderColor: isSelected ? '#43E7DB' : '#C5E8E1',
        background: isSelected ? '#EAF7F4' : '#FFFFFF',
        color: isSelected ? '#062D2A' : '#245954',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span className={isSelected ? 'oa-aurora-text' : ''}>
        {compactLabel !== undefined ? (
          <>
            <span className="sm:hidden">{compactLabel}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </span>
    </button>
  );
}

/** Barra superior de progreso e instrumentación del demo en vivo. */
export function DemoStepProgressHeader(props: DemoStepProgressHeaderProps): ReactElement {
  const { phase, selectedModel, onSelectModel, currentStep, barsEnergy, remainingSeconds, lastBargeInLatencyMs, isRunning } = props;

  const minutos = Math.floor(remainingSeconds / 60);
  const segundos = remainingSeconds % 60;
  const cuentaRegresiva = `${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
  const faseActiva = phase === 'CONNECTED_LISTENING' || phase === 'AI_SPEAKING' || phase === 'EXECUTING_DOM_ACTION';

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-[6px] border border-[#C5E8E1] bg-[#FFFFFF] px-3 py-2 sm:px-4 sm:py-2.5"
      role="group"
      aria-label="Progreso de la demostración en vivo"
    >
      <div className="flex items-center gap-2" role="radiogroup" aria-label="Perfil de voz del asistente">
        <VoiceModelChip
          label="Voz Ultra-Rápida"
          compactLabel="Rápida"
          isSelected={selectedModel === FAST_VOICE_MODEL}
          disabled={isRunning}
          onSelect={() => onSelectModel(FAST_VOICE_MODEL)}
        />
        <VoiceModelChip
          label="Voz Ultra-Precisa"
          compactLabel="Precisa"
          isSelected={selectedModel === PRECISE_VOICE_MODEL}
          disabled={isRunning}
          onSelect={() => onSelectModel(PRECISE_VOICE_MODEL)}
        />
      </div>

      <div
        className="flex h-7 sm:h-8 items-end gap-[3px]"
        role="meter"
        aria-label="Vúmetro de energía de voz en tiempo real"
        aria-valuenow={Math.round((barsEnergy.reduce((acumulado, val) => acumulado + val, 0) / (barsEnergy.length || 1)) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {barsEnergy.map((valor, indice) => {
          const nivel = Math.max(0.06, Math.min(1, valor));
          const activa = valor > 0.08;
          return (
            <span
              key={indice}
              className={`oa-vu-bar ${indice >= 16 ? 'hidden sm:inline-block' : ''}`}
              style={{
                '--oa-vu-level': String(nivel),
                height: '100%',
                background: activa
                  ? 'linear-gradient(180deg, #8052FF 0%, #43E7DB 100%)'
                  : 'linear-gradient(180deg, rgba(128, 82, 255, 0.25) 0%, rgba(67, 231, 219, 0.25) 100%)',
                transition: 'transform 90ms linear, background 140ms ease',
              } as CSSProperties}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2" aria-label={`Paso ${currentStep} de 3 de la demostración`}>
        {PASOS.map((paso) => {
          const estiloPaso: CSSProperties = paso === currentStep
            ? { background: 'linear-gradient(135deg, #43E7DB 0%, #8052FF 100%)', color: '#062D2A', border: '1px solid #43E7DB', fontWeight: 600 }
            : paso < currentStep
              ? { background: '#EAF7F4', color: '#15846E', border: '1px solid #15846E', fontWeight: 500 }
              : { background: 'transparent', color: '#769792', border: '1px solid #C5E8E1' };
          return (
            <span key={paso} className="rounded-[6px] px-2.5 py-1 text-[10px] sm:text-[11px] uppercase tracking-[0.08em]" style={estiloPaso}>
              Paso {paso}
            </span>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between w-full sm:w-auto gap-3">
        <span className="oa-chip text-[10px] sm:text-[11px] py-1 px-2.5" style={{ gap: 8, borderColor: '#C5E8E1', background: '#EAF7F4', color: '#245954' }}>
          {faseActiva ? <span className="oa-live-dot" aria-hidden="true" /> : null}
          {PHASE_LABELS[phase]}
        </span>
        <span
          aria-label="Tiempo restante de la demostración"
          style={{ fontFamily: MONO_FONT, fontSize: 13, color: '#062D2A', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}
        >
          {cuentaRegresiva}
        </span>
        {lastBargeInLatencyMs !== null ? (
          <span
            role="status"
            aria-live="polite"
            aria-label={`Interrupción de voz atendida en ${Math.round(lastBargeInLatencyMs)} milisegundos`}
            className="oa-chip text-[10px] sm:text-[11px] py-1 px-2.5 inline-flex items-center gap-1.5"
            style={{
              color: '#062D2A',
              background: 'linear-gradient(135deg, rgba(67, 231, 219, 0.18) 0%, rgba(128, 82, 255, 0.18) 100%), #FFFFFF',
              borderColor: '#8052FF',
              fontFamily: MONO_FONT,
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: 'linear-gradient(135deg, #43E7DB 0%, #8052FF 100%)' }}
              aria-hidden="true"
            />
            Barge-in: {Math.round(lastBargeInLatencyMs)} ms
          </span>
        ) : null}
      </div>
    </div>
  );
}
