/**
 * @archivo src/modules/06-superadmin-governance/infrastructure/governance-row.mapper.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Transforma filas crudas devueltas por PostgreSQL (snake_case) en entidades de dominio
 *   inmutables (camelCase) para la consola de gobierno SuperAdmin, garantizando aislamiento
 *   entre la estructura de tablas SQL y los casos de uso.
 *
 * @resumen_contenido
 *   - `mapOrganizationRowToGovernanceDetails()`: Mapea organizaciones y suscripción activa.
 *   - `mapPricingPlanRowToEntity()`: Mapea planes globales de tarificación Whop.
 *   - `mapPricingOverrideRowToEntity()`: Mapea tarifas y descuentos personalizados.
 *   - `mapAuditLogRowToRecord()`: Mapea eventos de auditoría inmutable con cadena SHA-256.
 *
 * @dependencias_internas
 *   - `TenantGovernanceDetails`, `GlobalPricingPlanEntity`, `TenantPricingOverrideEntity`,
 *     `GovernanceAuditRecord` (`../domain/governance.entities.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Mapeador de infraestructura desacoplado).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `pricing_plans_config`, `organization_pricing_overrides`, `audit_logs`.
 */

import type {
  TenantGovernanceDetails,
  GlobalPricingPlanEntity,
  TenantPricingOverrideEntity,
  GovernanceAuditRecord,
  OrganizationGovernanceStatus,
  GovernanceAuditSeverity,
} from '../domain/governance.entities';

/** Fila cruda de organizacion con datos cruzados de suscripcion. */
export interface OrganizationSqlRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  enforce_mfa: boolean;
  enforce_sso: boolean;
  sso_email_domain: string | null;
  opt_in_session_transcripts: boolean;
  dpa_signed_at: Date | string | null;
  suspended_reason: string | null;
  suspended_at: Date | string | null;
  suspended_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sub_plan_code?: string | null;
  credit_balance_usd?: string | null;
  hard_spend_cap_usd?: string | null;
}

/** Fila cruda de plan de precios en la base de datos. */
export interface PricingPlanSqlRow {
  plan_code: string;
  whop_plan_id: string;
  display_name: string;
  monthly_fixed_price_usd: string | number;
  included_minutes: string | number;
  base_overage_rate_per_minute_usd: string | number;
  overage_allowed: boolean;
  volume_discount_eligible: boolean;
  volume_discount_tiers_json: unknown;
  is_active: boolean;
  updated_by_superadmin_id: string | null;
  updated_at: Date | string;
}

/** Fila cruda de override de tarificacion para un tenant. */
export interface PricingOverrideSqlRow {
  id: string;
  organization_id: string;
  custom_rate_per_minute_usd: string | number | null;
  manual_discount_percentage: string | number;
  force_volume_discount_tiers: boolean;
  custom_volume_tiers_json: unknown | null;
  override_notes: string;
  effective_from: Date | string;
  effective_until: Date | string | null;
  created_by_superadmin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Fila cruda de registro de auditoria forense. */
export interface AuditLogSqlRow {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  actor_role: string | null;
  event_category: string;
  event_action: string;
  severity: string;
  target_resource_type: string | null;
  target_resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  before_state_json: unknown | null;
  after_state_json: unknown | null;
  prev_record_sha256: string | null;
  record_sha256: string;
  created_at: Date | string;
}

/**
 * Convierte una fecha o cadena en formato ISO 8601 estandar.
 */
function toIsoString(dateOrStr: Date | string | null | undefined): string | null {
  if (dateOrStr === null || dateOrStr === undefined) {
    return null;
  }
  return dateOrStr instanceof Date ? dateOrStr.toISOString() : new Date(dateOrStr).toISOString();
}

/**
 * Convierte una fila SQL de organizacion a la entidad `TenantGovernanceDetails`.
 */
export function mapOrganizationRowToGovernanceDetails(row: OrganizationSqlRow): TenantGovernanceDetails {
  return Object.freeze({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as OrganizationGovernanceStatus,
    enforceMfa: row.enforce_mfa,
    enforceSso: row.enforce_sso,
    ssoEmailDomain: row.sso_email_domain,
    optInSessionTranscripts: row.opt_in_session_transcripts,
    dpaSignedAt: toIsoString(row.dpa_signed_at),
    suspendedReason: row.suspended_reason,
    suspendedAt: toIsoString(row.suspended_at),
    suspendedByUserId: row.suspended_by_user_id,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    activeSubscriptionPlanCode: row.sub_plan_code ?? undefined,
    creditBalanceUsd: row.credit_balance_usd !== null && row.credit_balance_usd !== undefined ? String(row.credit_balance_usd) : undefined,
    hardSpendCapUsd: row.hard_spend_cap_usd !== null && row.hard_spend_cap_usd !== undefined ? String(row.hard_spend_cap_usd) : undefined,
  });
}

/**
 * Convierte una fila SQL de plan de precios a `GlobalPricingPlanEntity`.
 */
export function mapPricingPlanRowToEntity(row: PricingPlanSqlRow): GlobalPricingPlanEntity {
  const tiers = Array.isArray(row.volume_discount_tiers_json)
    ? (row.volume_discount_tiers_json as readonly unknown[])
    : [];

  return Object.freeze({
    planCode: row.plan_code,
    whopPlanId: row.whop_plan_id,
    displayName: row.display_name,
    monthlyFixedPriceUsd: String(row.monthly_fixed_price_usd),
    includedMinutes: String(row.included_minutes),
    baseOverageRatePerMinuteUsd: String(row.base_overage_rate_per_minute_usd),
    overageAllowed: row.overage_allowed,
    volumeDiscountEligible: row.volume_discount_eligible,
    volumeDiscountTiersJson: Object.freeze([...tiers]),
    isActive: row.is_active,
    updatedBySuperadminId: row.updated_by_superadmin_id,
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  });
}

/**
 * Convierte una fila SQL de override de cliente a `TenantPricingOverrideEntity`.
 */
export function mapPricingOverrideRowToEntity(row: PricingOverrideSqlRow): TenantPricingOverrideEntity {
  const customTiers = Array.isArray(row.custom_volume_tiers_json)
    ? (row.custom_volume_tiers_json as readonly unknown[])
    : null;

  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    customRatePerMinuteUsd: row.custom_rate_per_minute_usd !== null ? String(row.custom_rate_per_minute_usd) : null,
    manualDiscountPercentage: Number(row.manual_discount_percentage),
    forceVolumeDiscountTiers: row.force_volume_discount_tiers,
    customVolumeTiersJson: customTiers !== null ? Object.freeze([...customTiers]) : null,
    overrideNotes: row.override_notes,
    effectiveFrom: toIsoString(row.effective_from) ?? new Date().toISOString(),
    effectiveUntil: toIsoString(row.effective_until),
    createdBySuperadminId: row.created_by_superadmin_id,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  });
}

/**
 * Convierte una fila SQL de auditoria a `GovernanceAuditRecord`.
 */
export function mapAuditLogRowToRecord(row: AuditLogSqlRow): GovernanceAuditRecord {
  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    actorApiKeyId: row.actor_api_key_id,
    actorRole: row.actor_role,
    eventCategory: row.event_category,
    eventAction: row.event_action,
    severity: row.severity as GovernanceAuditSeverity,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    beforeStateJson: row.before_state_json,
    afterStateJson: row.after_state_json,
    prevRecordSha256: row.prev_record_sha256,
    recordSha256: row.record_sha256,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
  });
}
