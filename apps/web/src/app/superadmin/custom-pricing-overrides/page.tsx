/**
 * @archivo apps/web/src/app/superadmin/custom-pricing-overrides/page.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin)
 * @proposito
 *   Vista de gestión de tarifas personalizadas por cliente, descuentos especiales y
 *   acreditación de minutos de cortesía con registro inmutable en el libro mayor.
 *
 * @resumen_contenido
 *   - Componente de página `SuperAdminCustomPricingOverridesPage`:
 *       * Envoltura dentro de `SuperAdminControlShell`.
 *       * Integración con `useSuperAdminPricingAndOverrides`.
 *       * Renderizado del componente `TenantPricingOverrideManager`.
 *
 * @dependencias_internas
 *   - `SuperAdminControlShell` (`@/components/superadmin/SuperAdminControlShell`).
 *   - `useSuperAdminPricingAndOverrides` (`@/components/superadmin/useSuperAdminPricingAndOverrides`).
 *   - `TenantPricingOverrideManager` (`@/components/superadmin/TenantPricingOverrideManager`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Modifica `organization_pricing_overrides` y `usage_ledger`.
 */

'use client';

import React, { ReactElement } from 'react';
import { SuperAdminControlShell } from '../../../components/superadmin/SuperAdminControlShell';
import { useSuperAdminPricingAndOverrides } from '../../../components/superadmin/useSuperAdminPricingAndOverrides';
import { TenantPricingOverrideManager } from '../../../components/superadmin/TenantPricingOverrideManager';

/**
 * Página de tarifas preferenciales a medida y minutos de cortesía.
 */
export default function SuperAdminCustomPricingOverridesPage(): ReactElement {
  const {
    setTenantOverride,
    removeTenantOverride,
    grantPromotionalMinutes,
    error,
  } = useSuperAdminPricingAndOverrides();

  return (
    <SuperAdminControlShell currentPath="/superadmin/custom-pricing-overrides">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {/* Cabecera de Página */}
        <header style={{ borderBottom: '1px solid var(--color-stone, #cdcdc9)', paddingBottom: '16px' }}>
          <div
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              color: 'var(--color-driftwood, #84847e)',
              textTransform: 'uppercase',
              marginBottom: '4px',
            }}
          >
            GOBIERNO / TARIFAS A MEDIDA Y CORTESÍAS
          </div>
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 400,
              margin: '0 0 6px',
              letterSpacing: '-0.015em',
            }}
          >
            Overrides Comerciales y Minutos Promocionales
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
            Configure condiciones tarifarias excepcionales por cliente con precedencia total sobre el
            catálogo general, o acredite minutos de cortesía auditables en el libro mayor.
          </p>
        </header>

        {/* Notificación de Error */}
        {error && (
          <div
            role="alert"
            style={{
              backgroundColor: 'rgba(207, 45, 86, 0.08)',
              border: '1px solid var(--color-crimson, #cf2d56)',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '13px',
              color: 'var(--color-crimson, #cf2d56)',
            }}
          >
            {error}
          </div>
        )}

        {/* Gestor de Overrides y Cortesías */}
        <TenantPricingOverrideManager
          onApplyOverride={setTenantOverride}
          onRemoveOverride={removeTenantOverride}
          onGrantPromotionalMinutes={grantPromotionalMinutes}
        />
      </div>
    </SuperAdminControlShell>
  );
}
