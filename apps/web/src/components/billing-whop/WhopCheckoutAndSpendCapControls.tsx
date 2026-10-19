/**
 * @archivo apps/web/src/components/billing-whop/WhopCheckoutAndSpendCapControls.tsx
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Panel interactivo de cambio rápido de planes comerciales ($5 a $50 USD/mes o PAYG),
 *   acceso al portal de métodos de pago y formulario de protección de gasto (Spend Cap)
 *   con umbrales preventivos al 50%, 80% y 100%.
 *
 * @resumen_contenido
 *   - Componente `WhopCheckoutAndSpendCapControls`:
 *       * Botones de selección de plan: `btn_subscribe_plan_5` a `btn_subscribe_plan_50` y `btn_switch_to_payg`.
 *       * Botón `btn_open_whop_customer_portal` para facturas y métodos de pago guardados.
 *       * Subformulario `SpendProtectionControls` con validación numérica para `hard_spend_cap_usd`.
 *       * Alerta contextual cuando se requiere firma del DPA (`dpaRequired`).
 *
 * @dependencias_internas
 *   - `SpendCapConfig`, `BillingConsumptionState` (de `useOrganizationBillingWhop.ts`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`).
 *
 * @tablas_bd_o_redis
 *   - Configuración persistida en `whop_subscriptions.hard_spend_cap_usd` y pasarela de cobro.
 */

import React, { ReactElement, useEffect, useState } from 'react';
import type { BillingConsumptionState, SpendCapConfig } from './useOrganizationBillingWhop';
import { usePublicPlanCatalog } from './usePublicPlanCatalog';

export interface WhopCheckoutAndSpendCapControlsProps {
  readonly currentPlanCode: string;
  readonly consumption: BillingConsumptionState | null;
  readonly isLoading: boolean;
  readonly dpaRequired: boolean;
  readonly onSelectPlan: (planCode: string) => Promise<string | null>;
  readonly onOpenCustomerPortal: () => Promise<string | null>;
  readonly onSaveSpendCap: (config: SpendCapConfig) => Promise<boolean>;
}

/**
 * Controles de cambio de plan y formulario de protección Spend Cap.
 */
export function WhopCheckoutAndSpendCapControls({
  currentPlanCode,
  consumption,
  isLoading,
  dpaRequired,
  onSelectPlan,
  onOpenCustomerPortal,
  onSaveSpendCap,
}: WhopCheckoutAndSpendCapControlsProps): ReactElement {
  const [capAmount, setCapAmount] = useState<string>(consumption?.hardSpendCapUsd ?? '');
  const [alert50, setAlert50] = useState<boolean>(true);
  const [alert80, setAlert80] = useState<boolean>(true);
  const [alert100, setAlert100] = useState<boolean>(true);
  const [isSavingCap, setIsSavingCap] = useState<boolean>(false);
  const [capSuccessMsg, setCapSuccessMsg] = useState<string | null>(null);

  // Catálogo REAL de planes: la matriz de precios pública del backend, sin cifras escritas a mano.
  const { plans, isLoading: isLoadingCatalog, error: catalogError } = usePublicPlanCatalog();

  // Refleja el tope real del servidor cuando la instantánea de consumo llega (o se actualiza).
  useEffect((): void => {
    const serverCap = consumption?.hardSpendCapUsd ?? null;
    if (serverCap !== null) {
      setCapAmount(serverCap);
    }
  }, [consumption?.hardSpendCapUsd]);

  const handleSaveCap = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingCap(true);
    setCapSuccessMsg(null);
    const success = await onSaveSpendCap({
      hardSpendCapUsd: capAmount,
      alertAt50Percent: alert50,
      alertAt80Percent: alert80,
      alertAt100Percent: alert100,
    });
    setIsSavingCap(false);
    if (success) {
      setCapSuccessMsg('Tope de gasto y umbrales actualizados correctamente.');
      setTimeout(() => setCapSuccessMsg(null), 4000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Alerta de DPA pendiente */}
      {dpaRequired && (
        <div
          role="alert"
          style={{
            backgroundColor: 'rgba(207, 45, 86, 0.08)',
            border: '1px solid var(--color-crimson, #cf2d56)',
            borderRadius: '4px',
            padding: '16px',
            color: 'var(--color-crimson, #cf2d56)',
          }}
        >
          <strong style={{ display: 'block', marginBottom: '4px' }}>Firma del Acuerdo DPA Requerida</strong>
          <span style={{ fontSize: '13px' }}>
            Para activar o modificar suscripciones de voz en producción, el propietario de la organización debe
            aceptar el Acuerdo de Procesamiento de Datos (DPA) desde la sección de configuración legal.
          </span>
        </div>
      )}

      {/* Grid de Selección de Planes */}
      <section
        aria-labelledby="plans-selection-title"
        style={{
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '24px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3
              id="plans-selection-title"
              style={{
                fontSize: '18px',
                fontWeight: 400,
                margin: 0,
                color: 'var(--color-ink, #26251e)',
              }}
            >
              Planes de Capacidad y Minutos
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
              Seleccione una modalidad mensual con cuota incluida o facture según consumo exacto (PAYG).
            </p>
          </div>

          <button
            type="button"
            id="btn_open_whop_customer_portal"
            onClick={onOpenCustomerPortal}
            disabled={isLoading}
            style={{
              backgroundColor: 'var(--color-linen, #e6e5e0)',
              color: 'var(--color-ink, #26251e)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '8px 14px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-berkeleymono, monospace)',
            }}
          >
            Portal de Facturación y Medios de Pago →
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
          }}
        >
          {catalogError !== null && (
            <p
              role="status"
              style={{
                gridColumn: '1 / -1',
                margin: 0,
                fontSize: '12px',
                fontFamily: 'var(--font-berkeleymono, monospace)',
                color: 'var(--color-crimson, #cf2d56)',
              }}
            >
              No fue posible consultar la matriz real de precios: {catalogError} No se muestran cifras de ejemplo.
            </p>
          )}
          {plans.map((plan) => {
            const isCurrent = currentPlanCode === plan.code;
            return (
              <div
                key={plan.code}
                style={{
                  backgroundColor: isCurrent ? 'var(--color-linen, #e6e5e0)' : 'var(--color-parchment, #f7f7f4)',
                  border: isCurrent
                    ? '2px solid var(--color-forest, #34785c)'
                    : '1px solid var(--color-stone, #cdcdc9)',
                  borderRadius: '4px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  minHeight: '170px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-ink, #26251e)' }}>
                      {plan.name}
                    </span>
                    {isCurrent && (
                      <span
                        style={{
                          fontSize: '10px',
                          color: 'var(--color-forest, #34785c)',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                        }}
                      >
                        ACTUAL
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: '18px',
                      fontWeight: 500,
                      marginTop: '6px',
                      fontFamily: 'var(--font-berkeleymono, monospace)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {plan.priceUsd}
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginTop: '4px' }}>
                    {plan.minutes}
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)', marginTop: '2px' }}>
                    Exceso: {plan.overageRate}
                  </div>
                </div>

                <button
                  type="button"
                  id={plan.buttonId}
                  disabled={isCurrent || isLoading}
                  onClick={() => void onSelectPlan(plan.code)}
                  style={{
                    marginTop: '14px',
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: isCurrent || isLoading ? 'default' : 'pointer',
                    backgroundColor: isCurrent
                      ? 'transparent'
                      : 'var(--color-ink, #26251e)',
                    color: isCurrent
                      ? 'var(--color-driftwood, #84847e)'
                      : 'var(--color-parchment, #f7f7f4)',
                    border: isCurrent
                      ? '1px solid var(--color-stone, #cdcdc9)'
                      : '1px solid var(--color-ink, #26251e)',
                  }}
                >
                  {isCurrent ? 'Plan Activo' : 'Seleccionar'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sección Spend Protection / Spend Cap */}
      <section
        aria-labelledby="spend-protection-title"
        style={{
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '24px',
        }}
      >
        <h3
          id="spend-protection-title"
          style={{ fontSize: '18px', fontWeight: 400, margin: '0 0 6px', color: 'var(--color-ink, #26251e)' }}
        >
          Protección de Gasto Máximo (Spend Cap)
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
          Establezca un límite estricto de gasto mensual en USD para prevenir consumos no planificados. Al alcanzar el
          100%, las sesiones de voz se pausarán automáticamente de forma segura.
        </p>

        <form onSubmit={handleSaveCap} style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '480px' }}>
          <div>
            <label
              htmlFor="spend-cap-input"
              style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}
            >
              Límite duro mensual (USD):
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontFamily: 'var(--font-berkeleymono, monospace)', fontSize: '16px' }}>$</span>
              <input
                id="spend-cap-input"
                type="number"
                min="5"
                max="50000"
                step="5"
                value={capAmount}
                onChange={(e) => setCapAmount(e.target.value)}
                style={{
                  backgroundColor: 'var(--color-parchment, #f7f7f4)',
                  border: '1px solid var(--color-stone, #cdcdc9)',
                  borderRadius: '4px',
                  padding: '8px 12px',
                  fontSize: '14px',
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                  width: '160px',
                  color: 'var(--color-ink, #26251e)',
                }}
              />
              <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>USD / ciclo mensual</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 500 }}>Alertas preventivas por correo electrónico:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alert50}
                onChange={(e) => setAlert50(e.target.checked)}
                style={{ accentColor: 'var(--color-ink, #26251e)' }}
              />
              Avisar al alcanzar el 50% del presupuesto
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alert80}
                onChange={(e) => setAlert80(e.target.checked)}
                style={{ accentColor: 'var(--color-ink, #26251e)' }}
              />
              Avisar al alcanzar el 80% del presupuesto (Alerta preventiva)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alert100}
                onChange={(e) => setAlert100(e.target.checked)}
                style={{ accentColor: 'var(--color-crimson, #cf2d56)' }}
              />
              Avisar al alcanzar el 100% y pausar nuevas sesiones de voz
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
            <button
              type="submit"
              disabled={isSavingCap || isLoading}
              style={{
                backgroundColor: 'var(--color-ink, #26251e)',
                color: 'var(--color-parchment, #f7f7f4)',
                border: '1px solid var(--color-ink, #26251e)',
                borderRadius: '4px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: isSavingCap || isLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {isSavingCap ? 'Guardando...' : 'Guardar Límite de Gasto'}
            </button>
            {capSuccessMsg && (
              <span style={{ fontSize: '12px', color: 'var(--color-forest, #34785c)' }}>
                {capSuccessMsg}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
