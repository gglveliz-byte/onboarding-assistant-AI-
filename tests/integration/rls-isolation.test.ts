/**
 * @archivo tests/integration/rls-isolation.test.ts
 * @modulo 00-kernel (Prueba de Fuego de Aislamiento RLS y Bloqueo Pesimista contra Neon)
 * @proposito
 *   Demuestra empiricamente, contra PostgreSQL real, que las politicas Row-Level Security
 *   aislain de verdad a cada organizacion. Es imprescindible usar un rol de minimos privilegios
 *   sin el atributo `BYPASSRLS`: el rol propietario de la base de datos omite las politicas por
 *   diseno y, con el, cualquier prueba de aislamiento daria un falso positivo. Este archivo solo
 *   orquesta la prueba y garantiza la limpieza; las fixtures viven en `support/rls-fixtures.ts` y
 *   las aserciones en `support/rls-assertions.ts`.
 *
 * @resumen_contenido
 *   - Funcion `reportCleanupOutcome()`: Informa el rastro remanente tras la limpieza.
 *   - Funcion `main()`: Siembra fixtures, crea el rol restringido, ejecuta la bateria y limpia.
 *   - Bloque de arranque: informa el resultado consolidado y sale con codigo 1 ante cualquier fallo.
 *
 * @dependencias_internas
 *   - Fixtures y rol efimero (`./support/rls-fixtures.ts`).
 *   - Bateria de aserciones (`./support/rls-assertions.ts`).
 *   - `RlsDatabasePool` (`../../src/shared/infrastructure/database/rls-pool.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Pool de conexiones para el propietario y para el rol de minimos privilegios).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations`, `users`, `memberships`, `projects`, `whop_subscriptions`.
 *   - Todas las fixtures y el rol efimero se eliminan al terminar, incluso si la prueba falla.
 */

import { Pool, type PoolClient } from 'pg';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import {
  DATABASE_CONNECTION_STRING,
  FIXTURE_DEVELOPER,
  FIXTURE_ORG_A,
  FIXTURE_ORG_B,
  FIXTURE_SUPERADMIN,
  RESTRICTED_ROLE_NAME,
  buildRestrictedConnectionString,
  cleanupFixtures,
  createLeastPrivilegeRole,
  dropLeastPrivilegeRole,
  prepareFixtures,
} from './support/rls-fixtures';
import {
  getPassedAssertions,
  verifyPessimisticLock,
  verifyRlsPoliciesWithRestrictedRole,
  verifySuperAdminElevation,
} from './support/rls-assertions';

/**
 * Informa cuantas fixtures y objetos efimeros quedaron en la base de datos tras la limpieza.
 *
 * @param fixtureClient - Conexion directa con privilegios de propietario.
 */
async function reportCleanupOutcome(fixtureClient: PoolClient): Promise<void> {
  const remaining = await fixtureClient.query<{ organizaciones: string; proyectos: string; usuarios: string; roles: string }>(
    `SELECT (SELECT COUNT(*)::TEXT FROM organizations WHERE id = ANY($1::uuid[])) AS organizaciones,
            (SELECT COUNT(*)::TEXT FROM projects WHERE id = ANY($2::uuid[])) AS proyectos,
            (SELECT COUNT(*)::TEXT FROM users WHERE id = ANY($3::uuid[])) AS usuarios,
            (SELECT COUNT(*)::TEXT FROM pg_roles WHERE rolname = $4) AS roles`,
    [
      [FIXTURE_ORG_A.id, FIXTURE_ORG_B.id],
      [FIXTURE_ORG_A.projectId, FIXTURE_ORG_B.projectId],
      [FIXTURE_DEVELOPER.id, FIXTURE_SUPERADMIN.id],
      RESTRICTED_ROLE_NAME,
    ]
  );

  const leftover = remaining.rows[0];
  console.log(
    `Limpieza verificada: ${leftover?.organizaciones ?? '?'} organizaciones, ${leftover?.proyectos ?? '?'} proyectos, ` +
      `${leftover?.usuarios ?? '?'} usuarios y ${leftover?.roles ?? '?'} roles remanentes (esperado 0 en todos).`
  );
}

/** Ejecuta la prueba completa preparando y limpiando las fixtures de forma garantizada. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DE AISLAMIENTO RLS Y BLOQUEO PESIMISTA (PARTE 2)');
  console.log('='.repeat(96));

  const ownerPool = new RlsDatabasePool({ connectionString: DATABASE_CONNECTION_STRING, maxConnections: 4 });
  const fixturePool = new Pool({ connectionString: DATABASE_CONNECTION_STRING, max: 1 });
  const fixtureClient = await fixturePool.connect();
  let restrictedPool: RlsDatabasePool | undefined;

  try {
    const health = await ownerPool.healthCheck();
    console.log(`Motor conectado: ${health.engineVersion}`);

    await prepareFixtures(fixtureClient);
    console.log('Fixtures sembradas: 2 organizaciones, 2 usuarios, 2 membresias, 2 proyectos y 1 suscripcion.');

    await createLeastPrivilegeRole(fixtureClient);
    restrictedPool = new RlsDatabasePool({ connectionString: buildRestrictedConnectionString(), maxConnections: 2 });
    console.log(`Rol de minimos privilegios creado para la prueba: ${RESTRICTED_ROLE_NAME}`);

    await verifyRlsPoliciesWithRestrictedRole(restrictedPool);
    console.log('[1/4] Aislamiento RLS verificado con rol sin BYPASSRLS (lectura y escritura): APROBADO.');

    await verifyPessimisticLock(ownerPool);
    console.log('[2/4] Bloqueo pesimista FOR UPDATE y fallo controlado: APROBADO.');

    await verifySuperAdminElevation(ownerPool);
    console.log('[3/4] Elevacion de privilegio auditada por marca de SuperAdmin: APROBADO.');

    console.log('[4/4] Limpieza garantizada de fixtures y rol efimero.');
    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${getPassedAssertions()} aserciones superadas.`);
  } finally {
    if (restrictedPool !== undefined) {
      await restrictedPool.close();
    }
    await cleanupFixtures(fixtureClient);
    await dropLeastPrivilegeRole(fixtureClient);
    await reportCleanupOutcome(fixtureClient);
    fixtureClient.release();
    await fixturePool.end();
    await ownerPool.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('RESULTADO: FALLIDO.');
  console.error(message);
  process.exit(1);
});
