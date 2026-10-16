/**
 * @archivo tests/integration/handshake-domain-cache-invalidation.test.ts
 * @modulo 02-projects-and-keys / 03-visual-trainer-and-rag (Cache de Dominios Autorizados del SDK)
 * @proposito
 *   Reproduce C1-05 contra un Redis REAL: la lista de origenes autorizados de un proyecto se
 *   publica con vigencia de 86 400 segundos y la lectura jamas la revalida contra PostgreSQL. La
 *   purga de la cache solo alcanza al proceso que escribe —`syncProjectDomainsInRedis()`— porque no
 *   existe invalidacion por evento entre nodos. En consecuencia, un dominio dado de baja en la base
 *   de datos por otro nodo sigue autorizando el handshake del SDK durante un dia entero.
 *
 *   La prueba usa el repositorio real `PostgresProjectsKeysRepository` y el cliente real
 *   `RedisClusterClient`; lo unico simulado es PostgreSQL, que se sustituye por un almacen en memoria
 *   con la misma semantica que las sentencias del repositorio (`is_active = TRUE` y `DELETE`).
 *
 * @resumen_contenido
 *   - `EscenarioCacheDominios`: almacen en memoria de filas de `allowed_domains`.
 *   - `buildRepository()`: repositorio real sobre Redis real y PostgreSQL simulado.
 *   - FASE 1: sin entrada en cache la lectura cae a PostgreSQL (comportamiento correcto).
 *   - FASE 2: la publicacion en cache fija una vigencia de 86 400 segundos.
 *   - FASE 3: la baja del dominio en otro nodo no invalida la cache y el origen sigue autorizado.
 *
 * @dependencias_internas
 *   - `PostgresProjectsKeysRepository` y `syncProjectDomainsInRedis()` (src/modules/02-projects-and-keys).
 *   - `isOriginMatchingPattern()` (dominio de origenes del SDK).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `loadDotEnvFile()` (src/config/env.dotenv-loader.ts).
 *
 * @dependencias_externas
 *   - `node:assert`, `node:crypto` (asercciones nativas e identificador de ejecucion).
 *   - Redis real en `REDIS_CLUSTER_URLS` (por omision `redis://localhost:6379`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (simulado): `allowed_domains`.
 *   - Redis: `oa:proj:<projectId>:allowed_domains` (clave eliminada al terminar la prueba).
 */

import * as assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isOriginMatchingPattern } from '../../src/modules/02-projects-and-keys/domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../../src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository';
import { mapAllowedDomainRow } from '../../src/modules/02-projects-and-keys/infrastructure/projects-keys-row.mapper';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { RedisKeys } from '../../src/shared/infrastructure/redis/redis-key-namespaces';

/** Identificador unico de esta ejecucion, usado para aislar la clave de Redis. */
const RUN_ID = randomUUID().slice(0, 12);

/** Nodo de Redis de la prueba. Se declara de forma explicita para no depender del contrato de entorno. */
const REDIS_NODE_URL = 'redis://localhost:6379';

/** Prefijo de claves de la plataforma. */
const KEY_PREFIX = 'oa';

/** Proyecto sintetico de la prueba: no colisiona con ninguna clave real del servidor. */
const PROJECT_ID = `proyecto-c1-05-${RUN_ID}`;

/** Patron de origen registrado por el socio antes de la baja. */
const PATTERN_CONTRATO_VIGENTE = 'https://socio.empresa.com';

/** Origen presentado por el navegador del usuario final del socio. */
const ORIGIN_DEL_SOCIO = 'https://socio.empresa.com';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/** Fila de `allowed_domains` tal como la devuelve el mapeador del repositorio. */
interface FilaDominio {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly origin_pattern: string;
  readonly allow_localhost_dev: boolean;
  readonly dns_verification_token: string | null;
  readonly dns_verified_at: Date | null;
  readonly is_active: boolean;
  readonly created_by_user_id: string | null;
  readonly created_at: Date;
}

/**
 * Almacen en memoria que imita la semantica de las sentencias del repositorio.
 */
class EscenarioCacheDominios {
  private readonly filas = new Map<string, FilaDominio>();

  /**
   * Registra un origen autorizado, reutilizando la clave natural `(project_id, origin_pattern)`.
   *
   * @param projectId - Proyecto propietario del origen.
   * @param originPattern - Patron de origen autorizado.
   * @returns La fila resultante.
   */
  public registrar(projectId: string, originPattern: string): FilaDominio {
    const fila: FilaDominio = {
      id: `dom-${this.filas.size + 1}`,
      organization_id: '018f0000-0000-7000-8000-0000000000aa',
      project_id: projectId,
      origin_pattern: originPattern.trim().toLowerCase(),
      allow_localhost_dev: false,
      dns_verification_token: null,
      dns_verified_at: null,
      is_active: true,
      created_by_user_id: null,
      created_at: new Date(),
    };
    this.filas.set(fila.id, fila);
    return fila;
  }

  /**
   * Da de baja el origen: es el `DELETE` que ejecutaria el nodo que atiende la peticion del panel.
   *
   * @param projectId - Proyecto propietario.
   */
  public darDeBaja(projectId: string): void {
    for (const [id, fila] of this.filas.entries()) {
      if (fila.project_id === projectId) {
        this.filas.delete(id);
      }
    }
  }

  /**
   * Reproduce `listAllowedDomainsByProject()`: solo filas activas del proyecto.
   *
   * @param projectId - Proyecto consultado.
   * @returns Filas activas del proyecto.
   */
  public listarActivas(projectId: string): readonly FilaDominio[] {
    return Array.from(this.filas.values()).filter((f) => f.project_id === projectId && f.is_active);
  }
}

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/**
 * Construye el repositorio real sobre Redis real y PostgreSQL simulado.
 *
 * @param redisClient - Cliente Redis ya conectado.
 * @param escenario - Almacen en memoria que sustituye a PostgreSQL.
 * @returns Repositorio de proyectos y claves listo para la prueba.
 */
function buildRepository(
  redisClient: RedisClusterClient,
  escenario: EscenarioCacheDominios
): PostgresProjectsKeysRepository {
  const repository = new PostgresProjectsKeysRepository(redisClient, KEY_PREFIX);

  // Solo se sustituye PostgreSQL; la publicacion y la lectura de la cache en Redis siguen siendo el
  // codigo real del repositorio (C1-05). Las filas se mapean con el mapeador oficial, exactamente
  // igual que la ruta real de base de datos, para que las entidades conserven `originPattern`.
  repository.listAllowedDomainsByProject = async (_client: PoolClient, projectId: string) =>
    escenario.listarActivas(projectId).map((fila) => mapAllowedDomainRow(fila));
  return repository;
}

/**
 * Ejecuta las tres fases de la reproduccion de C1-05 y limpia la clave al terminar.
 */
async function main(): Promise<void> {
  console.log('================================================================================');
  console.log('C1-05 CACHE DE DOMINIOS AUTORIZADOS: VIGENCIA DE 24 HORAS SIN INVALIDACION POR EVENTO');
  console.log('================================================================================');

  const redisClient = new RedisClusterClient({
    clusterUrls: [REDIS_NODE_URL],
    keyPrefix: KEY_PREFIX,
    connectTimeoutMs: 5000,
  });
  const salud = await redisClient.healthCheck();
  console.log(`[Redis] ${REDIS_NODE_URL} alcanzable=${String(salud.reachable)} modo=${salud.mode} latencia=${salud.latencyMs}ms`);
  check(salud.reachable, 'Redis debe estar activo para esta prueba de cache');

  const escenario = new EscenarioCacheDominios();
  const repository = buildRepository(redisClient, escenario);
  const cacheKey = RedisKeys.projectAllowedDomains(KEY_PREFIX, PROJECT_ID);
  const clienteSimulado = {} as PoolClient;

  try {
    await redisClient.keys.remove(cacheKey);
    const fila = escenario.registrar(PROJECT_ID, PATTERN_CONTRATO_VIGENTE);
    console.log(`[Dato] Proyecto ${PROJECT_ID} con origen autorizado ${fila.origin_pattern}`);

    // FASE 1: sin entrada en cache la lectura debe caer a PostgreSQL.
    console.log('\n--- FASE 1: cache vacia, la lectura cae a PostgreSQL (comportamiento correcto) ---');
    const cacheVacia = await repository.getCachedProjectDomains(PROJECT_ID);
    console.log(`[Cache] getCachedProjectDomains() con cache vacia devolvio ${String(cacheVacia)}`);
    check(cacheVacia === null, 'Sin entrada en cache la lectura debe degradar a PostgreSQL');

    const desdeBase = escenario.listarActivas(PROJECT_ID);
    check(desdeBase.length === 1, 'PostgreSQL debe tener el origen recien registrado');
    check(
      desdeBase.some((d) => isOriginMatchingPattern(ORIGIN_DEL_SOCIO, d.origin_pattern, d.allow_localhost_dev)),
      'El origen del socio debe autorizarse leyendo PostgreSQL'
    );

    // FASE 2: publicacion en cache y medicion de la vigencia real.
    console.log('\n--- FASE 2: publicacion en cache (syncProjectDomainsInRedis) ---');
    await repository.syncProjectDomainsInRedis(clienteSimulado, PROJECT_ID);

    const cachePoblada = await repository.getCachedProjectDomains(PROJECT_ID);
    console.log(`[Cache] contenido publicado: ${JSON.stringify(cachePoblada)}`);
    check(cachePoblada !== null, 'Tras sincronizar, la cache debe contener el origen');

    const ttlSegundos = await redisClient.nativeClient.ttl(cacheKey);
    const horasDeVigencia = Math.round(ttlSegundos / 3600);
    console.log(`[Cache] TTL real de ${cacheKey}: ${ttlSegundos}s (~${horasDeVigencia} horas)`);
    check(ttlSegundos > 0, 'La entrada de cache debe tener vigencia declarada');
    check(
      ttlSegundos > 23 * 3600 && ttlSegundos <= 86400,
      'La vigencia publicada debe corresponder a las 24 horas del hallazgo C1-05'
    );

    // FASE 3: baja del dominio en la base de datos, sin pasar por el nodo que escribe.
    console.log('\n--- FASE 3: baja del dominio en la base de datos (nodo distinto, sin invalidacion) ---');
    escenario.darDeBaja(PROJECT_ID);
    const baseTrasLaBaja = escenario.listarActivas(PROJECT_ID);
    console.log(`[Dato] Origenes activos en PostgreSQL tras la baja: ${baseTrasLaBaja.length}`);
    check(baseTrasLaBaja.length === 0, 'PostgreSQL ya no debe tener el origen autorizado');

    const cacheTrasLaBaja = await repository.getCachedProjectDomains(PROJECT_ID);
    const origenSigueAutorizado = (cacheTrasLaBaja ?? []).some((d) =>
      isOriginMatchingPattern(ORIGIN_DEL_SOCIO, d.pattern, d.allowLocalhost)
    );
    console.log(`[Cache] Contenido tras la baja: ${JSON.stringify(cacheTrasLaBaja)}`);
    console.log(`[Veredicto] El origen dado de baja sigue autorizado por la cache: ${String(origenSigueAutorizado)}`);

    // El defecto C1-05 se reproduce cuando la cache mantiene autorizado un origen ya inexistente.
    check(!origenSigueAutorizado, 'Tras la baja, el origen revocado NO debe seguir autorizado desde la cache');
  } finally {
    await redisClient.keys.remove(cacheKey);
    await redisClient.close();
    console.log(`\n[Limpieza] Clave ${cacheKey} eliminada y conexion Redis cerrada.`);
  }

  console.log('\n================================================================================');
  console.log(`Verificaciones superadas: ${passedAssertions}`);
  console.log('RESULTADO: APROBADO. C1-05 no se reproduce (invalidacion de cache aplicada).');
  console.log('================================================================================');
}

main().catch((error: unknown) => {
  console.error(`Verificaciones superadas antes del fallo: ${passedAssertions}`);
  console.error('RESULTADO: DEFECTO C1-05 REPRODUCIDO. La prueba documenta la revocacion diferida 24 h.');
  console.error('DETALLE DEL FALLO:', error);
  process.exitCode = 1;
});
