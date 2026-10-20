/**
 * @archivo apps/web/src/components/superadmin/FixedPlansManagerTab.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Subvista para la gestión de Planes Fijos Mensuales (bolsas cerradas de minutos),
 *   con cálculo reactivo instantáneo del costo unitario por minuto y tope cerrado.
 *
 * @resumen_contenido
 *   - Componente `FixedPlansManagerTab`:
 *       * Selector de planes fijos.
 *       * Edición de precio mensual y minutos incluidos.
 *       * Cálculo reactivo: `precio / minutos = tarifa por minuto`.
 *       * Comparador de ahorro porcentual vs paquete base.
 *       * Botón de eliminación y guardado en caliente.
 *
 * @dependencias_internas
 *   - `GlobalPricingPlan`, `calculateEffectiveUnitRate` de `./useSuperAdminPricingAndOverrides`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 */

import React, { ReactElement } from 'react';
import type { GlobalPricingPlan } from './useSuperAdminPricingAndOverrides';
import { calculateEffectiveUnitRate } from './useSuperAdminPricingAndOverrides';

export interface FixedPlansManagerTabProps {
  readonly fixedPlans: readonly GlobalPricingPlan[];
  readonly selectedPlanCode: string;
  readonly draftPlan: GlobalPricingPlan | null;
  readonly isLoading: boolean;
  readonly onSelectPlanCode: (code: string) => void;
  readonly onOpenCreateModal: () => void;
  readonly onFieldChange: (field: keyof GlobalPricingPlan, value: unknown) => void;
  readonly onSavePlan: () => Promise<void>;
  readonly onDeletePlan: () => Promise<void>;
}

export function FixedPlansManagerTab({
  fixedPlans,
  selectedPlanCode,
  draftPlan,
  isLoading,
  onSelectPlanCode,
  onOpenCreateModal,
  onFieldChange,
  onSavePlan,
  onDeletePlan,
}: FixedPlansManagerTabProps): ReactElement {
  const basePlan = fixedPlans[0];
  const baseUnitRate = basePlan
    ? calculateEffectiveUnitRate(basePlan.monthlyFixedPriceUsd, basePlan.includedMinutes)
    : 0.142857;

  const currentUnitRate = draftPlan
    ? calculateEffectiveUnitRate(draftPlan.monthlyFixedPriceUsd, draftPlan.includedMinutes)
    : 0;

  const savingsPercent = baseUnitRate > 0 && currentUnitRate > 0 && currentUnitRate < baseUnitRate
    ? Math.round(((baseUnitRate - currentUnitRate) / baseUnitRate) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Sub-barra de Planes Fijos + Botón Crear Nuevo */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {fixedPlans.map((p) => {
            const isSelected = p.planCode === selectedPlanCode;
            const unitRate = calculateEffectiveUnitRate(p.monthlyFixedPriceUsd, p.includedMinutes);
            return (
              <button
                key={p.planCode}
                type="button"
                onClick={() => onSelectPlanCode(p.planCode)}
                style={{
                  backgroundColor: isSelected ? 'var(--color-linen, #e6e5e0)' : 'transparent',
                  border: '1px solid',
                  borderColor: isSelected ? 'var(--color-stone, #cdcdc9)' : 'transparent',
                  borderRadius: '4px',
                  padding: '8px 14px',
                  fontSize: '13px',
                  fontWeight: isSelected ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div>{p.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', fontFamily: 'var(--font-berkeleymono, monospace)' }}>
                  ${p.monthlyFixedPriceUsd} USD • ${unitRate.toFixed(4)}/min
                </div>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onOpenCreateModal}
          style={{
            backgroundColor: 'var(--color-forest, #34785c)',
            border: '1px solid var(--color-forest, #34785c)',
            borderRadius: '4px',
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 500,
            color: '#ffffff',
            cursor: 'pointer',
          }}
        >
          + Crear Nuevo Plan Fijo
        </button>
      </div>

      {draftPlan && (
        <section
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '6px',
            padding: '24px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
            <div>
              <h3 style={{ fontSize: '18px', fontWeight: 500, margin: '0 0 4px' }}>
                Editar Paquete Fijo: {draftPlan.displayName}
              </h3>
              <span style={{ fontSize: '11px', fontFamily: 'var(--font-berkeleymono, monospace)', color: 'var(--color-driftwood, #84847e)' }}>
                Código: {draftPlan.planCode} | Whop ID: {draftPlan.whopPlanId}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              {draftPlan.planCode !== 'PLAN_5' && (
                <button
                  type="button"
                  onClick={() => void onDeletePlan()}
                  disabled={isLoading}
                  style={{
                    backgroundColor: 'transparent',
                    border: '1px solid var(--color-crimson, #cf2d56)',
                    borderRadius: '4px',
                    padding: '8px 14px',
                    fontSize: '13px',
                    color: 'var(--color-crimson, #cf2d56)',
                    cursor: 'pointer',
                  }}
                >
                  Eliminar Plan
                </button>
              )}
              <button
                type="button"
                onClick={() => void onSavePlan()}
                disabled={isLoading}
                style={{
                  backgroundColor: 'var(--color-forest, #34785c)',
                  border: '1px solid var(--color-forest, #34785c)',
                  borderRadius: '4px',
                  padding: '8px 18px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#ffffff',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {isLoading ? 'Guardando...' : 'Guardar Cambios en Caliente'}
              </button>
            </div>
          </div>

          {/* Formulario de Parámetros del Plan Fijo */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                Nombre Comercial:
              </label>
              <input
                type="text"
                value={draftPlan.displayName}
                onChange={(e) => onFieldChange('displayName', e.target.value)}
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
                Precio Fijo Mensual ($ USD):
              </label>
              <input
                type="text"
                value={draftPlan.monthlyFixedPriceUsd}
                onChange={(e) => onFieldChange('monthlyFixedPriceUsd', e.target.value)}
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
                Minutos de Voz Incluidos en la Mensualidad:
              </label>
              <input
                type="text"
                value={draftPlan.includedMinutes}
                onChange={(e) => onFieldChange('includedMinutes', e.target.value)}
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
          </div>

          {/* Caja de Cálculo Reactivo de Tarifa Unitaria */}
          <div
            style={{
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <div>
              <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', textTransform: 'uppercase' }}>
                Cálculo Automático de Costo por Minuto:
              </div>
              <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'var(--font-berkeleymono, monospace)', color: 'var(--color-forest, #34785c)', marginTop: '2px' }}>
                ${currentUnitRate.toFixed(4)} USD / minuto
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginTop: '4px' }}>
                Resultado de dividir ${draftPlan.monthlyFixedPriceUsd} USD entre {draftPlan.includedMinutes} minutos.
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              {savingsPercent > 0 ? (
                <span
                  style={{
                    display: 'inline-block',
                    backgroundColor: 'rgba(52, 120, 92, 0.12)',
                    color: 'var(--color-forest, #34785c)',
                    padding: '6px 12px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  🌟 {savingsPercent}% más económico por minuto que el Plan de $5
                </span>
              ) : (
                <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
                  Paquete base de referencia
                </span>
              )}
              <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginTop: '6px' }}>
                🛡️ Tope cerrado: Sin cobro por excedente. Las llamadas se detienen al agotar minutos.
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
