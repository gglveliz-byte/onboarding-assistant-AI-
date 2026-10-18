/**
 * @archivo apps/web/src/app/superadmin/infrastructure/page.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin - Tema Claro)
 * @proposito
 *   Vista de infraestructura, monitoreo de telemetría acústica TTFA en tiempo real (SSE),
 *   comando del Kill-Switch de voz y exploración forense SOC2 encadenada con SHA-256
 *   bajo la estética Tema Claro.
 *
 * @resumen_contenido
 *   - Componente de página `SuperAdminInfrastructurePage`:
 *       * Envoltura dentro de `SuperAdminControlShell`.
 *       * Integración reactiva con `useRealtimeInfraTelemetrySse`.
 *       * Renderizado de `RealtimeInfraTelemetryPanel` con botón Kill-Switch y alertas Anti-SSRF.
 *       * Renderizado de `ImmutableAuditLogExplorer` con verificación de hashes SHA-256.
 *
 * @dependencias_internas
 *   - `SuperAdminControlShell` (`@/components/superadmin/SuperAdminControlShell`).
 *   - `useRealtimeInfraTelemetrySse` (`@/components/superadmin/useRealtimeInfraTelemetrySse`).
 *   - `RealtimeInfraTelemetryPanel` (`@/components/superadmin/RealtimeInfraTelemetryPanel`).
 *   - `ImmutableAuditLogExplorer` (`@/components/superadmin/ImmutableAuditLogExplorer`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 */

'use client';

import React, { ReactElement } from 'react';
import { SuperAdminControlShell } from '../../../components/superadmin/SuperAdminControlShell';
import { useRealtimeInfraTelemetrySse } from '../../../components/superadmin/useRealtimeInfraTelemetrySse';
import { RealtimeInfraTelemetryPanel } from '../../../components/superadmin/RealtimeInfraTelemetryPanel';
import { ImmutableAuditLogExplorer } from '../../../components/superadmin/ImmutableAuditLogExplorer';

/**
 * Página de monitoreo de infraestructura, Kill-Switch y auditoría forense SOC2 (Tema Claro).
 */
export default function SuperAdminInfrastructurePage(): ReactElement {
  const {
    metrics,
    isConnected,
    connectionMode,
    error,
    isTogglingKillSwitch,
    toggleVoiceAiKillSwitch,
  } = useRealtimeInfraTelemetrySse();

  return (
    <SuperAdminControlShell currentPath="/superadmin/infrastructure">
      <div className="flex flex-col gap-6">
        {/* Cabecera de Página */}
        <header className="border-b border-[#e6e5e0] pb-5">
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-[#7a7974] mb-1">
            <span>GOBIERNO</span>
            <span>/</span>
            <span className="text-[#26251e] font-semibold">INFRAESTRUCTURA</span>
            <span>/</span>
            <span className="text-[#7a7974]">TELEMETRÍA Y AUDITORÍA</span>
          </div>

          <h1 className="text-[24px] font-medium tracking-tight text-[#26251e] sm:text-[28px]">
            Infraestructura, Kill-Switch y Auditoría SOC2
          </h1>
          <p className="mt-1 text-[13px] text-[#7a7974]">
            Monitoree segundo a segundo las métricas TTFA, supervise incidentes bloqueados por el escudo
            Anti-SSRF y verifique la integridad matemática de los registros inmutables.
          </p>
        </header>

        {/* Notificación de Error */}
        {error && (
          <div
            role="alert"
            className="rounded-[12px] border border-[#cf2d56]/30 bg-[#cf2d56]/5 p-4 text-[13px] text-[#cf2d56]"
          >
            {error}
          </div>
        )}

        {/* Panel de Telemetría en Tiempo Real y Kill-Switch */}
        <RealtimeInfraTelemetryPanel
          metrics={metrics}
          isConnected={isConnected}
          connectionMode={connectionMode}
          isTogglingKillSwitch={isTogglingKillSwitch}
          onToggleKillSwitch={toggleVoiceAiKillSwitch}
        />

        {/* Explorador de Auditoría Criptográfica Inmutable */}
        <ImmutableAuditLogExplorer />
      </div>
    </SuperAdminControlShell>
  );
}
