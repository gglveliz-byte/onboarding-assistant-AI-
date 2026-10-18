/**
 * @archivo apps/web/src/components/landing/live-demo/LiveInteractiveVoiceDemo.tsx
 * @modulo apps/web/src/components/landing/live-demo (Demostración de Voz Pública Interactiva)
 * @proposito
 *   Sección comercial "Demostración en vivo" que orquesta en un solo flujo:
 *   1. El CRM simulado interactivo `VortexCrmSimulatorBoard` (inputs nativos, tratos dinámicos, CFDI).
 *   2. La capa de cursor láser bioluminiscente `DemoBioluminescentCursorOverlay` (vuelo físico y ack de latencia).
 *   3. El hook WebSocket `usePublicVoiceDemoSession` (PCM16 16kHz, barge-in <50ms y directivas `tool.execute`).
 *   Diseño ultra-compacto que cabe completamente en la pantalla sin scroll vertical.
 *
 * @resumen_contenido
 *   - Orquestación reactiva de directivas: `prepareDirective` -> `moveTo` -> `commitDirective` -> `acknowledgeDirective`.
 *   - Selector de motor de voz (`FAST_VOICE_MODEL` vs `PRECISE_VOICE_MODEL`).
 *   - Stepper de 3 pasos (Crear -> Auto-fill -> Guardar) y cuenta regresiva mm:ss.
 *   - Botón CTA de activación con controles en vivo (Detener, Interrumpir) y microcopia de tranquilidad.
 *
 * @dependencias_internas
 *   - `./VortexCrmSimulatorBoard` (`VortexCrmSimulatorBoard`, `CrmBoardHandle`).
 *   - `./DemoBioluminescentCursorOverlay` (`DemoBioluminescentCursorOverlay`, `CursorOverlayHandle`).
 *   - `./DemoStepProgressHeader` (`FAST_VOICE_MODEL`, `PRECISE_VOICE_MODEL`).
 *   - `./usePublicVoiceDemoSession` (`usePublicVoiceDemoSession`, `PublicDemoPhase`).
 *
 * @dependencias_externas
 *   - `react` (`useEffect`, `useRef`, `useState`, type `ReactElement`).
 */

'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { VortexCrmSimulatorBoard, type CrmBoardHandle } from './VortexCrmSimulatorBoard';
import {
  DemoBioluminescentCursorOverlay,
  type CursorOverlayHandle,
} from './DemoBioluminescentCursorOverlay';
import { FAST_VOICE_MODEL, PRECISE_VOICE_MODEL } from './DemoStepProgressHeader';
import { usePublicVoiceDemoSession, type PublicDemoPhase } from './usePublicVoiceDemoSession';
import type { VoiceModelId } from '../../../lib/api-client/backend-contracts.types';

const CURSOR_TRAVEL_MS = 450;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getStatusBadge(phase: PublicDemoPhase): { label: string; classes: string; dot: string } {
  switch (phase) {
    case 'CONNECTED_LISTENING':
      return { label: 'ESCUCHANDO', classes: 'bg-teal-50 border-teal-200 text-teal-800', dot: 'bg-teal-500' };
    case 'AI_SPEAKING':
      return { label: 'HABLANDO', classes: 'bg-violet-50 border-violet-200 text-violet-800', dot: 'bg-[#6d3dfa]' };
    case 'EXECUTING_DOM_ACTION':
      return { label: 'EJECUTANDO', classes: 'bg-amber-50 border-amber-200 text-amber-800', dot: 'bg-amber-500' };
    case 'REQUESTING_MIC_PERMISSION':
    case 'FETCHING_DEMO_EPHEMERAL_TOKEN':
      return { label: 'PREPARANDO', classes: 'bg-blue-50 border-blue-200 text-blue-800', dot: 'bg-blue-500' };
    case 'DEMO_COMPLETED':
      return { label: 'FINALIZADA', classes: 'bg-slate-100 border-slate-300 text-slate-700', dot: 'bg-slate-500' };
    case 'RATE_LIMITED':
      return { label: 'LÍMITE ALCANZADO', classes: 'bg-rose-50 border-rose-200 text-rose-800', dot: 'bg-rose-500' };
    case 'IDLE':
    default:
      return { label: 'EN ESPERA', classes: 'bg-emerald-50 border-emerald-200/80 text-emerald-800', dot: 'bg-emerald-600' };
  }
}

function pasoMinimoDeFase(phase: PublicDemoPhase): 1 | 2 | 3 {
  switch (phase) {
    case 'CONNECTED_LISTENING':
    case 'AI_SPEAKING':
      return 2;
    case 'EXECUTING_DOM_ACTION':
      return 3;
    default:
      return 1;
  }
}

export function LiveInteractiveVoiceDemo(): ReactElement {
  const session = usePublicVoiceDemoSession();
  const {
    phase,
    activeDirective,
    errorMessage,
    remainingSeconds,
    barsEnergy,
    lastAckLatencyMs,
    lastBargeInLatencyMs,
    acknowledgeDirective,
  } = session;

  const [selectedModel, setSelectedModel] = useState<VoiceModelId>(PRECISE_VOICE_MODEL);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const boardRef = useRef<CrmBoardHandle | null>(null);
  const cursorRef = useRef<CursorOverlayHandle | null>(null);
  const processedDirectiveRef = useRef<string | null>(null);

  const isLive = phase === 'CONNECTED_LISTENING' || phase === 'AI_SPEAKING' || phase === 'EXECUTING_DOM_ACTION';
  const isBusy = phase === 'REQUESTING_MIC_PERMISSION' || phase === 'FETCHING_DEMO_EPHEMERAL_TOKEN';
  const isRunning = isLive || isBusy;
  const statusBadge = getStatusBadge(phase);

  const iniciarDemo = (): void => {
    processedDirectiveRef.current = null;
    setCurrentStep(1);
    boardRef.current?.resetBoard();
    cursorRef.current?.hide();
    void session.startDemo({ preferredVoiceModel: selectedModel });
  };

  useEffect(() => {
    const minimo = pasoMinimoDeFase(phase);
    setCurrentStep((actual) => (minimo > actual ? minimo : actual));
  }, [phase]);

  // Coordinación física completa: IA directiva -> Inspección -> Vuelo del cursor -> Ejecución real -> ACK
  useEffect(() => {
    if (activeDirective === null) return undefined;
    if (processedDirectiveRef.current === activeDirective.providerToolCallId) return undefined;
    processedDirectiveRef.current = activeDirective.providerToolCallId;

    const board = boardRef.current;
    const cursor = cursorRef.current;
    if (!board) return undefined;

    // 1. Marcar e inspeccionar ancla
    board.prepareDirective(activeDirective);

    // 2. Resolver centro y volar cursor bioluminiscente
    const coords = board.resolveAnchorViewportCenter(activeDirective.targetElementKey);
    if (coords && cursor) {
      cursor.moveTo(coords.xNorm, coords.yNorm, { label: activeDirective.targetElementKey });
    }

    // 3. Ejecutar acción física tras vuelo del cursor
    const timer = window.setTimeout(() => {
      const outcome = board.commitDirective(activeDirective);
      acknowledgeDirective(activeDirective.providerToolCallId, outcome.success, outcome.detail);
      if (cursor && lastAckLatencyMs !== null) {
        cursor.showAckBadge(Math.round(lastAckLatencyMs));
      }
    }, CURSOR_TRAVEL_MS);

    return () => window.clearTimeout(timer);
  }, [activeDirective, acknowledgeDirective, lastAckLatencyMs]);

  // Ocultar cursor al terminar o parar la demo
  useEffect(() => {
    if (phase === 'DEMO_COMPLETED' || phase === 'IDLE') {
      cursorRef.current?.hide();
    }
  }, [phase]);

  return (
    <section
      id="demo-en-vivo"
      className="scroll-mt-14 max-w-6xl mx-auto py-2.5 sm:py-3.5 px-3 sm:px-6 lg:px-8"
      aria-labelledby="live-demo-heading"
    >
      {/* Cabecera compacta sin badge */}
      <div className="max-w-2xl mx-auto text-center mb-2 sm:mb-2.5">
        <h2
          id="live-demo-heading"
          className="text-xl sm:text-2xl md:text-[28px] lg:text-[32px] font-display tracking-tight text-[#0a252c] leading-tight mb-1 font-medium"
        >
          Habla con el asistente y míralo operar{' '}
          <span className="italic font-normal underline decoration-[#6d3dfa]/40 decoration-2 underline-offset-4">
            una interfaz real
          </span>{' '}
          en vivo.
        </h2>

        <p className="text-xs sm:text-[13px] text-[#1a3c44]/80 leading-snug max-w-xl mx-auto">
          El asistente escucha tu voz, responde en tiempo real y ejecuta acciones físicas sobre un CRM simulado: abre el formulario, captura el nombre del trato y lo guarda paso a paso.
        </p>
      </div>

      {/* Marco compacto del simulador */}
      <div
        className="bg-white rounded-xl sm:rounded-2xl border border-[#bfe2dd] shadow-glass overflow-hidden relative"
        data-purpose="simulator-window"
      >
        {/* Barra superior de herramientas */}
        <div className="bg-[#f6fcfa] border-b border-[#ddede9] px-3 sm:px-4 py-1.5 sm:py-2 flex flex-wrap items-center justify-between gap-2">
          {/* Selector de modo de voz */}
          <div aria-label="Modo de voz" className="flex items-center gap-1 bg-[#e4f2f0] p-0.5 rounded-lg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={selectedModel === FAST_VOICE_MODEL}
              disabled={isRunning}
              onClick={() => setSelectedModel(FAST_VOICE_MODEL)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all cursor-pointer ${
                selectedModel === FAST_VOICE_MODEL
                  ? 'bg-[#0096c7] text-white shadow-xs font-bold'
                  : 'bg-white text-[#0a252c] hover:bg-slate-50'
              }`}
            >
              VOZ ULTRA-RÁPIDA
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedModel === PRECISE_VOICE_MODEL}
              disabled={isRunning}
              onClick={() => setSelectedModel(PRECISE_VOICE_MODEL)}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                selectedModel === PRECISE_VOICE_MODEL
                  ? 'bg-[#0096c7] text-white shadow-xs'
                  : 'bg-white text-[#0a252c] hover:bg-slate-50'
              }`}
            >
              {selectedModel === PRECISE_VOICE_MODEL && (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="m5 12 5 5L20 7" />
                </svg>
              )}
              VOZ ULTRA-PRECISA
            </button>
          </div>

          {/* Stepper de flujo */}
          <div className="hidden md:flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-500">
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all ${
                currentStep >= 1 ? 'bg-[#6d3dfa] text-white shadow-xs' : 'bg-[#eef7f5] text-slate-600 border border-slate-200'
              }`}
            >
              <span>PASO 1</span>
              {currentStep === 1 && <span className="text-[9px] opacity-80">· Crear</span>}
            </span>
            <span className="w-3 border-t border-dashed border-slate-300" />
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all ${
                currentStep >= 2 ? 'bg-[#6d3dfa] text-white shadow-xs' : 'bg-[#eef7f5] text-slate-600 border border-slate-200'
              }`}
            >
              <span>PASO 2</span>
              {currentStep === 2 && <span className="text-[9px] opacity-80">· Auto-fill</span>}
            </span>
            <span className="w-3 border-t border-dashed border-slate-300" />
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all ${
                currentStep >= 3 ? 'bg-[#6d3dfa] text-white shadow-xs' : 'bg-[#eef7f5] text-slate-600 border border-slate-200'
              }`}
            >
              <span>PASO 3</span>
              {currentStep === 3 && <span className="text-[9px] opacity-80">· Guardar</span>}
            </span>
          </div>

          {/* Badge de estado en tiempo real y temporizador */}
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-md border text-[10px] sm:text-[11px] font-bold uppercase tracking-wider ${statusBadge.classes}`}>
              <span className="relative flex h-1.5 w-1.5">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${statusBadge.dot}`} />
                <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${statusBadge.dot}`} />
              </span>
              <span>{statusBadge.label}</span>
            </div>
            <div className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[#e4f2f0] text-slate-700 tracking-wider">
              {formatCountdown(remainingSeconds)}
            </div>
          </div>
        </div>

        {/* Tablero del CRM simulado con cursor bioluminiscente superpuesto */}
        <div className="relative">
          <VortexCrmSimulatorBoard
            ref={boardRef}
            phase={phase}
            isRunning={isRunning}
            barsEnergy={barsEnergy}
            speechText={
              phase === 'AI_SPEAKING'
                ? 'Entendido, creando trato "Acuerdo Enterprise Q3" para Acme Corp por $35,000.'
                : phase === 'EXECUTING_DOM_ACTION'
                ? 'Rellenando formulario y guardando trato en Vortex CRM...'
                : 'Crea un trato para Acme Corp por $35,000 en etapa de negociación.'
            }
          />

          {/* Puntero láser bioluminiscente guiado físicamente por la IA */}
          <DemoBioluminescentCursorOverlay
            onOverlayReady={(handle) => {
              cursorRef.current = handle;
            }}
          />

          {/* Mensaje de error si la sesión falló */}
          {errorMessage !== null && (
            <div
              className="absolute inset-x-3 bottom-3 z-30 rounded-lg border px-3 py-2 shadow-md"
              style={{ borderColor: '#E7CDF6', background: '#F9E8FF', color: '#581585', fontSize: 12 }}
              role="status"
            >
              {errorMessage}
            </div>
          )}

          {/* Modal de límite diario alcanzado */}
          {phase === 'RATE_LIMITED' && (
            <div className="absolute inset-0 z-40 flex items-center justify-center p-3 bg-white/95 backdrop-blur-sm">
              <div className="flex w-full max-w-[400px] flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-5 text-center shadow-xl">
                <h3 className="text-base font-bold text-[#0a252c]">Límite diario alcanzado</h3>
                <p className="text-xs text-slate-600">
                  {errorMessage ?? 'Has alcanzado el límite de 2 demostraciones públicas por IP al día.'}
                </p>
                <a
                  href="/auth/register"
                  className="inline-flex min-h-[38px] items-center justify-center rounded-lg bg-[#6d3dfa] px-5 py-2 text-xs font-semibold text-white shadow-md hover:bg-[#5c2ee0] transition-all"
                >
                  Crear cuenta y continuar sin límites
                </a>
              </div>
            </div>
          )}

          {/* Modal de demostración finalizada */}
          {phase === 'DEMO_COMPLETED' && (
            <div className="absolute inset-0 z-40 flex items-center justify-center p-3 bg-white/95 backdrop-blur-sm">
              <div className="flex w-full max-w-[400px] flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-5 text-center shadow-xl">
                <h3 className="text-base font-bold text-[#0a252c]">Demostración finalizada</h3>
                <ul className="text-[11px] text-slate-600 space-y-0.5 text-left w-full bg-slate-50 p-2.5 rounded-lg border border-slate-200/80">
                  {lastAckLatencyMs !== null && (
                    <li>· Acción confirmada en pantalla en {Math.round(lastAckLatencyMs)} ms.</li>
                  )}
                  {lastBargeInLatencyMs !== null && (
                    <li>· Interrupción de voz atendida en {Math.round(lastBargeInLatencyMs)} ms.</li>
                  )}
                  {lastAckLatencyMs === null && lastBargeInLatencyMs === null && (
                    <li>· Sesión completada con éxito.</li>
                  )}
                </ul>
                <div className="flex flex-wrap gap-2.5 justify-center w-full">
                  <button
                    type="button"
                    onClick={iniciarDemo}
                    className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-all cursor-pointer"
                  >
                    Volver a iniciar
                  </button>
                  <a
                    href="/auth/register"
                    className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-[#6d3dfa] px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#5c2ee0] transition-all"
                  >
                    Crear cuenta
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bloque CTA primario */}
      <div className="mt-2.5 sm:mt-3 text-center" data-purpose="primary-call-to-action">
        {isLive ? (
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => session.stopDemo()}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-bold uppercase tracking-wider hover:bg-slate-50 shadow-xs transition-all cursor-pointer"
            >
              Detener demostración
            </button>
            {phase === 'AI_SPEAKING' && (
              <button
                type="button"
                onClick={() => session.interruptAssistant()}
                className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-amber-500 text-white text-xs font-bold uppercase tracking-wider hover:bg-amber-600 shadow-xs transition-all cursor-pointer"
              >
                Interrumpir asistente
              </button>
            )}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={iniciarDemo}
              disabled={isBusy}
              className="group relative inline-flex items-center justify-center gap-2.5 px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#6d3dfa] to-[#7e52fc] text-white font-bold text-xs sm:text-sm shadow-md shadow-[#6d3dfa]/20 hover:scale-[1.01] hover:shadow-[#6d3dfa]/35 active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              <span className="p-0.5 rounded-md bg-white/20 group-hover:rotate-12 transition-transform">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              </span>
              <span>{isBusy ? 'Preparando sesión...' : 'Iniciar demostración en vivo'}</span>
            </button>

            <p className="mt-1.5 text-[11px] text-slate-500 tracking-wide font-medium flex items-center justify-center gap-2">
              <span>Máximo 2 demostraciones por IP al día</span>
              <span className="w-1 h-1 rounded-full bg-slate-300" />
              <span>Sin registro previo</span>
            </p>
          </>
        )}
      </div>
    </section>
  );
}
