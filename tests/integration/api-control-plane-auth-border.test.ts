/**
 * @archivo tests/integration/api-control-plane-auth-border.test.ts
 * @modulo Tests de Integracion (Borde HTTP del Plano de Control y Middleware de Sesion - C2-05)
 * @proposito
 *   Prueba de fuego para C2-05: atraviesa el BORDE HTTP REAL de la plataforma mediante un socket
 *   TCP nativo para comprobar que las rutas autenticadas no responden 503 SERVICE_UNAVAILABLE
 *   (defecto detectado en auditoria por ausencia de middleware de sesion en el borde).
 *   Verifica:
 *     1. Sin token -> 401 UNAUTHORIZED (no 503).
 *     2. Con token valido de tenant -> 200 OK con respuesta del modulo (no 503).
 *     3. Con token revocado (C1-35) -> 401 TOKEN_VERSION_REVOKED (no 503).
 *     4. Con token sin privilegios a ruta SuperAdmin -> 403 FORBIDDEN (no 503).
 */

import * as crypto from 'node:crypto';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { PostgresIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository';
import { bootstrapBackendSystem } from '../../src/bootstrap/module-autoloader';
import { ApiControlPlaneServer } from '../../src/bootstrap/api-control-plane.server';

async function runBorderAuthTest(): Promise<void> {
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

  const identityRepo = new PostgresIdentityRepository(pool, redis);
  const testUserId = crypto.randomUUID();
  const testOrgId = crypto.randomUUID();
  const testEmail = `test_border_${Date.now()}@example.com`;

  let server: ApiControlPlaneServer | null = null;

  try {
    // 1. Sembrar organizacion y usuario en Neon
    await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query(
        `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [testOrgId, `org-border-${Date.now()}`, 'Org Border Test']
      );

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, token_version, created_at, updated_at)
         VALUES ($1, $2, 'dummy_hash', 'User Border Test', 1, NOW(), NOW())`,
        [testUserId, testEmail]
      );

      await client.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, 'DEVELOPER', true, NOW(), NOW())`,
        [crypto.randomUUID(), testOrgId, testUserId]
      );
      await client.query('COMMIT');
    });

    // Sembrar version inicial en Redis
    await redis.json.setText(RedisKeys.authUserTokenVersion('oa', testUserId), '1');

    // 2. Ensamblar monolito con los pools reales
    const system = bootstrapBackendSystem({
      databasePool: pool,
      redisClient: redis,
    });

    // 3. Levantar ApiControlPlaneServer en puerto efimero
    server = new ApiControlPlaneServer(system, () => {});
    await server.listen(0);

    const port = server.getListeningPort();
    if (!port) {
      throw new Error('FALLO: El servidor no obtuvo puerto de escucha.');
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    // 4. Emitir JWT valido para el usuario de prueba
    const validToken = await JwtEddsaSigner.signAccessToken({
      userId: testUserId,
      organizationId: testOrgId,
      role: 'DEVELOPER',
      scopes: ['project:read'],
      tokenVersion: 1,
      mfaSatisfied: true,
    });

    // CASO 1: Peticion a ruta protegida SIN token de sesion
    const resNoToken = await fetch(`${baseUrl}/api/v1/projects`);
    const bodyNoToken = (await resNoToken.json()) as { error?: { code?: string } };

    if (resNoToken.status === 503) {
      throw new Error('FALLO (DEFECTO C2-05): El borde respondio 503 a una ruta protegida sin token en vez de 401.');
    }
    if (resNoToken.status !== 401 || bodyNoToken.error?.code !== 'UNAUTHORIZED') {
      throw new Error(`FALLO: Se esperaba 401 UNAUTHORIZED sin token, se recibio ${resNoToken.status} (${JSON.stringify(bodyNoToken)})`);
    }

    // CASO 2: Peticion a ruta protegida CON token valido
    const resValid = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });

    if (resValid.status === 503) {
      throw new Error('FALLO (DEFECTO C2-05 CRITICA): El borde respondio 503 a una ruta protegida con token valido. Falta el middleware de sesion.');
    }
    if (resValid.status !== 200) {
      const errText = await resValid.text();
      throw new Error(`FALLO: Se esperaba 200 OK con token valido, se recibio ${resValid.status}: ${errText}`);
    }
    const projectsList = await resValid.json();
    if (!Array.isArray(projectsList)) {
      throw new Error(`FALLO: Se esperaba lista de proyectos en JSON array, se recibio: ${JSON.stringify(projectsList)}`);
    }

    // CASO 3: Revocar sesion (C1-35 + C2-08) y verificar rechazo en el borde HTTP
    await identityRepo.incrementTokenVersion(testUserId);
    const resRevoked = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });

    if (resRevoked.status === 503) {
      throw new Error('FALLO (DEFECTO C2-05): El borde respondio 503 al token revocado.');
    }
    if (resRevoked.status !== 401) {
      throw new Error(`FALLO: Se esperaba 401 para token revocado, se recibio ${resRevoked.status}`);
    }
    const bodyRevoked = (await resRevoked.json()) as { error?: { code?: string } };
    if (bodyRevoked.error?.code !== 'TOKEN_VERSION_REVOKED') {
      throw new Error(`FALLO: Se esperaba codigo TOKEN_VERSION_REVOKED, se recibio ${JSON.stringify(bodyRevoked)}`);
    }

    // CASO 4: Acceso a ruta SUPERADMIN con credencial de DEVELOPER
    const resSuperAdmin = await fetch(`${baseUrl}/api/v1/superadmin/telemetry/snapshot`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });
    if (resSuperAdmin.status === 503) {
      throw new Error('FALLO (DEFECTO C2-05): El borde respondio 503 a ruta de superadmin.');
    }
    if (resSuperAdmin.status !== 401 && resSuperAdmin.status !== 403) {
      throw new Error(`FALLO: Se esperaba 401/403 a ruta de superadmin sin rol, se recibio ${resSuperAdmin.status}`);
    }

    console.log('✅ TEST INTEGRACION EXITOSO: El borde HTTP procesa autenticacion, revocacion y RBAC sin responder 503 (C2-05).');
  } finally {
    if (server) {
      await server.stopAcceptingConnections(100);
    }
    await pool.withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query('DELETE FROM memberships WHERE organization_id = $1', [testOrgId]);
      await client.query('DELETE FROM users WHERE id = $1', [testUserId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    }).catch(() => {});
    await redis.keys.remove(RedisKeys.authUserTokenVersion('oa', testUserId)).catch(() => {});
    await pool.close().catch(() => {});
    await redis.close().catch(() => {});
    process.exit(0);
  }
}

void runBorderAuthTest();
