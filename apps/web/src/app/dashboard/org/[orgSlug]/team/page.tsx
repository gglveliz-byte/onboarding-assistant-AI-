/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/team/page.tsx
 * @modulo 08-frontend-dashboard-dev (Página de Equipo, RBAC y Cumplimiento GDPR)
 * @proposito
 *   Permite gestionar los miembros de la organización con roles RBAC (OWNER, DEVELOPER,
 *   BILLING, VIEWER), enviar invitaciones seguras por correo, ejecutar reseteo administrativo
 *   de factores MFA ante pérdida de dispositivos, y ejercer derechos GDPR (portabilidad y supresión).
 *
 * @resumen_contenido
 *   - Tabla de integrantes con scroll horizontal en móvil (mín. 720 px) y acciones por fila.
 *   - Modal de invitación de nuevo miembro con asignación de rol.
 *   - Botón administrativo de reseteo sudo de MFA (`btn_reset_member_mfa`).
 *   - Panel de gobernanza GDPR con exportación de datos (`btn_export_org_data`) y borrado.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `memberships`, `users`, `organizations`.
 */

'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { DeveloperDashboardShell } from '../../../../../components/dashboard-dev/DeveloperDashboardShell';
import { backendFetch } from '../../../../../lib/api-client/http-client';

interface TeamMember {
  id: string;
  email: string;
  fullName: string;
  role: 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';
  mfaEnabled: boolean;
  joinedAtIso: string;
}

export default function OrganizationTeamPage() {
  const params = useParams();
  const orgSlug = String(params?.['orgSlug'] ?? 'default-org');

  // El backend aún no expone el listado de miembros del tenant: la tabla arranca vacía y
  // refleja solo lo que la API entregue. Nada de integrantes de demostración.
  const [members, setMembers] = useState<TeamMember[]>([]);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'DEVELOPER' | 'BILLING' | 'VIEWER'>('DEVELOPER');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isDeletingOrg, setIsDeletingOrg] = useState(false);
  const [confirmDeleteText, setConfirmDeleteText] = useState('');

  const handleInviteMember = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) return;

    // El envío de invitaciones todavía no está expuesto por la API: se informa con claridad en
    // lugar de simular un alta que el servidor nunca registró.
    setInviteEmail('');
    setStatusMessage(
      `El envío de invitaciones aún no está expuesto por la API: la solicitud para ${inviteEmail} no se registró.`
    );
    setTimeout(() => setStatusMessage(null), 6000);
  };

  const handleResetMemberMfa = (memberId: string, memberEmail: string) => {
    if (!confirm(`¿Restablecer el factor MFA para ${memberEmail}? El usuario deberá configurarlo nuevamente.`)) {
      return;
    }
    setMembers(members.map((m) => (m.id === memberId ? { ...m, mfaEnabled: false } : m)));
    setStatusMessage(
      `El reseteo de MFA de ${memberEmail} se refleja en la vista, pero el backend aún no expone el `
      + 'endpoint de administración: no se ha ejecutado en el servidor.',
    );
    setTimeout(() => setStatusMessage(null), 6000);
  };

  /** Descarga la portabilidad GDPR REAL que produce el backend (`GET /api/v1/legal/gdpr/export`). */
  const handleExportData = async () => {
    setStatusMessage('Generando la exportación GDPR desde el servidor…');
    try {
      const payload = await backendFetch<unknown>('/api/v1/legal/gdpr/export');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gdpr-export-${orgSlug}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatusMessage('Exportación GDPR descargada desde el servidor.');
    } catch (caught) {
      setStatusMessage(
        caught instanceof Error
          ? `No fue posible exportar los datos: ${caught.message}`
          : 'No fue posible exportar los datos personales.',
      );
    }
    setTimeout(() => setStatusMessage(null), 6000);
  };

  return (
    <DeveloperDashboardShell orgSlug={orgSlug} userRole="OWNER">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Cabecera Editorial */}
        <div>
          <h1 className="text-[26px] font-sans font-normal tracking-[-0.012em] text-[#26251e]">
            Equipo, Permisos y Cumplimiento
          </h1>
          <p className="text-sm font-sans text-[#84847e] mt-1">
            Administra los roles de acceso, credenciales de segundo factor y normativas de privacidad GDPR.
          </p>
        </div>

        {statusMessage && (
          <div
            className="p-3 text-xs font-mono bg-[#1f8a65]/10 text-[#1f8a65] border border-[#1f8a65]/30 rounded"
            style={{ borderRadius: '4px' }}
          >
            ✓ {statusMessage}
          </div>
        )}

        {/* Sección 1: Formulario de Invitación */}
        <div
          className="bg-[#f2f1ed] p-5 border border-[#cdcdc9] rounded"
          style={{ borderRadius: '4px' }}
        >
          <h2 className="text-sm font-sans font-medium text-[#26251e] mb-3">
            Invitar a un nuevo colaborador
          </h2>
          <form onSubmit={handleInviteMember} className="flex flex-wrap gap-3 items-center">
            <input
              type="email"
              placeholder="correo@empresa.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="flex-1 min-w-[240px] px-3 py-1.5 text-xs font-sans bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] placeholder:text-[#a1a19f] focus:outline-none focus:border-[#26251e]"
              style={{ borderRadius: '4px' }}
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as any)}
              className="px-3 py-1.5 text-xs font-sans bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
              style={{ borderRadius: '4px' }}
            >
              <option value="DEVELOPER">DEVELOPER (Acceso a claves y RAG)</option>
              <option value="BILLING">BILLING (Suscripción y pagos)</option>
              <option value="VIEWER">VIEWER (Solo lectura)</option>
            </select>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-sans font-medium bg-[#26251e] text-[#f7f7f4] hover:bg-[#3d3b31] rounded transition-colors"
              style={{ borderRadius: '4px' }}
            >
              Enviar Invitación
            </button>
          </form>
        </div>

        {/* Sección 2: Tabla de Miembros */}
        <div
          className="bg-[#f2f1ed] border border-[#cdcdc9] rounded overflow-hidden"
          style={{ borderRadius: '4px' }}
        >
          <div className="px-5 py-3 border-b border-[#cdcdc9] flex items-center justify-between gap-3 bg-[#e6e5e0]/40">
            <h2 className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
              Miembros Activos ({members.length})
            </h2>
            <span className="sm:hidden text-[10px] font-mono text-[#84847e] whitespace-nowrap">
              Desliza →
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs font-sans">
            <thead className="bg-[#e6e5e0]/60 text-[#84847e] border-b border-[#cdcdc9]">
              <tr>
                <th className="px-5 py-2.5 font-normal">Usuario</th>
                <th className="px-5 py-2.5 font-normal">Rol RBAC</th>
                <th className="px-5 py-2.5 font-normal">Segundo Factor (MFA)</th>
                <th className="px-5 py-2.5 font-normal">Fecha Ingreso</th>
                <th className="px-5 py-2.5 font-normal text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#cdcdc9]">
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-xs font-sans text-[#84847e]">
                    No hay miembros que mostrar: el backend aún no expone el listado de miembros del
                    tenant (endpoint de lectura pendiente). Los roles reales se reflejarán aquí en
                    cuanto la API los entregue.
                  </td>
                </tr>
              ) : (
                members.map((member) => (
                <tr key={member.id} className="hover:bg-[#e6e5e0]/30 transition-colors">
                  <td className="px-5 py-3">
                    <div className="font-medium text-[#26251e]">{member.fullName}</div>
                    <div className="text-[#84847e] text-[11px] font-mono">{member.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-[10px] font-mono rounded ${
                        member.role === 'OWNER'
                          ? 'bg-[#34785c]/10 text-[#34785c]'
                          : member.role === 'DEVELOPER'
                          ? 'bg-[#c08532]/10 text-[#c08532]'
                          : 'bg-[#84847e]/10 text-[#84847e]'
                      }`}
                      style={{ borderRadius: '4px' }}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {member.mfaEnabled ? (
                      <span className="text-[#1f8a65] font-mono flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#1f8a65]" />
                        Activo (FIDO2/TOTP)
                      </span>
                    ) : (
                      <span className="text-[#84847e] font-mono">Inactivo</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[#84847e] font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {member.joinedAtIso.split('T')[0]}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {member.role !== 'OWNER' && (
                      <button
                        type="button"
                        onClick={() => handleResetMemberMfa(member.id, member.email)}
                        className="px-2.5 py-1 text-[11px] font-mono text-[#c08532] hover:bg-[#c08532]/10 border border-[#c08532]/30 rounded transition-colors"
                        style={{ borderRadius: '4px' }}
                        data-testid="btn_reset_member_mfa"
                        title="Reseteo administrativo de MFA en caso de bloqueo"
                      >
                        Reset MFA Sudo
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
            </tbody>
            </table>
          </div>
        </div>

        {/* Sección 3: Cumplimiento GDPR y Privacidad */}
        <div
          className="bg-[#f2f1ed] p-5 border border-[#cdcdc9] rounded space-y-4"
          style={{ borderRadius: '4px' }}
        >
          <div>
            <h2 className="text-sm font-sans font-medium text-[#26251e]">
              Gobernanza y Cumplimiento GDPR
            </h2>
            <p className="text-xs font-sans text-[#84847e] mt-0.5">
              Descarga snapshots completos de auditoría o tramita la supresión definitiva de la organización.
            </p>
          </div>

          <div className="flex flex-wrap gap-4 pt-2">
            <button
              type="button"
              onClick={handleExportData}
              className="px-4 py-2 text-xs font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] border border-[#cdcdc9] rounded transition-colors flex items-center gap-2"
              style={{ borderRadius: '4px' }}
              data-testid="btn_export_org_data"
            >
              <span>📥</span>
              <span>Exportar Datos del Tenant (Portabilidad GDPR)</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDeletingOrg(true)}
              className="px-4 py-2 text-xs font-sans text-[#cf2d56] hover:bg-[#cf2d56]/10 border border-[#cf2d56]/40 rounded transition-colors"
              style={{ borderRadius: '4px' }}
              data-testid="btn_delete_organization"
            >
              Eliminar Organización
            </button>
          </div>

          {/* Modal de confirmación para eliminar organización */}
          {isDeletingOrg && (
            <div
              className="p-4 bg-[#f7f7f4] border border-[#cf2d56]/50 rounded space-y-3 mt-4"
              style={{ borderRadius: '4px' }}
            >
              <div className="text-xs text-[#cf2d56] font-medium font-sans">
                ⚠️ Acción destructiva irreversible
              </div>
              <p className="text-xs text-[#84847e] font-sans">
                Para confirmar la baja definitiva y la purga de claves RLS y mapas RAG de esta organización,
                escribe el slug exacto: <span className="font-mono text-[#26251e] font-semibold">{orgSlug}</span>
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={confirmDeleteText}
                  onChange={(e) => setConfirmDeleteText(e.target.value)}
                  placeholder={orgSlug}
                  className="px-3 py-1.5 text-xs font-mono bg-[#f2f1ed] border border-[#cdcdc9] rounded text-[#26251e] focus:outline-none"
                  style={{ borderRadius: '4px' }}
                />
                <button
                  type="button"
                  disabled={confirmDeleteText !== orgSlug}
                  onClick={() => {
                    alert('El backend aún no expone el borrado de organizaciones: no se ejecutó ninguna baja.');
                    setIsDeletingOrg(false);
                  }}
                  className="px-3 py-1.5 text-xs font-sans bg-[#cf2d56] text-[#f7f7f4] rounded disabled:opacity-40 transition-opacity"
                  style={{ borderRadius: '4px' }}
                >
                  Confirmar Supresión
                </button>
                <button
                  type="button"
                  onClick={() => setIsDeletingOrg(false)}
                  className="px-3 py-1.5 text-xs font-sans text-[#84847e] hover:bg-[#e6e5e0] rounded"
                  style={{ borderRadius: '4px' }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </DeveloperDashboardShell>
  );
}
