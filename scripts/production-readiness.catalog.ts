/**
 * @archivo scripts/production-readiness.catalog.ts
 * @modulo Scripts de Verificacion (Lectura del Catalogo de PostgreSQL)
 * @proposito
 *   Lee el estado real del catalogo del motor —atributos del rol de conexion, cobertura de seguridad a
 *   nivel de fila por tabla y migraciones aplicadas— para que el verificador de preparacion pueda
 *   medir la infraestructura en lugar de suponerla. Se aisla de `verify-production-readiness.ts`
 *   porque son dos responsabilidades distintas: este archivo **observa el motor** y aquel **interpreta
 *   lo observado y decide si el sistema es apto**, y mantenerlos separados evita que el verificador
 *   crezca hasta romper el limite de lineas por archivo.
 *
 * @resumen_contenido
 *   - Interfaces `CatalogTableState` y `CatalogSnapshot`.
 *   - Funcion `readCatalogSnapshot()`: Lectura del catalogo contra la cadena indicada.
 *
 * @dependencias_internas
 *   - Ninguna del proyecto: es deliberado, para que pueda usarse aunque el codigo de aplicacion no
 *     compile, que es justo cuando mas falta hace un diagnostico del esquema.
 *
 * @dependencias_externas
 *   - `pg` (Consulta directa al catalogo del motor).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pg_roles`, `pg_class`, `pg_policies` y `schema_migrations` (Solo lectura).
 */

import { Pool } from 'pg';

/** Estado de seguridad a nivel de fila de una tabla del esquema publico. */
export interface CatalogTableState {
  /** Nombre de la tabla. */
  readonly tableName: string;
  /** Indica si la tabla tiene la seguridad a nivel de fila habilitada. */
  readonly rlsEnabled: boolean;
  /** Indica si la seguridad esta FORZADA, de modo que alcance tambien al propietario. */
  readonly rlsForced: boolean;
  /** Numero de politicas declaradas sobre la tabla. */
  readonly policyCount: number;
}

/** Instantanea del catalogo: el estado real del motor en el momento de la lectura. */
export interface CatalogSnapshot {
  /** Rol con el que la aplicacion se conecta. */
  readonly roleName: string;
  /** Indica si el rol es superusuario. */
  readonly isSuperuser: boolean;
  /**
   * Indica si el rol omite la seguridad a nivel de fila.
   * Es el atributo decisivo: si esta activo, las politicas **no se aplican** en ejecucion y el
   * aislamiento multi-tenant depende unicamente del filtrado de la aplicacion.
   */
  readonly bypassesRls: boolean;
  /** Tablas del esquema publico con su estado de seguridad. */
  readonly tables: readonly CatalogTableState[];
  /** Migraciones aplicadas, ordenadas por nombre de archivo. */
  readonly appliedMigrations: readonly string[];
}

/**
 * Lee el estado real del catalogo del motor de base de datos.
 *
 * @param connectionString - Cadena de conexion a medir. Debe ser **la que se va a desplegar**, no una
 *   heredada del entorno del proceso: medir otra identidad produciria un informe sobre un sistema que
 *   no es el que va a atender trafico.
 * @returns Instantanea del catalogo, o `null` cuando el motor no responde.
 */
export async function readCatalogSnapshot(connectionString: string): Promise<CatalogSnapshot | null> {
  const pool = new Pool({ connectionString, max: 2 });
  pool.on('error', () => undefined);

  try {
    const roleResult = await pool.query<{ role_name: string; is_superuser: boolean; bypasses_rls: boolean }>(
      `SELECT current_user AS role_name, rolsuper AS is_superuser, rolbypassrls AS bypasses_rls
         FROM pg_roles WHERE rolname = current_user`
    );
    const roleRow = roleResult.rows[0];
    if (roleRow === undefined) {
      return null;
    }

    const tablesResult = await pool.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: string;
    }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              (SELECT COUNT(*)::TEXT FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`
    );

    const migrationsResult = await pool
      .query<{ filename: string }>(`SELECT filename FROM schema_migrations ORDER BY filename`)
      .catch(() => ({ rows: [] as { filename: string }[] }));

    return {
      roleName: roleRow.role_name,
      isSuperuser: roleRow.is_superuser,
      bypassesRls: roleRow.bypasses_rls,
      tables: tablesResult.rows.map((row) => ({
        tableName: row.table_name,
        rlsEnabled: row.rls_enabled,
        rlsForced: row.rls_forced,
        policyCount: Number(row.policy_count),
      })),
      appliedMigrations: migrationsResult.rows.map((row) => row.filename),
    };
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}
