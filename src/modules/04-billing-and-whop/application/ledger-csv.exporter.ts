/**
 * @archivo src/modules/04-billing-and-whop/application/ledger-csv.exporter.ts
 * @modulo 04-billing-and-whop (Exportacion Contable del Libro Mayor en Formato CSV)
 * @proposito
 *   Convierte los asientos del libro mayor en un documento CSV que el area contable del cliente
 *   puede abrir directamente en su hoja de calculo. Ademas de dar formato, protege contra la
 *   inyeccion de formulas: un asiento cuyo texto comience por `=`, `+`, `-`, `@` o un caracter de
 *   control se prefija con una comilla simple, porque de lo contrario la hoja de calculo lo
 *   interpretaria como una formula ejecutable al abrir el archivo, un vector de ataque real cuando
 *   el documento circula entre terceros. Se incluye la marca de orden de bytes UTF-8 para que los
 *   acentos de los conceptos contables en espanol no se corrompan.
 *
 * @resumen_contenido
 *   - Constante `SPREADSHEET_FORMULA_PREFIXES` y `CSV_COLUMN_HEADER`.
 *   - Funcion `escapeCsvCell()`: Neutralizacion de formulas y comillado correcto.
 *   - Funcion `buildLedgerCsvDocument()`: Documento completo con encabezado y filas.
 *   - Funcion `buildLedgerExportFileName()`: Nombre de archivo saneado.
 *   - Funcion `summarizeLedgerExport()`: Totales del rango exportado.
 *
 * @dependencias_internas
 *   - `LedgerHistoryEntry` (`../infrastructure/postgres-billing.repository.ts`).
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`) para los totales exactos.
 *
 * @dependencias_externas
 *   - Ninguna (Transformacion pura de datos: no accede a base de datos ni a red).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `usage_ledger` (Los asientos exportados provienen de esta tabla append-only).
 */

import { DecimalMath, type Fixed6String, type UsdAmountFixed6 } from '../../../shared/kernel/decimal.util';
import type { LedgerHistoryEntry } from '../infrastructure/postgres-billing.repository';

/**
 * Prefijos que una hoja de calculo interpreta como inicio de formula.
 * El tabulador y el retorno de carro se incluyen porque algunas versiones los ignoran al evaluar
 * la primera celda de una fila y ejecutan igualmente el contenido siguiente.
 */
const SPREADSHEET_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/** Encabezado canonico del documento contable exportable. */
const CSV_COLUMN_HEADER = [
  'asiento_id',
  'fecha_utc',
  'tipo_asiento',
  'proyecto_id',
  'sesion_voz_id',
  'minutos_delta',
  'tarifa_usd_minuto',
  'descuento_pct',
  'importe_usd',
  'minutos_incluidos_restantes',
  'saldo_usd_restante',
].join(',');

/** Totales consolidados del rango exportado. */
export interface LedgerExportTotals {
  /** Numero de asientos incluidos en la exportacion. */
  readonly rowCount: number;
  /** Importe total facturado en el rango. */
  readonly totalBilledUsd: UsdAmountFixed6;
  /** Minutos totales consumidos por sesiones de voz en el rango. */
  readonly totalConsumedMinutes: Fixed6String;
}

/**
 * Escapa una celda CSV neutralizando la inyeccion de formulas.
 *
 * @param rawValue - Valor crudo de la celda.
 * @returns Celda escapada y comillada cuando contiene separadores, comillas o formulas.
 */
export function escapeCsvCell(rawValue: string): string {
  const needsFormulaShield = SPREADSHEET_FORMULA_PREFIXES.some((prefix) => rawValue.startsWith(prefix));
  const shielded = needsFormulaShield ? `'${rawValue}` : rawValue;
  const needsQuoting = /[",\n\r;]/u.test(shielded);
  return needsQuoting ? `"${shielded.replace(/"/gu, '""')}"` : shielded;
}

/**
 * Compone el documento CSV completo a partir de los asientos del periodo.
 *
 * @param entries - Asientos a exportar, en orden cronologico.
 * @returns Documento CSV con marca UTF-8, encabezado y filas.
 */
export function buildLedgerCsvDocument(entries: readonly LedgerHistoryEntry[]): string {
  const rows = entries.map((entry) =>
    [
      escapeCsvCell(entry.ledgerEntryId),
      escapeCsvCell(entry.createdAtIso),
      escapeCsvCell(entry.entryType),
      escapeCsvCell(entry.projectId ?? ''),
      escapeCsvCell(entry.voiceSessionId ?? ''),
      escapeCsvCell(entry.minutesDelta),
      escapeCsvCell(entry.unitRateUsd),
      escapeCsvCell(entry.discountAppliedPercent),
      escapeCsvCell(entry.amountUsdDelta),
      escapeCsvCell(entry.includedMinutesBalanceAfter),
      escapeCsvCell(entry.creditBalanceUsdAfter),
    ].join(',')
  );

  // El terminador CRLF es el que exige el estandar CSV y el que esperan las hojas de calculo.
  return `\uFEFF${[CSV_COLUMN_HEADER, ...rows].join('\r\n')}\r\n`;
}

/**
 * Construye el nombre del archivo de exportacion a partir del rango exportado.
 *
 * @param rangeStartIso - Inicio del rango en formato ISO 8601.
 * @param rangeEndIso - Fin del rango en formato ISO 8601.
 * @returns Nombre de archivo saneado y estable.
 */
export function buildLedgerExportFileName(rangeStartIso: string, rangeEndIso: string): string {
  return `consumo-${rangeStartIso.slice(0, 10)}_a_${rangeEndIso.slice(0, 10)}.csv`;
}

/**
 * Consolida los totales del rango exportado.
 * Los minutos consumidos solo cuentan los asientos de consumo de voz, no las recargas ni los
 * otorgamientos, para que el total refleje el uso real del servicio.
 *
 * @param entries - Asientos incluidos en la exportacion.
 * @returns Totales de filas, importe y minutos consumidos.
 */
export function summarizeLedgerExport(entries: readonly LedgerHistoryEntry[]): LedgerExportTotals {
  let totalBilledMicros = 0n;
  let totalConsumedMicros = 0n;

  for (const entry of entries) {
    totalBilledMicros += DecimalMath.parseFixed6(entry.amountUsdDelta, 'importe del asiento');
    if (entry.entryType === 'VOICE_MINUTE_DEDUCTION') {
      // El asiento registra el consumo como variacion negativa; el total consumido es su magnitud.
      totalConsumedMicros += -DecimalMath.parseFixed6(entry.minutesDelta, 'minutos del asiento');
    }
  }

  return Object.freeze({
    rowCount: entries.length,
    totalBilledUsd: DecimalMath.formatFixed6(microsToFixed6(totalBilledMicros), 'total facturado'),
    totalConsumedMinutes: DecimalMath.formatFixed6(microsToFixed6(totalConsumedMicros), 'total consumido'),
  });
}

/**
 * Convierte micro-unidades enteras a la representacion decimal canonica de 6 cifras.
 *
 * @param micros - Cantidad en millonésimas de unidad.
 * @returns Cadena decimal canonica de 6 cifras.
 */
function microsToFixed6(micros: bigint): Fixed6String {
  const scale = BigInt(DecimalMath.FIXED6_SCALE);
  const isNegative = micros < 0n;
  const absoluteMicros = isNegative ? -micros : micros;
  const whole = absoluteMicros / scale;
  const fraction = absoluteMicros % scale;
  return `${isNegative ? '-' : ''}${whole}.${fraction.toString().padStart(6, '0')}`;
}
