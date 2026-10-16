/**
 * @archivo src/shared/kernel/decimal.util.ts
 * @modulo 00-kernel (Aritmetica Decimal Fija a 6 Decimales para Dinero y Minutos)
 * @proposito
 *   Implementa `DecimalMath`, el unico motor autorizado para calcular dinero y minutos en la
 *   plataforma. Toda la aritmetica se realiza sobre enteros escalados con `BigInt` a 6
 *   decimales (`1 unidad = 1_000_000 micros`), de modo que queda terminantemente prohibido
 *   usar los operadores flotantes `+`, `-`, `*` y `/` sobre valores monetarios o de consumo:
 *   un error de redondeo de coma flotante en la deduccion por minuto de voz produce cobros
 *   incorrectos y descuadres en el libro mayor inmutable.
 *
 * @resumen_contenido
 *   - Constante `FIXED6_SCALE` y tipo `Fixed6String` (cadena canonica de 6 decimales).
 *   - Entrada/Salida: `parseFixed6()`, `fromNumber()`, `formatFixed6()`, `sumFixed6()`,
 *     `compareFixed6()`, `maxFixed6()`, `clampNonNegative()`.
 *   - Consumo y minutos: `secondsToMinutesFixed6()`, `multiplyUnitsByRate()`,
 *     `subtractMinutesClamped()`.
 *   - Tarificacion: `applyCompoundDiscount()`, `calculateCompoundedRate()`,
 *     `roundUsdToCents()`, `exceedsUsdCap()`.
 *
 * @dependencias_internas
 *   - `ValidationError` (`./result-and-errors.ts`) para entradas con formato invalido.
 *
 * @dependencias_externas
 *   - Ninguna (Aritmetica entera nativa con `BigInt`: cero dependencias y cero redondeo binario).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `usage_ledger` (`minutes_delta`, `unit_rate_usd`, `amount_usd_delta`).
 *   - PostgreSQL: `whop_subscriptions` (Cuotas, saldos de credito y consumos acumulados).
 *   - Redis: `org:<id>:billing` (Saldos serializados con el formato canonico de 6 decimales).
 */

import { ValidationError } from './result-and-errors';

/** Escala oficial de la plataforma: 6 decimales, es decir 1 unidad = 1.000.000 micros. */
export const FIXED6_SCALE = 1_000_000;

/** Factor de escala como `BigInt`, usado en todas las operaciones internas. */
const SCALE_BIGINT = BigInt(FIXED6_SCALE);

/** Patron aceptado por `parseFixed6()`: signo opcional, parte entera y hasta 6 decimales. */
const FIXED6_PATTERN = /^([+-]?)(\d+)(?:\.(\d{1,6}))?$/u;

/** Cadena canonica que representa un valor decimal fijo de 6 decimales. */
export type Fixed6String = string;

/** Cadena canonica que representa un monto en dolares con 6 decimales. */
export type UsdAmountFixed6 = string;

/**
 * Convierte un valor entero de micros a su representacion canonica de 6 decimales.
 *
 * @param micros - Valor entero escalado a 6 decimales.
 * @returns Cadena canonica con signo y exactamente 6 decimales.
 */
function microsToFixed6(micros: bigint): Fixed6String {
  const isNegative = micros < 0n;
  const absolute = isNegative ? -micros : micros;
  const integerPart = absolute / SCALE_BIGINT;
  const fractionalPart = (absolute % SCALE_BIGINT).toString().padStart(6, '0');
  return `${isNegative ? '-' : ''}${integerPart.toString()}.${fractionalPart}`;
}

/**
 * Convierte una cadena decimal canonica a micros enteros, rechazando formatos invalidos.
 *
 * @param value - Cadena decimal con hasta 6 decimales (por ejemplo `12.5` o `-0.000001`).
 * @param label - Nombre del parametro, usado en el mensaje de error en espanol.
 * @returns Valor entero escalado a 6 decimales.
 * @throws ValidationError cuando la cadena no respeta el formato decimal permitido.
 */
export function parseFixed6(value: Fixed6String, label: string = 'valor'): bigint {
  const match = FIXED6_PATTERN.exec(value.trim());
  if (match === null) {
    throw new ValidationError(`El ${label} debe ser una cadena decimal con hasta 6 decimales; se recibio "${value}".`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = match[2] ?? '0';
  const fractionalPart = (match[3] ?? '').padEnd(6, '0');
  return sign * (BigInt(integerPart) * SCALE_BIGINT + BigInt(fractionalPart));
}

/**
 * Convierte un numero JavaScript a la representacion decimal fija de 6 decimales.
 * El redondeo es bancario hacia el valor mas cercano y, en caso de empate, alejandose de cero.
 * Se usa exclusivamente en los bordes del sistema (entradas de configuracion o semillas);
 * una vez dentro del dominio, todos los valores viajan como cadenas canonicas.
 *
 * @param value - Numero finito a convertir.
 * @param label - Nombre del parametro, usado en el mensaje de error.
 * @returns Cadena canonica de 6 decimales.
 * @throws ValidationError cuando el numero no es finito.
 */
export function fromNumber(value: number, label: string = 'valor'): Fixed6String {
  if (!Number.isFinite(value)) {
    throw new ValidationError(`El ${label} debe ser un numero finito; se recibio "${String(value)}".`);
  }
  const scaled = Math.round(Math.abs(value) * FIXED6_SCALE);
  const micros = BigInt(scaled) * (value < 0 ? -1n : 1n);
  return microsToFixed6(micros);
}

/**
 * Formatea un valor canonico de 6 decimales garantizando exactamente 6 cifras decimales.
 *
 * @param value - Cadena decimal con hasta 6 decimales.
 * @param label - Nombre del parametro, usado en el mensaje de error.
 * @returns Cadena canonica normalizada.
 */
export function formatFixed6(value: Fixed6String, label: string = 'valor'): Fixed6String {
  return microsToFixed6(parseFixed6(value, label));
}

/**
 * Suma una lista de valores decimales fijos sin perdida de precision.
 *
 * @param values - Valores a sumar en formato decimal de 6 decimales.
 * @returns Cadena canonica con la suma total (positiva, negativa o cero).
 */
export function sumFixed6(values: readonly Fixed6String[]): Fixed6String {
  const totalMicros = values.reduce<bigint>((accumulator, value) => accumulator + parseFixed6(value), 0n);
  return microsToFixed6(totalMicros);
}

/**
 * Compara dos valores decimales fijos: `-1` si el primero es menor, `0` si son iguales y
 * `1` si el primero es mayor.
 *
 * @param left - Primer valor a comparar.
 * @param right - Segundo valor a comparar.
 * @returns Resultado de la comparacion como entero.
 */
export function compareFixed6(left: Fixed6String, right: Fixed6String): -1 | 0 | 1 {
  const leftMicros = parseFixed6(left, 'valor izquierdo');
  const rightMicros = parseFixed6(right, 'valor derecho');
  if (leftMicros === rightMicros) {
    return 0;
  }
  return leftMicros < rightMicros ? -1 : 1;
}

/**
 * Devuelve el mayor de dos valores decimales fijos.
 *
 * @param left - Primer valor candidato.
 * @param right - Segundo valor candidato.
 * @returns El mayor de los dos valores.
 */
export function maxFixed6(left: Fixed6String, right: Fixed6String): Fixed6String {
  return compareFixed6(left, right) >= 0 ? formatFixed6(left, 'valor izquierdo') : formatFixed6(right, 'valor derecho');
}

/**
 * Fuerza un valor decimal fijo a no ser negativo, elevando a cero cualquier cantidad menor.
 *
 * @param value - Valor a acotar.
 * @returns El valor original si es cero o positivo, o `0.000000` en caso contrario.
 */
export function clampNonNegative(value: Fixed6String): Fixed6String {
  const micros = parseFixed6(value);
  return micros < 0n ? '0.000000' : microsToFixed6(micros);
}

/**
 * Convierte una cantidad de segundos facturables a minutos con precision de 6 decimales.
 * `secondsMicros` ya viaja escalado a 6 decimales, de modo que basta con dividir entre 60 para
 * obtener los micro-minutos: un segundo produce `16.666666` micro-minutos, es decir
 * `0.016666` minutos. La division trunca hacia cero de forma deliberada para no sobre-facturar
 * nunca al cliente por efecto del redondeo.
 *
 * @param seconds - Segundos consumidos, aceptados como numero o cadena decimal.
 * @returns Minutos canonico de 6 decimales.
 * @throws ValidationError cuando los segundos son negativos o no respetan el formato decimal.
 */
export function secondsToMinutesFixed6(seconds: number | string): Fixed6String {
  const secondsMicros = typeof seconds === 'number' ? parseFixed6(fromNumber(seconds, 'segundos')) : parseFixed6(seconds, 'segundos');
  if (secondsMicros < 0n) {
    throw new ValidationError('Los segundos consumidos no pueden ser negativos.');
  }
  const minuteMicros = secondsMicros / 60n;
  return microsToFixed6(minuteMicros);
}

/**
 * Multiplica una cantidad de unidades (minutos o creditos) por una tarifa unitaria.
 * Ambas magnitudes comparten escala de 6 decimales, por lo que el producto se reescala una
 * sola vez al final para conservar la precision completa del calculo intermedio.
 *
 * @param units - Cantidad de unidades consumidas, en formato decimal fijo.
 * @param unitRate - Tarifa por unidad, en formato decimal fijo.
 * @returns Producto canonico de 6 decimales.
 */
export function multiplyUnitsByRate(units: Fixed6String, unitRate: Fixed6String): Fixed6String {
  const unitsMicros = parseFixed6(units, 'unidades');
  const rateMicros = parseFixed6(unitRate, 'tarifa unitaria');
  const productMicros = (unitsMicros * rateMicros) / SCALE_BIGINT;
  return microsToFixed6(productMicros);
}

/**
 * Resta un consumo de minutos contra el saldo disponible, desglosando la parte cubierta y la
 * parte que excede la cuota. Prohibido realizar esta operacion con aritmetica flotante: el
 * resultado alimenta directamente el libro mayor inmutable `usage_ledger`.
 *
 * @param availableMinutes - Minutos disponibles en la cuota del periodo.
 * @param deltaMinutes - Minutos consumidos por el pulso de facturacion.
 * @returns Desglose con saldo restante, minutos cubiertos y minutos que exceden la cuota.
 * @throws ValidationError cuando el consumo es negativo o el saldo disponible no es valido.
 */
export function subtractMinutesClamped(
  availableMinutes: Fixed6String,
  deltaMinutes: Fixed6String
): { readonly remaining: Fixed6String; readonly covered: Fixed6String; readonly uncoveredOverage: Fixed6String } {
  const availableMicros = parseFixed6(availableMinutes, 'minutos disponibles');
  const deltaMicros = parseFixed6(deltaMinutes, 'minutos consumidos');

  if (deltaMicros < 0n) {
    throw new ValidationError('El consumo de minutos no puede ser negativo.');
  }

  const usableMicros = availableMicros > 0n ? availableMicros : 0n;
  const coveredMicros = deltaMicros <= usableMicros ? deltaMicros : usableMicros;
  const uncoveredMicros = deltaMicros - coveredMicros;
  const remainingMicros = usableMicros - coveredMicros;

  return {
    remaining: microsToFixed6(remainingMicros),
    covered: microsToFixed6(coveredMicros),
    uncoveredOverage: microsToFixed6(uncoveredMicros),
  };
}

/**
 * Aplica descuentos porcentuales compuestos sobre un precio base.
 * Los descuentos se aplican de forma multiplicativa (nunca sumando porcentajes), de modo que
 * un descuento por volumen del 10% y un descuento manual del 5% producen un 14,5% efectivo y
 * jamas un 15%. Los porcentajes se acotan al rango [0, 100] para impedir precios negativos.
 *
 * @param baseAmount - Precio o tarifa base en formato decimal fijo.
 * @param discountPercentages - Porcentajes de descuento a componer, en formato decimal fijo.
 * @returns Precio resultante con los descuentos ya compuestos.
 */
export function applyCompoundDiscount(baseAmount: Fixed6String, discountPercentages: readonly Fixed6String[]): Fixed6String {
  const baseMicros = parseFixed6(baseAmount, 'importe base');
  let resultMicros = baseMicros;

  for (const percentage of discountPercentages) {
    const percentageMicros = parseFixed6(percentage, 'porcentaje de descuento');
    const boundedMicros = percentageMicros < 0n ? 0n : percentageMicros > 100n * SCALE_BIGINT ? 100n * SCALE_BIGINT : percentageMicros;
    // El porcentaje ya viene escalado a 6 decimales (10% se representa como 10.000000 micros),
    // por lo que el factor de retencion debe calcularse en la MISMA escala: 100% - 10% = 90%.
    const retentionMicros = 100n * SCALE_BIGINT - boundedMicros;
    resultMicros = (resultMicros * retentionMicros) / (100n * SCALE_BIGINT);
  }

  return microsToFixed6(resultMicros);
}

/**
 * Calcula la tarifa efectiva por minuto aplicando en orden de precedencia:
 * 1) tarifa base del plan activo, 2) tramo de descuento por volumen alcanzado y
 * 3) descuento manual otorgado por el SuperAdmin a la organizacion.
 *
 * @param baseRatePerMinuteUsd - Tarifa base del plan, en USD por minuto.
 * @param volumeDiscountPercent - Descuento por volumen alcanzado, en porcentaje.
 * @param manualDiscountPercent - Descuento manual vigente de la organizacion, en porcentaje.
 * @returns Tarifa efectiva por minuto en USD con 6 decimales.
 */
export function calculateCompoundedRate(
  baseRatePerMinuteUsd: UsdAmountFixed6,
  volumeDiscountPercent: Fixed6String,
  manualDiscountPercent: Fixed6String
): UsdAmountFixed6 {
  return applyCompoundDiscount(baseRatePerMinuteUsd, [volumeDiscountPercent, manualDiscountPercent]);
}

/**
 * Redondea un monto en USD a centavos, que es la unidad minima que acepta la pasarela de
 * cobros. El redondeo es hacia el centavo mas cercano y nunca produce montos negativos.
 *
 * @param amountUsd - Monto en USD con 6 decimales.
 * @returns Monto redondeado a centavos, con 6 decimales y dos cifras significativas.
 */
export function roundUsdToCents(amountUsd: UsdAmountFixed6): UsdAmountFixed6 {
  const micros = parseFixed6(amountUsd, 'monto en USD');
  const nonNegativeMicros = micros < 0n ? 0n : micros;
  const cents = (nonNegativeMicros + 5_000n) / 10_000n;
  return microsToFixed6(cents * 10_000n);
}

/**
 * Determina si un monto acumulado supera un tope de gasto duro configurado.
 * Un tope nulo desactiva la validacion y devuelve `false`.
 *
 * @param accumulatedUsd - Monto acumulado en el periodo actual.
 * @param hardSpendCapUsd - Tope de gasto duro, o `null` cuando no existe limite.
 * @returns `true` cuando el monto acumulado alcanza o excede el tope configurado.
 */
export function exceedsUsdCap(accumulatedUsd: UsdAmountFixed6, hardSpendCapUsd: UsdAmountFixed6 | null): boolean {
  if (hardSpendCapUsd === null) {
    return false;
  }
  return compareFixed6(accumulatedUsd, hardSpendCapUsd) >= 0;
}

/** Espacio de nombres con la fachada publica de aritmetica decimal fija de la plataforma. */
export const DecimalMath = Object.freeze({
  FIXED6_SCALE,
  parseFixed6,
  fromNumber,
  formatFixed6,
  sumFixed6,
  compareFixed6,
  maxFixed6,
  clampNonNegative,
  secondsToMinutesFixed6,
  multiplyUnitsByRate,
  subtractMinutesClamped,
  applyCompoundDiscount,
  calculateCompoundedRate,
  roundUsdToCents,
  exceedsUsdCap,
});
