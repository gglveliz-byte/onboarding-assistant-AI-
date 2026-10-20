/**
 * @archivo src/modules/04-billing-and-whop/domain/whop-fee.util.ts
 * @modulo 04-billing-and-whop (Traslado de la Comision de la Pasarela al Precio de Lista)
 * @proposito
 *   La pasarela descuenta de cada cobro una comision porcentual mas un fijo por transaccion, de modo
 *   que el importe que liquida en el panel de la empresa es MENOR que el precio que pago el cliente.
 *   El requisito de negocio es que el NETO que llega a la empresa sea exactamente el precio de lista
 *   del plan, asi que el precio que ve el cliente debe calcularse hacia atras a partir del neto
 *   objetivo. Este archivo concentra esa aritmetica en dos funciones puras para que el calculo no
 *   quede repartido entre el alta de planes, el checkout y el libro mayor.
 *
 *   El redondeo se hace SIEMPRE hacia arriba al centavo: redondear hacia abajo dejaria un neto
 *   inferior al precio de lista y volveria a abrir el agujero que esta regla cierra. La consecuencia
 *   aceptada es que el neto puede exceder el objetivo en menos de un centavo.
 *
 * @resumen_contenido
 *   - Constantes `MICROS_PER_CENT` y `SCALE_ONE`.
 *   - Interface `PlatformFeeConfig`: Porcentaje y fijo de la comision de la pasarela.
 *   - Funcion `computeGrossPriceUsd()`: Precio bruto a cobrar a partir del neto objetivo.
 *   - Funcion `computeNetFromGrossUsd()`: Neto que liquida la pasarela dado un precio bruto.
 *   - Funcion `assertFeeConfigSane()`: Rechazo de configuraciones de comision imposibles.
 *
 * @dependencias_internas
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`): unica fuente de aritmetica decimal fija.
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Calculo puro, sin persistencia).
 */

import { DecimalMath, type Fixed6String, type UsdAmountFixed6 } from '../../../shared/kernel/decimal.util';

/** Micros de la escala Fixed6 que equivalen a un centavo de dolar (USD usa 2 decimales). */
const MICROS_PER_CENT = 10_000n;

/** Representacion Fixed6 de la unidad, denominador del porcentaje. */
const SCALE_ONE = 1_000_000n;

/** Comision de la pasarela: un porcentaje sobre el bruto mas un fijo por transaccion. */
export interface PlatformFeeConfig {
  /** Comision porcentual en tanto por uno (`0.035` = 3.5%). */
  readonly percent: Fixed6String;
  /** Comision fija por transaccion en USD. */
  readonly fixedUsd: Fixed6String;
}

/**
 * Convierte una cantidad en micros Fixed6 a su cadena decimal canonica de 6 cifras.
 * `DecimalMath` expone la entrada (`parseFixed6`) pero no esta salida, y el kernel no debe tocarse
 * por un helper de un solo modulo, asi que se resuelve aqui con aritmetica de enteros exactos.
 *
 * @param micros - Cantidad en unidades de 1e-6.
 * @returns Cadena decimal con exactamente 6 cifras fraccionarias.
 */
function microsToFixed6(micros: bigint): Fixed6String {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const integerPart = absolute / SCALE_ONE;
  const fractionalPart = (absolute % SCALE_ONE).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${integerPart}.${fractionalPart}`;
}

/**
 * Valida que una configuracion de comision sea operable.
 * Un porcentaje igual o superior al 100% no tiene inversa: el neto jamas podria obtenerse de ningun
 * bruto, y un valor negativo regalarias dinero en cada cobro.
 *
 * @param fee - Configuracion declarada por el entorno.
 * @throws RangeError cuando el porcentaje esta fuera del rango admitido o el fijo es negativo.
 */
export function assertFeeConfigSane(fee: PlatformFeeConfig): void {
  const percentMicros = DecimalMath.parseFixed6(fee.percent, 'comision porcentual');
  const fixedMicros = DecimalMath.parseFixed6(fee.fixedUsd, 'comision fija');
  if (percentMicros < 0n || percentMicros >= SCALE_ONE) {
    throw new RangeError(`La comision porcentual de la pasarela debe estar en [0, 1): recibido ${fee.percent}.`);
  }
  if (fixedMicros < 0n) {
    throw new RangeError(`La comision fija de la pasarela no puede ser negativa: recibido ${fee.fixedUsd}.`);
  }
}

/**
 * Calcula el precio BRUTO que debe pagar el cliente para que la empresa reciba un NETO exacto.
 *
 * Despeje: `neto = bruto - bruto * porcentaje - fijo`, luego `bruto = (neto + fijo) / (1 - porcentaje)`.
 * El resultado se redondea hacia arriba al centavo mas cercano.
 *
 * @param netTargetUsd - Importe que la empresa quiere liquidar en su panel (precio de lista).
 * @param fee - Comision de la pasarela aplicada a la transaccion.
 * @returns Precio bruto en USD con 6 decimales, listo para registrar como `initial_price`.
 * @throws RangeError cuando la configuracion de comision es imposible.
 */
export function computeGrossPriceUsd(netTargetUsd: Fixed6String, fee: PlatformFeeConfig): UsdAmountFixed6 {
  assertFeeConfigSane(fee);

  const netMicros = DecimalMath.parseFixed6(netTargetUsd, 'neto objetivo');
  if (netMicros < 0n) {
    throw new RangeError(`El neto objetivo de un plan no puede ser negativo: recibido ${netTargetUsd}.`);
  }

  const percentMicros = DecimalMath.parseFixed6(fee.percent, 'comision porcentual');
  const fixedMicros = DecimalMath.parseFixed6(fee.fixedUsd, 'comision fija');
  const denominator = SCALE_ONE - percentMicros;

  // Multiplicar por la escala antes de dividir preserva los decimales de la fraccion.
  const rawGrossMicros = ((netMicros + fixedMicros) * SCALE_ONE + denominator - 1n) / denominator;
  const centsUp = (rawGrossMicros + MICROS_PER_CENT - 1n) / MICROS_PER_CENT;
  return microsToFixed6(centsUp * MICROS_PER_CENT);
}

/**
 * Calcula el NETO que liquida la pasarela dado un precio BRUTO, para conciliar el panel con la
 * tarjeta de pago. Se expone porque el asiento contable del libro mayor debe registrar el neto real
 * esperado, no el importe bruto que figuro en el checkout.
 *
 * @param grossUsd - Importe efectivamente cobrado al cliente.
 * @param fee - Comision de la pasarela aplicada a la transaccion.
 * @returns Neto esperado en USD con 6 decimales (puede quedar en menos de un centavo de exactitud).
 */
export function computeNetFromGrossUsd(grossUsd: Fixed6String, fee: PlatformFeeConfig): UsdAmountFixed6 {
  assertFeeConfigSane(fee);

  const grossMicros = DecimalMath.parseFixed6(grossUsd, 'importe bruto');
  const nonNegativeGross = grossMicros < 0n ? 0n : grossMicros;
  const percentMicros = DecimalMath.parseFixed6(fee.percent, 'comision porcentual');
  const fixedMicros = DecimalMath.parseFixed6(fee.fixedUsd, 'comision fija');

  const feeFromPercent = (nonNegativeGross * percentMicros) / SCALE_ONE;
  const netMicros = nonNegativeGross - feeFromPercent - fixedMicros;
  return microsToFixed6(netMicros < 0n ? 0n : netMicros);
}
