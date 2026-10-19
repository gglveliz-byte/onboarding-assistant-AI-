/**
 * @archivo apps/web/src/components/dashboard-dev/DashboardShellNavigation.tsx
 * @modulo 08-frontend-dashboard-dev (Controles de Navegación del Shell del Dashboard)
 * @proposito
 *   Extrae del shell maestro los controles de navegación de la cabecera y del pie: selector de
 *   organización, selector de proyecto, distintivo de entorno (LIVE/TEST) y pastilla de saldo de
 *   voz. Se separan en su propio módulo para mantener cada archivo por debajo del tope de 500
 *   líneas sin perder la estética Warm Parchment Atelier (radios de 4px, tinta #26251e).
 *
 * @resumen_contenido
 *   - `OrganizationSwitcher`: selector con truncado fluido; sin flecha cuando hay una sola organización.
 *   - `ProjectSwitcher`: selector de proyectos del tenant con distintivo de entorno.
 *   - `EnvironmentModeBadge`: distintivo LIVE (#34785c) vs TEST (#c08532).
 *   - `RealtimeBalancePill`: saldo en minutos en berkeleyMono con alerta >=85% de consumo.
 *
 * @dependencias_internas
 *   - Ninguna (componentes de presentación autónomos del shell del dashboard).
 *
 * @dependencias_externas
 *   - `react` (`useState`).
 *   - `next/link` (`Link`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (presentación pura; el saldo lo provee `useDashboardWorkspace`).
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * Selector desplegable de organización con truncado fluido.
 */
export function OrganizationSwitcher({
  currentOrgSlug,
  currentOrgName,
  orgs,
}: {
  readonly currentOrgSlug: string;
  readonly currentOrgName: string;
  readonly orgs: Array<{ slug: string; name: string }>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative inline-block text-left" data-testid="organization-switcher">
      <button
        type="button"
        onClick={() => {
          if (orgs.length > 1) {
            setIsOpen(!isOpen);
          }
        }}
        className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 text-xs font-normal text-[#26251e] bg-[#f2f1ed] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors"
        style={{ borderRadius: '4px' }}
        aria-label="Seleccionar organización activa"
        aria-expanded={isOpen}
      >
        <span className="w-2 h-2 rounded-full bg-[#34785c] flex-shrink-0" />
        <span className="font-sans font-medium tracking-tight truncate max-w-[85px] xs:max-w-[110px] sm:max-w-[140px]">
          {currentOrgName || currentOrgSlug}
        </span>
        {orgs.length > 1 && (
          <span className="text-[#84847e] text-[10px] flex-shrink-0">▼</span>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute left-0 mt-1 w-48 bg-[#f2f1ed] border border-[#cdcdc9] rounded shadow-sm z-50 py-1"
          style={{ borderRadius: '4px' }}
        >
          <div className="px-3 py-1 text-[11px] font-sans text-[#84847e] uppercase tracking-wider border-b border-[#cdcdc9]/50">
            Organizaciones
          </div>
          {orgs.map((org) => (
            <Link
              key={org.slug}
              href={`/dashboard/org/${org.slug}`}
              onClick={() => setIsOpen(false)}
              className={`block px-3 py-1.5 text-xs font-sans text-[#26251e] hover:bg-[#e6e5e0] transition-colors ${
                org.slug === currentOrgSlug ? 'bg-[#e6e5e0] font-medium' : ''
              }`}
            >
              <span className="truncate block">{org.name}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Selector desplegable de proyectos con truncado fluido.
 */
export function ProjectSwitcher({
  orgSlug,
  currentProjectId,
  projects,
}: {
  readonly orgSlug: string;
  readonly currentProjectId?: string;
  readonly projects: Array<{ id: string; name: string; slug: string; environment: 'LIVE' | 'TEST' }>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const activeProject = projects.find((p) => p.id === currentProjectId) ?? projects[0];

  return (
    <div className="relative inline-block text-left" data-testid="project-switcher">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 text-xs font-normal text-[#26251e] bg-[#f2f1ed] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors"
        style={{ borderRadius: '4px' }}
        aria-label="Seleccionar proyecto activo"
        aria-expanded={isOpen}
      >
        <span className="text-[#84847e] font-sans hidden sm:inline">Proyecto:</span>
        <span className="font-sans font-medium tracking-tight truncate max-w-[80px] xs:max-w-[100px] sm:max-w-[130px]">
          {activeProject?.name ?? 'Sin proyecto'}
        </span>
        <span className="text-[#84847e] text-[10px] flex-shrink-0">▼</span>
      </button>

      {isOpen && (
        <div
          className="absolute left-0 mt-1 w-52 bg-[#f2f1ed] border border-[#cdcdc9] rounded shadow-sm z-50 py-1"
          style={{ borderRadius: '4px' }}
        >
          <div className="px-3 py-1 text-[11px] font-sans text-[#84847e] uppercase tracking-wider border-b border-[#cdcdc9]/50">
            Proyectos del Tenant
          </div>
          {projects.map((proj) => (
            <Link
              key={proj.id}
              href={`/dashboard/org/${orgSlug}/projects/${proj.id}/keys`}
              onClick={() => setIsOpen(false)}
              className={`flex items-center justify-between px-3 py-1.5 text-xs font-sans text-[#26251e] hover:bg-[#e6e5e0] transition-colors ${
                proj.id === currentProjectId ? 'bg-[#e6e5e0] font-medium' : ''
              }`}
            >
              <span className="truncate">{proj.name}</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded font-mono ml-2 flex-shrink-0 ${
                  proj.environment === 'LIVE' ? 'bg-[#34785c]/10 text-[#34785c]' : 'bg-[#c08532]/10 text-[#c08532]'
                }`}
              >
                {proj.environment}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pastilla de entorno (LIVE vs TEST).
 */
export function EnvironmentModeBadge({ environment }: { readonly environment: 'LIVE' | 'TEST' }) {
  const isLive = environment === 'LIVE';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono border rounded ${
        isLive
          ? 'bg-[#34785c]/10 text-[#34785c] border-[#34785c]/30'
          : 'bg-[#c08532]/10 text-[#c08532] border-[#c08532]/30'
      }`}
      style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-[#34785c]' : 'bg-[#c08532]'}`} />
      {environment}
    </span>
  );
}

/**
 * Pastilla de saldo en tiempo real con alerta visual al 85% de consumo.
 */
export function RealtimeBalancePill({
  remainingMinutes = 0,
  totalPurchasedMinutes = 0,
}: {
  readonly remainingMinutes?: number;
  readonly totalPurchasedMinutes?: number;
}) {
  const consumedMinutes = Math.max(0, totalPurchasedMinutes - remainingMinutes);
  const consumptionPercentage =
    totalPurchasedMinutes > 0 ? (consumedMinutes / totalPurchasedMinutes) * 100 : 0;
  const isNearLimit = consumptionPercentage >= 85;

  return (
    <div
      className={`inline-flex items-center gap-1.5 sm:gap-2 px-2 sm:px-2.5 py-1 text-xs font-mono border rounded transition-colors ${
        isNearLimit
          ? 'bg-[#cf2d56]/10 text-[#cf2d56] border-[#cf2d56]/40'
          : 'bg-[#f2f1ed] text-[#26251e] border-[#cdcdc9]'
      }`}
      style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
      title={`Consumo: ${consumptionPercentage.toFixed(1)}% (${consumedMinutes}/${totalPurchasedMinutes} min)`}
    >
      <span className="text-[11px] text-[#84847e] font-sans hidden sm:inline">Saldo Voz:</span>
      <span className="font-semibold">{remainingMinutes.toFixed(1)}m</span>
      {isNearLimit && (
        <span
          className="text-[10px] px-1 py-0.2 bg-[#cf2d56] text-[#f7f7f4] rounded font-sans uppercase font-medium"
          style={{ borderRadius: '2px' }}
        >
          85%
        </span>
      )}
    </div>
  );
}
