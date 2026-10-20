/**
 * @archivo apps/web/src/components/superadmin/GlobalWhopPricingMatrixEditor.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Consola administrativa integral (CRUD) para gestionar los Planes Fijos Mensuales
 *   (bolsas cerradas de minutos con cálculo automático de costo por minuto) y el plan
 *   de Pago por Uso (PAYG) con tramos dinámicos de descuento por volumen en estética Atelier.
 *
 * @resumen_contenido
 *   - Componente `GlobalWhopPricingMatrixEditor`:
 *       * Pestaña 1: `FixedPlansManagerTab` (CRUD, cálculo `precio / minutos`, tope cerrado sin sorpresas).
 *       * Pestaña 2: `PaygVolumeTiersTab` (tarifa PAYG y tramos escalonados de descuento dinámicos).
 *       * Modal integrado `CreateNewPlanModal`.
 *
 * @dependencias_internas
 *   - `GlobalPricingPlan`, `calculateEffectiveUnitRate` de `./useSuperAdminPricingAndOverrides`.
 *   - `CreateNewPlanModal` de `./CreateNewPlanModal`.
 *   - `FixedPlansManagerTab` de `./FixedPlansManagerTab`.
 *   - `PaygVolumeTiersTab` de `./PaygVolumeTiersTab`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`, `useMemo`).
 */

import React, { ReactElement, useState, useMemo } from 'react';
import type {
  GlobalPricingPlan,
  FinancialSimulationResult,
} from './useSuperAdminPricingAndOverrides';
import { calculateEffectiveUnitRate } from './useSuperAdminPricingAndOverrides';
import { CreateNewPlanModal } from './CreateNewPlanModal';
import { FixedPlansManagerTab } from './FixedPlansManagerTab';
import { PaygVolumeTiersTab } from './PaygVolumeTiersTab';

export interface GlobalWhopPricingMatrixEditorProps {
  readonly plans: readonly GlobalPricingPlan[];
  readonly isLoading: boolean;
  readonly onSavePlan: (planCode: string, updatedPlan: Partial<GlobalPricingPlan>) => Promise<boolean>;
  readonly onCreatePlan: (newPlan: GlobalPricingPlan) => Promise<boolean>;
  readonly onDeletePlan: (planCode: string) => Promise<boolean>;
  readonly onSimulate?: (
    minutes: number,
    baseRate: number,
    discountPct: number,
    customRate?: number,
    monthlyFixedPrice?: number,
    includedMinutes?: number
  ) => FinancialSimulationResult;
}

export function GlobalWhopPricingMatrixEditor({
  plans,
  isLoading,
  onSavePlan,
  onCreatePlan,
  onDeletePlan,
}: GlobalWhopPricingMatrixEditorProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'FIXED_PLANS' | 'PAYG'>('FIXED_PLANS');
  const [selectedPlanCode, setSelectedPlanCode] = useState<string>('PLAN_5');
  const [editingValues, setEditingValues] = useState<Record<string, Partial<GlobalPricingPlan>>>({});
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);

  // Filtramos planes fijos vs PAYG
  const fixedPlans = useMemo(() => plans.filter((p) => p.planCode !== 'PAYG'), [plans]);
  const paygPlan = useMemo(() => plans.find((p) => p.planCode === 'PAYG') ?? plans[0], [plans]);

  // Plan activo bajo edición
  const currentPlan = activeTab === 'FIXED_PLANS'
    ? (fixedPlans.find((p) => p.planCode === selectedPlanCode) ?? fixedPlans[0] ?? plans[0])
    : paygPlan;

  const draftPlan = currentPlan
    ? { ...currentPlan, ...(editingValues[currentPlan.planCode] ?? {}) }
    : null;

  const handleFieldChange = (field: keyof GlobalPricingPlan, value: unknown) => {
    if (!currentPlan) return;
    setEditingValues((prev) => ({
      ...prev,
      [currentPlan.planCode]: {
        ...(prev[currentPlan.planCode] ?? {}),
        [field]: value,
      },
    }));
  };

  const handleSave = async () => {
    if (!currentPlan || !draftPlan) return;
    setSaveStatus('Guardando cambios...');
    const unitRate = calculateEffectiveUnitRate(draftPlan.monthlyFixedPriceUsd, draftPlan.includedMinutes);
    const toSave: Partial<GlobalPricingPlan> = {
      ...draftPlan,
      baseOverageRatePerMinuteUsd: activeTab === 'FIXED_PLANS'
        ? unitRate.toFixed(6)
        : draftPlan.baseOverageRatePerMinuteUsd,
      overageAllowed: false, // Tope cerrado estricto en planes fijos
    };
    const ok = await onSavePlan(currentPlan.planCode, toSave);
    if (ok) {
      setSaveStatus('Plan actualizado y sincronizado en PostgreSQL.');
      setTimeout(() => setSaveStatus(null), 3000);
    } else {
      setSaveStatus('Error al guardar cambios.');
    }
  };

  const handleDelete = async () => {
    if (!currentPlan) return;
    if (currentPlan.planCode === 'PAYG' || currentPlan.planCode === 'PLAN_5') {
      window.alert('Los planes base del sistema no pueden ser eliminados.');
      return;
    }
    const confirmed = window.confirm(
      `¿Está seguro de eliminar el plan "${currentPlan.displayName}" (${currentPlan.planCode})?`
    );
    if (!confirmed) return;

    setSaveStatus('Eliminando plan...');
    const ok = await onDeletePlan(currentPlan.planCode);
    if (ok) {
      setSaveStatus('Plan eliminado correctamente.');
      if (fixedPlans.length > 1) {
        setSelectedPlanCode(fixedPlans[0]?.planCode ?? 'PLAN_5');
      }
      setTimeout(() => setSaveStatus(null), 3000);
    } else {
      setSaveStatus('Error al eliminar plan.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Selector Principal de Modo: Planes Fijos vs Pago por Uso */}
      <div style={{ display: 'flex', gap: '12px', borderBottom: '2px solid var(--color-stone, #cdcdc9)', paddingBottom: '8px' }}>
        <button
          type="button"
          onClick={() => setActiveTab('FIXED_PLANS')}
          style={{
            backgroundColor: activeTab === 'FIXED_PLANS' ? 'var(--color-bone, #f2f1ed)' : 'transparent',
            border: '1px solid',
            borderColor: activeTab === 'FIXED_PLANS' ? 'var(--color-stone, #cdcdc9)' : 'transparent',
            borderRadius: '4px',
            padding: '8px 18px',
            fontSize: '14px',
            fontWeight: activeTab === 'FIXED_PLANS' ? 600 : 400,
            cursor: 'pointer',
            color: 'var(--color-ink, #26251e)',
          }}
        >
          📦 Planes Fijos Mensuales (Bolsas Cerradas de Minutos)
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('PAYG')}
          style={{
            backgroundColor: activeTab === 'PAYG' ? 'var(--color-bone, #f2f1ed)' : 'transparent',
            border: '1px solid',
            borderColor: activeTab === 'PAYG' ? 'var(--color-stone, #cdcdc9)' : 'transparent',
            borderRadius: '4px',
            padding: '8px 18px',
            fontSize: '14px',
            fontWeight: activeTab === 'PAYG' ? 600 : 400,
            cursor: 'pointer',
            color: 'var(--color-ink, #26251e)',
          }}
        >
          ⚡ Pago por Uso (PAYG) y Descuentos por Volumen
        </button>
      </div>

      {saveStatus && (
        <div
          style={{
            fontSize: '12px',
            padding: '10px 14px',
            borderRadius: '4px',
            backgroundColor: saveStatus.includes('Error') ? 'rgba(207, 45, 86, 0.1)' : 'rgba(52, 120, 92, 0.1)',
            color: saveStatus.includes('Error') ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)',
          }}
        >
          {saveStatus}
        </div>
      )}

      {/* VISTA 1: PLANES FIJOS MENSUALES */}
      {activeTab === 'FIXED_PLANS' && (
        <FixedPlansManagerTab
          fixedPlans={fixedPlans}
          selectedPlanCode={selectedPlanCode}
          draftPlan={draftPlan}
          isLoading={isLoading}
          onSelectPlanCode={setSelectedPlanCode}
          onOpenCreateModal={() => setIsCreateModalOpen(true)}
          onFieldChange={handleFieldChange}
          onSavePlan={handleSave}
          onDeletePlan={handleDelete}
        />
      )}

      {/* VISTA 2: PAGO POR USO (PAYG) Y TRAMOS DE DESCUENTO */}
      {activeTab === 'PAYG' && (
        <PaygVolumeTiersTab
          draftPlan={draftPlan}
          isLoading={isLoading}
          onFieldChange={handleFieldChange}
          onSavePlan={handleSave}
        />
      )}

      {/* Modal para Crear Nuevo Plan Fijo */}
      <CreateNewPlanModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreatePlan={onCreatePlan}
      />
    </div>
  );
}
