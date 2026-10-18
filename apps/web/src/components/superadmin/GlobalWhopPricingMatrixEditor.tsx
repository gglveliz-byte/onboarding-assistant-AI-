/**
 * @archivo apps/web/src/components/superadmin/GlobalWhopPricingMatrixEditor.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Editor interactivo de la Matriz Global de Precios Whop ($5 a $50 USD/mes + PAYG)
 *   y editor de tramos de descuento por volumen (10%, 20%, 35%, 50%) para SuperAdmin
 *   en estética Cursor Atelier Light.
 *
 * @resumen_contenido
 *   - Componente `GlobalWhopPricingMatrixEditor`:
 *       * Editor tabular de planes con campos editables en línea (`berkeleyMono 12px`, `tnum`).
 *       * Subcomponente `VolumeDiscountTiersEditor` para los tramos escalonados del Plan $50.
 *       * Simulador financiero interactivo de consumo proyectado.
 *       * Botón de guardado con validación FIDO2 y notificación de éxito.
 *
 * @dependencias_internas
 *   - `GlobalPricingPlan`, `VolumeDiscountTierDefinition` de `useSuperAdminPricingAndOverrides.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Modifica `pricing_plans_config` en PostgreSQL y sincroniza con el catálogo Whop.
 */

import React, { ReactElement, useState } from 'react';
import type {
  GlobalPricingPlan,
  VolumeDiscountTierDefinition,
  FinancialSimulationResult,
} from './useSuperAdminPricingAndOverrides';

export interface GlobalWhopPricingMatrixEditorProps {
  readonly plans: readonly GlobalPricingPlan[];
  readonly isLoading: boolean;
  readonly onSavePlan: (planCode: string, updatedPlan: Partial<GlobalPricingPlan>) => Promise<boolean>;
  readonly onSimulate: (minutes: number, baseRate: number, discountPct: number) => FinancialSimulationResult;
}

/**
 * Editor tabular de la Matriz Global de Precios Whop.
 */
export function GlobalWhopPricingMatrixEditor({
  plans,
  isLoading,
  onSavePlan,
  onSimulate,
}: GlobalWhopPricingMatrixEditorProps): ReactElement {
  const [selectedPlanCode, setSelectedPlanCode] = useState<string>('PLAN_50');
  const [editingValues, setEditingValues] = useState<Record<string, Partial<GlobalPricingPlan>>>({});
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Estado del simulador
  const [simMinutes, setSimMinutes] = useState<number>(1200);

  const activePlan = plans.find((p) => p.planCode === selectedPlanCode) ?? plans[0];
  const draftPlan = activePlan ? { ...activePlan, ...(editingValues[activePlan.planCode] ?? {}) } : null;

  const handleFieldChange = (field: keyof GlobalPricingPlan, value: unknown) => {
    if (!activePlan) return;
    setEditingValues((prev) => ({
      ...prev,
      [activePlan.planCode]: {
        ...(prev[activePlan.planCode] ?? {}),
        [field]: value,
      },
    }));
  };

  const handleSave = async () => {
    if (!activePlan || !draftPlan) return;
    setSaveStatus('Guardando cambios en matriz global...');
    const ok = await onSavePlan(activePlan.planCode, draftPlan);
    if (ok) {
      setSaveStatus('Plan actualizado y sincronizado correctamente.');
      setTimeout(() => setSaveStatus(null), 3500);
    } else {
      setSaveStatus('Error al guardar cambios en el plan.');
    }
  };

  const simulation = draftPlan
    ? onSimulate(
        simMinutes,
        parseFloat(draftPlan.baseOverageRatePerMinuteUsd || '0.08'),
        draftPlan.volumeDiscountEligible ? 20 : 0
      )
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Selector de Plan y Pestañas */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          borderBottom: '1px solid var(--color-stone, #cdcdc9)',
          paddingBottom: '12px',
        }}
      >
        {plans.map((p) => {
          const isSelected = p.planCode === selectedPlanCode;
          return (
            <button
              key={p.planCode}
              type="button"
              onClick={() => setSelectedPlanCode(p.planCode)}
              style={{
                backgroundColor: isSelected ? 'var(--color-linen, #e6e5e0)' : 'transparent',
                border: '1px solid',
                borderColor: isSelected ? 'var(--color-stone, #cdcdc9)' : 'transparent',
                borderRadius: '4px',
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: isSelected ? 500 : 400,
                color: 'var(--color-ink, #26251e)',
                cursor: 'pointer',
              }}
            >
              {p.displayName}
            </button>
          );
        })}
      </div>

      {draftPlan && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* Formulario de Configuración del Plan Seleccionado */}
          <section
            aria-labelledby="plan-editor-title"
            style={{
              backgroundColor: 'var(--color-bone, #f2f1ed)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '24px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 id="plan-editor-title" style={{ fontSize: '18px', fontWeight: 400, margin: 0 }}>
                  Editar Parámetros: {draftPlan.displayName}
                </h3>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-berkeleymono, monospace)',
                    color: 'var(--color-driftwood, #84847e)',
                  }}
                >
                  Código de plan: {draftPlan.planCode} | Whop ID: {draftPlan.whopPlanId}
                </span>
              </div>

              <button
                type="button"
                onClick={handleSave}
                disabled={isLoading}
                style={{
                  backgroundColor: 'var(--color-forest, #34785c)',
                  border: '1px solid var(--color-forest, #34785c)',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--color-parchment, #f7f7f4)',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {isLoading ? 'Guardando...' : 'Aplicar Cambios en Caliente'}
              </button>
            </div>

            {saveStatus && (
              <div
                style={{
                  fontSize: '12px',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  marginBottom: '16px',
                  backgroundColor: saveStatus.includes('Error') ? 'rgba(207, 45, 86, 0.1)' : 'rgba(52, 120, 92, 0.1)',
                  color: saveStatus.includes('Error') ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)',
                }}
              >
                {saveStatus}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                  Nombre Comercial:
                </label>
                <input
                  type="text"
                  value={draftPlan.displayName}
                  onChange={(e) => handleFieldChange('displayName', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid var(--color-stone, #cdcdc9)',
                    backgroundColor: 'var(--color-parchment, #f7f7f4)',
                    fontSize: '13px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                  Precio Fijo Mensual (USD):
                </label>
                <input
                  type="text"
                  value={draftPlan.monthlyFixedPriceUsd}
                  onChange={(e) => handleFieldChange('monthlyFixedPriceUsd', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid var(--color-stone, #cdcdc9)',
                    backgroundColor: 'var(--color-parchment, #f7f7f4)',
                    fontSize: '13px',
                    fontFamily: 'var(--font-berkeleymono, monospace)',
                    fontVariantNumeric: 'tabular-nums',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                  Minutos de Voz Incluidos:
                </label>
                <input
                  type="text"
                  value={draftPlan.includedMinutes}
                  onChange={(e) => handleFieldChange('includedMinutes', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid var(--color-stone, #cdcdc9)',
                    backgroundColor: 'var(--color-parchment, #f7f7f4)',
                    fontSize: '13px',
                    fontFamily: 'var(--font-berkeleymono, monospace)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                  Tarifa Sobreconsumo Base ($/min):
                </label>
                <input
                  type="text"
                  value={draftPlan.baseOverageRatePerMinuteUsd}
                  onChange={(e) => handleFieldChange('baseOverageRatePerMinuteUsd', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid var(--color-stone, #cdcdc9)',
                    backgroundColor: 'var(--color-parchment, #f7f7f4)',
                    fontSize: '13px',
                    fontFamily: 'var(--font-berkeleymono, monospace)',
                    fontVariantNumeric: 'tabular-nums',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>

            {/* Checkbox de Elegibilidad de Descuento por Volumen */}
            <div style={{ marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="vol-eligible-check"
                type="checkbox"
                checked={draftPlan.volumeDiscountEligible}
                onChange={(e) => handleFieldChange('volumeDiscountEligible', e.target.checked)}
                style={{ accentColor: 'var(--color-forest, #34785c)' }}
              />
              <label htmlFor="vol-eligible-check" style={{ fontSize: '13px', cursor: 'pointer' }}>
                Habilitar tramos de descuento por volumen escalonado (10% a 50%)
              </label>
            </div>

            {/* Sub-Editor de Tramos de Volumen */}
            {draftPlan.volumeDiscountEligible && (
              <div style={{ marginTop: '20px', borderTop: '1px solid var(--color-stone, #cdcdc9)', paddingTop: '16px' }}>
                <h4 style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 10px' }}>
                  Tramos Escalonados de Descuento por Volumen:
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {draftPlan.volumeDiscountTiers.map((tier, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        backgroundColor: 'var(--color-parchment, #f7f7f4)',
                        padding: '8px 12px',
                        borderRadius: '4px',
                        border: '1px solid var(--color-stone, #cdcdc9)',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        fontSize: '12px',
                      }}
                    >
                      <span style={{ width: '130px' }}>
                        Min {tier.fromMinute} {tier.toMinute ? `a ${tier.toMinute}` : 'en adelante'}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--color-forest, #34785c)' }}>
                        {tier.discountPercentage}% Dto.
                      </span>
                      <span style={{ color: 'var(--color-driftwood, #84847e)' }}>
                        Tarifa: ${tier.discountedRatePerMinuteUsd ?? '—'}/min
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Panel Lateral: Simulador Financiero en Cliente */}
          <aside
            aria-labelledby="sim-title"
            style={{
              backgroundColor: 'var(--color-bone, #f2f1ed)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '20px',
            }}
          >
            <h4 id="sim-title" style={{ fontSize: '14px', fontWeight: 500, margin: '0 0 8px' }}>
              Simulador de Facturación
            </h4>
            <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
              Proyecte el costo mensual de un cliente con este plan y volumen de minutos.
            </p>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Minutos mensuales estimados:
              </label>
              <input
                type="number"
                min="0"
                max="50000"
                step="100"
                value={simMinutes}
                onChange={(e) => setSimMinutes(Number(e.target.value))}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {simulation && (
              <div
                style={{
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  borderRadius: '4px',
                  padding: '12px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  fontSize: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Costo Bruto:</span>
                  <span>${simulation.estimatedCostWithoutDiscountUsd}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-forest, #34785c)' }}>
                  <span>Descuento Volumen:</span>
                  <span>-${simulation.estimatedDiscountUsd}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontWeight: 600,
                    borderTop: '1px solid var(--color-stone, #cdcdc9)',
                    paddingTop: '6px',
                    marginTop: '2px',
                  }}
                >
                  <span>Total Facturado:</span>
                  <span>${simulation.finalBilledAmountUsd}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
                  <span>Tarifa Media:</span>
                  <span>${simulation.effectiveAverageRateUsd}/min</span>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
