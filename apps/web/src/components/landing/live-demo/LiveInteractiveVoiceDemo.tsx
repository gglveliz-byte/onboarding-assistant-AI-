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
 *   - Selector de voz REAL por motor (`DEMO_VOICE_CATALOG`: voces QWEN y Gemini), en lugar del antiguo
 *     toggle faux "Ultra-Rápida / Ultra-Precisa".
 *   - La barra muestra solo la voz: se ocultan el stepper, el badge de estado y la cuenta regresiva para
 *     que el marco se lea como una app de negocio real y no como una demostración guionada.
 *   - Botón CTA de activación con controles en vivo (Detener, Interrumpir) y microcopia de tranquilidad.
 *
 * @dependencias_internas
 *   - `./VortexCrmSimulatorBoard` (`VortexCrmSimulatorBoard`, `CrmBoardHandle`).
 *   - `./DemoBioluminescentCursorOverlay` (`DemoBioluminescentCursorOverlay`, `CursorOverlayHandle`).
 *   - `./DemoStepProgressHeader` (`FAST_VOICE_MODEL`, `PRECISE_VOICE_MODEL`).
 *   - `./usePublicVoiceDemoSession` (`usePublicVoiceDemoSession`).
 *
 * @dependencias_externas
 *   - `react` (`useEffect`, `useRef`, `useState`, type `ReactElement`).
 *   - `backend-contracts.types` (`DEMO_VOICE_CATALOG`, `VoiceModelId`).
 */

'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { VortexCrmSimulatorBoard, type CrmBoardHandle } from './VortexCrmSimulatorBoard';
import {
  DemoBioluminescentCursorOverlay,
  type CursorOverlayHandle,
} from './DemoBioluminescentCursorOverlay';
import { FAST_VOICE_MODEL, PRECISE_VOICE_MODEL } from './DemoStepProgressHeader';
import { usePublicVoiceDemoSession } from './usePublicVoiceDemoSession';
import { DEMO_VOICE_CATALOG, type VoiceModelId } from '../../../lib/api-client/backend-contracts.types';

/** Milisegundos del vuelo del cursor hasta el ancla: viaje pausado, pedagógico y con click sincronizado a causa de este mismo valor. */
const CURSOR_TRAVEL_MS = 900;

/** Clave única del selector de voces: `MOTOR:voz` (p. ej. `GEMINI:Kore`). */
function voiceKey(engine: VoiceModelId, voiceName: string): string {
  return `${engine}:${voiceName}`;
}

/**
 * Motores que se muestran en el selector de la demo pública.
 * Ambos quedaron VERIFICADOS en vivo contra la cuenta del usuario: Gemini Live (workspace Virginia)
 * y Qwen3.8-Omni-Realtime (workspace Singapur `ws-4uv1ji0nmluiwa0e`, con su llave regional). Cada voz
 * del catálogo es un ID oficial del proveedor y se probó produciendo audio real.
 */
const DEMO_ENGINES_ONLINE: readonly VoiceModelId[] = [FAST_VOICE_MODEL, PRECISE_VOICE_MODEL];

export function LiveInteractiveVoiceDemo(): ReactElement {
  const session = usePublicVoiceDemoSession();
  const {
    phase,
    activeDirective,
    errorMessage,
    barsEnergy,
    lastAckLatencyMs,
    lastBargeInLatencyMs,
    acknowledgeDirective,
  } = session;

  const [selectedVoice, setSelectedVoice] = useState<{ readonly engine: VoiceModelId; readonly voiceName: string }>(
    { engine: PRECISE_VOICE_MODEL, voiceName: 'Kore' },
  );
  const [previewing, setPreviewing] = useState<boolean>(false);
  const boardRef = useRef<CrmBoardHandle | null>(null);
  const cursorRef = useRef<CursorOverlayHandle | null>(null);
  const processedDirectiveRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Reproduce un clip previo real de la voz seleccionada (generado por proveedor y servido estático
  // desde /public/demo-voices/<MOTOR>-<voz>.wav), para oírla antes de lanzar la demo.
  const reproducirPreview = (): void => {
    if (isRunning) return;
    previewAudioRef.current?.pause();
    const audio = new Audio(`/demo-voices/${selectedVoice.engine}-${selectedVoice.voiceName}.wav`);
    previewAudioRef.current = audio;
    setPreviewing(true);
    audio.onended = (): void => setPreviewing(false);
    audio.onerror = (): void => setPreviewing(false);
    void audio.play().catch((): void => setPreviewing(false));
  };

  // Espejos estables para el temporizador de ejecución: `acknowledgeDirective` se recrea en cada
  // render y, al estar en las dependencias del efecto, cancelaba el `setTimeout` de 450 ms antes
  // de que la acción física se confirmara al backend (la demo quedaba esperando el acuse).
  const acknowledgeDirectiveRef = useRef(acknowledgeDirective);
  const lastAckLatencyRef = useRef(lastAckLatencyMs);

  useEffect(() => {
    acknowledgeDirectiveRef.current = acknowledgeDirective;
    lastAckLatencyRef.current = lastAckLatencyMs;
  }, [acknowledgeDirective, lastAckLatencyMs]);

  const isLive = phase === 'CONNECTED_LISTENING' || phase === 'AI_SPEAKING' || phase === 'EXECUTING_DOM_ACTION';
  const isBusy = phase === 'REQUESTING_MIC_PERMISSION' || phase === 'FETCHING_DEMO_EPHEMERAL_TOKEN';
  const isRunning = isLive || isBusy;

  const iniciarDemo = (): void => {
    processedDirectiveRef.current = null;
    boardRef.current?.resetBoard();
    cursorRef.current?.hide();
    void session.startDemo({ preferredVoiceModel: selectedVoice.engine, preferredVoiceName: selectedVoice.voiceName });
  };

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

    // 3. Ejecutar acción física tras vuelo del cursor. Se leen las funciones/valores desde refs
    //    para que ningún re-render (por ejemplo, el `setInspectedKey` de `prepareDirective`)
    //    cancele este temporizador ni reinicie el efecto antes del acuse al backend.
    const timer = window.setTimeout(() => {
      const outcome = board.commitDirective(activeDirective);
      acknowledgeDirectiveRef.current(activeDirective.providerToolCallId, outcome.success, outcome.detail);
      const ackLatency = lastAckLatencyRef.current;
      if (cursor && ackLatency !== null) {
        cursor.showAckBadge(Math.round(ackLatency));
      }
    }, CURSOR_TRAVEL_MS);

    return () => window.clearTimeout(timer);
  }, [activeDirective]);

  // Ocultar cursor al terminar o parar la demo
  useEffect(() => {
    if (phase === 'DEMO_COMPLETED' || phase === 'IDLE') {
      cursorRef.current?.hide();
    }
  }, [phase]);

  return (
    <section
      id="demo-en-vivo"
      className="scroll-mt-14 max-w-7xl mx-auto py-3 sm:py-6 px-4 sm:px-6 lg:px-8 w-full"
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
        {/* Barra superior: selector de voz real del proveedor (se ocultan stepper, badge y countdown
            para que el marco se lea como una app de negocio y no como una demostración guionada). */}
        <div className="bg-[#f6fcfa] border-b border-[#ddede9] px-3 sm:px-4 py-1.5 sm:py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <label htmlFor="demo-voice-select" className="text-[11px] font-semibold text-[#1a3c44]/70">
              Voz del asistente
            </label>
            <select
              id="demo-voice-select"
              disabled={isRunning}
              value={voiceKey(selectedVoice.engine, selectedVoice.voiceName)}
              onChange={(event) => {
                const partes = event.target.value.split(':');
                const engine = partes[0];
                const voiceName = partes[1] ?? '';
                if (engine === FAST_VOICE_MODEL || engine === PRECISE_VOICE_MODEL) {
                  setSelectedVoice({ engine, voiceName });
                }
              }}
              className="rounded-md border border-[#bfe2dd] bg-white px-2 py-1 text-[11px] font-semibold text-[#0a252c] focus:outline-none focus:ring-2 focus:ring-[#0096c7]/40 disabled:opacity-60 cursor-pointer"
            >
              {DEMO_ENGINES_ONLINE.map((engine) => (
                <optgroup key={engine} label={engine === FAST_VOICE_MODEL ? 'Voces naturales' : 'Voces HD'}>
                  {DEMO_VOICE_CATALOG[engine].map((voice) => (
                    <option key={voiceKey(engine, voice.voiceName)} value={voiceKey(engine, voice.voiceName)}>
                      {voice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={reproducirPreview}
              disabled={isRunning}
              aria-label="Escuchar una muestra de esta voz"
              className="inline-flex items-center gap-1 rounded-md border border-[#bfe2dd] bg-white px-2 py-1 text-[11px] font-semibold text-[#0a252c] hover:bg-[#eef7f5] transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span aria-hidden>{previewing ? '■' : '▶'}</span>
              <span>{previewing ? 'Detener' : 'Probar voz'}</span>
            </button>
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
