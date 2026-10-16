/**
 * @archivo tests/integration/handshake-nonce-concurrency.test.ts
 * @modulo 02-projects-and-keys (Pruebas de Concurrencia y Atomicidad del Nonce de Handshake)
 * @proposito
 *   Verifica de forma exhaustiva y contra una instancia real de Redis que el consumo del nonce
 *   efimero de handshake del SDK sea 100% atomico (C1-01). Demuestra que ante ráfagas concurrentes
 *   (Promise.all) sobre el mismo identificador de nonce, exactamente un consumidor tiene exito y
 *   todos los demas reciben nulo, erradicando la creacion de multiples sesiones con un solo nonce.
 *
 * @dependencias_internas
 *   - `ProjectsKeysRedisStore` (src/modules/02-projects-and-keys/infrastructure/projects-keys-redis.store.ts)
 *   - `createRedisClusterClientFromEnv` (src/shared/infrastructure/redis/redis-cluster.client.ts)
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:sdk_handshake:nonce:<id>`
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisClusterClientFromEnv, RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { ProjectsKeysRedisStore } from '../../src/modules/02-projects-and-keys/infrastructure/projects-keys-redis.store';

describe('C1-01: Atomicidad y Concurrencia del Nonce de Handshake SDK', () => {
  let redisClient: RedisClusterClient;
  let store: ProjectsKeysRedisStore;

  before(async () => {
    const rawUrl = process.env['REDIS_CLUSTER_URLS'] || 'redis://127.0.0.1:6379';
    const resolvedUrl = rawUrl.replace('localhost', '127.0.0.1');
    redisClient = new RedisClusterClient({
      clusterUrls: [resolvedUrl],
      keyPrefix: 'test_c1_01',
    });
    const health = await redisClient.healthCheck();
    assert.equal(health.reachable, true, `Redis debe estar accesible en ${resolvedUrl}`);
    store = new ProjectsKeysRedisStore(redisClient, 'test_c1_01');
  });

  after(async () => {
    if (redisClient) {
      await redisClient.close();
    }
  });

  it('Fase 1: Dos consumos concurrentes simultaneos garantizan que solo uno obtiene el payload', async () => {
    const nonceId = `nonce-concurrent-${Date.now()}-duo`;
    const payload = JSON.stringify({
      projectId: 'proj-c101-test',
      organizationId: 'org-c101-test',
      token: 'jwt-ephemeral-test',
    });

    await store.storeHandshakeNonce(nonceId, payload, 30);

    // Dos consumos compitiendo concurrentemente via Promise.all
    const [consumoA, consumoB] = await Promise.all([
      store.consumeHandshakeNonce(nonceId),
      store.consumeHandshakeNonce(nonceId),
    ]);

    const exitosos = [consumoA, consumoB].filter((resultado) => resultado === payload);
    const nulos = [consumoA, consumoB].filter((resultado) => resultado === null);

    assert.equal(
      exitosos.length,
      1,
      `Debe haber exactamente un consumo exitoso. Obtenido exitosos=${exitosos.length}, nulos=${nulos.length}`
    );
    assert.equal(
      nulos.length,
      1,
      'Exactamente un consumidor concurrente debe recibir null por intento duplicado'
    );

    // Verificacion subsiguiente: un tercer intento secuencial debe devolver null
    const consumoTardio = await store.consumeHandshakeNonce(nonceId);
    assert.equal(consumoTardio, null, 'Un consumo posterior al canje atómico debe retornar null');
  });

  it('Fase 2: Ráfaga concurrente de 10 peticiones simultaneas sobre el mismo nonce', async () => {
    const nonceId = `nonce-concurrent-${Date.now()}-decem`;
    const payload = JSON.stringify({
      projectId: 'proj-c101-burst',
      organizationId: 'org-c101-burst',
      randomEntropy: Math.random(),
    });

    await store.storeHandshakeNonce(nonceId, payload, 30);

    const rafaga = Array.from({ length: 10 }, () => store.consumeHandshakeNonce(nonceId));
    const resultados = await Promise.all(rafaga);

    const ganadores = resultados.filter((res) => res === payload);
    const rechazados = resultados.filter((res) => res === null);

    assert.equal(
      ganadores.length,
      1,
      `En una rafaga de 10 peticiones concurrentes, exactamente 1 debe ganar (ganadores: ${ganadores.length})`
    );
    assert.equal(
      rechazados.length,
      9,
      `En una rafaga de 10 peticiones concurrentes, exactamente 9 deben recibir null (rechazados: ${rechazados.length})`
    );
  });

  it('Fase 3: Fallback en memoria ante degradacion tambien respeta consumo unico', async () => {
    // Probamos el almacen de degradacion en memoria directamente usando una clave no guardada en Redis
    const dummyStore = new ProjectsKeysRedisStore(
      {
        runScript: async () => {
          throw new Error('REDIS_SIMULATED_FAILURE');
        },
      } as unknown as RedisClusterClient,
      'test_degraded'
    );

    const nonceId = `nonce-degraded-${Date.now()}`;
    const payload = 'degraded-payload-test';

    await dummyStore.storeHandshakeNonce(nonceId, payload, 30);

    const primerConsumo = await dummyStore.consumeHandshakeNonce(nonceId);
    assert.equal(primerConsumo, payload, 'El primer consumo en modo degradado debe recuperar el payload');

    const segundoConsumo = await dummyStore.consumeHandshakeNonce(nonceId);
    assert.equal(segundoConsumo, null, 'El segundo consumo en modo degradado debe retornar null');
  });
});
