/**
 * @archivo apps/web/src/app/superadmin/organizations/page.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin)
 * @proposito
 *   Vista principal de gobierno de organizaciones y tenants para el SuperAdmin de plataforma.
 *   Ensambla la grilla de búsqueda instantánea, el monitoreo de sesiones concurrentes en vivo,
 *   el modal disciplinario de suspensión forzosa y la cola de solicitudes Break-Glass.
 *
 * @resumen_contenido
 *   - Componente de página `SuperAdminOrganizationsPage`:
 *       * Envoltura dentro de `SuperAdminControlShell`.
 *       * Integración con `useSuperAdminTenantGovernance`.
 *       * Renderizado de `GlobalTenantGovernanceGrid`.
 *       * Modal de confirmación `SuspendTenantModal`.
 *       * Panel de desbloqueo `BreakGlassApprovalsPanel`.
 *
 * @dependencias_internas
 *   - `SuperAdminControlShell` (`@/components/superadmin/SuperAdminControlShell`).
 *   - `useSuperAdminTenantGovernance` (`@/components/superadmin/useSuperAdminTenantGovernance`).
 *   - `GlobalTenantGovernanceGrid` (`@/components/superadmin/GlobalTenantGovernanceGrid`).
 *   - `SuspendTenantModal`, `BreakGlassApprovalsPanel` (`@/components/superadmin/SuspendTenantAndBreakGlassModals`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Consume `/api/v1/superadmin/organizations/*` con privilegios de plataforma.
 */

'use client';

import React, { ReactElement, useState } from 'react';
import { SuperAdminControlShell } from '../../../components/superadmin/SuperAdminControlShell';
import {
  useSuperAdminTenantGovernance,
  type TenantGovernanceRecord,
} from '../../../components/superadmin/useSuperAdminTenantGovernance';
import { GlobalTenantGovernanceGrid } from '../../../components/superadmin/GlobalTenantGovernanceGrid';
import {
  SuspendTenantModal,
  BreakGlassApprovalsPanel,
} from '../../../components/superadmin/SuspendTenantAndBreakGlassModals';
import { DeleteTenantModal } from '../../../components/superadmin/DeleteTenantModal';

/**
 * Página de gobierno y auditoría de tenants de plataforma.
 */
export default function SuperAdminOrganizationsPage(): ReactElement {
  const {
    organizations,
    breakGlassRequests,
    isLoading,
    error,
    fetchOrganizations,
    suspendOrganization,
    reactivateOrganization,
    forceLogoutOrganization,
    deleteOrganization,
    approveBreakGlass,
  } = useSuperAdminTenantGovernance();

  const [selectedOrgForSuspend, setSelectedOrgForSuspend] = useState<TenantGovernanceRecord | null>(null);
  const [isSuspendModalOpen, setIsSuspendModalOpen] = useState<boolean>(false);

  const [selectedOrgForDelete, setSelectedOrgForDelete] = useState<TenantGovernanceRecord | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);

  const handleOpenSuspend = (org: TenantGovernanceRecord) => {
    setSelectedOrgForSuspend(org);
    setIsSuspendModalOpen(true);
  };

  const handleOpenDelete = (org: TenantGovernanceRecord) => {
    setSelectedOrgForDelete(org);
    setIsDeleteModalOpen(true);
  };

  const handleOpenReactivate = async (org: TenantGovernanceRecord) => {
    const notes = window.prompt(`Notas de reactivación para la organización "${org.name}":`, 'Reactivación administrativa aprobada');
    if (notes) {
      await reactivateOrganization(org.id, notes);
    }
  };

  const handleForceLogout = async (org: TenantGovernanceRecord) => {
    const reason = window.prompt(`Motivo de cierre forzoso de sesiones para "${org.name}":`, 'Mantenimiento de seguridad');
    if (reason) {
      await forceLogoutOrganization(org.id, reason);
    }
  };

  return (
    <SuperAdminControlShell currentPath="/superadmin/organizations">
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
            GOBIERNO / ORGANIZACIONES Y TENANTS
          </div>
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 400,
              margin: '0 0 6px',
              letterSpacing: '-0.015em',
            }}
          >
            Supervisión y Control Multi-Tenant
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
            Supervise todas las organizaciones cliente, su consumo de minutos, sesiones en vivo y ejecute
            acciones de suspensión o autorización de emergencia Break-Glass.
          </p>
        </header>

        {/* Mensaje de Error si aplica */}
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

        {/* Cola de Break-Glass de Emergencia */}
        <BreakGlassApprovalsPanel
          requests={breakGlassRequests}
          onApprove={approveBreakGlass}
        />

        {/* Grilla Global de Organizaciones */}
        <GlobalTenantGovernanceGrid
          organizations={organizations}
          isLoading={isLoading}
          onOpenSuspendModal={handleOpenSuspend}
          onOpenReactivateModal={handleOpenReactivate}
          onForceLogout={handleForceLogout}
          onOpenDeleteModal={handleOpenDelete}
          onRefresh={() => void fetchOrganizations()}
        />

        {/* Modal Flotante de Suspensión */}
        <SuspendTenantModal
          org={selectedOrgForSuspend}
          isOpen={isSuspendModalOpen}
          onClose={() => {
            setIsSuspendModalOpen(false);
            setSelectedOrgForSuspend(null);
          }}
          onConfirmSuspend={suspendOrganization}
        />

        {/* Modal Flotante de Eliminación Definitiva */}
        <DeleteTenantModal
          org={selectedOrgForDelete}
          isOpen={isDeleteModalOpen}
          onClose={() => {
            setIsDeleteModalOpen(false);
            setSelectedOrgForDelete(null);
          }}
          onConfirmDelete={deleteOrganization}
        />
      </div>
    </SuperAdminControlShell>
  );
}
