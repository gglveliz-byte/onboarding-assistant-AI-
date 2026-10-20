/**
 * @archivo apps/web/src/components/superadmin/PaygVolumeTiersTab.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Subvista para la gestión de Pago por Uso (PAYG / Consumo Elástico) y
 *   editor interactivo de tramos escalonados de descuento por volumen.
 *
 * @resumen_contenido
 *   - Componente `PaygVolumeTiersTab`:
 *       * Configuración de la tarifa base por minuto ($/min).
 *       * Gestor dinámico de tramos de descuento (agregar, eliminar, cálculo en vivo).
 *       * Botón de guardado transaccional.
 *
 * @dependencias_internas
 *   - `GlobalPricingPlan`, `VolumeDiscountTierDefinition` de `./useSuperAdminPricingAndOverrides`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 */

import React, { ReactElement, useState } from 'react';
import type {
  GlobalPricingPlan,
  VolumeDiscountTierDefinition,
} from './useSuperAdminPricingAndOverrides';

export interface PaygVolumeTiersTabProps {
  readonly draftPlan: GlobalPricingPlan | null;
  readonly isLoading: boolean;
  readonly onFieldChange: (field: keyof GlobalPricingPlan, value: unknown) => void;
  readonly onSavePlan: () => Promise<void>;
}

export function PaygVolumeTiersTab({
  draftPlan,
  isLoading,
  onFieldChange,
  onSavePlan,
}: PaygVolumeTiersTabProps): ReactElement {
  const [newTierFrom, setNewTierFrom] = useState<number>(500);
  const [newTierTo, setNewTierTo] = useState<number>(999);
  const [newTierDiscount, setNewTierDiscount] = useState<number>(10);

  if (!draftPlan) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-driftwood, #84847e)' }}>
        No se encontró la configuración del plan de Pago por Uso (PAYG).
      </div>
    );
  }

  const handleAddVolumeTier = () => {
    const currentTiers = draftPlan.volumeDiscountTiers ?? [];
    const baseRate = parseFloat(draftPlan.baseOverageRatePerMinuteUsd || '0.15');
    const discountedRate = (baseRate * (1 - newTierDiscount / 100)).toFixed(6);

    const updatedTiers: VolumeDiscountTierDefinition[] = [
      ...currentTiers,
      {
        fromMinute: newTierFrom,
        toMinute: newTierTo > 0 ? newTierTo : null,
        discountPercentage: newTierDiscount,
        discountedRatePerMinuteUsd: discountedRate,
      },
    ].sort((a, b) => a.fromMinute - b.fromMinute);

    onFieldChange('volumeDiscountTiers', updatedTiers);
  };

  const handleRemoveVolumeTier = (index: number) => {
    const currentTiers = draftPlan.volumeDiscountTiers ?? [];
    const updated = currentTiers.filter((_, idx) => idx !== index);
    onFieldChange('volumeDiscountTiers', updated);
  };

  return (
    <section
      style={{
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: '6px',
        padding: '24px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h3 style={{ fontSize: '18px', fontWeight: 500, margin: '0 0 4px' }}>
            Configuración de Pago por Uso (PAYG) y Tramos de Descuento
          </h3>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Defina la tarifa base por minuto para consumo elástico y los tramos de descuento por volumen aplicables.
          </p>
        </div>

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
          {isLoading ? 'Guardando...' : 'Guardar Configuración PAYG'}
        </button>
      </div>

      <div style={{ maxWidth: '300px', marginBottom: '24px' }}>
        <label style={{ display: 'block', fontSize: '12px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
          Tarifa Base por Minuto ($ USD / min):
        </label>
        <input
          type="text"
          value={draftPlan.baseOverageRatePerMinuteUsd}
          onChange={(e) => onFieldChange('baseOverageRatePerMinuteUsd', e.target.value)}
          style={{
            width: '100%',
            padding: '8px',
            borderRadius: '4px',
            border: '1px solid var(--color-stone, #cdcdc9)',
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            fontSize: '14px',
            fontFamily: 'var(--font-berkeleymono, monospace)',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Gestor Dinámico de Tramos de Descuento */}
      <div style={{ borderTop: '1px solid var(--color-stone, #cdcdc9)', paddingTop: '20px' }}>
        <h4 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 12px' }}>
          Tramos Escalonados de Descuento por Volumen:
        </h4>

        {draftPlan.volumeDiscountTiers.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--color-driftwood, #84847e)', padding: '12px 0' }}>
            No hay tramos configurados. Todo el consumo se cobra a la tarifa base.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {draftPlan.volumeDiscountTiers.map((tier, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  padding: '10px 16px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  fontSize: '12px',
                }}
              >
                <span>
                  Desde <strong>{tier.fromMinute}</strong> {tier.toMinute ? `hasta ${tier.toMinute} minutos` : 'minutos en adelante'}
                </span>
                <span style={{ fontWeight: 600, color: 'var(--color-forest, #34785c)' }}>
                  {tier.discountPercentage}% de Descuento
                </span>
                <span style={{ color: 'var(--color-driftwood, #84847e)' }}>
                  Tarifa: ${tier.discountedRatePerMinuteUsd ?? (parseFloat(draftPlan.baseOverageRatePerMinuteUsd || '0.15') * (1 - tier.discountPercentage / 100)).toFixed(4)}/min
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveVolumeTier(idx)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-crimson, #cf2d56)',
                    color: 'var(--color-crimson, #cf2d56)',
                    padding: '3px 8px',
                    borderRadius: '3px',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  Eliminar
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Formulario para agregar nuevo tramo */}
        <div
          style={{
            backgroundColor: 'var(--color-linen, #e6e5e0)',
            padding: '14px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'flex-end',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Desde Minuto:</label>
            <input
              type="number"
              min="1"
              value={newTierFrom}
              onChange={(e) => setNewTierFrom(Number(e.target.value))}
              style={{ width: '100px', padding: '6px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', fontSize: '12px' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Hasta Minuto (0 = infinito):</label>
            <input
              type="number"
              min="0"
              value={newTierTo}
              onChange={(e) => setNewTierTo(Number(e.target.value))}
              style={{ width: '100px', padding: '6px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', fontSize: '12px' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>% Descuento:</label>
            <input
              type="number"
              min="1"
              max="90"
              value={newTierDiscount}
              onChange={(e) => setNewTierDiscount(Number(e.target.value))}
              style={{ width: '90px', padding: '6px', borderRadius: '4px', border: '1px solid var(--color-stone, #cdcdc9)', fontSize: '12px' }}
            />
          </div>

          <button
            type="button"
            onClick={handleAddVolumeTier}
            style={{
              backgroundColor: 'var(--color-forest, #34785c)',
              color: '#ffffff',
              border: 'none',
              padding: '7px 14px',
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            + Añadir Tramo
          </button>
        </div>
      </div>
    </section>
  );
}
