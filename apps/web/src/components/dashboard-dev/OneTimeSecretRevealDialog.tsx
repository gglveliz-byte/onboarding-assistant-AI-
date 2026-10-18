/**
 * @archivo apps/web/src/components/dashboard-dev/OneTimeSecretRevealDialog.tsx
 * @modulo 08-frontend-dashboard-dev (Diálogo de Revelación Única de Clave Secreta SHA-256)
 * @proposito
 *   Modal crítico de revelación de la clave secreta `sk_live_...` inmediatamente después de
 *   su creación o rotación. Advierte de forma explícita que la base de datos PostgreSQL RLS
 *   únicamente almacena el hash SHA-256 no reversible y que no podrá ser consultada nuevamente.
 *   Presenta un bloque de código monospaciado con `break-all` sobre fondo Bone (#f2f1ed)
 *   y botón de copiado táctil accesible con `aria-live`.
 *
 * @resumen_contenido
 *   - Componente `OneTimeSecretRevealDialog`: Modal flotante con advertencia de seguridad.
 *   - Exportación dual `OneTimeSecretRevealDialog` y `OneTimeSecretRevealModal`.
 *   - Bloque monospaciado seleccionable con soporte móvil y botón de copiado accesible.
 *   - Notificación de almacenamiento inmutable bajo SHA-256.
 *
 * @dependencias_internas
 *   - Ninguna (Componente modal autónomo de alta seguridad).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `api_keys.key_hash`.
 */

'use client';

import React, { useState } from 'react';

export interface OneTimeSecretRevealDialogProps {
  readonly rawSecretKey: string;
  readonly keyName: string;
  readonly onClose: () => void;
}

/**
 * Diálogo modal de revelación única de secretos criptográficos.
 */
export function OneTimeSecretRevealDialog({
  rawSecretKey,
  keyName,
  onClose,
}: OneTimeSecretRevealDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(rawSecretKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="fixed inset-0 bg-[#26251e]/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div
        className="bg-[#f7f7f4] border border-[#cdcdc9] max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-xl"
        style={{ borderRadius: '8px' }}
        data-testid="one-time-secret-reveal-dialog"
      >
        <div className="flex items-center justify-between border-b border-[#cdcdc9] pb-3">
          <div className="flex items-center gap-2 text-sm font-sans font-medium text-[#26251e]">
            <span className="text-[#c08532]">🔑</span>
            <span>Nueva Clave de API Generada ({keyName})</span>
          </div>
          <span className="text-[10px] font-mono bg-[#1f8a65]/10 text-[#1f8a65] px-2 py-0.5 rounded">
            SHA-256 STORED
          </span>
        </div>

        <div className="p-3 bg-[#cf2d56]/10 border border-[#cf2d56]/30 rounded text-xs font-sans text-[#cf2d56] leading-relaxed">
          <strong>⚠️ Advertencia de seguridad inquebrantable:</strong> Guarda esta clave secreta en un lugar seguro ahora.
          Por motivos de seguridad, la plataforma únicamente almacena el hash <strong>SHA-256</strong> en la base de datos
          y no volverá a mostrarte este secreto jamás.
        </div>

        <div className="space-y-2">
          <label className="text-[11px] font-sans text-[#84847e] uppercase tracking-wider block">
            Clave de API Secreta
          </label>
          <div
            className="p-3 bg-[#f2f1ed] border border-[#cdcdc9] rounded flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            style={{ borderRadius: '4px' }}
          >
            <code
              className="text-xs font-mono text-[#26251e] select-all break-all leading-relaxed"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {rawSecretKey}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="min-h-[40px] sm:min-h-0 px-4 py-2 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] rounded transition-colors whitespace-nowrap flex items-center justify-center self-stretch sm:self-auto"
              style={{ borderRadius: '4px' }}
              aria-live="polite"
              aria-label={copied ? 'Clave copiada al portapapeles' : 'Copiar clave secreta al portapapeles'}
            >
              {copied ? '✓ Copiada' : 'Copiar Clave'}
            </button>
          </div>
          <p className="text-[11px] font-sans text-[#84847e]" aria-live="polite">
            {copied ? '✓ Secreto copiado exitosamente al portapapeles.' : 'Haz clic en el bloque o en el botón para copiarla.'}
          </p>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto min-h-[40px] sm:min-h-0 px-4 py-2 text-xs font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded transition-colors font-medium flex items-center justify-center"
            style={{ borderRadius: '4px' }}
          >
            Entendido, ya guardé mi clave
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Alias de exportación para compatibilidad de nomenclatura.
 */
export const OneTimeSecretRevealModal = OneTimeSecretRevealDialog;
