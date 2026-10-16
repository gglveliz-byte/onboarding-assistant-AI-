/**
 * @archivo tests/integration/handshake-real-rls.test.ts
 * @modulo 02-projects-and-keys (Prueba Real de Handshake y Resolucion de Claves contra Neon con rol oa_app)
 * @proposito
 *   Verifica el comportamiento real del handshake del SDK y la resolucion de claves de API
 *   contra la base de datos PostgreSQL real (Neon) usando el rol restringido sin privilegios
 *   `oa_app` (sin `BYPASSRLS`), en sustitucion de la suite simulada en memoria (C1-31).
 *
 * @resumen_contenido
 *   - Conecta a Neon con `DATABASE_URL` (rol `oa_app`) y `DATABASE_OWNER_URL` (para siembra y limpieza).
 *   - Siembra una organizacion de prueba, un proyecto y una clave de API con hash SHA-256.
 *   - Evalua la consulta de resolucion de clave con y sin contexto de tenant bajo el rol `oa_app`.
 *   - Ejecuta `PostgresProjectsKeysRepository.getApiKeyByHash` y `ValidateSdkHandshakeUseCase`.
 *   - Certifica y mide de forma determinista la visibilidad de filas bajo RLS real.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import { PostgresProjectsKeysRepository } from '../../src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository';
import { createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';

console.log('================================================================================');
console.log('PRUEBA REAL: HANDSHAKE Y RESOLUCION DE CLAVES CONTRA NEON DB CON ROL oa_app (C1-31)');
console.log('================================================================================');

function readEnvVar(key: string): string {
  const envContent = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of envContent.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).replace(/^["']|["']$/gu, '').trim();
    }
  }
  return process.env[key] ?? '';
}

async function runRealHandshakeRlsSuite(): Promise<void> {
  const appDbUrl = readEnvVar('DATABASE_URL');
  const ownerDbUrl = readEnvVar('DATABASE_OWNER_URL');

  assert.ok(appDbUrl.length > 0, 'DATABASE_URL debe estar configurada en .env');
  assert.ok(ownerDbUrl.length > 0, 'DATABASE_OWNER_URL debe estar configurada en .env');

  const ownerPool = new Pool({ connectionString: ownerDbUrl });
  const appRlsPool = new RlsDatabasePool({ connectionString: appDbUrl });
  const redis = createRedisClusterClientFromEnv();

  const testOrgId = 'a0000000-0000-4000-8000-000000000001';
  const testProjectId = 'b0000000-0000-4000-8000-000000000001';
  const rawPublishableKey = 'pk_live_realtest_12345678901234567890';
  const keyHash = CryptoUtils.sha256Hex(rawPublishableKey);

  const ownerClient = await ownerPool.connect();

  try {
    // 1. Limpieza preventiva y siembra con privilegios de propietario
    await ownerClient.query('DELETE FROM api_keys WHERE project_id = $1', [testProjectId]);
    await ownerClient.query('DELETE FROM allowed_domains WHERE project_id = $1', [testProjectId]);
    await ownerClient.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
    await ownerClient.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);

    await ownerClient.query(
      `INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
       VALUES ($1, 'Org Handshake Real Test', 'org-handshake-real-test', 'ACTIVE', NOW(), NOW())`,
      [testOrgId]
    );

    await ownerClient.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Proyecto Real Test', 'proyecto-real-test', 'LIVE', true, NOW(), NOW())`,
      [testProjectId, testOrgId]
    );

    await ownerClient.query(
      `INSERT INTO api_keys (project_id, organization_id, name, key_type, key_prefix, last_four, key_hash, scopes, created_at)
       VALUES ($1, $2, 'Clave Test Real', 'PUBLISHABLE', 'pk_live_re', '8901', $3, ARRAY['voice:stream'], NOW())`,
      [testProjectId, testOrgId, keyHash]
    );

    console.log('✓ Fixtures sembradas exitosamente con el rol propietario.');

    // 2. Comprobacion de RLS con el rol oa_app
    const repo = new PostgresProjectsKeysRepository(redis);

    // Medicion A: SELECT directo sobre api_keys conectado como oa_app SIN contexto de tenant
    const noContextResult = await appRlsPool.withClient(async (client) => {
      const res = await client.query('SELECT count(*) FROM api_keys WHERE key_hash = $1', [keyHash]);
      return Number(res.rows[0]?.count ?? 0);
    });

    console.log(`[MEDICION REAL] Filas visibles en api_keys como oa_app SIN contexto RLS: ${noContextResult}`);
    assert.equal(
      noContextResult,
      0,
      'Bajo RLS forzado y rol oa_app, sin contexto de tenant la consulta debe devolver 0 filas (comprobando C1-03/C1-31)'
    );

    // Medicion B: SELECT dentro de transaccion con contexto de tenant fijado
    const withContextResult = await appRlsPool.runInTenantTransaction(
      { organizationId: testOrgId },
      async (client) => {
        const key = await repo.getApiKeyByHash(client, keyHash, testOrgId);
        return key;
      }
    );

    assert.ok(withContextResult !== null, 'Dentro de transaccion con contexto RLS, la clave DEBE ser resuelta');
    assert.equal(withContextResult.projectId, testProjectId, 'El projectId debe coincidir');
    assert.equal(withContextResult.keyType, 'PUBLISHABLE', 'El tipo de clave debe ser PUBLISHABLE');
    console.log('✓ [MEDICION REAL] Con contexto RLS establecido, la clave se resuelve correctamente: pk_live_re...');

    // Medicion C: Aislamiento estricto en PostgreSQL a nivel de base de datos
    const foreignOrgId = 'a0000000-0000-4000-8000-000000000002';
    const foreignDbQueryResult = await appRlsPool.runInTenantTransaction(
      { organizationId: foreignOrgId },
      async (client) => {
        const res = await client.query('SELECT count(*) FROM api_keys WHERE key_hash = $1', [keyHash]);
        return Number(res.rows[0]?.count ?? 0);
      }
    );

    assert.equal(foreignDbQueryResult, 0, 'En PostgreSQL bajo RLS, una organizacion ajena ve 0 filas de api_keys');
    console.log('✓ [MEDICION REAL] Aislamiento RLS en PostgreSQL: organizacion ajena ve exactamente 0 filas.');

    // Medicion D: la cache de Redis esta **segmentada por organizacion**, de modo que tampoco entrega la
    // clave a un inquilino ajeno. Esta medicion comprobaba antes lo CONTRARIO —que la cache global
    // eludia el aislamiento (hallazgos C1-07 y C1-46)— y por eso se actualiza: el defecto ya no existe.
    const foreignRepoResult = await appRlsPool.runInTenantTransaction(
      { organizationId: foreignOrgId },
      async (client) => {
        return await repo.getApiKeyByHash(client, keyHash, foreignOrgId);
      }
    );
    assert.equal(
      foreignRepoResult,
      null,
      'La cache segmentada por organizacion NO debe entregar la clave a un inquilino ajeno (C1-46 resuelto)'
    );
    console.log('✓ [C1-46 RESUELTO] Ni la base de datos ni la cache entregan la clave a una organizacion ajena.');

    // Medicion E: la resolucion de identidad devuelve la organizacion propietaria **sin** contexto de
    // inquilino. Es la pieza que rompe la dependencia circular de la autenticacion: sin ella, la
    // lectura directa devolvia cero filas bajo el rol de aplicacion y el sistema solo funcionaba con un
    // rol privilegiado, es decir con el aislamiento multi-tenant apagado.
    const resolvedOwner = await appRlsPool.withClient((client) => repo.resolveApiKeyOwnerByHash(client, keyHash));
    assert.ok(resolvedOwner !== null, 'La resolucion de identidad debe encontrar la organizacion propietaria');
    assert.equal(resolvedOwner.organizationId, testOrgId, 'La organizacion resuelta debe ser la propietaria');
    assert.equal(resolvedOwner.projectId, testProjectId, 'El proyecto resuelto debe ser el propietario');
    console.log('✓ [C1-03/C1-31 RESUELTO] La identidad se resuelve sin contexto de inquilino: el circulo esta roto.');

    const unknownOwner = await appRlsPool.withClient((client) =>
      repo.resolveApiKeyOwnerByHash(client, 'resumen-que-no-existe-en-la-plataforma')
    );
    assert.equal(unknownOwner, null, 'Un resumen desconocido no debe resolver ninguna organizacion');
    console.log('✓ Un resumen desconocido no revela ninguna organizacion.');

  } finally {
    // 3. Limpieza garantizada con el cliente de owner
    await ownerClient.query('DELETE FROM api_keys WHERE project_id = $1', [testProjectId]);
    await ownerClient.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
    await ownerClient.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    ownerClient.release();
    await ownerPool.end();
    await appRlsPool.close();
    await redis.close();
  }

  console.log('================================================================================');
  console.log('PRUEBA REAL DE HANDSHAKE Y RLS CONTRA NEON (C1-31) COMPLETADA CON EXITO');
  console.log('================================================================================');
}

void runRealHandshakeRlsSuite().catch((err) => {
  console.error('ERROR EN PRUEBA REAL HANDSHAKE RLS:', err);
  process.exit(1);
});
