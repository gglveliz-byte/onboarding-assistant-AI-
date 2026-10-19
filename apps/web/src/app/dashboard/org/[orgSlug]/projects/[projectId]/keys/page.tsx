/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/keys/page.tsx
 * @modulo 08-frontend-dashboard-dev (Página de API Keys Criptográficas y Dominios CORS)
 * @proposito
 *   Ensambla la consola de gestión de credenciales y orígenes para el SDK del proyecto.
 *   Aplica control de acceso basado en roles (RBAC) deshabilitando mutaciones para
 *   usuarios con rol VIEWER o BILLING, y enlazando los hooks reactivos de dominios y claves.
 *
 * @resumen_contenido
 *   - Ensamblado de `AllowedDomainsManager` y `ApiKeyLifecycleManager`.
 *   - Control de permisos RBAC según el rol del usuario en la organización.
 *   - Pestañas informativas sobre la integración segura del SDK y variables de entorno.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *   - `AllowedDomainsManager` (apps/web/src/components/dashboard-dev/AllowedDomainsManager.tsx).
 *   - `ApiKeyLifecycleManager` (apps/web/src/components/dashboard-dev/ApiKeyLifecycleManager.tsx).
 *   - `useAllowedDomains`, `useApiKeys` (apps/web/src/components/dashboard-dev/useProjectsAndApiKeys.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`.
 */

'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { DeveloperDashboardShell } from '@/components/dashboard-dev/DeveloperDashboardShell';
import { AllowedDomainsManager } from '@/components/dashboard-dev/AllowedDomainsManager';
import { ApiKeyLifecycleManager } from '@/components/dashboard-dev/ApiKeyLifecycleManager';
import { useResolvedProjectId, type ApiKeyItem } from '@/components/dashboard-dev/useProjectsAndApiKeys';
import { useAllowedDomains, useApiKeys } from '@/components/dashboard-dev/useAllowedDomainsAndApiKeys';
import { useDashboardSessionFacts } from '@/components/dashboard-dev/useDashboardWorkspace';

export default function ProjectKeysPage() {
  const params = useParams();
  const orgSlug = String(params?.['orgSlug'] ?? 'default-org');
  const projectId = String(params?.['projectId'] ?? 'proj_default_live');

  // Rol real de la sesión vigente (reclamo `role` del token de acceso de la pestaña).
  const session = useDashboardSessionFacts();
  const userRole = session.role ?? 'DEVELOPER';
  const isReadOnly = userRole === 'VIEWER' || userRole === 'BILLING';

  // UUID real del proyecto (la URL puede llevar el slug) para las llamadas a la API.
  const { projectId: resolvedProjectId } = useResolvedProjectId(projectId);

  const { domains, addDomain, removeDomain } = useAllowedDomains(projectId);
  const { apiKeys, createApiKey, rotateApiKey, revokeApiKey } = useApiKeys(projectId);

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      projectId={projectId}
      userRole={userRole}
      environment="LIVE"
    >
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Encabezado Principal */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-[#cdcdc9] pb-4">
          <div>
            <h1 className="text-[26px] font-sans font-normal tracking-[-0.012em] text-[#26251e]">
              API Keys y Orígenes del SDK
            </h1>
            <p className="text-sm font-sans text-[#84847e] mt-1">
              Credenciales criptográficas para inicializar el asistente de voz y enlazar dominios autorizados.
            </p>
          </div>

          {isReadOnly && (
            <div className="px-3 py-1 bg-[#84847e]/10 border border-[#84847e]/30 rounded text-xs font-mono text-[#84847e] self-start sm:self-auto">
              Modo Solo Lectura (Rol: {userRole})
            </div>
          )}
        </div>

        {/* Aviso de cobertura de la API: el listado de claves y orígenes aún no está expuesto */}
        <p className="text-[11px] font-mono text-[#84847e]">
          El backend expone la creación, rotación y revocación de claves y orígenes, pero todavía no
          su listado: las tablas reflejan únicamente lo emitido en esta sesión.
        </p>

        {/* Sección 1: Gestor de Claves de API */}
        <ApiKeyLifecycleManager
          projectId={projectId}
          environment="LIVE"
          apiKeys={apiKeys}
          onCreateKey={createApiKey}
          onRotateKey={rotateApiKey}
          onRevokeKey={revokeApiKey}
          isReadOnly={isReadOnly}
        />

        {/* Sección 2: Gestor de Dominios CORS para Handshake */}
        <AllowedDomainsManager
          projectId={projectId}
          environment="LIVE"
          domains={domains}
          onAddDomain={addDomain}
          onRemoveDomain={removeDomain}
          isReadOnly={isReadOnly}
        />

        {/* Sección 3: Guía Rápida de Integración del SDK */}
        <div
          className="bg-[#f2f1ed] p-5 border border-[#cdcdc9] rounded space-y-3"
          style={{ borderRadius: '4px' }}
        >
          <div className="flex items-center gap-2 text-xs font-mono text-[#26251e] font-semibold">
            <span>📦</span>
            <span>Snippet Rápido de Inicialización en Frontend</span>
          </div>
          <p className="text-xs font-sans text-[#84847e]">
            Pega tu clave pública <span className="font-mono text-[#26251e]">pk_live_...</span> en tu aplicación cliente:
          </p>
          <pre
            className="p-3 bg-[#f7f7f4] border border-[#cdcdc9] rounded text-[12px] font-mono text-[#26251e] overflow-x-auto leading-relaxed"
            style={{ borderRadius: '4px', fontVariantNumeric: 'tabular-nums' }}
          >
            {`import { OnboardingAssistant } from '@onboarding-assistant/sdk';

// Inicialización en el cliente web
const assistant = await OnboardingAssistant.init({
  publishableKey: '${apiKeys.find((k: ApiKeyItem) => k.keyType === 'pk')?.keyPrefix || 'pk_live_...' }...',
  projectId: '${resolvedProjectId ?? projectId}',
});`}
          </pre>
        </div>
      </div>
    </DeveloperDashboardShell>
  );
}
