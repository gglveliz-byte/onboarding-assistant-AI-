/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/page.tsx
 * @modulo 08-frontend-dashboard-dev (Punto de Entrada por Organización)
 * @proposito
 *   Entrada del Dashboard para una organización concreta. Resuelve en el cliente el primer
 *   proyecto real del tenant (vía `GET /api/v1/projects` con el token de la sesión) y navega a
 *   su consola de credenciales, en vez de apuntar a un slug de proyecto fijo.
 *
 * @resumen_contenido
 *   - `OrgDashboardRootPage`: monta `DashboardEntryRedirect` con el slug de la ruta.
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

export default function OrgDashboardRootPage(): ReactElement {
  const params = useParams();
  const orgSlug = String(params?.['orgSlug'] ?? '');
  return <DashboardEntryRedirect orgSlug={orgSlug} />;
}
