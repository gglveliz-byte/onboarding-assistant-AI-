/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/page.tsx
 * @modulo 08-frontend-dashboard-dev (Punto de Entrada a Proyectos)
 * @proposito
 *   Entrada del listado de proyectos de una organización. Resuelve en el cliente el primer
 *   proyecto real del tenant (vía `GET /api/v1/projects`) y navega a su consola de
 *   credenciales, sin depender de un slug de proyecto fijo.
 *
 * @resumen_contenido
 *   - `OrgProjectsRootPage`: monta `DashboardEntryRedirect` con el slug de la ruta.
 *
 * @dependencias_internas
 *   - `DashboardEntryRedirect` (apps/web/src/components/dashboard-dev/DashboardEntryRedirect.tsx).
 *
 * @dependencias_externas
 *   - `next/navigation` (`useParams`).
 *   - `react` (tipo `ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST): `projects` (lectura del tenant de la sesión).
 */

'use client';

import type { ReactElement } from 'react';
import { useParams } from 'next/navigation';
import { DashboardEntryRedirect } from '@/components/dashboard-dev/DashboardEntryRedirect';

export default function OrgProjectsRootPage(): ReactElement {
  const params = useParams();
  const orgSlug = String(params?.['orgSlug'] ?? '');
  return <DashboardEntryRedirect orgSlug={orgSlug} />;
}
