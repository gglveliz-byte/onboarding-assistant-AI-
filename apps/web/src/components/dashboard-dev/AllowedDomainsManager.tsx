/**
 * @archivo apps/web/src/components/dashboard-dev/AllowedDomainsManager.tsx
 * @modulo 08-frontend-dashboard-dev (Gestor de Dominios y Orígenes CORS Autorizados)
 * @proposito
 *   Administra la lista de orígenes permitidos (`allowed_domains`) requeridos por el
 *   Handshake seguro del SDK Web (`POST /api/v1/sdk/handshake`). Bloquea en cliente
 *   y visualmente cualquier intento de registrar `http://localhost` o IPs de loopback
 *   cuando el proyecto opera en modo `LIVE`.
 *
 * @resumen_contenido
 *   - Formulario de alta con validación de URL/patrón de origen y advertencia anti-localhost.
 *   - Tabla de orígenes configurados (sm+) y tarjetas táctiles con acción de revocación en móvil.
 *   - Botón de eliminación de dominios (`btn_delete_domain`).
 *   - Indicador de políticas de seguridad para el Handshake del SDK.
 *
 * @dependencias_internas
 *   - `AllowedDomainItem`, `useAllowedDomains` (./useProjectsAndApiKeys.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `allowed_domains`.
 *   - Redis: `oa:proj:<id>:allowed_domains`.
 */

'use client';

import React, { useState } from 'react';
import type { AllowedDomainItem, ProjectEnvironment } from './useProjectsAndApiKeys';

export interface AllowedDomainsManagerProps {
  readonly projectId: string;
  readonly environment: ProjectEnvironment;
  readonly domains: readonly AllowedDomainItem[];
  readonly onAddDomain: (originPattern: string, allowLocalhost: boolean, isLive: boolean) => Promise<unknown>;
  readonly onRemoveDomain: (domainId: string) => Promise<unknown>;
  readonly isReadOnly?: boolean;
}

export function AllowedDomainsManager({
  projectId,
  environment,
  domains,
  onAddDomain,
  onRemoveDomain,
  isReadOnly = false,
}: AllowedDomainsManagerProps) {
  const [newOrigin, setNewOrigin] = useState('');
  const [allowLocalhost, setAllowLocalhost] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLive = environment === 'LIVE';

  const validateOrigin = (pattern: string): string | null => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return 'El origen no puede estar vacío.';
    }

    if (isLive && (trimmed.includes('localhost') || trimmed.includes('127.0.0.1'))) {
      return 'RESTRICCIÓN DE SEGURIDAD: En proyectos LIVE está estrictamente prohibido autorizar localhost o 127.0.0.1.';
    }

    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://localhost')) {
      return 'Los orígenes de producción deben usar protocolo seguro (https://).';
    }

    return null;
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setSuccessBanner(null);

    const validationErr = validateOrigin(newOrigin);
    if (validationErr) {
      setErrorBanner(validationErr);
      return;
    }

    setIsSubmitting(true);
    try {
      await onAddDomain(newOrigin.trim(), allowLocalhost, isLive);
      setSuccessBanner(`Origen ${newOrigin.trim()} agregado exitosamente.`);
      setNewOrigin('');
      setAllowLocalhost(false);
      setTimeout(() => setSuccessBanner(null), 4000);
    } catch (err: any) {
      setErrorBanner(err.message || 'Error al registrar el origen.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="bg-[#f2f1ed] p-5 border border-[#cdcdc9] rounded space-y-5"
      style={{ borderRadius: '4px' }}
      data-testid="allowed-domains-manager"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-[#cdcdc9] pb-3">
        <div>
          <h2 className="text-sm font-sans font-medium text-[#26251e]">
            Orígenes Autorizados para Handshake del SDK
          </h2>
          <p className="text-xs font-sans text-[#84847e] mt-0.5">
            Solo las aplicaciones web servidas desde estos dominios podrán inicializar el asistente de voz.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[#84847e]">Modo:</span>
          <span
            className={`px-2 py-0.5 text-[10px] font-mono rounded ${
              isLive ? 'bg-[#34785c]/10 text-[#34785c] border border-[#34785c]/30' : 'bg-[#c08532]/10 text-[#c08532] border border-[#c08532]/30'
            }`}
            style={{ borderRadius: '4px' }}
          >
            {environment}
          </span>
        </div>
      </div>

      {errorBanner && (
        <div
          className="p-3 text-xs font-sans bg-[#cf2d56]/10 text-[#cf2d56] border border-[#cf2d56]/40 rounded flex items-center gap-2"
          style={{ borderRadius: '4px' }}
        >
          <span>✕</span>
          <span>{errorBanner}</span>
        </div>
      )}

      {successBanner && (
        <div
          className="p-3 text-xs font-sans bg-[#1f8a65]/10 text-[#1f8a65] border border-[#1f8a65]/40 rounded flex items-center gap-2"
          style={{ borderRadius: '4px' }}
        >
          <span>✓</span>
          <span>{successBanner}</span>
        </div>
      )}

      {/* Formulario de Adición de Dominio */}
      {!isReadOnly && (
        <form onSubmit={handleAddSubmit} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              placeholder="https://app.tuempresa.com o https://*.tuempresa.com"
              value={newOrigin}
              onChange={(e) => {
                setNewOrigin(e.target.value);
                if (errorBanner) setErrorBanner(null);
              }}
              className="flex-1 px-3 py-1.5 text-xs font-mono bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] placeholder:text-[#a1a19f] focus:outline-none focus:border-[#26251e]"
              style={{ borderRadius: '4px' }}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              disabled={isSubmitting || !newOrigin.trim()}
              className="px-4 py-1.5 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] disabled:opacity-40 rounded transition-colors whitespace-nowrap"
              style={{ borderRadius: '4px' }}
            >
              {isSubmitting ? 'Guardando...' : 'Autorizar Dominio'}
            </button>
          </div>

          {!isLive && (
            <label className="flex items-center gap-2 text-xs text-[#84847e] font-sans cursor-pointer">
              <input
                type="checkbox"
                checked={allowLocalhost}
                onChange={(e) => setAllowLocalhost(e.target.checked)}
                className="rounded border-[#cdcdc9] accent-[#34785c] focus:ring-0"
              />
              <span>Habilitar pruebas en entorno local (`http://localhost:3000`) para este origen</span>
            </label>
          )}

          {isLive && (
            <div className="text-[11px] text-[#84847e] font-sans flex items-center gap-1.5">
              <span className="text-[#34785c]">🛡</span>
              <span>Protección activa: Los orígenes `localhost` están bloqueados permanentemente en el entorno LIVE.</span>
            </div>
          )}
        </form>
      )}

      {/* Vista Móvil (< sm): Tarjetas táctiles con acción Revocar siempre accesible */}
      <div className="sm:hidden space-y-2" data-testid="allowed-domains-mobile-cards">
        {domains.length === 0 ? (
          <div
            className="p-5 text-center text-xs font-sans text-[#84847e] bg-[#f7f7f4] border border-[#cdcdc9] rounded"
            style={{ borderRadius: '4px' }}
          >
            No hay dominios autorizados. El SDK rechazará las peticiones hasta que configures un origen.
          </div>
        ) : (
          domains.map((dom) => {
            const isWildcard = dom.originPattern.includes('*');
            return (
              <div
                key={dom.id}
                className="p-3.5 bg-[#f7f7f4] border border-[#cdcdc9] rounded space-y-2 shadow-xs"
                style={{ borderRadius: '4px' }}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex items-start gap-1.5 font-mono text-xs text-[#26251e] break-all min-w-0">
                    <span className="text-[#34785c]">●</span>
                    <span>{dom.originPattern}</span>
                  </span>
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`¿Revocar acceso al origen ${dom.originPattern}?`)) {
                          onRemoveDomain(dom.id);
                        }
                      }}
                      className="px-2 py-1 text-[11px] font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/30 rounded transition-colors flex-shrink-0"
                      style={{ borderRadius: '4px' }}
                      title="Revocar origen"
                    >
                      Revocar
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-[#84847e]">
                  <span className="px-2 py-0.5 bg-[#e6e5e0] text-[#7a7974] rounded" style={{ borderRadius: '3px' }}>
                    {isWildcard ? 'Comodín (Subdominios)' : 'Exacto'}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{dom.createdAtIso.split('T')[0]}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Lista de Dominios Autorizados (sm+): tabla con scroll horizontal suave */}
      <div className="hidden sm:block border border-[#cdcdc9] rounded overflow-x-auto bg-[#f7f7f4]" style={{ borderRadius: '4px' }}>
        <table className="w-full min-w-[480px] text-left text-xs font-sans">
          <thead className="bg-[#e6e5e0]/70 text-[#84847e] border-b border-[#cdcdc9]">
            <tr>
              <th className="px-4 py-2 font-normal">Patrón de Origen Permitido</th>
              <th className="px-4 py-2 font-normal">Tipo</th>
              <th className="px-4 py-2 font-normal">Fecha Registro</th>
              {!isReadOnly && <th className="px-4 py-2 font-normal text-right">Acción</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#cdcdc9]">
            {domains.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[#84847e] font-sans">
                  No hay dominios autorizados. El SDK rechazará las peticiones hasta que configures un origen.
                </td>
              </tr>
            ) : (
              domains.map((dom) => {
                const isWildcard = dom.originPattern.includes('*');
                return (
                  <tr key={dom.id} className="hover:bg-[#e6e5e0]/20 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-[#26251e]">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[#34785c]">●</span>
                        <span>{dom.originPattern}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className="px-2 py-0.5 text-[10px] font-mono bg-[#e6e5e0] text-[#7a7974] rounded"
                        style={{ borderRadius: '3px' }}
                      >
                        {isWildcard ? 'Comodín (Subdominios)' : 'Exacto'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[#84847e]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {dom.createdAtIso.split('T')[0]}
                    </td>
                    {!isReadOnly && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`¿Revocar acceso al origen ${dom.originPattern}?`)) {
                              onRemoveDomain(dom.id);
                            }
                          }}
                          className="px-2 py-0.5 text-[11px] font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/30 rounded transition-colors"
                          style={{ borderRadius: '4px' }}
                          title="Revocar origen"
                        >
                          Revocar
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
