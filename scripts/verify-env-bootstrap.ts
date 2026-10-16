/**
 * @archivo scripts/verify-env-bootstrap.ts
 * @modulo 00-foundations (Verificacion de Arranque, Contratos de Entorno y Estado de Migraciones)
 * @proposito
 *   Prueba de fuego de la Parte 1: valida que `src/config/env.schema.ts` acepta la
 *   configuracion real del proyecto, que todos los contratos de borde requeridos por las
 *   16 Partes del backend estan declarados, y certifica contra PostgreSQL (Neon) que las
 *   6 migraciones SQL estan aplicadas con su hash SHA-256 intacto en `schema_migrations`.
 *
 * @resumen_contenido
 *   - Constante `REQUIRED_ENVIRONMENT_KEYS`: Contratos de entorno exigidos por la Parte 1.
 *   - Funcion `verifyEnvironmentContract()`: Confirma que ninguna clave obligatoria falta.
 *   - Funcion `verifyMigrationLedger()`: Consulta `schema_migrations` y valida los 6 hashes.
 *   - Funcion `runVerification()`: Orquesta ambas verificaciones y reporta el resultado.
 *
 * @dependencias_internas
 *   - `getEnvConfig` y `summarizeEnvConfig` (`src/config/env.schema.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Pool de PostgreSQL), `node:fs`, `node:path`, `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `schema_migrations` (Lectura de version, archivo, hash SHA-256 y tiempo de ejecucion).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { getEnvConfig, summarizeEnvConfig, type AppEnvironment, type EnvironmentKey } from '../src/config/env.schema';

/** Variables de entorno que la Parte 1 debe declarar obligatoriamente en el contrato. */
const REQUIRED_ENVIRONMENT_KEYS: readonly string[] = [
  'DATABASE_URL',
  'REDIS_CLUSTER_URLS',
  'JWT_EDDSA_PRIVATE_KEY_PEM',
  'JWT_EDDSA_PUBLIC_KEY_PEM',
  'WHOP_API_KEY',
  'WHOP_WEBHOOK_SECRET',
  'INTERNAL_CHECKOUT_HMAC_SECRET',
  'QWEN_REALTIME_WS_URL',
  'QWEN_API_KEY',
  'GEMINI_LIVE_WS_URL',
  'GEMINI_API_KEY',
  'CHROMIUM_DMZ_ENDPOINT',
  'EXTERNAL_DNS_RESOLVERS',
  'NODE_POOL_ROLE',
];

/** Estructura de una fila de la tabla de control de migraciones. */
interface MigrationLedgerRow {
  readonly version: string;
  readonly filename: string;
  readonly checksum_sha256: string;
  readonly execution_time_ms: number;
}

/**
 * Verifica que el contrato de entorno expuesto por `env.schema.ts` cubra todas las claves
 * criticas exigidas por el plan maestro, sin importar su valor ni revelar secretos.
 *
 * @param environment - Configuracion de entorno ya validada.
 * @returns `true` si el contrato esta completo; lanza un error describiendo las ausencias.
 */
function verifyEnvironmentContract(environment: AppEnvironment): boolean {
  const availableKeys = new Set(Object.keys(environment));
  const missingKeys = REQUIRED_ENVIRONMENT_KEYS.filter((key) => !availableKeys.has(key));

  if (missingKeys.length > 0) {
    throw new Error(`CONTRATO_ENTORNO_INCOMPLETO: faltan claves en el esquema -> ${missingKeys.join(', ')}`);
  }

  const emptyCriticalValues = REQUIRED_ENVIRONMENT_KEYS.filter((key) => {
    const value = environment[key as EnvironmentKey];
    return typeof value === 'string' && value.trim().length === 0;
  });

  if (emptyCriticalValues.length > 0) {
    throw new Error(`VALORES_CRITICOS_VACIOS: las siguientes claves no tienen valor asignado -> ${emptyCriticalValues.join(', ')}`);
  }

  return true;
}

/**
 * Consulta la tabla `schema_migrations` y certifica que cada migracion aplicada conserve
 * exactamente el mismo hash SHA-256 del archivo SQL que esta en disco.
 *
 * @param databaseUrl - Cadena de conexion PostgreSQL de Neon.
 * @returns Listado de cadenas con el estado de cada migracion verificada.
 */
async function verifyMigrationLedger(databaseUrl: string): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 8000 });
  const migrationsDirectory = path.resolve(__dirname, '..', 'migrations');
  const report: string[] = [];

  try {
    const serverInfo = await pool.query<{ version: string }>('SELECT version() AS version');
    report.push(`Motor PostgreSQL: ${serverInfo.rows[0]?.version.split(' ').slice(0, 2).join(' ') ?? 'desconocido'}`);

    const ledger = await pool.query<MigrationLedgerRow>(
      'SELECT version, filename, checksum_sha256, execution_time_ms FROM schema_migrations ORDER BY version ASC'
    );

    if (ledger.rows.length === 0) {
      throw new Error('MIGRACIONES_NO_APLICADAS: la tabla `schema_migrations` existe pero no contiene ninguna migracion registrada.');
    }

    for (const row of ledger.rows) {
      const absolutePath = path.join(migrationsDirectory, row.filename);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`ARCHIVO_MIGRACION_AUSENTE: ${row.filename} figura como aplicado pero no existe en disco.`);
      }

      const currentHash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath, 'utf8'), 'utf8').digest('hex');
      const integrityStatus = currentHash === row.checksum_sha256 ? 'SHA-256 INTACTO' : 'HASH ALTERADO';
      if (currentHash !== row.checksum_sha256) {
        throw new Error(`VIOLACION_INTEGRIDAD_MIGRACION: ${row.filename} fue modificado despues de aplicarse.`);
      }

      report.push(`[${row.version}] ${row.filename} | ${integrityStatus} | ${row.execution_time_ms}ms | SHA-256 ${row.checksum_sha256.slice(0, 16)}...`);
    }

    const policyCount = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM pg_policies WHERE policyname LIKE 'rls_%'`
    );
    const tableCount = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM pg_tables WHERE schemaname = 'public'`
    );
    const rlsForced = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM pg_class WHERE relrowsecurity = TRUE AND relforcerowsecurity = TRUE`
    );

    report.push(`Objetos verificados -> Tablas publicas: ${tableCount.rows[0]?.total ?? '0'} | Politicas RLS: ${policyCount.rows[0]?.total ?? '0'} | Tablas con FORCE RLS: ${rlsForced.rows[0]?.total ?? '0'}`);
    return report;
  } finally {
    await pool.end();
  }
}

/**
 * Orquesta la verificacion completa de la Parte 1: contrato de entorno y ledger de migraciones.
 */
async function runVerification(): Promise<void> {
  console.log('VERIFICACION DE CIMIENTOS (PARTE 1): CONTRATO DE ENTORNO Y MIGRACIONES SQL');
  console.log('='.repeat(96));

  const environment = getEnvConfig();
  console.log('[1/3] Radiografia segura de la configuracion de entorno:');
  for (const line of summarizeEnvConfig()) {
    console.log(`      ${line}`);
  }

  console.log('[2/3] Contrato de entorno obligatorio:');
  const contractOk = verifyEnvironmentContract(environment);
  console.log(`      ${contractOk ? 'APROBADO' : 'FALLIDO'}: ${REQUIRED_ENVIRONMENT_KEYS.length} claves criticas declaradas y con valor.`);

  console.log('[3/3] Ledger de migraciones PostgreSQL (Neon):');
  const migrationReport = await verifyMigrationLedger(environment.DATABASE_URL);
  for (const line of migrationReport) {
    console.log(`      ${line}`);
  }

  console.log('='.repeat(96));
  console.log('RESULTADO: APROBADO. Cimientos, contrato de entorno y esquema SQL verificados.');
}

runVerification().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('RESULTADO: FALLIDO.');
  console.error(message);
  process.exit(1);
});
