/**
 * @archivo src/shared/infrastructure/redis/redis-typed-accessors.ts
 * @modulo 00-kernel (Accesos Tipados a Datos de Redis)
 * @proposito
 *   Agrupa las operaciones de lectura y escritura de Redis que consumen los modulos, de modo que
 *   el cliente principal quede dedicado a la conexion, la reconexion y el ciclo de vida. Cada
 *   accesor envuelve el cliente nativo y entrega primitivas tipadas y tolerantes a fallos de
 *   serializacion: un JSON corrupto en cache nunca debe tumbar una peticion, sino degradar a
 *   "cache miss" para que la capa superior consulte PostgreSQL.
 *
 * @resumen_contenido
 *   - Clase `RedisJsonAccessors`: Lectura y escritura de objetos y textos serializados.
 *   - Clase `RedisKeyAccessors`: Existencia, eliminacion, expiracion y exclusividad mutua.
 *   - Clase `RedisCounterAccessors`: Contadores atomicos y conjuntos de sesiones activas.
 *
 * @dependencias_internas
 *   - Ninguna (Opera directamente sobre el cliente nativo de `ioredis`).
 *
 * @dependencias_externas
 *   - `ioredis` (Solo como tipo: el cliente se recibe ya construido).
 *
 * @tablas_bd_o_redis
 *   - Redis: todas las claves `oa:*` definidas en `redis-key-namespaces.ts`.
 */

import type { Cluster, Redis } from 'ioredis';

/** Cliente nativo de Redis: instancia unica o cluster. */
export type NativeRedisClient = Redis | Cluster;

/**
 * Accesos tipados para valores serializados como JSON y textos planos.
 */
export class RedisJsonAccessors {
  private readonly client: NativeRedisClient;

  /**
   * @param client - Cliente nativo de Redis ya conectado.
   */
  public constructor(client: NativeRedisClient) {
    this.client = client;
  }

  /**
   * Lee una clave y la deserializa como JSON.
   *
   * @param key - Clave completa construida con los ayudantes de namespace.
   * @returns Objeto deserializado, o `null` si la clave no existe o su contenido es invalido.
   */
  public async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Contenido corrupto: se trata como cache miss y la capa superior consultara PostgreSQL.
      return null;
    }
  }

  /**
   * Serializa un valor como JSON y lo persiste con vigencia opcional.
   *
   * @param key - Clave completa a escribir.
   * @param value - Valor serializable a persistir.
   * @param ttlSeconds - Vigencia en segundos; `0` significa sin caducidad.
   */
  public async setJson(key: string, value: unknown, ttlSeconds: number = 0): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, payload);
  }

  /**
   * Lee una clave de texto.
   *
   * @param key - Clave completa a leer.
   * @returns Valor textual, o `null` si la clave no existe.
   */
  public async getText(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Escribe una clave de texto con vigencia opcional.
   *
   * @param key - Clave completa a escribir.
   * @param value - Valor textual a persistir.
   * @param ttlSeconds - Vigencia en segundos; `0` significa sin caducidad.
   */
  public async setText(key: string, value: string, ttlSeconds: number = 0): Promise<void> {
    if (ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }
}

/**
 * Accesos para el ciclo de vida de las claves: existencia, borrado, caducidad y exclusividad.
 */
export class RedisKeyAccessors {
  private readonly client: NativeRedisClient;

  /**
   * @param client - Cliente nativo de Redis ya conectado.
   */
  public constructor(client: NativeRedisClient) {
    this.client = client;
  }

  /**
   * Comprueba la existencia de una clave.
   *
   * @param key - Clave completa a comprobar.
   * @returns `true` cuando la clave existe.
   */
  public async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /**
   * Elimina una o varias claves.
   *
   * @param keys - Claves completas a eliminar.
   * @returns Numero de claves efectivamente eliminadas.
   */
  public async remove(...keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return this.client.del(...keys);
  }

  /**
   * Aplica o renueva la caducidad de una clave.
   *
   * @param key - Clave completa a la que se aplica la caducidad.
   * @param ttlSeconds - Vigencia en segundos.
   * @returns `true` cuando la caducidad quedo aplicada.
   */
  public async expire(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.expire(key, ttlSeconds)) === 1;
  }

  /**
   * Escribe una clave solo si aun no existe.
   * Es la primitiva base de la idempotencia de webhooks y de los bloqueos de un solo dueño.
   *
   * @param key - Clave completa a escribir.
   * @param value - Valor textual a persistir.
   * @param ttlSeconds - Vigencia en segundos.
   * @returns `true` cuando la clave fue creada por esta operacion.
   */
  public async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
}

/**
 * Accesos para contadores atomicos y conjuntos de miembros (sesiones activas por organizacion).
 */
export class RedisCounterAccessors {
  private readonly client: NativeRedisClient;

  /**
   * @param client - Cliente nativo de Redis ya conectado.
   */
  public constructor(client: NativeRedisClient) {
    this.client = client;
  }

  /**
   * Incrementa un contador atomico y fija su caducidad cuando se crea.
   *
   * @param key - Clave completa del contador.
   * @param ttlSeconds - Vigencia aplicada unicamente en la creacion.
   * @returns Valor del contador tras el incremento.
   */
  public async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1 && ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
    return value;
  }

  /**
   * Agrega un miembro a un conjunto y aplica vigencia al conjunto completo.
   *
   * @param key - Clave completa del conjunto.
   * @param member - Miembro a agregar.
   * @param ttlSeconds - Vigencia del conjunto en segundos.
   * @returns Numero de miembros nuevos agregados (0 si el miembro ya existia).
   */
  public async addToSet(key: string, member: string, ttlSeconds: number): Promise<number> {
    const added = await this.client.sadd(key, member);
    if (ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
    return added;
  }

  /**
   * Quita un miembro de un conjunto.
   *
   * @param key - Clave completa del conjunto.
   * @param member - Miembro a quitar.
   * @returns Numero de miembros efectivamente quitados.
   */
  public async removeFromSet(key: string, member: string): Promise<number> {
    return this.client.srem(key, member);
  }

  /**
   * Cuenta los miembros de un conjunto.
   *
   * @param key - Clave completa del conjunto.
   * @returns Cardinalidad del conjunto.
   */
  public async countSet(key: string): Promise<number> {
    return this.client.scard(key);
  }

  /**
   * Lista los miembros de un conjunto.
   *
   * @param key - Clave completa del conjunto.
   * @returns Miembros actuales del conjunto.
   */
  public async listSet(key: string): Promise<readonly string[]> {
    return this.client.smembers(key);
  }
}
