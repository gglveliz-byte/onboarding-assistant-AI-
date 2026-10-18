/**
 * @archivo apps/web/src/components/landing/explore/VisualTrainingMolecularGraph.tsx
 * @modulo 12. Landing Publica Comercial: Exploracion del producto
 * @proposito
 *   Espaciador transparente para la sección "Entrenamiento Visual & Memoria RAG":
 *   reserva el espacio de la cuadrícula de escritorio de forma 100% limpia y sin ningún
 *   texto, marco ni elemento superpuesto, permitiendo que la Red Neuronal 3D del fondo de
 *   partículas del sistema sea la protagonista visual absoluta.
 *
 * @resumen_contenido
 *   - `DesktopMolecularGraph`: contenedor transparente puro sin texto ni bordes (`pointer-events-none`).
 *   - `CompactMolecularGraph`: glifo neuronal vectorial estilizado para móvil (< lg).
 *
 * @dependencias_internas
 *   - Ninguna.
 *
 * @dependencias_externas
 *   - `react` (tipo `ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (componente de presentación pura sin estado de red).
 */

import type { ReactElement } from 'react';

/**
 * Escenario transparente para la cuadrícula de 7 columnas de la landing:
 * Cero cajas opacas, cero textos superpuestos y cero retículas falsas.
 * Permite que las partículas 3D de fondo operen con visibilidad pura e interacción al cursor.
 */
export function DesktopMolecularGraph(): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative mx-auto h-[460px] w-full max-w-[660px] sm:h-[500px]"
    />
  );
}

/**
 * Glifo vectorial neuronal para el botón del explorador móvil (< lg).
 */
export function CompactMolecularGraph(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      className="h-full w-full p-2 text-[#15846E]"
      fill="none"
      stroke="currentColor"
    >
      <g strokeWidth={1.2} opacity={0.5} stroke="#8052FF">
        <line x1="50" y1="50" x2="25" y2="30" />
        <line x1="50" y1="50" x2="75" y2="30" />
        <line x1="50" y1="50" x2="20" y2="70" />
        <line x1="50" y1="50" x2="80" y2="70" />
        <line x1="25" y1="30" x2="20" y2="70" />
        <line x1="75" y1="30" x2="80" y2="70" />
        <line x1="50" y1="50" x2="50" y2="18" />
        <line x1="50" y1="50" x2="50" y2="82" />
      </g>
      <circle cx="25" cy="30" r="4" fill="#43E7DB" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="75" cy="30" r="4" fill="#8052FF" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="20" cy="70" r="4" fill="#15846E" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="80" cy="70" r="4" fill="#FFB829" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="50" cy="18" r="3.5" fill="#43E7DB" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="50" cy="82" r="3.5" fill="#8052FF" stroke="#FFFFFF" strokeWidth={1} />
      <circle cx="50" cy="50" r="7.5" fill="#8052FF" stroke="#FFFFFF" strokeWidth={1.5} />
      <circle cx="50" cy="50" r="3" fill="#FFFFFF" />
      <circle cx="50" cy="50" r="11" stroke="#43E7DB" strokeWidth={0.8} strokeDasharray="2 2" opacity={0.7} />
    </svg>
  );
}
