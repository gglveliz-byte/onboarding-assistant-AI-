/**
 * @archivo src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case.ts
 * @modulo 04-billing-and-whop (Consultas del Panel de Consumo y Exportacion Contable)
 * @proposito
 *   Alimenta el Panel de Consumo del Desarrollador con una instantanea completa de la situacion
 *   economica de la organizacion: plan vigente, minutos restantes, tramo de descuento alcanzado,
 *   topes de gasto configurados e historial paginado del libro mayor. Ademas genera la exportacion
 *   contable en formato CSV con proteccion contra inyeccion de formulas: un asiento cuyo texto
 *   empiece por `=`, `+`, `-` o `@` se neutraliza, porque una hoja de calculo lo interpretaria como
 *   una formula ejecutable y eso es un vector de ataque real cuando el archivo lo abre un tercero.
 *
 * @resumen_contenido
 *   - Constantes `MAX_LEDGER_PAGE_SIZE`, `DEFAULT_LEDGER_PAGE_SIZE` y `SPREADSHEET_FORMULA_PREFIXES`.
 *   - Interfaces `BillingConsumptionSnapshot` y `LedgerExportResult`.
 *   - Clase `BillingDashboardQueriesUseCase`:
 *       * `getConsumptionSnapshot()`: Instantanea completa del consumo del periodo.
 *       * `getLedgerHistory()`: Historial paginado del libro mayor.
 *       * `exportLedgerCsv()`: Exportacion contable del periodo en CSV.
 *       * `calculateSuggestedTopUpUsd()`: Recarga sugerida segun el ritmo de consumo.
 *       * `escapeCsvCell()`: Neutralizacion de formulas y comillado correcto.
 *
 * @dependencias_internas
 *   - `CalculateEffectiveRateUseCase` (`./calculate-effective-rate.use-case.ts`).
 *   - `BillingRepositoryPort` (`../infrastructure/postgres-billing.repository.ts`).
 *   - `DecimalMath` (`src/shared/kernel/decimal.util.ts`).
 *   - `NotFoundError`, `ValidationError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Nucleo de aplicacion puro: lee a traves del puerto del repositorio inyectado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `pricing_plans_config` y
 *     `organization_pricing_overrides` (Lectura bajo RLS con contexto de tenant).
 */

import { DecimalMath, type Fixed6String, type UsdAmountFixed6 } from '../../../shared/kernel/decimal.util';
import { NotFoundError, ValidationError } from '../../../shared/kernel/result-and-errors';
import type { BillingPlanCode, WhopSubscriptionStatus } from '../domain/billing-whop.types';
import type { BillingRepositoryPort, LedgerHistoryEntry, LedgerHistoryPage } from '../infrastructure/postgres-billing.repository';
import { CalculateEffectiveRateUseCase } from './calculate-effective-rate.use-case';
import { ZERO_FIXED6, type CheckoutUseCaseDependencies } from './checkout-use-case.dependencies';
import { buildLedgerCsvDocument, buildLedgerExportFileName, summarizeLedgerExport } from './ledger-csv.exporter';

/** Numero maximo de asientos que admite una pagina del historial. */
export const MAX_LEDGER_PAGE_SIZE = 200;

/** Numero de asientos por pagina cuando el cliente no lo especifica. */
export const DEFAULT_LEDGER_PAGE_SIZE = 25;

/** Consumo mensual de referencia usado para sugerir una recarga cuando el saldo se agota. */
const SUGGESTED_TOP_UP_REFERENCE_USD: UsdAmountFixed6 = '25.000000';

/** Instantanea completa del consumo de la organizacion en el periodo vigente. */
export interface BillingConsumptionSnapshot {
  /** Plan contratado actualmente. */
  readonly planCode: BillingPlanCode;
  /** Estado del ciclo de vida de la suscripcion. */
  readonly status: WhopSubscriptionStatus;
  /** Minutos incluidos que otorga el plan en el periodo. */
  readonly includedMinutesQuota: Fixed6String;
  /** Minutos incluidos disponibles en este instante. */
  readonly includedMinutesRemaining: Fixed6String;
  /** Minutos incluidos ya consumidos en el periodo. */
  readonly includedMinutesConsumed: Fixed6String;
  /** Porcentaje del cupo incluido ya consumido, util para la barra de progreso del panel. */
  readonly includedMinutesConsumedPercent: Fixed6String;
  /** Minutos de exceso acumulados en el periodo. */
  readonly overageMinutesUsed: Fixed6String;
  /** Importe facturado por exceso en el periodo. */
  readonly overageBilledUsd: UsdAmountFixed6;
  /** Tarifa efectiva por minuto aplicable en este instante. */
  readonly effectiveRatePerMinuteUsd: UsdAmountFixed6;
  /** Tarifa base antes de descuentos. */
  readonly baseRatePerMinuteUsd: UsdAmountFixed6;
  /** Porcentaje del tramo de descuento por volumen alcanzado. */
  readonly volumeDiscountPercent: Fixed6String;
  /** Numero del tramo alcanzado, o `null` si no aplica. */
  readonly appliedTierNumber: number | null;
  /** Porcentaje del descuento manual otorgado por el operador. */
  readonly manualDiscountPercent: Fixed6String;
  /** Descuento total efectivo que percibe la organizacion. */
  readonly totalDiscountPercent: Fixed6String;
  /** Saldo prepagado disponible. */
  readonly creditBalanceUsd: UsdAmountFixed6;
  /** Tope de gasto duro del periodo, o `null` cuando no se configura. */
  readonly hardSpendCapUsd: UsdAmountFixed6 | null;
  /** Indica si la organizacion alcanzo su tope de gasto. */
  readonly hardSpendCapReached: boolean;
  /** Importe de la recarga sugerida cuando el saldo esta por agotarse. */
  readonly suggestedTopUpUsd: UsdAmountFixed6;
  /** Indica si la organizacion puede iniciar nuevas sesiones de voz. */
  readonly canStartSession: boolean;
  /** Motivo del bloqueo cuando no puede iniciar sesiones. */
  readonly blockedReason: string | null;
  /** Inicio del periodo vigente, en formato ISO 8601. */
  readonly currentPeriodStartIso: string;
  /** Fin del periodo vigente, en formato ISO 8601. */
  readonly currentPeriodEndIso: string;
}

/** Documento CSV generado y listo para entregar como descarga. */
export interface LedgerExportResult {
  /** Nombre de archivo sugerido, ya saneado para el sistema de archivos. */
  readonly fileName: string;
  /** Tipo de contenido HTTP del documento. */
  readonly contentType: string;
  /** Contenido CSV completo, con encabezado y filas. */
  readonly csvContent: string;
  /** Numero de asientos incluidos en la exportacion. */
  readonly rowCount: number;
  /** Importe total facturado en el rango exportado. */
  readonly totalBilledUsd: UsdAmountFixed6;
  /** Minutos totales consumidos en el rango exportado. */
  readonly totalConsumedMinutes: Fixed6String;
}

/**
 * Caso de uso de consultas del panel de consumo.
 * Es de solo lectura: jamas modifica saldos ni escribe asientos contables.
 */
export class BillingDashboardQueriesUseCase {
  private readonly dependencies: CheckoutUseCaseDependencies;
  private readonly rateCalculator: CalculateEffectiveRateUseCase;

  /**
   * @param dependencies - Repositorio, pasarela, Redis y verificador de DPA del modulo.
   * @param rateCalculator - Motor de tarificacion; se construye uno por omision.
   */
  public constructor(dependencies: CheckoutUseCaseDependencies, rateCalculator?: CalculateEffectiveRateUseCase) {
    this.dependencies = dependencies;
    this.rateCalculator = rateCalculator ?? new CalculateEffectiveRateUseCase();
  }

  /**
   * Construye la instantanea completa del consumo del periodo vigente.
   *
   * @param organizationId - Organizacion consultada.
   * @returns Instantanea lista para renderizar el panel de consumo.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  public async getConsumptionSnapshot(organizationId: string): Promise<BillingConsumptionSnapshot> {
    const subscription = await this.dependencies.billingRepository.findSubscription(organizationId);
    if (subscription === null) {
      throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
    }

    // El catalogo y el override se leen EN SERIE sobre conexiones independientes y liberadas: un
    // `Promise.all` tomaria dos conexiones simultaneas del pool por cada consulta del panel
    // (hallazgo C1-21). Ninguna de las dos retiene bloqueo, pero duplicarlas por snapshot agota el
    // pool igual bajo carga del panel.
    const planCatalog = await this.dependencies.billingRepository.getPlanCatalog();
    const override = await this.dependencies.billingRepository.getActivePricingOverride(organizationId);
    const plan = planCatalog[subscription.planCode];
    if (plan === undefined) {
      throw new NotFoundError(`plan de precios ${subscription.planCode}`);
    }

    const quote = this.rateCalculator.execute({
      subscription,
      plan,
      override,
      accumulatedOverageMinutes: subscription.periodOverageMinutesUsed,
    });
    const consumedMinutes = DecimalMath.sumFixed6([
      subscription.periodIncludedMinutesQuota,
      `-${subscription.periodIncludedMinutesRemaining}`,
    ]);
    const consumedPercent = this.calculateConsumedPercent(consumedMinutes, subscription.periodIncludedMinutesQuota);
    const capReached = subscription.hardSpendCapUsd !== null
      ? DecimalMath.compareFixed6(subscription.currentPeriodOverageBilledUsd, subscription.hardSpendCapUsd) >= 0
      : false;
    const canStartSession = this.resolveCanStartSession(
      subscription.planCode,
      subscription.periodIncludedMinutesRemaining,
      subscription.creditBalanceUsd,
      subscription.hardSpendCapUsd
    );
    const hasFunds = DecimalMath.compareFixed6(subscription.creditBalanceUsd, ZERO_FIXED6) > 0
      || DecimalMath.compareFixed6(subscription.periodIncludedMinutesRemaining, ZERO_FIXED6) > 0;

    return Object.freeze({
      planCode: subscription.planCode,
      status: subscription.status,
      includedMinutesQuota: subscription.periodIncludedMinutesQuota,
      includedMinutesRemaining: subscription.periodIncludedMinutesRemaining,
      includedMinutesConsumed: consumedMinutes,
      includedMinutesConsumedPercent: consumedPercent,
      overageMinutesUsed: subscription.periodOverageMinutesUsed,
      overageBilledUsd: subscription.currentPeriodOverageBilledUsd,
      effectiveRatePerMinuteUsd: quote.effectiveRatePerMinuteUsd,
      baseRatePerMinuteUsd: quote.baseRatePerMinuteUsd,
      volumeDiscountPercent: quote.volumeDiscountPercent,
      appliedTierNumber: quote.appliedTierNumber,
      manualDiscountPercent: quote.manualDiscountPercent,
      totalDiscountPercent: quote.totalDiscountPercent,
      creditBalanceUsd: subscription.creditBalanceUsd,
      hardSpendCapUsd: subscription.hardSpendCapUsd,
      hardSpendCapReached: capReached,
      suggestedTopUpUsd: this.calculateSuggestedTopUpUsd(subscription.creditBalanceUsd, hasFunds),
      canStartSession,
      blockedReason: canStartSession ? null : this.resolveBlockedReason(capReached, subscription.status),
      currentPeriodStartIso: subscription.currentPeriodStartIso,
      currentPeriodEndIso: subscription.currentPeriodEndIso,
    });
  }

  /**
   * Recupera una pagina del historial contable de la organizacion.
   *
   * @param organizationId - Organizacion consultada.
   * @param cursorIso - Marca temporal de continuacion; `null` para la primera pagina.
   * @param pageSize - Numero de asientos por pagina.
   * @returns Pagina del historial con su clave de continuacion.
   * @throws ValidationError cuando el tamano de pagina no es un entero positivo.
   */
  public async getLedgerHistory(organizationId: string, cursorIso: string | null, pageSize: number): Promise<LedgerHistoryPage> {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new ValidationError('El tamano de pagina del historial contable debe ser un entero positivo.');
    }
    if (cursorIso !== null && Number.isNaN(Date.parse(cursorIso))) {
      throw new ValidationError('La clave de continuacion del historial contable debe ser una marca ISO 8601 valida.');
    }

    return this.dependencies.billingRepository.readLedgerPage(
      organizationId,
      cursorIso,
      Math.min(pageSize, MAX_LEDGER_PAGE_SIZE)
    );
  }

  /**
   * Genera la exportacion contable del periodo vigente en formato CSV.
   *
   * @param organizationId - Organizacion consultada.
   * @returns Documento CSV con su nombre de archivo y sus totales.
   * @throws ValidationError cuando el rango temporal es invalido.
   */
  public async exportLedgerCsv(organizationId: string): Promise<LedgerExportResult> {
    const subscription = await this.dependencies.billingRepository.findSubscription(organizationId);
    if (subscription === null) {
      throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
    }

    const rangeStartIso = subscription.currentPeriodStartIso;
    const rangeEndIso = subscription.currentPeriodEndIso;
    if (Number.isNaN(Date.parse(rangeStartIso)) || Number.isNaN(Date.parse(rangeEndIso)) || Date.parse(rangeEndIso) <= Date.parse(rangeStartIso)) {
      throw new ValidationError('El periodo de facturacion vigente no delimita un rango temporal valido.');
    }

    const entries = await this.dependencies.billingRepository.exportLedgerEntries(organizationId, rangeStartIso, rangeEndIso);
    const exportTotals = summarizeLedgerExport(entries);

    return Object.freeze({
      fileName: buildLedgerExportFileName(rangeStartIso, rangeEndIso),
      contentType: 'text/csv; charset=utf-8',
      csvContent: buildLedgerCsvDocument(entries),
      rowCount: exportTotals.rowCount,
      totalBilledUsd: exportTotals.totalBilledUsd,
      totalConsumedMinutes: exportTotals.totalConsumedMinutes,
    });
  }

  /**
   * Sugiere el importe de recarga cuando el saldo prepagado esta por agotarse.
   * Con fondos suficientes no se sugiere nada: empujar una recarga innecesaria erosiona la
   * confianza del cliente y no aporta valor.
   *
   * @param creditBalanceUsd - Saldo prepagado actual.
   * @param hasFunds - Indica si la organizacion conserva minutos incluidos o saldo.
   * @returns Importe sugerido en USD; `0.000000` cuando no procede sugerir recarga.
   */
  public calculateSuggestedTopUpUsd(creditBalanceUsd: UsdAmountFixed6, hasFunds: boolean): UsdAmountFixed6 {
    if (hasFunds && DecimalMath.compareFixed6(creditBalanceUsd, ZERO_FIXED6) > 0) {
      return ZERO_FIXED6;
    }
    return SUGGESTED_TOP_UP_REFERENCE_USD;
  }
  /**
   * Calcula el porcentaje del cupo incluido ya consumido.
   * La division se hace en micro-unidades enteras porque el kernel no expone division decimal: el
   * resultado se acota al rango [0, 100] para que una cuota reducida a mitad de periodo no muestre
   * una barra de progreso superior al total.
   *
   * @param consumedMinutes - Minutos consumidos del cupo.
   * @param quotaMinutes - Cupo total del periodo.
   * @returns Porcentaje consumido acotado al rango [0, 100].
   */
  private calculateConsumedPercent(consumedMinutes: Fixed6String, quotaMinutes: Fixed6String): Fixed6String {
    const quotaMicros = DecimalMath.parseFixed6(quotaMinutes, 'cupo de minutos');
    if (quotaMicros <= 0n) {
      return ZERO_FIXED6;
    }

    const consumedMicros = DecimalMath.clampNonNegative(consumedMinutes);
    const consumedMicrosValue = DecimalMath.parseFixed6(consumedMicros, 'minutos consumidos');
    const percentageMicros = (consumedMicrosValue * 100n * BigInt(DecimalMath.FIXED6_SCALE)) / quotaMicros;
    const boundedMicros = percentageMicros > 100n * BigInt(DecimalMath.FIXED6_SCALE)
      ? 100n * BigInt(DecimalMath.FIXED6_SCALE)
      : percentageMicros;
    return DecimalMath.formatFixed6(this.microsToFixed6(boundedMicros), 'porcentaje consumido');
  }

  /**
   * Convierte micro-unidades enteras a la representacion decimal canonica de 6 cifras.
   *
   * @param micros - Cantidad en millonésimas de unidad.
   * @returns Cadena decimal canonica de 6 cifras.
   */
  private microsToFixed6(micros: bigint): Fixed6String {
    const scale = BigInt(DecimalMath.FIXED6_SCALE);
    const whole = micros / scale;
    const fraction = micros % scale;
    return `${whole}.${fraction.toString().padStart(6, '0')}`;
  }

  /**
   * Determina si la organizacion puede iniciar sesiones de voz segun sus saldos.
   * Un plan de suscripcion admite consumo por exceso mientras su estado sea operativo, PERO solo
   * cuando tiene tope de gasto duro configurado: sin tope no hay deuda admitida (hallazgo C2-02) y
   * la organizacion solo opera con minutos incluidos o saldo prepagado.
   *
   * @param planCode - Plan contratado.
   * @param remainingMinutes - Minutos incluidos disponibles.
   * @param creditBalanceUsd - Saldo prepagado disponible.
   * @param hardSpendCapUsd - Tope de gasto duro; `null` cuando no se configura.
   * @returns `true` cuando puede iniciar sesiones.
   */
  private resolveCanStartSession(
    planCode: BillingPlanCode,
    remainingMinutes: Fixed6String,
    creditBalanceUsd: UsdAmountFixed6,
    hardSpendCapUsd: UsdAmountFixed6 | null
  ): boolean {
    const hasIncludedMinutes = DecimalMath.compareFixed6(remainingMinutes, ZERO_FIXED6) > 0;
    const hasCredit = DecimalMath.compareFixed6(creditBalanceUsd, ZERO_FIXED6) > 0;
    if (planCode === 'PAYG') {
      return hasIncludedMinutes || hasCredit;
    }
    if (hardSpendCapUsd === null) {
      return hasIncludedMinutes || hasCredit;
    }
    // Un plan de suscripcion con tope admite consumo por exceso mientras su estado sea operativo;
    // el plan de pago por uso exige saldo o cuota disponible porque nadie responde por el exceso.
    return true;
  }

  /**
   * Compone el motivo legible del bloqueo de servicio.
   *
   * @param capReached - Indica si se alcanzo el tope de gasto.
   * @param status - Estado del ciclo de vida de la suscripcion.
   * @returns Motivo del bloqueo en lenguaje claro para el panel.
   */
  private resolveBlockedReason(capReached: boolean, status: WhopSubscriptionStatus): string {
    if (capReached) {
      return 'TOPE_DE_GASTO_ALCANZADO: eleva el limite o recarga saldo para reanudar el servicio.';
    }
    if (status === 'PAST_DUE_OR_INVALID' || status === 'CANCELED' || status === 'SUSPENDED') {
      return 'SUSCRIPCION_INACTIVA: regulariza el pago o recarga saldo para reanudar el servicio.';
    }
    return 'FONDOS_AGOTADOS: recarga saldo para reanudar el servicio.';
  }
}

/**
 * Ensambla el caso de uso de consultas del panel de consumo.
 *
 * @param dependencies - Repositorio, pasarela, Redis y verificador de DPA del modulo.
 * @returns Caso de uso listo para el contenedor de inyeccion.
 */
export function createBillingDashboardQueriesUseCase(dependencies: CheckoutUseCaseDependencies): BillingDashboardQueriesUseCase {
  return new BillingDashboardQueriesUseCase(dependencies);
}


