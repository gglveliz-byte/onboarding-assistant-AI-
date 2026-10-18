/**
 * @archivo apps/web/src/components/dashboard-dev/ApiKeyLifecycleModals.tsx
 * @modulo 08-frontend-dashboard-dev (Modales de Creación y Rotación de API Keys - Cursor Atelier)
 * @proposito
 *   Provee los modales de creación (clave pública/secreta con scopes) y de rotación
 *   con ventana de gracia de 0h, 1h, 24h o 72h bajo el estricto sistema de diseño
 *   Cursor Atelier (Bone #f2f1ed, Parchment #f7f7f4, Stone #cdcdc9, radios de 8px en modales).
 *
 * @resumen_contenido
 *   - Componente `CreateApiKeyModal`: Formulario de generación con selección de tipo y scopes.
 *   - Componente `RotateApiKeyModal`: Selector de ventana de gracia para clave secreta.
 *
 * @dependencias_internas
 *   - `ApiKeyItem`, `GracePeriodHours`, `ProjectEnvironment` (./useProjectsAndApiKeys.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `api_keys`.
 */

'use client';

import React, { useState } from 'react';
import type { ApiKeyItem, GracePeriodHours, ProjectEnvironment } from './useProjectsAndApiKeys';

export interface CreateApiKeyModalProps {
  readonly isOpen: boolean;
  readonly environment: ProjectEnvironment;
  readonly onClose: () => void;
  readonly onSubmit: (input: { name: string; keyType: 'pk' | 'sk'; environment: ProjectEnvironment; scopes: string[] }) => Promise<void>;
}

/**
 * Modal para generar una nueva clave pública (pk_) o secreta (sk_).
 */
export function CreateApiKeyModal({
  isOpen,
  environment,
  onClose,
  onSubmit,
}: CreateApiKeyModalProps) {
  const [name, setName] = useState('');
  const [keyType, setKeyType] = useState<'pk' | 'sk'>('pk');
  const [scopes, setScopes] = useState<string[]>(['telemetry:write']);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        keyType,
        environment,
        scopes,
      });
      setName('');
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#26251e]/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div
        className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-md w-full p-5 space-y-4 shadow-xl text-[#26251e]"
        style={{ borderRadius: '8px' }}
      >
        <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-2">
          <h3 className="text-sm font-sans font-medium text-[#26251e]">Generar Nueva Clave de API</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[#7a7974] hover:text-[#26251e] p-1"
            aria-label="Cerrar modal"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[10px] font-sans text-[#7a7974] uppercase tracking-wider mb-1">
              Nombre Descriptivo
            </label>
            <input
              type="text"
              required
              placeholder="ej. SDK Cliente Web"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-1.5 text-xs font-sans bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none focus:border-[#26251e]"
              style={{ borderRadius: '4px' }}
            />
          </div>

          <div>
            <label className="block text-[10px] font-sans text-[#7a7974] uppercase tracking-wider mb-1">
              Tipo de Clave
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setKeyType('pk');
                  setScopes(['telemetry:write', 'voice:stream']);
                }}
                className={`py-2 text-xs font-sans rounded border text-center transition-colors ${
                  keyType === 'pk'
                    ? 'bg-[#1f8a65] text-[#f7f7f4] border-[#1f8a65] font-medium'
                    : 'bg-[#f2f1ed] text-[#7a7974] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '4px' }}
              >
                Pública (pk_live_)
              </button>
              <button
                type="button"
                onClick={() => {
                  setKeyType('sk');
                  setScopes(['maps:publish', 'prompt:update']);
                }}
                className={`py-2 text-xs font-sans rounded border text-center transition-colors ${
                  keyType === 'sk'
                    ? 'bg-[#26251e] text-[#f7f7f4] border-[#26251e] font-medium'
                    : 'bg-[#f2f1ed] text-[#7a7974] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '4px' }}
              >
                Secreta (sk_live_)
              </button>
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2 border-t border-[#cdcdc9]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3 py-1.5 text-xs font-sans text-[#7a7974] hover:bg-[#e6e5e0] rounded transition-colors"
              style={{ borderRadius: '4px' }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="px-4 py-1.5 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] disabled:opacity-50 rounded transition-colors"
              style={{ borderRadius: '4px' }}
            >
              {isSubmitting ? 'Creando...' : 'Crear Clave'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export interface RotateApiKeyModalProps {
  readonly keyToRotate: ApiKeyItem | null;
  readonly onClose: () => void;
  readonly onRotate: (gracePeriodHours: GracePeriodHours) => Promise<void>;
}

/**
 * Modal para rotar una clave secreta con ventana de gracia.
 */
export function RotateApiKeyModal({
  keyToRotate,
  onClose,
  onRotate,
}: RotateApiKeyModalProps) {
  const [gracePeriod, setGracePeriod] = useState<GracePeriodHours>(24);
  const [isRotating, setIsRotating] = useState(false);

  if (!keyToRotate) return null;

  const handleRotate = async () => {
    setIsRotating(true);
    try {
      await onRotate(gracePeriod);
      onClose();
    } finally {
      setIsRotating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#26251e]/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div
        className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-md w-full p-5 space-y-4 shadow-xl text-[#26251e]"
        style={{ borderRadius: '8px' }}
      >
        <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-2">
          <h3 className="text-sm font-sans font-medium text-[#26251e]">
            Rotación de Clave Secreta ({keyToRotate.name})
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[#7a7974] hover:text-[#26251e] p-1"
            aria-label="Cerrar modal"
          >
            ✕
          </button>
        </div>

        <p className="text-xs font-sans text-[#7a7974] leading-relaxed">
          La clave actual continuará siendo válida durante la ventana de gracia elegida,
          permitiéndote actualizar tus servidores sin interrupciones de servicio.
        </p>

        <div>
          <label className="block text-[10px] font-sans text-[#7a7974] uppercase tracking-wider mb-1.5">
            Ventana de Gracia para la Clave Antigua
          </label>
          <div className="grid grid-cols-4 gap-2">
            {([0, 1, 24, 72] as GracePeriodHours[]).map((hours) => (
              <button
                key={hours}
                type="button"
                onClick={() => setGracePeriod(hours)}
                className={`py-1.5 text-xs font-mono rounded border transition-colors ${
                  gracePeriod === hours
                    ? 'bg-[#c08532] text-[#f7f7f4] border-[#c08532] font-medium'
                    : 'bg-[#f2f1ed] text-[#7a7974] border-[#cdcdc9]'
                }`}
                style={{ borderRadius: '4px' }}
              >
                {hours === 0 ? '0h (Inmediato)' : `${hours}h`}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2 flex justify-end gap-2 border-t border-[#cdcdc9]">
          <button
            type="button"
            onClick={onClose}
            disabled={isRotating}
            className="px-3 py-1.5 text-xs font-sans text-[#7a7974] hover:bg-[#e6e5e0] rounded transition-colors"
            style={{ borderRadius: '4px' }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleRotate}
            disabled={isRotating}
            className="px-4 py-1.5 text-xs font-sans font-medium bg-[#c08532] text-[#f7f7f4] hover:bg-[#a67128] disabled:opacity-50 rounded transition-colors"
            style={{ borderRadius: '4px' }}
          >
            {isRotating ? 'Rotando...' : 'Rotar y Mostrar Secreto'}
          </button>
        </div>
      </div>
    </div>
  );
}
