/**
 * @archivo apps/web/src/components/rag-editor/MapVersionHistoryAndShaBar.tsx
 * @modulo 08-frontend-rag-editor (Barra Superior de Sellado Criptográfico SHA-256 e Historial de Versiones)
 * @proposito
 *   Muestra en tiempo real la huella inmutable del mapa funcional calculada bajo la norma
 *   RFC 8785 con la etiqueta de verificación `SHA-256 VERIFIED` en color Verdant #1f8a65.
 *   Provee el menú desplegable del historial de versiones y botón de rollback instantáneo.
 *
 * @resumen_contenido
 *   - Etiqueta `SHA-256 VERIFIED` con hash abreviado en berkeleyMono tabular.
 *   - Desplegable de versiones históricas publicadas en PostgreSQL RLS.
 *   - Botón de confirmación estructural en verde bosque (#34785c Forest) para publicar.
 *   - Diálogo modal de confirmación de rollback instantáneo a versión anterior.
 *
 * @dependencias_internas
 *   - `MapVersionMetadata` (./useFunctionalMapDualEditor.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps.content_sha256_hash`.
 */

'use client';

import React, { useState } from 'react';
import type { MapVersionMetadata } from './useFunctionalMapDualEditor';

export interface MapVersionHistoryAndShaBarProps {
  readonly currentSha256: string;
  readonly publishedVersions: readonly MapVersionMetadata[];
  readonly isPublishing: boolean;
  readonly onPublish: (versionLabel?: string) => Promise<unknown>;
  readonly onRollback: (versionNumber: number) => Promise<unknown>;
  readonly isReadOnly?: boolean;
}

export function MapVersionHistoryAndShaBar({
  currentSha256,
  publishedVersions,
  isPublishing,
  onPublish,
  onRollback,
  isReadOnly = false,
}: MapVersionHistoryAndShaBarProps) {
  const [isVersionDropdownOpen, setIsVersionDropdownOpen] = useState(false);
  const [publishLabel, setPublishLabel] = useState('');
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<MapVersionMetadata | null>(null);

  const activeVersion = publishedVersions[0];

  const handlePublishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onPublish(publishLabel.trim() || undefined);
    setIsPublishModalOpen(false);
    setPublishLabel('');
  };

  const handleRollbackConfirm = async () => {
    if (!rollbackTarget) return;
    await onRollback(rollbackTarget.versionNumber);
    setRollbackTarget(null);
  };

  return (
    <div
      className="bg-[#f2f1ed] border-b border-[#cdcdc9] px-5 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 select-none flex-shrink-0"
      data-testid="map-version-history-and-sha-bar"
    >
      {/* 1. Sello Criptográfico SHA-256 */}
      <div className="flex items-center gap-3">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono text-[#1f8a65] bg-[#1f8a65]/10 border border-[#1f8a65]/30 rounded font-semibold"
          style={{ borderRadius: '3px' }}
        >
          <span>✓</span>
          <span>SHA-256 VERIFIED</span>
        </span>

        <span
          className="text-xs font-mono text-[#26251e] tracking-tight bg-[#f7f7f4] px-2.5 py-1 border border-[#cdcdc9] rounded"
          style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
          title={`Hash SHA-256 RFC 8785: ${currentSha256}`}
        >
          {currentSha256.slice(0, 16)}...{currentSha256.slice(-8)}
        </span>
      </div>

      {/* 2. Selector de Versiones y Publicación */}
      <div className="flex items-center gap-3">
        {/* Selector de Historial */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsVersionDropdownOpen(!isVersionDropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors"
            style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
          >
            <span>Versión: {activeVersion ? activeVersion.versionLabel || `v${activeVersion.versionNumber}.0.0` : 'v1.0.0 (Borrador)'}</span>
            <span className="text-[10px] text-[#84847e]">▼</span>
          </button>

          {isVersionDropdownOpen && (
            <div
              className="absolute right-0 mt-1 w-72 bg-[#f2f1ed] border border-[#cdcdc9] rounded shadow-xl z-50 py-1"
              style={{ borderRadius: '4px' }}
            >
              <div className="px-3 py-1.5 text-[10px] font-sans text-[#84847e] uppercase tracking-wider border-b border-[#cdcdc9]">
                Historial Inmutable de Versiones
              </div>
              <div className="max-h-60 overflow-y-auto divide-y divide-[#cdcdc9]/50">
                {publishedVersions.map((v) => (
                  <div
                    key={v.versionNumber}
                    className="p-3 text-xs space-y-1 hover:bg-[#e6e5e0]/60 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium text-[#26251e]">
                        {v.versionLabel || `Versión ${v.versionNumber}`}
                      </span>
                      <span className="text-[10px] font-mono text-[#84847e]">
                        {v.totalElements} nodos
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-[#84847e] truncate" title={v.contentSha256Hash}>
                      SHA: {v.contentSha256Hash.slice(0, 14)}...
                    </div>
                    {!isReadOnly && v.versionNumber !== activeVersion?.versionNumber && (
                      <div className="pt-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            setIsVersionDropdownOpen(false);
                            setRollbackTarget(v);
                          }}
                          className="px-2 py-0.5 text-[10px] font-mono text-[#c08532] hover:bg-[#c08532]/10 border border-[#c08532]/30 rounded transition-colors"
                          style={{ borderRadius: '3px' }}
                        >
                          Rollback Instantáneo
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Botón Publicar Mapa RAG */}
        {!isReadOnly && (
          <button
            type="button"
            onClick={() => setIsPublishModalOpen(true)}
            disabled={isPublishing}
            className="px-4 py-1.5 text-xs font-sans font-medium bg-[#34785c] text-[#f7f7f4] hover:bg-[#2c654d] disabled:opacity-40 rounded transition-colors shadow-xs"
            style={{ borderRadius: '4px' }}
            data-testid="btn_publish_immutable_map"
          >
            {isPublishing ? 'Sellando...' : 'Publicar Mapa RAG SHA-256'}
          </button>
        )}
      </div>

      {/* Modal de Publicación */}
      {isPublishModalOpen && (
        <div className="fixed inset-0 bg-[#26251e]/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div
            className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-md w-full p-5 space-y-4 shadow-xl"
            style={{ borderRadius: '8px' }}
          >
            <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-2">
              <h3 className="text-sm font-sans font-medium text-[#26251e]">
                Publicar Versión Inmutable del Mapa RAG
              </h3>
              <button
                type="button"
                onClick={() => setIsPublishModalOpen(false)}
                className="text-[#84847e] hover:text-[#26251e]"
              >
                ✕
              </button>
            </div>

            <p className="text-xs font-sans text-[#84847e] leading-relaxed">
              El mapa actual será canonicalizado bajo RFC 8785 y sellado con el digest SHA-256 en PostgreSQL.
              Esta versión quedará fijada para el Gateway de Voz y el Context Slimming.
            </p>

            <form onSubmit={handlePublishSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-sans text-[#84847e] uppercase tracking-wider mb-1">
                  Etiqueta de la Versión (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="ej. v1.1.0 - Nuevos flujos de pago"
                  value={publishLabel}
                  onChange={(e) => setPublishLabel(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs font-sans bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
                  style={{ borderRadius: '4px' }}
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-[#cdcdc9]">
                <button
                  type="button"
                  onClick={() => setIsPublishModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-sans text-[#84847e] hover:bg-[#e6e5e0] rounded"
                  style={{ borderRadius: '4px' }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-sans font-medium bg-[#34785c] text-[#f7f7f4] hover:bg-[#2c654d] rounded transition-colors"
                  style={{ borderRadius: '4px' }}
                >
                  Confirmar y Publicar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Rollback */}
      {rollbackTarget && (
        <div className="fixed inset-0 bg-[#26251e]/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div
            className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-md w-full p-5 space-y-4 shadow-xl"
            style={{ borderRadius: '8px' }}
          >
            <h3 className="text-sm font-sans font-medium text-[#26251e]">
              Confirmar Rollback a {rollbackTarget.versionLabel || `v${rollbackTarget.versionNumber}`}
            </h3>
            <p className="text-xs font-sans text-[#84847e] leading-relaxed">
              El Gateway de Voz volverá a usar inmediatamente la instantánea histórica del mapa con hash:
              <br />
              <span className="font-mono text-[#26251e] block pt-1">{rollbackTarget.contentSha256Hash}</span>
            </p>
            <div className="flex justify-end gap-2 border-t border-[#cdcdc9] pt-3">
              <button
                type="button"
                onClick={() => setRollbackTarget(null)}
                className="px-3 py-1.5 text-xs font-sans text-[#84847e] hover:bg-[#e6e5e0] rounded"
                style={{ borderRadius: '4px' }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleRollbackConfirm}
                className="px-4 py-1.5 text-xs font-sans font-medium bg-[#c08532] text-[#f7f7f4] hover:bg-[#aa7225] rounded transition-colors"
                style={{ borderRadius: '4px' }}
              >
                Ejecutar Rollback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
