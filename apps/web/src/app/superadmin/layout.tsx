/**
 * @archivo apps/web/src/app/superadmin/layout.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin — Layout del Portal SuperAdmin)
 * @proposito
 *   Cascarón de nivel de ruta para la Consola SuperAdmin de gobierno de plataforma:
 *   aplica los tokens "Cursor Light — Warm Parchment Atelier" con `data-portal="workspace-atelier"`,
 *   asegurando la persistencia de estilos, telemetría y navegación en todas las subrutas de SuperAdmin.
 *
 * @resumen_contenido
 *   - Componente `SuperAdminLayout`:
 *       * Importa `../../styles/dashboard-docs-cursor-atelier.css`.
 *       * Aplica el atributo `data-portal="workspace-atelier"` y la clase `atelier-shell`.
 *       * Establece la superficie de lienzo pergamino (`--color-parchment: #f7f7f4`).
 *       * Preserva el estado de telemetría y navegación de los componentes descendientes.
 *
 * @dependencias_internas
 *   - `apps/web/src/styles/dashboard-docs-cursor-atelier.css` (tokens y clases `.atelier-*`).
 *
 * @dependencias_externas
 *   - `react` (tipos `ReactElement`, `ReactNode`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna directa (layout de presentación de App Router).
 */

import type { ReactElement, ReactNode } from 'react';
import '../../styles/dashboard-docs-cursor-atelier.css';

export interface SuperAdminLayoutProps {
  readonly children: ReactNode;
}

/**
 * Layout maestro del App Router para el módulo de SuperAdmin con tokens Atelier.
 */
export default function SuperAdminLayout({ children }: SuperAdminLayoutProps): ReactElement {
  return (
    <div
      data-portal="workspace-atelier"
      className="atelier-shell"
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-parchment, #f7f7f4)',
        color: 'var(--color-ink, #26251e)',
        fontFamily: 'var(--font-cursorgothic, sans-serif)',
      }}
    >
      {children}
    </div>
  );
}
