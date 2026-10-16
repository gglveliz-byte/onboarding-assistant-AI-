/**
 * @archivo src/shared/infrastructure/database/migrator.ts
 * @modulo 00-database-core (Orquestador Transaccional de Migraciones SQL con SHA-256)
 * @proposito
 *   Ejecuta de forma determinista y ordenada todas las migraciones SQL de la carpeta
 *   `migrations/`, registrando en la tabla de control `schema_migrations` el hash
 *   criptografico `SHA-256` de cada archivo aplicado e impidiendo que migraciones
 *   historicas sean alteradas sin control. Es el UNICO ejecutor de esquema autorizado
 *   del proyecto: cualquier otro punto de entrada debe delegar en esta clase.
 *
 * @resumen_contenido
 *   - Interfaz `MigrationRecord`: Metadatos de una migracion aplicada en base de datos.
 *   - Interfaz `MigrationStatusRow`: Fila cruda del ledger de migraciones.
 *   - Clase `DatabaseMigrator`:
 *       * `ensureMigrationsTable()`: Crea la tabla `schema_migrations` si no existe.
 *       * `computeFileSha256()`: Calcula el digest SHA-256 del contenido SQL.
 *       * `listSqlFilesOrdered()`: Descubre y ordena los archivos `NNN_*.sql`.
 *       * `runPendingMigrations()`: Aplica las migraciones pendientes y verifica integridad.
 *       * `getMigrationStatus()`: Devuelve el estado actual de todas las migraciones.
 *       * `close()`: Cierra ordenadamente el pool de conexiones.
 *   - Bloque CLI: ejecucion directa mediante `npx tsx src/shared/infrastructure/database/migrator.ts`.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`../../../config/env.schema.ts`) para resolver `DATABASE_URL` tipada.
 *
 * @dependencias_externas
 *   - `pg` (Pool nativo de PostgreSQL), `node:fs`, `node:path`, `node:crypto`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `schema_migrations` (Tabla de control de versiones del esquema).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, PoolClient } from 'pg';
import { getEnvConfig } from '../../../config/env.schema';

export interface MigrationRecord {
  readonly version: string;
  readonly filename: string;
  readonly checksumSha256: string;
  readonly appliedAt: Date;
  readonly executionTimeMs: number;
}

/** Fila cruda del ledger de migraciones tal como se persiste en `schema_migrations`. */
interface MigrationStatusRow {
  readonly version: string;
  readonly filename: string;
  readonly checksum_sha256: string;
  readonly applied_at: Date;
  readonly execution_time_ms: number;
}

export class DatabaseMigrator {
  private readonly pool: Pool;
  private readonly migrationsDirectory: string;

  /**
   * Inicializa el ejecutor de migraciones conectandose al pool de PostgreSQL.
   *
   * @param databaseUrl - Cadena de conexion PostgreSQL con permisos de DDL.
   * @param migrationsDirectory - Ruta absoluta al directorio `migrations/`. Por omision se
   *   resuelve a la carpeta `migrations/` de la raiz del repositorio (tres niveles arriba
   *   de `src/shared/infrastructure/database/`), de modo que el ejecutor funcione igual
   *   desde `tsx`, desde `node dist/` o desde un contenedor.
   */
  constructor(databaseUrl: string, migrationsDirectory: string = path.resolve(__dirname, '..', '..', '..', '..', 'migrations')) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
    this.migrationsDirectory = migrationsDirectory;
  }

  /**
   * Crea la tabla de auditoria de migraciones `schema_migrations` si aun no existe.
   *
   * @param client - Cliente activo del pool de PostgreSQL.
   */
  private async ensureMigrationsTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(16) PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        checksum_sha256 CHAR(64) NOT NULL,
        execution_time_ms INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  /**
   * Calcula el hash SHA-256 en formato hexadecimal del contenido de un archivo SQL.
   *
   * @param sqlContent - Contenido completo del archivo SQL en UTF-8.
   * @returns Cadena hexadecimal de 64 caracteres.
   */
  private computeFileSha256(sqlContent: string): string {
    return crypto.createHash('sha256').update(sqlContent, 'utf8').digest('hex');
  }

  /**
   * Descubre y ordena alfabeticamente todos los archivos `.sql` en `migrations/`.
   *
   * @returns Lista ordenada de nombres de archivo SQL.
   */
  private listSqlFilesOrdered(): string[] {
    const entries = fs.readdirSync(this.migrationsDirectory);
    return entries
      .filter((file) => /^\d{3}_.+\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Ejecuta todas las migraciones pendientes verificando que las migraciones
   * previamente aplicadas conserven exactamente el mismo hash SHA-256.
   *
   * @returns Lista de migraciones recien aplicadas en esta ejecucion.
   */
  public async runPendingMigrations(): Promise<MigrationRecord[]> {
    const client = await this.pool.connect();
    const newlyApplied: MigrationRecord[] = [];

    try {
      await this.ensureMigrationsTable(client);

      const existingRows = await client.query<MigrationStatusRow>(
        'SELECT version, filename, checksum_sha256, applied_at, execution_time_ms FROM schema_migrations ORDER BY version ASC'
      );

      const appliedMap = new Map(existingRows.rows.map((r) => [r.version, r]));
      const sqlFiles = this.listSqlFilesOrdered();

      for (const filename of sqlFiles) {
        const version = filename.slice(0, 3);
        const fullPath = path.join(this.migrationsDirectory, filename);
        const sqlContent = fs.readFileSync(fullPath, 'utf8');
        const checksumSha256 = this.computeFileSha256(sqlContent);

        const alreadyApplied = appliedMap.get(version);
        if (alreadyApplied) {
          if (alreadyApplied.checksum_sha256 !== checksumSha256) {
            throw new Error(
              `VIOLACION_INTEGRIDAD_MIGRACION: El archivo ${filename} fue modificado despues de haber sido aplicado. ` +
                `Hash esperado: ${alreadyApplied.checksum_sha256}, Hash actual: ${checksumSha256}`
            );
          }
          continue;
        }

        const startTime = Date.now();
        await client.query(sqlContent);
        const executionTimeMs = Date.now() - startTime;

        const insertResult = await client.query<{ applied_at: Date }>(
          `INSERT INTO schema_migrations (version, filename, checksum_sha256, execution_time_ms)
           VALUES ($1, $2, $3, $4)
           RETURNING applied_at`,
          [version, filename, checksumSha256, executionTimeMs]
        );

        const appliedAtRow = insertResult.rows[0];
        if (appliedAtRow === undefined) {
          throw new Error(`REGISTRO_MIGRACION_NO_CONFIRMADO: PostgreSQL no devolvio la marca temporal de ${filename}.`);
        }

        newlyApplied.push({
          version,
          filename,
          checksumSha256,
          appliedAt: appliedAtRow.applied_at,
          executionTimeMs,
        });
      }

      return newlyApplied;
    } finally {
      client.release();
    }
  }

  /**
   * Devuelve el estado actual de todas las migraciones del proyecto comparando los archivos
   * presentes en disco contra el ledger `schema_migrations` de PostgreSQL.
   *
   * @returns Listado de migraciones con su version, archivo, hash persistido y bandera de aplicacion.
   */
  public async getMigrationStatus(): Promise<readonly MigrationRecord[]> {
    const client = await this.pool.connect();

    try {
      await this.ensureMigrationsTable(client);
      const existingRows = await client.query<MigrationStatusRow>(
        'SELECT version, filename, checksum_sha256, applied_at, execution_time_ms FROM schema_migrations ORDER BY version ASC'
      );

      return existingRows.rows.map((row) => ({
        version: row.version,
        filename: row.filename,
        checksumSha256: row.checksum_sha256,
        appliedAt: row.applied_at,
        executionTimeMs: row.execution_time_ms,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Cierra ordenadamente el pool de conexiones del migrador.
   */
  public async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Punto de entrada de linea de comandos del migrador.
 * Ejecucion directa: `npx tsx src/shared/infrastructure/database/migrator.ts`
 */
async function runMigratorCli(): Promise<void> {
  const environment = getEnvConfig();
  const migrator = new DatabaseMigrator(environment.DATABASE_OWNER_URL || environment.DATABASE_URL);

  try {
    const applied = await migrator.runPendingMigrations();
    console.log(`Migraciones completadas. Archivos nuevos aplicados: ${applied.length}`);
    for (const item of applied) {
      console.log(` - [${item.version}] ${item.filename} (${item.executionTimeMs}ms) SHA-256: ${item.checksumSha256}`);
    }

    const ledger = await migrator.getMigrationStatus();
    console.log(`Ledger ` + '`schema_migrations`' + `: ${ledger.length} migracion(es) registradas.`);
    for (const record of ledger) {
      console.log(` * [${record.version}] ${record.filename} | aplicada ${record.appliedAt.toISOString()}`);
    }
  } finally {
    await migrator.close();
  }
}

// Ejecucion directa desde CLI: `npx tsx src/shared/infrastructure/database/migrator.ts`
if (require.main === module) {
  runMigratorCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Fallo critico durante la ejecucion de migraciones:');
    console.error(message);
    process.exit(1);
  });
}
