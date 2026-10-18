/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/page.tsx
 * @modulo apps/web/src/app/dashboard (Punto de Entrada por Organización)
 * @proposito
 *   Redirige inmediatamente el acceso raíz a `/dashboard/org/[orgSlug]` hacia la consola
 *   predeterminada del proyecto General (`/dashboard/org/[orgSlug]/projects/general/keys`),
 *   erradicando errores 404 tras el registro o inicio de sesión de cualquier tenant.
 *
 * @resumen_contenido
 *   - `OrgDashboardRootPage`: Redirige de forma declarativa y segura en el servidor.
 *
 * @dependencias_internas
 *   - Ninguna.
 *
 * @dependencias_externas
 *   - `next/navigation` (`redirect`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna.
 */

import { redirect } from 'next/navigation';

interface OrgDashboardRootPageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Redirige la ruta base de la organización al proyecto activo inicial.
 */
export default async function OrgDashboardRootPage({ params }: OrgDashboardRootPageProps): Promise<never> {
  const { orgSlug } = await params;
  redirect(`/dashboard/org/${encodeURIComponent(orgSlug)}/projects/general/keys`);
}
