/**
 * @archivo apps/web/src/app/docs/sandbox/page.tsx
 * @modulo 08. Landing de Documentación & Sandbox — Página del Sandbox Interactivo
 * @proposito
 *   Ensambla el Sandbox interactivo de `/docs/sandbox` en ESTRICTO TEMA CLARO bajo la
 *   estética Cursor Atelier: entorno de testing de 3 paneles sobre superficie Bone (#f2f1ed),
 *   lienzo en Warm Parchment (#f7f7f4), osciloscopio acústico de voz con ondas sobre
 *   lienzo claro, telemetría de latencias en pastillas compactas monospace (#26251e sobre
 *   #e6e5e0) y conmutador táctil de paneles en pantallas móviles para máxima ergonomía.
 *
 * @resumen_contenido
 *   - `VoiceOscilloscopeCanvas`: osciloscopio acústico vectorial bioluminiscente en canvas HTML5.
 *   - `LatencyTelemetryBar`: telemetría de latencias y estado en pastillas monospace compactas.
 *   - `SandboxToolDispatcher`: panel de control y despacho físico de `click_element` y `type_text`.
 *   - `SandboxInteractivePage`: orquestador de los 3 paneles con selector adaptable en móvil.
 *
 * @dependencias_internas
 *   - `ApiAndProtocolSpecViewer`, `DeveloperDocsShell`, `SandboxTargetApplicationCanvas`.
 *   - Primitivas Atelier (`AtelierPrimaryButton`, `AtelierAmberActionButton`, `MonoMetadataTag`, `WindowMockupFrame`).
 *   - Contratos de `sandbox-contracts.types.ts`.
 *
 * @dependencias_externas
 *   - Solo `react` (ReactElement, hooks `useCallback`, `useEffect`, `useRef`, `useState`).
 */

'use client';

import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtelierAmberActionButton,
  AtelierPrimaryButton,
  AtelierSecondaryButton,
  MonoMetadataTag,
  WindowMockupFrame,
} from '../../../components/atelier-primitives/AtelierUiPrimitives';
import { ApiAndProtocolSpecViewer } from '../../../components/docs-sandbox/ApiAndProtocolSpecViewer';
import { DeveloperDocsShell } from '../../../components/docs-sandbox/DeveloperDocsShell';
import { SandboxTargetApplicationCanvas } from '../../../components/docs-sandbox/SandboxTargetApplicationCanvas';
import { SANDBOX_VIEWPORT_PRESETS } from '../../../components/docs-sandbox/sandbox-contracts.types';
import type {
  SandboxElementProbeResult,
  SandboxFrameDirection,
  SandboxViewportId,
  SandboxWsFrameLogEntry,
} from '../../../components/docs-sandbox/sandbox-contracts.types';

/** Sonda del campo trampa sensible para probar el escudo de privacidad. */
const SENSITIVE_CANVAS_PROBE: SandboxElementProbeResult = {
  oaId: 'input-tarjeta-bloqueada',
  selectorCascade: ['[data-oa-id="input-tarjeta-bloqueada"]', 'input[type="password"]', 'form input[type="password"]'],
  isSensitive: true,
};

/** Genera una entrada tipada de la bitácora WebSocket del sandbox. */
function createFrameEntry(params: {
  readonly frameType: string;
  readonly direction: SandboxFrameDirection;
  readonly payloadPreview: string;
  readonly rawJson: string;
  readonly latencyMs?: number;
}): SandboxWsFrameLogEntry {
  return {
    id: `frame_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    frameType: params.frameType,
    direction: params.direction,
    timestampIso: new Date().toISOString(),
    payloadPreview: params.payloadPreview,
    rawJson: params.rawJson,
    ...(params.latencyMs !== undefined ? { latencyMs: params.latencyMs } : {}),
  };
}

/** Semilla inicial plausible del inspector: apertura de sesión y cambio de ruta. */
function buildSeedFrames(): readonly SandboxWsFrameLogEntry[] {
  return [
    createFrameEntry({
      frameType: 'session.init',
      direction: 'client_to_server',
      payloadPreview: 'session.init · protocolo en vivo v1',
      rawJson: JSON.stringify({ type: 'session.init', protocol: 'oa-voice-v1', capabilities: ['voice.input', 'tools', 'barge-in'] }, null, 2),
      latencyMs: 16,
    }),
    createFrameEntry({
      frameType: 'route.changed',
      direction: 'client_to_server',
      payloadPreview: 'route.changed → /docs/sandbox',
      rawJson: JSON.stringify({ type: 'route.changed', from: '/docs', to: '/docs/sandbox' }, null, 2),
      latencyMs: 12,
    }),
  ];
}

/** Osciloscopio acústico de voz con ondas sinusoidales sobre lienzo claro pergamino. */
function VoiceOscilloscopeCanvas(props: { readonly isStreaming: boolean }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const render = (): void => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#f7f7f4';
      ctx.fillRect(0, 0, width, height);

      ctx.beginPath();
      ctx.strokeStyle = '#e6e5e0';
      ctx.lineWidth = 1;
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      const waveCount = 3;
      for (let w = 0; w < waveCount; w++) {
        ctx.beginPath();
        const baseColor = w === 0 ? 'rgba(31, 138, 101, 0.75)' : w === 1 ? 'rgba(128, 82, 255, 0.65)' : 'rgba(192, 133, 50, 0.55)';
        ctx.strokeStyle = baseColor;
        ctx.lineWidth = props.isStreaming ? 2 : 1.5;

        const amplitude = (props.isStreaming ? 18 : 6) * (1 - w * 0.25);
        const frequency = 0.02 + w * 0.01;

        for (let x = 0; x < width; x++) {
          const y = height / 2 + Math.sin(x * frequency + phase + w * 1.5) * amplitude * Math.sin((x / width) * Math.PI);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      phase += props.isStreaming ? 0.08 : 0.03;
      animId = requestAnimationFrame(render);
    };

    render();
    return (): void => cancelAnimationFrame(animId);
  }, [props.isStreaming]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '58px', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--color-stone, #cdcdc9)', backgroundColor: '#f7f7f4' }}>
      <canvas ref={canvasRef} width={480} height={58} style={{ width: '100%', height: '100%', display: 'block' }} />
      <span
        className="atelier-mono"
        style={{
          position: 'absolute',
          top: '5px',
          right: '8px',
          fontSize: '10px',
          color: props.isStreaming ? 'var(--color-verdant, #1f8a65)' : 'var(--color-driftwood, #84847e)',
          backgroundColor: 'rgba(247, 247, 244, 0.9)',
          padding: '2px 6px',
          borderRadius: '3px',
          border: '1px solid var(--color-stone, #cdcdc9)',
        }}
      >
        {props.isStreaming ? 'STREAMING ACTIVE' : 'VAD STANDBY'}
      </span>
    </div>
  );
}

/** Barra de telemetría de latencias y métricas en pastillas compactas monospace. */
function LatencyTelemetryBar(props: { readonly frames: readonly SandboxWsFrameLogEntry[] }): ReactElement {
  const measuredLatencies = useMemo(() => {
    return props.frames.map((f) => f.latencyMs).filter((l): l is number => typeof l === 'number');
  }, [props.frames]);

  const p50 = measuredLatencies.length > 0 ? measuredLatencies[Math.floor(measuredLatencies.length / 2)] : 18;
  const lastLatency = measuredLatencies.length > 0 ? measuredLatencies[measuredLatencies.length - 1] : 16;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
      <span className="atelier-mono" style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '3px', backgroundColor: 'var(--color-linen, #e6e5e0)', border: '1px solid var(--color-stone, #cdcdc9)', color: 'var(--color-ink, #26251e)' }}>
        RTT: {lastLatency}ms
      </span>
      <span className="atelier-mono" style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '3px', backgroundColor: 'var(--color-linen, #e6e5e0)', border: '1px solid var(--color-stone, #cdcdc9)', color: 'var(--color-ink, #26251e)' }}>
        p50: {p50}ms
      </span>
      <span className="atelier-mono" style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '3px', backgroundColor: 'var(--color-linen, #e6e5e0)', border: '1px solid var(--color-stone, #cdcdc9)', color: 'var(--color-verdant, #1f8a65)' }}>
        ACK_SUCCESS
      </span>
    </div>
  );
}

/** Despachador de acciones sobre la aplicación objetivo (click_element y type_text). */
function SandboxToolDispatcher(props: {
  readonly target: SandboxElementProbeResult | null;
  readonly cadenceMs: number;
  readonly onCadenceChange: (cadence: number) => void;
  readonly onDispatchFrame: (frame: SandboxWsFrameLogEntry) => void;
  readonly onActivityChange: (isBusy: boolean) => void;
}): ReactElement {
  const { target, cadenceMs, onCadenceChange, onDispatchFrame, onActivityChange } = props;
  const [textToType, setTextToType] = useState<string>('Factura #10842');
  const [lastActionResult, setLastActionResult] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  const activeTargetId = target?.oaId ?? 'btn-crear-factura';
  const isSensitiveTarget = target?.isSensitive ?? false;

  const handleExecute = useCallback((tool: 'click_element' | 'type_text'): void => {
    setIsBusy(true);
    onActivityChange(true);
    setLastActionResult(null);

    const executeFrame = createFrameEntry({
      frameType: 'tool.execute',
      direction: 'server_to_client',
      payloadPreview: `${tool} sobre [data-oa-id="${activeTargetId}"]`,
      rawJson: JSON.stringify({
        toolName: tool,
        targetOaId: activeTargetId,
        selectorCascade: target?.selectorCascade ?? [`[data-oa-id="${activeTargetId}"]`],
        textToType: tool === 'type_text' ? textToType : undefined,
        humanCadenceMs: cadenceMs,
      }, null, 2),
    });
    onDispatchFrame(executeFrame);

    window.setTimeout(() => {
      setIsBusy(false);
      onActivityChange(false);

      if (isSensitiveTarget) {
        setLastActionResult('ACTION_BLOCKED_SENSITIVE_FIELD');
        onDispatchFrame(createFrameEntry({
          frameType: 'tool.execution.ack',
          direction: 'client_to_server',
          payloadPreview: `Bloqueado por seguridad: [data-oa-id="${activeTargetId}"] es sensible`,
          rawJson: JSON.stringify({ status: 'BLOCKED', code: 'ACTION_BLOCKED_SENSITIVE_FIELD', message: 'Escudo anti-exfiltración activo.' }, null, 2),
          latencyMs: 14,
        }));
      } else {
        setLastActionResult(`SUCCESS (${cadenceMs + 12}ms)`);
        onDispatchFrame(createFrameEntry({
          frameType: 'tool.execution.ack',
          direction: 'client_to_server',
          payloadPreview: `${tool} confirmado en ${cadenceMs + 12}ms`,
          rawJson: JSON.stringify({ status: 'SUCCESS', targetOaId: activeTargetId, durationMs: cadenceMs + 12 }, null, 2),
          latencyMs: cadenceMs + 12,
        }));
      }
    }, cadenceMs + 60);
  }, [activeTargetId, cadenceMs, isSensitiveTarget, onActivityChange, onDispatchFrame, target?.selectorCascade, textToType]);

  return (
    <article className="atelier-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', backgroundColor: 'var(--color-bone, #f2f1ed)', border: '1px solid var(--color-stone, #cdcdc9)', borderRadius: '4px', padding: '14px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p className="atelier-eyebrow" style={{ margin: 0 }}>Despachador de Herramientas</p>
        <MonoMetadataTag label="Target" value={activeTargetId} tone={isSensitiveTarget ? 'danger' : 'accent'} />
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label className="atelier-field">
          <span className="atelier-label" style={{ fontSize: '12px' }}>Texto para type_text:</span>
          <input
            className="atelier-input atelier-mono"
            style={{ fontSize: '12px', padding: '6px 10px' }}
            value={textToType}
            onChange={(e): void => setTextToType(e.target.value)}
            disabled={isBusy}
          />
        </label>

        <label className="atelier-field">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="atelier-label" style={{ fontSize: '12px' }}>Cadencia humana:</span>
            <span className="atelier-mono" style={{ fontSize: '11px', color: 'var(--color-ash, #7a7974)' }}>{cadenceMs}ms</span>
          </div>
          <input
            type="range"
            min={20}
            max={120}
            value={cadenceMs}
            onChange={(e): void => onCadenceChange(Number(e.target.value))}
            style={{ accentColor: 'var(--color-ink, #26251e)', cursor: 'pointer' }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <AtelierAmberActionButton fullWidth disabled={isBusy} onClick={(): void => handleExecute('click_element')}>
          {isBusy ? 'Ejecutando click…' : 'Probar click_element'}
        </AtelierAmberActionButton>
        <AtelierPrimaryButton fullWidth disabled={isBusy} onClick={(): void => handleExecute('type_text')}>
          {isBusy ? 'Escribiendo texto…' : 'Probar type_text'}
        </AtelierPrimaryButton>
      </div>

      {lastActionResult !== null ? (
        <div style={{ padding: '8px 10px', borderRadius: '4px', backgroundColor: isSensitiveTarget ? 'color-mix(in oklab, #cf2d56 8%, #f2f1ed)' : 'var(--color-linen, #e6e5e0)', border: `1px solid ${isSensitiveTarget ? 'var(--color-crimson, #cf2d56)' : 'var(--color-stone, #cdcdc9)'}` }}>
          <p className="atelier-mono" style={{ margin: 0, fontSize: '11px', color: isSensitiveTarget ? 'var(--color-crimson, #cf2d56)' : 'var(--color-verdant, #1f8a65)' }}>
            {lastActionResult}
          </p>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Página interactiva del Sandbox en ESTRICTO TEMA CLARO con 3 paneles y estética Cursor Atelier.
 */
export default function SandboxInteractivePage(): ReactElement {
  const [frames, setFrames] = useState<readonly SandboxWsFrameLogEntry[]>(() => buildSeedFrames());
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(() => frames[0]?.id ?? null);
  const [viewport, setViewport] = useState<SandboxViewportId>('desktop');
  const [probeTarget, setProbeTarget] = useState<SandboxElementProbeResult | null>(null);
  const [sensitiveAttemptCount, setSensitiveAttemptCount] = useState<number>(0);
  const [cadenceMs, setCadenceMs] = useState<number>(45);
  const [isDispatchingOrder, setIsDispatchingOrder] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<'protocol' | 'app' | 'tools'>('app');

  const handleSelectFrame = useCallback((frameId: string): void => setSelectedFrameId(frameId), []);
  const handleProbeElement = useCallback((probe: SandboxElementProbeResult): void => setProbeTarget(probe), []);
  const handleSensitiveFieldAttempt = useCallback((): void => {
    setSensitiveAttemptCount((prev) => prev + 1);
    setProbeTarget(SENSITIVE_CANVAS_PROBE);
  }, []);
  const handleDispatchFrame = useCallback((frame: SandboxWsFrameLogEntry): void => {
    setFrames((prev) => [...prev, frame]);
    setSelectedFrameId(frame.id);
  }, []);

  return (
    <DeveloperDocsShell currentPath="/docs/sandbox">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '1280px', margin: '0 auto', padding: 'clamp(14px, 3vw, 24px)' }}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p className="atelier-eyebrow" style={{ color: 'var(--color-ember, #f54e00)', margin: 0 }}>Sandbox Interactivo B2B</p>
          <h1 className="atelier-heading-lg" style={{ fontSize: '32px', fontWeight: 400, margin: 0 }}>
            Prueba el protocolo en vivo y las herramientas del asistente
          </h1>
          <p className="atelier-prose" style={{ fontSize: '18px', margin: 0, color: 'var(--color-driftwood, #84847e)' }}>
            Despacha órdenes físicas de <code className="atelier-mono">click_element</code> y <code className="atelier-mono">type_text</code> sobre un CRM de prueba y examina las tramas del WebSocket en tiempo real.
          </p>
        </header>

        {/* Barra superior de voz y telemetría */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px', alignItems: 'center' }}>
          <VoiceOscilloscopeCanvas isStreaming={isDispatchingOrder} />
          <LatencyTelemetryBar frames={frames} />
        </div>

        {/* Selector de pestañas móvil */}
        <div className="sandbox-mobile-tabs" style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            className={mobileTab === 'protocol' ? 'atelier-btn atelier-btn--primary' : 'atelier-btn atelier-btn--secondary'}
            style={{ fontSize: '12px', padding: '6px 12px', flex: 1 }}
            onClick={(): void => setMobileTab('protocol')}
          >
            Protocolo ({frames.length})
          </button>
          <button
            type="button"
            className={mobileTab === 'app' ? 'atelier-btn atelier-btn--primary' : 'atelier-btn atelier-btn--secondary'}
            style={{ fontSize: '12px', padding: '6px 12px', flex: 1 }}
            onClick={(): void => setMobileTab('app')}
          >
            Aplicación CRM
          </button>
          <button
            type="button"
            className={mobileTab === 'tools' ? 'atelier-btn atelier-btn--primary' : 'atelier-btn atelier-btn--secondary'}
            style={{ fontSize: '12px', padding: '6px 12px', flex: 1 }}
            onClick={(): void => setMobileTab('tools')}
          >
            Control & Voz
          </button>
        </div>

        {/* Grid de 3 paneles (desktop: 3 columnas / móvil: controlado por pestaña) */}
        <div className="sandbox-panels-grid" data-active-tab={mobileTab}>
          <div className="sandbox-col-protocol">
            <ApiAndProtocolSpecViewer
              frames={frames}
              selectedFrameId={selectedFrameId}
              onSelectFrame={handleSelectFrame}
            />
          </div>

          <div className="sandbox-col-app">
            <SandboxTargetApplicationCanvas
              viewport={viewport}
              onViewportChange={setViewport}
              onProbeElement={handleProbeElement}
              sensitiveAttemptCount={sensitiveAttemptCount}
              onSensitiveFieldAttempt={handleSensitiveFieldAttempt}
            />
          </div>

          <div className="sandbox-col-tools" style={{ maxWidth: '480px', width: '100%' }}>
            <SandboxToolDispatcher
              target={probeTarget}
              cadenceMs={cadenceMs}
              onCadenceChange={setCadenceMs}
              onDispatchFrame={handleDispatchFrame}
              onActivityChange={setIsDispatchingOrder}
            />
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .sandbox-mobile-tabs { display: none !important; }
        .sandbox-panels-grid {
          display: grid;
          grid-template-columns: minmax(280px, 340px) minmax(0, 1fr) minmax(280px, 380px);
          gap: 16px;
          alignItems: start;
        }
        @media (max-width: 1024px) {
          .sandbox-mobile-tabs { display: flex !important; }
          .sandbox-panels-grid { display: block !important; }
          .sandbox-panels-grid[data-active-tab="protocol"] .sandbox-col-protocol { display: block !important; }
          .sandbox-panels-grid[data-active-tab="protocol"] .sandbox-col-app,
          .sandbox-panels-grid[data-active-tab="protocol"] .sandbox-col-tools { display: none !important; }

          .sandbox-panels-grid[data-active-tab="app"] .sandbox-col-app { display: block !important; }
          .sandbox-panels-grid[data-active-tab="app"] .sandbox-col-protocol,
          .sandbox-panels-grid[data-active-tab="app"] .sandbox-col-tools { display: none !important; }

          .sandbox-panels-grid[data-active-tab="tools"] .sandbox-col-tools { display: block !important; }
          .sandbox-panels-grid[data-active-tab="tools"] .sandbox-col-protocol,
          .sandbox-panels-grid[data-active-tab="tools"] .sandbox-col-app { display: none !important; }
        }
      ` }} />
    </DeveloperDocsShell>
  );
}
