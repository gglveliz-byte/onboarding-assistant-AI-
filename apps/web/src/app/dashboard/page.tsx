/**
 * @archivo apps/web/src/app/dashboard/page.tsx
 * @modulo apps/web/src/app/dashboard (Ruta Raíz del Dashboard)
 * @proposito
 *   Redirige inmediatamente el acceso a `/dashboard` hacia el espacio de trabajo
 *   predeterminado del proyecto (`/dashboard/org/default-org/projects/proj_default_live/keys`),
 *   erradicando cualquier respuesta 404 y facilitando la navegación inmediata del desarrollador.
 *
 * @resumen_contenido
 *   - `DashboardRootPage`: Componente servidor que invoca `redirect()` de Next.js App Router.
 *
 * @dependencias_internas
 *   - Ninguna.
 *
 * @dependencias_externas
 *   - `next/navigation` (`redirect`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (redirección declarativa en servidor).
 */

import { redirect } from 'next/navigation';

/**
 * Página raíz del Dashboard: redirección hacia la consola predeterminada de claves de API.
 */
export default function DashboardRootPage(): never {
  redirect('/dashboard/org/default-org/projects/proj_default_live/keys');
}
