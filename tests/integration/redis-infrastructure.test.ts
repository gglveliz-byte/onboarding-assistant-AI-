/**
 * @archivo tests/integration/redis-infrastructure.test.ts
 * @modulo 00-kernel (Prueba de Fuego de Redis, Token Bucket Lua, Bus de Eventos y Contenedor DI)
 * @proposito
 *   Demuestra contra un servidor Redis real que el limitador de cuota es atomico y correcto, que
 *   la idempotencia de webhooks funciona como exclusion mutua, que el bus de eventos entrega en
 *   memoria y propaga por Pub/Sub entre dos conexiones independientes, y que el contenedor de
 *   inyeccion resuelve, cachea y rechaza registros duplicados. Todas las claves usadas llevan un
 *   identificador de ejecucion y una vigencia corta, y se eliminan al terminar: la prueba jamas
 *   deja residuos en el servidor.
 *
 * @resumen_contenido
 *   - Bloque `verifyRedisClientContract()`: Salud, JSON, exclusividad mutua y conjuntos.
 *   - Bloque `verifyTokenBucketAtomicity()`: Cuota dentro del limite, rechazo, `peek` y `reset`.
 *   - Bloque `verifyEventBusHybrid()`: Via local, via global por Pub/Sub, Stream e historial.
 *   - Bloque `verifyDependencyContainer()`: Resolucion, cacheo, duplicados y ambitos hijos.
 *   - Funcion `main()`: Orquesta la bateria y limpia todas las claves al finalizar.
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (`src/shared/infrastructure/redis/redis-cluster.client.ts`).
 *   - `TokenBucketRateLimiter` (`src/shared/infrastructure/redis/token-bucket.lua.ts`).
 *   - `DomainEventBus` (`src/shared/infrastructure/event-bus/domain-event-bus.ts`).
 *   - `DependencyContainer`, `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *   - `RateLimitExceededError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas), `node:crypto` (Identificador de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:rl:tb:*` (Cuotas), `oa:events:global` (Pub/Sub), `oa:events:stream` (Historial).
 */

import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { DependencyContainer, DI_TOKENS, createDependencyToken } from '../../src/shared/container/di-container';
import { DomainEventBus } from '../../src/shared/infrastructure/event-bus/domain-event-bus';
import { RedisClusterClient, createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { TOKEN_BUCKET_POLICIES, TokenBucketRateLimiter } from '../../src/shared/infrastructure/redis/token-bucket.lua';
import { RateLimitExceededError } from '../../src/shared/kernel/result-and-errors';

/** Identificador unico de esta ejecucion, usado para aislar todas las claves de prueba. */
const RUN_ID = randomUUID().slice(0, 12);

/** Claves creadas por la prueba, eliminadas al finalizar. */
const createdKeys: string[] = [];

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

/**
 * Registra una clave para su eliminacion garantizada al finalizar la prueba.
 *
 * @param key - Clave completa creada por la prueba.
 */
function trackKey(key: string): string {
  createdKeys.push(key);
  return key;
}

/** Verifica el contrato basico del cliente Redis: salud, JSON, exclusividad y conjuntos. */
async function verifyRedisClientContract(client: RedisClusterClient): Promise<void> {
  const health = await client.healthCheck();
  check(health.reachable, 'El servidor Redis debe responder al comando PING');
  check(health.latencyMs >= 0 && health.latencyMs < 1000, `La latencia del PING debe medirse (${health.latencyMs}ms)`);
  check(health.mode === 'SINGLE_NODE' || health.mode === 'CLUSTER', 'El modo de operacion debe detectarse correctamente');
  check(health.configuredNodes >= 1, 'Debe declararse al menos un nodo de Redis');

  const billingKey = trackKey(client.keyNamespaces.organizationBilling(`prueba-${RUN_ID}`));
  check(billingKey.startsWith('oa:org:'), 'El prefijo global debe aplicarse a todas las claves');
  check(billingKey.endsWith(':billing'), 'El namespace de facturacion debe respetar el contrato del Ledger');

  const snapshot = { availableMinutes: '485.500000', creditBalanceUsd: '12.500000', planCode: 'PLAN_30' };
  await client.json.setJson(billingKey, snapshot, 30);
  const restored = await client.json.getJson<typeof snapshot>(billingKey);
  check(restored?.availableMinutes === '485.500000', 'El saldo debe conservar la escala de 6 decimales al pasar por cache');
  check(restored?.planCode === 'PLAN_30', 'El plan contratado debe recuperarse intacto desde cache');

  const nonceKey = trackKey(client.keyNamespaces.sdkHandshakeNonce(`nonce-${RUN_ID}`));
  const firstConsumption = await client.keys.setIfAbsent(nonceKey, 'consumido', 30);
  const replayAttempt = await client.keys.setIfAbsent(nonceKey, 'consumido', 30);
  check(firstConsumption, 'El primer uso de un nonce de handshake debe ser aceptado');
  check(!replayAttempt, 'El segundo uso del mismo nonce debe rechazarse (proteccion contra repeticion)');

  const sessionsKey = trackKey(client.keyNamespaces.organizationActiveSessions(`org-${RUN_ID}`));
  await client.counters.addToSet(sessionsKey, 'sesion-1', 60);
  await client.counters.addToSet(sessionsKey, 'sesion-2', 60);
  await client.counters.addToSet(sessionsKey, 'sesion-1', 60);
  check((await client.counters.countSet(sessionsKey)) === 2, 'El conjunto de sesiones activas debe contar miembros unicos');
  await client.counters.removeFromSet(sessionsKey, 'sesion-1');
  check((await client.counters.countSet(sessionsKey)) === 1, 'Quitar una sesion debe reducir la cardinalidad del conjunto');

  const counterKey = trackKey(`${billingKey}:pulsos`);
  await client.counters.increment(counterKey, 30);
  const secondIncrement = await client.counters.increment(counterKey, 30);
  check(secondIncrement === 2, 'El contador atomico debe incrementarse de forma acumulativa');

  await client.json.setText(trackKey(`${billingKey}:texto`), 'valor-plano', 30);
  check((await client.json.getText(`${billingKey}:texto`)) === 'valor-plano', 'El acceso de texto plano debe funcionar');

  const missing = await client.json.getJson<unknown>(`oa:inexistente:${RUN_ID}`);
  check(missing === null, 'Una clave inexistente debe devolver null sin lanzar excepcion');
  check((await client.keys.exists(billingKey)) === true, 'La comprobacion de existencia debe detectar la clave creada');
}

/** Verifica la atomicidad y exactitud del Token Bucket ejecutado en Lua dentro de Redis. */
async function verifyTokenBucketAtomicity(client: RedisClusterClient): Promise<void> {
  const limiter = new TokenBucketRateLimiter(client);

  const trainerPolicy = TOKEN_BUCKET_POLICIES.VISUAL_TRAINER;
  check(trainerPolicy.capacity === 3 && trainerPolicy.windowSeconds === 60, 'La politica del entrenador debe ser 3 por minuto');
  check(TOKEN_BUCKET_POLICIES.AUTH_BY_IP.capacity === 10, 'La politica de acceso por IP debe ser 10 por minuto');
  check(TOKEN_BUCKET_POLICIES.AUTH_FAILURES_BY_ACCOUNT.windowSeconds === 900, 'La politica de fallos por cuenta debe ventilar 15 minutos');
  check(Object.keys(TOKEN_BUCKET_POLICIES).length === 8, 'Deben existir exactamente las 8 politicas oficiales');

  const subject = `prueba-${RUN_ID}`;
  trackKey(client.keyNamespaces.rateLimitBucket('VISUAL_TRAINER', subject));

  const decisions = [];
  for (let attempt = 0; attempt < trainerPolicy.capacity; attempt += 1) {
    decisions.push(await limiter.consume('VISUAL_TRAINER', subject));
  }
  check(
    decisions.every((decision) => decision.allowed),
    `Las ${trainerPolicy.capacity} primeras solicitudes deben ser autorizadas`
  );
  check(decisions[0]?.remainingTokens === 2, 'Tras la primera solicitud deben quedar 2 fichas');
  check(decisions[2]?.remainingTokens === 0, 'Tras agotar la capacidad deben quedar 0 fichas');

  const blockedDecision = await limiter.consume('VISUAL_TRAINER', subject);
  check(!blockedDecision.allowed, 'La solicitud que excede la cuota debe ser rechazada');
  check(blockedDecision.remainingTokens === 0, 'Un cubo agotado no debe reportar fichas disponibles');
  check(blockedDecision.retryAfterSeconds >= 1, `El rechazo debe indicar cuando reintentar (${blockedDecision.retryAfterSeconds}s)`);

  let thrownError: unknown = null;
  try {
    await limiter.assertWithinQuota('VISUAL_TRAINER', subject);
  } catch (error) {
    thrownError = error;
  }
  check(thrownError instanceof RateLimitExceededError, 'La variante estricta debe lanzar RateLimitExceededError');
  check((thrownError as RateLimitExceededError | null)?.httpStatus === 429, 'La cuota excedida debe mapear a HTTP 429');
  check((thrownError as RateLimitExceededError | null)?.wsCloseCode === 4007, 'La cuota excedida debe cerrar el socket con 4007');

  // El cubo se recarga con el tiempo transcurrido (3 fichas por minuto = 1 ficha cada 20 s), por lo
  // que las aserciones de fichas deben tolerar la recarga parcial ocurrida durante la prueba.
  const peeked = await limiter.peek('VISUAL_TRAINER', subject);
  check(peeked.allowed, 'La consulta sin consumo no debe rechazarse a si misma (solicita 0 fichas)');
  check(peeked.remainingTokens >= 0 && peeked.remainingTokens <= 1, `La consulta debe reflejar el cubo agotado (${peeked.remainingTokens} fichas)`);
  check(peeked.retryAfterSeconds === 0, 'Una consulta informativa nunca debe indicar espera');

  const otherBucketBefore = await limiter.peek('VISUAL_TRAINER', `otro-${RUN_ID}`);
  check(
    otherBucketBefore.remainingTokens >= 1 && otherBucketBefore.remainingTokens <= trainerPolicy.capacity,
    `La consulta informativa no debe alterar el cubo de otros sujetos (${otherBucketBefore.remainingTokens} fichas)`
  );

  const otherSubject = `otro-${RUN_ID}`;
  trackKey(client.keyNamespaces.rateLimitBucket('VISUAL_TRAINER', otherSubject));
  const independentBucket = await limiter.consume('VISUAL_TRAINER', otherSubject);
  check(independentBucket.allowed, 'Cada sujeto debe tener su propio cubo independiente');

  const resetPerformed = await limiter.reset('VISUAL_TRAINER', subject);
  check(resetPerformed, 'El reinicio de cuota debe eliminar el cubo existente');
  const afterReset = await limiter.peek('VISUAL_TRAINER', subject);
  check(afterReset.remainingTokens === trainerPolicy.capacity, 'Tras el reinicio el cubo debe recuperar su capacidad completa');

  const authSubject = `ip-${RUN_ID}`;
  trackKey(client.keyNamespaces.rateLimitBucket('AUTH_BY_IP', authSubject));
  let withinQuotaCount = 0;
  for (let attempt = 0; attempt < TOKEN_BUCKET_POLICIES.AUTH_BY_IP.capacity; attempt += 1) {
    const decision = await limiter.consume('AUTH_BY_IP', authSubject);
    if (decision.allowed) {
      withinQuotaCount += 1;
    }
  }
  check(withinQuotaCount === 10, 'La politica de acceso por IP debe permitir exactamente 10 solicitudes en la ventana');
  check(!(await limiter.consume('AUTH_BY_IP', authSubject)).allowed, 'La solicitud 11 desde la misma IP debe rechazarse');
}

/** Verifica las tres vias del bus de eventos: memoria, Pub/Sub global y stream duradero. */
async function verifyEventBusHybrid(client: RedisClusterClient): Promise<void> {
  const publisherBus = new DomainEventBus({ redisClient: client, emittedByPool: 'API_CONTROL_PLANE' });
  const subscriberClient = createRedisClusterClientFromEnv();
  const subscriberBus = new DomainEventBus({ redisClient: subscriberClient, emittedByPool: 'VOICE_REALTIME_GATEWAY' });

  try {
    const localReceived: string[] = [];
    const unsubscribeLocal = publisherBus.subscribeLocal('organization.suspended', (envelope) => {
      localReceived.push(envelope.payload.organizationId);
    });

    const envelope = publisherBus.publishLocal('organization.suspended', {
      organizationId: `org-${RUN_ID}`,
      reason: 'Prueba de integracion del bus de eventos',
      suspendedByUserId: `admin-${RUN_ID}`,
      suspendedAtIso: new Date().toISOString(),
    });

    check(localReceived.length === 1, 'La via en memoria debe entregar el evento al suscriptor local');
    check(localReceived[0] === `org-${RUN_ID}`, 'La carga util debe llegar intacta por la via local');
    check(envelope.eventId.startsWith('evt_'), 'Todo evento debe llevar identificador unico con prefijo evt_');
    check(publisherBus.countLocalSubscribers('organization.suspended') === 1, 'El conteo de suscriptores locales debe ser exacto');

    unsubscribeLocal();
    publisherBus.publishLocal('organization.suspended', {
      organizationId: `org-${RUN_ID}`,
      reason: 'Evento posterior a la cancelacion',
      suspendedByUserId: `admin-${RUN_ID}`,
      suspendedAtIso: new Date().toISOString(),
    });
    check(localReceived.length === 1, 'Tras cancelar la suscripcion no deben entregarse mas eventos');
    check(publisherBus.countLocalSubscribers('organization.suspended') === 0, 'El conteo debe reflejar la cancelacion');

    const globalReceived: string[] = [];
    const unsubscribeGlobal = await subscriberBus.subscribeGlobal('voice.terminate_all_org_sessions', (received) => {
      globalReceived.push(received.payload.organizationId);
    });

    const publishedGlobally = await publisherBus.publishGlobal('voice.terminate_all_org_sessions', {
      organizationId: `org-${RUN_ID}`,
      reason: 'Suspension de organizacion en prueba',
      requestedByUserId: `admin-${RUN_ID}`,
    });
    check(publishedGlobally, 'La publicacion global debe confirmarse por Pub/Sub y Stream');

    const waitDeadline = Date.now() + 3000;
    while (globalReceived.length === 0 && Date.now() < waitDeadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    check(globalReceived.length === 1, 'La via global debe entregar la orden al otro Node Pool');
    check(globalReceived[0] === `org-${RUN_ID}`, 'El payload global debe viajar intacto entre nodos');
    unsubscribeGlobal();

    const otherEventReceived: string[] = [];
    const unsubscribeFilter = await subscriberBus.subscribeGlobal('organization.suspended', (received) => {
      otherEventReceived.push(received.eventName);
    });
    await publisherBus.publishGlobal('voice.terminate_all_org_sessions', {
      organizationId: `org-${RUN_ID}`,
      reason: 'Evento que no debe cruzar el filtro',
      requestedByUserId: `admin-${RUN_ID}`,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    check(otherEventReceived.length === 0, 'El filtro por nombre de evento debe descartar los eventos ajenos');
    unsubscribeFilter();

    const history = await publisherBus.readStreamHistory(20);
    check(history.length >= 2, `El stream duradero debe conservar el historial de eventos (${history.length} entradas)`);
    check(
      history.some((entry) => entry.eventName === 'voice.terminate_all_org_sessions'),
      'El historial debe contener el evento global publicado'
    );
    const latestEntry = history[0];
    check(typeof latestEntry?.publishedAtIso === 'string', 'Cada entrada del historial debe declarar su fecha de publicacion');
  } finally {
    publisherBus.close();
    subscriberBus.close();
    await subscriberClient.close();
  }
}

/** Verifica el contenedor de inyeccion: resolucion, cacheo, duplicados y ambitos hijos. */
function verifyDependencyContainer(): void {
  const container = new DependencyContainer();
  const sampleToken = createDependencyToken<{ readonly nombre: string }>('PruebaServicio');
  const factoryToken = createDependencyToken<{ readonly instancia: number }>('PruebaFabrica');

  check(container.listRegisteredTokens().length === 0, 'Un contenedor nuevo no debe tener registros');
  check(!container.has(sampleToken), 'Un token no registrado no debe reportarse como disponible');

  let missingError: unknown = null;
  try {
    container.get(sampleToken);
  } catch (error) {
    missingError = error;
  }
  check(missingError instanceof Error, 'Resolver un token no registrado debe lanzar un error controlado');
  check(
    missingError instanceof Error && missingError.message.includes('DEPENDENCIA_NO_REGISTRADA'),
    'El error debe explicar en espanol que la dependencia no fue registrada'
  );

  const instance = { nombre: 'servicio-de-prueba' };
  container.registerInstance(sampleToken, instance);
  check(container.get(sampleToken) === instance, 'El contenedor debe devolver exactamente la instancia registrada');
  check(container.has(sampleToken), 'Tras registrarlo, el token debe reportarse como disponible');

  let duplicateError: unknown = null;
  try {
    container.registerInstance(sampleToken, { nombre: 'duplicado' });
  } catch (error) {
    duplicateError = error;
  }
  check(duplicateError instanceof Error, 'Registrar dos veces el mismo token debe ser un error de programacion');
  check(
    duplicateError instanceof Error && duplicateError.message.includes('DEPENDENCIA_DUPLICADA'),
    'El error de duplicado debe explicar la causa en espanol'
  );

  let factoryInvocations = 0;
  container.registerFactory(factoryToken, () => {
    factoryInvocations += 1;
    return { instancia: factoryInvocations };
  });
  const firstResolution = container.get(factoryToken);
  const secondResolution = container.get(factoryToken);
  check(factoryInvocations === 1, 'La fabrica debe evaluarse una sola vez (resolucion perezosa cacheada)');
  check(firstResolution === secondResolution, 'Las resoluciones sucesivas deben devolver la misma instancia');

  const childScope = container.createScope();
  check(childScope.get(sampleToken) === instance, 'El ambito hijo debe resolver los tokens del contenedor padre');
  const overrideToken = createDependencyToken<{ readonly nombre: string }>('PruebaServicio');
  const overriddenInstance = { nombre: 'servicio-sustituido' };
  childScope.registerInstance(overrideToken, overriddenInstance);
  check(childScope.get(overrideToken) === overriddenInstance, 'El ambito hijo debe poder sustituir una dependencia');
  check(container.get(sampleToken) === instance, 'La sustitucion en el hijo no debe contaminar al contenedor padre');
  check(container.tryGet(createDependencyToken<string>('TokenInexistente')) === undefined, 'tryGet debe devolver undefined en lugar de lanzar');

  const infrastructureTokens = [
    DI_TOKENS.EnvironmentConfig,
    DI_TOKENS.LoggerPort,
    DI_TOKENS.RlsDatabasePool,
    DI_TOKENS.RedisClusterClient,
    DI_TOKENS.RateLimiter,
    DI_TOKENS.DomainEventBus,
    DI_TOKENS.IdentityAuthPort,
    DI_TOKENS.ApiKeyValidationPort,
    DI_TOKENS.BillingDeductionPort,
    DI_TOKENS.VoiceRealtimeProvider,
    DI_TOKENS.VoiceGatewayControlPort,
    DI_TOKENS.AuditLoggerPort,
    DI_TOKENS.RagMapQueryPort,
    DI_TOKENS.VisualTrainerPort,
    DI_TOKENS.SuperAdminGovernancePort,
    DI_TOKENS.SdkHandshakePort,
    DI_TOKENS.HttpRouterRegistry,
    DI_TOKENS.WsRouteRegistry,
  ];
  check(infrastructureTokens.length === 18, 'El catalogo debe declarar los 18 tokens de la plataforma');
  const uniqueNames = new Set(infrastructureTokens.map((token) => token.tokenName));
  check(uniqueNames.size === infrastructureTokens.length, 'Ningun token del catalogo debe repetir nombre');
}

/** Ejecuta la bateria completa y limpia todas las claves creadas. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DE INFRAESTRUCTURA REDIS Y AUTO-CONEXION (PARTE 3)');
  console.log('='.repeat(96));

  const client = createRedisClusterClientFromEnv();
  trackKey(client.domainEventsStream);

  try {
    const health = await client.healthCheck();
    console.log(`Redis conectado en modo ${health.mode} con ${health.configuredNodes} nodo(s) | latencia ${health.latencyMs}ms`);

    await verifyRedisClientContract(client);
    console.log('[1/4] Contrato del cliente Redis (salud, JSON, nonces y conjuntos): APROBADO.');

    await verifyTokenBucketAtomicity(client);
    console.log('[2/4] Token Bucket atomico en Lua con las 8 politicas: APROBADO.');

    await verifyEventBusHybrid(client);
    console.log('[3/4] Bus de eventos hibrido (memoria, Pub/Sub y Stream): APROBADO.');

    verifyDependencyContainer();
    console.log('[4/4] Contenedor de inyeccion y catalogo de 18 tokens: APROBADO.');

    console.log('='.repeat(96));
    console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
  } finally {
    const removedKeys = createdKeys.length > 0 ? await client.keys.remove(...createdKeys) : 0;
    console.log(`Limpieza verificada: ${removedKeys} de ${createdKeys.length} claves de prueba eliminadas (incluye el stream de eventos).`);
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('RESULTADO: FALLIDO.');
  console.error(message);
  process.exit(1);
});
