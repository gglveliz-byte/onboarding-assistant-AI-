/**
 * @archivo apps/web/src/components/superadmin/SuspendTenantAndBreakGlassModals.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Modales de intervención de seguridad para SuperAdmin (Cursor Atelier Light):
 *   1) Modal de Suspensión Inmediata con motivo obligatorio, revocación de API keys en Redis
 *      y corte forzoso de WebSockets activos con código `4003_TENANT_SUSPENDED`.
 *   2) Panel y modal de aprobación para tickets de emergencia Break-Glass de Owners.
 *
 * @resumen_contenido
 *   - Componente `SuspendTenantModal`: Modal flotante con borde `#cf2d56` Crimson y radio `8px`.
 *   - Componente `BreakGlassApprovalsPanel`: Cola de solicitudes de desbloqueo de emergencia MFA
 *     con botón `btn_approve_emergency_mfa_reset`.
 *
 * @dependencias_internas
 *   - `TenantGovernanceRecord`, `BreakGlassRequestRecord` de `useSuperAdminTenantGovernance.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Modifica `organizations.status = 'SUSPENDED'` y anula sesiones en Redis.
 */

import React, { ReactElement, useState } from 'react';
import type { TenantGovernanceRecord, BreakGlassRequestRecord } from './useSuperAdminTenantGovernance';

export interface SuspendTenantModalProps {
  readonly org: TenantGovernanceRecord | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConfirmSuspend: (orgId: string, reason: string) => Promise<boolean>;
}

export interface BreakGlassApprovalsPanelProps {
  readonly requests: readonly BreakGlassRequestRecord[];
  readonly onApprove: (requestId: string, orgId: string) => Promise<boolean>;
}

/**
 * Modal de suspensión forzada de una organización.
 */
export function SuspendTenantModal({
  org,
  isOpen,
  onClose,
  onConfirmSuspend,
}: SuspendTenantModalProps): ReactElement | null {
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !org) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 5) {
      setErrorMessage('El motivo de suspensión debe tener al menos 5 caracteres.');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    const ok = await onConfirmSuspend(org.id, reason.trim());
    setIsSubmitting(false);
    if (ok) {
      setReason('');
      onClose();
    } else {
      setErrorMessage('No se pudo aplicar la suspensión. Verifique permisos o conexión.');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(38, 37, 30, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
          border: '2px solid var(--color-crimson, #cf2d56)',
          borderRadius: 'var(--radius-modals, 8px)',
          width: '100%',
          maxWidth: '520px',
          padding: '28px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
          color: 'var(--color-ink, #26251e)',
          fontFamily: 'var(--font-cursorgothic, sans-serif)',
        }}
      >
        <div style={{ marginBottom: '16px' }}>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              color: 'var(--color-crimson, #cf2d56)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 600,
            }}
          >
            ACCIÓN DE GOBIERNO DISCIPLINARIO
          </span>
          <h3 style={{ margin: '4px 0 0', fontSize: '20px', fontWeight: 400 }}>
            Suspender Organización: {org.name}
          </h3>
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            ID: {org.id} | Slug: /{org.slug}
          </p>
        </div>

        <div
          style={{
            backgroundColor: 'rgba(207, 45, 86, 0.06)',
            border: '1px solid var(--color-crimson, #cf2d56)',
            borderRadius: '4px',
            padding: '12px',
            fontSize: '12px',
            lineHeight: 1.5,
            color: 'var(--color-ink, #26251e)',
            marginBottom: '16px',
          }}
        >
          <strong>Impacto inmediato de la suspensión:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
            <li>Todas las API keys de la organización se revocarán en caché Redis instantáneamente.</li>
            <li>Las sesiones WebSocket de voz activas se cortarán con código <code>4003_TENANT_SUSPENDED</code>.</li>
            <li>Se registrará una entrada inmutable con hash SHA-256 en la bitácora de auditoría forense.</li>
          </ul>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label
              htmlFor="suspend-reason"
              style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}
            >
              Motivo formal y auditable de la suspensión:
            </label>
            <textarea
              id="suspend-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describa el motivo (violación de términos, impago reiterado, incidente de seguridad)..."
              style={{
                width: '100%',
                backgroundColor: 'var(--color-bone, #f2f1ed)',
                border: '1px solid var(--color-stone, #cdcdc9)',
                borderRadius: '4px',
                padding: '10px',
                fontSize: '13px',
                color: 'var(--color-ink, #26251e)',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {errorMessage && (
            <div style={{ fontSize: '12px', color: 'var(--color-crimson, #cf2d56)' }}>
              {errorMessage}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid var(--color-stone, #cdcdc9)',
                borderRadius: '4px',
                padding: '8px 16px',
                fontSize: '13px',
                cursor: 'pointer',
                color: 'var(--color-ink, #26251e)',
              }}
            >
              Cancelar
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                backgroundColor: 'var(--color-crimson, #cf2d56)',
                border: '1px solid var(--color-crimson, #cf2d56)',
                borderRadius: '4px',
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--color-parchment, #f7f7f4)',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Aplicando suspensión...' : 'Confirmar Suspensión Inmediata'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Panel de cola de solicitudes de emergencia Break-Glass de Owners.
 */
export function BreakGlassApprovalsPanel({
  requests,
  onApprove,
}: BreakGlassApprovalsPanelProps): ReactElement {
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const handleApprove = async (requestId: string, orgId: string) => {
    setApprovingId(requestId);
    await onApprove(requestId, orgId);
    setApprovingId(null);
  };

  return (
    <section
      aria-labelledby="break-glass-title"
      style={{
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: 'var(--radius-cards, 4px)',
        padding: '24px',
        color: 'var(--color-ink, #26251e)',
      }}
    >
      <div style={{ marginBottom: '16px' }}>
        <h3
          id="break-glass-title"
          style={{ fontSize: '18px', fontWeight: 400, margin: 0, color: 'var(--color-ink, #26251e)' }}
        >
          Cola de Solicitudes de Emergencia Break-Glass
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
          Peticiones de restablecimiento de MFA y acceso de emergencia emitidas por Propietarios (Owners) bloqueados.
        </p>
      </div>

      {requests.length === 0 ? (
        <div
          style={{
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '24px',
            textAlign: 'center',
            fontSize: '13px',
            color: 'var(--color-driftwood, #84847e)',
          }}
        >
          No hay solicitudes de Break-Glass pendientes de resolución.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {requests.map((req) => (
            <div
              key={req.id}
              style={{
                backgroundColor: 'var(--color-parchment, #f7f7f4)',
                border: '1px solid var(--color-amber, #c08532)',
                borderRadius: '4px',
                padding: '16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '16px',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-berkeleymono, monospace)',
                    color: 'var(--color-amber, #c08532)',
                    fontWeight: 600,
                  }}
                >
                  SOLICITUD: {req.id.slice(0, 8)}... | FECHA: {new Date(req.requestedAt).toLocaleString()}
                </span>
                <div style={{ fontSize: '14px', fontWeight: 500, marginTop: '2px' }}>
                  {req.organizationName} ({req.requesterEmail})
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
                  Motivo: {req.reason}
                </p>
              </div>

              <button
                type="button"
                id="btn_approve_emergency_mfa_reset"
                disabled={approvingId === req.id}
                onClick={() => handleApprove(req.id, req.organizationId)}
                style={{
                  backgroundColor: 'var(--color-forest, #34785c)',
                  border: '1px solid var(--color-forest, #34785c)',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'var(--color-parchment, #f7f7f4)',
                  cursor: approvingId === req.id ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {approvingId === req.id ? 'Aprobando...' : 'Aprobar Reseteo MFA'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
