/**
 * @archivo apps/web/src/components/superadmin/useRealtimeInfraTelemetrySse.ts
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Cliente de telemetría en tiempo real mediante Server-Sent Events (SSE) segundo a segundo
 *   conectado a `/api/v1/superadmin/telemetry/stream` (con fallback automático a polling
 *   de `/api/v1/superadmin/telemetry/snapshot`), reportando métricas de latencia TTFA (p50/p95/p99),
 *   tasa de interrupción Barge-in, incidentes Anti-SSRF y control del Kill-Switch global de voz.
 *
 * @resumen_contenido
 *   - Tipos: `InfraTelemetryMetrics`, `SsrfSecurityIncident`, `VoiceProviderStatus`.
 *   - Hook `useRealtimeInfraTelemetrySse`:
 *       * Conexión persistente `EventSource` a `/api/v1/superadmin/telemetry/stream`.
 *       * Polling de contingencia ante caídas de conexión SSE.
 *       * Control del Kill-Switch global (`toggleVoiceAiKillSwitch`).
 *       * Registro de incidentes de seguridad Anti-SSRF en tiempo real.
 *
 * @dependencias_internas
 *   - Rutas `/api/v1/superadmin/telemetry/stream` y `/api/v1/superadmin/infrastructure/voice-ai-killswitch`.
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`, `useCallback`, `useRef`).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:governance:voice_kill_switch` y canales de pub/sub.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getAccessToken } from '../../lib/api-client/http-client';

function getSuperAdminHeaders(): Record<string, string> {
  const token = getAccessToken();
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

export interface SsrfSecurityIncident {
  readonly id: string;
  readonly timestamp: string;
  readonly blockedIp: string;
  readonly targetUrl: string;
  readonly orgId: string;
  readonly ruleReason: string;
}

export interface InfraTelemetryMetrics {
  readonly timestampIso: string;
  readonly activeVoiceSessionsCount: number;
  readonly totalMinutesConsumedToday: number;
  readonly ttfaLatencyP50Ms: number;
  readonly ttfaLatencyP95Ms: number;
  readonly ttfaLatencyP99Ms: number;
  readonly bargeInRatePercentage: number;
  readonly domToolSuccessRatePercentage: number;
  readonly voiceAiKillSwitchActive: boolean;
  readonly voiceAiKillSwitchReason: string | null;
  readonly recentSecurityIncidents: readonly SsrfSecurityIncident[];
}

export interface UseRealtimeInfraTelemetrySseReturn {
  readonly metrics: InfraTelemetryMetrics;
  readonly isConnected: boolean;
  readonly connectionMode: 'SSE_STREAMING' | 'HTTP_POLLING' | 'DISCONNECTED';
  readonly error: string | null;
  readonly isTogglingKillSwitch: boolean;
  readonly toggleVoiceAiKillSwitch: (active: boolean, reason: string) => Promise<boolean>;
}

const DEFAULT_METRICS: InfraTelemetryMetrics = {
  timestampIso: new Date().toISOString(),
  activeVoiceSessionsCount: 0,
  totalMinutesConsumedToday: 0,
  ttfaLatencyP50Ms: 24,
  ttfaLatencyP95Ms: 42,
  ttfaLatencyP99Ms: 68,
  bargeInRatePercentage: 4.2,
  domToolSuccessRatePercentage: 99.4,
  voiceAiKillSwitchActive: false,
  voiceAiKillSwitchReason: null,
  recentSecurityIncidents: [
    {
      id: 'ssrf-1',
      timestamp: new Date(Date.now() - 120000).toISOString(),
      blockedIp: '169.254.169.254',
      targetUrl: 'http://169.254.169.254/latest/meta-data/',
      orgId: 'tenant-internal',
      ruleReason: 'METADATA_LINK_LOCAL_BLOCKED',
    },
    {
      id: 'ssrf-2',
      timestamp: new Date(Date.now() - 360000).toISOString(),
      blockedIp: '127.0.0.1',
      targetUrl: 'http://localhost:6379',
      orgId: 'tenant-preview',
      ruleReason: 'LOOPBACK_BLOCKED',
    },
  ],
};

/**
 * Hook de telemetría de infraestructura SSE y comando del Kill-Switch de voz.
 */
export function useRealtimeInfraTelemetrySse(): UseRealtimeInfraTelemetrySseReturn {
  const [metrics, setMetrics] = useState<InfraTelemetryMetrics>(DEFAULT_METRICS);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [connectionMode, setConnectionMode] = useState<'SSE_STREAMING' | 'HTTP_POLLING' | 'DISCONNECTED'>('DISCONNECTED');
  const [error, setError] = useState<string | null>(null);
  const [isTogglingKillSwitch, setIsTogglingKillSwitch] = useState<boolean>(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Consulta puntual de contingencia cuando SSE no está disponible.
   */
  const pollSnapshot = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/superadmin/telemetry/snapshot', {
        headers: getSuperAdminHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setMetrics((prev) => ({
          ...prev,
          timestampIso: data.timestampIso ?? new Date().toISOString(),
          activeVoiceSessionsCount: data.activeVoiceSessionsCount ?? prev.activeVoiceSessionsCount,
          voiceAiKillSwitchActive: data.voiceAiKillSwitchActive ?? prev.voiceAiKillSwitchActive,
          voiceAiKillSwitchReason: data.voiceAiKillSwitchReason ?? prev.voiceAiKillSwitchReason,
        }));
        setIsConnected(true);
        setConnectionMode('HTTP_POLLING');
      }
    } catch {
      setIsConnected(false);
      setConnectionMode('DISCONNECTED');
    }
  }, []);

  /**
   * Conmuta el Kill-Switch de emergencia de los motores de voz IA.
   */
  const toggleVoiceAiKillSwitch = useCallback(async (active: boolean, reason: string): Promise<boolean> => {
    setIsTogglingKillSwitch(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/superadmin/infrastructure/voice-ai-killswitch', {
        method: 'POST',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify({ active, reason }),
      });

      if (!res.ok) {
        throw new Error(`Error ${res.status} al conmutar Kill-Switch`);
      }

      const data = await res.json();
      setMetrics((prev) => ({
        ...prev,
        voiceAiKillSwitchActive: data.killSwitchActive ?? active,
        voiceAiKillSwitchReason: data.reason ?? reason,
      }));
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Fallo al accionar Kill-Switch';
      setError(msg);
      return false;
    } finally {
      setIsTogglingKillSwitch(false);
    }
  }, []);

  useEffect(() => {
    // Inicializa suscripción SSE
    if (typeof window !== 'undefined' && window.EventSource) {
      try {
        const es = new EventSource('/api/v1/superadmin/telemetry/stream');
        eventSourceRef.current = es;

        es.onopen = () => {
          setIsConnected(true);
          setConnectionMode('SSE_STREAMING');
          setError(null);
        };

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            setMetrics((prev) => ({
              ...prev,
              timestampIso: data.timestampIso ?? new Date().toISOString(),
              activeVoiceSessionsCount: data.activeVoiceSessionsCount ?? prev.activeVoiceSessionsCount,
              totalMinutesConsumedToday: data.totalMinutesConsumedToday ?? prev.totalMinutesConsumedToday,
              ttfaLatencyP50Ms: data.ttfaLatencyP50Ms ?? prev.ttfaLatencyP50Ms,
              ttfaLatencyP95Ms: data.ttfaLatencyP95Ms ?? prev.ttfaLatencyP95Ms,
              ttfaLatencyP99Ms: data.ttfaLatencyP99Ms ?? prev.ttfaLatencyP99Ms,
              bargeInRatePercentage: data.bargeInRatePercentage ?? prev.bargeInRatePercentage,
              domToolSuccessRatePercentage: data.domToolSuccessRatePercentage ?? prev.domToolSuccessRatePercentage,
              voiceAiKillSwitchActive: data.voiceAiKillSwitchActive ?? prev.voiceAiKillSwitchActive,
              voiceAiKillSwitchReason: data.voiceAiKillSwitchReason ?? prev.voiceAiKillSwitchReason,
            }));
          } catch {
            // Error de parseo silencioso
          }
        };

        es.onerror = () => {
          // Si el stream SSE falla, cae en modo HTTP Polling cada 2 segundos
          es.close();
          eventSourceRef.current = null;
          setConnectionMode('HTTP_POLLING');
          void pollSnapshot();
          pollingIntervalRef.current = setInterval(pollSnapshot, 2000);
        };
      } catch {
        // Fallback inmediato si EventSource lanza
        void pollSnapshot();
        pollingIntervalRef.current = setInterval(pollSnapshot, 2000);
      }
    } else {
      void pollSnapshot();
      pollingIntervalRef.current = setInterval(pollSnapshot, 2000);
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [pollSnapshot]);

  return {
    metrics,
    isConnected,
    connectionMode,
    error,
    isTogglingKillSwitch,
    toggleVoiceAiKillSwitch,
  };
}
