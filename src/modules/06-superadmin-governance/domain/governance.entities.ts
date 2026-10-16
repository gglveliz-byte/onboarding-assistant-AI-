/**
 * @archivo src/modules/06-superadmin-governance/domain/governance.entities.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Define las entidades inmutables de dominio, contratos de auditoría forense,
 *   esquemas de validación Zod y tipos tipados para la Consola de Gobierno SuperAdmin.
 *
 * @resumen_contenido
 *   - Interfaces `TenantGovernanceDetails`, `GlobalPricingPlanEntity`, `TenantPricingOverrideEntity`
 *   - Interfaces `PlatformTelemetrySnapshot`, `GovernanceAuditRecord`
 *   - Esquemas de validación Zod: `suspendOrganizationSchema`, `reactivateOrganizationSchema`,
 *     `updateGlobalPricingSchema`, `setTenantOverrideSchema`, `grantPromotionalMinutesSchema`,
 *     `voiceAiKillSwitchSchema`
 *
 * @dependencias_internas
 *   - Ninguna (Capa de Dominio Hexagonal pura).
 *
 * @dependencias_externas
 *   - `zod` para validación estricta de payloads de gobierno.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `pricing_plans_config`, `organization_pricing_overrides`,
 *     `audit_logs`, `whop_subscriptions`.
 */

import { z } from 'zod';

/** Estado administrativo de una organizacion en la plataforma. */
export type OrganizationGovernanceStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION';

/** Nivel de severidad para eventos de auditoria forense. */
export type GovernanceAuditSeverity = 'INFO' | 'WARN' | 'CRITICAL_SECURITY';

/** Detalles consolidados de gobernanza de una organizacion. */
export interface TenantGovernanceDetails {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: OrganizationGovernanceStatus;
  readonly enforceMfa: boolean;
  readonly enforceSso: boolean;
  readonly ssoEmailDomain: string | null;
  readonly optInSessionTranscripts: boolean;
  readonly dpaSignedAt: string | null;
  readonly suspendedReason: string | null;
  readonly suspendedAt: string | null;
  readonly suspendedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeSubscriptionPlanCode?: string | undefined;
  readonly creditBalanceUsd?: string | undefined;
  readonly hardSpendCapUsd?: string | undefined;
}

/** Entidad de configuracion global de plan de facturacion sincronizado con Whop. */
export interface GlobalPricingPlanEntity {
  readonly planCode: string;
  readonly whopPlanId: string;
  readonly displayName: string;
  readonly monthlyFixedPriceUsd: string;
  readonly includedMinutes: string;
  readonly baseOverageRatePerMinuteUsd: string;
  readonly overageAllowed: boolean;
  readonly volumeDiscountEligible: boolean;
  readonly volumeDiscountTiersJson: readonly unknown[];
  readonly isActive: boolean;
  readonly updatedBySuperadminId: string | null;
  readonly updatedAt: string;
}

/** Entidad de override manual de tarifas y descuentos para un tenant especifico. */
export interface TenantPricingOverrideEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly customRatePerMinuteUsd: string | null;
  readonly manualDiscountPercentage: number;
  readonly forceVolumeDiscountTiers: boolean;
  readonly customVolumeTiersJson: readonly unknown[] | null;
  readonly overrideNotes: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdBySuperadminId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Registro de auditoria forense inmutable encadenado con SHA-256. */
export interface GovernanceAuditRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly actorRole: string | null;
  readonly eventCategory: string;
  readonly eventAction: string;
  readonly severity: GovernanceAuditSeverity;
  readonly targetResourceType: string | null;
  readonly targetResourceId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly beforeStateJson: unknown | null;
  readonly afterStateJson: unknown | null;
  readonly prevRecordSha256: string | null;
  readonly recordSha256: string;
  readonly createdAt: string;
}

/** Instantanea de telemetria de infraestructura y sesiones de la plataforma. */
export interface PlatformTelemetrySnapshot {
  readonly timestampIso: string;
  readonly activeVoiceSessionsCount: number;
  readonly totalOrganizationsCount: number;
  readonly suspendedOrganizationsCount: number;
  readonly voiceAiKillSwitchActive: boolean;
  readonly voiceAiKillSwitchReason: string | null;
  readonly recentSecurityIncidentsCount: number;
}

// =============================================================================
// ESQUEMAS DE VALIDACION ZOD PARA ENDPOINTS Y CASOS DE USO DE GOBIERNO
// =============================================================================

/** Esquema para suspender una organizacion con motivo auditable. */
export const suspendOrganizationSchema = z.object({
  reason: z.string().trim().min(5, 'El motivo de suspension debe contener al menos 5 caracteres.').max(500),
  immediateSocketClose: z.boolean().default(true),
});

export type SuspendOrganizationInput = z.infer<typeof suspendOrganizationSchema>;

/** Esquema para reactivar una organizacion suspendida. */
export const reactivateOrganizationSchema = z.object({
  reactivationNotes: z.string().trim().min(3, 'Las notas de reactivacion deben contener al menos 3 caracteres.').max(500),
});

export type ReactivateOrganizationInput = z.infer<typeof reactivateOrganizationSchema>;

/** Esquema para forzar cierre de sesion global de todos los usuarios de un tenant. */
export const forceLogoutOrganizationSchema = z.object({
  reason: z.string().trim().min(3).max(250),
});

export type ForceLogoutOrganizationInput = z.infer<typeof forceLogoutOrganizationSchema>;

/** Esquema para un tramo individual de descuento por volumen con validación de magnitud (C1-16). */
export const volumeDiscountTierSchema = z.object({
  fromMinute: z.number().int().min(0, 'Minuto inicial debe ser mayor o igual a 0').max(10_000_000),
  toMinute: z.number().int().min(1).max(10_000_000).nullable().optional(),
  discountPercentage: z.number().min(0).max(100, 'El porcentaje de descuento no puede superar el 100%'),
  discountedRatePerMinuteUsd: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal invalido para tarifa de tramo')
    .refine((v) => Number(v) <= 1_000, 'La tarifa con descuento no puede exceder $1,000 USD')
    .optional(),
});

/** Esquema para actualizar un plan de la matriz global de precios Whop con límites de magnitud (C1-16). */
export const updateGlobalPricingSchema = z.object({
  whopPlanId: z.string().trim().min(1, 'whopPlanId es requerido'),
  displayName: z.string().trim().min(1, 'displayName es requerido').max(100),
  monthlyFixedPriceUsd: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal no valido para precio fijo')
    .refine((v) => Number(v) >= 0 && Number(v) <= 100_000, 'El precio fijo mensual debe estar entre 0 y 100,000 USD'),
  includedMinutes: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal no valido para minutos incluidos')
    .refine((v) => Number(v) >= 0 && Number(v) <= 10_000_000, 'Los minutos incluidos deben estar entre 0 y 10,000,000'),
  baseOverageRatePerMinuteUsd: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal no valido para tarifa de sobreuso')
    .refine((v) => Number(v) >= 0 && Number(v) <= 1_000, 'La tarifa base por minuto debe estar entre 0 y 1,000 USD'),
  overageAllowed: z.boolean(),
  volumeDiscountEligible: z.boolean(),
  volumeDiscountTiersJson: z.array(z.record(z.unknown())).default([]),
  isActive: z.boolean().default(true),
});

export type UpdateGlobalPricingInput = z.infer<typeof updateGlobalPricingSchema>;

/** Esquema para fijar tarifas u overrides personalizados por cliente con cotas máximas (C1-16). */
export const setTenantOverrideSchema = z.object({
  customRatePerMinuteUsd: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal invalido para tarifa personalizada')
    .refine((v) => Number(v) >= 0 && Number(v) <= 1_000, 'La tarifa personalizada debe estar entre 0 y 1,000 USD')
    .optional(),
  manualDiscountPercentage: z
    .number()
    .min(0, 'El descuento minimo es 0%')
    .max(100, 'El descuento maximo es 100%')
    .default(0),
  forceVolumeDiscountTiers: z.boolean().default(false),
  customVolumeTiersJson: z.array(z.record(z.unknown())).optional(),
  overrideNotes: z.string().trim().min(5, 'Se requieren notas explicativas para auditoria.').max(500),
  effectiveUntilIso: z.string().datetime().optional(),
});

export type SetTenantOverrideInput = z.infer<typeof setTenantOverrideSchema>;

/** Esquema para acreditar minutos promocionales de cortesia a un cliente con cota superior (C1-16). */
export const grantPromotionalMinutesSchema = z.object({
  minutesToGrant: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/, 'Formato decimal no valido para minutos')
    .refine((v) => Number(v) > 0, 'La cantidad de minutos debe ser mayor a cero')
    .refine((v) => Number(v) <= 10_000_000, 'No se pueden otorgar mas de 10,000,000 de minutos promocionales'),
  reason: z.string().trim().min(5, 'Debe especificar el motivo del credito promocional').max(300),
});

export type GrantPromotionalMinutesInput = z.infer<typeof grantPromotionalMinutesSchema>;

/** Esquema para accionar el Kill-Switch de emergencia del motor de voz IA. */
export const voiceAiKillSwitchSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(5, 'Se requiere motivo para accionar el kill-switch').max(300),
});

export type VoiceAiKillSwitchInput = z.infer<typeof voiceAiKillSwitchSchema>;
