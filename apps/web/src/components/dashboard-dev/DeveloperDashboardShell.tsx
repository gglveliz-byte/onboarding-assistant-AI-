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
 *   - `DeveloperDashboardShell`: Shell maestro con drawer responsive y navegación lateral.
 *   - Controles de navegación (selectores, distintivo de entorno y pastilla de saldo) en
 *     `DashboardShellNavigation.tsx` (módulo hermano).
 *   - Datos reales: organización, rol, proyectos y saldo provienen de `useDashboardWorkspace`
 *     (token de la sesión de la pestaña + `GET /api/v1/projects` + `GET /api/v1/billing/consumption`).
 *   - Sin sesión activa el shell muestra «Iniciar sesión» en lugar de cifras de demostración.
 *
 * @dependencias_internas
 *   - `useDashboardWorkspace` (./useDashboardWorkspace.ts): hechos reales de sesión y workspace.
 *   - `DashboardShellNavigation` (./DashboardShellNavigation.tsx): selectores y pastillas.
 *
 * @tablas_bd_o_redis
 *   - Consume estado del tenant y proyectos desde APIs REST /api/v1/projects.
 */

'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDashboardWorkspace } from './useDashboardWorkspace';
import {
  EnvironmentModeBadge,
  OrganizationSwitcher,
  ProjectSwitcher,
  RealtimeBalancePill,
} from './DashboardShellNavigation';

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
 * Shell maestro del Dashboard del Desarrollador con Drawer deslizante para móviles.
 */
export function DeveloperDashboardShell({
  orgSlug,
  projectId = '',
  orgName = '',
  availableOrgs = [],
  availableProjects = [],
  remainingMinutes = 0,
  totalPurchasedMinutes = 0,
  environment = 'LIVE',
  userRole = 'OWNER',
  children,
}: DeveloperDashboardShellProps) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const workspace = useDashboardWorkspace(projectId);

  // Hechos reales: rol del token de la sesión, proyectos del tenant y saldo del ciclo.
  const session = workspace.session;
  const hasSession = session.isAuthenticated;
  const effectiveRole = session.role ?? userRole;
  const displayOrgName = orgName.length > 0 ? orgName : orgSlug;
  const activeProjectId = workspace.activeProject?.id ?? projectId;
  const resolvedProjects = workspace.projects.length > 0
    ? workspace.projects.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        environment: project.environment,
      }))
    : availableProjects;
  const resolvedOrgs = availableOrgs.length > 0 ? availableOrgs : [{ slug: orgSlug, name: displayOrgName }];
  const balanceMinutes = hasSession ? workspace.balance.remainingMinutes : remainingMinutes;
  const balanceTotal = hasSession ? workspace.balance.totalPurchasedMinutes : totalPurchasedMinutes;

  const navItems = [
    {
      label: 'Visor Trainer DOM',
      href: `/dashboard/org/${orgSlug}/projects/${activeProjectId}/visual-trainer`,
      icon: '◎',
    },
    {
      label: 'Mapa RAG Dual',
      href: `/dashboard/org/${orgSlug}/projects/${activeProjectId}/rag-map-editor`,
      icon: '☵',
    },
    {
      label: 'Estudio del Prompt',
      href: `/dashboard/org/${orgSlug}/projects/${activeProjectId}/prompt-studio`,
      icon: '✎',
    },
    {
      label: 'API Keys y Dominios',
      href: `/dashboard/org/${orgSlug}/projects/${activeProjectId}/keys`,
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
            <span className="text-[#26251e] font-medium">{effectiveRole}</span>
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
              currentOrgName={displayOrgName}
              orgs={resolvedOrgs}
            />
            <span className="text-[#cdcdc9]">/</span>
            <ProjectSwitcher
              orgSlug={orgSlug}
              currentProjectId={activeProjectId}
              projects={resolvedProjects}
            />
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {!session.isResolved ? (
              <span
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-mono text-[#84847e] bg-[#f2f1ed] border border-[#cdcdc9] rounded whitespace-nowrap"
                style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
                title="Resolviendo la sesión de la pestaña"
              >
                Saldo Voz: —
              </span>
            ) : hasSession ? (
              <RealtimeBalancePill
                remainingMinutes={balanceMinutes}
                totalPurchasedMinutes={balanceTotal}
              />
            ) : (
              <Link
                href="/auth/login"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-sans text-[#f54e00] bg-[#f2f1ed] border border-[#cdcdc9] rounded hover:border-[#26251e] transition-colors whitespace-nowrap"
                style={{ borderRadius: '4px' }}
                title="Inicia sesión para consultar los datos reales de tu organización"
              >
                Iniciar sesión
              </Link>
            )}
          </div>
        </header>

        {/* Aviso de error del workspace (proyectos o consumo no disponibles) */}
        {workspace.error !== null && (
          <div
            className="px-3 sm:px-6 py-1.5 bg-[#cf2d56]/10 border-b border-[#cf2d56]/30 text-[11px] font-sans text-[#cf2d56]"
            role="status"
            data-testid="dashboard-workspace-error"
          >
            {workspace.error}
          </div>
        )}

        {/* Lienzo de Contenido */}
        <main className="flex-1 overflow-auto p-3 sm:p-4 bg-[#f7f7f4]">{children}</main>
      </div>
    </div>
  );
}
