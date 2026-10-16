/**
 * @archivo src/shared/infrastructure/database/rls-pool.ts
 * @modulo 00-kernel (Pool PostgreSQL con Row-Level Security Multi-Tenant y Bloqueo Pesimista)
 * @proposito
 *   Envuelve el pool nativo de PostgreSQL en la clase `RlsDatabasePool`, que es el UNICO punto
 *   autorizado de acceso a la base de datos. Antes de ejecutar cualquier sentencia de negocio
 *   establece las variables de sesion `app.current_org_id`, `app.current_user_id` y
 *   `app.is_superadmin` mediante `set_config(..., is_local => true)`, de modo que las politicas
 *   RLS aislain a cada organizacion incluso si la aplicacion cometiera un error de filtrado.
 *   Incorpora ademas el bloqueo pesimista `SELECT ... FOR UPDATE` sobre `whop_subscriptions`,
 *   unica forma correcta de deducir minutos cuando varias sesiones de voz compiten por saldo.
 *
 * @resumen_contenido
 *   - Interface `RlsPoolOptions`: Parametros de construccion del pool.
 *   - Interface `WhopSubscriptionRow`: Fila real de `whop_subscriptions` (21 columnas verificadas).
 *   - Interface `TenantTransactionContext`: Contexto multi-tenant de una transaccion.
 *   - Funcion `mapWhopSubscriptionRow()`: Mapeador de fila a objeto tipado con decimales seguros.
 *   - Clase `RlsDatabasePool`:
 *       * `runInTenantTransaction()`: Transaccion con aislamiento de organizacion.
 *       * `runInSuperAdminTransaction()`: Transaccion auditada con privilegio de gobierno.
 *       * `runWithPessimisticOrgLock()`: Transaccion con `FOR UPDATE` sobre la suscripcion.
 *       * `withClient()`: Acceso directo controlado para migraciones y diagnostico.
 *       * `healthCheck()` y `close()`: Operacion y cierre del pool.
 *   - Fabrica `createRlsDatabasePoolFromEnv()`: Construccion desde el contrato de entorno.
 *
 * @dependencias_internas
 *   - `ForbiddenError`, `NotFoundError` (`../../kernel/result-and-errors.ts`).
 *   - `getEnvConfig()` (`../../../config/env.schema.ts`) para los parametros del pool.
 *
 * @dependencias_externas
 *   - `pg` (Pool y cliente nativo de PostgreSQL).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: todas las tablas multi-tenant (Variables de sesion RLS por transaccion).
 *   - PostgreSQL: `whop_subscriptions` (Lectura con `FOR UPDATE` en la ruta financiera).
 *   - PostgreSQL: `memberships` (Verificacion de rol SUPERADMIN antes de elevar privilegio).
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { ForbiddenError, NotFoundError } from '../../kernel/result-and-errors';
import { getEnvConfig } from '../../../config/env.schema';

/** Parametros de construccion del pool con contexto RLS. */
export interface RlsPoolOptions {
  /** Cadena de conexion PostgreSQL (debe incluir `sslmode=require` en produccion). */
  readonly connectionString: string;
  /** Numero maximo de conexiones simultaneas del pool. */
  readonly maxConnections?: number;
  /** Tiempo de espera para obtener una conexion libre, en milisegundos. */
  readonly connectionTimeoutMs?: number;
  /** Tiempo de inactividad antes de devolver una conexion al sistema, en milisegundos. */
  readonly idleTimeoutMs?: number;
  /** Tiempo maximo de ejecucion de una sentencia, en milisegundos (`statement_timeout`). */
  readonly statementTimeoutMs?: number;
}

/** Contexto multi-tenant obligatorio para abrir una transaccion aislada por organizacion. */
export interface TenantTransactionContext {
  /** Identificador de la organizacion activa (`app.current_org_id`). */
  readonly organizationId: string;
  /** Identificador del usuario autenticado (`app.current_user_id`), si existe. */
  readonly userId?: string;
}

/**
 * Fila tipada de `whop_subscriptions`.
 * Las columnas `NUMERIC` se leen como cadenas de texto para preservar la precision exacta de
 * 6 decimales sin pasar jamas por aritmetica de coma flotante.
 */
export interface WhopSubscriptionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly plan_code: string;
  readonly status: string;
  readonly whop_membership_id: string | null;
  readonly whop_user_id: string | null;
  readonly whop_company_id: string | null;
  readonly whop_plan_id: string | null;
  readonly current_period_start: Date;
  readonly current_period_end: Date;
  readonly period_included_minutes_quota: string;
  readonly period_included_minutes_remaining: string;
  readonly period_overage_minutes_used: string;
  readonly current_period_overage_billed_usd: string;
  readonly credit_balance_usd: string;
  readonly hard_spend_cap_usd: string | null;
  readonly auto_topup_enabled: boolean;
  readonly last_whop_webhook_event_id: string | null;
  readonly last_whop_webhook_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Proyeccion explicita de columnas de la suscripcion, evitando `SELECT *` en rutas criticas. */
const WHOP_SUBSCRIPTION_COLUMNS = `id, organization_id, plan_code, status, whop_membership_id, whop_user_id,
  whop_company_id, whop_plan_id, current_period_start, current_period_end, period_included_minutes_quota,
  period_included_minutes_remaining, period_overage_minutes_used, current_period_overage_billed_usd,
  credit_balance_usd, hard_spend_cap_usd, auto_topup_enabled, last_whop_webhook_event_id,
  last_whop_webhook_at, created_at, updated_at`;

/**
 * Mapea una fila cruda de `whop_subscriptions` a un objeto tipado con decimales seguros.
 * PostgreSQL devuelve las columnas `NUMERIC` como cadenas; este mapeador garantiza que esa
 * precision llegue intacta al motor `DecimalMath` sin conversiones intermedias a `number`.
 *
 * @param row - Fila cruda devuelta por el driver `pg`.
 * @returns Suscripcion tipada lista para el motor de tarificacion.
 */
export function mapWhopSubscriptionRow(row: WhopSubscriptionRow): WhopSubscriptionRow {
  return Object.freeze({
    id: row.id,
    organization_id: row.organization_id,
    plan_code: row.plan_code,
    status: row.status,
    whop_membership_id: row.whop_membership_id,
    whop_user_id: row.whop_user_id,
    whop_company_id: row.whop_company_id,
    whop_plan_id: row.whop_plan_id,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    period_included_minutes_quota: row.period_included_minutes_quota,
    period_included_minutes_remaining: row.period_included_minutes_remaining,
    period_overage_minutes_used: row.period_overage_minutes_used,
    current_period_overage_billed_usd: row.current_period_overage_billed_usd,
    credit_balance_usd: row.credit_balance_usd,
    hard_spend_cap_usd: row.hard_spend_cap_usd,
    auto_topup_enabled: row.auto_topup_enabled,
    last_whop_webhook_event_id: row.last_whop_webhook_event_id,
    last_whop_webhook_at: row.last_whop_webhook_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

/**
 * Pool de PostgreSQL con contexto Row-Level Security.
 * Toda transaccion abre con `BEGIN`, fija las variables de sesion con alcance local, ejecuta
 * el trabajo solicitado y confirma o revierte. Si la funcion de trabajo lanza una excepcion,
 * la transaccion se revierte siempre y la conexion vuelve al pool en estado limpio.
 */
export class RlsDatabasePool {
  private readonly pool: Pool;

  /**
   * Construye el pool aplicando los valores por omision seguros del proyecto.
   *
   * @param options - Parametros de conexion y limites de recursos.
   */
  public constructor(options: RlsPoolOptions) {
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      max: options.maxConnections ?? 20,
      // La espera de inactividad debe superar el intervalo del pulso de cobro (15 000 ms);
      // con 10 000 ms cada pulso encontraba la conexion cerrada, forzando reconexiones frias (C1-58).
      idleTimeoutMillis: options.idleTimeoutMs ?? 30000,
      statement_timeout: options.statementTimeoutMs ?? 15000,
      application_name: 'onboarding-assistant-backend',
    };
    this.pool = new Pool(poolConfig);

    // Un servidor gestionado (como Neon) puede cerrar una conexion ociosa por su propia politica.
    // Sin este manejador, el evento `error` de un cliente inactivo se propaga como excepcion no
    // capturada y derriba el proceso; con el, la conexion se descarta y el pool abre otra.
    this.pool.on('error', () => {
      // La conexion ociosa fue cerrada por el servidor: el pool la reemplaza en la proxima peticion.
    });
  }

  /**
   * Ejecuta una funcion dentro de una transaccion aislada por organizacion.
   * Todas las consultas heredan el contexto RLS, por lo que un `SELECT` sin filtro explicito
   * devuelve unicamente las filas de la organizacion activa.
   *
   * @param context - Organizacion y usuario que definen el contexto de seguridad.
   * @param work - Funcion que recibe el cliente transaccional y produce el resultado.
   * @returns Resultado producido por la funcion de trabajo.
   */
  public async runInTenantTransaction<T>(
    context: TenantTransactionContext,
    work: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [context.organizationId]);
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [context.userId ?? '']);
      await client.query(`SELECT set_config('app.is_superadmin', 'false', true)`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await this.safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ejecuta una funcion dentro de una transaccion con privilegio de gobierno (SuperAdmin).
   * Antes de elevar el privilegio se comprueba que el usuario este marcado como SuperAdmin de
   * plataforma (`users.is_platform_superadmin`) y que su cuenta no este bloqueada ni eliminada.
   * La marca vive en `users` porque el esquema prohibe el rol `SUPERADMIN` dentro de
   * `memberships` (restriccion `chk_no_tenant_superadmin`): el gobierno es de plataforma y
   * nunca un rol de organizacion. Si la verificacion falla, la transaccion se rechaza sin
   * llegar a habilitar el flag de gobierno.
   *
   * @param superAdminUserId - Usuario que solicita el privilegio de gobierno.
   * @param work - Funcion que recibe el cliente transaccional y produce el resultado.
   * @returns Resultado producido por la funcion de trabajo.
   * @throws ForbiddenError cuando el usuario no acredita la marca de SuperAdmin de plataforma.
   */
  public async runInSuperAdminTransaction<T>(superAdminUserId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // La verificacion se ejecuta con el flag de gobierno ya activo para que la politica RLS
      // de `users` no oculte la propia fila del operador que solicita el privilegio.
      await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
      const operator = await client.query<{ is_platform_superadmin: boolean; locked_until: Date | null }>(
        `SELECT is_platform_superadmin, locked_until FROM users WHERE id = $1`,
        [superAdminUserId]
      );

      const operatorRow = operator.rows[0];
      if (operatorRow === undefined || !operatorRow.is_platform_superadmin) {
        throw new ForbiddenError('El usuario no acredita la marca de SuperAdmin de plataforma.');
      }
      if (operatorRow.locked_until !== null && operatorRow.locked_until.getTime() > Date.now()) {
        throw new ForbiddenError('La cuenta de gobierno esta bloqueada temporalmente por intentos fallidos.');
      }

      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [superAdminUserId]);
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, ['']);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await this.safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ejecuta una funcion con la suscripcion de la organizacion bloqueada en modo pesimista.
   * Adquiere `SELECT ... FOR UPDATE` sobre `whop_subscriptions` antes de ejecutar la logica
   * financiera, garantizando que dos sesiones de voz concurrentes no puedan leer el mismo
   * saldo y deducir minutos dos veces (condicion de carrera de doble gasto).
   *
   * @param organizationId - Organizacion propietaria de la suscripcion.
   * @param work - Funcion que recibe el cliente y la fila de suscripcion ya bloqueada.
   * @returns Resultado producido por la funcion de trabajo.
   * @throws NotFoundError cuando la organizacion no tiene suscripcion registrada.
   */
  public async runWithPessimisticOrgLock<T>(
    organizationId: string,
    work: (client: PoolClient, lockedSubscription: WhopSubscriptionRow) => Promise<T>
  ): Promise<T> {
    return this.runInTenantTransaction({ organizationId }, async (client) => {
      const locked = await client.query<WhopSubscriptionRow>(
        `SELECT ${WHOP_SUBSCRIPTION_COLUMNS} FROM whop_subscriptions WHERE organization_id = $1 FOR UPDATE`,
        [organizationId]
      );

      const lockedRow = locked.rows[0];
      if (lockedRow === undefined) {
        throw new NotFoundError(`suscripcion de la organizacion ${organizationId}`);
      }

      return work(client, mapWhopSubscriptionRow(lockedRow));
    });
  }

  /**
   * Entrega una conexion directa del pool para tareas administrativas controladas
   * (migraciones, diagnostico y verificaciones de integridad).
   * El llamador es responsable de liberar la conexion a traves del bloque `finally`.
   *
   * @param work - Funcion que recibe la conexion y produce el resultado.
   * @returns Resultado producido por la funcion de trabajo.
   */
  public async withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  /**
   * Comprueba que el pool responde y devuelve la version del motor PostgreSQL.
   *
   * @returns Version del motor y numero de conexiones activas del pool.
   */
  public async healthCheck(): Promise<{ readonly engineVersion: string; readonly totalConnections: number }> {
    const result = await this.pool.query<{ version: string }>('SELECT version() AS version');
    return {
      engineVersion: result.rows[0]?.version.split(' ').slice(0, 2).join(' ') ?? 'desconocida',
      totalConnections: this.pool.totalCount,
    };
  }

  /**
   * Cierra ordenadamente todas las conexiones del pool.
   * Debe invocarse en el apagado controlado del proceso para no dejar conexiones colgadas.
   */
  public async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Revierte una transaccion ignorando cualquier fallo de la propia reversion, para no
   * enmascarar el error original que provoco el `catch`.
   *
   * @param client - Cliente transaccional a revertir.
   */
  private async safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Una reversion fallida deja la conexion marcada; el pool la descartara al liberarla.
    }
  }
}

/**
 * Construye el pool con contexto RLS a partir del contrato de entorno ya validado.
 *
 * @returns Instancia configurada del pool con los parametros de `env.schema.ts`.
 */
export function createRlsDatabasePoolFromEnv(): RlsDatabasePool {
  const environment = getEnvConfig();
  return new RlsDatabasePool({
    connectionString: environment.DATABASE_URL,
    maxConnections: environment.DATABASE_POOL_MAX,
    statementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
  });
}
