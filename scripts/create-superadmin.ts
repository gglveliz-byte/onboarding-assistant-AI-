/**
 * @archivo scripts/create-superadmin.ts
 * @modulo scripts (Aprovisionamiento y Creación de Operador SuperAdmin de Plataforma)
 * @proposito
 *   Permite aprovisionar o ascender un usuario con rol SuperAdmin de plataforma
 *   (users.is_platform_superadmin = true), con contraseña hasheada en Argon2id y
 *   sincronización en Redis del token_version.
 *
 * @uso
 *   npx tsx scripts/create-superadmin.ts <email> <password> "<Nombre Completo>"
 *   o sin argumentos para crear el administrador inicial por defecto.
 */

import { Pool } from 'pg';
import { getEnvConfig } from '../src/config/env.schema';
import { CryptoUtils } from '../src/shared/kernel/crypto.util';
import { createRedisClusterClientFromEnv } from '../src/shared/infrastructure/redis/redis-cluster.client';

async function main() {
  const args = process.argv.slice(2);
  const email = (args[0] || 'admin@plataforma.local').trim().toLowerCase();
  const password = args[1] || 'SuperAdmin2026!Seguro';
  const fullName = args[2] || 'Administrador de Plataforma';

  console.log(`\n=== APROVISIONAMIENTO DE SUPERADMIN ===`);
  console.log(`Correo:   ${email}`);
  console.log(`Nombre:   ${fullName}`);
  console.log(`Clave:    ${'*'.repeat(password.length)}`);

  const env = getEnvConfig();

  // 1. Conexión PostgreSQL Neon
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL_REJECT_UNAUTHORIZED ? { rejectUnauthorized: true } : false,
  });

  try {
    const client = await pool.connect();
    let userId = '';
    try {
      await client.query('BEGIN');
      // Forzar contexto de superadmin para RLS
      await client.query("SELECT set_config('app.is_superadmin', 'true', true)");

      const existing = await client.query('SELECT id, is_platform_superadmin FROM users WHERE email = $1', [email]);

      const passwordHash = await CryptoUtils.hashPasswordArgon2id(password);

      if (existing.rows.length > 0 && existing.rows[0]) {
        userId = existing.rows[0].id;
        console.log(`\n→ El usuario ya existe (ID: ${userId}). Actualizando privilegios a SuperAdmin...`);
        await client.query(
          `UPDATE users 
           SET is_platform_superadmin = TRUE, 
               password_hash = $1, 
               email_verified_at = COALESCE(email_verified_at, NOW()), 
               token_version = token_version + 1,
               locked_until = NULL,
               failed_login_attempts = 0,
               updated_at = NOW() 
           WHERE id = $2`,
          [passwordHash, userId]
        );
      } else {
        console.log('\n→ Creando nuevo usuario SuperAdmin...');
        const insertRes = await client.query(
          `INSERT INTO users (
             email, full_name, password_hash, is_platform_superadmin, token_version, email_verified_at
           ) VALUES ($1, $2, $3, TRUE, 1, NOW())
           RETURNING id, token_version`,
          [email, fullName, passwordHash]
        );
        userId = insertRes.rows[0].id;
      }

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    // 2. Sincronizar token_version en Redis usando el cliente oficial del proyecto
    if (userId.length > 0) {
      try {
        const redisClient = createRedisClusterClientFromEnv();
        await redisClient.json.setText(redisClient.keyNamespaces.authUserTokenVersion(userId), '1');
        await redisClient.close();
      } catch (redisErr) {
        console.warn('⚠️ Nota: Redis no pudo ser actualizado directamente (se actualizará automáticamente en el primer login vía fallback de PostgreSQL):', (redisErr as Error).message);
      }
    }

    console.log('\n✅ ¡SUPERADMIN APROVISIONADO CON ÉXITO!');
    console.log(`ID:           ${userId}`);
    console.log(`Email:        ${email}`);
    console.log(`Clave usada:  ${password}`);
    console.log(`URL Login:    http://localhost:3001/auth/login`);
    console.log(`Consola Admin: http://localhost:3001/superadmin/organizations\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ ERROR AL APROVISIONAR SUPERADMIN:', err);
  process.exit(1);
});
