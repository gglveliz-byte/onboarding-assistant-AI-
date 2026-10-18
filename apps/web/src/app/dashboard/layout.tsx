/**
 * @archivo apps/web/src/app/dashboard/layout.tsx
 * @modulo apps/web/src/app/dashboard (Cascarón del Dashboard del Desarrollador)
 * @proposito
 *   Layout de grupo del App Router para el Dashboard del Desarrollador: monta el marco visual
 *   estricto Cursor Atelier (`[data-portal="workspace-atelier"]`), carga la hoja de estilos
 *   `dashboard-docs-cursor-atelier.css` con lienzo en Warm Parchment (`#f7f7f4`) y declara
 *   los metadatos del área de trabajo técnico.
 *
 * @resumen_contenido
 *   - `metadata`: Metadatos del área de trabajo técnico de onboarding y asistentes de voz.
 *   - `DashboardLayout`: Componente servidor que envuelve todas las rutas hijas del dashboard
 *     en el contenedor con `data-portal="workspace-atelier"`.
 *
 * @dependencias_internas
 *   - `apps/web/src/styles/dashboard-docs-cursor-atelier.css` (tokens y clases `.atelier-*`).
 *
 * @dependencias_externas
 *   - `next` (tipo `Metadata`).
 *   - `react` (tipos `ReactElement`, `ReactNode`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascarón de presentación sin acceso a datos).
 */

import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';
import '../../styles/dashboard-docs-cursor-atelier.css';

/** Metadatos del portal de trabajo técnico para desarrolladores. */
export const metadata: Metadata = {
  title: 'Dashboard del Desarrollador · Onboarding Assistant',
  description:
    'Consola técnica de desarrollo: gestión de API Keys criptográficas, orígenes autorizados, entrenamiento visual de asistentes de voz, mapas RAG y analítica de consumo.',
};

/** Props del layout del dashboard. */
interface DashboardLayoutProps {
  readonly children: ReactNode;
}

/**
 * Cascarón principal del Dashboard bajo la estética Warm Parchment Atelier.
 *
 * @param props - Contenedor de las rutas hijas del dashboard.
 * @returns Estructura HTML con data-portal="workspace-atelier" y lienzo #f7f7f4.
 */
export default function DashboardLayout(props: DashboardLayoutProps): ReactElement {
  return (
    <div
      data-portal="workspace-atelier"
      className="atelier-shell"
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-parchment, #f7f7f4)',
        color: 'var(--color-ink, #26251e)',
      }}
    >
      {props.children}
    </div>
  );
}
