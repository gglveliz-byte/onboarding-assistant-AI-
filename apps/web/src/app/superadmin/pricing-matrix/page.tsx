/**
 * @archivo apps/web/src/app/superadmin/pricing-matrix/page.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin)
 * @proposito
 *   Vista de gestión de la Matriz Global de Precios Whop ($5 a $50 USD/mes + PAYG)
 *   y configuración de tramos escalonados de descuento por volumen para el SuperAdmin.
 *
 * @resumen_contenido
 *   - Componente de página `SuperAdminPricingMatrixPage`:
 *       * Envoltura dentro de `SuperAdminControlShell`.
 *       * Integración con `useSuperAdminPricingAndOverrides`.
 *       * Renderizado del editor `GlobalWhopPricingMatrixEditor`.
 *       * Auditoría de cambios de tarificación con FIDO2.
 *
 * @dependencias_internas
 *   - `SuperAdminControlShell` (`@/components/superadmin/SuperAdminControlShell`).
 *   - `useSuperAdminPricingAndOverrides` (`@/components/superadmin/useSuperAdminPricingAndOverrides`).
 *   - `GlobalWhopPricingMatrixEditor` (`@/components/superadmin/GlobalWhopPricingMatrixEditor`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Consume `PUT /api/v1/superadmin/pricing-matrix/:planCode`.
 */

'use client';

import React, { ReactElement } from 'react';
import { SuperAdminControlShell } from '../../../components/superadmin/SuperAdminControlShell';
import { useSuperAdminPricingAndOverrides } from '../../../components/superadmin/useSuperAdminPricingAndOverrides';
import { GlobalWhopPricingMatrixEditor } from '../../../components/superadmin/GlobalWhopPricingMatrixEditor';

/**
 * Página de configuración global de la matriz de precios Whop.
 */
export default function SuperAdminPricingMatrixPage(): ReactElement {
  const {
    plans,
    isLoading,
    error,
    updateGlobalPricingPlan,
    simulateFinancialImpact,
  } = useSuperAdminPricingAndOverrides();

  return (
    <SuperAdminControlShell currentPath="/superadmin/pricing-matrix">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {/* Cabecera */}
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
            GOBIERNO / TARIFICACIÓN Y CATÁLOGO
          </div>
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 400,
              margin: '0 0 6px',
              letterSpacing: '-0.015em',
            }}
          >
            Matriz Global de Precios Whop ($5 - $50 USD)
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
            Modifique en caliente las tarifas base de los planes activos, minutos incluidos y defina los
            tramos de descuento por volumen (10% a 50%) sincronizados con el checkout de la plataforma.
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

        {/* Editor de la Matriz Global */}
        <GlobalWhopPricingMatrixEditor
          plans={plans}
          isLoading={isLoading}
          onSavePlan={updateGlobalPricingPlan}
          onSimulate={(minutes, baseRate, discount) =>
            simulateFinancialImpact(minutes, baseRate, discount)
          }
        />
      </div>
    </SuperAdminControlShell>
  );
}
