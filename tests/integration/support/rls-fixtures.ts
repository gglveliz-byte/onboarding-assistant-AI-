/**
 * @archivo tests/integration/support/rls-fixtures.ts
 * @modulo 00-kernel (Soporte de Fixtures para las Pruebas de Aislamiento RLS)
 * @proposito
 *   Concentra la siembra y la limpieza de las fixtures de prueba, ademas de la gestion del rol
 *   efimero de minimos privilegios sin el atributo `BYPASSRLS`. Vive en un modulo aparte para que
 *   el archivo de pruebas se limite a declarar aserciones y no crezca hasta el limite de 500
 *   lineas, y para que cualquier prueba futura de RLS (modulo de gobierno, facturacion o voz)
 *   reutilice exactamente las mismas fixtures en lugar de duplicarlas.
 *
 * @resumen_contenido
 *   - Fixtures compartidas: `FIXTURE_ORG_A`, `FIXTURE_ORG_B`, usuarios, proyectos y suscripcion.
 *   - Funcion `runAsPlatformOwner()`: Ejecuta sentencias de siembra y limpieza con privilegio.
 *   - Funcion `prepareFixtures()` y `cleanupFixtures()`: Siembra y eliminacion total del rastro.
 *   - Funcion `createLeastPrivilegeRole()` y `dropLeastPrivilegeRole()`: Rol efimero de pruebas.
 *   - Funcion `buildRestrictedConnectionString()`: Cadena de conexion del rol efimero.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para resolver la cadena de conexion.
 *
 * @dependencias_externas
 *   - `pg` (Cliente nativo para ejecutar las sentencias de fixture).
 *   - `node:crypto` (Generacion de identificadores y contrasenas aleatorias).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `memberships`, `projects`, `whop_subscriptions`.
 *   - PostgreSQL: `pg_roles` y `public` (Alta y baja del rol efimero con sus privilegios).
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnvConfig } from '../../../src/config/env.schema';

/** Hash Argon2id inutilizable, presente solo para satisfacer la restriccion de SuperAdmin. */
export const FIXTURE_UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$cHJ1ZWJhRGVGaXh0dXJl$0000000000000000000000000000000000000000000';

/** Nombre del rol efimero de minimos privilegios usado para probar las politicas RLS. */
export const RESTRICTED_ROLE_NAME = `oa_rls_test_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;

/** Esquema temporal creado para que el rol efimero resuelva los nombres de tabla. */
export const RESTRICTED_SCHEMA_NAME = RESTRICTED_ROLE_NAME;

/** Contrasena aleatoria del rol efimero: se genera en memoria y nunca se persiste. */
export const RESTRICTED_ROLE_PASSWORD = randomUUID().replace(/-/gu, '');

/**
 * Resuelve la cadena de conexion del PROPIETARIO de la base de datos.
 *
 * Se resuelve de forma PEREZOSA y no como constante de modulo: `getEnvConfig()` es quien puebla
 * `process.env` desde el archivo `.env`, de modo que leer la variable durante la evaluacion del
 * modulo devolveria `undefined` porque el cargador aun no se habia ejecutado.
 *
 * Se prefiere `DATABASE_OWNER_URL` a `DATABASE_URL` de forma deliberada: desde la migracion 007 la
 * aplicacion se conecta con un rol SIN `BYPASSRLS`, y esta prueba necesita privilegio de propietario
 * para crear y destruir su rol efimero. Reutilizar la misma cadena para ambos fines fue precisamente
 * lo que mantuvo oculto, durante toda la construccion, que las politicas RLS no se aplicaban.
 *
 * @returns Cadena de conexion con privilegio de propietario.
 */
export function resolveOwnerConnectionString(): string {
  const environment = getEnvConfig();
  const ownerUrl = environment.DATABASE_OWNER_URL;
  return ownerUrl !== undefined && ownerUrl.length > 0 ? ownerUrl : environment.DATABASE_URL;
}

/** Cadena de conexion del propietario, resuelta en el momento de su primer uso. */
export const DATABASE_CONNECTION_STRING = resolveOwnerConnectionString();

/** Organizacion A de la prueba (tenant con proyecto, membresia y suscripcion). */
export const FIXTURE_ORG_A = {
  id: randomUUID(),
  slug: `prueba-rls-a-${randomUUID().slice(0, 8)}`,
  name: 'Organizacion de prueba A',
  subscriptionId: randomUUID(),
  projectId: randomUUID(),
  projectSlug: `proyecto-a-${randomUUID().slice(0, 8)}`,
};

/** Organizacion B de la prueba (tenant aislado, sin suscripcion). */
export const FIXTURE_ORG_B = {
  id: randomUUID(),
  slug: `prueba-rls-b-${randomUUID().slice(0, 8)}`,
  name: 'Organizacion de prueba B',
  projectId: randomUUID(),
  projectSlug: `proyecto-b-${randomUUID().slice(0, 8)}`,
};

/** Usuario desarrollador perteneciente unicamente a la organizacion A. */
export const FIXTURE_DEVELOPER = {
  id: randomUUID(),
  email: `dev-${randomUUID().slice(0, 8)}@prueba.interno`,
  fullName: 'Desarrollador de prueba',
};

/** Usuario con marca de SuperAdmin de plataforma usado para validar la elevacion de privilegio. */
export const FIXTURE_SUPERADMIN = {
  id: randomUUID(),
  email: `superadmin-${randomUUID().slice(0, 8)}@prueba.interno`,
  fullName: 'SuperAdmin de prueba',
};

/** Organizacion inexistente usada para verificar el fallo controlado del bloqueo pesimista. */
export const FIXTURE_MISSING_ORG_ID = randomUUID();

/**
 * Ejecuta una sentencia dentro de una transaccion con privilegio de gobierno, de modo que las
 * politicas RLS no bloqueen la siembra ni la limpieza de las fixtures. Ante cualquier fallo
 * revierte la transaccion y relanza el motivo exacto reportado por el motor.
 *
 * @param client - Conexion directa al pool de PostgreSQL.
 * @param sql - Sentencia SQL parametrizada a ejecutar.
 * @param parameters - Valores de los parametros de la sentencia.
 * @param label - Etiqueta de diagnostico para identificar la sentencia que fallo.
 */
export async function runAsPlatformOwner(
  client: PoolClient,
  sql: string,
  parameters: readonly unknown[] = [],
  label: string = 'sentencia'
): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    await client.query(sql, [...parameters]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FIXTURE_FALLIDA [${label}]: ${detail}`);
  }
}

/**
 * Siembra organizaciones, usuarios, membresias, proyectos y la suscripcion de prueba.
 *
 * @param client - Conexion directa al pool de PostgreSQL.
 */
export async function prepareFixtures(client: PoolClient): Promise<void> {
  await runAsPlatformOwner(
    client,
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'ACTIVE'), ($4, $5, $6, 'ACTIVE')`,
    [FIXTURE_ORG_A.id, FIXTURE_ORG_A.name, FIXTURE_ORG_A.slug, FIXTURE_ORG_B.id, FIXTURE_ORG_B.name, FIXTURE_ORG_B.slug],
    'alta de organizaciones'
  );

  await runAsPlatformOwner(
    client,
    `INSERT INTO users (id, email, full_name, password_hash, is_platform_superadmin)
     VALUES ($1, $2, $3, $4, FALSE), ($5, $6, $7, $8, TRUE)`,
    [
      FIXTURE_DEVELOPER.id,
      FIXTURE_DEVELOPER.email,
      FIXTURE_DEVELOPER.fullName,
      FIXTURE_UNUSABLE_PASSWORD_HASH,
      FIXTURE_SUPERADMIN.id,
      FIXTURE_SUPERADMIN.email,
      FIXTURE_SUPERADMIN.fullName,
      FIXTURE_UNUSABLE_PASSWORD_HASH,
    ],
    'alta de usuarios'
  );

  // El esquema prohibe el rol SUPERADMIN dentro de una organizacion (chk_no_tenant_superadmin):
  // el gobierno es de plataforma y se acredita con `users.is_platform_superadmin`.
  await runAsPlatformOwner(
    client,
    `INSERT INTO memberships (organization_id, user_id, role, is_active) VALUES ($1, $2, 'DEVELOPER', TRUE), ($3, $4, 'OWNER', TRUE)`,
    [FIXTURE_ORG_A.id, FIXTURE_DEVELOPER.id, FIXTURE_ORG_B.id, FIXTURE_SUPERADMIN.id],
    'alta de membresias'
  );

  await runAsPlatformOwner(
    client,
    `INSERT INTO projects (id, organization_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      FIXTURE_ORG_A.projectId,
      FIXTURE_ORG_A.id,
      'Proyecto de prueba A',
      FIXTURE_ORG_A.projectSlug,
      FIXTURE_ORG_B.projectId,
      FIXTURE_ORG_B.id,
      'Proyecto de prueba B',
      FIXTURE_ORG_B.projectSlug,
    ],
    'alta de proyectos'
  );

  await runAsPlatformOwner(
    client,
    `INSERT INTO whop_subscriptions (id, organization_id, plan_code, status,
        period_included_minutes_quota, period_included_minutes_remaining,
        current_period_overage_billed_usd, credit_balance_usd)
     VALUES ($1, $2, 'PLAN_30', 'ACTIVE', 600.000000, 485.500000, 0.000000, 12.500000)`,
    [FIXTURE_ORG_A.subscriptionId, FIXTURE_ORG_A.id],
    'alta de suscripcion'
  );
}

/**
 * Elimina todas las fixtures de prueba respetando el orden de las claves foraneas.
 *
 * @param client - Conexion directa al pool de PostgreSQL.
 */
export async function cleanupFixtures(client: PoolClient): Promise<void> {
  const organizationIds = [FIXTURE_ORG_A.id, FIXTURE_ORG_B.id];
  await runAsPlatformOwner(client, `DELETE FROM whop_subscriptions WHERE organization_id = ANY($1::uuid[])`, [organizationIds], 'baja de suscripciones');
  await runAsPlatformOwner(client, `DELETE FROM projects WHERE organization_id = ANY($1::uuid[])`, [organizationIds], 'baja de proyectos');
  await runAsPlatformOwner(client, `DELETE FROM memberships WHERE organization_id = ANY($1::uuid[])`, [organizationIds], 'baja de membresias');
  await runAsPlatformOwner(
    client,
    `DELETE FROM users WHERE id = ANY($1::uuid[])`,
    [[FIXTURE_DEVELOPER.id, FIXTURE_SUPERADMIN.id]],
    'baja de usuarios'
  );
  await runAsPlatformOwner(client, `DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [organizationIds], 'baja de organizaciones');
}

/**
 * Crea el rol efimero de minimos privilegios y le concede acceso a las tablas publicas a traves
 * de un esquema temporal. Es la unica forma de que las politicas RLS se apliquen de verdad: el
 * rol propietario de la base de datos lleva el atributo `BYPASSRLS` y las omite por diseno.
 *
 * @param client - Conexion directa al pool de PostgreSQL con privilegios de propietario.
 */
export async function createLeastPrivilegeRole(client: PoolClient): Promise<void> {
  await runAsPlatformOwner(client, `DROP ROLE IF EXISTS ${RESTRICTED_ROLE_NAME}`, [], 'limpieza previa del rol');
  await runAsPlatformOwner(client, `CREATE ROLE ${RESTRICTED_ROLE_NAME} LOGIN PASSWORD '${RESTRICTED_ROLE_PASSWORD}'`, [], 'alta del rol restringido');
  await runAsPlatformOwner(client, `CREATE SCHEMA IF NOT EXISTS ${RESTRICTED_SCHEMA_NAME}`, [], 'alta del esquema temporal');
  await runAsPlatformOwner(client, `GRANT USAGE ON SCHEMA public TO ${RESTRICTED_ROLE_NAME}`, [], 'permiso de uso del esquema publico');
  await runAsPlatformOwner(client, `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${RESTRICTED_ROLE_NAME}`, [], 'permisos de datos');
  await runAsPlatformOwner(
    client,
    `ALTER ROLE ${RESTRICTED_ROLE_NAME} IN DATABASE ${client.database} SET search_path = public, ${RESTRICTED_SCHEMA_NAME}`,
    [],
    'ruta de busqueda del rol'
  );
}

/**
 * Elimina el rol efimero y su esquema temporal para no dejar rastro en la base de datos.
 * Se revocan los privilegios de forma explicita en lugar de usar `DROP OWNED BY`, porque esa
 * sentencia exige que el ejecutor sea miembro del rol y el rol de pruebas es de minimos
 * privilegios por diseno.
 *
 * @param client - Conexion directa al pool de PostgreSQL con privilegios de propietario.
 */
export async function dropLeastPrivilegeRole(client: PoolClient): Promise<void> {
  await runAsPlatformOwner(client, `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${RESTRICTED_ROLE_NAME}`, [], 'revocacion de privilegios de datos');
  await runAsPlatformOwner(client, `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${RESTRICTED_ROLE_NAME}`, [], 'revocacion de privilegios de esquema');
  await runAsPlatformOwner(client, `DROP SCHEMA IF EXISTS ${RESTRICTED_SCHEMA_NAME} CASCADE`, [], 'baja del esquema temporal');
  await runAsPlatformOwner(client, `DROP ROLE IF EXISTS ${RESTRICTED_ROLE_NAME}`, [], 'baja del rol restringido');
}

/**
 * Construye la cadena de conexion del rol efimero reemplazando las credenciales de la original.
 *
 * @returns Cadena de conexion autenticada con el rol de minimos privilegios.
 */
export function buildRestrictedConnectionString(): string {
  return DATABASE_CONNECTION_STRING.replace(/postgres(ql)?:\/\/[^@]+@/u, `postgresql://${RESTRICTED_ROLE_NAME}:${RESTRICTED_ROLE_PASSWORD}@`);
}
