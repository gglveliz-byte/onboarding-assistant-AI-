/**
 * @archivo apps/web/src/components/landing/live-demo/VortexCrmDealsTable.tsx
 * @modulo apps/web/src/components/landing/live-demo (Tabla del pipeline de tratos)
 * @proposito
 *   Tabla reactiva del pipeline de ventas del CRM simulado "Vortex CRM". Nace como extraccion
 *   presentacional del tablero (ola del guion con portones): el tablero quedaría fuera del tope
 *   de 500 líneas al sumar la pestaña de servicios, así que la tabla migra a su propio archivo
 *   y todo el estado sigue viviendo y editándose en `VortexCrmSimulatorBoard`.
 *
 * @resumen_contenido
 *   - Interfaz `DealRow` (fila del pipeline, compartida con el temario).
 *   - Componente `VortexCrmDealsTable` (tabla con resaltado del trato recién creado).
 *
 * @dependencias_internas
 *   - Ninguna (la tabla jamás toca estado: es pura presentación).
 *
 * @dependencias_externas
 *   - Solo `react` (type ReactElement). Cero librerías externas de animación o tablas.
 */

'use client';

import type { ReactElement } from 'react';

/** Fila del pipeline de ventas (duena del estado: `VortexCrmSimulatorBoard`). */
export interface DealRow {
  readonly id: string;
  readonly name: string;
  readonly stage: string;
  readonly value: string;
  readonly contact: string;
  readonly date: string;
  readonly isNew?: boolean;
}

/** Propiedades de la tabla de tratos: solo las filas en vivo del pipeline. */
export interface VortexCrmDealsTableProps {
  readonly deals: readonly DealRow[];
}

/** Tabla del pipeline con resaltado animado del trato recién guardado. */
export function VortexCrmDealsTable({ deals }: VortexCrmDealsTableProps): ReactElement {
  return (
    <div className="bg-white rounded-lg border border-slate-200/90 shadow-xs overflow-x-auto mb-2">
      <table className="w-full text-left text-[11px] text-slate-600 border-collapse min-w-[360px]">
        <thead>
          <tr className="bg-slate-50/90 border-b border-slate-200 text-slate-400 font-medium text-[9px] sm:text-[10px]">
            <th className="py-1 px-2.5">NOMBRE DEL TRATO</th>
            <th className="py-1 px-2.5">ETAPA</th>
            <th className="py-1 px-2.5">VALOR</th>
            <th className="py-1 px-2.5 text-right">CIERRE</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-[10px] sm:text-[11px]">
          {deals.map((deal) => (
            <tr key={deal.id} className={deal.isNew ? 'bg-teal-50/60 font-semibold' : 'hover:bg-slate-50/60'}>
              <td className="py-1 px-2.5 font-semibold text-slate-800 flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${deal.isNew ? 'bg-[#6d3dfa] animate-ping' : 'bg-emerald-500'}`} />
                <span className="truncate max-w-[130px] sm:max-w-none">{deal.name}</span>
              </td>
              <td className="py-1 px-2.5">
                <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-semibold">
                  {deal.stage}
                </span>
              </td>
              <td className="py-1 px-2.5 font-mono font-bold text-slate-800">{deal.value}</td>
              <td className="py-1 px-2.5 text-right text-slate-400 text-[10px]">{deal.date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
