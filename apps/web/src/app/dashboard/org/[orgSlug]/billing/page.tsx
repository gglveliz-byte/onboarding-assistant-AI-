/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/billing/page.tsx
 * @modulo 08-frontend-dashboard-dev (Página de Facturación y Consumo dentro del Shell Atelier)
 * @proposito
 *   Vista de facturación, suscripción y consumo minuto a minuto de la organización, integrada
 *   en el shell `DeveloperDashboardShell` del Dashboard del Desarrollador (Tema Claro Cursor
 *   Atelier: pergamino #f7f7f4, hueso #f2f1ed, lino #e6e5e0, tinta #26251e, bordes capilares
 *   #cdcdc9, acentos Forest #34785c y Ember #f54e00; radios estrictos de 4px).
 *
 * @resumen_contenido
 *   - Componente `OrganizationBillingPage`:
 *       * Encabezado editorial con título, subtítulo y distintivo técnico del motor de facturación.
 *       * Pestañas segmentadas de Atelier (Resumen, Planes y Spend Cap, Libro Mayor).
 *       * Alerta de error con acción de reintento y estado de carga esquelético honesto.
 *       * Integración con `useOrganizationBillingWhop` (consumo, libro mayor, checkout, spend cap).
 *       * Renderizado responsivo de `CurrentPlanAndBalanceCard`, `WhopCheckoutAndSpendCapControls`
 *         y `MinuteByMinuteUsageLedgerTable`.
 *
 * @dependencias_internas
 *   - `DeveloperDashboardShell` (apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx).
 *   - `useOrganizationBillingWhop` (`@/components/billing-whop/useOrganizationBillingWhop`).
 *   - `CurrentPlanAndBalanceCard` (`@/components/billing-whop/CurrentPlanAndBalanceCard`).
 *   - `WhopCheckoutAndSpendCapControls` (`@/components/billing-whop/WhopCheckoutAndSpendCapControls`).
 *   - `MinuteByMinuteUsageLedgerTable` (`@/components/billing-whop/MinuteByMinuteUsageLedgerTable`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST `/api/v1/billing/*`): `whop_subscriptions`, `usage_ledger`.
 */

'use client';

import React, { ReactElement, use, useState } from 'react';
import { useOrganizationBillingWhop } from '../../../../../components/billing-whop/useOrganizationBillingWhop';
import { CurrentPlanAndBalanceCard } from '../../../../../components/billing-whop/CurrentPlanAndBalanceCard';
import { WhopCheckoutAndSpendCapControls } from '../../../../../components/billing-whop/WhopCheckoutAndSpendCapControls';
import { MinuteByMinuteUsageLedgerTable } from '../../../../../components/billing-whop/MinuteByMinuteUsageLedgerTable';
import { DeveloperDashboardShell } from '../../../../../components/dashboard-dev/DeveloperDashboardShell';

interface PageProps {
  readonly params: Promise<{
    readonly orgSlug: string;
  }>;
}

type BillingTabValue = 'OVERVIEW' | 'PLANS_AND_CAPS' | 'LEDGER';

interface BillingTabDefinition {
  readonly id: string;
  readonly label: string;
  readonly value: BillingTabValue;
}

const BILLING_TABS: readonly BillingTabDefinition[] = [
  { id: 'tab_billing_overview', label: 'Resumen y Estado', value: 'OVERVIEW' },
  { id: 'tab_billing_plans', label: 'Planes y Spend Cap', value: 'PLANS_AND_CAPS' },
  { id: 'tab_billing_ledger', label: 'Libro Mayor Auditable', value: 'LEDGER' },
];

/**
 * Página de facturación y consumo Whop para la organización (Tema Claro Cursor Atelier).
 */
export default function OrganizationBillingPage({ params }: PageProps): ReactElement {
  // Next.js 15 entrega `params` como Promesa: se desenvuelve con `use()` para evitar el error de acceso directo.
  const { orgSlug } = use(params);
  const [activeTab, setActiveTab] = useState<BillingTabValue>('OVERVIEW');

  // En producción, orgId se resuelve desde el contexto de sesión o parámetro de ruta
  const organizationId = orgSlug;

  const {
    consumption,
    ledgerItems,
    isLoading,
    isExportingCsv,
    error,
    dpaRequired,
    refreshConsumption,
    fetchLedger,
    exportLedgerCsv,
    startCheckout,
    openCustomerPortal,
    updateSpendCap,
  } = useOrganizationBillingWhop(organizationId);

  const showSkeleton = isLoading && consumption === null;

  return (
    <DeveloperDashboardShell
      orgSlug={orgSlug}
      userRole="OWNER"
      {...(consumption
        ? {
            remainingMinutes: consumption.includedMinutesRemaining,
            totalPurchasedMinutes: consumption.includedMinutesTotal,
          }
        : {})}
    >
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Encabezado Editorial */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[26px] font-sans font-normal tracking-[-0.012em] text-[#26251e]">
              Facturación, Suscripción y Consumo
            </h1>
            <p className="text-sm font-sans text-[#84847e] mt-1">
              Controle su plan de voz, el límite de gasto mensual y audite el consumo minuto a minuto.
            </p>
          </div>

          <span
            className="inline-flex items-center gap-1.5 self-start px-2.5 py-1 text-[11px] font-mono text-[#7a7974] bg-[#f2f1ed] border border-[#cdcdc9] rounded whitespace-nowrap"
            style={{ borderRadius: '4px' }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#34785c]" />
            Billing Engine v1.0
          </span>
        </div>

        {/* Pestañas Segmentadas de Atelier */}
        <nav
          aria-label="Secciones de facturación"
          className="inline-flex flex-wrap p-1 bg-[#e6e5e0] border border-[#cdcdc9] rounded max-w-full"
          style={{ borderRadius: '4px' }}
        >
          {BILLING_TABS.map((tab) => {
            const isActive = activeTab === tab.value;
            return (
              <button
                key={tab.id}
                type="button"
                id={tab.id}
                onClick={() => {
                  setActiveTab(tab.value);
                  if (tab.value === 'LEDGER') {
                    void fetchLedger();
                  }
                }}
                className={`px-3 py-1.5 text-[11px] font-sans uppercase tracking-wider transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-[#f7f7f4] text-[#26251e] border-t-2 border-[#26251e]'
                    : 'text-[#84847e] hover:text-[#26251e]'
                }`}
                style={{ borderRadius: '3px' }}
                aria-current={isActive ? 'page' : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Alerta de Error del Motor de Facturación */}
        {error && (
          <div
            role="alert"
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3.5 bg-[#cf2d56]/10 border border-[#cf2d56]/40 rounded"
            style={{ borderRadius: '4px' }}
          >
            <div className="min-w-0">
              <p className="text-xs font-sans text-[#cf2d56]">Error de Facturación</p>
              <p className="text-xs font-mono text-[#84847e] mt-0.5 break-words">{error}</p>
              <p className="text-[11px] font-sans text-[#84847e] mt-1">
                El consumo y el libro mayor requieren una sesión autenticada en el dashboard.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void refreshConsumption();
                void fetchLedger();
              }}
              className="self-start sm:self-auto px-3 py-1.5 text-xs font-sans text-[#26251e] bg-[#e6e5e0] border border-[#cdcdc9] rounded transition-colors hover:border-[#26251e] whitespace-nowrap"
              style={{ borderRadius: '4px' }}
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Contenido Dinámico de la Pestaña Activa */}
        <section className="flex flex-col gap-6">
          {activeTab === 'OVERVIEW' && (
            <div className="flex flex-col gap-6">
              {showSkeleton ? (
                <div
                  className="p-5 bg-[#f2f1ed] border border-[#cdcdc9] rounded"
                  style={{ borderRadius: '4px' }}
                  data-testid="billing-loading-skeleton"
                >
                  <p className="text-xs font-mono text-[#84847e]">Sincronizando consumo con el motor de facturación…</p>
                </div>
              ) : (
                <CurrentPlanAndBalanceCard
                  consumption={consumption}
                  isLoading={isLoading}
                  onRefresh={refreshConsumption}
                  onOpenManagePlan={() => setActiveTab('PLANS_AND_CAPS')}
                />
              )}

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div
                  className="p-5 bg-[#f2f1ed] border border-[#cdcdc9] rounded"
                  style={{ borderRadius: '4px' }}
                >
                  <h3 className="text-[15px] font-sans font-normal text-[#26251e] mb-1.5">Resumen Rápido de Cuota</h3>
                  <p className="text-[12px] font-sans text-[#84847e] leading-relaxed">
                    Los minutos base incluidos se renuevan en cada ciclo de facturación mensual.
                    Al agotarse la cuota base, el sistema continúa operando sin interrupción aplicando la tarifa
                    de sobreconsumo (overage) correspondiente a su plan.
                  </p>
                </div>

                <div
                  className="p-5 bg-[#f2f1ed] border border-[#cdcdc9] rounded"
                  style={{ borderRadius: '4px' }}
                >
                  <h3 className="text-[15px] font-sans font-normal text-[#26251e] mb-1.5">Garantía de Protección</h3>
                  <p className="text-[12px] font-sans text-[#84847e] leading-relaxed">
                    Su organización cuenta con la protección activa de gasto máximo (Spend Cap).
                    Si el consumo alcanza el límite configurado, se bloquea la apertura de nuevas llamadas
                    conversacionales para evitar sorpresas en su estado contable.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'PLANS_AND_CAPS' && (
            <WhopCheckoutAndSpendCapControls
              currentPlanCode={consumption?.planCode ?? 'PAYG'}
              consumption={consumption}
              isLoading={isLoading}
              dpaRequired={dpaRequired}
              onSelectPlan={startCheckout}
              onOpenCustomerPortal={openCustomerPortal}
              onSaveSpendCap={updateSpendCap}
            />
          )}

          {activeTab === 'LEDGER' && (
            <MinuteByMinuteUsageLedgerTable
              items={ledgerItems}
              isLoading={isLoading}
              isExportingCsv={isExportingCsv}
              onExportCsv={exportLedgerCsv}
              onRefresh={fetchLedger}
            />
          )}
        </section>
      </div>
    </DeveloperDashboardShell>
  );
}
