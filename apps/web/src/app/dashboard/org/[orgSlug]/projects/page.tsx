/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/page.tsx
 * @modulo apps/web/src/app/dashboard (Punto de Entrada a Proyectos)
 * @proposito
 *   Redirige inmediatamente el acceso a `/dashboard/org/[orgSlug]/projects` hacia
 *   la consola de claves del proyecto principal (`/dashboard/org/[orgSlug]/projects/general/keys`),
 *   impidiendo respuestas 404 intermedias en la navegación.
 *
 * @resumen_contenido
 *   - `OrgProjectsRootPage`: Redirige de forma declarativa y segura en el servidor.
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

interface OrgProjectsRootPageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Redirige la ruta de proyectos hacia la vista de credenciales del proyecto general.
 */
export default async function OrgProjectsRootPage({ params }: OrgProjectsRootPageProps): Promise<never> {
  const { orgSlug } = await params;
  redirect(`/dashboard/org/${encodeURIComponent(orgSlug)}/projects/general/keys`);
}
