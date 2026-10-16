/**
 * @archivo src/modules/06-superadmin-governance/infrastructure/postgres-governance-admin.repository.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Gestiona las consultas y mutaciones de gobierno en PostgreSQL ejecutadas por el SuperAdmin
 *   bajo transacciones con `app.is_superadmin = true`. Administra el estado de tenants,
 *   matriz global de precios Whop, overrides y telemetria consolidada.
 *
 * @resumen_contenido
 *   - Gestion de Tenants: `updateOrganizationStatus`, `getOrganizationById`, `listOrganizations`.
 *   - Matriz Global Whop: `getPricingPlan`, `listPricingPlans`, `upsertPricingPlan`.
 *   - Overrides de Tarificacion: `getPricingOverride`, `upsertPricingOverride`, `deletePricingOverride`.
 *   - Beneficios y Telemetria: `creditPromotionalMinutes`, `getPlatformTelemetrySnapshot`.
 *
 * @dependencias_internas
 *   - `TenantGovernanceDetails`, `GlobalPricingPlanEntity`, `TenantPricingOverrideEntity`,
 *     `PlatformTelemetrySnapshot`, `OrganizationGovernanceStatus` (`../domain/governance.entities.ts`).
 *   - `governance-row.mapper.ts`.
 *
 * @dependencias_externas
 *   - `pg` (`PoolClient`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `pricing_plans_config`, `organization_pricing_overrides`,
 *     `whop_subscriptions`, `voice_sessions`, `audit_logs`.
 */

import type { PoolClient } from 'pg';
import type {
  TenantGovernanceDetails,
  GlobalPricingPlanEntity,
  TenantPricingOverrideEntity,
  PlatformTelemetrySnapshot,
  OrganizationGovernanceStatus,
} from '../domain/governance.entities';
import {
  mapOrganizationRowToGovernanceDetails,
  mapPricingPlanRowToEntity,
  mapPricingOverrideRowToEntity,
  type OrganizationSqlRow,
  type PricingPlanSqlRow,
  type PricingOverrideSqlRow,
} from './governance-row.mapper';

/** Repositorio de operaciones administrativas de gobierno de plataforma. */
export class PostgresGovernanceAdminRepository {
  /**
   * Actualiza el estado administrativo de una organizacion (Suspender / Reactivar).
   */
  public async updateOrganizationStatus(
    client: PoolClient,
    orgId: string,
    status: OrganizationGovernanceStatus,
    reason: string | null,
    superAdminId: string
  ): Promise<TenantGovernanceDetails | null> {
    const isSuspended = status === 'SUSPENDED';
    const now = new Date();

    const res = await client.query<OrganizationSqlRow>(
      `UPDATE organizations
       SET status = $1,
           suspended_reason = $2,
           suspended_at = $3,
           suspended_by_user_id = $4,
           updated_at = $5
       WHERE id = $6
       RETURNING *`,
      [
        status,
        isSuspended ? reason : null,
        isSuspended ? now : null,
        isSuspended ? superAdminId : null,
        now,
        orgId,
      ]
    );

    const row = res.rows[0];
    return row ? mapOrganizationRowToGovernanceDetails(row) : null;
  }

  /**
   * Obtiene una organizacion con sus datos de suscripcion activa cruzados.
   */
  public async getOrganizationById(client: PoolClient, orgId: string): Promise<TenantGovernanceDetails | null> {
    const res = await client.query<OrganizationSqlRow>(
      `SELECT o.*, s.plan_code as sub_plan_code, s.credit_balance_usd, s.hard_spend_cap_usd
       FROM organizations o
       LEFT JOIN whop_subscriptions s ON s.organization_id = o.id
       WHERE o.id = $1`,
      [orgId]
    );
    const row = res.rows[0];
    return row ? mapOrganizationRowToGovernanceDetails(row) : null;
  }

  /**
   * Lista todas las organizaciones de la plataforma con filtros y paginacion.
   */
  public async listOrganizations(
    client: PoolClient,
    options: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined }
  ): Promise<readonly TenantGovernanceDetails[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    let query = `
      SELECT o.*, s.plan_code as sub_plan_code, s.credit_balance_usd, s.hard_spend_cap_usd
      FROM organizations o
      LEFT JOIN whop_subscriptions s ON s.organization_id = o.id
    `;
    const params: unknown[] = [];

    if (options.status) {
      params.push(options.status);
      query += ` WHERE o.status = $${params.length}`;
    }

    params.push(limit, offset);
    query += ` ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const res = await client.query<OrganizationSqlRow>(query, params);
    return res.rows.map(mapOrganizationRowToGovernanceDetails);
  }

  /**
   * Obtiene la configuracion de un plan de precios global por codigo.
   */
  public async getPricingPlan(client: PoolClient, planCode: string): Promise<GlobalPricingPlanEntity | null> {
    const res = await client.query<PricingPlanSqlRow>(
      `SELECT * FROM pricing_plans_config WHERE plan_code = $1`,
      [planCode]
    );
    const row = res.rows[0];
    return row ? mapPricingPlanRowToEntity(row) : null;
  }

  /**
   * Lista todos los planes configurados en la matriz global.
   */
  public async listPricingPlans(client: PoolClient): Promise<readonly GlobalPricingPlanEntity[]> {
    const res = await client.query<PricingPlanSqlRow>(
      `SELECT * FROM pricing_plans_config ORDER BY monthly_fixed_price_usd ASC`
    );
    return res.rows.map(mapPricingPlanRowToEntity);
  }

  /**
   * Inserta o actualiza un plan de la matriz global de precios Whop.
   */
  public async upsertPricingPlan(
    client: PoolClient,
    plan: {
      planCode: string;
      whopPlanId: string;
      displayName: string;
      monthlyFixedPriceUsd: string;
      includedMinutes: string;
      baseOverageRatePerMinuteUsd: string;
      overageAllowed: boolean;
      volumeDiscountEligible: boolean;
      volumeDiscountTiersJson: readonly unknown[];
      isActive: boolean;
      superAdminId: string;
    }
  ): Promise<GlobalPricingPlanEntity> {
    const res = await client.query<PricingPlanSqlRow>(
      `INSERT INTO pricing_plans_config (
        plan_code, whop_plan_id, display_name, monthly_fixed_price_usd, included_minutes,
        base_overage_rate_per_minute_usd, overage_allowed, volume_discount_eligible,
        volume_discount_tiers_json, is_active, updated_by_superadmin_id, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (plan_code) DO UPDATE SET
        whop_plan_id = EXCLUDED.whop_plan_id,
        display_name = EXCLUDED.display_name,
        monthly_fixed_price_usd = EXCLUDED.monthly_fixed_price_usd,
        included_minutes = EXCLUDED.included_minutes,
        base_overage_rate_per_minute_usd = EXCLUDED.base_overage_rate_per_minute_usd,
        overage_allowed = EXCLUDED.overage_allowed,
        volume_discount_eligible = EXCLUDED.volume_discount_eligible,
        volume_discount_tiers_json = EXCLUDED.volume_discount_tiers_json,
        is_active = EXCLUDED.is_active,
        updated_by_superadmin_id = EXCLUDED.updated_by_superadmin_id,
        updated_at = NOW()
      RETURNING *`,
      [
        plan.planCode,
        plan.whopPlanId,
        plan.displayName,
        plan.monthlyFixedPriceUsd,
        plan.includedMinutes,
        plan.baseOverageRatePerMinuteUsd,
        plan.overageAllowed,
        plan.volumeDiscountEligible,
        JSON.stringify(plan.volumeDiscountTiersJson),
        plan.isActive,
        plan.superAdminId,
      ]
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error(`Fallo al guardar el plan de precios ${plan.planCode}`);
    }
    return mapPricingPlanRowToEntity(row);
  }

  /**
   * Obtiene el override tarifario vigente para una organizacion.
   */
  public async getPricingOverride(client: PoolClient, orgId: string): Promise<TenantPricingOverrideEntity | null> {
    const res = await client.query<PricingOverrideSqlRow>(
      `SELECT * FROM organization_pricing_overrides WHERE organization_id = $1`,
      [orgId]
    );
    const row = res.rows[0];
    return row ? mapPricingOverrideRowToEntity(row) : null;
  }

  /**
   * Crea o actualiza un override de tarifas para un cliente.
   */
  public async upsertPricingOverride(
    client: PoolClient,
    override: {
      organizationId: string;
      customRatePerMinuteUsd: string | null;
      manualDiscountPercentage: number;
      forceVolumeDiscountTiers: boolean;
      customVolumeTiersJson: readonly unknown[] | null;
      overrideNotes: string;
      effectiveUntil: string | null;
      superAdminId: string;
    }
  ): Promise<TenantPricingOverrideEntity> {
    const res = await client.query<PricingOverrideSqlRow>(
      `INSERT INTO organization_pricing_overrides (
        organization_id, custom_rate_per_minute_usd, manual_discount_percentage,
        force_volume_discount_tiers, custom_volume_tiers_json, override_notes,
        effective_until, created_by_superadmin_id, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (organization_id) DO UPDATE SET
        custom_rate_per_minute_usd = EXCLUDED.custom_rate_per_minute_usd,
        manual_discount_percentage = EXCLUDED.manual_discount_percentage,
        force_volume_discount_tiers = EXCLUDED.force_volume_discount_tiers,
        custom_volume_tiers_json = EXCLUDED.custom_volume_tiers_json,
        override_notes = EXCLUDED.override_notes,
        effective_until = EXCLUDED.effective_until,
        updated_at = NOW()
      RETURNING *`,
      [
        override.organizationId,
        override.customRatePerMinuteUsd,
        override.manualDiscountPercentage,
        override.forceVolumeDiscountTiers,
        override.customVolumeTiersJson ? JSON.stringify(override.customVolumeTiersJson) : null,
        override.overrideNotes,
        override.effectiveUntil,
        override.superAdminId,
      ]
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error(`Fallo al guardar override para la organizacion ${override.organizationId}`);
    }
    return mapPricingOverrideRowToEntity(row);
  }

  /**
   * Elimina un override personalizado restableciendo la tarificacion base Whop.
   */
  public async deletePricingOverride(client: PoolClient, orgId: string): Promise<boolean> {
    const res = await client.query(
      `DELETE FROM organization_pricing_overrides WHERE organization_id = $1`,
      [orgId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Acredita minutos promocionales de cortesia en la suscripcion del tenant.
   */
  public async creditPromotionalMinutes(
    client: PoolClient,
    orgId: string,
    minutesToAdd: string,
    _reason: string
  ): Promise<boolean> {
    const res = await client.query(
      `UPDATE whop_subscriptions
       SET period_included_minutes_remaining = period_included_minutes_remaining + $1::numeric,
           updated_at = NOW()
       WHERE organization_id = $2`,
      [minutesToAdd, orgId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Computa la instantanea de telemetria consolidada de la plataforma.
   */
  public async getPlatformTelemetrySnapshot(
    client: PoolClient,
    killSwitchActive: boolean,
    killSwitchReason: string | null
  ): Promise<PlatformTelemetrySnapshot> {
    const orgsRes = await client.query<{ total: string; suspended: string }>(
      `SELECT
        COUNT(*)::text as total,
        COUNT(CASE WHEN status = 'SUSPENDED' THEN 1 END)::text as suspended
       FROM organizations`
    );

    const voiceRes = await client.query<{ active_sessions: string }>(
      `SELECT COUNT(*)::text as active_sessions FROM voice_sessions WHERE status = 'ACTIVE_STREAMING'`
    );

    const securityRes = await client.query<{ incidents: string }>(
      `SELECT COUNT(*)::text as incidents
       FROM audit_logs
       WHERE severity = 'CRITICAL_SECURITY' AND created_at >= NOW() - INTERVAL '24 hours'`
    );

    const total = Number(orgsRes.rows[0]?.total ?? '0');
    const suspended = Number(orgsRes.rows[0]?.suspended ?? '0');
    const activeSessions = Number(voiceRes.rows[0]?.active_sessions ?? '0');
    const recentIncidents = Number(securityRes.rows[0]?.incidents ?? '0');

    return Object.freeze({
      timestampIso: new Date().toISOString(),
      activeVoiceSessionsCount: activeSessions,
      totalOrganizationsCount: total,
      suspendedOrganizationsCount: suspended,
      voiceAiKillSwitchActive: killSwitchActive,
      voiceAiKillSwitchReason: killSwitchReason,
      recentSecurityIncidentsCount: recentIncidents,
    });
  }
}
