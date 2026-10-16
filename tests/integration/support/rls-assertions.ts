/**
 * @archivo tests/integration/support/rls-assertions.ts
 * @modulo 00-kernel (Bateria de Aserciones de Aislamiento RLS, Bloqueo y Gobierno)
 * @proposito
 *   Agrupa las aserciones de la prueba de integracion de RLS en funciones verificables de forma
 *   independiente. Se separa del archivo de pruebas para que este conserve unicamente la
 *   orquestacion y la garantia de limpieza, y para que cualquier prueba futura de gobierno,
 *   facturacion o voz pueda reutilizar exactamente las mismas verificaciones de aislamiento.
 *
 * @resumen_contenido
 *   - Funcion `check()`: Aserta una condicion y contabiliza la verificacion superada.
 *   - Funcion `getPassedAssertions()`: Devuelve el total de aserciones superadas.
 *   - Funcion `verifyRlsPoliciesWithRestrictedRole()`: Aislamiento de lectura y escritura.
 *   - Funcion `verifyPessimisticLock()`: Bloqueo `FOR UPDATE` y fallo controlado.
 *   - Funcion `verifySuperAdminElevation()`: Elevacion de privilegio por marca de plataforma.
 *
 * @dependencias_internas
 *   - Fixtures compartidas (`./rls-fixtures.ts`).
 *   - `RlsDatabasePool` (`../../../src/shared/infrastructure/database/rls-pool.ts`).
 *   - `ForbiddenError`, `NotFoundError` (`../../../src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas), `node:crypto` (Identificador inexistente de prueba).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `whop_subscriptions`, `organizations`, `users` (Solo lectura).
 */

import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError } from '../../../src/shared/kernel/result-and-errors';
import { RlsDatabasePool } from '../../../src/shared/infrastructure/database/rls-pool';
import { FIXTURE_DEVELOPER, FIXTURE_MISSING_ORG_ID, FIXTURE_ORG_A, FIXTURE_ORG_B, FIXTURE_SUPERADMIN } from './rls-fixtures';

/** Contador de verificaciones superadas durante la ejecucion de la bateria. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
export function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Devuelve el total de aserciones superadas hasta el momento.
 *
 * @returns Numero de aserciones superadas.
 */
export function getPassedAssertions(): number {
  return passedAssertions;
}

/**
 * Verifica el aislamiento multi-tenant usando el rol de minimos privilegios, el unico sobre el
 * que PostgreSQL aplica realmente las politicas Row-Level Security. Cubre lectura aislada,
 * lectura cruzada imposible y escritura cruzada bloqueada.
 *
 * @param restrictedPool - Pool construido con el rol efimero sin atributo `BYPASSRLS`.
 */
export async function verifyRlsPoliciesWithRestrictedRole(restrictedPool: RlsDatabasePool): Promise<void> {
  const withoutContext = await restrictedPool.withClient(async (client) => {
    const projects = await client.query<{ total: string }>(`SELECT COUNT(*)::TEXT AS total FROM projects`);
    const subscriptions = await client.query<{ total: string }>(`SELECT COUNT(*)::TEXT AS total FROM whop_subscriptions`);
    const organizations = await client.query<{ total: string }>(`SELECT COUNT(*)::TEXT AS total FROM organizations`);
    return { projects: projects.rows[0]?.total, subscriptions: subscriptions.rows[0]?.total, organizations: organizations.rows[0]?.total };
  });

  check(withoutContext.projects === '0', `Sin contexto de organizacion no debe verse ningun proyecto (devolvio ${withoutContext.projects})`);
  check(
    withoutContext.subscriptions === '0',
    `Sin contexto de organizacion no debe verse ninguna suscripcion (devolvio ${withoutContext.subscriptions})`
  );
  check(
    withoutContext.organizations === '0',
    `Sin contexto de organizacion no debe verse ninguna organizacion (devolvio ${withoutContext.organizations})`
  );

  const organizationAView = await restrictedPool.runInTenantTransaction(
    { organizationId: FIXTURE_ORG_A.id, userId: FIXTURE_DEVELOPER.id },
    async (client) => {
      const projects = await client.query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM projects`);
      const foreignProjects = await client.query<{ total: string }>(
        `SELECT COUNT(*)::TEXT AS total FROM projects WHERE organization_id <> $1`,
        [FIXTURE_ORG_A.id]
      );
      const subscriptions = await client.query<{ total: string; credit_balance_usd: string }>(
        `SELECT COUNT(*)::TEXT AS total, MIN(credit_balance_usd::TEXT) AS credit_balance_usd FROM whop_subscriptions`
      );
      return { projects: projects.rows, foreignProjects: foreignProjects.rows[0]?.total, subscriptions: subscriptions.rows[0] };
    }
  );

  check(organizationAView.projects.length === 1, 'La organizacion A debe ver exactamente su propio proyecto a traves de RLS');
  check(organizationAView.projects[0]?.id === FIXTURE_ORG_A.projectId, 'El proyecto visible debe ser el de la organizacion A');
  check(organizationAView.foreignProjects === '0', 'Ninguna fila de otra organizacion debe ser visible (0 filas)');
  check(organizationAView.subscriptions?.total === '1', 'La organizacion A debe ver su propia suscripcion');
  check(
    organizationAView.subscriptions?.credit_balance_usd === '12.500000',
    `El saldo debe conservar la escala de 6 decimales (recibido ${organizationAView.subscriptions?.credit_balance_usd ?? 'nulo'})`
  );

  const organizationBView = await restrictedPool.runInTenantTransaction({ organizationId: FIXTURE_ORG_B.id }, async (client) => {
    const projects = await client.query<{ id: string }>(`SELECT id FROM projects`);
    const subscriptions = await client.query<{ total: string }>(`SELECT COUNT(*)::TEXT AS total FROM whop_subscriptions`);
    return { projects: projects.rows, subscriptions: subscriptions.rows[0]?.total };
  });

  check(organizationBView.projects.length === 1, 'La organizacion B debe ver exactamente su propio proyecto');
  check(organizationBView.projects[0]?.id === FIXTURE_ORG_B.projectId, 'El proyecto visible por B debe ser el suyo y no el de A');
  check(organizationBView.subscriptions === '0', 'La organizacion B no debe ver la suscripcion de la organizacion A');

  const crossTenantWriteAttempt = await restrictedPool.runInTenantTransaction({ organizationId: FIXTURE_ORG_A.id }, async (client) => {
    const updated = await client.query(
      `UPDATE projects SET name = 'Intento de escritura cruzada' WHERE organization_id = $1 RETURNING id`,
      [FIXTURE_ORG_B.id]
    );
    return updated.rowCount ?? 0;
  });
  check(crossTenantWriteAttempt === 0, 'La organizacion A no debe poder modificar filas de la organizacion B (0 filas afectadas)');
}

/**
 * Verifica la adquisicion del bloqueo pesimista y el fallo controlado sin suscripcion registrada.
 *
 * @param rlsPool - Pool de conexiones con privilegios de propietario.
 */
export async function verifyPessimisticLock(rlsPool: RlsDatabasePool): Promise<void> {
  const lockedRead = await rlsPool.runWithPessimisticOrgLock(FIXTURE_ORG_A.id, async (client, subscription) => {
    const lockProbe = await client.query<{ granted: boolean }>(
      `SELECT TRUE AS granted FROM whop_subscriptions WHERE organization_id = $1 FOR UPDATE NOWAIT`,
      [FIXTURE_ORG_A.id]
    );
    return { subscription, lockGranted: lockProbe.rows.length === 1 };
  });

  check(lockedRead.subscription.organization_id === FIXTURE_ORG_A.id, 'El bloqueo pesimista debe devolver la suscripcion de la organizacion');
  check(lockedRead.subscription.plan_code === 'PLAN_30', 'La suscripcion bloqueada debe exponer el plan contratado');
  check(
    typeof lockedRead.subscription.period_included_minutes_remaining === 'string',
    'Las columnas NUMERIC deben llegar como cadenas para preservar la precision de 6 decimales'
  );
  check(lockedRead.lockGranted, 'La misma transaccion debe poder re-adquirir el bloqueo que ya posee');

  let missingSubscriptionError: unknown = null;
  try {
    await rlsPool.runWithPessimisticOrgLock(FIXTURE_MISSING_ORG_ID, async () => 'no_deberia_ejecutarse');
  } catch (error) {
    missingSubscriptionError = error;
  }
  check(missingSubscriptionError instanceof NotFoundError, 'Una organizacion sin suscripcion debe producir NotFoundError controlado');
  check((missingSubscriptionError as NotFoundError | null)?.httpStatus === 404, 'El error por suscripcion ausente debe mapear a HTTP 404');
}

/**
 * Verifica que la elevacion de privilegio de gobierno exija la marca de SuperAdmin de plataforma
 * y que, una vez acreditada, habilite la vision transversal entre organizaciones.
 *
 * @param rlsPool - Pool de conexiones con privilegios de propietario.
 */
export async function verifySuperAdminElevation(rlsPool: RlsDatabasePool): Promise<void> {
  let elevationError: unknown = null;
  try {
    await rlsPool.runInSuperAdminTransaction(FIXTURE_DEVELOPER.id, async () => 'no_deberia_ejecutarse');
  } catch (error) {
    elevationError = error;
  }
  check(elevationError instanceof ForbiddenError, 'Un usuario sin marca de SuperAdmin no debe poder elevar privilegios');
  check((elevationError as ForbiddenError | null)?.httpStatus === 403, 'La elevacion denegada debe mapear a HTTP 403');

  let unknownOperatorError: unknown = null;
  try {
    await rlsPool.runInSuperAdminTransaction(randomUUID(), async () => 'no_deberia_ejecutarse');
  } catch (error) {
    unknownOperatorError = error;
  }
  check(unknownOperatorError instanceof ForbiddenError, 'Un usuario inexistente tampoco debe poder elevar privilegios');

  const crossTenantView = await rlsPool.runInSuperAdminTransaction(FIXTURE_SUPERADMIN.id, async (client) => {
    const projects = await client.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM projects WHERE id = ANY($1::uuid[])`,
      [[FIXTURE_ORG_A.projectId, FIXTURE_ORG_B.projectId]]
    );
    const subscriptions = await client.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total FROM whop_subscriptions WHERE id = $1`,
      [FIXTURE_ORG_A.subscriptionId]
    );
    return { projects: projects.rows[0]?.total, subscriptions: subscriptions.rows[0]?.total };
  });

  check(crossTenantView.projects === '2', 'El SuperAdmin acreditado debe ver los proyectos de ambas organizaciones');
  check(crossTenantView.subscriptions === '1', 'El SuperAdmin acreditado debe ver la suscripcion sembrada');
}
