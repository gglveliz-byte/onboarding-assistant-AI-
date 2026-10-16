/**
 * @archivo tests/unit/infrastructure-contracts.test.ts
 * @modulo 00-kernel (Prueba Unitaria de Namespaces de Redis, Politicas de Cuota y Contenedor DI)
 * @proposito
 *   Blinda los contratos que las Partes 4 a 16 dan por ciertos sin volver a comprobarlos: que cada
 *   clave de Redis se construye exactamente con el patron documentado en el Ledger, que las 8
 *   politicas de cuota son coherentes entre si y que el contenedor de inyeccion resuelve, cachea
 *   y aisla dependencias segun lo esperado. Al no requerir servidor, esta prueba se ejecuta en
 *   cualquier entorno y detecta de inmediato un cambio de patron que romperia a los demas modulos.
 *
 * @resumen_contenido
 *   - Bloque `verifyRedisKeyNamespaces()`: Patrones exactos de las 13 claves y 3 canales.
 *   - Bloque `verifyTokenBucketPolicyCatalog()`: Coherencia de las 8 politicas de cuota.
 *   - Bloque `verifyDependencyContainer()`: Resolucion, cacheo, duplicados y ambitos hijos.
 *   - Bloque `verifyEventCatalog()`: Sobres de evento con identificador unico y trazabilidad.
 *
 * @dependencias_internas
 *   - `RedisKeys`, `RedisChannels`, `RedisStreams` (`src/shared/infrastructure/redis/redis-key-namespaces.ts`).
 *   - `TOKEN_BUCKET_POLICIES`, `TOKEN_BUCKET_LUA_SCRIPT` (`src/shared/infrastructure/redis/token-bucket.lua.ts`).
 *   - `DependencyContainer`, `DI_TOKENS`, `createDependencyToken` (`src/shared/container/di-container.ts`).
 *   - `buildEventEnvelope` (`src/shared/kernel/application-event.catalog.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente estatica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import { DependencyContainer, DI_TOKENS, createDependencyToken } from '../../src/shared/container/di-container';
import { RedisChannels, RedisKeys, RedisStreams } from '../../src/shared/infrastructure/redis/redis-key-namespaces';
import { TOKEN_BUCKET_LUA_SCRIPT, TOKEN_BUCKET_POLICIES } from '../../src/shared/infrastructure/redis/token-bucket.lua';
import { buildEventEnvelope } from '../../src/shared/kernel/application-event.catalog';

/** Prefijo de claves usado en las comprobaciones de patron. */
const PREFIX = 'oa';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** Verifica que cada clave y canal de Redis respete el patron exacto documentado en el Ledger. */
function verifyRedisKeyNamespaces(): void {
  const expectedKeys: readonly (readonly [string, string])[] = [
    [RedisKeys.authUserTokenVersion(PREFIX, 'usr-1'), 'oa:auth:user_tv:usr-1'],
    [RedisKeys.apiKeyBySha256(PREFIX, 'a'.repeat(64)), `oa:apikey:sha256:${'a'.repeat(64)}`],
    [RedisKeys.projectAllowedDomains(PREFIX, 'prj-1'), 'oa:proj:prj-1:allowed_domains'],
    [RedisKeys.ragMapMeta(PREFIX, 'prj-1'), 'oa:rag_map:proj:prj-1:meta'],
    [RedisKeys.ragMapRoutes(PREFIX, 'prj-1'), 'oa:rag_map:proj:prj-1:routes'],
    [RedisKeys.sdkHandshakeNonce(PREFIX, 'jti-1'), 'oa:sdk_handshake:nonce:jti-1'],
    [RedisKeys.voiceSessionState(PREFIX, 'vs-1'), 'oa:voice_session:state:vs-1'],
    [RedisKeys.organizationActiveSessions(PREFIX, 'org-1'), 'oa:org:org-1:active_sessions'],
    [RedisKeys.organizationBilling(PREFIX, 'org-1'), 'oa:org:org-1:billing'],
    [RedisKeys.webhookEventSeen(PREFIX, 'evt-1'), 'oa:whop:webhook:evt:evt-1'],
    [RedisKeys.checkoutIssued(PREFIX, 'chk-1'), 'oa:checkout:issued:chk-1'],
    [RedisKeys.rateLimitBucket(PREFIX, 'AUTH_BY_IP', '203.0.113.7'), 'oa:rl:tb:auth_by_ip:203.0.113.7'],
    [RedisKeys.distributedLock(PREFIX, 'settlement:org-1'), 'oa:lock:settlement:org-1'],
  ];

  for (const [actual, expected] of expectedKeys) {
    check(actual === expected, `La clave generada debe ser exactamente "${expected}" (generada: "${actual}")`);
  }

  check(RedisChannels.globalEvents(PREFIX) === 'oa:events:global', 'El canal global de eventos debe respetar el patron');
  check(RedisChannels.governanceCommands(PREFIX) === 'oa:governance:commands', 'El canal de gobierno debe respetar el patron');
  check(
    RedisChannels.terminateOrganizationSessions(PREFIX, 'org-1') === 'oa:terminate:org:org-1',
    'El canal de terminacion por organizacion debe respetar el patron'
  );
  check(RedisStreams.domainEvents(PREFIX) === 'oa:events:stream', 'El stream de eventos debe respetar el patron');

  check(
    RedisKeys.authUserTokenVersion('otro', 'usr-1') === 'otro:auth:user_tv:usr-1',
    'El prefijo debe ser sustituible sin alterar el resto del patron'
  );
  check(
    RedisKeys.rateLimitBucket(PREFIX, 'SDK_HANDSHAKE_GLOBAL_BY_PROJECT', 'prj-1') === 'oa:rl:tb:sdk_handshake_global_by_project:prj-1',
    'El codigo de politica debe normalizarse a minusculas en la clave'
  );
  check(
    RedisKeys.webhookEventSeen(PREFIX, 'evt-1') !== RedisKeys.checkoutIssued(PREFIX, 'evt-1'),
    'Dos namespaces distintos nunca deben producir la misma clave'
  );
}

/** Verifica la coherencia interna del catalogo de las 8 politicas de cuota. */
function verifyTokenBucketPolicyCatalog(): void {
  const policyCodes = Object.keys(TOKEN_BUCKET_POLICIES);
  check(policyCodes.length === 8, `Deben existir exactamente 8 politicas de cuota (encontradas: ${policyCodes.length})`);

  for (const policyCode of policyCodes) {
    const policy = TOKEN_BUCKET_POLICIES[policyCode as keyof typeof TOKEN_BUCKET_POLICIES];
    check(policy.capacity > 0, `La politica ${policyCode} debe declarar capacidad positiva`);
    check(policy.windowSeconds > 0, `La politica ${policyCode} debe declarar una ventana positiva`);
    check(policy.tokensPerRequest > 0, `La politica ${policyCode} debe consumir al menos una ficha`);
    check(policy.idleTtlSeconds > 0, `La politica ${policyCode} debe declarar vigencia de limpieza`);
    check(policy.description.length > 20, `La politica ${policyCode} debe documentar su alcance en espanol`);
    const tokensPerSecond = (policy.capacity / policy.windowSeconds) * 1000;
    check(
      Number.isFinite(tokensPerSecond) && tokensPerSecond > 0,
      `La velocidad de recarga de ${policyCode} debe ser finita y positiva`
    );
    check(
      /^\d+$/.test(String(Math.ceil(tokensPerSecond * 1000))),
      `La velocidad de recarga de ${policyCode} debe expresarse en micro-fichas enteras`
    );
  }

  check(Object.isFrozen(TOKEN_BUCKET_POLICIES), 'El catalogo de politicas debe ser inmutable');
  check(Object.isFrozen(TOKEN_BUCKET_POLICIES.AUTH_BY_IP), 'Cada politica debe ser inmutable');
  check(
    TOKEN_BUCKET_POLICIES.AUTH_BY_IP.code === 'AUTH_BY_IP',
    'El codigo de cada politica debe coincidir con su clave en el catalogo'
  );

  check(TOKEN_BUCKET_LUA_SCRIPT.includes('HMGET'), 'El script Lua debe leer el estado con HMGET');
  check(TOKEN_BUCKET_LUA_SCRIPT.includes('HMSET'), 'El script Lua debe persistir el estado con HMSET');
  check(TOKEN_BUCKET_LUA_SCRIPT.includes("redis.call('TIME')"), 'El script Lua debe usar el reloj del servidor, no el de la aplicacion');
  check(TOKEN_BUCKET_LUA_SCRIPT.includes('EXPIRE'), 'El script Lua debe aplicar vigencia para limpiar cubos inactivos');
  check(!TOKEN_BUCKET_LUA_SCRIPT.includes('tonumber(ARGV[5])'), 'El script no debe depender de parametros no documentados');
  check(
    TOKEN_BUCKET_LUA_SCRIPT.includes('math.floor'),
    'El script debe truncar con math.floor para mantener la aritmetica entera'
  );
}

/** Verifica el contenedor de inyeccion: resolucion, cacheo, duplicados y ambitos hijos. */
function verifyDependencyContainer(): void {
  const container = new DependencyContainer();
  const sampleToken = createDependencyToken<{ readonly nombre: string }>('PruebaServicio');
  const factoryToken = createDependencyToken<{ readonly instancia: number }>('PruebaFabrica');

  check(container.listRegisteredTokens().length === 0, 'Un contenedor nuevo no debe tener registros');
  check(!container.has(sampleToken), 'Un token no registrado no debe reportarse como disponible');
  check(container.tryGet(sampleToken) === undefined, 'tryGet debe devolver undefined en lugar de lanzar');

  let missingError: unknown = null;
  try {
    container.get(sampleToken);
  } catch (error) {
    missingError = error;
  }
  check(
    missingError instanceof Error && missingError.message.includes('DEPENDENCIA_NO_REGISTRADA'),
    'Resolver un token no registrado debe lanzar un error explicado en espanol'
  );

  const instance = { nombre: 'servicio-de-prueba' };
  container.registerInstance(sampleToken, instance);
  check(container.get(sampleToken) === instance, 'El contenedor debe devolver exactamente la instancia registrada');
  check(container.has(sampleToken), 'Tras registrarlo, el token debe reportarse como disponible');
  check(container.listRegisteredTokens().includes('PruebaServicio'), 'El diagnostico debe listar los tokens registrados');

  let duplicateError: unknown = null;
  try {
    container.registerInstance(sampleToken, { nombre: 'duplicado' });
  } catch (error) {
    duplicateError = error;
  }
  check(
    duplicateError instanceof Error && duplicateError.message.includes('DEPENDENCIA_DUPLICADA'),
    'Registrar dos veces el mismo token debe fallar con un mensaje explicito'
  );

  let factoryInvocations = 0;
  container.registerFactory(factoryToken, () => {
    factoryInvocations += 1;
    return { instancia: factoryInvocations };
  });
  check(factoryInvocations === 0, 'La fabrica no debe evaluarse durante el registro');
  const firstResolution = container.get(factoryToken);
  const secondResolution = container.get(factoryToken);
  check(factoryInvocations === 1, 'La fabrica debe evaluarse una sola vez y cachear el resultado');
  check(firstResolution === secondResolution, 'Las resoluciones sucesivas deben devolver la misma instancia');

  const childScope = container.createScope();
  check(childScope.get(sampleToken) === instance, 'El ambito hijo debe resolver los tokens del contenedor padre');
  check(childScope.has(sampleToken), 'El ambito hijo debe reportar como disponible lo heredado del padre');

  const overrideToken = createDependencyToken<{ readonly nombre: string }>('PruebaServicio');
  const overriddenInstance = { nombre: 'servicio-sustituido' };
  childScope.registerInstance(overrideToken, overriddenInstance);
  check(childScope.get(overrideToken) === overriddenInstance, 'El ambito hijo debe poder sustituir una dependencia');
  check(container.get(sampleToken) === instance, 'La sustitucion en el hijo no debe contaminar al contenedor padre');

  const tokenName = createDependencyToken<string>('TokenConNombre').toString();
  check(tokenName === 'DependencyToken<TokenConNombre>', 'La representacion textual del token debe ser legible en diagnosticos');

  const catalogTokens = Object.values(DI_TOKENS);
  check(catalogTokens.length === 18, `El catalogo debe declarar 18 tokens (encontrados: ${catalogTokens.length})`);
  check(new Set(catalogTokens.map((token) => token.tokenName)).size === 18, 'Ningun token del catalogo debe repetir nombre');
}

/** Verifica la fabrica de sobres de evento: identificador unico y trazabilidad completa. */
function verifyEventCatalog(): void {
  const firstEnvelope = buildEventEnvelope(
    'billing.payment_succeeded',
    {
      organizationId: 'org-1',
      whopSubscriptionId: 'sub-1',
      externalEventId: 'evt-externo-1',
      grantedMinutes: '600.000000',
    },
    { organizationId: 'org-1', correlationId: 'req-1' }
  );
  const secondEnvelope = buildEventEnvelope('billing.payment_succeeded', {
    organizationId: 'org-1',
    whopSubscriptionId: 'sub-1',
    externalEventId: 'evt-externo-1',
    grantedMinutes: '600.000000',
  });

  check(firstEnvelope.eventId !== secondEnvelope.eventId, 'Cada evento debe recibir un identificador unico e irrepetible');
  check(firstEnvelope.eventId.startsWith('evt_'), 'El identificador del evento debe llevar el prefijo evt_');
  check(firstEnvelope.eventName === 'billing.payment_succeeded', 'El sobre debe conservar el nombre canonico del evento');
  check(firstEnvelope.organizationId === 'org-1', 'El sobre debe registrar la organizacion de origen');
  check(firstEnvelope.correlationId === 'req-1', 'El sobre debe conservar el identificador de correlacion');
  check(firstEnvelope.emittedByPool === 'API_CONTROL_PLANE', 'El sobre debe declarar el Node Pool emisor');
  check(secondEnvelope.organizationId === null, 'Sin contexto explicito, la organizacion debe quedar como nula');
  check(!Number.isNaN(Date.parse(firstEnvelope.occurredAtIso)), 'La marca temporal del evento debe ser una fecha ISO valida');
  check(firstEnvelope.payload.grantedMinutes === '600.000000', 'La carga util debe conservar los decimales de 6 cifras');
}

/** Ejecuta los 4 grupos de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA UNITARIA DE CONTRATOS DE INFRAESTRUCTURA (PARTE 3)');
  console.log('='.repeat(96));

  verifyRedisKeyNamespaces();
  console.log('[1/4] Patrones de claves, canales y streams de Redis: APROBADO.');

  verifyTokenBucketPolicyCatalog();
  console.log('[2/4] Catalogo de las 8 politicas de cuota y script Lua: APROBADO.');

  verifyDependencyContainer();
  console.log('[3/4] Contenedor de inyeccion y catalogo de tokens: APROBADO.');

  verifyEventCatalog();
  console.log('[4/4] Sobres de evento y trazabilidad: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main();
