/**
 * @archivo apps/web/src/components/superadmin/GlobalTenantGovernanceGrid.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Grilla de alta densidad (Cursor Atelier Light) para la búsqueda instantánea y
 *   supervisión operacional de todos los tenants de la plataforma. Permite visualizar
 *   consumo acumulado, sesiones de voz concurrentes en vivo y lanzar acciones de gobierno.
 *
 * @resumen_contenido
 *   - Componente `GlobalTenantGovernanceGrid`:
 *       * Barra de búsqueda reactiva por ID, nombre, slug o dominio SSO.
 *       * Filtro por estado operativo (`ACTIVE`, `SUSPENDED`, `PENDING_DELETION`).
 *       * Tabla de datos densos con números tabulares (`tnum` en `berkeleyMono 12px`).
 *       * Botones de acción: "Suspender", "Reactivar" y "Cierre Forzoso de Sesiones".
 *
 * @dependencias_internas
 *   - `TenantGovernanceRecord` de `useSuperAdminTenantGovernance.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`, `useMemo`).
 *
 * @tablas_bd_o_redis
 *   - Visualiza datos de `organizations`, `whop_subscriptions` y sesiones de voz en Redis.
 */

import React, { ReactElement, useState, useMemo } from 'react';
import type { TenantGovernanceRecord } from './useSuperAdminTenantGovernance';

export interface GlobalTenantGovernanceGridProps {
  readonly organizations: readonly TenantGovernanceRecord[];
  readonly isLoading: boolean;
  readonly onOpenSuspendModal: (org: TenantGovernanceRecord) => void;
  readonly onOpenReactivateModal: (org: TenantGovernanceRecord) => void;
  readonly onForceLogout: (org: TenantGovernanceRecord) => void;
  readonly onRefresh: () => void;
}

const STATUS_BADGES: Record<string, { label: string; bg: string; color: string }> = {
  ACTIVE: { label: 'ACTIVO', bg: 'rgba(52, 120, 92, 0.1)', color: 'var(--color-forest, #34785c)' },
  SUSPENDED: { label: 'SUSPENDIDO', bg: 'rgba(207, 45, 86, 0.1)', color: 'var(--color-crimson, #cf2d56)' },
  PENDING_DELETION: { label: 'ELIMINACIÓN', bg: 'rgba(192, 133, 50, 0.1)', color: 'var(--color-amber, #c08532)' },
};

/**
 * Grilla de supervisión y gobierno global de organizaciones.
 */
export function GlobalTenantGovernanceGrid({
  organizations,
  isLoading,
  onOpenSuspendModal,
  onOpenReactivateModal,
  onForceLogout,
  onRefresh,
}: GlobalTenantGovernanceGridProps): ReactElement {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const filteredOrgs = useMemo(() => {
    return organizations.filter((org) => {
      if (statusFilter !== 'ALL' && org.status !== statusFilter) {
        return false;
      }
      if (searchQuery.trim().length > 0) {
        const query = searchQuery.toLowerCase();
        const matchesName = org.name.toLowerCase().includes(query);
        const matchesSlug = org.slug.toLowerCase().includes(query);
        const matchesId = org.id.toLowerCase().includes(query);
        const matchesDomain = org.ssoEmailDomain?.toLowerCase().includes(query) ?? false;
        return matchesName || matchesSlug || matchesId || matchesDomain;
      }
      return true;
    });
  }, [organizations, statusFilter, searchQuery]);

  return (
    <div
      style={{
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: 'var(--radius-cards, 4px)',
        padding: '24px',
        color: 'var(--color-ink, #26251e)',
      }}
    >
      {/* Barra de Búsqueda y Filtros Rápidos */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, maxWidth: '500px' }}>
          <input
            type="text"
            placeholder="Buscar por ID, nombre, slug o dominio SSO..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '8px 12px',
              fontSize: '13px',
              color: 'var(--color-ink, #26251e)',
              width: '100%',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '6px 10px',
              fontSize: '12px',
              color: 'var(--color-ink, #26251e)',
            }}
          >
            <option value="ALL">Todos los Estados</option>
            <option value="ACTIVE">Activas</option>
            <option value="SUSPENDED">Suspendidas</option>
            <option value="PENDING_DELETION">Pendientes de Eliminación</option>
          </select>

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            style={{
              backgroundColor: 'transparent',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '6px 12px',
              fontSize: '12px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              color: 'var(--color-ink, #26251e)',
            }}
          >
            {isLoading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* Tabla de Organizaciones */}
      <div
        style={{
          overflowX: 'auto',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--color-linen, #e6e5e0)', borderBottom: '1px solid var(--color-stone, #cdcdc9)' }}>
              <th style={{ padding: '10px 12px', fontWeight: 500 }}>Organización</th>
              <th style={{ padding: '10px 12px', fontWeight: 500 }}>Estado</th>
              <th style={{ padding: '10px 12px', fontWeight: 500 }}>Plan / Cap</th>
              <th style={{ padding: '10px 12px', fontWeight: 500, textAlign: 'center' }}>Sesiones Activas</th>
              <th style={{ padding: '10px 12px', fontWeight: 500 }}>Políticas Seguridad</th>
              <th style={{ padding: '10px 12px', fontWeight: 500, textAlign: 'right' }}>Acciones de Gobierno</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrgs.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--color-driftwood, #84847e)' }}>
                  {isLoading ? 'Cargando registros...' : 'No se encontraron organizaciones coincidentes.'}
                </td>
              </tr>
            ) : (
              filteredOrgs.map((org) => {
                const badge = STATUS_BADGES[org.status] ?? STATUS_BADGES['ACTIVE']!;
                return (
                  <tr
                    key={org.id}
                    style={{
                      borderBottom: '1px solid color-mix(in oklab, #26251e 6%, transparent)',
                      backgroundColor: org.status === 'SUSPENDED' ? 'rgba(207, 45, 86, 0.02)' : 'transparent',
                    }}
                  >
                    {/* Nombre y slug */}
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontWeight: 500, color: 'var(--color-ink, #26251e)', display: 'block' }}>
                        {org.name}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--color-driftwood, #84847e)',
                          fontFamily: 'var(--font-berkeleymono, monospace)',
                        }}
                      >
                        ID: {org.id.slice(0, 8)}... | /{org.slug}
                      </span>
                    </td>

                    {/* Badge de Estado */}
                    <td style={{ padding: '10px 12px' }}>
                      <span
                        style={{
                          fontSize: '10px',
                          fontFamily: 'var(--font-berkeleymono, monospace)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          backgroundColor: badge.bg,
                          color: badge.color,
                          fontWeight: 600,
                        }}
                      >
                        {badge.label}
                      </span>
                      {org.suspendedReason && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: '10px',
                            color: 'var(--color-crimson, #cf2d56)',
                            marginTop: '2px',
                          }}
                        >
                          Motivo: {org.suspendedReason.slice(0, 30)}...
                        </span>
                      )}
                    </td>

                    {/* Plan y Spend Cap */}
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--font-berkeleymono, monospace)' }}>
                      <span>{org.activeSubscriptionPlanCode ?? 'PLAN_5'}</span>
                      <span style={{ display: 'block', fontSize: '10px', color: 'var(--color-driftwood, #84847e)' }}>
                        Cap: {org.hardSpendCapUsd ? `$${org.hardSpendCapUsd}` : 'Sin límite'}
                      </span>
                    </td>

                    {/* Sesiones de Voz en Vivo */}
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-berkeleymono, monospace)',
                          fontWeight: 500,
                          fontSize: '13px',
                          color: (org.activeLiveVoiceSessions ?? 0) > 0 ? 'var(--color-forest, #34785c)' : 'var(--color-driftwood, #84847e)',
                        }}
                      >
                        {org.activeLiveVoiceSessions ?? 0}
                      </span>
                    </td>

                    {/* Seguridad y DPA */}
                    <td style={{ padding: '10px 12px', fontSize: '11px' }}>
                      <span>MFA: {org.enforceMfa ? 'Forzado' : 'Opcional'}</span>
                      <span style={{ display: 'block', color: org.dpaSignedAt ? 'var(--color-forest, #34785c)' : 'var(--color-crimson, #cf2d56)' }}>
                        DPA: {org.dpaSignedAt ? 'Firmado' : 'Pendiente'}
                      </span>
                    </td>

                    {/* Acciones */}
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                        {org.status === 'ACTIVE' ? (
                          <button
                            type="button"
                            onClick={() => onOpenSuspendModal(org)}
                            style={{
                              backgroundColor: 'transparent',
                              border: '1px solid var(--color-crimson, #cf2d56)',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              fontSize: '11px',
                              color: 'var(--color-crimson, #cf2d56)',
                              cursor: 'pointer',
                            }}
                          >
                            Suspender
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenReactivateModal(org)}
                            style={{
                              backgroundColor: 'transparent',
                              border: '1px solid var(--color-forest, #34785c)',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              fontSize: '11px',
                              color: 'var(--color-forest, #34785c)',
                              cursor: 'pointer',
                            }}
                          >
                            Reactivar
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onForceLogout(org)}
                          style={{
                            backgroundColor: 'transparent',
                            border: '1px solid var(--color-stone, #cdcdc9)',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            color: 'var(--color-ink, #26251e)',
                            cursor: 'pointer',
                          }}
                        >
                          Force Logout
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
