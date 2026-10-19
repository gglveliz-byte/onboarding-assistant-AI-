/**
 * @archivo apps/web/src/app/dashboard/page.tsx
 * @modulo 08-frontend-dashboard-dev (Ruta Raíz del Dashboard)
 * @proposito
 *   Punto de entrada raíz del Dashboard del Desarrollador. Resuelve en el cliente la
 *   organización y el proyecto reales de la sesión activa (a partir del token persistido en la
 *   pestaña) y navega a la consola de credenciales, en lugar de redirigir a identificadores
 *   ficticios (`default-org` / `proj_default_live`) que terminaban en un 404.
 *
 * @resumen_contenido
 *   - `DashboardRootPage`: monta `DashboardEntryRedirect` con la sesión de la pestaña.
 *
 * @dependencias_internas
 *   - `DashboardEntryRedirect` (apps/web/src/components/dashboard-dev/DashboardEntryRedirect.tsx).
 *
 * @dependencias_externas
 *   - `react` (tipo `ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST): `projects` (lectura del tenant de la sesión).
 */

import type { ReactElement } from 'react';
import { DashboardEntryRedirect } from '@/components/dashboard-dev/DashboardEntryRedirect';

/**
 * Página raíz del Dashboard: resuelve el destino real de la sesión activa.
 */
export default function DashboardRootPage(): ReactElement {
  return <DashboardEntryRedirect />;
}
