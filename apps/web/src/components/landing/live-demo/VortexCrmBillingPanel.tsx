/**
 * @archivo apps/web/src/components/landing/live-demo/VortexCrmBillingPanel.tsx
 * @modulo apps/web/src/components/landing/live-demo (Panel de Facturación y CFDI)
 * @proposito
 *   Muestra la pestaña de facturación y validación fiscal mexicana (CFDI / RFC)
 *   para las directivas de onboarding y validación DOM en la demostración interactiva.
 *
 * @resumen_contenido
 *   - Estado de validación fiscal con chip reactivo.
 *   - Campo de entrada con ancla `data-oa-id="input-company-tax"` para RFC emisor.
 *   - Visualización de Folio Fiscal UUID verificado.
 *
 * @dependencias_externas
 *   - `react` (`type ReactElement`).
 */

'use client';

import type { ReactElement } from 'react';

export interface VortexCrmBillingPanelProps {
  readonly cfdiValidated: boolean;
}

export function VortexCrmBillingPanel({ cfdiValidated }: VortexCrmBillingPanelProps): ReactElement {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
        <span className="text-xs font-bold text-[#0a252c]">Validación de Comprobantes Fiscales</span>
        {cfdiValidated && (
          <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full">
            ✓ CFDI Validado Exitosamente
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <div>
          <label className="block text-slate-500 mb-0.5 text-[10px]">RFC Emisor</label>
          <input
            type="text"
            data-oa-id="input-company-tax"
            defaultValue="ACM840512-AA1"
            className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] font-mono text-slate-800"
          />
        </div>
        <div>
          <label className="block text-slate-500 mb-0.5 text-[10px]">Folio Fiscal (UUID)</label>
          <input
            type="text"
            readOnly
            value="4A82B-981F-4301-A9E0-0081C4"
            className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] font-mono text-slate-500"
          />
        </div>
      </div>
    </div>
  );
}
