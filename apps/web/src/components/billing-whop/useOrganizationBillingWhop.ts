/**
 * @archivo apps/web/src/components/billing-whop/useOrganizationBillingWhop.ts
 * @modulo apps/web (Componentes de Facturación y Consumo Whop)
 * @proposito
 *   Hook reactivo de cliente para la gestión integral de suscripciones, consumo en tiempo
 *   real, apertura de checkout firmado en Whop, portal de autoservicio y configuración de
 *   topes de gasto (Spend Cap) para una organización.
 *
 * @resumen_contenido
 *   - Tipos de estado: `BillingConsumptionState`, `BillingLedgerItem`, `SpendCapConfig`.
 *   - Hook `useOrganizationBillingWhop()`:
 *       * `refreshConsumption()`: Consulta `GET /api/v1/billing/consumption`.
 *       * `fetchLedger()`: Consulta `GET /api/v1/billing/ledger` con paginación por cursor.
 *       * `exportLedgerCsv()`: Descarga `GET /api/v1/billing/ledger/export`.
 *       * `startCheckout()`: Envía `POST /api/v1/billing/checkout` manejando 403 DPA_NOT_SIGNED.
 *       * `openCustomerPortal()`: Redirección al portal de facturas y métodos de pago.
 *       * `updateSpendCap()`: Guarda el tope de gasto mensual y umbrales de alerta.
 *
 * @dependencias_internas
 *   - Contratos REST de `src/modules/04-billing-and-whop/billing-whop.manifest.ts`.
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`, `useCallback`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `organizations` (vía API REST).
 */

import { useState, useEffect, useCallback } from 'react';

export interface VolumeDiscountTier {
  readonly fromMinute: number;
  readonly toMinute: number | null;
  readonly discountPercentage: number;
  readonly discountedRatePerMinuteUsd?: string;
}

export interface BillingConsumptionState {
  readonly organizationId: string;
  readonly planCode: 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50';
  readonly status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING';
  readonly includedMinutesTotal: number;
  readonly includedMinutesUsed: number;
  readonly includedMinutesRemaining: number;
  readonly overageMinutesUsed: number;
  readonly overageBilledUsd: string;
  readonly effectiveRatePerMinuteUsd: string;
  readonly volumeDiscountPercentage: number;
  readonly activeVolumeTier: VolumeDiscountTier | null;
  readonly hardSpendCapUsd: string | null;
  readonly currentTotalCostUsd: string;
  readonly cyclePeriodStart: string;
  readonly cyclePeriodEnd: string;
  readonly dpaSigned: boolean;
}

export interface BillingLedgerItem {
  readonly id: string;
  readonly createdAt: string;
  readonly entryType: 'VOICE_MINUTE_DEDUCTION' | 'PLAN_ACTIVATION_GRANT' | 'PAYMENT_SUCCEEDED_RENEWAL' | 'CREDIT_SUPERADMIN_GRANT';
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
  readonly startCheckout: (planCode: string, mode?: 'SUBSCRIPTION' | 'ONE_TIME_TOP_UP', topUpAmountUsd?: string) => Promise<string | null>;
  readonly openCustomerPortal: () => Promise<string | null>;
  readonly updateSpendCap: (config: SpendCapConfig) => Promise<boolean>;
}

/**
 * Hook de gestión de facturación, consumo y enlaces seguros de Whop.
 *
 * @param organizationId - Identificador único de la organización en sesión.
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
   * Refresca la instantánea de consumo de minutos y saldo del periodo activo.
   */
  const refreshConsumption = useCallback(async (): Promise<void> => {
    if (!organizationId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/billing/consumption', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        if (response.status === 403) {
          const body = await response.json().catch(() => ({}));
          if (body.code === 'DPA_NOT_SIGNED' || body.code === 'LEGAL_CONSENT_OUTDATED') {
            setDpaRequired(true);
            setError('Se requiere la firma del Acuerdo de Procesamiento de Datos (DPA) para operar.');
            return;
          }
        }
        throw new Error(`Error ${response.status} al obtener consumo de facturación`);
      }

      const data = await response.json();
      setConsumption({
        organizationId: data.organizationId ?? organizationId,
        planCode: data.planCode ?? 'PLAN_5',
        status: data.status ?? 'ACTIVE',
        includedMinutesTotal: Number(data.includedMinutesTotal ?? 25),
        includedMinutesUsed: Number(data.includedMinutesUsed ?? 0),
        includedMinutesRemaining: Math.max(0, Number(data.includedMinutesTotal ?? 25) - Number(data.includedMinutesUsed ?? 0)),
        overageMinutesUsed: Number(data.overageMinutesUsed ?? 0),
        overageBilledUsd: String(data.overageBilledUsd ?? '0.000000'),
        effectiveRatePerMinuteUsd: String(data.effectiveRatePerMinuteUsd ?? '0.120000'),
        volumeDiscountPercentage: Number(data.volumeDiscountPercentage ?? 0),
        activeVolumeTier: data.activeVolumeTier ?? null,
        hardSpendCapUsd: data.hardSpendCapUsd ? String(data.hardSpendCapUsd) : null,
        currentTotalCostUsd: String(data.currentTotalCostUsd ?? '5.000000'),
        cyclePeriodStart: data.cyclePeriodStart ?? new Date(Date.now() - 15 * 86400000).toISOString(),
        cyclePeriodEnd: data.cyclePeriodEnd ?? new Date(Date.now() + 15 * 86400000).toISOString(),
        dpaSigned: data.dpaSigned ?? true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al conectar con el servicio de facturación';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  /**
   * Consulta el historial paginado del libro mayor de consumo minuto a minuto.
   */
  const fetchLedger = useCallback(async (pageSize = 20, cursor: string | null = null): Promise<void> => {
    if (!organizationId) return;
    try {
      const url = new URL('/api/v1/billing/ledger', window.location.origin);
      url.searchParams.set('pageSize', String(pageSize));
      if (cursor) url.searchParams.set('cursor', cursor);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status} al consultar libro mayor`);
      }

      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setLedgerItems(items.map((row: Record<string, unknown>, idx: number) => ({
        id: String(row['id'] ?? `ledger-${idx}`),
        createdAt: String(row['createdAt'] ?? new Date().toISOString()),
        entryType: (row['entryType'] as BillingLedgerItem['entryType']) ?? 'VOICE_MINUTE_DEDUCTION',
        minutesDelta: String(row['minutesDelta'] ?? '-1.000000'),
        costDeltaUsd: String(row['costDeltaUsd'] ?? '0.120000'),
        voiceEngine: String(row['voiceEngine'] ?? 'Motor Conversacional en Vivo'),
        runningBalanceMinutes: String(row['runningBalanceMinutes'] ?? '24.000000'),
        runningBalanceUsd: String(row['runningBalanceUsd'] ?? '0.120000'),
        description: String(row['description'] ?? 'Consumo sesión asistente en tiempo real'),
        projectName: row['projectName'] ? String(row['projectName']) : undefined,
      })));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al consultar transacciones del libro mayor';
      setError(msg);
    }
  }, [organizationId]);

  /**
   * Exporta el libro mayor del periodo vigente en formato CSV auditable.
   */
  const exportLedgerCsv = useCallback(async (): Promise<void> => {
    if (!organizationId) return;
    setIsExportingCsv(true);
    try {
      const response = await fetch('/api/v1/billing/ledger/export', {
        method: 'GET',
        headers: { 'Accept': 'text/csv' },
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Fallo en la descarga del CSV';
      setError(msg);
    } finally {
      setIsExportingCsv(false);
    }
  }, [organizationId]);

  /**
   * Inicia el flujo de checkout firmado para cambio de plan o recarga prepagada.
   */
  const startCheckout = useCallback(async (
    planCode: string,
    mode: 'SUBSCRIPTION' | 'ONE_TIME_TOP_UP' = 'SUBSCRIPTION',
    topUpAmountUsd?: string
  ): Promise<string | null> => {
    if (!organizationId) return null;
    setIsLoading(true);
    setError(null);
    try {
      const redirectUrl = window.location.href;
      const response = await fetch('/api/v1/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          planCode,
          checkoutMode: mode,
          redirectUrl,
          ...(topUpAmountUsd ? { topUpAmountUsd } : {}),
        }),
      });

      if (response.status === 403) {
        const body = await response.json().catch(() => ({}));
        if (body.code === 'DPA_NOT_SIGNED' || body.code === 'LEGAL_CONSENT_OUTDATED') {
          setDpaRequired(true);
          setError('Debe firmar el DPA legal antes de suscribirse a un plan comercial.');
          return null;
        }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Error en checkout' }));
        throw new Error(errorData.message ?? `Error HTTP ${response.status}`);
      }

      const data = await response.json();
      const checkoutUrl = data.checkoutUrl ?? data.url;
      if (typeof checkoutUrl === 'string' && checkoutUrl.length > 0) {
        window.location.href = checkoutUrl;
        return checkoutUrl;
      }
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al iniciar checkout seguro';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  /**
   * Solicita la URL del portal de gestión de suscripción y facturas del cliente.
   */
  const openCustomerPortal = useCallback(async (): Promise<string | null> => {
    if (!organizationId) return null;
    try {
      const response = await fetch('/api/v1/billing/whop/customer-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, returnUrl: window.location.href }),
      });

      if (!response.ok) {
        throw new Error(`Portal no disponible (${response.status})`);
      }

      const data = await response.json();
      const portalUrl = data.portalUrl ?? data.url;
      if (portalUrl) {
        window.open(portalUrl, '_blank', 'noopener,noreferrer');
        return portalUrl;
      }
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'No se pudo abrir el portal de facturación';
      setError(msg);
      return null;
    }
  }, [organizationId]);

  /**
   * Guarda o actualiza el tope de gasto mensual y umbrales de alerta.
   */
  const updateSpendCap = useCallback(async (config: SpendCapConfig): Promise<boolean> => {
    if (!organizationId) return false;
    try {
      const response = await fetch('/api/v1/billing/spend-cap', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          hardSpendCapUsd: config.hardSpendCapUsd,
          alertAt50Percent: config.alertAt50Percent,
          alertAt80Percent: config.alertAt80Percent,
          alertAt100Percent: config.alertAt100Percent,
        }),
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status} al actualizar tope de gasto`);
      }

      await refreshConsumption();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al guardar tope de gasto';
      setError(msg);
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
