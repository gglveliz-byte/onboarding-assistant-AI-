/**
 * @archivo tests/integration/governance-telemetry-killswitch-real.test.ts
 * @modulo Tests de Integracion (Telemetria de Gobierno y Kill-Switch - C1-04)
 * @proposito
 *   Prueba de fuego para C1-04:
 *     1. Verifica que la telemetria de plataforma (`/api/v1/superadmin/telemetry/snapshot`) se ejecute
 *        dentro de `runInSuperAdminTransaction`, devolviendo las metricas reales de la plataforma
 *        (conteo real de organizaciones > 0) y no 0 filas por culpa del filtrado RLS de `withClient`.
 *     2. Verifica que el adaptador de control del gateway de voz registre sesiones vivas en
 *        `voiceGatewayControl.registerLiveSession()` y que la invocacion del kill-switch
 *        (`terminateAllOrgSessionsImmediately`) corte efectivamente las conexiones activas.
 */

import * as crypto from 'node:crypto';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { bootstrapBackendSystem } from '../../src/bootstrap/module-autoloader';
import { ApiControlPlaneServer } from '../../src/bootstrap/api-control-plane.server';

async function runGovernanceTest(): Promise<void> {
  const env = getEnvConfig();
  const pool = new RlsDatabasePool({
    connectionString: env.DATABASE_URL,
    maxConnections: 5,
    statementTimeoutMs: 10000,
  });
  const redis = new RedisClusterClient({
    clusterUrls: env.REDIS_CLUSTER_URLS,
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
  });

  const superAdminUserId = crypto.randomUUID();
  const testOrgId = crypto.randomUUID();
  const testEmail = `superadmin_test_${Date.now()}@example.com`;
  let server: ApiControlPlaneServer | null = null;

  try {
    // 1. Sembrar SuperAdmin de plataforma y organizacion de prueba en Neon
    await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query(
        `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [testOrgId, `org-gov-${Date.now()}`, 'Org Governance Test']
      );

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, is_platform_superadmin, token_version, created_at, updated_at)
         VALUES ($1, $2, 'dummy_hash', 'SuperAdmin Test', true, 1, NOW(), NOW())`,
        [superAdminUserId, testEmail]
      );
      await client.query('COMMIT');
    });

    await redis.json.setText(RedisKeys.authUserTokenVersion('oa', superAdminUserId), '1');

    // 2. Ensamblar sistema monolito
    const system = bootstrapBackendSystem({
      databasePool: pool,
      redisClient: redis,
    });

    // 3. Levantar ApiControlPlaneServer en puerto efimero
    server = new ApiControlPlaneServer(system, (msg, meta) => {
      process.stdout.write(`[SERVER LOG] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
    });
    await server.listen(0);
    const port = server.getListeningPort();
    if (!port) {
      throw new Error('FALLO: Servidor no obtuvo puerto efimero.');
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    // 4. Emitir JWT firmado para SuperAdmin con permisos requeridos
    const superAdminToken = await JwtEddsaSigner.signAccessToken({
      userId: superAdminUserId,
      organizationId: testOrgId,
      role: 'SUPERADMIN',
      scopes: ['admin:govern_tenants'],
      tokenVersion: 1,
      mfaSatisfied: true,
    });

    // 5. PARTE A: Consulta real al snapshot de telemetria a traves del borde HTTP
    const resTelemetry = await fetch(`${baseUrl}/api/v1/superadmin/telemetry/snapshot`, {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
      },
    });

    if (resTelemetry.status !== 200) {
      const errText = await resTelemetry.text();
      throw new Error(`FALLO: Telemetria devolvio HTTP ${resTelemetry.status}: ${errText}`);
    }

    const telemetryData = (await resTelemetry.json()) as {
      totalOrganizationsCount?: number;
      activeVoiceSessionsCount?: number;
      killSwitchActive?: boolean;
    };

    if (typeof telemetryData.totalOrganizationsCount !== 'number') {
      throw new Error(`FALLO: Telemetria no devolvio totalOrganizationsCount numerico: ${JSON.stringify(telemetryData)}`);
    }

    // Asercion clave de C1-04: Si RLS estuviera bloqueando con withClient, totalOrganizationsCount seria 0
    if (telemetryData.totalOrganizationsCount < 1) {
      throw new Error(`FALLO (DEFECTO C1-04): Telemetria devolvio ${telemetryData.totalOrganizationsCount} organizaciones. Deberia ser >= 1.`);
    }

    // 6. PARTE B: Registro de sesion viva y activacion de Kill-Switch
    let terminatedSignalReceived = false;
    let terminationReasonReceived = '';
    let terminationCodeReceived = 0;
    const testVoiceSessionId = `voice_sess_${Date.now()}`;

    // Simular registro de sesion viva en voiceGatewayControl
    system.voiceGatewayControl.registerLiveSession(
      testVoiceSessionId,
      testOrgId,
      async (closeCode: number, reason: string) => {
        terminatedSignalReceived = true;
        terminationCodeReceived = closeCode;
        terminationReasonReceived = reason;
      }
    );

    const activeCountBefore = system.voiceGatewayControl.countOrganizationSessions(testOrgId);
    if (activeCountBefore !== 1) {
      throw new Error(`FALLO: Se esperaba 1 sesion viva registrada, se conto ${activeCountBefore}`);
    }

    // Ejecutar terminacion masiva inmediata por kill-switch
    const terminationResult = await system.voiceGatewayControl.terminateAllOrgSessionsImmediately(
      testOrgId,
      'EMERGENCIA_SEGURIDAD_TEST',
      1008
    );

    if (terminationResult.terminatedSessionCount !== 1) {
      throw new Error(`FALLO: Se esperaba terminar 1 sesion, se terminaron ${terminationResult.terminatedSessionCount}`);
    }
    if (!terminatedSignalReceived || terminationCodeReceived !== 1008 || terminationReasonReceived !== 'EMERGENCIA_SEGURIDAD_TEST') {
      throw new Error('FALLO: El callback terminate de la sesion viva no recibio la senal de corte esperada.');
    }

    const activeCountAfter = system.voiceGatewayControl.countOrganizationSessions(testOrgId);
    if (activeCountAfter !== 0) {
      throw new Error(`FALLO: Las sesiones vivas no se limpiaron tras el corte masivo. Restantes: ${activeCountAfter}`);
    }

    process.stdout.write(
      `[TELEMETRIA REAL RECIBIDA]: totalOrganizationsCount=${telemetryData.totalOrganizationsCount}, activeVoiceSessionsCount=${telemetryData.activeVoiceSessionsCount}\n`
    );
    process.stdout.write(
      '✅ TEST C1-04 EXITOSO: Telemetria reporta datos reales bajo SuperAdmin y Kill-Switch corta sesiones vivas.\n'
    );
  } catch (error) {
    process.stderr.write(`❌ ERROR EN TEST: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  } finally {
    if (server) {
      await server.stopAcceptingConnections(100);
    }
    await pool.withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query('DELETE FROM users WHERE id = $1', [superAdminUserId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    }).catch(() => {});
    await redis.keys.remove(RedisKeys.authUserTokenVersion('oa', superAdminUserId)).catch(() => {});
    await pool.close().catch(() => {});
    await redis.close().catch(() => {});
    process.exit(0);
  }
}

void runGovernanceTest();
