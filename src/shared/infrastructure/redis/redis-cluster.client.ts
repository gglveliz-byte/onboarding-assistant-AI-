/**
 * @archivo src/shared/infrastructure/redis/redis-cluster.client.ts
 * @modulo 00-kernel (Cliente Redis Cluster Unico con Reconexion Exponencial y Namespaces Tipados)
 * @proposito
 *   Envuelve `ioredis` en la clase `RedisClusterClient`, que es el UNICO punto autorizado de
 *   acceso a Redis. Centraliza la conexion a uno o varios nodos, la reconexion con retroceso
 *   exponencial acotado, el chequeo de salud y los ayudantes tipados para cada namespace de la
 *   arquitectura (versiones de token, claves de API, dominios permitidos, mapas RAG, nonces de
 *   handshake, estado de sesiones de voz e idempotencia de webhooks). Las operaciones de datos
 *   viven en `redis-typed-accessors.ts`; aqui quedan la conexion, los namespaces, el Pub/Sub, los
 *   Streams y la ejecucion de scripts Lua por digest.
 *
 * @resumen_contenido
 *   - Interface `RedisClusterClientOptions`: Parametros de conexion y reconexion.
 *   - Interface `RedisHealthReport`: Resultado del chequeo de salud.
 *   - Interface `RedisStreamEntry`: Entrada historica del stream de eventos.
 *   - Clase `RedisClusterClient`:
 *       * `parseNode()`: Descompone una URL de nodo en parametros de conexion.
 *       * `healthCheck()`: `PING` con latencia medida y cardinalidad de nodos.
 *       * Accesores `json`, `keys` y `counters` (delegados en `redis-typed-accessors.ts`).
 *       * Namespaces `keyNamespaces` y `channels` resueltos con el prefijo configurado.
 *       * `publish()` y `subscribe()`: Pub/Sub entre Node Pools.
 *       * `appendToStream()` y `readStreamEntries()`: Historial duradero de eventos.
 *       * `runScript()`: Scripts Lua por `EVALSHA` con respaldo `EVAL` ante `NOSCRIPT`.
 *   - Fabrica `createRedisClusterClientFromEnv()`: Construccion desde el contrato de entorno.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`../../../config/env.schema.ts`) para URLs, prefijo y timeouts.
 *   - `RedisKeys`, `RedisChannels`, `RedisStreams` (`./redis-key-namespaces.ts`).
 *   - Accesores tipados (`./redis-typed-accessors.ts`).
 *   - `ProviderUnavailableError` (`../../kernel/result-and-errors.ts`) para fallos de conexion.
 *
 * @dependencias_externas
 *   - `ioredis` (Cliente oficial de Redis, unico autorizado por el Ledger).
 *   - `node:crypto` (Digest SHA-1 que Redis exige para cachear scripts por `EVALSHA`).
 *
 * @tablas_bd_o_redis
 *   - Redis: todos los namespaces `oa:*` definidos en `redis-key-namespaces.ts`.
 */

import * as crypto from 'node:crypto';
import Redis, { type Cluster, type RedisOptions } from 'ioredis';
import { getEnvConfig } from '../../../config/env.schema';
import { ProviderUnavailableError } from '../../kernel/result-and-errors';
import { DEFAULT_KEY_PREFIX, RedisChannels, RedisKeys, RedisStreams, type TokenBucketPolicyCode } from './redis-key-namespaces';
import { RedisCounterAccessors, RedisJsonAccessors, RedisKeyAccessors, type NativeRedisClient } from './redis-typed-accessors';

/** Parametros de construccion del cliente Redis. */
export interface RedisClusterClientOptions {
  /** Lista de nodos del cluster en formato `redis://host:puerto`. */
  readonly clusterUrls: readonly string[];
  /** Prefijo obligatorio de todas las claves de la plataforma. */
  readonly keyPrefix?: string;
  /** Tiempo maximo de espera al establecer la conexion, en milisegundos. */
  readonly connectTimeoutMs?: number;
  /** Numero maximo de reintentos por peticion antes de fallar. */
  readonly maxRetriesPerRequest?: number;
  /** Retroceso exponencial maximo entre reconexiones, en milisegundos. */
  readonly maxRetryDelayMs?: number;
}

/** Resultado del chequeo de salud del cluster. */
export interface RedisHealthReport {
  /** Indica si el comando `PING` respondio correctamente. */
  readonly reachable: boolean;
  /** Latencia medida del `PING` en milisegundos. */
  readonly latencyMs: number;
  /** Numero de nodos declarados en la configuracion. */
  readonly configuredNodes: number;
  /** Modo de operacion detectado segun el numero de nodos. */
  readonly mode: 'SINGLE_NODE' | 'CLUSTER';
}

/** Entrada historica recuperada del stream duradero de eventos. */
export interface RedisStreamEntry {
  /** Identificador asignado por Redis a la entrada. */
  readonly entryId: string;
  /** Nombre canonico del evento publicado. */
  readonly eventName: string;
  /** Carga util tal como fue publicada. */
  readonly payload: unknown;
  /** Marca temporal de publicacion declarada por el emisor. */
  readonly publishedAtIso: string;
}

/**
 * Construye los generadores de claves resueltos con el prefijo indicado.
 *
 * @param prefix - Prefijo global de claves de la plataforma.
 * @returns Conjunto de generadores tipados de cada namespace.
 */
function buildKeyNamespaces(prefix: string) {
  return {
    authUserTokenVersion: (userId: string): string => RedisKeys.authUserTokenVersion(prefix, userId),
    apiKeyBySha256: (sha256Hash: string): string => RedisKeys.apiKeyBySha256(prefix, sha256Hash),
    projectAllowedDomains: (projectId: string): string => RedisKeys.projectAllowedDomains(prefix, projectId),
    ragMapMeta: (projectId: string): string => RedisKeys.ragMapMeta(prefix, projectId),
    ragMapRoutes: (projectId: string): string => RedisKeys.ragMapRoutes(prefix, projectId),
    sdkHandshakeNonce: (nonceId: string): string => RedisKeys.sdkHandshakeNonce(prefix, nonceId),
    voiceSessionState: (voiceSessionId: string): string => RedisKeys.voiceSessionState(prefix, voiceSessionId),
    organizationActiveSessions: (organizationId: string): string => RedisKeys.organizationActiveSessions(prefix, organizationId),
    webhookEventSeen: (externalEventId: string): string => RedisKeys.webhookEventSeen(prefix, externalEventId),
    checkoutIssued: (checkoutId: string): string => RedisKeys.checkoutIssued(prefix, checkoutId),
    organizationBilling: (organizationId: string): string => RedisKeys.organizationBilling(prefix, organizationId),
    rateLimitBucket: (policyCode: TokenBucketPolicyCode, subject: string): string => RedisKeys.rateLimitBucket(prefix, policyCode, subject),
    distributedLock: (resource: string): string => RedisKeys.distributedLock(prefix, resource),
  };
}

/**
 * Construye los canales de Pub/Sub resueltos con el prefijo indicado.
 *
 * @param prefix - Prefijo global de claves de la plataforma.
 * @returns Conjunto de canales de eventos entre Node Pools.
 */
function buildChannels(prefix: string) {
  return {
    globalEvents: RedisChannels.globalEvents(prefix),
    governanceCommands: RedisChannels.governanceCommands(prefix),
    terminateOrganizationSessions: (organizationId: string): string => RedisChannels.terminateOrganizationSessions(prefix, organizationId),
  };
}

/**
 * Cliente Redis unico de la plataforma, con reconexion exponencial y namespaces tipados.
 * Los modulos nunca construyen una clave literal ni instancian su propio cliente.
 */
export class RedisClusterClient {
  private readonly client: NativeRedisClient;
  private readonly prefix: string;
  private readonly configuredNodeCount: number;

  /** Accesos tipados a valores JSON y textos planos. */
  public readonly json: RedisJsonAccessors;

  /** Accesos al ciclo de vida de las claves (existencia, borrado y exclusividad mutua). */
  public readonly keys: RedisKeyAccessors;

  /** Accesos a contadores atomicos y conjuntos de sesiones activas. */
  public readonly counters: RedisCounterAccessors;

  /** Constructores tipados de claves resueltos con el prefijo configurado. */
  public readonly keyNamespaces: ReturnType<typeof buildKeyNamespaces>;

  /** Canales de Pub/Sub resueltos con el prefijo configurado. */
  public readonly channels: ReturnType<typeof buildChannels>;

  /**
   * Construye el cliente y registra la politica de reconexion exponencial con jitter.
   *
   * @param options - Parametros de conexion, prefijo y reconexion.
   * @throws ProviderUnavailableError cuando no se declara ningun nodo de Redis.
   */
  public constructor(options: RedisClusterClientOptions) {
    const configuredUrls = options.clusterUrls.filter((url) => url.trim().length > 0);
    if (configuredUrls.length === 0) {
      throw new ProviderUnavailableError('PRIMARY', 'no se declaro ningun nodo de Redis en REDIS_CLUSTER_URLS');
    }

    this.prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.configuredNodeCount = configuredUrls.length;

    const maxRetryDelayMs = options.maxRetryDelayMs ?? 3000;
    const baseOptions: RedisOptions = {
      connectTimeout: options.connectTimeoutMs ?? 5000,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      enableReadyCheck: true,
      retryStrategy: (attempt: number): number => Math.min(2 ** (attempt - 1) * 100, maxRetryDelayMs) + Math.floor(Math.random() * 100),
      reconnectOnError: (error: Error): boolean => error.message.includes('READONLY'),
    };

    if (configuredUrls.length === 1) {
      this.client = new Redis({ ...baseOptions, ...this.parseNode(configuredUrls[0] as string) });
    } else {
      this.client = new Redis.Cluster(configuredUrls.map((url) => this.parseNode(url)), {
        redisOptions: baseOptions,
        clusterRetryStrategy: baseOptions.retryStrategy,
      });
    }

    // Captura los eventos de error de conexion de la biblioteca de Redis para no ensuciar
    // la salida estandar ni emitir advertencias no capturadas ante caidas o reinicios (C1-60).
    this.client.on('error', () => {
      // Error de conexion o reconexion absorbido de forma limpia
    });

    this.json = new RedisJsonAccessors(this.client);
    this.keys = new RedisKeyAccessors(this.client);
    this.counters = new RedisCounterAccessors(this.client);
    this.keyNamespaces = buildKeyNamespaces(this.prefix);
    this.channels = buildChannels(this.prefix);
  }

  /**
   * Descompone una URL de nodo en los parametros que espera el cliente de Redis.
   *
   * @param nodeUrl - URL del nodo en formato `redis://usuario:clave@host:puerto`.
   * @returns Parametros de conexion del nodo.
   */
  private parseNode(nodeUrl: string): RedisOptions {
    const parsed = new URL(nodeUrl);
    const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined;
    const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined;
    return {
      host: parsed.hostname,
      port: parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 6379,
      ...(password === undefined ? {} : { password }),
      ...(username === undefined ? {} : { username }),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  }

  /** Stream duradero de eventos de dominio resuelto con el prefijo configurado. */
  public get domainEventsStream(): string {
    return RedisStreams.domainEvents(this.prefix);
  }

  /**
   * Verifica que el cluster responda y mide la latencia del comando `PING`.
   *
   * @returns Informe de salud con latencia y modo de operacion detectado.
   */
  public async healthCheck(): Promise<RedisHealthReport> {
    const startedAt = Date.now();
    const mode: 'SINGLE_NODE' | 'CLUSTER' = this.configuredNodeCount > 1 ? 'CLUSTER' : 'SINGLE_NODE';
    try {
      const response = await this.client.ping();
      return { reachable: response === 'PONG', latencyMs: Date.now() - startedAt, configuredNodes: this.configuredNodeCount, mode };
    } catch {
      return { reachable: false, latencyMs: Date.now() - startedAt, configuredNodes: this.configuredNodeCount, mode };
    }
  }

  /**
   * Publica un mensaje en un canal de Pub/Sub para los demas Node Pools.
   *
   * @param channel - Canal de destino.
   * @param message - Carga serializable del mensaje.
   * @returns Numero de suscriptores que recibieron el mensaje.
   */
  public async publish(channel: string, message: unknown): Promise<number> {
    return this.client.publish(channel, JSON.stringify(message));
  }

  /**
   * Se suscribe a un canal y entrega cada mensaje deserializado al manejador indicado.
   *
   * @param channel - Canal a escuchar.
   * @param handler - Funcion invocada por cada mensaje recibido.
   * @returns Funcion asincrona para cancelar la suscripcion.
   */
  public async subscribe(channel: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> {
    const subscriber = this.client.duplicate();
    await subscriber.subscribe(channel);
    subscriber.on('message', (_channelName: string, rawMessage: string) => {
      try {
        handler(JSON.parse(rawMessage) as unknown);
      } catch {
        handler(rawMessage);
      }
    });
    return async (): Promise<void> => {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    };
  }

  /**
   * Agrega un evento al stream duradero con la estructura estandar de la plataforma.
   *
   * @param eventType - Tipo de evento publicado (por ejemplo `organization.suspended`).
   * @param payload - Carga serializable del evento.
   * @param maxStreamLength - Longitud maxima aproximada del stream para acotar la memoria.
   * @returns Identificador asignado por Redis al evento.
   */
  public async appendToStream(eventType: string, payload: unknown, maxStreamLength: number = 10000): Promise<string> {
    const entryId = await this.client.xadd(
      this.domainEventsStream,
      'MAXLEN',
      '~',
      String(maxStreamLength),
      '*',
      'event_type',
      eventType,
      'payload',
      JSON.stringify(payload),
      'published_at',
      new Date().toISOString()
    );
    return entryId ?? '';
  }

  /**
   * Recupera las entradas mas recientes del stream duradero de eventos.
   *
   * @param limit - Numero maximo de entradas a recuperar (acotado entre 1 y 1000).
   * @returns Entradas en orden cronologico descendente.
   */
  public async readStreamEntries(limit: number = 50): Promise<readonly RedisStreamEntry[]> {
    const rawEntries = await this.client.xrevrange(this.domainEventsStream, '+', '-', 'COUNT', Math.max(1, Math.min(limit, 1000)));
    const entries: RedisStreamEntry[] = [];

    for (const [entryId, fields] of rawEntries) {
      const fieldMap = new Map<string, string>();
      for (let index = 0; index < fields.length; index += 2) {
        const fieldName = fields[index];
        const fieldValue = fields[index + 1];
        if (fieldName !== undefined && fieldValue !== undefined) {
          fieldMap.set(fieldName, fieldValue);
        }
      }

      const payloadRaw = fieldMap.get('payload');
      entries.push({
        entryId,
        eventName: fieldMap.get('event_type') ?? 'desconocido',
        payload: payloadRaw === undefined ? null : this.parseJsonOrRaw(payloadRaw),
        publishedAtIso: fieldMap.get('published_at') ?? new Date(0).toISOString(),
      });
    }

    return entries;
  }

  /**
   * Ejecuta un script Lua de forma atomica, cacheandolo por digest (`EVALSHA`).
   * Si el digest no esta en la cache del servidor, se envia el codigo completo una sola vez.
   *
   * @param scriptBody - Codigo Lua del script.
   * @param scriptKeys - Claves que el script declara y manipula.
   * @param scriptArgs - Argumentos escalares del script.
   * @returns Resultado devuelto por el script.
   */
  public async runScript(scriptBody: string, scriptKeys: readonly string[], scriptArgs: readonly (string | number)[]): Promise<unknown> {
    const digest = crypto.createHash('sha1').update(scriptBody).digest('hex');
    const flatArgs = scriptArgs.map((value) => String(value));
    try {
      return await this.client.evalsha(digest, scriptKeys.length, ...scriptKeys, ...flatArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('NOSCRIPT')) {
        throw error;
      }
      return this.client.eval(scriptBody, scriptKeys.length, ...scriptKeys, ...flatArgs);
    }
  }

  /**
   * Deserializa una carga util sin propagar la excepcion ante contenido invalido.
   *
   * @param rawValue - Cadena JSON cruda.
   * @returns Valor deserializado, o la propia cadena cuando no es JSON valido.
   */
  private parseJsonOrRaw(rawValue: string): unknown {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return rawValue;
    }
  }

  /**
   * Expone el cliente nativo para integraciones avanzadas (bloqueos, transacciones `MULTI`).
   * Su uso directo debe justificarse: la via preferida son los accesores tipados.
   *
   * @returns Instancia nativa del cliente de Redis (nodo unico o cluster).
   */
  public get nativeClient(): NativeRedisClient {
    return this.client;
  }

  /**
   * Cierra la conexion de forma ordenada.
   */
  public async close(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Construye el cliente Redis a partir del contrato de entorno ya validado.
 *
 * @returns Cliente configurado con los nodos, el prefijo y los timeouts del entorno.
 */
export function createRedisClusterClientFromEnv(): RedisClusterClient {
  const environment = getEnvConfig();
  return new RedisClusterClient({
    clusterUrls: environment.REDIS_CLUSTER_URLS,
    keyPrefix: environment.REDIS_KEY_PREFIX,
    connectTimeoutMs: environment.REDIS_CONNECT_TIMEOUT_MS,
  });
}
