/**
 * @archivo apps/web/src/components/billing-whop/MinuteByMinuteUsageLedgerTable.tsx
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Tabla auditable del libro mayor (usage_ledger) minuto a minuto en estética Cursor Atelier Light.
 *   Permite a los administradores y desarrolladores inspeccionar cada pulso de consumo de voz,
 *   asientos de recarga o abonos de cortesía, con filtrado en tiempo real y descarga CSV.
 *
 * @resumen_contenido
 *   - Componente `MinuteByMinuteUsageLedgerTable`:
 *       * Barra de herramientas: Filtro por tipo de asiento, buscador y botón `btn_export_usage_csv`.
 *       * Tabla de alta densidad: Marca temporal, concepto, tipo de asiento, minutos debitados/acreditados,
 *         costo unitario, motor de voz y saldo acumulado en números tabulares (`tnum`).
 *       * Paginación / carga de siguientes registros.
 *
 * @dependencias_internas
 *   - `BillingLedgerItem` de `useOrganizationBillingWhop.ts`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `useState`, `useMemo`).
 *
 * @tablas_bd_o_redis
 *   - Representa filas inmutables de la tabla `usage_ledger` en PostgreSQL.
 */

import React, { ReactElement, useState, useMemo } from 'react';
import type { BillingLedgerItem } from './useOrganizationBillingWhop';

export interface MinuteByMinuteUsageLedgerTableProps {
  readonly items: readonly BillingLedgerItem[];
  readonly isLoading: boolean;
  readonly isExportingCsv: boolean;
  readonly onExportCsv: () => void;
  readonly onRefresh: () => void;
}

const ENTRY_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  VOICE_MINUTE_DEDUCTION: { label: 'Consumo de Voz', color: 'var(--color-driftwood, #84847e)' },
  PLAN_ACTIVATION_GRANT: { label: 'Cuota de Plan', color: 'var(--color-forest, #34785c)' },
  PAYMENT_SUCCEEDED_RENEWAL: { label: 'Renovación Pago', color: 'var(--color-verdant, #1f8a65)' },
  CREDIT_SUPERADMIN_GRANT: { label: 'Abono Cortesía', color: 'var(--color-amber, #c08532)' },
};

/**
 * Tabla auditable minuto a minuto del libro mayor.
 */
export function MinuteByMinuteUsageLedgerTable({
  items,
  isLoading,
  isExportingCsv,
  onExportCsv,
  onRefresh,
}: MinuteByMinuteUsageLedgerTableProps): ReactElement {
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filterType !== 'ALL' && item.entryType !== filterType) {
        return false;
      }
      if (searchTerm.trim().length > 0) {
        const query = searchTerm.toLowerCase();
        const matchesDesc = item.description.toLowerCase().includes(query);
        const matchesProject = item.projectName?.toLowerCase().includes(query) ?? false;
        return matchesDesc || matchesProject;
      }
      return true;
    });
  }, [items, filterType, searchTerm]);

  return (
    <section
      aria-labelledby="usage-ledger-title"
      style={{
        backgroundColor: 'var(--color-bone, #f2f1ed)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        borderRadius: 'var(--radius-cards, 4px)',
        padding: '24px',
        color: 'var(--color-ink, #26251e)',
      }}
    >
      {/* Barra de Filtros y Acciones */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        <div>
          <h3
            id="usage-ledger-title"
            style={{ fontSize: '18px', fontWeight: 400, margin: 0, color: 'var(--color-ink, #26251e)' }}
          >
            Libro Mayor de Consumo Minuto a Minuto
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Registro inmutable de deducciones, renovaciones y créditos con números tabulares de precisión.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            style={{
              backgroundColor: 'transparent',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '6px 12px',
              fontSize: '12px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              color: 'var(--color-ink, #26251e)',
            }}
          >
            Actualizar
          </button>

          <button
            type="button"
            id="btn_export_usage_csv"
            onClick={onExportCsv}
            disabled={isExportingCsv || items.length === 0}
            style={{
              backgroundColor: 'var(--color-linen, #e6e5e0)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: isExportingCsv || items.length === 0 ? 'not-allowed' : 'pointer',
              color: 'var(--color-ink, #26251e)',
              fontFamily: 'var(--font-berkeleymono, monospace)',
            }}
          >
            {isExportingCsv ? 'Descargando CSV...' : 'Exportar Libro Mayor (.CSV)'}
          </button>
        </div>
      </div>

      {/* Controles de Filtrado */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label htmlFor="ledger-filter-type" style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Tipo de Asiento:
          </label>
          <select
            id="ledger-filter-type"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '12px',
              color: 'var(--color-ink, #26251e)',
            }}
          >
            <option value="ALL">Todos los asientos</option>
            <option value="VOICE_MINUTE_DEDUCTION">Consumo de Voz</option>
            <option value="PLAN_ACTIVATION_GRANT">Cuota de Plan</option>
            <option value="PAYMENT_SUCCEEDED_RENEWAL">Renovación de Pago</option>
            <option value="CREDIT_SUPERADMIN_GRANT">Abono Cortesía</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
          <label htmlFor="ledger-search-input" style={{ fontSize: '12px', color: 'var(--color-driftwood, #84847e)' }}>
            Buscar:
          </label>
          <input
            id="ledger-search-input"
            type="text"
            placeholder="Buscar por proyecto o detalle..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              backgroundColor: 'var(--color-parchment, #f7f7f4)',
              border: '1px solid var(--color-stone, #cdcdc9)',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '12px',
              color: 'var(--color-ink, #26251e)',
              width: '100%',
              maxWidth: '300px',
            }}
          />
        </div>
      </div>

      {/* Contenedor de la Tabla Auditable */}
      <div
        style={{
          overflowX: 'auto',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--color-linen, #e6e5e0)', borderBottom: '1px solid var(--color-stone, #cdcdc9)' }}>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)' }}>Fecha / Hora</th>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)' }}>Tipo de Asiento</th>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)' }}>Detalle / Proyecto</th>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)', textAlign: 'right' }}>
                Minutos Δ
              </th>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)', textAlign: 'right' }}>
                Importe USD
              </th>
              <th style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-ink, #26251e)', textAlign: 'right' }}>
                Saldo Restante
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--color-driftwood, #84847e)' }}>
                  {isLoading ? 'Cargando transacciones...' : 'No hay registros contables en este periodo.'}
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const typeMeta = ENTRY_TYPE_LABELS[item.entryType] ?? {
                  label: item.entryType,
                  color: 'var(--color-ink, #26251e)',
                };
                const isNegative = item.minutesDelta.startsWith('-');
                return (
                  <tr
                    key={item.id}
                    style={{ borderBottom: '1px solid color-mix(in oklab, #26251e 6%, transparent)' }}
                  >
                    <td
                      style={{
                        padding: '10px 12px',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          backgroundColor: 'var(--color-linen, #e6e5e0)',
                          color: typeMeta.color,
                          fontWeight: 500,
                        }}
                      >
                        {typeMeta.label}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-ink, #26251e)' }}>
                      <span>{item.description}</span>
                      {item.projectName && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: '11px',
                            color: 'var(--color-driftwood, #84847e)',
                            fontFamily: 'var(--font-berkeleymono, monospace)',
                          }}
                        >
                          Proyecto: {item.projectName}
                        </span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '10px 12px',
                        textAlign: 'right',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 500,
                        color: isNegative ? 'var(--color-crimson, #cf2d56)' : 'var(--color-forest, #34785c)',
                      }}
                    >
                      {item.minutesDelta} min
                    </td>
                    <td
                      style={{
                        padding: '10px 12px',
                        textAlign: 'right',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--color-ink, #26251e)',
                      }}
                    >
                      ${item.costDeltaUsd}
                    </td>
                    <td
                      style={{
                        padding: '10px 12px',
                        textAlign: 'right',
                        fontFamily: 'var(--font-berkeleymono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--color-driftwood, #84847e)',
                      }}
                    >
                      {item.runningBalanceMinutes} min
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
