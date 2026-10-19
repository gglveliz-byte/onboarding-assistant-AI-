/**
 * @archivo apps/web/src/components/dashboard-dev/ApiKeyLifecycleManager.tsx
 * @modulo apps/web/src/components/dashboard-dev (Gestión Integral de API Keys y Métricas - Cursor Atelier)
 * @proposito
 *   Permite listar, crear, rotar con ventana de gracia y revocar claves criptográficas
 *   `pk_live_` y `sk_live_`. Integra tarjetas métricas de consumo en Bone (#f2f1ed),
 *   vista adaptativa dual (tarjetas táctiles compactas con botones WCAG de 40px en móvil
 *   y tabla con scroll suave en desktop), tokens oficiales Atelier y diálogo de revelación único.
 *
 * @resumen_contenido
 *   - Sección de Métricas: Carrusel snap horizontal en móvil, grid de 4 en desktop sobre Bone #f2f1ed.
 *   - Vista Móvil (`sm:hidden`): Tarjetas táctiles en #f2f1ed con botón de copiado rápido y acciones de 40px.
 *   - Vista Desktop (`hidden sm:block`): Tabla con scroll suave y números tabulares berkeleyMono.
 *   - Modales de ciclo de vida (`CreateApiKeyModal`, `RotateApiKeyModal`, `OneTimeSecretRevealDialog`).
 *
 * @dependencias_internas
 *   - `ApiKeyItem`, `CreatedApiKeyResult`, `GracePeriodHours`, `ProjectEnvironment` (./useProjectsAndApiKeys.ts).
 *   - `OneTimeSecretRevealDialog`, `OneTimeSecretRevealModal` (./OneTimeSecretRevealDialog.tsx).
 *   - `CreateApiKeyModal`, `RotateApiKeyModal` (./ApiKeyLifecycleModals.tsx).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `api_keys`.
 *   - Redis: `oa:apikey:sha256:<hash>`.
 */

'use client';

import React, { useState } from 'react';
import type { ApiKeyItem, CreatedApiKeyResult, GracePeriodHours, ProjectEnvironment } from './useProjectsAndApiKeys';
import { OneTimeSecretRevealDialog, OneTimeSecretRevealModal } from './OneTimeSecretRevealDialog';
import { CreateApiKeyModal, RotateApiKeyModal } from './ApiKeyLifecycleModals';

export { OneTimeSecretRevealDialog, OneTimeSecretRevealModal };

export interface ApiKeyLifecycleManagerProps {
  readonly projectId: string;
  readonly environment: ProjectEnvironment;
  readonly apiKeys: readonly ApiKeyItem[];
  readonly onCreateKey: (input: { name: string; keyType: 'pk' | 'sk'; environment: ProjectEnvironment; scopes: string[] }) => Promise<CreatedApiKeyResult>;
  readonly onRotateKey: (apiKeyId: string, gracePeriodHours: GracePeriodHours) => Promise<CreatedApiKeyResult>;
  readonly onRevokeKey: (apiKeyId: string) => Promise<unknown>;
  readonly isReadOnly?: boolean;
}

export function ApiKeyLifecycleManager({
  projectId: _projectId,
  environment,
  apiKeys,
  onCreateKey,
  onRotateKey,
  onRevokeKey,
  isReadOnly = false,
}: ApiKeyLifecycleManagerProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [rotatingKey, setRotatingKey] = useState<ApiKeyItem | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ raw: string; name: string } | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const activeKeysCount = apiKeys.filter((k) => !k.isRevoked).length;
  const secretKeysCount = apiKeys.filter((k) => k.keyType === 'sk' && !k.isRevoked).length;
  const publishableKeysCount = apiKeys.filter((k) => k.keyType === 'pk' && !k.isRevoked).length;

  // Último uso real registrado por la API (`last_used_at`); `null` si ninguna clave lo reporta.
  const usedAtValues = apiKeys
    .map((key) => key.lastUsedAtIso)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort();
  const lastUsedAtIso = usedAtValues.length > 0 ? usedAtValues[usedAtValues.length - 1] ?? null : null;

  const handleCreateSubmit = async (input: { name: string; keyType: 'pk' | 'sk'; environment: ProjectEnvironment; scopes: string[] }) => {
    const res = await onCreateKey(input);
    if (res.rawSecretKey) {
      setRevealedSecret({ raw: res.rawSecretKey, name: res.apiKey.name });
    }
  };

  const handleRotateSubmit = async (gracePeriodHours: GracePeriodHours) => {
    if (!rotatingKey) return;
    const res = await onRotateKey(rotatingKey.id, gracePeriodHours);
    setRotatingKey(null);
    if (res.rawSecretKey) {
      setRevealedSecret({ raw: res.rawSecretKey, name: res.apiKey.name });
    }
  };

  const handleCopyPrefix = (key: ApiKeyItem) => {
    navigator.clipboard.writeText(`${key.keyPrefix}...${key.lastFour}`);
    setCopiedKeyId(key.id);
    setTimeout(() => setCopiedKeyId(null), 2500);
  };

  return (
    <div className="space-y-5" data-testid="api-key-lifecycle-manager">
      {/* Carrusel de Métricas de Consumo & Claves (Móvil: scroll-snap horizontal, Desktop: grid de 4) */}
      <div className="flex sm:grid sm:grid-cols-4 gap-3 overflow-x-auto snap-x snap-mandatory pb-1 sm:pb-0 scrollbar-none">
        {/* Métrica 1: Total de Claves */}
        <div
          className="flex-shrink-0 w-[240px] sm:w-auto snap-start p-4 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-1 transition-all hover:border-[#26251e]/30 shadow-xs"
          style={{ borderRadius: '4px' }}
        >
          <div className="text-[11px] font-sans text-[#7a7974] uppercase tracking-wider flex items-center justify-between">
            <span>Claves Activas</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#1f8a65]" />
          </div>
          <div className="text-[28px] font-mono font-medium tracking-[-1px] text-[#26251e] tabular-nums">
            {activeKeysCount}
          </div>
          <div className="text-[10px] text-[#7a7974] font-mono">
            {publishableKeysCount} pk_ · {secretKeysCount} sk_
          </div>
        </div>

        {/* Métrica 2: Claves Publicables (pk_) */}
        <div
          className="flex-shrink-0 w-[240px] sm:w-auto snap-start p-4 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-1 transition-all hover:border-[#26251e]/30 shadow-xs"
          style={{ borderRadius: '4px' }}
        >
          <div className="text-[11px] font-sans text-[#7a7974] uppercase tracking-wider flex items-center justify-between">
            <span>Claves pk_</span>
            <span className="text-[10px] text-[#1f8a65] font-mono">públicas</span>
          </div>
          <div className="text-[28px] font-mono font-medium tracking-[-1px] text-[#1f8a65] tabular-nums">
            {publishableKeysCount}
          </div>
          <div className="text-[10px] text-[#7a7974] font-mono">Inicialización del SDK en el navegador</div>
        </div>

        {/* Métrica 3: Claves Secretas (sk_) */}
        <div
          className="flex-shrink-0 w-[240px] sm:w-auto snap-start p-4 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-1 transition-all hover:border-[#26251e]/30 shadow-xs"
          style={{ borderRadius: '4px' }}
        >
          <div className="text-[11px] font-sans text-[#7a7974] uppercase tracking-wider flex items-center justify-between">
            <span>Claves sk_</span>
            <span className="text-[10px] text-[#c08532] font-mono">secretas</span>
          </div>
          <div className="text-[28px] font-mono font-medium tracking-[-1px] text-[#c08532] tabular-nums">
            {secretKeysCount}
          </div>
          <div className="text-[10px] text-[#7a7974] font-mono">Control de mapas RAG y backend</div>
        </div>

        {/* Métrica 4: Último Uso Registrado */}
        <div
          className="flex-shrink-0 w-[240px] sm:w-auto snap-start p-4 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-1 transition-all hover:border-[#26251e]/30 shadow-xs"
          style={{ borderRadius: '4px' }}
        >
          <div className="text-[11px] font-sans text-[#7a7974] uppercase tracking-wider flex items-center justify-between">
            <span>Último Uso</span>
            <span className="text-[10px] text-[#7a7974] font-mono">last_used_at</span>
          </div>
          <div className="text-[28px] font-mono font-medium tracking-[-1px] text-[#26251e] tabular-nums">
            {lastUsedAtIso === null ? '—' : lastUsedAtIso.split('T')[0]}
          </div>
          <div className="text-[10px] text-[#7a7974] font-mono">
            {lastUsedAtIso === null ? 'Ninguna clave reporta uso todavía' : 'Consumo más reciente en la API'}
          </div>
        </div>
      </div>

      {/* Pista de desplazamiento para el carrusel de métricas en móvil */}
      <p className="sm:hidden -mt-3 text-[10px] font-mono text-[#84847e]">
        Desliza para ver las 4 métricas →
      </p>

      {/* Barra de Título y Botón de Creación */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
        <div>
          <h2 className="text-sm font-sans font-medium text-[#26251e] flex items-center gap-2">
            <span>Claves Criptográficas de API ({environment})</span>
            <span className="text-[10px] font-mono px-2 py-0.5 bg-[#e6e5e0] text-[#7a7974] rounded">
              {apiKeys.length} registradas
            </span>
          </h2>
          <p className="text-xs font-sans text-[#7a7974] mt-0.5">
            Claves públicas (`pk_`) para inicialización en el navegador y claves secretas (`sk_`) para control de mapas RAG.
          </p>
        </div>

        {!isReadOnly && (
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="min-h-[40px] sm:min-h-0 px-3.5 py-1.5 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3c36] rounded transition-all shadow-sm self-start sm:self-auto flex items-center justify-center"
            style={{ borderRadius: '4px' }}
            data-testid="btn_create_api_key"
          >
            + Generar Nueva Clave
          </button>
        )}
      </div>

      {/* Vista Móvil Adaptativa (sm:hidden): Tarjetas Táctiles Compactas en #f2f1ed con Acciones WCAG de 40px */}
      <div className="sm:hidden space-y-3" data-testid="api-keys-mobile-cards">
        {apiKeys.length === 0 ? (
          <div
            className="p-6 text-center text-xs font-sans text-[#7a7974] bg-[#f2f1ed] border border-[#cdcdc9] rounded"
            style={{ borderRadius: '4px' }}
          >
            No hay claves de API creadas en este entorno. Genera tu primera clave pública o secreta.
          </div>
        ) : (
          apiKeys.map((key) => {
            const isSecret = key.keyType === 'sk';
            const isCopied = copiedKeyId === key.id;
            return (
              <div
                key={key.id}
                className="p-4 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-3 shadow-xs"
                style={{ borderRadius: '4px' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-xs text-[#26251e] truncate">{key.name}</div>
                    <div className="text-[#7a7974] text-[10px] font-mono truncate mt-0.5">{key.id}</div>
                  </div>
                  <span
                    className={`inline-block px-2 py-0.5 text-[9px] font-mono rounded flex-shrink-0 ${
                      isSecret
                        ? 'bg-[#c08532]/10 text-[#c08532] border border-[#c08532]/30'
                        : 'bg-[#1f8a65]/10 text-[#1f8a65] border border-[#1f8a65]/30'
                    }`}
                    style={{ borderRadius: '4px' }}
                  >
                    {isSecret ? 'Secret (sk_)' : 'Publishable (pk_)'}
                  </span>
                </div>

                <div
                  className="flex items-center justify-between gap-2 p-2 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[11px] font-mono text-[#26251e]"
                  style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
                >
                  <span className="truncate">{key.keyPrefix}...{key.lastFour}</span>
                  <button
                    type="button"
                    onClick={() => handleCopyPrefix(key)}
                    className="min-h-[40px] px-3 text-xs font-sans text-[#26251e] bg-[#e6e5e0] hover:bg-[#cdcdc9] border border-[#cdcdc9] rounded flex items-center justify-center transition-colors flex-shrink-0"
                    style={{ borderRadius: '4px' }}
                    aria-label={`Copiar prefijo de la clave ${key.name}`}
                  >
                    {isCopied ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#7a7974]">
                  <div className="flex flex-wrap gap-1">
                    {key.scopes.map((s) => (
                      <span
                        key={s}
                        className="px-1.5 py-0.5 font-mono bg-[#e6e5e0] text-[#7a7974] rounded"
                        style={{ borderRadius: '3px' }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                  <span className="font-mono">
                    Uso: {key.lastUsedAtIso ? key.lastUsedAtIso.split('T')[0] : 'Nunca'}
                  </span>
                </div>

                {!isReadOnly && (
                  <div className="flex items-center gap-2 pt-2 border-t border-[#cdcdc9]">
                    {isSecret && (
                      <button
                        type="button"
                        onClick={() => setRotatingKey(key)}
                        className="flex-1 min-h-[40px] px-3 text-xs font-sans font-medium bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] border border-[#cdcdc9] rounded flex items-center justify-center transition-colors"
                        style={{ borderRadius: '4px' }}
                      >
                        Rotar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`¿Revocar inmediatamente la clave ${key.name}? Toda petición en curso será rechazada.`)) {
                          onRevokeKey(key.id);
                        }
                      }}
                      className="flex-1 min-h-[40px] px-3 text-xs font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/40 rounded flex items-center justify-center transition-colors"
                      style={{ borderRadius: '4px' }}
                    >
                      Revocar
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Vista Desktop (hidden sm:block): Tabla con Scroll Horizontal Suave en Bone #f2f1ed */}
      <div
        className="hidden sm:block bg-[#f2f1ed] border border-[#cdcdc9] rounded overflow-hidden max-w-full shadow-xs"
        style={{ borderRadius: '4px' }}
      >
        <div className="overflow-x-auto max-w-full scrollbar-thin">
          <table className="w-full min-w-[620px] text-left text-xs font-sans">
            <thead className="bg-[#e6e5e0]/70 text-[#7a7974] border-b border-[#cdcdc9]">
              <tr>
                <th className="px-4 py-2.5 font-normal">Nombre e Identificador</th>
                <th className="px-4 py-2.5 font-normal">Tipo</th>
                <th className="px-4 py-2.5 font-normal">Prefijo y Terminación</th>
                <th className="px-4 py-2.5 font-normal">Alcances (Scopes)</th>
                <th className="px-4 py-2.5 font-normal">Último Uso</th>
                {!isReadOnly && <th className="px-4 py-2.5 font-normal text-right">Gestión</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#cdcdc9]">
              {apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[#7a7974]">
                    No hay claves de API creadas en este entorno. Genera tu primera clave pública o secreta.
                  </td>
                </tr>
              ) : (
                apiKeys.map((key) => {
                  const isSecret = key.keyType === 'sk';
                  return (
                    <tr key={key.id} className="hover:bg-[#f7f7f4] transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[#26251e]">{key.name}</div>
                        <div className="text-[#7a7974] text-[10px] font-mono">{key.id}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block px-2 py-0.5 text-[9px] font-mono rounded ${
                            isSecret
                              ? 'bg-[#c08532]/10 text-[#c08532] border border-[#c08532]/30'
                              : 'bg-[#1f8a65]/10 text-[#1f8a65] border border-[#1f8a65]/30'
                          }`}
                          style={{ borderRadius: '4px' }}
                        >
                          {isSecret ? 'Secret (sk_)' : 'Publishable (pk_)'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[#26251e] text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        <span>{key.keyPrefix}...{key.lastFour}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {key.scopes.map((s) => (
                            <span
                              key={s}
                              className="px-1.5 py-0.2 text-[9px] font-mono bg-[#e6e5e0] text-[#7a7974] border border-[#cdcdc9] rounded"
                              style={{ borderRadius: '3px' }}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[#7a7974] text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {key.lastUsedAtIso ? key.lastUsedAtIso.split('T')[0] : 'Nunca'}
                      </td>
                      {!isReadOnly && (
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {isSecret && (
                              <button
                                type="button"
                                onClick={() => setRotatingKey(key)}
                                className="px-2 py-1 text-[10px] font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] border border-[#cdcdc9] rounded transition-colors"
                                style={{ borderRadius: '4px' }}
                                data-testid="btn_rotate_key"
                              >
                                Rotar
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (confirm(`¿Revocar inmediatamente la clave ${key.name}? Toda petición en curso será rechazada.`)) {
                                  onRevokeKey(key.id);
                                }
                              }}
                              className="px-2 py-1 text-[10px] font-mono text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/30 rounded transition-colors"
                              style={{ borderRadius: '4px' }}
                              data-testid="btn_revoke_key"
                            >
                              Revocar
                            </button>
                          </div>
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

      {/* Modal Crear Clave */}
      <CreateApiKeyModal
        isOpen={isCreateModalOpen}
        environment={environment}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateSubmit}
      />

      {/* Modal Rotar Clave con Gracia */}
      <RotateApiKeyModal
        keyToRotate={rotatingKey}
        onClose={() => setRotatingKey(null)}
        onRotate={handleRotateSubmit}
      />

      {/* Modal de Revelación Única */}
      {revealedSecret && (
        <OneTimeSecretRevealDialog
          rawSecretKey={revealedSecret.raw}
          keyName={revealedSecret.name}
          onClose={() => setRevealedSecret(null)}
        />
      )}
    </div>
  );
}
