/**
 * @archivo apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx
 * @modulo 08-frontend-dashboard-dev (Shell y Navegación del Desarrollador - Cursor Atelier Light)
 * @proposito
 *   Estructura la barra lateral y la cabecera fija para el Dashboard del Desarrollador.
 *   Implementa la estética Warm Parchment Atelier (#f7f7f4, #f2f1ed, #26251e), drawer lateral
 *   deslizante para móviles (< md) con backdrop oscurecido (#26251e/40), botón hamburguesa accesible,
 *   conmutadores con truncado fluido de nombres de organización y proyecto, badge de entorno
 *   LIVE/TEST y pastilla de saldo en tiempo real con tipografía tabular berkeleyMono.
 *
 * @resumen_contenido
 *   - Componente `OrganizationSwitcher`: Selector con truncado elástico y menú desplegable.
 *   - Componente `ProjectSwitcher`: Selector con truncado fluido de proyectos del tenant.
 *   - Componente `EnvironmentModeBadge`: Distintivo LIVE (#34785c) vs TEST (#c08532).
 *   - Componente `RealtimeBalancePill`: Saldo en minutos en berkeleyMono con alerta >=85%.
 *   - Componente `DeveloperDashboardShell`: Shell maestro con drawer responsive y navegación lateral.
 *
 * @dependencias_internas
 *   - Ninguna (Componente de presentación y navegación autónomo).
 *
 * @tablas_bd_o_redis
 *   - Consume estado del tenant y proyectos desde APIs REST /api/v1/projects.
 */

'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface DeveloperDashboardShellProps {
  readonly orgSlug: string;
  readonly projectId?: string;
  readonly orgName?: string;
  readonly availableOrgs?: Array<{ slug: string; name: string }>;
  readonly availableProjects?: Array<{ id: string; name: string; slug: string; environment: 'LIVE' | 'TEST' }>;
  readonly remainingMinutes?: number;
  readonly totalPurchasedMinutes?: number;
  readonly environment?: 'LIVE' | 'TEST';
  readonly userRole?: 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';
  readonly children: React.ReactNode;
}

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
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 text-xs font-normal text-[#26251e] bg-[#f2f1ed] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors"
        style={{ borderRadius: '4px' }}
        aria-label="Seleccionar organización activa"
        aria-expanded={isOpen}
      >
        <span className="w-2 h-2 rounded-full bg-[#34785c] flex-shrink-0" />
        <span className="font-sans font-medium tracking-tight truncate max-w-[85px] xs:max-w-[110px] sm:max-w-[140px]">
          {currentOrgName || currentOrgSlug}
        </span>
        <span className="text-[#84847e] text-[10px] flex-shrink-0">▼</span>
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
  remainingMinutes = 120,
  totalPurchasedMinutes = 200,
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

/**
 * Shell maestro del Dashboard del Desarrollador con Drawer deslizante para móviles.
 */
export function DeveloperDashboardShell({
  orgSlug,
  projectId = 'default',
  orgName = 'Organización Principal',
  availableOrgs = [{ slug: orgSlug, name: orgName }],
  availableProjects = [{ id: projectId, name: 'Proyecto Principal', slug: 'main', environment: 'LIVE' }],
  remainingMinutes = 245.5,
  totalPurchasedMinutes = 300,
  environment = 'LIVE',
  userRole = 'OWNER',
  children,
}: DeveloperDashboardShellProps) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    {
      label: 'Visor Trainer DOM',
      href: `/dashboard/org/${orgSlug}/projects/${projectId}/visual-trainer`,
      icon: '◎',
    },
    {
      label: 'Mapa RAG Dual',
      href: `/dashboard/org/${orgSlug}/projects/${projectId}/rag-map-editor`,
      icon: '☵',
    },
    {
      label: 'Estudio del Prompt',
      href: `/dashboard/org/${orgSlug}/projects/${projectId}/prompt-studio`,
      icon: '✎',
    },
    {
      label: 'API Keys y Dominios',
      href: `/dashboard/org/${orgSlug}/projects/${projectId}/keys`,
      icon: '⚿',
    },
    {
      label: 'Equipo y Seguridad',
      href: `/dashboard/org/${orgSlug}/team`,
      icon: '👥',
    },
    {
      label: 'Facturación Whop',
      href: `/dashboard/org/${orgSlug}/billing`,
      icon: '💳',
    },
  ];

  return (
    <div
      className="min-h-screen flex bg-[#f7f7f4] text-[#26251e] font-sans selection:bg-[#8BC4F8] selection:text-[#26251e]"
      data-portal="workspace-atelier"
    >
      {/* Backdrop táctil oscurecido (#26251e/40) en < md */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-[#26251e]/40 z-40 md:hidden transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Barra lateral Drawer deslizante: fija a la izquierda en < md, estática w-[220px] md:w-56 en desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 md:static w-[220px] md:w-56 flex-shrink-0 bg-[#f2f1ed] border-r border-[#cdcdc9] flex flex-col justify-between select-none transform transition-transform duration-200 ease-in-out ${
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
        aria-label="Navegación principal del dashboard"
      >
        <div>
          {/* Logo y Encabezado de Navegación con botón cerrar en móvil */}
          <div className="h-11 px-4 flex items-center justify-between border-b border-[#cdcdc9]">
            <Link
              href={`/dashboard/org/${orgSlug}`}
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center gap-2 text-sm font-sans font-medium tracking-tight text-[#26251e]"
            >
              <span className="w-3 h-3 bg-[#26251e] rounded-sm" />
              <span>Onboarding Studio</span>
            </Link>
            <div className="flex items-center gap-2">
              <EnvironmentModeBadge environment={environment} />
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="md:hidden p-1 text-[#84847e] hover:text-[#26251e] rounded transition-colors"
                aria-label="Cerrar navegación lateral"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Menú de Navegación Principal */}
          <nav className="p-3 space-y-1">
            <div className="px-2 py-1 text-[11px] font-sans uppercase tracking-wider text-[#84847e]">
              Herramientas de Proyecto
            </div>
            {navItems.map((item) => {
              const isActive = pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={`flex items-center justify-between px-3 py-2 text-xs font-sans rounded transition-colors ${
                    isActive
                      ? 'bg-[#e6e5e0] text-[#26251e] font-medium'
                      : 'text-[#84847e] hover:text-[#26251e] hover:bg-[#e6e5e0]/60'
                  }`}
                  style={{ borderRadius: '4px' }}
                >
                  <span className="flex items-center gap-2.5">
                    <span className="text-sm font-mono text-[#7a7974]">{item.icon}</span>
                    <span>{item.label}</span>
                  </span>
                  {isActive && <span className="w-1.5 h-1.5 rounded-full bg-[#34785c]" />}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Pie de Sidebar con Rol y Documentación */}
        <div className="p-3 border-t border-[#cdcdc9] space-y-2">
          <div className="flex items-center justify-between px-2 text-[11px] text-[#84847e] font-mono">
            <span>Rol:</span>
            <span className="text-[#26251e] font-medium">{userRole}</span>
          </div>
          <Link
            href="/docs"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block text-center px-3 py-1.5 text-xs text-[#84847e] hover:text-[#26251e] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors"
            style={{ borderRadius: '4px' }}
          >
            Ver Documentación Técnica
          </Link>
        </div>
      </aside>

      {/* Contenedor Principal */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Barra Superior Fija con botón hamburguesa accesible en < md */}
        <header className="h-11 px-3 sm:px-6 bg-[#f7f7f4] border-b border-[#cdcdc9] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(true)}
              className="md:hidden p-1.5 text-[#26251e] bg-[#f2f1ed] hover:bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors"
              style={{ borderRadius: '4px' }}
              aria-label="Abrir menú de navegación"
              aria-expanded={isMobileMenuOpen}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            <OrganizationSwitcher
              currentOrgSlug={orgSlug}
              currentOrgName={orgName}
              orgs={availableOrgs}
            />
            <span className="text-[#cdcdc9]">/</span>
            <ProjectSwitcher
              orgSlug={orgSlug}
              currentProjectId={projectId}
              projects={availableProjects}
            />
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <RealtimeBalancePill
              remainingMinutes={remainingMinutes}
              totalPurchasedMinutes={totalPurchasedMinutes}
            />
          </div>
        </header>

        {/* Lienzo de Contenido */}
        <main className="flex-1 overflow-auto p-3 sm:p-4 bg-[#f7f7f4]">{children}</main>
      </div>
    </div>
  );
}
