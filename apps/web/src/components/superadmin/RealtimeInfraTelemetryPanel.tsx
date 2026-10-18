/**
 * @archivo apps/web/src/components/superadmin/RealtimeInfraTelemetryPanel.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Panel de telemetría de infraestructura en tiempo real (Cursor Atelier Light) que
 *   monitorea latencias TTFA (p50/p95/p99), tasa de interrupción Barge-in, incidentes
 *   del escudo Anti-SSRF en Crimson (`#cf2d56`) y botón de conmutación en caliente / Kill-Switch.
 *
 * @resumen_contenido
 *   - Componente `RealtimeInfraTelemetryPanel`:
 *       * Tarjetas de latencia acústica TTFA p50, p95 y p99 con números tabulares (`tnum`).
 *       * Estado del Kill-Switch global con botón de corte inmediato `<AtelierCrimsonDangerButton />`.
 *       * Tabla de intentos de conexión hostil bloqueados por el escudo Anti-SSRF (DNS Pinning).
 *       * Indicador del modo de transporte (SSE Streaming vs Polling).
 *
 * @dependencias_internas
 *   - `InfraTelemetryMetrics` de `useRealtimeInfraTelemetrySse.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Muestra métricas de telemetría y estado de `oa:governance:voice_kill_switch` en Redis.
 */

import React, { ReactElement, useState } from 'react';
import type { InfraTelemetryMetrics } from './useRealtimeInfraTelemetrySse';

export interface RealtimeInfraTelemetryPanelProps {
  readonly metrics: InfraTelemetryMetrics;
  readonly isConnected: boolean;
  readonly connectionMode: 'SSE_STREAMING' | 'HTTP_POLLING' | 'DISCONNECTED';
  readonly isTogglingKillSwitch: boolean;
  readonly onToggleKillSwitch: (active: boolean, reason: string) => Promise<boolean>;
}

/**
 * Panel de telemetría de infraestructura y conmutador de emergencia.
 */
export function RealtimeInfraTelemetryPanel({
  metrics,
  isConnected,
  connectionMode,
  isTogglingKillSwitch,
  onToggleKillSwitch,
}: RealtimeInfraTelemetryPanelProps): ReactElement {
  const [killSwitchReasonInput, setKillSwitchReasonInput] = useState<string>('Mantenimiento no programado');

  const handleToggle = async () => {
    const nextState = !metrics.voiceAiKillSwitchActive;
    const actionLabel = nextState ? 'ACTIVAR CORTE TOTAL (KILL-SWITCH)' : 'REANUDAR TRÁFICO DE VOZ';
    const confirmed = window.confirm(
      `¿Está completamente seguro de ${actionLabel}?\n\nMotivo: ${killSwitchReasonInput}`
    );
    if (!confirmed) return;
    await onToggleKillSwitch(nextState, killSwitchReasonInput);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Barra de Estado de Conexión en Vivo */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '12px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              display: 'inline-block',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isConnected ? 'var(--color-forest, #34785c)' : 'var(--color-crimson, #cf2d56)',
            }}
          />
          <span style={{ fontSize: '13px', fontWeight: 500 }}>
            Telemetría de Infraestructura: {isConnected ? 'Sincronizado en Vivo' : 'Reconectando...'}
          </span>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              backgroundColor: 'var(--color-linen, #e6e5e0)',
              padding: '2px 6px',
              borderRadius: '3px',
              color: 'var(--color-driftwood, #84847e)',
            }}
          >
            {connectionMode}
          </span>
        </div>

        <span
          style={{
            fontSize: '11px',
            fontFamily: 'var(--font-berkeleymono, monospace)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--color-driftwood, #84847e)',
          }}
        >
          Último pulso: {new Date(metrics.timestampIso).toLocaleTimeString()}
        </span>
      </div>

      {/* Grid de Métricas de Latencia y Sesiones */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
        }}
      >
        {/* Métrica 1: Sesiones de Voz Concurrentes */}
        <div
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '18px',
          }}
        >
          <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Sesiones WebSocket Activas
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '26px',
              fontWeight: 500,
              color: 'var(--color-ink, #26251e)',
            }}
          >
            {metrics.activeVoiceSessionsCount}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-forest, #34785c)' }}>
            Capacidad operativa en parámetros normales
          </span>
        </div>

        {/* Métrica 2: Latencias TTFA (p50 / p95 / p99) */}
        <div
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '18px',
          }}
        >
          <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Latencia Acústica TTFA (p50 / p95 / p99)
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '22px',
              fontWeight: 500,
              color: 'var(--color-forest, #34785c)',
            }}
          >
            {metrics.ttfaLatencyP50Ms}ms / {metrics.ttfaLatencyP95Ms}ms / {metrics.ttfaLatencyP99Ms}ms
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            Tiempo de primer byte de audio decodificado
          </span>
        </div>

        {/* Métrica 3: Tasa de Interrupción Barge-in */}
        <div
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '18px',
          }}
        >
          <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Tasa de Interrupción (Barge-in)
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '26px',
              fontWeight: 500,
              color: 'var(--color-ink, #26251e)',
            }}
          >
            {metrics.bargeInRatePercentage}%
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            Cancelaciones limpias en RAM &lt;50ms
          </span>
        </div>

        {/* Métrica 4: Éxito de Automatización DOM */}
        <div
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '18px',
          }}
        >
          <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Éxito Despacho DOM (click/type)
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '26px',
              fontWeight: 500,
              color: 'var(--color-forest, #34785c)',
            }}
          >
            {metrics.domToolSuccessRatePercentage}%
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            Acciones confirmadas con tool.execution.ack
          </span>
        </div>
      </div>

      {/* Módulo Kill-Switch de Emergencia */}
      <section
        aria-labelledby="killswitch-title"
        style={{
          backgroundColor: metrics.voiceAiKillSwitchActive ? 'rgba(207, 45, 86, 0.08)' : 'var(--color-bone, #f2f1ed)',
          border: `2px solid ${metrics.voiceAiKillSwitchActive ? 'var(--color-crimson, #cf2d56)' : 'var(--color-stone, #cdcdc9)'}`,
          borderRadius: '4px',
          padding: '24px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  color: metrics.voiceAiKillSwitchActive ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                ● ESTADO DEL KILL-SWITCH: {metrics.voiceAiKillSwitchActive ? 'ACTIVADO (TRÁFICO BLOQUEADO)' : 'INACTIVO (TRÁFICO PERMITIDO)'}
              </span>
            </div>
            <h3 id="killswitch-title" style={{ fontSize: '18px', fontWeight: 400, margin: '0 0 6px' }}>
              Kill-Switch Global de Motores de Voz IA
            </h3>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)', maxWidth: '650px' }}>
              Al activar esta palanca de emergencia, la plataforma rechaza inmediatamente nuevas conexiones WebSocket
              en el plano de voz y desconecta las sesiones activas en todos los Node Pools, preservando el aislamiento
              de seguridad de la plataforma.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
            <input
              type="text"
              placeholder="Motivo de la conmutación..."
              value={killSwitchReasonInput}
              onChange={(e) => setKillSwitchReasonInput(e.target.value)}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid var(--color-stone, #cdcdc9)',
                backgroundColor: 'var(--color-parchment, #f7f7f4)',
                width: '260px',
              }}
            />
            <button
              type="button"
              onClick={handleToggle}
              disabled={isTogglingKillSwitch}
              style={{
                backgroundColor: metrics.voiceAiKillSwitchActive ? 'var(--color-forest, #34785c)' : 'var(--color-crimson, #cf2d56)',
                border: `1px solid ${metrics.voiceAiKillSwitchActive ? 'var(--color-forest, #34785c)' : 'var(--color-crimson, #cf2d56)'}`,
                color: 'var(--color-parchment, #f7f7f4)',
                borderRadius: '4px',
                padding: '10px 18px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: isTogglingKillSwitch ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {isTogglingKillSwitch
                ? 'Conmutando...'
                : metrics.voiceAiKillSwitchActive
                ? 'Reanudar Tráfico de Voz'
                : 'Accionar Kill-Switch de Voz'}
            </button>
          </div>
        </div>
      </section>

      {/* Tabla de Alertas del Escudo Anti-SSRF en Crimson */}
      <section
        aria-labelledby="ssrf-alerts-title"
        style={{
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '24px',
        }}
      >
        <div style={{ marginBottom: '16px' }}>
          <h3 id="ssrf-alerts-title" style={{ fontSize: '18px', fontWeight: 400, margin: 0 }}>
            Incidentes Bloqueados por el Escudo Anti-SSRF (DNS Pinning)
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Intentos de resolución hacia IPs privadas (RFC 1918), loopback (127.0.0.1) o metadatos cloud (169.254.169.254)
            bloqueados implacablemente antes de abrir sockets TCP.
          </p>
        </div>

        <div
          style={{
            overflowX: 'auto',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--color-linen, #e6e5e0)', borderBottom: '1px solid var(--color-stone, #cdcdc9)' }}>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Fecha / Hora</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>IP Bloqueada</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>URL Destino Solicitada</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Regla de Defensa</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Tenant</th>
              </tr>
            </thead>
            <tbody>
              {metrics.recentSecurityIncidents.map((incident) => (
                <tr
                  key={incident.id}
                  style={{ borderBottom: '1px solid color-mix(in oklab, #26251e 6%, transparent)' }}
                >
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--font-berkeleymono, monospace)' }}>
                    {new Date(incident.timestamp).toLocaleTimeString()}
                  </td>
                  <td
                    style={{
                      padding: '8px 12px',
                      fontFamily: 'var(--font-berkeleymono, monospace)',
                      fontWeight: 600,
                      color: 'var(--color-crimson, #cf2d56)',
                    }}
                  >
                    {incident.blockedIp}
                  </td>
                  <td
                    style={{
                      padding: '8px 12px',
                      fontFamily: 'var(--font-berkeleymono, monospace)',
                      color: 'var(--color-ink, #26251e)',
                    }}
                  >
                    {incident.targetUrl}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span
                      style={{
                        fontSize: '10px',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        backgroundColor: 'rgba(207, 45, 86, 0.1)',
                        color: 'var(--color-crimson, #cf2d56)',
                        fontWeight: 600,
                      }}
                    >
                      {incident.ruleReason}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-driftwood, #84847e)' }}>
                    {incident.orgId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
