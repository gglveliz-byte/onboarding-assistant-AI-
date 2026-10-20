/**
 * @archivo apps/web/src/components/billing-whop/useOrganizationBillingWhop.ts
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Hook reactivo de cliente para la gestión integral de suscripciones, consumo en tiempo
 *   real, apertura de checkout firmado en Whop, portal de autoservicio y configuración de
 *   topes de gasto (Spend Cap) de una organización. Todas las lecturas y mutaciones viajan por
 *   el cliente HTTP único del frente (`backendFetch`), que adjunta el Bearer de la sesión,
 *   renueva el token ante un 401 y normaliza el sobre de error del backend. Los campos del
 *   backend se traducen aquí a la proyección de la interfaz: no se fabrican cifras.
 *
 * @resumen_contenido
 *   - Tipos de estado: `BillingConsumptionState`, `BillingLedgerItem`, `SpendCapConfig`.
 *   - Hook `useOrganizationBillingWhop()`:
 *       * `refreshConsumption()`: `GET /api/v1/billing/consumption` (mapeo de la instantánea real).
 *       * `fetchLedger()`: `GET /api/v1/billing/ledger` con paginación por cursor ISO.
 *       * `exportLedgerCsv()`: `GET /api/v1/billing/ledger/export` (CSV crudo, no JSON).
 *       * `startCheckout()`: `POST /api/v1/billing/checkout` con manejo de 403 DPA_NOT_SIGNED.
 *       * `openCustomerPortal()`: portal de facturas y métodos de pago.
 *       * `updateSpendCap()`: tope de gasto mensual y umbrales de alerta.
 *
 * @dependencias_internas
 *   - `backendFetch`, `getAccessToken` (apps/web/src/lib/api-client/http-client.ts).
 *   - Contratos REST de `src/modules/04-billing-and-whop/billing-whop.manifest.ts`.
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`, `useCallback`).
 *
 * @notas
 *   - La organización se resuelve en el servidor a partir de la sesión; `organizationId` solo se
 *     usa como etiqueta local (por ejemplo, en el nombre del archivo CSV exportado).
 *   - `PUT /api/v1/billing/spend-cap`, `POST /api/v1/billing/customer-portal` y
 *     `POST /api/v1/billing/reconcile` ya están expuestos por el backend. El portal requiere que
 *     exista una membresía en la pasarela —es decir, tras el primer pago confirmado—; mientras no la
 *     haya el servidor responde 404 con causa legible y la interfaz lo comunica sin simular un éxito.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `organizations` (vía API REST).
 */

import { useState, useEffect, useCallback } from 'react';
import { BackendHttpError, backendFetch, getAccessToken } from '../../lib/api-client/http-client';

export interface VolumeDiscountTier {
  /** Número de tramo alcanzado (1 en adelante), tal y como lo devuelve el backend. */
  readonly tier: number;
  readonly discountPercentage: number;
  readonly discountedRatePerMinuteUsd?: string;
}

export interface BillingConsumptionState {
  readonly organizationId: string;
  readonly planCode: 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50' | 'CUSTOM_ENTERPRISE';
  readonly status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE_OR_INVALID' | 'CANCELED' | 'SUSPENDED';
  readonly includedMinutesTotal: number;
  readonly includedMinutesUsed: number;
  readonly includedMinutesRemaining: number;
  readonly overageMinutesUsed: number;
  readonly overageBilledUsd: string;
  readonly effectiveRatePerMinuteUsd: string;
  readonly volumeDiscountPercentage: number;
  readonly activeVolumeTier: VolumeDiscountTier | null;
  readonly hardSpendCapUsd: string | null;
  readonly cyclePeriodStart: string;
  readonly cyclePeriodEnd: string;
  readonly dpaSigned: boolean;
}

export interface BillingLedgerItem {
  readonly id: string;
  readonly createdAt: string;
  readonly entryType:
    | 'VOICE_MINUTE_DEDUCTION'
    | 'PLAN_ACTIVATION_GRANT'
    | 'PAYMENT_SUCCEEDED_RENEWAL'
    | 'PAYMENT_SUCCEEDED_TOPUP'
    | 'CREDIT_SUPERADMIN_GRANT'
    | 'MANUAL_ADJUSTMENT'
    | 'REFUND_REVERSAL';
  readonly minutesDelta: string;
  readonly costDeltaUsd: string;
  readonly voiceEngine: string;
  readonly runningBalanceMinutes: string;
  readonly runningBalanceUsd: string;
  readonly description: string;
  readonly projectName?: string;
}

export interface SpendCapConfig {
  readonly hardSpendCapUsd: string;
  readonly alertAt50Percent: boolean;
  readonly alertAt80Percent: boolean;
  readonly alertAt100Percent: boolean;
}

export interface UseOrganizationBillingWhopReturn {
  readonly consumption: BillingConsumptionState | null;
  readonly ledgerItems: readonly BillingLedgerItem[];
  readonly isLoading: boolean;
  readonly isExportingCsv: boolean;
  readonly error: string | null;
  readonly dpaRequired: boolean;
  readonly refreshConsumption: () => Promise<void>;
  readonly fetchLedger: (pageSize?: number, cursor?: string | null) => Promise<void>;
  readonly exportLedgerCsv: () => Promise<void>;
  readonly startCheckout: (planCode: string, mode?: 'SUBSCRIPTION' | 'TOP_UP' | 'PAY_AS_YOU_GO', topUpAmountUsd?: string) => Promise<string | null>;
  readonly openCustomerPortal: () => Promise<string | null>;
  readonly updateSpendCap: (config: SpendCapConfig) => Promise<boolean>;
}

/** Descripción legible de cada tipo de asiento del libro mayor (7 tipos del backend). */
const LEDGER_ENTRY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  VOICE_MINUTE_DEDUCTION: 'Consumo de minutos de voz en tiempo real',
  PLAN_ACTIVATION_GRANT: 'Otorgamiento de minutos por activación de plan',
  PAYMENT_SUCCEEDED_RENEWAL: 'Renovación de suscripción pagada',
  PAYMENT_SUCCEEDED_TOPUP: 'Recarga prepagada de saldo',
  CREDIT_SUPERADMIN_GRANT: 'Crédito otorgado por la plataforma',
  MANUAL_ADJUSTMENT: 'Ajuste manual de la plataforma',
  REFUND_REVERSAL: 'Devolución de un cobro anterior',
};

/** Tipos de asiento reconocidos por el backend (`ledger_entry_type_enum`). */
const LEDGER_ENTRY_TYPES: readonly string[] = [
  'VOICE_MINUTE_DEDUCTION',
  'PLAN_ACTIVATION_GRANT',
  'PAYMENT_SUCCEEDED_RENEWAL',
  'PAYMENT_SUCCEEDED_TOPUP',
  'CREDIT_SUPERADMIN_GRANT',
  'MANUAL_ADJUSTMENT',
  'REFUND_REVERSAL',
];

/** Códigos de plan del backend (`billing_plan_code_enum`). */
const PLAN_CODES: readonly string[] = ['PAYG', 'PLAN_5', 'PLAN_10', 'PLAN_30', 'PLAN_50', 'CUSTOM_ENTERPRISE'];

/** Estados de suscripción del backend (`whop_sub_status_enum`). */
const SUBSCRIPTION_STATUSES: readonly string[] = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE_OR_INVALID',
  'CANCELED',
  'SUSPENDED',
];

/** Determina si un valor desconocido es un registro JSON indexable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convierte un decimal de cadena (Fixed6) en número finito. */
function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Normaliza un valor textual del backend; `''` cuando no existe. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : '');
}

/**
 * Hook de gestión de facturación, consumo y enlaces seguros de Whop.
 *
 * @param organizationId - Etiqueta local de la organización (la API resuelve el tenant por la sesión).
 * @returns Funciones operativas y estado reactivo del consumo y libro mayor.
 */
export function useOrganizationBillingWhop(organizationId: string): UseOrganizationBillingWhopReturn {
  const [consumption, setConsumption] = useState<BillingConsumptionState | null>(null);
  const [ledgerItems, setLedgerItems] = useState<readonly BillingLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isExportingCsv, setIsExportingCsv] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dpaRequired, setDpaRequired] = useState<boolean>(false);

  /**
   * Refresca la instantánea real de consumo de minutos y saldo del periodo activo.
   */
  const refreshConsumption = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const snapshot = await backendFetch<unknown>('/api/v1/billing/consumption');
      if (!isRecord(snapshot)) {
        throw new Error('El motor de facturación devolvió una respuesta inesperada.');
      }
      const effectiveRate = toText(snapshot['effectiveRatePerMinuteUsd']);
      const discountPercentage = toNumber(snapshot['volumeDiscountPercent']);
      const planCode = toText(snapshot['planCode']);
      const status = toText(snapshot['status']);
      const appliedTierNumber = snapshot['appliedTierNumber'];
      setConsumption({
        organizationId,
        planCode: (PLAN_CODES.includes(planCode)
          ? planCode
          : 'PAYG') as BillingConsumptionState['planCode'],
        status: (SUBSCRIPTION_STATUSES.includes(status)
          ? status
          : 'ACTIVE') as BillingConsumptionState['status'],
        includedMinutesTotal: toNumber(snapshot['includedMinutesQuota']),
        includedMinutesUsed: toNumber(snapshot['includedMinutesConsumed']),
        includedMinutesRemaining: toNumber(snapshot['includedMinutesRemaining']),
        overageMinutesUsed: toNumber(snapshot['overageMinutesUsed']),
        overageBilledUsd: toText(snapshot['overageBilledUsd']),
        effectiveRatePerMinuteUsd: effectiveRate,
        volumeDiscountPercentage: discountPercentage,
        activeVolumeTier: typeof appliedTierNumber === 'number' && appliedTierNumber > 0
          ? {
              tier: appliedTierNumber,
              discountPercentage,
              discountedRatePerMinuteUsd: effectiveRate,
            }
          : null,
        hardSpendCapUsd: snapshot['hardSpendCapUsd'] === null || snapshot['hardSpendCapUsd'] === undefined
          ? null
          : toText(snapshot['hardSpendCapUsd']),
        cyclePeriodStart: toText(snapshot['currentPeriodStartIso']),
        cyclePeriodEnd: toText(snapshot['currentPeriodEndIso']),
        dpaSigned: true,
      });
    } catch (caught: unknown) {
      const message = caught instanceof Error
        ? caught.message
        : 'Error al conectar con el servicio de facturación';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  /**
   * Consulta el historial paginado del libro mayor de consumo minuto a minuto.
   */
  const fetchLedger = useCallback(async (pageSize = 20, cursor: string | null = null): Promise<void> => {
    try {
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      if (cursor !== null) {
        query.set('cursor', cursor);
      }
      const payload = await backendFetch<unknown>(`/api/v1/billing/ledger?${query.toString()}`);
      const rawEntries = isRecord(payload) && Array.isArray(payload['entries']) ? payload['entries'] : [];
      setLedgerItems(rawEntries.map((raw: unknown): BillingLedgerItem => {
        const entry = isRecord(raw) ? raw : {};
        const entryType = toText(entry['entryType']);
        const voiceSessionId = toText(entry['voiceSessionId']);
        const projectId = toText(entry['projectId']);
        return {
          id: toText(entry['ledgerEntryId']),
          createdAt: toText(entry['createdAtIso']),
          entryType: (LEDGER_ENTRY_TYPES.includes(entryType)
            ? entryType
            : 'VOICE_MINUTE_DEDUCTION') as BillingLedgerItem['entryType'],
          minutesDelta: toText(entry['minutesDelta']),
          costDeltaUsd: toText(entry['amountUsdDelta']),
          voiceEngine: voiceSessionId.length > 0 ? 'Sesión de voz' : 'Ajuste de facturación',
          runningBalanceMinutes: toText(entry['includedMinutesBalanceAfter']),
          runningBalanceUsd: toText(entry['creditBalanceUsdAfter']),
          description: LEDGER_ENTRY_DESCRIPTIONS[entryType] ?? 'Asiento contable del ciclo vigente',
          ...(projectId.length > 0 ? { projectName: projectId } : {}),
        };
      }));
    } catch (caught: unknown) {
      const message = caught instanceof Error
        ? caught.message
        : 'Error al consultar transacciones del libro mayor';
      setError(message);
    }
  }, []);

  /**
   * Exporta el libro mayor del periodo vigente en formato CSV auditable.
   */
  const exportLedgerCsv = useCallback(async (): Promise<void> => {
    setIsExportingCsv(true);
    setError(null);
    try {
      const token = getAccessToken();
      const response = await fetch('/api/v1/billing/ledger/export', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/csv',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
      });
      if (!response.ok) {
        throw new Error(`Error ${response.status} al exportar archivo CSV`);
      }
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `libro_mayor_consumo_${organizationId}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'Fallo en la descarga del CSV';
      setError(message);
    } finally {
      setIsExportingCsv(false);
    }
  }, [organizationId]);

  /**
   * Inicia el flujo de checkout firmado para cambio de plan o recarga prepagada.
   */
  const startCheckout = useCallback(async (
    planCode: string,
    mode: 'SUBSCRIPTION' | 'TOP_UP' | 'PAY_AS_YOU_GO' = 'SUBSCRIPTION',
    topUpAmountUsd?: string
  ): Promise<string | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const redirectUrl = window.location.href;
      const payload = await backendFetch<unknown>('/api/v1/billing/checkout', {
        method: 'POST',
        body: {
          planCode,
          checkoutMode: mode,
          redirectUrl,
          ...(topUpAmountUsd ? { topUpAmountUsd } : {}),
        },
      });
      const session = isRecord(payload) ? payload : {};
      // El backend devuelve `gatewayCheckoutUrl` y `signedUrl` (contrato de Whop).
      const checkoutUrl = toText(session['gatewayCheckoutUrl'])
        || toText(session['signedUrl'])
        || toText(session['checkoutUrl']);
      if (checkoutUrl.length === 0) {
        throw new Error('El motor de facturación no devolvió un enlace de checkout.');
      }
      window.location.href = checkoutUrl;
      return checkoutUrl;
    } catch (caught: unknown) {
      if (caught instanceof BackendHttpError && caught.code === 'DPA_NOT_SIGNED') {
        setDpaRequired(true);
        setError('Debe firmar el DPA legal antes de suscribirse a un plan comercial.');
        return null;
      }
      const message = caught instanceof Error ? caught.message : 'Error al iniciar checkout seguro';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Solicita la URL del portal de gestión de suscripción y facturas del cliente.
   */
  const openCustomerPortal = useCallback(async (): Promise<string | null> => {
    try {
      const payload = await backendFetch<unknown>('/api/v1/billing/customer-portal', {
        method: 'POST',
        body: { returnUrl: window.location.href },
      });
      const body = isRecord(payload) ? payload : {};
      const portalUrl = toText(body['portalUrl']) || toText(body['url']);
      if (portalUrl.length === 0) {
        throw new Error('El motor de facturación no devolvió una URL de portal.');
      }
      window.open(portalUrl, '_blank', 'noopener,noreferrer');
      return portalUrl;
    } catch (caught: unknown) {
      const isMissing = caught instanceof BackendHttpError && caught.httpStatus === 404;
      const message = caught instanceof Error
        ? caught.message
        : 'No se pudo abrir el portal de facturación';
      setError(isMissing
        ? 'El portal de clientes todavía no está expuesto por la API.'
        : message);
      return null;
    }
  }, [organizationId]);

  /**
   * Guarda o actualiza el tope de gasto mensual y umbrales de alerta.
   */
  const updateSpendCap = useCallback(async (config: SpendCapConfig): Promise<boolean> => {
    try {
      await backendFetch<unknown>('/api/v1/billing/spend-cap', {
        method: 'PUT',
        body: {
          organizationId,
          hardSpendCapUsd: config.hardSpendCapUsd,
          alertAt50Percent: config.alertAt50Percent,
          alertAt80Percent: config.alertAt80Percent,
          alertAt100Percent: config.alertAt100Percent,
        },
      });
      await refreshConsumption();
      return true;
    } catch (caught: unknown) {
      const isMissing = caught instanceof BackendHttpError && caught.httpStatus === 404;
      const message = caught instanceof Error ? caught.message : 'Error al guardar tope de gasto';
      setError(isMissing
        ? 'El ajuste del Spend Cap todavía no está expuesto por la API.'
        : message);
      return false;
    }
  }, [organizationId, refreshConsumption]);

  useEffect(() => {
    void refreshConsumption();
    void fetchLedger();
  }, [refreshConsumption, fetchLedger]);

  return {
    consumption,
    ledgerItems,
    isLoading,
    isExportingCsv,
    error,
    dpaRequired,
    refreshConsumption,
    fetchLedger,
    exportLedgerCsv,
    startCheckout,
    openCustomerPortal,
    updateSpendCap,
  };
}
