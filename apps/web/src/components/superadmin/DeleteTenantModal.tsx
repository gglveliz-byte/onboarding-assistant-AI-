/**
 * @archivo apps/web/src/components/superadmin/DeleteTenantModal.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Modal de confirmación destructiva para la eliminación definitiva de organizaciones (tenants).
 *   Aplica el patrón de seguridad de doble confirmación (escribir el nombre o slug exacto del tenant)
 *   para prevenir borrados accidentales en entornos de producción, informando claramente sobre la
 *   revocación inmediata de API keys, cierre forzoso de llamadas de voz y desvinculación de usuarios.
 *
 * @resumen_contenido
 *   - Componente `DeleteTenantModal`:
 *       * Estilo Cursor Atelier Light con acento Carmesí (`#cf2d56`) para acciones irreversibles.
 *       * Resumen del tenant (nombre, slug, ID, minutos consumidos).
 *       * Entrada de texto de confirmación obligatoria.
 *       * Botones "Cancelar" y "Eliminar Organización Definitivamente".
 *
 * @dependencias_internas
 *   - `TenantGovernanceRecord` (`./useSuperAdminTenantGovernance.ts`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Provoca `DELETE /api/v1/superadmin/organizations/:orgId` (PostgreSQL y Redis).
 */

'use client';

import React, { ReactElement, useState, useEffect } from 'react';
import type { TenantGovernanceRecord } from './useSuperAdminTenantGovernance';

export interface DeleteTenantModalProps {
  readonly org: TenantGovernanceRecord | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConfirmDelete: (orgId: string) => Promise<boolean>;
}

/**
 * Modal de eliminación destructiva de organizaciones.
 */
export function DeleteTenantModal({
  org,
  isOpen,
  onClose,
  onConfirmDelete,
}: DeleteTenantModalProps): ReactElement | null {
  const [confirmationInput, setConfirmationInput] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setConfirmationInput('');
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen || !org) return null;

  const targetIdentifier = org.slug.toLowerCase();
  const isMatch = confirmationInput.trim().toLowerCase() === targetIdentifier ||
                  confirmationInput.trim().toLowerCase() === org.name.trim().toLowerCase();

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isMatch) {
      setErrorMessage(`Debe escribir exactamente "${org.slug}" para confirmar.`);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const ok = await onConfirmDelete(org.id);
      if (ok) {
        onClose();
      } else {
        setErrorMessage('Fallo al eliminar la organización. Verifique sus credenciales SuperAdmin.');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Error inesperado al eliminar');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(26, 25, 21, 0.65)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1.5px solid var(--color-crimson, #cf2d56)',
          borderRadius: 'var(--radius-cards, 8px)',
          maxWidth: '520px',
          width: '100%',
          padding: '28px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.25)',
          color: 'var(--color-ink, #26251e)',
        }}
      >
        {/* Cabecera Destructiva */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <span style={{ fontSize: '20px' }}>⚠️</span>
          <h2
            style={{
              fontSize: '18px',
              fontWeight: 600,
              margin: 0,
              color: 'var(--color-crimson, #cf2d56)',
              letterSpacing: '-0.01em',
            }}
          >
            Eliminar Organización Definitivamente
          </h2>
        </div>

        <p style={{ fontSize: '13px', lineHeight: 1.5, margin: '0 0 16px', color: 'var(--color-ink, #26251e)' }}>
          Esta acción es <strong>irreversible</strong> y purgará permanentemente a la organización{' '}
          <strong>{org.name}</strong> (slug: <code>{org.slug}</code>).
        </p>

        {/* Lista de Impactos Operativos */}
        <div
          style={{
            backgroundColor: 'rgba(207, 45, 86, 0.06)',
            border: '1px solid rgba(207, 45, 86, 0.2)',
            borderRadius: '4px',
            padding: '12px 14px',
            fontSize: '12px',
            lineHeight: 1.6,
            marginBottom: '18px',
            color: 'var(--color-ink, #26251e)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--color-crimson, #cf2d56)' }}>
            Efectos inmediatos de la eliminación:
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px' }}>
            <li>Se revocarán y eliminarán todas las API keys activas.</li>
            <li>Se cerrarán de inmediato las llamadas de voz en curso (código 4003).</li>
            <li>Se invalidarán los tokens de sesión de todos los miembros del tenant.</li>
            <li>Se liberará el slug comercial para futuros registros.</li>
          </ul>
        </div>

        {errorMessage && (
          <div
            style={{
              backgroundColor: 'rgba(207, 45, 86, 0.12)',
              border: '1px solid var(--color-crimson, #cf2d56)',
              borderRadius: '4px',
              padding: '10px',
              fontSize: '12px',
              color: 'var(--color-crimson, #cf2d56)',
              marginBottom: '16px',
            }}
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleConfirm} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label
              htmlFor="confirm-tenant-slug"
              style={{
                display: 'block',
                fontSize: '12px',
                fontWeight: 500,
                marginBottom: '6px',
                color: 'var(--color-ink, #26251e)',
              }}
            >
              Para confirmar, escribe <strong>{org.slug}</strong> a continuación:
            </label>
            <input
              id="confirm-tenant-slug"
              type="text"
              value={confirmationInput}
              onChange={(e) => setConfirmationInput(e.target.value)}
              placeholder={org.slug}
              autoComplete="off"
              style={{
                width: '100%',
                backgroundColor: 'var(--color-parchment, #f7f7f4)',
                border: isMatch ? '1.5px solid var(--color-crimson, #cf2d56)' : '1px solid var(--color-stone, #cdcdc9)',
                borderRadius: '4px',
                padding: '9px 12px',
                fontSize: '13px',
                fontFamily: 'var(--font-berkeleymono, monospace)',
                color: 'var(--color-ink, #26251e)',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid var(--color-stone, #cdcdc9)',
                borderRadius: '4px',
                padding: '8px 16px',
                fontSize: '12px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                color: 'var(--color-ink, #26251e)',
              }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!isMatch || isSubmitting}
              style={{
                backgroundColor: isMatch ? 'var(--color-crimson, #cf2d56)' : 'var(--color-stone, #cdcdc9)',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 18px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#ffffff',
                cursor: !isMatch || isSubmitting ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.15s ease',
              }}
            >
              {isSubmitting ? 'Eliminando...' : 'Eliminar Organización Definitivamente'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
