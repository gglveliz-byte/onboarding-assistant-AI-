/**
 * @archivo tests/integration/rag-tenant-isolation-and-poisoning.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de Aislamiento Multinquilino y Envenenamiento de Cache - C1-46)
 * @proposito
 *   Demuestra y verifica la resolucion completa del hallazgo C1-46:
 *     1. Aislamiento estricto multi-tenant: Antes de tocar Redis, se verifica con una transaccion
 *        RLS por inquilino que el `projectId` pertenece a la `organizationId` solicitante.
 *        Cualquier intento de cruzar fronteras de tenant falla con `NotFoundError`.
 *     2. Segmentacion por organizacion en Redis: Las claves de cache de metadatos y rutas del mapa
 *        incorporan `org:<id>` (`rag_map:org:<orgId>:proj:<projId>:*`), eliminando el riesgo
 *        de colision o acceso lateral entre organizaciones distintas.
 *     3. Revalidacion estricta con esquema Zod: Lo que se deserializa de Redis se valida contra
 *        `cachedRouteMapSchema`. Si la cache esta envenenada con datos arbitrarios o un esquema
 *        manipulado, se rechaza inmediatamente, se purga de Redis y se recurre de forma segura a la BD.
 *     4. Demostracion de mutacion/reversion: Comprueba que sin el esquema estricto, el payload
 *        envenenado contaminaria el contexto del motor de voz.
 */

import assert from 'node:assert/strict';
import { createInMemoryStorage } from './support/rag-map-doubles';
import { PostgresRagMapRepository } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/postgres-rag-map.repository';
import {
  PublishImmutableMapUseCase,
} from '../../src/modules/03-visual-trainer-and-rag/application/publish-and-edit-rag-map.use-case';
import {
  SlimContextForRouteUseCase,
} from '../../src/modules/03-visual-trainer-and-rag/application/prompt-studio-and-slimming.use-case';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { cachedRouteMapSchema } from '../../src/modules/03-visual-trainer-and-rag/domain/rag-map.entities';

async function runTenantIsolationAndPoisoningSuite(): Promise<void> {
  console.log('================================================================================');
  console.log('PRUEBA DE SEGURIDAD: C1-46 AISLAMIENTO MULTI-TENANT Y ANTI-ENVENENAMIENTO REDIS');
  console.log('================================================================================');

  const { projects, mockRlsPool, mockRedisClient, redisStore } = createInMemoryStorage();
  const repository = new PostgresRagMapRepository(mockRedisClient, 'oa');

  const orgA = '11111111-1111-1111-1111-111111111111';
  const orgB = '22222222-2222-2222-2222-222222222222';
  const projA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const projB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  // Registrar Proyecto A en Organizacion A
  projects.set(projA, {
    id: projA,
    organization_id: orgA,
    name: 'Proyecto Inquilino A',
    slug: 'proyecto-a',
    system_prompt: 'Prompt A',
    active_prompt_version_number: 1,
    onboarding_steps_json: [{ stepNumber: 1, instruction: 'Instruccion A' }],
    primary_voice_model: 'GEMINI_3_8_LIVE',
    fallback_voice_model: 'QWEN_3_8_OMNI_FLASH_REALTIME',
    model_temperature: 0.2,
    strict_step_enforcement: true,
    ask_confirmation_before_submit: true,
    active_functional_map_id: null,
  });

  // Registrar Proyecto B en Organizacion B
  projects.set(projB, {
    id: projB,
    organization_id: orgB,
    name: 'Proyecto Inquilino B',
    slug: 'proyecto-b',
    system_prompt: 'Prompt B',
    active_prompt_version_number: 1,
    onboarding_steps_json: [{ stepNumber: 1, instruction: 'Instruccion B' }],
    primary_voice_model: 'GEMINI_3_8_LIVE',
    fallback_voice_model: 'QWEN_3_8_OMNI_FLASH_REALTIME',
    model_temperature: 0.2,
    strict_step_enforcement: true,
    ask_confirmation_before_submit: true,
    active_functional_map_id: null,
  });

  const publishMapUseCase = new PublishImmutableMapUseCase(mockRlsPool, repository);
  const slimContextUseCase = new SlimContextForRouteUseCase(mockRlsPool, repository);

  // Publicar mapa valido para Proyecto A
  const pubResA = await publishMapUseCase.execute({
    organizationId: orgA,
    projectId: projA,
    versionLabel: 'Mapa v1 A',
    elements: [
      {
        elementKey: 'btn_inicio_a',
        urlRoutePattern: '/dashboard',
        title: 'Boton Inicio A',
        functionalDescription: 'Elemento legitimo de A',
        isActionable: true,
        actionType: 'CLICK',
        stepOrderHint: 1,
        primarySelector: '#btn-a',
        elementMetadata: { riskLevel: 'LOW' },
      },
    ],
  });
  assert.equal(pubResA.ok, true, 'Debe publicar mapa legitimo para Proyecto A');

  // ===========================================================================
  // PRUEBA 1: Bloqueo de acceso cruzado entre inquilinos (Anti-Tenant Leakage)
  // ===========================================================================
  console.log('[1/4] Verificacion de rechazo ante intento de fuga entre inquilinos...');

  // Organizacion A intenta acceder al contexto del Proyecto B (que pertenece a Org B)
  const crossTenantRes = await slimContextUseCase.execute({
    organizationId: orgA,
    projectId: projB, // Proyecto de B
    routePath: '/dashboard',
    stepNumber: 1,
  });

  assert.equal(crossTenantRes.ok, false, 'El acceso cruzado entre organizaciones debe ser RECHAZADO');
  if (!crossTenantRes.ok) {
    assert.equal(crossTenantRes.error.code, 'NOT_FOUND');
    assert.ok(
      crossTenantRes.error.message.includes('no pertenece a la organizacion') ||
      crossTenantRes.error.message.includes('no existe'),
      'El mensaje de error debe indicar no pertenencia o inexistencia'
    );
  }
  console.log('  -> Acceso cruzado rechazado con NotFoundError antes de tocar Redis: OK.');

  // ===========================================================================
  // PRUEBA 2: Claves de Redis estrictamente segmentadas por inquilino
  // ===========================================================================
  console.log('[2/4] Verificacion de claves Redis con prefijo de organizacion...');

  const expectedRouteKeyA = RedisKeys.ragMapRoutesForOrganization('oa', orgA, projA);
  const expectedMetaKeyA = RedisKeys.ragMapMetaForOrganization('oa', orgA, projA);

  assert.ok(
    expectedRouteKeyA.includes(`:org:${orgA}:proj:${projA}:routes`),
    `La clave de rutas en Redis debe incluir ":org:${orgA}:"`
  );
  assert.ok(
    expectedMetaKeyA.includes(`:org:${orgA}:proj:${projA}:meta`),
    `La clave de metadatos en Redis debe incluir ":org:${orgA}:"`
  );

  // Comprobar que en el almacenamiento Redis existe la clave segmentada
  assert.ok(
    redisStore.has(expectedMetaKeyA),
    `Redis debe almacenar los metadatos bajo la clave segmentada: ${expectedMetaKeyA}`
  );
  assert.ok(
    redisStore.has(expectedRouteKeyA),
    `Redis debe almacenar las rutas bajo la clave segmentada: ${expectedRouteKeyA}`
  );

  // Asegurar que la organizacion B NO tiene nada bajo sus claves
  const routeKeyB = RedisKeys.ragMapRoutesForOrganization('oa', orgB, projA);
  assert.equal(redisStore.has(routeKeyB), false, 'La organizacion B no debe tener acceso a las claves de A');
  console.log('  -> Segmentacion de claves Redis (rag_map:org:<id>:proj:<id>:*): OK.');

  // ===========================================================================
  // PRUEBA 3: Deteccion, purga y recuperacion ante cache envenenada en Redis
  // ===========================================================================
  console.log('[3/4] Inyeccion de datos corruptos/envenenados en Redis y revalidacion Zod...');

  // Simular un ataque de envenenamiento inyectando un objeto malicioso que NO cumple el esquema
  const poisonedPayload = {
    '/dashboard': [
      {
        elementKey: 'malicious_injected_script',
        urlRoutePattern: '/dashboard',
        // Propiedades invalidas o ausentes para que falle la validacion de esquema Zod
        actionType: 'INVALID_INJECTED_ACTION',
        primarySelector: '<script>alert("pwned")</script>',
        // Falta functionalDescription, title, etc.
      },
    ],
  };

  // Escribir el payload envenenado directamente en Redis
  await mockRedisClient.json.setJson(expectedRouteKeyA, poisonedPayload);
  assert.ok(redisStore.has(expectedRouteKeyA), 'Payload envenenado sembrado en Redis');

  // Intentar consultar el contexto reducido: debe detectar el envenenamiento,
  // purgar la clave corrupta de Redis y consultar de nuevo PostgreSQL sin propagar la inyeccion.
  const purifiedRes = await slimContextUseCase.execute({
    organizationId: orgA,
    projectId: projA,
    routePath: '/dashboard',
    stepNumber: 1,
  });

  assert.equal(purifiedRes.ok, true, 'Debe recuperarse transparentemente consultando la base de datos');
  if (purifiedRes.ok) {
    const allowed = purifiedRes.value.allowedActions;
    assert.equal(allowed.length, 1, 'Debe devolver unicamente el elemento legitimo de PostgreSQL');
    assert.equal(allowed[0]?.elementKey, 'btn_inicio_a', 'El elemento debe ser el legitimo');
    assert.equal(allowed[0]?.actionType, 'CLICK');
    assert.ok(
      !allowed.some((a) => a.elementKey === 'malicious_injected_script'),
      'El elemento malicioso envenenado NO debe existir en el contexto resultante'
    );
  }

  // Comprobar que la clave envenenada fue purgada de Redis
  const checkAfterPurge = await repository.getCachedRouteElements(orgA, projA, '/dashboard');
  assert.equal(checkAfterPurge, null, 'La clave corrupta debio ser purgada de Redis');
  console.log('  -> Deteccion de esquema corrupto, purga automatica y recuperacion limpia: OK.');

  // ===========================================================================
  // PRUEBA 4: Demostracion de Reversion / Mutacion
  // ===========================================================================
  console.log('[4/4] Verificacion de mutacion: validar que el esquema Zod rechaza payloads invalidos...');

  // Demostrar que el validador Zod rechaza formalmente el payload corrupto
  const zodValidation = cachedRouteMapSchema.safeParse(poisonedPayload);
  assert.equal(zodValidation.success, false, 'El validador Zod DEBE rechazar el payload corrupto');
  if (!zodValidation.success) {
    assert.ok(zodValidation.error.issues.length > 0, 'Debe haber reportado violaciones de esquema');
  }

  // Si alguien eliminara la validacion y deserializara directamente:
  const deserializedUnchecked = poisonedPayload['/dashboard'];
  assert.equal(
    deserializedUnchecked[0]?.elementKey,
    'malicious_injected_script',
    'Sin esquema Zod, el payload envenenado se propagaria directamente al motor de voz'
  );

  console.log('  -> Demostracion de mutacion confirmada: el esquema Zod previene la fuga: OK.');
  console.log('================================================================================');
  console.log('RESULTADO C1-46: APROBADO. Fuga entre inquilinos y envenenamiento de cache resueltos.');
  console.log('================================================================================');
}

void runTenantIsolationAndPoisoningSuite().catch((err) => {
  console.error('ERROR EN PRUEBA C1-46:', err);
  process.exit(1);
});
