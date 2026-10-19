/**
 * @archivo apps/web/src/components/billing-whop/CurrentPlanAndBalanceCard.tsx
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Tarjeta principal de estado financiero para el Dashboard del Desarrollador (Cursor Atelier Light).
 *   Muestra el plan activo, el balance de minutos incluidos vs sobreconsumo, la tarifa efectiva
 *   por minuto con números tabulares (`tnum`) y el tramo de descuento por volumen alcanzado.
 *
 * @resumen_contenido
 *   - Componente `CurrentPlanAndBalanceCard`:
 *       * Cabecera con selector visual de plan y badge de estado de suscripción.
 *       * Barra de progreso de minutos (consumidos vs restantes con advertencia al 85%).
 *       * Indicador de tarifa por minuto en fuente mono con alineación `tnum`.
 *       * Escaparate de tramos de descuento por volumen alcanzados.
 *       * Resumen de ciclo de facturación y costo total acumulado.
 *       * Estado vacío honesto («Plan no disponible») cuando el consumo aún no está disponible.
 *
 * @dependencias_internas
 *   - Tipos de `useOrganizationBillingWhop.ts` (`BillingConsumptionState`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useMemo`).
 *
 * @tablas_bd_o_redis
 *   - Proyección visual sin acoplamiento a base de datos ni nombres de infraestructura.
 */

import React, { ReactElement, useMemo } from 'react';
import type { BillingConsumptionState } from './useOrganizationBillingWhop';

export interface CurrentPlanAndBalanceCardProps {
  readonly consumption: BillingConsumptionState | null;
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onOpenManagePlan: () => void;
}

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  PAYG: 'Pago por Uso (PAYG)',
  PLAN_5: 'Plan Starter ($5 USD/mes)',
  PLAN_10: 'Plan Growth ($10 USD/mes)',
  PLAN_30: 'Plan Pro ($30 USD/mes)',
  PLAN_50: 'Plan Scale ($50 USD/mes)',
  CUSTOM_ENTERPRISE: 'Plan Enterprise a medida',
};

/**
 * Tarjeta de saldo y plan activo en estética Cursor Light (Warm Parchment Atelier).
 */
export function CurrentPlanAndBalanceCard({
  consumption,
  isLoading,
  onRefresh,
  onOpenManagePlan,
}: CurrentPlanAndBalanceCardProps): ReactElement {
  const planName = consumption
    ? PLAN_DISPLAY_NAMES[consumption.planCode] ?? consumption.planCode
    : isLoading
      ? 'Cargando plan...'
      : 'Plan no disponible';

  const percentUsed = useMemo(() => {
    if (!consumption || consumption.includedMinutesTotal === 0) return 0;
    const ratio = (consumption.includedMinutesUsed / consumption.includedMinutesTotal) * 100;
    return Math.min(100, Math.max(0, Math.round(ratio)));
  }, [consumption]);

  const isNearLimit = percentUsed >= 85;
  const isOverLimit = consumption ? consumption.overageMinutesUsed > 0 : false;

  return (
    <section
      aria-labelledby="billing-balance-title"
      style={{
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: 'var(--radius-cards, 4px)',
        padding: '24px',
        color: 'var(--color-ink, #26251e)',
        fontFamily: 'var(--font-cursorgothic, sans-serif)',
        boxShadow: 'none',
      }}
    >
      {/* Cabecera Superior: Título de sección y Botón Gestionar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div style={{ flex: '1 1 220px', minWidth: '0' }}>
          <div
            style={{
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--color-driftwood, #84847e)',
              marginBottom: '4px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
            }}
          >
            Estado de Cuenta y Tarificación Activa
          </div>
          <h2
            id="billing-balance-title"
            style={{
              fontSize: '20px',
              fontWeight: 400,
              margin: 0,
              letterSpacing: '-0.01em',
              color: 'var(--color-ink, #26251e)',
            }}
          >
            {planName}
          </h2>
          {!consumption && !isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)', margin: '4px 0 0' }}>
              Sin datos de consumo: la sesión no está autenticada o el motor de facturación no respondió.
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            style={{
              background: 'transparent',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '6px 12px',
              fontSize: '12px',
              color: 'var(--color-ink, #26251e)',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-berkeleymono, monospace)',
            }}
          >
            {isLoading ? 'Sincronizando...' : 'Refrescar Saldo'}
          </button>

          <button
            type="button"
            onClick={onOpenManagePlan}
            style={{
              backgroundColor: 'var(--color-ink, #26251e)',
              color: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-ink, #26251e)',
              borderRadius: '4px',
              padding: '6px 14px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cambiar Plan
          </button>
        </div>
      </div>

      {/* Grid de Métricas Principales */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        {/* Celda 1: Minutos Disponibles */}
        <div
          style={{
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '16px',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Minutos en Plan / Restantes
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '22px',
              fontWeight: 500,
              color: isOverLimit ? 'var(--color-crimson, #cf2d56)' : 'var(--color-ink, #26251e)',
            }}
          >
            {consumption ? `${consumption.includedMinutesRemaining} / ${consumption.includedMinutesTotal}` : '—'}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            {consumption && consumption.includedMinutesRemaining === 0 ? 'Cuota base agotada (en sobreconsumo)' : 'Minutos de voz restantes'}
          </span>
        </div>

        {/* Celda 2: Tarifa Efectiva Vigente */}
        <div
          style={{
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '16px',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Tarifa Efectiva por Minuto
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '22px',
              fontWeight: 500,
              color: 'var(--color-forest, #34785c)',
            }}
          >
            {consumption ? `$${consumption.effectiveRatePerMinuteUsd}` : '—'}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            {consumption && consumption.volumeDiscountPercentage > 0
              ? `Incluye ${consumption.volumeDiscountPercentage}% descuento por volumen`
              : 'Tarifa base sin recargos ocultos'}
          </span>
        </div>

        {/* Celda 3: Sobreconsumo del Periodo */}
        <div
          style={{
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '16px',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)', display: 'block', marginBottom: '6px' }}>
            Sobreconsumo Acumulado
          </span>
          <div
            style={{
              fontFamily: 'var(--font-berkeleymono, monospace)',
              fontFeatureSettings: '"tnum"',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '22px',
              fontWeight: 500,
              color: isOverLimit ? 'var(--color-crimson, #cf2d56)' : 'var(--color-ink, #26251e)',
            }}
          >
            {consumption ? `${consumption.overageMinutesUsed} min ($${consumption.overageBilledUsd})` : '—'}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            Tope de protección: {consumption?.hardSpendCapUsd ? `$${consumption.hardSpendCapUsd} USD` : 'Sin límite duro'}
          </span>
        </div>
      </div>

      {/* Barra de Progreso de Minutos */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
          <span>Utilización de la cuota mensual</span>
          <span style={{ fontFamily: 'var(--font-berkeleymono, monospace)', fontFeatureSettings: '"tnum"' }}>
            {percentUsed}% ({consumption?.includedMinutesUsed ?? 0} de {consumption?.includedMinutesTotal ?? 0} min)
          </span>
        </div>
        <div
          style={{
            width: '100%',
            height: '8px',
            backgroundColor: 'var(--color-linen, #e6e5e0)',
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${percentUsed}%`,
              height: '100%',
              backgroundColor: isOverLimit
                ? 'var(--color-crimson, #cf2d56)'
                : isNearLimit
                ? 'var(--color-amber, #c08532)'
                : 'var(--color-forest, #34785c)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      {/* Tramo de Volumen Alcanzado */}
      {consumption && consumption.activeVolumeTier && (
        <div
          style={{
            backgroundColor: 'rgba(52, 120, 92, 0.08)',
            border: '1px solid var(--color-forest, #34785c)',
            borderRadius: '4px',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <span style={{ fontWeight: 500, color: 'var(--color-forest, #34785c)', fontSize: '13px' }}>
              Tramo de Descuento por Volumen Alcanzado: {consumption.activeVolumeTier.discountPercentage}% Dto.
            </span>
            <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--color-ink, #26251e)' }}>
              Tramo de descuento por volumen nº {consumption.activeVolumeTier.tier} aplicado. Tarifa
              resultante:{' '}
              <span style={{ fontFamily: 'var(--font-berkeleymono, monospace)', fontFeatureSettings: '"tnum"' }}>
                ${consumption.activeVolumeTier.discountedRatePerMinuteUsd ?? consumption.effectiveRatePerMinuteUsd}/min
              </span>
            </p>
          </div>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              backgroundColor: 'var(--color-forest, #34785c)',
              color: 'var(--color-parchment, #f7f7f4)',
              padding: '4px 8px',
              borderRadius: '4px',
            }}
          >
            ACTIVO
          </span>
        </div>
      )}
    </section>
  );
}
