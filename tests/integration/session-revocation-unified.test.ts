/**
 * @archivo tests/integration/session-revocation-unified.test.ts
 * @modulo Tests de Integracion (Verificador Unificado de Sesion y Revocacion - C1-35)
 * @proposito
 *   Prueba de fuego para C1-35: verifica que la revocacion de sesiones por `token_version`
 *   se aplique implacablemente en el verificador unificado, tanto cuando la clave reside en Redis
 *   como tras un cache miss / reinicio de Redis donde debe caer a PostgreSQL y rechazar
 *   el token revocado sin asumir nunca validez por defecto.
 */

import * as crypto from 'node:crypto';
import { getEnvConfig } from '../../src/config/env.schema';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { PostgresIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository';
import { UnifiedSessionTokenVerifier } from '../../src/shared/infrastructure/auth/unified-session-verifier';

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

  const identityRepo = new PostgresIdentityRepository(pool, redis);
  const verifier = new UnifiedSessionTokenVerifier(pool, redis);

  const testUserId = crypto.randomUUID();
  const testOrgId = crypto.randomUUID();
  const testEmail = `test_revocation_${Date.now()}@example.com`;

  try {
    // 1. Sembrar organizacion y usuario con token_version = 1
    await pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      await client.query(
        `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [testOrgId, `org-rev-${Date.now()}`, 'Org Revocation Test']
      );

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, token_version, created_at, updated_at)
         VALUES ($1, $2, 'dummy_hash', 'User Revocation Test', 1, NOW(), NOW())`,
        [testUserId, testEmail]
      );
      await client.query('COMMIT');
    });

    // Fijar en Redis version inicial
    await redis.json.setText(RedisKeys.authUserTokenVersion('oa', testUserId), '1');

    // 2. Emitir JWT con token_version = 1
    const tokenV1 = await JwtEddsaSigner.signAccessToken({
      userId: testUserId,
      organizationId: testOrgId,
      role: 'DEVELOPER',
      scopes: ['project:read'],
      tokenVersion: 1,
      mfaSatisfied: true,
    });

    // Asercion 1: El token v1 es valido inicialmente
    const initialVerification = await verifier.verifyAccessTokenAndVersion(tokenV1);
    if (!initialVerification.ok) {
      throw new Error(`FALLO: Token valido fue rechazado: ${initialVerification.reason}`);
    }
    if (initialVerification.actor.userId !== testUserId) {
      throw new Error('FALLO: Actor userId no coincide.');
    }

    // 3. Incrementar version a 2 (revocacion global de todas las sesiones v1)
    const newVersion = await identityRepo.incrementTokenVersion(testUserId);
    if (newVersion !== 2) {
      throw new Error(`FALLO: incrementTokenVersion devolvio ${newVersion}, se esperaba 2.`);
    }

    // Asercion 2: Con la clave en Redis, el token v1 debe ser RECHAZADO con TOKEN_VERSION_REVOKED
    const revokedCheck1 = await verifier.verifyAccessTokenAndVersion(tokenV1);
    if (revokedCheck1.ok) {
      throw new Error('FALLO (DEFECTO C1-35): El verificador acepto un token cuya version fue revocada en Redis.');
    }
    if (revokedCheck1.code !== 'TOKEN_VERSION_REVOKED') {
      throw new Error(`FALLO: Codigo esperado TOKEN_VERSION_REVOKED, recibido ${revokedCheck1.code}`);
    }

    // 4. Simular caida/desalojo de clave en Redis (cache miss total)
    const redisKey = RedisKeys.authUserTokenVersion('oa', testUserId);
    await redis.keys.remove(redisKey);

    const checkCacheMissing = await redis.json.getText(redisKey);
    if (checkCacheMissing !== null) {
      throw new Error('FALLO: La clave de Redis debia haber sido eliminada para simular el desalojo.');
    }

    // Asercion 3: Con Redis vacio, el verificador DEBE caer a PostgreSQL y SEGUIR RECHAZANDO el token v1
    const revokedCheckWithoutCache = await verifier.verifyAccessTokenAndVersion(tokenV1);
    if (revokedCheckWithoutCache.ok) {
      throw new Error(
        'FALLO CRITICO (DEFECTO C1-35 REPRODUCIDO): Al faltar la clave en Redis, el verificador asumio ' +
        'validez y acepto el token revocado en lugar de consultar PostgreSQL.'
      );
    }
    if (revokedCheckWithoutCache.code !== 'TOKEN_VERSION_REVOKED') {
      throw new Error(`FALLO: Codigo esperado TOKEN_VERSION_REVOKED tras fallback a DB, recibido ${revokedCheckWithoutCache.code}`);
    }

    // Asercion 4: El verificador debe haber re-poblado la version en Redis
    const repopulatedVersion = await redis.json.getText(redisKey);
    if (repopulatedVersion !== '2') {
      throw new Error(`FALLO: El fallback debio repoblar Redis con version '2', valor actual: ${repopulatedVersion}`);
    }

    // 5. Emitir nuevo token con version 2
    const tokenV2 = await JwtEddsaSigner.signAccessToken({
      userId: testUserId,
      organizationId: testOrgId,
      role: 'DEVELOPER',
      scopes: ['project:read'],
      tokenVersion: 2,
      mfaSatisfied: true,
    });

    const v2Verification = await verifier.verifyAccessTokenAndVersion(tokenV2);
    if (!v2Verification.ok) {
      throw new Error(`FALLO: Token con version actualizada v2 fue rechazado: ${v2Verification.reason}`);
    }

    process.stdout.write('PASS tests/integration/session-revocation-unified.test.ts (C1-35 verificado: revocacion implacable con fallback DB)\n');
  } finally {
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
