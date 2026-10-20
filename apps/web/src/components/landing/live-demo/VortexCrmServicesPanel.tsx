/**
 * @archivo apps/web/src/components/landing/live-demo/VortexCrmServicesPanel.tsx
 * @modulo apps/web/src/components/landing/live-demo (Panel del Catalogo de Servicios)
 * @proposito
 *   Tercera pestaña del CRM simulado "Vortex CRM": el catálogo de servicios del que el asistente
 *   demuestra «asignar o agregar un servicio» con la acción física `btn-create-service`. Cierra el
 *   recorrido guiado por secciones del guion con portones (tratos → facturación → servicios).
 *
 * @resumen_contenido
 *   - Interfaz `VortexCrmServiceItem` (fila del catálogo; los recién creados quedan resaltados).
 *   - Botón con ancla `data-oa-id="btn-create-service"` y anillo de inspección cuando la IA lo
 *     ejecuta; con click manual del visitante delega en el tablero vía `onCreateService`.
 *
 * @dependencias_internas
 *   - Ninguna (presentacional puro; el estado y el commit viven en `VortexCrmSimulatorBoard`).
 *
 * @dependencias_externas
 *   - Solo `react` (type ReactElement). Cero librerías externas.
 */

'use client';

import type { ReactElement } from 'react';

/** Fila del catálogo de servicios (el estado vive en el tablero Vortex CRM). */
export interface VortexCrmServiceItem {
  readonly name: string;
  readonly isNew?: boolean;
}

/** Propiedades del panel de servicios: catálogo en vivo, inspección y creación delegada. */
export interface VortexCrmServicesPanelProps {
  readonly services: readonly VortexCrmServiceItem[];
  readonly inspectedKey: string | null;
  readonly onCreateService: () => void;
}

/** Panel del catálogo de servicios con botón "Crear servicio" instrumentado para la IA. */
export function VortexCrmServicesPanel({ services, inspectedKey, onCreateService }: VortexCrmServicesPanelProps): ReactElement {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
        <span className="text-xs font-bold text-[#0a252c]">Catálogo de Servicios</span>
        <span className="text-[9px] text-slate-400">{services.length} servicios activos</span>
      </div>
      <ul className="divide-y divide-slate-100 text-[11px]">
        {services.map((servicio) => (
          <li
            key={servicio.name}
            className={`flex items-center justify-between py-1.5 ${servicio.isNew ? 'bg-teal-50/70 -mx-2 px-2 rounded' : ''}`}
          >
            <span className="flex items-center gap-1.5 font-semibold text-slate-800">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${servicio.isNew ? 'bg-[#6d3dfa] animate-ping' : 'bg-emerald-500'}`} />
              <span className="truncate max-w-[170px] sm:max-w-none">{servicio.name}</span>
            </span>
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-semibold shrink-0">
              Activo
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-oa-id="btn-create-service"
        onClick={onCreateService}
        className={`w-full text-center text-[10px] font-bold px-2.5 py-1.5 rounded-md shadow-xs transition-all cursor-pointer ${
          inspectedKey === 'btn-create-service'
            ? 'bg-teal-600 text-white ring-2 ring-teal-300'
            : 'bg-[#0a252c] hover:bg-slate-800 text-white'
        }`}
      >
        + Crear servicio
      </button>
    </div>
  );
}
