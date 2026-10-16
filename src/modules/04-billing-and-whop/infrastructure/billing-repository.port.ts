/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/billing-repository.port.ts
 * @modulo 04-billing-and-whop (Contrato de Persistencia de la Facturacion)
 * @proposito
 *   Declara el puerto de acceso a datos del modulo de cobros y los dos tipos que acompanan cada
 *   mutacion de saldo: la actualizacion de periodo de la suscripcion y el asiento del libro mayor.
 *   Al ser un contrato puro, permite que los casos de uso se prueben con un repositorio simulado y
 *   que el motor de persistencia pueda sustituirse sin tocar la logica de negocio.
 *
 *   Las tres lecturas admiten una conexion opcional del llamador. No es un adorno: el pulso de cobro
 *   del gateway de voz ya retiene una conexion dentro de su transaccion, y tomar otra del pool
 *   mientras la primera sigue viva agota el pool con unas pocas sesiones concurrentes —ademas de
 *   perder el contexto de inquilino, sin el cual las tablas con aislamiento por organizacion no
 *   devuelven ninguna fila—.
 *
 * @resumen_contenido
 *   - Interface `SubscriptionPeriodUpdate`: Campos de periodo y saldos a persistir.
 *   - Interface `LedgerAppendInput`: Asiento inmutable a registrar en el libro mayor.
 *   - Interface `BillingRepositoryPort`: Contrato completo de acceso a datos del modulo.
 *
 * @dependencias_internas
 *   - Tipos del dominio (`../domain/billing-whop.types.ts`) y `Fixed6String` del kernel.
 *
 * @dependencias_externas
 *   - Ninguna (Contrato puro: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `pricing_plans_config` y
 *     `organization_pricing_overrides`.
 */

import type { PoolClient } from 'pg';
import type { Fixed6String } from '../../../shared/kernel/decimal.util';
import type {
  BillingPlanCode,
  LedgerEntryType,
  OrganizationPricingOverride,
  PricingPlanConfig,
  WhopSubscriptionState,
  WhopSubscriptionStatus,
} from '../domain/billing-whop.types';

/** Campos de periodo y saldos que se persisten sobre la suscripcion bloqueada. */
export interface SubscriptionPeriodUpdate {
  /** Plan que queda vigente. */
  readonly planCode: BillingPlanCode;
  /** Estado del ciclo de vida que queda vigente. */
  readonly status: WhopSubscriptionStatus;
  /** Cuota de minutos incluidos del periodo. */
  readonly periodIncludedMinutesQuota: Fixed6String;
  /** Minutos incluidos disponibles tras la operacion. */
  readonly periodIncludedMinutesRemaining: Fixed6String;
  /** Minutos de exceso acumulados tras la operacion. */
  readonly periodOverageMinutesUsed: Fixed6String;
  /** Importe facturado por exceso tras la operacion. */
  readonly currentPeriodOverageBilledUsd: Fixed6String;
  /** Saldo de credito tras la operacion. */
  readonly creditBalanceUsd: Fixed6String;
  /** Inicio del periodo vigente en formato ISO 8601. */
  readonly currentPeriodStartIso?: string;
  /** Fin del periodo vigente en formato ISO 8601. */
  readonly currentPeriodEndIso?: string;
  /** Identificador de la membresia en la pasarela. */
  readonly externalMembershipId?: string | null;
  /** Identificador del ultimo evento aplicado. */
  readonly lastExternalEventId?: string | null;
}

/** Asiento inmutable a registrar en el libro mayor. */
export interface LedgerAppendInput {
  /** Organizacion afectada. */
  readonly organizationId: string;
  /** Proyecto cuyo consumo origino el asiento, cuando proviene de una sesion de voz. */
  readonly projectId?: string | null;
  /** Sesion de voz cuyo consumo origino el asiento, cuando aplica. */
  readonly voiceSessionId?: string | null;
  /** Suscripcion afectada, cuando el asiento modifica saldos del periodo. */
  readonly subscriptionId: string | null;
  /** Identificador del evento externo, unico para la idempotencia contable. */
  readonly externalEventId: string | null;
  /** Identificador del pago en la pasarela. */
  readonly externalPaymentId: string | null;
  /** Naturaleza contable del asiento. */
  readonly entryType: LedgerEntryType;
  /** Variacion de minutos. */
  readonly minutesDelta: Fixed6String;
  /** Tarifa unitaria aplicada. */
  readonly unitRateUsd: Fixed6String;
  /** Porcentaje de descuento aplicado. */
  readonly discountAppliedPercent: Fixed6String;
  /** Variacion de importe en USD. */
  readonly amountUsdDelta: Fixed6String;
  /** Saldo de minutos incluidos tras el asiento. */
  readonly includedMinutesBalanceAfter: Fixed6String;
  /** Saldo de credito tras el asiento. */
  readonly creditBalanceUsdAfter: Fixed6String;
  /** Metadatos adicionales del asiento. */
  readonly metadataJson: Readonly<Record<string, unknown>>;
}

/** Asiento del libro mayor ya normalizado para el panel de consumo y la exportacion contable. */
export interface LedgerHistoryEntry {
  /** Identificador del asiento. */
  readonly ledgerEntryId: string;
  /** Proyecto cuyo consumo origino el asiento; `null` cuando no proviene de una sesion de voz. */
  readonly projectId: string | null;
  /** Sesion de voz cuyo consumo origino el asiento; `null` cuando no aplica. */
  readonly voiceSessionId: string | null;
  /** Naturaleza contable del asiento. */
  readonly entryType: LedgerEntryType;
  /** Variacion de minutos. */
  readonly minutesDelta: Fixed6String;
  /** Tarifa unitaria aplicada. */
  readonly unitRateUsd: Fixed6String;
  /** Porcentaje de descuento aplicado. */
  readonly discountAppliedPercent: Fixed6String;
  /** Variacion de importe en USD. */
  readonly amountUsdDelta: Fixed6String;
  /** Saldo de minutos incluidos tras el asiento. */
  readonly includedMinutesBalanceAfter: Fixed6String;
  /** Saldo de credito tras el asiento. */
  readonly creditBalanceUsdAfter: Fixed6String;
  /** Marca temporal del asiento en formato ISO 8601. */
  readonly createdAtIso: string;
}

/** Pagina del historial contable, con la clave de continuacion para la siguiente pagina. */
export interface LedgerHistoryPage {
  /** Asientos de la pagina, del mas reciente al mas antiguo. */
  readonly entries: readonly LedgerHistoryEntry[];
  /** Marca temporal del asiento mas antiguo de la pagina, o `null` cuando no hay mas. */
  readonly nextCursorIso: string | null;
  /** Indica si existe al menos una pagina adicional. */
  readonly hasMore: boolean;
}

/** Totales consolidados del libro mayor dentro de la ventana del periodo vigente. */
export interface LedgerPeriodTotals {
  /** Minutos netos otorgados o consumidos en el periodo. */
  readonly totalMinutesDelta: Fixed6String;
  /** Importe neto facturado o abonado en el periodo. */
  readonly totalAmountUsdDelta: Fixed6String;
  /** Minutos efectivamente consumidos por sesiones de voz en el periodo. */
  readonly consumedMinutes: Fixed6String;
}

/** Contrato de acceso a datos de la facturacion. */
export interface BillingRepositoryPort {
  /**
   * Recupera el catalogo completo de planes de precios.
   *
   * @param client - Conexion ya abierta por el llamador, cuando este retiene una transaccion. Se
   *   reutiliza para no tomar una segunda conexion del pool mientras la primera sigue retenida.
   * @returns Planes vigentes indexados por codigo.
   */
  getPlanCatalog(client?: PoolClient): Promise<Readonly<Record<BillingPlanCode, PricingPlanConfig>>>;

  /**
   * Recupera el override de precios vigente de una organizacion.
   *
   * @param organizationId - Organizacion consultada.
   * @param client - Conexion ya abierta por el llamador, cuando este retiene una transaccion.
   * @returns Override vigente, o `null` cuando no existe o esta fuera de vigencia.
   */
  getActivePricingOverride(organizationId: string, client?: PoolClient): Promise<OrganizationPricingOverride | null>;

  /**
   * Recupera la suscripcion de una organizacion sin adquirir bloqueo.
   *
   * @param organizationId - Organizacion consultada.
   * @param callerClient - Conexion ya abierta por el llamador, cuando este retiene una transaccion.
   *   Reutilizarla evita una segunda conexion del pool Y conserva el contexto de inquilino que el
   *   llamador ya fijo, sin el cual una tabla con aislamiento por organizacion no devuelve filas.
   * @returns Estado de la suscripcion, o `null` cuando no existe.
   */
  findSubscription(organizationId: string, callerClient?: PoolClient): Promise<WhopSubscriptionState | null>;

  /**
   * Bloquea la suscripcion con `SELECT ... FOR UPDATE` SOBRE la conexion del llamador.
   *
   * Es la pieza que cierra el hallazgo C1-21 en la via rapida del pulso: reutilizar la conexion
   * sin bloquear permitia que varios pulsos leyeran la misma instantanea y sobrescribieran el
   * saldo (actualizacion perdida; medido: 30.5 minutos cubiertos con una cuota de 10). El bloqueo
   * viaja por la conexion que ya retiene el llamador, de modo que serializa sin tomar una segunda
   * del pool.
   *
   * @param client - Conexion transaccional del llamador, con su contexto de inquilino ya fijado.
   * @param organizationId - Organizacion cuya suscripcion se bloquea.
   * @returns Estado bloqueado de la suscripcion.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  lockSubscriptionOnClient(client: PoolClient, organizationId: string): Promise<WhopSubscriptionState>;

  /**
   * Recupera la suscripcion por el identificador de membresia de la pasarela.
   *
   * @param externalMembershipId - Identificador de la membresia.
   * @returns Estado de la suscripcion, o `null` cuando no existe.
   */
  findSubscriptionByMembershipId(externalMembershipId: string): Promise<WhopSubscriptionState | null>;

  /**
   * Ejecuta una operacion bajo bloqueo pesimista exclusivo de la suscripcion.
   *
   * @param organizationId - Organizacion cuya suscripcion se bloquea.
   * @param work - Operacion que recibe el estado bloqueado y produce un resultado.
   * @returns Resultado producido por la operacion.
   */
  withLockedSubscription<T>(
    organizationId: string,
    work: (client: PoolClient, lockedSubscription: WhopSubscriptionState) => Promise<T>
  ): Promise<T>;

  /**
   * Aplica una actualizacion de periodo y saldos sobre la suscripcion.
   *
   * @param organizationId - Organizacion cuya suscripcion se actualiza.
   * @param update - Campos de periodo y saldos a persistir.
   */
  applyPeriodUpdateOnLockedClient(client: PoolClient, organizationId: string, update: SubscriptionPeriodUpdate): Promise<void>;

  /**
   * Crea la suscripcion de una organizacion si aun no existe.
   *
   * @param organizationId - Organizacion propietaria.
   * @param update - Estado inicial con el que se crea la suscripcion.
   */
  ensureSubscriptionExists(organizationId: string, update: SubscriptionPeriodUpdate): Promise<void>;

  /**
   * Registra un asiento inmutable en el libro mayor contable.
   *
   * @param entry - Asiento a registrar.
   * @returns Identificador del asiento creado.
   */
  appendImmutableLedgerEntryOnLockedClient(client: PoolClient, entry: LedgerAppendInput): Promise<{ readonly ledgerEntryId: string }>;

  /**
   * Comprueba si una organizacion puede iniciar nuevas sesiones de voz.
   *
   * @param organizationId - Organizacion consultada.
   * @returns `true` cuando puede iniciar sesiones.
   */
  canOrganizationOperate(organizationId: string): Promise<boolean>;

  /**
   * Recupera una pagina del historial contable de una organizacion.
   *
   * @param organizationId - Organizacion consultada.
   * @param cursorIso - Marca temporal de continuacion; `null` para la primera pagina.
   * @param pageSize - Numero maximo de asientos a devolver.
   * @returns Pagina de asientos con su clave de continuacion.
   */
  readLedgerPage(organizationId: string, cursorIso: string | null, pageSize: number): Promise<LedgerHistoryPage>;

  /**
   * Consolida los minutos y dolares movidos en el periodo vigente.
   *
   * @param organizationId - Organizacion consultada.
   * @param periodStartIso - Inicio de la ventana del periodo, en formato ISO 8601.
   * @returns Totales del periodo.
   */
  readLedgerPeriodTotals(organizationId: string, periodStartIso: string): Promise<LedgerPeriodTotals>;

  /**
   * Recupera todos los asientos de un rango temporal para la exportacion contable.
   *
   * @param organizationId - Organizacion consultada.
   * @param rangeStartIso - Inicio del rango, en formato ISO 8601.
   * @param rangeEndIso - Fin del rango, en formato ISO 8601.
   * @returns Asientos del rango ordenados cronologicamente.
   */
  exportLedgerEntries(organizationId: string, rangeStartIso: string, rangeEndIso: string): Promise<readonly LedgerHistoryEntry[]>;
}

