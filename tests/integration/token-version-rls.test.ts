/**
 * @archivo tests/integration/token-version-rls.test.ts
 * @modulo Tests de Integracion (Identidad y RLS - C2-08)
 * @proposito
 *   Verifica que `incrementTokenVersion` en PostgresIdentityRepository actualice realmente
 *   la fila del usuario en PostgreSQL bajo politicas RLS (rol oa_app sin BYPASSRLS) y que
 *   la version persistida en base de datos coincida exactamente con la version en cache Redis.
 */

import * as crypto from 'node:crypto';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { PostgresIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository';

async function runTest(): Promise<void> {
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
  const repo = new PostgresIdentityRepository(pool, redis);

  const testUserId = crypto.randomUUID();
  const testOrgId = crypto.randomUUID();
  const testEmail = `test_c2_08_${Date.now()}@example.com`;

  try {
    // 1. Sembrar organizacion y usuario de prueba
    await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query(
        `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [testOrgId, `test-org-${Date.now()}`, 'Test Org C2-08']
      );

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, token_version, created_at, updated_at)
         VALUES ($1, $2, 'dummy_hash', 'Test User C2-08', 1, NOW(), NOW())`,
        [testUserId, testEmail]
      );
      await client.query('COMMIT');
    });

    // 2. Ejecutar incrementTokenVersion a traves del repositorio (sin pasar cliente previo)
    const returnedVersion = await repo.incrementTokenVersion(testUserId);

    if (returnedVersion !== 2) {
      throw new Error(`FALLO: incrementTokenVersion devolvio ${returnedVersion}, se esperaba 2.`);
    }

    // 3. Consultar directamente en PostgreSQL el valor real de token_version
    const dbVersion = await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      const res = await client.query<{ token_version: number }>(
        'SELECT token_version FROM users WHERE id = $1',
        [testUserId]
      );
      await client.query('COMMIT');
      return res.rows[0]?.token_version;
    });

    if (dbVersion !== 2) {
      throw new Error(
        `FALLO (DEFECTO C2-08 DETECTADO): La base de datos tiene version ${dbVersion} pero la funcion devolvio ${returnedVersion}. ` +
        `La fila no fue actualizada en PostgreSQL por bloqueo de RLS.`
      );
    }

    // 4. Consultar en Redis
    const redisVersionStr = await redis.json.getText(RedisKeys.authUserTokenVersion('oa', testUserId));
    if (redisVersionStr !== '2') {
      throw new Error(`FALLO: Redis tiene version ${redisVersionStr}, se esperaba '2'.`);
    }

    // 5. Segundo incremento sucesivo: debe pasar a 3 en ambos lados
    const secondVersion = await repo.incrementTokenVersion(testUserId);
    if (secondVersion !== 3) {
      throw new Error(`FALLO: Segundo incremento devolvio ${secondVersion}, se esperaba 3.`);
    }

    const secondDbVersion = await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      const res = await client.query<{ token_version: number }>(
        'SELECT token_version FROM users WHERE id = $1',
        [testUserId]
      );
      await client.query('COMMIT');
      return res.rows[0]?.token_version;
    });

    if (secondDbVersion !== 3) {
      throw new Error(`FALLO: Segundo incremento en BD resulto en ${secondDbVersion}, se esperaba 3.`);
    }

    process.stdout.write('PASS tests/integration/token-version-rls.test.ts (C2-08 verificado: sincronizacion atomica PostgreSQL + Redis)\n');
  } finally {
    // Limpieza
    try {
      await pool.withClient(async (client) => {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
        await client.query('DELETE FROM users WHERE id = $1', [testUserId]);
        await client.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
        await client.query('COMMIT');
      });
      await redis.close();
      await pool.close();
    } catch {
      // Ignorar errores de limpieza
    }
  }
}

void runTest().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
