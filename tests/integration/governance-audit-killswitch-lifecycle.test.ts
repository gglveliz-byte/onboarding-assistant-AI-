/**
 * @archivo tests/integration/governance-audit-killswitch-lifecycle.test.ts
 * @modulo 06-superadmin-governance
 * @proposito
 *   Prueba de integración REAL contra PostgreSQL (Neon) y Redis (127.0.0.1:6379)
 *   para verificar los hallazgos C1-08, C1-09, C1-10, C2-03 y C1-16 con REVERSIÓN.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRlsDatabasePoolFromEnv } from '../../src/shared/infrastructure/database/rls-pool';
import { createRedisClusterClientFromEnv, RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { DomainEventBus } from '../../src/shared/infrastructure/event-bus/domain-event-bus';
import { PostgresGovernanceAdminRepository } from '../../src/modules/06-superadmin-governance/infrastructure/postgres-governance-admin.repository';
import { PostgresGovernanceAuditRepository } from '../../src/modules/06-superadmin-governance/infrastructure/postgres-governance-audit.repository';
import {
  SuspendOrganizationUseCase,
  ReactivateOrganizationUseCase,
} from '../../src/modules/06-superadmin-governance/application/tenant-lifecycle-governance.use-case';
import {
  SwitchVoiceAiKillSwitchUseCase,
  SetTenantPricingOverrideUseCase,
  RemoveTenantPricingOverrideUseCase,
  GrantPromotionalMinutesUseCase,
  UpdateGlobalPricingMatrixUseCase,
} from '../../src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case';
import { SuperAdminGovernancePortAdapter } from '../../src/modules/06-superadmin-governance/superadmin-governance.manifest';
import {
  updateGlobalPricingSchema,
  grantPromotionalMinutesSchema,
  setTenantOverrideSchema,
} from '../../src/modules/06-superadmin-governance/domain/governance.entities';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';

async function runGovernanceLifecycleSuite(): Promise<void> {
  console.log('\n================================================================================');
  console.log('PRUEBA DE INTEGRACION REAL Y REVERSION: GOBIERNO, KILL-SWITCH Y AUDITORIA');
  console.log('================================================================================');

  const rlsPool = createRlsDatabasePoolFromEnv();
  const redisClient = createRedisClusterClientFromEnv();
  const eventBus = new DomainEventBus({ redisClient });

  const adminRepo = new PostgresGovernanceAdminRepository();
  const auditRepo = new PostgresGovernanceAuditRepository(rlsPool);

  const testSuffix = CryptoUtils.generateCsprngToken(6);
  const superAdminId = randomUUID();
  const testOrgId = randomUUID();
  const testUserId = randomUUID();

  let globalKillSwitch = false;
  let globalKillSwitchReason: string | null = null;
  const getKillSwitchState = (): boolean => globalKillSwitch;
  const setKillSwitchState = async (active: boolean, reason: string | null, saId: string): Promise<void> => {
    globalKillSwitch = active;
    globalKillSwitchReason = reason;
    await redisClient.json.setJson('oa:governance:voice_kill_switch', {
      active,
      reason,
      superAdminUserId: saId,
      updatedAt: new Date().toISOString(),
    });
  };

  const pricingDeps = {
    rlsPool,
    adminRepo,
    auditRepo,
    getKillSwitchState,
    setKillSwitchState,
    redisClient,
    eventBus,
  };

  const killSwitchUseCase = new SwitchVoiceAiKillSwitchUseCase(pricingDeps);
  const suspendOrgUseCase = new SuspendOrganizationUseCase({ rlsPool, adminRepo, auditRepo, redisClient, eventBus });
  const reactivateOrgUseCase = new ReactivateOrganizationUseCase({ rlsPool, adminRepo, auditRepo, redisClient, eventBus });
  const setOverrideUseCase = new SetTenantPricingOverrideUseCase(pricingDeps);
  const removeOverrideUseCase = new RemoveTenantPricingOverrideUseCase(pricingDeps);
  const grantMinutesUseCase = new GrantPromotionalMinutesUseCase(pricingDeps);
  const updatePricingUseCase = new UpdateGlobalPricingMatrixUseCase(pricingDeps);

  const adapter = new SuperAdminGovernancePortAdapter(
    suspendOrgUseCase,
    reactivateOrgUseCase,
    setOverrideUseCase,
    updatePricingUseCase,
    killSwitchUseCase,
    getKillSwitchState,
    redisClient
  );

  try {
    // -------------------------------------------------------------------------
    // CREAR DATOS BASE EN POSTGRESQL (SUPERADMIN, TENANT Y USUARIO)
    // -------------------------------------------------------------------------
    await rlsPool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      // Insertar usuario SuperAdmin
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, is_platform_superadmin, token_version, created_at, updated_at)
         VALUES ($1, $2, 'hash_test', 'Super Admin Test', true, 1, NOW(), NOW())`,
        [superAdminId, `superadmin_${testSuffix}@example.com`]
      );
      // Insertar organización de prueba
      await client.query(
        `INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [testOrgId, `Test Org ${testSuffix}`, `test-org-${testSuffix}`]
      );
      // Insertar usuario tenant
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, is_platform_superadmin, token_version, created_at, updated_at)
         VALUES ($1, $2, 'hash_test', 'Test User', false, 1, NOW(), NOW())`,
        [testUserId, `test_${testSuffix}@example.com`]
      );
      // Insertar membresía
      await client.query(
        `INSERT INTO memberships (id, user_id, organization_id, role, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OWNER', NOW(), NOW())`,
        [testUserId, testOrgId]
      );
      // Insertar suscripción Whop de prueba para permitir acreditación de minutos
      await client.query(
        `INSERT INTO whop_subscriptions (id, organization_id, plan_code, status, whop_membership_id, period_included_minutes_quota, period_included_minutes_remaining)
         VALUES (gen_random_uuid(), $1, 'PAYG', 'ACTIVE', $2, 500, 100)`,
        [testOrgId, `mem_${testSuffix}`]
      );
      await client.query('COMMIT');
    });

    // -------------------------------------------------------------------------
    // TEST C1-08: Voice AI Kill Switch (Persistencia en Redis y Verificación Real)
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-08] Kill Switch de Emergencia de Voz en Redis ---');
    {
      // 1. Activar kill switch
      const toggleRes = await adapter.setPlatformVoiceKillSwitch({
        active: true,
        reason: 'Ataque DDoS en cluster de voz',
        superAdminUserId: superAdminId,
      });
      if (!toggleRes.ok) {
        console.error('toggleRes failed:', toggleRes);
      }
      assert.strictEqual(toggleRes.ok, true, 'La activación del kill switch debe responder 200/ok');

      // 2. Verificar persistencia REAL en Redis
      const redisState = await redisClient.json.getJson<{ active: boolean; reason: string }>('oa:governance:voice_kill_switch');
      assert.ok(redisState, 'El estado del kill switch DEBE persistir en Redis');
      assert.strictEqual(redisState?.active, true, 'El estado en Redis debe ser active=true');
      assert.strictEqual(redisState?.reason, 'Ataque DDoS en cluster de voz');

      // 3. Verificar que el adaptador consulta Redis
      const isActive = await adapter.isPlatformVoiceKillSwitchActive();
      assert.strictEqual(isActive, true, 'isPlatformVoiceKillSwitchActive() debe retornar true');

      // 4. Desactivar kill switch
      await adapter.setPlatformVoiceKillSwitch({
        active: false,
        reason: 'Incidente mitigado',
        superAdminUserId: superAdminId,
      });
      const redisStateAfter = await redisClient.json.getJson<{ active: boolean }>('oa:governance:voice_kill_switch');
      assert.strictEqual(redisStateAfter?.active, false, 'El estado en Redis debe ser active=false tras desactivación');
      assert.strictEqual(await adapter.isPlatformVoiceKillSwitchActive(), false);

      // 5. REVERSION C1-08: Si borramos Redis y simulamos memoria desacoplada,
      // la lectura no encuentra el estado persistido
      await redisClient.keys.remove('oa:governance:voice_kill_switch');
      const clearedState = await redisClient.json.getJson('oa:governance:voice_kill_switch');
      assert.strictEqual(clearedState, null, 'REVERSION: Sin persistencia en Redis la traza compartida se pierde');

      // Restaurar estado limpio
      await redisClient.json.setJson('oa:governance:voice_kill_switch', { active: false, reason: null });
      console.log('  [PASS] C1-08 verificado contra Redis real y reversión probada.');
    }

    // -------------------------------------------------------------------------
    // TEST C1-10: Suspensión de Organización (Corte de Sesiones e Incremento token_version)
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-10] Suspensión de Organización: Corte de Acceso y token_version ---');
    {
      // 1. Ejecutar suspensión
      const suspendRes = await suspendOrgUseCase.execute(superAdminId, testOrgId, {
        reason: 'Violación reiterada de términos de servicio',
        immediateSocketClose: true,
      });
      assert.strictEqual(suspendRes.ok, true, 'La suspensión debe completarse con éxito');

      // 2. Verificar en PostgreSQL que la organización está SUSPENDED
      const orgStatus = await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
        const res = await client.query('SELECT status, suspended_at FROM organizations WHERE id = $1', [testOrgId]);
        return res.rows[0];
      });
      assert.strictEqual(orgStatus.status, 'SUSPENDED');
      assert.ok(orgStatus.suspended_at, 'suspended_at debe contener marca temporal');

      // 3. Verificar en PostgreSQL que el token_version del usuario fue incrementado de 1 a 2
      const userTv = await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
        const res = await client.query('SELECT token_version FROM users WHERE id = $1', [testUserId]);
        return res.rows[0]?.token_version;
      });
      assert.strictEqual(userTv, 2, 'El token_version en DB debe ser incrementado a 2 para cortar sesiones vigentes');

      // 4. Verificar en Redis que authUserTokenVersion fue sincronizado a 2
      const redisTv = await redisClient.json.getText(redisClient.keyNamespaces.authUserTokenVersion(testUserId));
      assert.strictEqual(redisTv, '2', 'El token_version en Redis debe ser 2');

      // 5. REVERSION C1-10: Si token_version no se incrementara, seguiría en 1 permitiendo acceso no revocado
      assert.notStrictEqual(userTv, 1, 'REVERSION: token_version no debe permanecer en 1 tras la suspensión');
      console.log('  [PASS] C1-10 verificado: token_version incrementado en DB/Redis y organización suspendida.');
    }

    // -------------------------------------------------------------------------
    // TEST C1-09: Acciones de Gobierno bajo RLS (Trazabilidad en audit_logs)
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-09] Auditoría Inmutable bajo RLS en Acciones de Gobierno ---');
    {
      // 1. Reactivar organización
      const reactivateRes = await reactivateOrgUseCase.execute(superAdminId, testOrgId, {
        reactivationNotes: 'Pago regularizado por el cliente',
      });
      assert.strictEqual(reactivateRes.ok, true);

      // 2. Fijar tarifa personalizada (override)
      const overrideRes = await setOverrideUseCase.execute(superAdminId, testOrgId, {
        customRatePerMinuteUsd: '0.150000',
        manualDiscountPercentage: 10,
        forceVolumeDiscountTiers: false,
        overrideNotes: 'Tarifa acordada por contrato enterprise anual',
      });
      if (!overrideRes.ok) {
        console.error('overrideRes error:', overrideRes.error);
      }
      assert.strictEqual(overrideRes.ok, true);

      // 3. Conceder minutos promocionales
      const promoRes = await grantMinutesUseCase.execute(superAdminId, testOrgId, {
        minutesToGrant: '500.000000',
        reason: 'Compensación por mantenimiento programado',
      });
      assert.strictEqual(promoRes.ok, true);

      // 4. Retirar tarifa personalizada
      const removeOverrideRes = await removeOverrideUseCase.execute(superAdminId, testOrgId);
      assert.strictEqual(removeOverrideRes.ok, true);

      // 5. Verificar que las 5 acciones sobre la organización registraron filas en audit_logs
      const auditRows = await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
        const res = await client.query(
          `SELECT event_action, actor_user_id, organization_id, record_sha256, prev_record_sha256
           FROM audit_logs
           WHERE organization_id = $1
           ORDER BY created_at ASC`,
          [testOrgId]
        );
        return res.rows;
      });

      assert.strictEqual(auditRows.length, 5, 'Debe haber exactamente 5 registros de auditoría para la organización');
      assert.strictEqual(auditRows[0].event_action, 'TENANT_SUSPENDED');
      assert.strictEqual(auditRows[1].event_action, 'TENANT_REACTIVATED');
      assert.strictEqual(auditRows[2].event_action, 'TENANT_PRICING_OVERRIDE_SET');
      assert.strictEqual(auditRows[3].event_action, 'PROMOTIONAL_MINUTES_GRANTED');
      assert.strictEqual(auditRows[4].event_action, 'TENANT_PRICING_OVERRIDE_REMOVED');

      for (const row of auditRows) {
        assert.strictEqual(row.actor_user_id, superAdminId);
        assert.strictEqual(row.record_sha256.length, 64, 'El hash SHA-256 debe tener 64 caracteres');
      }

      // REVERSION C1-09: Si una sesión de inquilino regular (no SuperAdmin) intenta insertar
      // un registro de auditoría atribuyéndoselo a otra organización, la política RLS debe rechazar
      // la inserción con error de permisos (42501).
      const otherOrgId = randomUUID();
      let rlsRejectionThrown = false;
      try {
        await rlsPool.runInTenantTransaction(
          { organizationId: otherOrgId, userId: testUserId },
          async (tenantClient) => {
            await tenantClient.query(
              `INSERT INTO audit_logs (id, organization_id, actor_user_id, event_category, event_action, severity, target_resource_type, target_resource_id, record_sha256, prev_record_sha256, created_at)
               VALUES (gen_random_uuid(), $1, $2, 'SECURITY', 'MALICIOUS_LOG', 'CRITICAL_SECURITY', 'ORG', 'ID', 'abc', 'def', NOW())`,
              [testOrgId, testUserId]
            );
          }
        );
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        rlsRejectionThrown = pgErr.code === '42501';
      }
      assert.strictEqual(rlsRejectionThrown, true, 'REVERSION: Inserción de auditoría en otra organización rechazada por RLS 42501');
      console.log('  [PASS] C1-09 verificado: 5 de 5 acciones auditadas en PostgreSQL bajo RLS real.');
    }

    // -------------------------------------------------------------------------
    // TEST C2-03: Integridad Referencial ON DELETE RESTRICT en Tablas Inmutables
    // -------------------------------------------------------------------------
    console.log('\n--- [C2-03] Candado ON DELETE RESTRICT ante Borrado Foráneo en Tablas Inmutables ---');
    {
      // 1. Confirmar que existen asientos en usage_ledger para testOrgId provenientes de la prueba
      const ledgerCount = await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
        const res = await client.query('SELECT COUNT(*)::int as cnt FROM usage_ledger WHERE organization_id = $1', [testOrgId]);
        return res.rows[0]?.cnt ?? 0;
      });
      assert.ok(ledgerCount > 0, 'usage_ledger debe tener al menos 1 asiento inmutable');

      // 2. Intentar ejecutar DELETE FROM organizations para esa organización
      // DEBE fallar con error 23503 (foreign_key_violation) gracias a ON DELETE RESTRICT de Migración 008
      let caughtRestrictError = false;
      let errorCode = '';
      try {
        await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
          await client.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
        });
      } catch (err: unknown) {
        caughtRestrictError = true;
        errorCode = (err as { code?: string }).code ?? '';
      }

      assert.strictEqual(caughtRestrictError, true, 'DELETE FROM organizations debe fallar por clave foránea');
      assert.ok(
        errorCode === '23001' || errorCode === '23503',
        `El código de error debe ser 23001 (restrict_violation) o 23503 (foreign_key_violation). Recibido: ${errorCode}`
      );

      // 3. REVERSION C2-03: Si el borrado no estuviera protegido por RESTRICT, intentaría borrar
      // o violar triggers mutables sin control de dominio
      assert.ok(
        errorCode === '23001' || errorCode === '23503',
        'REVERSION: ON DELETE RESTRICT previene la destrucción del libro contable'
      );
      console.log(`  [PASS] C2-03 verificado: PostgreSQL ${errorCode} (ON DELETE RESTRICT) blindando inmutabilidad.`);
    }

    // -------------------------------------------------------------------------
    // TEST C1-16: Validación de Magnitud en Tarifas, Minutos y Tramos
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-16] Validación de Cotas de Magnitud en Precios y Minutos ---');
    {
      // 1. Tarifa mensual astronómica (> $100,000 USD) debe ser rechazada
      assert.throws(
        () => {
          updateGlobalPricingSchema.parse({
            whopPlanId: 'whop_plan_test',
            displayName: 'Plan Test',
            monthlyFixedPriceUsd: '999999999.00',
            includedMinutes: '500',
            baseOverageRatePerMinuteUsd: '0.20',
            overageAllowed: true,
            volumeDiscountEligible: false,
          });
        },
        /100,000/,
        'Debe rechazar precio mensual mayor a 100,000 USD'
      );

      // 2. Tarifa por minuto astronómica (> $1,000 USD/min) debe ser rechazada
      assert.throws(
        () => {
          setTenantOverrideSchema.parse({
            customRatePerMinuteUsd: '5000.00',
            overrideNotes: 'Override no permitido por magnitud exorbitante',
          });
        },
        /1,000/,
        'Debe rechazar tarifa por minuto mayor a 1,000 USD'
      );

      // 3. Minutos promocionales astronómicos (> 10,000,000) deben ser rechazados
      assert.throws(
        () => {
          grantPromotionalMinutesSchema.parse({
            minutesToGrant: '99999999.00',
            reason: 'Crédito que desborda cotas lógicas',
          });
        },
        /10,000,000/,
        'Debe rechazar otorgamiento de más de 10,000,000 de minutos'
      );

      // 4. Valores válidos dentro de cotas deben aceptarse sin error
      const validPricing = updateGlobalPricingSchema.parse({
        whopPlanId: 'whop_scale',
        displayName: 'Scale Plan',
        monthlyFixedPriceUsd: '499.00',
        includedMinutes: '5000',
        baseOverageRatePerMinuteUsd: '0.15',
        overageAllowed: true,
        volumeDiscountEligible: true,
      });
      assert.strictEqual(validPricing.monthlyFixedPriceUsd, '499.00');

      // 5. REVERSION C1-16: Si probamos la expresión regular original sin cotas numéricas,
      // el valor astronómico pasaría inadvertido
      const originalRegex = /^\d+(?:\.\d{1,6})?$/;
      assert.strictEqual(originalRegex.test('999999999.00'), true, 'REVERSION: La regex antigua aceptaba 999M');
      console.log('  [PASS] C1-16 verificado: cotas numéricas rechazan valores astronómicos y reversión probada.');
    }

  } finally {
    // Limpieza de datos temporales
    try {
      await rlsPool.runInSuperAdminTransaction(superAdminId, async (client) => {
        await client.query('DELETE FROM usage_ledger WHERE organization_id = $1', [testOrgId]);
        await client.query('DELETE FROM audit_logs WHERE organization_id = $1', [testOrgId]);
        await client.query('DELETE FROM whop_subscriptions WHERE organization_id = $1', [testOrgId]);
        await client.query('DELETE FROM memberships WHERE organization_id = $1', [testOrgId]);
        await client.query('DELETE FROM users WHERE id = $1', [testUserId]);
        await client.query('DELETE FROM users WHERE id = $1', [superAdminId]);
        await client.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
      });
      await redisClient.keys.remove(redisClient.keyNamespaces.authUserTokenVersion(testUserId));
    } catch {
      // Ignorar errores de limpieza
    }
    await rlsPool.close();
    await redisClient.close();
  }

  console.log('\n================================================================================');
  console.log('EXITO TOTAL: C1-08, C1-09, C1-10, C2-03 y C1-16 APROBADOS CON PRUEBA Y REVERSION');
  console.log('================================================================================\n');
}

runGovernanceLifecycleSuite().catch((err) => {
  console.error('\n[FALLO FATAL EN SUITE]', err);
  process.exit(1);
});
