/**
 * @archivo apps/web/src/app/billing/page.tsx
 * @modulo apps/web (Rutas Directas de Facturación y Consumo - Tema Claro)
 * @proposito
 *   Página de acceso directo a la consola de facturación y planes (/billing) bajo
 *   la estética de Tema Claro (Cursor Atelier Light). Resuelve la organización activa o
 *   permite navegar rápidamente a las opciones de suscripción y saldo.
 *
 * @resumen_contenido
 *   - Componente `BillingRedirectOrDirectPage`:
 *       * Renderiza el portal de facturación con el identificador de organización por defecto o activo.
 *       * Integración directa con `OrganizationBillingPage`.
 *
 * @dependencias_internas
 *   - `OrganizationBillingPage` de `../dashboard/org/[orgSlug]/billing/page`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 */

'use client';

import React, { ReactElement } from 'react';
import OrganizationBillingPage from '../dashboard/org/[orgSlug]/billing/page';

/**
 * Entrada directa a /billing para acceso rápido o navegación desde la landing comercial.
 */
export default function BillingDirectPortalPage(): ReactElement {
  // Organización predeterminada para navegación directa o sesión actual
  const defaultOrgParams = { orgSlug: 'default-org' };

  return <OrganizationBillingPage params={defaultOrgParams} />;
}
