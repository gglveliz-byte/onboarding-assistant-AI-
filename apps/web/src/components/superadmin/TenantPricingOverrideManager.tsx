/**
 * @archivo apps/web/src/components/superadmin/TenantPricingOverrideManager.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Consola para asignar tarifas a medida, descuentos manuales por cliente con prioridad
 *   absoluta sobre la matriz general en `CalculateEffectiveRateUseCase`, y acreditación
 *   de minutos de cortesía (`CREDIT_SUPERADMIN_GRANT`).
 *
 * @resumen_contenido
 *   - Componente `TenantPricingOverrideManager`:
 *       * Formulario de fijación de tarifas a medida (`custom_rate_per_minute_usd`).
 *       * Control de porcentaje de descuento manual (0% a 100%).
 *       * Configuración de vigencia temporal (`effective_from` / `effective_until`).
 *       * Sección de acreditación de minutos promocionales con motivo auditable.
 *
 * @dependencias_internas
 *   - Tipos de `useSuperAdminPricingAndOverrides.ts` (`TenantOverridePayload`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Modifica `organization_pricing_overrides` y genera asientos en `usage_ledger`.
 */

import React, { ReactElement, useState } from 'react';
import type { TenantOverridePayload } from './useSuperAdminPricingAndOverrides';

export interface TenantPricingOverrideManagerProps {
  readonly onApplyOverride: (orgId: string, payload: TenantOverridePayload) => Promise<boolean>;
  readonly onRemoveOverride: (orgId: string) => Promise<boolean>;
  readonly onGrantPromotionalMinutes: (orgId: string, minutes: number, reason: string) => Promise<boolean>;
}

/**
 * Gestor de tarifas personalizadas y minutos de cortesía por organización.
 */
export function TenantPricingOverrideManager({
  onApplyOverride,
  onRemoveOverride,
  onGrantPromotionalMinutes,
}: TenantPricingOverrideManagerProps): ReactElement {
  const [targetOrgId, setTargetOrgId] = useState<string>('');
  const [customRate, setCustomRate] = useState<string>('0.065000');
  const [manualDiscount, setManualDiscount] = useState<number>(0);
  const [forceVolumeTiers, setForceVolumeTiers] = useState<boolean>(false);
  const [overrideNotes, setOverrideNotes] = useState<string>('Tarifa preferencial para socio estratégico');
  const [effectiveUntil, setEffectiveUntil] = useState<string>('');

  const [promoMinutes, setPromoMinutes] = useState<number>(100);
  const [promoReason, setPromoReason] = useState<string>('Compensación técnica por latencia de red');

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const handleSaveOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetOrgId.trim()) {
      setFeedbackMsg({ text: 'Debe ingresar el ID o slug de la organización objetivo.', isError: true });
      return;
    }
    setIsSubmitting(true);
    setFeedbackMsg(null);
    const ok = await onApplyOverride(targetOrgId.trim(), {
      customRatePerMinuteUsd: customRate.trim() || null,
      manualDiscountPercentage: manualDiscount,
      forceVolumeDiscountTiers: forceVolumeTiers,
      overrideNotes: overrideNotes.trim(),
      effectiveUntil: effectiveUntil.trim() || null,
    });
    setIsSubmitting(false);
    if (ok) {
      setFeedbackMsg({ text: `Override tarifario aplicado exitosamente a "${targetOrgId}".`, isError: false });
    } else {
      setFeedbackMsg({ text: 'Error al aplicar el override tarifario.', isError: true });
    }
  };

  const handleGrantPromo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetOrgId.trim()) {
      setFeedbackMsg({ text: 'Debe ingresar el ID de la organización objetivo.', isError: true });
      return;
    }
    if (promoMinutes <= 0) {
      setFeedbackMsg({ text: 'El número de minutos debe ser mayor a 0.', isError: true });
      return;
    }
    setIsSubmitting(true);
    setFeedbackMsg(null);
    const ok = await onGrantPromotionalMinutes(targetOrgId.trim(), promoMinutes, promoReason.trim());
    setIsSubmitting(false);
    if (ok) {
      setFeedbackMsg({
        text: `${promoMinutes} minutos promocionales acreditados a "${targetOrgId}" con asiento CREDIT_SUPERADMIN_GRANT.`,
        isError: false,
      });
    } else {
      setFeedbackMsg({ text: 'Error al acreditar minutos de cortesía.', isError: true });
    }
  };

  const handleRemoveOverride = async () => {
    if (!targetOrgId.trim()) return;
    const confirmed = window.confirm(`¿Restablecer tarifas generales para la organización "${targetOrgId}"?`);
    if (!confirmed) return;
    setIsSubmitting(true);
    setFeedbackMsg(null);
    const ok = await onRemoveOverride(targetOrgId.trim());
    setIsSubmitting(false);
    if (ok) {
      setFeedbackMsg({ text: `Override revocado. La organización ha vuelto a la matriz general.`, isError: false });
    } else {
      setFeedbackMsg({ text: 'Error al revocar override.', isError: true });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Campo Selector de Organización */}
      <section
        style={{
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '20px 24px',
        }}
      >
        <label
          htmlFor="override-org-id"
          style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}
        >
          Organización Objetivo (ID o UUID):
        </label>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            id="override-org-id"
            type="text"
            placeholder="Ej: 00000000-0000-4000-8000-00000000b111"
            value={targetOrgId}
            onChange={(e) => setTargetOrgId(e.target.value)}
            style={{
              flex: 1,
              maxWidth: '460px',
              padding: '8px 12px',
              borderRadius: '4px',
              border: '1px solid var(--color-stone, #cdcdc9)',
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              fontSize: '13px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              color: 'var(--color-ink, #26251e)',
            }}
          />
          <button
            type="button"
            onClick={handleRemoveOverride}
            disabled={!targetOrgId.trim() || isSubmitting}
            style={{
              backgroundColor: 'transparent',
              border: '1px solid var(--color-crimson, #cf2d56)',
              borderRadius: '4px',
              padding: '8px 14px',
              fontSize: '12px',
              color: 'var(--color-crimson, #cf2d56)',
              cursor: !targetOrgId.trim() || isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            Revocar Override Actual
          </button>
        </div>
      </section>

      {/* Mensaje de Feedback */}
      {feedbackMsg && (
        <div
          role="status"
          style={{
            padding: '12px 16px',
            borderRadius: '4px',
            fontSize: '13px',
            backgroundColor: feedbackMsg.isError ? 'rgba(207, 45, 86, 0.08)' : 'rgba(52, 120, 92, 0.08)',
            border: `1px solid ${feedbackMsg.isError ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)'}`,
            color: feedbackMsg.isError ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)',
          }}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* Grid de Dos Columnas: 1) Formulario Override, 2) Minutos Promocionales */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '24px' }}>
        {/* Columna 1: Override Tarifario */}
        <section
          aria-labelledby="override-form-title"
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '24px',
          }}
        >
          <h3 id="override-form-title" style={{ fontSize: '18px', fontWeight: 400, margin: '0 0 6px' }}>
            Fijar Tarifa Personalizada por Minuto
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Este valor tiene <strong>prioridad absoluta</strong> sobre el catálogo general en las deducciones en tiempo real.
          </p>

          <form onSubmit={handleSaveOverride} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Tarifa personalizada por minuto (USD):
              </label>
              <input
                type="text"
                value={customRate}
                onChange={(e) => setCustomRate(e.target.value)}
                placeholder="0.065000"
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
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Descuento manual compuesto (%):
              </label>
              <input
                type="number"
                min="0"
                max="100"
                value={manualDiscount}
                onChange={(e) => setManualDiscount(Number(e.target.value))}
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
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Vigencia hasta (ISO / Fecha):
              </label>
              <input
                type="date"
                value={effectiveUntil}
                onChange={(e) => setEffectiveUntil(e.target.value)}
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
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Justificación de auditoría del override:
              </label>
              <textarea
                rows={2}
                value={overrideNotes}
                onChange={(e) => setOverrideNotes(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="force-vol-check"
                type="checkbox"
                checked={forceVolumeTiers}
                onChange={(e) => setForceVolumeTiers(e.target.checked)}
                style={{ accentColor: 'var(--color-forest, #34785c)' }}
              />
              <label htmlFor="force-vol-check" style={{ fontSize: '12px', cursor: 'pointer' }}>
                Permitir acumulación adicional con tramos de volumen
              </label>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                marginTop: '8px',
                backgroundColor: 'var(--color-forest, #34785c)',
                color: 'var(--color-parchment, #f7f7f4)',
                border: '1px solid var(--color-forest, #34785c)',
                borderRadius: '4px',
                padding: '10px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Guardando...' : 'Aplicar Override de Tarifa'}
            </button>
          </form>
        </section>

        {/* Columna 2: Minutos Promocionales / Cortesía */}
        <section
          aria-labelledby="promo-minutes-title"
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '24px',
          }}
        >
          <h3 id="promo-minutes-title" style={{ fontSize: '18px', fontWeight: 400, margin: '0 0 6px' }}>
            Acreditar Minutos Promocionales de Cortesía
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Inserta un crédito en el libro mayor inmutable con tipo de asiento <code>CREDIT_SUPERADMIN_GRANT</code>.
          </p>

          <form onSubmit={handleGrantPromo} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Cantidad de minutos de voz a acreditar:
              </label>
              <input
                type="number"
                min="1"
                max="50000"
                step="5"
                value={promoMinutes}
                onChange={(e) => setPromoMinutes(Number(e.target.value))}
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
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                Motivo auditable del abono de cortesía:
              </label>
              <textarea
                rows={3}
                value={promoReason}
                onChange={(e) => setPromoReason(e.target.value)}
                placeholder="Indique motivo técnico o comercial..."
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <button
              type="submit"
              id="btn_grant_promotional_minutes"
              disabled={isSubmitting}
              style={{
                marginTop: '12px',
                backgroundColor: 'var(--color-amber, #c08532)',
                color: 'var(--color-parchment, #f7f7f4)',
                border: '1px solid var(--color-amber, #c08532)',
                borderRadius: '4px',
                padding: '10px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Acreditando...' : 'Acreditar Minutos de Cortesía'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
