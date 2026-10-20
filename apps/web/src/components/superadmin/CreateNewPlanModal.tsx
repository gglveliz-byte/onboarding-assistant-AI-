/**
 * @archivo apps/web/src/components/superadmin/CreateNewPlanModal.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Modal para la creación de nuevos planes de precios globales en Whop
 *   con cálculo reactivo instantáneo del costo unitario por minuto ($/min).
 *
 * @resumen_contenido
 *   - Componente `CreateNewPlanModal`:
 *       * Campos: Código de Plan, Whop ID, Nombre Comercial, Precio Mensual USD, Minutos Incluidos.
 *       * Cálculo en vivo: `precio / minutos = costo por minuto`.
 *       * Validación previa antes de invocar `onCreatePlan`.
 *
 * @dependencias_internas
 *   - `GlobalPricingPlan`, `calculateEffectiveUnitRate` de `useSuperAdminPricingAndOverrides.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 */

import React, { ReactElement, useState } from 'react';
import type { GlobalPricingPlan } from './useSuperAdminPricingAndOverrides';
import { calculateEffectiveUnitRate } from './useSuperAdminPricingAndOverrides';

export interface CreateNewPlanModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onCreatePlan: (newPlan: GlobalPricingPlan) => Promise<boolean>;
}

export function CreateNewPlanModal({
  isOpen,
  onClose,
  onCreatePlan,
}: CreateNewPlanModalProps): ReactElement | null {
  const [planCode, setPlanCode] = useState<string>('PLAN_15');
  // El identificador de la pasarela NO se pre-rellenaba con un valor de ejemplo: un `whop_plan_...`
  // inventado se guardaba tal cual y el plan quedaba imposible de contratar. Se parte vacio y se
  // exige la forma real (`plan_...`) antes de enviar.
  const [whopPlanId, setWhopPlanId] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('Plan Especial ($15 USD / mes)');
  const [monthlyFixedPriceUsd, setMonthlyFixedPriceUsd] = useState<string>('15.00');
  const [includedMinutes, setIncludedMinutes] = useState<string>('120');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const unitRate = calculateEffectiveUnitRate(monthlyFixedPriceUsd, includedMinutes);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planCode.trim() || !whopPlanId.trim() || !displayName.trim()) {
      setErrorMsg('Todos los campos son obligatorios.');
      return;
    }
    // Forma exigida por la pasarela: los planes reales empiezan por `plan_`. Rechazar aqui evita
    // crear un plan que el checkout no podra contratar nunca.
    if (!/^plan_[A-Za-z0-9]+$/u.test(whopPlanId.trim())) {
      setErrorMsg(
        'El identificador de la pasarela debe tener la forma plan_XXXXXXXXXXXX. Cree el plan en la pasarela (o ejecute el aprovisionamiento) y pegue aqui su identificador real.'
      );
      return;
    }
    const priceNum = parseFloat(monthlyFixedPriceUsd);
    const minsNum = parseFloat(includedMinutes);
    if (isNaN(priceNum) || priceNum < 0 || isNaN(minsNum) || minsNum < 0) {
      setErrorMsg('Precio y minutos deben ser números válidos mayores o iguales a 0.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    const newPlan: GlobalPricingPlan = {
      planCode: planCode.trim().toUpperCase(),
      whopPlanId: whopPlanId.trim(),
      displayName: displayName.trim(),
      monthlyFixedPriceUsd: priceNum.toFixed(2),
      includedMinutes: minsNum.toFixed(4),
      baseOverageRatePerMinuteUsd: unitRate.toFixed(6),
      overageAllowed: false, // Paquete cerrado por defecto
      volumeDiscountEligible: false,
      volumeDiscountTiers: [],
      isActive: true,
    };

    const success = await onCreatePlan(newPlan);
    setIsSubmitting(false);
    if (success) {
      onClose();
    } else {
      setErrorMsg('Error al persistir el plan en PostgreSQL.');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '6px',
          width: '100%',
          maxWidth: '520px',
          padding: '24px',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.15)',
          color: 'var(--color-ink, #26251e)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 500, margin: 0 }}>
            Crear Nuevo Plan Fijo Mensual
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '18px',
              cursor: 'pointer',
              color: 'var(--color-driftwood, #84847e)',
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
          Configure un nuevo paquete cerrado de minutos. El costo por minuto se calculará de forma automática.
        </p>

        {errorMsg && (
          <div
            role="alert"
            style={{
              backgroundColor: 'rgba(207, 45, 86, 0.1)',
              border: '1px solid var(--color-crimson, #cf2d56)',
              borderRadius: '4px',
              padding: '8px 12px',
              fontSize: '12px',
              color: 'var(--color-crimson, #cf2d56)',
              marginBottom: '16px',
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                Código Interno (ID único):
              </label>
              <input
                type="text"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                placeholder="ej: PLAN_15"
                required
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  fontSize: '12px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                Identificador del plan en la pasarela:
              </label>
              <input
                type="text"
                value={whopPlanId}
                onChange={(e) => setWhopPlanId(e.target.value)}
                placeholder="ej: plan_aB3gy0ILk0OWB (obligatorio, forma plan_...)"
                required
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  fontSize: '12px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
              Nombre Comercial:
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="ej: Plan Growth Plus ($15 USD / mes)"
              required
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid var(--color-stone, #cdcdc9)',
                fontSize: '12px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                Precio Fijo Mensual ($ USD):
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={monthlyFixedPriceUsd}
                onChange={(e) => setMonthlyFixedPriceUsd(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginBottom: '4px' }}>
                Minutos Incluidos:
              </label>
              <input
                type="number"
                step="1"
                min="1"
                value={includedMinutes}
                onChange={(e) => setIncludedMinutes(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Tarjeta de cálculo reactivo del costo por minuto */}
          <div
            style={{
              backgroundColor: 'var(--color-bone, #f2f1ed)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '12px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', display: 'block' }}>
                Costo Efectivo por Minuto (calculado):
              </span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-forest, #34785c)', fontFamily: 'var(--font-berkeleymono, monospace)' }}>
                ${unitRate.toFixed(4)} / min
              </span>
            </div>
            <span
              style={{
                fontSize: '11px',
                backgroundColor: 'rgba(52, 120, 92, 0.12)',
                color: 'var(--color-forest, #34785c)',
                padding: '4px 8px',
                borderRadius: '3px',
                fontWeight: 500,
              }}
            >
              Tope Cerrado (Sin sobrecostos)
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid var(--color-stone, #cdcdc9)',
                borderRadius: '4px',
                padding: '8px 16px',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                backgroundColor: 'var(--color-forest, #34785c)',
                border: '1px solid var(--color-forest, #34785c)',
                borderRadius: '4px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#ffffff',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Creando Plan...' : 'Crear y Publicar Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
