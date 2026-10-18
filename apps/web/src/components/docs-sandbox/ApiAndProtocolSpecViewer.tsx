/**
 * @archivo apps/web/src/components/docs-sandbox/ApiAndProtocolSpecViewer.tsx
 * @modulo 08. Landing de Documentación & Sandbox — Panel Izquierdo (Inspector del Protocolo)
 * @proposito
 *   Panel izquierdo del Sandbox en ESTRICTO TEMA CLARO bajo la estética Cursor Atelier:
 *   publica la especificación honesta del protocolo de voz en vivo (las 6 tramas con su
 *   dirección, resumen y campos) e inspecciona la bitácora de tramas recibidas en tiempo real,
 *   con el JSON crudo de la trama seleccionada resaltado sobre fondo pergamino y copiado
 *   efímero al portapapeles. Las latencias se presentan en pastillas monospace compactas.
 *
 * @resumen_contenido
 *   - `WsProtocolFrameCatalogEntry` y `WS_PROTOCOL_FRAME_CATALOG`: catálogo congelado de
 *     las 6 tramas del protocolo (`session.init`, `audio.input.pcm16`, `route.changed`,
 *     `tool.execute`, `tool.execution.ack`, `voice.barge_in`).
 *   - `ApiAndProtocolSpecViewerProps` y `ApiAndProtocolSpecViewer`: catálogo colapsable
 *     con badges de dirección, lista viva de tramas y visor de JSON crudo en tema claro.
 *
 * @dependencias_internas
 *   - `MonoMetadataTag` (../atelier-primitives/AtelierUiPrimitives.tsx).
 *   - `SandboxFrameDirection`, `SandboxWsFrameLogEntry` (./sandbox-contracts.types.ts).
 *
 * @dependencias_externas
 *   - Solo `react` (ReactElement, hooks `useCallback`, `useMemo`, `useState`).
 */

'use client';

import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { MonoMetadataTag } from '../atelier-primitives/AtelierUiPrimitives';
import type { SandboxFrameDirection, SandboxWsFrameLogEntry } from './sandbox-contracts.types';

/** Metadatos visuales de una dirección de tráfico en Atelier Light. */
interface FrameDirectionMeta {
  readonly arrow: string;
  readonly label: string;
  readonly color: string;
  readonly badgeTone: 'success' | 'accent' | 'neutral';
}

/** Dirección de tráfico → flecha, etiqueta y tono semántico claro. */
const FRAME_DIRECTION_META: Record<SandboxFrameDirection, FrameDirectionMeta> = {
  client_to_server: { arrow: '↑', label: 'cliente → servidor', color: 'var(--color-forest, #34785c)', badgeTone: 'success' },
  server_to_client: { arrow: '↓', label: 'servidor → cliente', color: 'var(--color-amber, #c08532)', badgeTone: 'accent' },
};

/** Entrada del catálogo estático de tramas del protocolo. */
export interface WsProtocolFrameCatalogEntry {
  readonly frameType: string;
  readonly direction: SandboxFrameDirection;
  readonly summary: string;
  readonly payloadFields: readonly string[];
}

/** Catálogo congelado de las 6 tramas del protocolo de voz en vivo. */
export const WS_PROTOCOL_FRAME_CATALOG: readonly WsProtocolFrameCatalogEntry[] = [
  {
    frameType: 'session.init',
    direction: 'client_to_server',
    summary: 'Apertura de la sesión de voz: el cliente presenta su contexto de proyecto, el origen autorizado y las capacidades negociadas antes de enviar audio.',
    payloadFields: ['sessionId', 'origin', 'capabilities', 'locale'],
  },
  {
    frameType: 'audio.input.pcm16',
    direction: 'client_to_server',
    summary: 'Audio del usuario muestreado en PCM de 16 bits y empaquetado en tramas de 20 ms para mantener la latencia del canal lo más baja posible.',
    payloadFields: ['pcm16Bytes', 'sequenceNumber', 'capturedAtIso'],
  },
  {
    frameType: 'route.changed',
    direction: 'client_to_server',
    summary: 'Navegación detectada: informa que la ruta de la aplicación cambió para reevaluar la página activa del mapa funcional del proyecto.',
    payloadFields: ['route', 'title', 'changedAtIso'],
  },
  {
    frameType: 'tool.execute',
    direction: 'server_to_client',
    summary: 'Orden de herramienta del asistente: click_element o type_text con su cascada de selectores, su cadencia humana y coordenadas normalizadas opcionales.',
    payloadFields: ['actionId', 'toolName', 'selectorCascade', 'textToType', 'bboxNorm', 'stepIndex'],
  },
  {
    frameType: 'tool.execution.ack',
    direction: 'client_to_server',
    summary: 'Confirmación de ejecución devuelta por el cliente: status, durationMs y el selector resuelto real para cerrar el ciclo de la acción física.',
    payloadFields: ['actionId', 'status', 'durationMs', 'resolvedSelector', 'errorMessage'],
  },
  {
    frameType: 'voice.barge_in',
    direction: 'client_to_server',
    summary: 'Interrupción del usuario: el detector local del cliente señala que la persona empezó a hablar para cortar de inmediato la respuesta del asistente en curso.',
    payloadFields: ['interruptedResponseId', 'detectedAtIso', 'vadConfidence'],
  },
];

/** Convierte una marca temporal ISO en milisegundos numéricos (0 si es inválida). */
function toTimestampMillis(timestampIso: string): number {
  const parsed = Date.parse(timestampIso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Devuelve una copia de la bitácora ordenada de la trama más reciente a la más antigua. */
function orderFramesMostRecentFirst(
  frames: readonly SandboxWsFrameLogEntry[],
): readonly SandboxWsFrameLogEntry[] {
  return [...frames].sort(
    (left, right) => toTimestampMillis(right.timestampIso) - toTimestampMillis(left.timestampIso),
  );
}

/** Formatea la marca temporal como `HH:MM:SS.mmm` en la zona local del navegador. */
function formatFrameTimestamp(timestampIso: string): string {
  const parsed = new Date(timestampIso);
  if (Number.isNaN(parsed.getTime())) return timestampIso;
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const seconds = String(parsed.getSeconds()).padStart(2, '0');
  const milliseconds = String(parsed.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/** Badge mono con la dirección de la trama en tono claro. */
function DirectionBadge(props: { readonly direction: SandboxFrameDirection; readonly compact?: boolean }): ReactElement {
  const meta = FRAME_DIRECTION_META[props.direction];
  return (
    <span
      className="atelier-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '11px',
        color: meta.color,
        fontWeight: 600,
      }}
      title={meta.label}
    >
      <span>{meta.arrow}</span>
      {props.compact ? null : <span>{meta.label}</span>}
    </span>
  );
}

/** Sección colapsable del catálogo de tramas. */
function ProtocolFrameSection(props: {
  readonly entry: WsProtocolFrameCatalogEntry;
  readonly isExpanded: boolean;
  readonly onToggle: (frameType: string) => void;
}): ReactElement {
  const { entry, isExpanded, onToggle } = props;
  return (
    <div
      style={{
        borderRadius: '4px',
        border: '1px solid var(--color-stone, #cdcdc9)',
        backgroundColor: isExpanded ? 'var(--color-linen, #e6e5e0)' : 'var(--color-bone, #f2f1ed)',
        overflow: 'hidden',
        transition: 'background-color 120ms ease',
      }}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={(): void => onToggle(entry.frameType)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '10px', color: 'var(--color-ash, #7a7974)' }}>
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className="atelier-mono" style={{ flex: 1, fontSize: '12px', color: 'var(--color-ink, #26251e)', fontWeight: 500 }}>
          {entry.frameType}
        </span>
        <DirectionBadge direction={entry.direction} compact />
      </button>
      {isExpanded ? (
        <div style={{ padding: '0 12px 10px 24px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.45, color: 'var(--color-driftwood, #84847e)' }}>
            {entry.summary}
          </p>
          <p className="atelier-mono" style={{ margin: 0, fontSize: '11px', color: 'var(--color-ash, #7a7974)' }}>
            {`campos: ${entry.payloadFields.join(' · ')}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Visor de JSON crudo con botón copiable en estética claro editorial. */
function RawJsonBlock(props: { readonly label: string; readonly code: string }): ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const handleCopy = useCallback((): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(props.code).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }, [props.code]);

  return (
    <div style={{ backgroundColor: 'var(--color-parchment, #f7f7f4)', border: '1px solid var(--color-stone, #cdcdc9)', borderRadius: '4px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="atelier-eyebrow" style={{ fontSize: '11px' }}>{props.label}</span>
        <button type="button" onClick={handleCopy} className="atelier-terminal__copy" style={{ fontSize: '11px', padding: '2px 8px' }}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre
        className="atelier-mono atelier-scrollarea"
        style={{
          margin: 0,
          maxHeight: '180px',
          overflowY: 'auto',
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          fontSize: '11.5px',
          lineHeight: 1.4,
          color: 'var(--color-ink, #26251e)',
          whiteSpace: 'pre',
          wordBreak: 'normal',
        }}
      >
        {props.code}
      </pre>
    </div>
  );
}

/** Props del panel izquierdo de especificación e inspector del protocolo. */
export interface ApiAndProtocolSpecViewerProps {
  readonly frames: readonly SandboxWsFrameLogEntry[];
  readonly selectedFrameId: string | null;
  readonly onSelectFrame: (id: string) => void;
}

/**
 * Panel izquierdo del Sandbox: catálogo colapsable del protocolo e inspector en vivo
 * de tramas con telemetría de latencias sobre superficie Bone #f2f1ed.
 */
export function ApiAndProtocolSpecViewer(props: ApiAndProtocolSpecViewerProps): ReactElement {
  const { frames, selectedFrameId, onSelectFrame } = props;
  const [expandedFrameType, setExpandedFrameType] = useState<string | null>(null);

  const orderedFrames = useMemo((): readonly SandboxWsFrameLogEntry[] => {
    return orderFramesMostRecentFirst(frames);
  }, [frames]);

  const selectedFrame = useMemo((): SandboxWsFrameLogEntry | null => {
    if (selectedFrameId === null) return null;
    return orderedFrames.find((frame) => frame.id === selectedFrameId) ?? null;
  }, [orderedFrames, selectedFrameId]);

  const handleToggleFrameSection = useCallback((frameType: string): void => {
    setExpandedFrameType((current) => (current === frameType ? null : frameType));
  }, []);

  return (
    <article
      className="atelier-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: '4px',
        padding: '14px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <p className="atelier-eyebrow" style={{ margin: 0 }}>Protocolo de Voz Realtime</p>
        <MonoMetadataTag label="Tramas" value={String(orderedFrames.length)} tone="neutral" />
      </header>

      {/* Catálogo colapsable */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <p className="atelier-eyebrow" style={{ fontSize: '11px', margin: 0 }}>Especificación del protocolo</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {WS_PROTOCOL_FRAME_CATALOG.map((entry) => (
            <ProtocolFrameSection
              key={entry.frameType}
              entry={entry}
              isExpanded={expandedFrameType === entry.frameType}
              onToggle={handleToggleFrameSection}
            />
          ))}
        </div>
      </section>

      <hr className="atelier-divider" style={{ margin: '4px 0' }} />

      {/* Inspector en vivo */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p className="atelier-eyebrow" style={{ fontSize: '11px', margin: 0 }}>Inspector en vivo</p>
          <span className="atelier-mono" style={{ fontSize: '11px', color: 'var(--color-ash, #7a7974)' }}>
            {orderedFrames.length} recibidas
          </span>
        </div>

        {orderedFrames.length === 0 ? (
          <p className="atelier-help-text" style={{ margin: 0, padding: '12px', textAlign: 'center', backgroundColor: 'var(--color-linen, #e6e5e0)', borderRadius: '4px' }}>
            Aún no hay tramas. Dispara una acción en el panel de control.
          </p>
        ) : (
          <ul
            className="atelier-scrollarea"
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              maxHeight: '200px',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {orderedFrames.map((frame) => {
              const isSelected = frame.id === selectedFrameId;
              return (
                <li key={frame.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={(): void => onSelectFrame(frame.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: `1px solid ${isSelected ? 'var(--color-ink, #26251e)' : 'var(--color-stone, #cdcdc9)'}`,
                      backgroundColor: isSelected ? 'var(--color-linen, #e6e5e0)' : 'var(--color-bone, #f2f1ed)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background-color 100ms ease, border-color 100ms ease',
                    }}
                  >
                    <DirectionBadge direction={frame.direction} compact />
                    <span className="atelier-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: 'var(--color-ink, #26251e)' }}>
                      {frame.frameType}
                    </span>
                    {frame.latencyMs !== undefined ? (
                      <span
                        className="atelier-mono"
                        style={{
                          fontSize: '11px',
                          padding: '1px 5px',
                          borderRadius: '3px',
                          backgroundColor: 'var(--color-linen, #e6e5e0)',
                          color: 'var(--color-ink, #26251e)',
                        }}
                      >
                        {`${frame.latencyMs} ms`}
                      </span>
                    ) : null}
                    <span className="atelier-mono" style={{ fontSize: '11px', color: 'var(--color-ash, #7a7974)' }}>
                      {formatFrameTimestamp(frame.timestampIso)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selectedFrame !== null ? (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <p className="atelier-mono" style={{ margin: 0, fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
              {`vista previa: ${selectedFrame.payloadPreview}`}
            </p>
            <RawJsonBlock
              key={selectedFrame.id}
              label={`trama · ${selectedFrame.frameType}`}
              code={selectedFrame.rawJson}
            />
          </div>
        ) : null}
      </section>
    </article>
  );
}
