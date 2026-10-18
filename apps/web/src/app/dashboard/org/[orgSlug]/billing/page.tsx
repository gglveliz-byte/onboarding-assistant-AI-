/**
 * @archivo apps/web/src/app/dashboard/org/[orgSlug]/billing/page.tsx
 * @modulo apps/web (Rutas del Dashboard del Desarrollador - Tema Claro Cursor Atelier)
 * @proposito
 *   Vista principal de facturación, suscripciones y consumo minuto a minuto de la organización
 *   bajo la estética de Tema Claro (fondos blanco y pergamino #f7f7f4, tinta mineral #26251e,
 *   bordes capilares #cdcdc9, acentos esmeralda #15846e y lavanda #8052ff).
 *
 * @resumen_contenido
 *   - Componente de página `OrganizationBillingPage`:
 *       * Cabecera de marca con `<Logo size={28} variant="compact" textTheme="dark" />` y migas de pan.
 *       * Barra de pestañas táctil: Resumen, Planes & Spend Cap, y Libro Mayor.
 *       * Integración con `useOrganizationBillingWhop`.
 *       * Renderizado responsivo de `CurrentPlanAndBalanceCard`, `WhopCheckoutAndSpendCapControls` y `MinuteByMinuteUsageLedgerTable`.
 *
 * @dependencias_internas
 *   - `useOrganizationBillingWhop` (`@/components/billing-whop/useOrganizationBillingWhop`).
 *   - `CurrentPlanAndBalanceCard` (`@/components/billing-whop/CurrentPlanAndBalanceCard`).
 *   - `WhopCheckoutAndSpendCapControls` (`@/components/billing-whop/WhopCheckoutAndSpendCapControls`).
 *   - `MinuteByMinuteUsageLedgerTable` (`@/components/billing-whop/MinuteByMinuteUsageLedgerTable`).
 *   - `Logo` (`@/components/common/Logo`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 */

'use client';

import React, { ReactElement, useState } from 'react';
import { useOrganizationBillingWhop } from '../../../../../components/billing-whop/useOrganizationBillingWhop';
import { CurrentPlanAndBalanceCard } from '../../../../../components/billing-whop/CurrentPlanAndBalanceCard';
import { WhopCheckoutAndSpendCapControls } from '../../../../../components/billing-whop/WhopCheckoutAndSpendCapControls';
import { MinuteByMinuteUsageLedgerTable } from '../../../../../components/billing-whop/MinuteByMinuteUsageLedgerTable';
import { Logo } from '../../../../../components/common/Logo';

interface PageProps {
  readonly params: {
    readonly orgSlug: string;
  };
}

/**
 * Página principal de facturación y consumo Whop para la organización (Tema Claro).
 */
export default function OrganizationBillingPage({ params }: PageProps): ReactElement {
  const { orgSlug } = params;
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'PLANS_AND_CAPS' | 'LEDGER'>('OVERVIEW');

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

  return (
    <div className="min-h-screen bg-[#f7f7f4] text-[#26251e] px-4 sm:px-6 py-6 md:py-8 font-sans selection:bg-[#8BC4F8] selection:text-[#26251e]">
      <div className="mx-auto max-w-7xl flex flex-col gap-6">
        {/* Cabecera Principal con Identidad Tema Claro */}
        <header className="border-b border-[#cdcdc9] pb-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Logo size={28} variant="compact" textTheme="dark" />
              <div className="h-4 w-px bg-[#cdcdc9]" />
              <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#7a7974]">
                <span>ORG</span>
                <span>/</span>
                <span className="text-[#8052ff] font-semibold">{orgSlug}</span>
                <span>/</span>
                <span className="text-[#26251e] font-medium">FACTURACIÓN</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#cdcdc9] bg-[#ffffff] px-3 py-1 text-[11px] font-mono text-[#7a7974] shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-[#15846e]" />
                Billing Engine v1.0
              </span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h1 className="text-[24px] font-normal tracking-tight text-[#26251e] sm:text-[28px]">
                Gestión de Suscripción, Saldo y Consumo
              </h1>
              <p className="mt-1 text-[13px] text-[#7a7974]">
                Controle su plan de voz, límite de gasto mensual y audite el consumo minuto a minuto.
              </p>
            </div>
          </div>

          {/* Selector de Pestañas con Diseño Píldora Tema Claro */}
          <nav aria-label="Secciones de facturación" className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              id="tab_billing_overview"
              onClick={() => setActiveTab('OVERVIEW')}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold tracking-wider uppercase transition-all ${
                activeTab === 'OVERVIEW'
                  ? 'border border-[#26251e] bg-[#26251e] text-white shadow-sm'
                  : 'border border-[#cdcdc9] bg-[#ffffff] text-[#7a7974] hover:border-[#26251e] hover:text-[#26251e]'
              }`}
            >
              Resumen y Estado
            </button>

            <button
              type="button"
              id="tab_billing_plans"
              onClick={() => setActiveTab('PLANS_AND_CAPS')}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold tracking-wider uppercase transition-all ${
                activeTab === 'PLANS_AND_CAPS'
                  ? 'border border-[#26251e] bg-[#26251e] text-white shadow-sm'
                  : 'border border-[#cdcdc9] bg-[#ffffff] text-[#7a7974] hover:border-[#26251e] hover:text-[#26251e]'
              }`}
            >
              Planes y Spend Cap
            </button>

            <button
              type="button"
              id="tab_billing_ledger"
              onClick={() => {
                setActiveTab('LEDGER');
                fetchLedger();
              }}
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold tracking-wider uppercase transition-all ${
                activeTab === 'LEDGER'
                  ? 'border border-[#26251e] bg-[#26251e] text-white shadow-sm'
                  : 'border border-[#cdcdc9] bg-[#ffffff] text-[#7a7974] hover:border-[#26251e] hover:text-[#26251e]'
              }`}
            >
              Libro Mayor Auditable
            </button>
          </nav>
        </header>

        {/* Mensaje de Error Global si la API falla */}
        {error && (
          <div
            role="alert"
            className="rounded-[6px] border border-[#cf2d56]/40 bg-[#cf2d56]/10 p-4 text-[13px] text-[#cf2d56]"
          >
            <strong>Error de Facturación:</strong> {error}
          </div>
        )}

        {/* Contenido Dinámico de la Pestaña Activa */}
        <main className="flex flex-col gap-6">
          {activeTab === 'OVERVIEW' && (
            <div className="flex flex-col gap-6">
              <CurrentPlanAndBalanceCard
                consumption={consumption}
                isLoading={isLoading}
                onRefresh={refreshConsumption}
                onOpenManagePlan={() => setActiveTab('PLANS_AND_CAPS')}
              />

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="rounded-[6px] border border-[#cdcdc9] bg-[#ffffff] p-5 shadow-sm">
                  <h3 className="text-[15px] font-medium text-[#26251e] mb-2">Resumen Rápido de Cuota</h3>
                  <p className="text-[12px] text-[#7a7974] leading-relaxed">
                    Los minutos base incluidos se renuevan en cada ciclo de facturación mensual.
                    Al agotarse la cuota base, el sistema continúa operando sin interrupción aplicando la tarifa
                    de sobreconsumo (overage) correspondiente a su plan.
                  </p>
                </div>

                <div className="rounded-[6px] border border-[#cdcdc9] bg-[#ffffff] p-5 shadow-sm">
                  <h3 className="text-[15px] font-medium text-[#26251e] mb-2">Garantía de Protección</h3>
                  <p className="text-[12px] text-[#7a7974] leading-relaxed">
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
        </main>
      </div>
    </div>
  );
}
