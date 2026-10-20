/**
 * @archivo apps/web/src/components/superadmin/PublicDemoConfigPanel.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Panel de gobierno de la DEMOSTRACIÓN PÚBLICA de la landing: permite al SuperAdmin fijar la duración
 *   máxima de cada demo (segundos) y cuántas demos permite por IP al día, reemplazando el antiguo
 *   hardcodeo (90 s / 2 por IP). Lee y escribe `GET|PUT /api/v1/superadmin/public-demo-config` (Redis
 *   `oa:demo:config`). Los cambios se aplican a las siguientes sesiones, no a las ya abiertas.
 *
 * @resumen_contenido
 *   - `PublicDemoConfigPanel`: formulario de dos campos con carga inicial, guardado y estados.
 *
 * @dependencias_internas
 *   - `getAccessToken`/`setAccessToken` (`../../lib/api-client/http-client`).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`, `ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Consume `GET`/`PUT /api/v1/superadmin/public-demo-config` → Redis `oa:demo:config`.
 */

'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { getAccessToken, setAccessToken } from '../../lib/api-client/http-client';

const CONFIG_ENDPOINT = '/api/v1/superadmin/public-demo-config';
const MIN_DURATION = 15;
const MAX_DURATION = 600;
const MIN_DEMOS = 1;
const MAX_DEMOS = 1000;

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function redirectToLogin(): void {
  setAccessToken(null);
  if (typeof window !== 'undefined') {
    const next = window.location.pathname + window.location.search;
    window.location.replace(`/internal/superadmin-login?next=${encodeURIComponent(next)}`);
  }
}

/**
 * Panel para gobernar duración y límite por IP de la demostración pública.
 */
export function PublicDemoConfigPanel(): ReactElement {
  const [duration, setDuration] = useState<number>(90);
  const [demos, setDemos] = useState<number>(2);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(CONFIG_ENDPOINT, { method: 'GET', headers: authHeaders(), credentials: 'include' });
      if (res.status === 401 || res.status === 403) { redirectToLogin(); return; }
      if (!res.ok) { setError(`No se pudo leer la configuración (HTTP ${res.status}).`); return; }
      const json = (await res.json()) as { maxDurationSeconds?: number; demosPerIpPerDay?: number };
      setDuration(json.maxDurationSeconds ?? 90);
      setDemos(json.demosPerIpPerDay ?? 2);
    } catch {
      setError('Fallo de red al consultar la configuración de la demo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onSave = async (): Promise<void> => {
    setSaving(true); setError(null); setSavedMessage(null);
    try {
      const res = await fetch(CONFIG_ENDPOINT, {
        method: 'PUT',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify({ maxDurationSeconds: duration, demosPerIpPerDay: demos }),
      });
      if (res.status === 401 || res.status === 403) { redirectToLogin(); return; }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        setError(`No se pudo guardar (HTTP ${res.status}). ${detail.slice(0, 140)}`);
        return;
      }
      const json = (await res.json()) as { maxDurationSeconds?: number; demosPerIpPerDay?: number };
      setDuration(json.maxDurationSeconds ?? duration);
      setDemos(json.demosPerIpPerDay ?? demos);
      setSavedMessage('Configuración guardada. Se aplica a las próximas demostraciones.');
    } catch {
      setError('Fallo de red al guardar la configuración de la demo.');
    } finally {
      setSaving(false);
    }
  };

  const invalid = duration < MIN_DURATION || duration > MAX_DURATION || demos < MIN_DEMOS || demos > MAX_DEMOS;
  const inputStyle = { width: '100%', padding: '10px 12px', fontSize: '14px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', background: '#ffffff', color: '#2f2e2a' } as const;
  const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--color-driftwood, #84847e)', textTransform: 'uppercase', marginBottom: '6px' } as const;

  return (
    <div style={{ border: '1px solid var(--color-stone, #cdcdc9)', borderRadius: '6px', background: 'var(--color-bone, #f2f1ed)', padding: '20px', maxWidth: '640px' }}>
      <div style={{ fontFamily: 'var(--font-berkeleymono, monospace)', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', textTransform: 'uppercase', marginBottom: '4px' }}>
        Gobierno / Demostración Pública
      </div>
      <h2 style={{ fontSize: '18px', fontWeight: 500, margin: '0 0 12px' }}>Duración y límite por IP de la demo</h2>

      {loading ? (
        <p style={{ color: 'var(--color-driftwood, #84847e)', fontSize: '13px' }}>Cargando configuración…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <label>
            <span style={labelStyle}>Duración máxima por demo (segundos)</span>
            <input
              type="number" min={MIN_DURATION} max={MAX_DURATION} step={5} value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              style={inputStyle}
            />
            <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>{MIN_DURATION}–{MAX_DURATION} s · {duration} s ≈ {(duration / 60).toFixed(1)} min</span>
          </label>

          <label>
            <span style={labelStyle}>Demostraciones permitidas por IP (cada 24 h)</span>
            <input
              type="number" min={MIN_DEMOS} max={MAX_DEMOS} step={1} value={demos}
              onChange={(e) => setDemos(Number(e.target.value))}
              style={inputStyle}
            />
            <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>{MIN_DEMOS}–{MAX_DEMOS} por IP al día</span>
          </label>

          {error && (
            <div role="alert" style={{ background: 'rgba(207,45,86,0.08)', border: '1px solid var(--color-crimson, #cf2d56)', borderRadius: '4px', padding: '10px', fontSize: '13px', color: 'var(--color-crimson, #cf2d56)' }}>{error}</div>
          )}
          {savedMessage && !error && (
            <div role="status" style={{ background: 'rgba(46,160,67,0.10)', border: '1px solid var(--color-forest, #2ea043)', borderRadius: '4px', padding: '10px', fontSize: '13px', color: 'var(--color-forest, #2ea043)' }}>{savedMessage}</div>
          )}

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button
              type="button" onClick={() => { void onSave(); }} disabled={saving || invalid}
              style={{ padding: '10px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '4px', border: 'none', cursor: invalid || saving ? 'not-allowed' : 'pointer', background: '#6d3dfa', color: '#ffffff', opacity: saving || invalid ? 0.6 : 1 }}
            >
              {saving ? 'Guardando…' : 'Guardar configuración'}
            </button>
            <button
              type="button" onClick={() => { setDuration(90); setDemos(2); setSavedMessage(null); }}
              style={{ padding: '10px 16px', fontSize: '13px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', background: '#ffffff', color: '#2f2e2a', cursor: 'pointer' }}
            >
              Restablecer a defectos (90 s / 2)
            </button>
          </div>
          {invalid && (
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-crimson, #cf2d56)' }}>
              Fuera de rango: duración {MIN_DURATION}–{MAX_DURATION} s y demos {MIN_DEMOS}–{MAX_DEMOS}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
