/**
 * @archivo src/shared/infrastructure/redis/token-bucket.lua.ts
 * @modulo 00-kernel (Limitador Token Bucket Atomico en Lua con 8 Politicas Preconfiguradas)
 * @proposito
 *   Implementa el control de cuota de toda la plataforma mediante un unico script Lua que Redis
 *   ejecuta de forma atomica: leer el estado, recargar fichas, decidir y persistir ocurre sin
 *   posibilidad de intercalado entre peticiones concurrentes. La aritmetica es estrictamente
 *   entera (micro-fichas y milisegundos) porque el punto flotante de Lua se trunca durante el
 *   guardado RDB de Redis y corromperia la recarga tras un reinicio. El tiempo se lee con `TIME`
 *   del propio servidor, de modo que un reloj de aplicacion desajustado no pueda conceder cuota
 *   infinita ni bloquear a un cliente legitimo.
 *
 * @resumen_contenido
 *   - Constante `TOKEN_BUCKET_LUA_SCRIPT`: Script Lua atomico con `HMGET`/`HMSET`/`EXPIRE`/`TIME`.
 *   - Constante `MICRO_TOKENS_PER_TOKEN` y `RATE_SCALE`: Factores de la aritmetica entera.
 *   - Interface `TokenBucketPolicy`: Definicion de capacidad, velocidad de recarga y alcance.
 *   - Constante `TOKEN_BUCKET_POLICIES`: Las 8 politicas oficiales del sistema.
 *   - Interface `TokenBucketDecision`: Resultado normalizado de una evaluacion de cuota.
 *   - Clase `TokenBucketRateLimiter`:
 *       * `consume()`: Evalua y descuenta fichas con `EVALSHA`.
 *       * `peek()`: Consulta el estado del cubo sin descontar fichas.
 *       * `reset()`: Elimina el cubo de un sujeto (usado al resolver un desafio de seguridad).
 *   - Fabrica `createTokenBucketRateLimiter()`: Construccion desde el cliente Redis y el entorno.
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (`./redis-cluster.client.ts`) para ejecutar el script por `EVALSHA`.
 *   - `RateLimitExceededError` (`../../kernel/result-and-errors.ts`) para el rechazo 429.
 *   - `TokenBucketPolicyCode` (`./redis-key-namespaces.ts`) para tipar los codigos de politica.
 *
 * @dependencias_externas
 *   - Ninguna (El script se ejecuta dentro de Redis; no se importa ninguna libreria de cuotas).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:rl:tb:<politica>:<sujeto>` (Hash con `tokens` y `ts` en milisegundos).
 */

import { RateLimitExceededError } from '../../kernel/result-and-errors';
import type { RedisClusterClient } from './redis-cluster.client';
import type { TokenBucketPolicyCode } from './redis-key-namespaces';

/** Micro-fichas que componen una ficha completa (precision de la aritmetica entera). */
export const MICRO_TOKENS_PER_TOKEN = 1000;

/** Escala de la velocidad de recarga: micro-fichas por segundo. */
export const RATE_SCALE = 1000;

/** Capacidad maxima admitida en micro-fichas, acotada para impedir desbordamiento numerico. */
const MAX_CAPACITY_MICRO_TOKENS = 1_000_000_000_000;

/**
 * Script Lua del Token Bucket.
 * `KEYS[1]`: clave del cubo. `ARGV[1]`: capacidad. `ARGV[2]`: micro-fichas por segundo.
 * `ARGV[3]`: fichas solicitadas. `ARGV[4]`: vigencia del cubo en segundos.
 * Devuelve `{ permitido (0/1), fichas_restantes, milisegundos_para_reintentar, fichas_actuales }`.
 */
export const TOKEN_BUCKET_LUA_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local lastTimestamp = tonumber(state[2])

local nowParts = redis.call('TIME')
local nowMs = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)

if tokens == nil or lastTimestamp == nil then
  tokens = capacity
  lastTimestamp = nowMs
end

local elapsedMs = nowMs - lastTimestamp
if elapsedMs < 0 then
  elapsedMs = 0
end

local refilled = math.floor((elapsedMs * refillPerSecond) / 1000)
tokens = tokens + refilled
if tokens > capacity then
  tokens = capacity
end

local allowed = 0
local retryAfterMs = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local missing = requested - tokens
  if refillPerSecond > 0 then
    retryAfterMs = math.ceil((missing * 1000) / refillPerSecond)
  else
    retryAfterMs = 0
  end
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', nowMs)
if ttlSeconds > 0 then
  redis.call('EXPIRE', KEYS[1], ttlSeconds)
end

return { allowed, tokens, retryAfterMs, capacity }
`.trim();

/** Definicion completa de una politica de cuota. */
export interface TokenBucketPolicy {
  /** Codigo estable de la politica. */
  readonly code: TokenBucketPolicyCode;
  /** Nombre tecnico legible de la politica. */
  readonly technicalName: string;
  /** Descripcion en espanol del alcance protegido. */
  readonly description: string;
  /** Numero maximo de solicitudes acumulables (capacidad del cubo). */
  readonly capacity: number;
  /** Ventana de tiempo en la que se agota la capacidad completa. */
  readonly windowSeconds: number;
  /** Fichas descontadas por cada solicitud. */
  readonly tokensPerRequest: number;
  /** Vigencia del cubo sin uso, en segundos (limpieza automatica en Redis). */
  readonly idleTtlSeconds: number;
}

/**
 * Construye una politica derivando la velocidad de recarga de la capacidad y la ventana.
 *
 * @param code - Codigo estable de la politica.
 * @param technicalName - Nombre tecnico legible.
 * @param description - Alcance protegido en espanol.
 * @param capacity - Numero maximo de solicitudes en la ventana.
 * @param windowSeconds - Ventana de tiempo en segundos.
 * @param idleTtlSeconds - Vigencia del cubo sin uso.
 * @returns Politica lista para el limitador.
 */
function definePolicy(
  code: TokenBucketPolicyCode,
  technicalName: string,
  description: string,
  capacity: number,
  windowSeconds: number,
  idleTtlSeconds: number
): TokenBucketPolicy {
  return Object.freeze({
    code,
    technicalName,
    description,
    capacity,
    windowSeconds,
    tokensPerRequest: 1,
    idleTtlSeconds,
  });
}

/**
 * Las 8 politicas oficiales de cuota del sistema.
 * La velocidad de recarga se expresa siempre en fichas por segundo al ejecutar el script.
 */
export const TOKEN_BUCKET_POLICIES: Readonly<Record<TokenBucketPolicyCode, TokenBucketPolicy>> = Object.freeze({
  AUTH_BY_IP: definePolicy('AUTH_BY_IP', 'Autenticacion por direccion IP', 'Frena la fuerza bruta de credenciales desde una misma IP', 10, 60, 120),
  AUTH_FAILURES_BY_ACCOUNT: definePolicy(
    'AUTH_FAILURES_BY_ACCOUNT',
    'Fallos de acceso por cuenta',
    'Frena el ataque dirigido contra una cuenta concreta',
    5,
    900,
    1800
  ),
  DASHBOARD_JWT: definePolicy(
    'DASHBOARD_JWT',
    'Panel autenticado por sesion',
    'Cuota general de la API para una sesion de panel valida',
    120,
    60,
    180
  ),
  SDK_HANDSHAKE_BY_IP: definePolicy(
    'SDK_HANDSHAKE_BY_IP',
    'Handshake del SDK por IP',
    'Frena la generacion masiva de sesiones desde una misma IP',
    15,
    60,
    180
  ),
  SDK_HANDSHAKE_GLOBAL_BY_PROJECT: definePolicy(
    'SDK_HANDSHAKE_GLOBAL_BY_PROJECT',
    'Handshake del SDK por proyecto',
    'Techo global de sesiones por proyecto, independiente del origen',
    600,
    60,
    180
  ),
  SECRET_KEY: definePolicy('SECRET_KEY', 'API de backend por clave secreta', 'Cuota de la API server-to-server', 300, 60, 180),
  VISUAL_TRAINER: definePolicy(
    'VISUAL_TRAINER',
    'Navegador de entrenamiento remoto',
    'Frena la apertura masiva de contenedores de entrenamiento',
    3,
    60,
    180
  ),
  WS_CONTROL: definePolicy(
    'WS_CONTROL',
    'Control del socket de voz',
    'Limita los mensajes de control del canal en tiempo real',
    60,
    10,
    60
  ),
});

/** Resultado normalizado de una evaluacion de cuota. */
export interface TokenBucketDecision {
  /** Indica si la solicitud fue autorizada. */
  readonly allowed: boolean;
  /** Codigo de la politica evaluada. */
  readonly policyCode: TokenBucketPolicyCode;
  /** Sujeto al que se aplico la cuota (IP, cuenta, proyecto o sesion). */
  readonly subject: string;
  /** Fichas completas restantes tras la operacion. */
  readonly remainingTokens: number;
  /** Capacidad total de la politica. */
  readonly capacity: number;
  /** Segundos que el cliente debe esperar antes de reintentar (0 cuando fue autorizado). */
  readonly retryAfterSeconds: number;
}

/**
 * Limitador Token Bucket respaldado por un script Lua atomico en Redis.
 * Ninguna solicitud puede consumir una ficha ya comprometida por otra: la lectura, la recarga
 * y el descuento ocurren dentro de una unica ejecucion atomica en el servidor.
 */
export class TokenBucketRateLimiter {
  private readonly redisClient: RedisClusterClient;

  /**
   * Construye el limitador sobre el cliente Redis unico de la plataforma.
   *
   * @param redisClient - Cliente Redis con el prefijo de claves ya configurado.
   */
  public constructor(redisClient: RedisClusterClient) {
    this.redisClient = redisClient;
  }

  /**
   * Evalua una politica y descuenta las fichas correspondientes de forma atomica.
   *
   * @param policyCode - Codigo de la politica de cuota a aplicar.
   * @param subject - Sujeto de la cuota (IP, cuenta, proyecto o sesion).
   * @param tokensToConsume - Fichas a consumir; por omision, las de la politica.
   * @returns Decision normalizada con fichas restantes y espera recomendada.
   */
  public async consume(policyCode: TokenBucketPolicyCode, subject: string, tokensToConsume?: number): Promise<TokenBucketDecision> {
    const policy = TOKEN_BUCKET_POLICIES[policyCode];
    const requestedTokens = tokensToConsume ?? policy.tokensPerRequest;
    const bucketKey = this.redisClient.keyNamespaces.rateLimitBucket(policyCode, subject);
    const refillPerSecond = (policy.capacity / policy.windowSeconds) * RATE_SCALE;

    const rawResult = await this.redisClient.runScript(
      TOKEN_BUCKET_LUA_SCRIPT,
      [bucketKey],
      [policy.capacity * MICRO_TOKENS_PER_TOKEN, refillPerSecond, requestedTokens * MICRO_TOKENS_PER_TOKEN, policy.idleTtlSeconds]
    );

    const parsed = this.parseScriptResult(rawResult);
    return {
      allowed: parsed.allowed,
      policyCode,
      subject,
      remainingTokens: Math.floor(parsed.remainingMicroTokens / MICRO_TOKENS_PER_TOKEN),
      capacity: policy.capacity,
      retryAfterSeconds: parsed.retryAfterMs > 0 ? Math.max(1, Math.ceil(parsed.retryAfterMs / 1000)) : 0,
    };
  }

  /**
   * Evalua una politica y lanza `RateLimitExceededError` cuando la cuota esta agotada.
   * Es la variante que consumen los middlewares de transporte.
   *
   * @param policyCode - Codigo de la politica de cuota a aplicar.
   * @param subject - Sujeto de la cuota.
   * @param tokensToConsume - Fichas a consumir; por omision, las de la politica.
   * @returns Decision autorizada con las fichas restantes.
   * @throws RateLimitExceededError cuando la cuota esta agotada (se traduce a HTTP 429).
   */
  public async assertWithinQuota(
    policyCode: TokenBucketPolicyCode,
    subject: string,
    tokensToConsume?: number
  ): Promise<TokenBucketDecision> {
    const decision = await this.consume(policyCode, subject, tokensToConsume);
    if (!decision.allowed) {
      throw new RateLimitExceededError(decision.retryAfterSeconds, `${policyCode}:${subject}`);
    }
    return decision;
  }

  /**
   * Consulta el estado del cubo sin descontar fichas.
   * Se implementa consumiendo cero fichas: el script recarga el cubo y lo persiste, pero no
   * descuenta nada, por lo que el estado devuelto es el vigente en este instante.
   *
   * @param policyCode - Codigo de la politica a consultar.
   * @param subject - Sujeto de la cuota.
   * @returns Decision informativa con las fichas disponibles.
   */
  public async peek(policyCode: TokenBucketPolicyCode, subject: string): Promise<TokenBucketDecision> {
    return this.consume(policyCode, subject, 0);
  }

  /**
   * Elimina el cubo de un sujeto para restablecer su cuota.
   * Se usa al superar un desafio de seguridad legitimo (por ejemplo, tras verificar el correo).
   *
   * @param policyCode - Codigo de la politica a restablecer.
   * @param subject - Sujeto cuya cuota se restablece.
   * @returns `true` cuando el cubo existia y fue eliminado.
   */
  public async reset(policyCode: TokenBucketPolicyCode, subject: string): Promise<boolean> {
    const bucketKey = this.redisClient.keyNamespaces.rateLimitBucket(policyCode, subject);
    return (await this.redisClient.keys.remove(bucketKey)) > 0;
  }

  /**
   * Devuelve la definicion de una politica preconfigurada.
   *
   * @param policyCode - Codigo de la politica solicitada.
   * @returns Definicion completa de la politica.
   */
  public getPolicy(policyCode: TokenBucketPolicyCode): TokenBucketPolicy {
    return TOKEN_BUCKET_POLICIES[policyCode];
  }

  /**
   * Interpreta la respuesta cruda del script Lua y valida su forma.
   *
   * @param rawResult - Valor devuelto por Redis.
   * @returns Componentes numericos del resultado del script.
   * @throws Error cuando la respuesta no tiene la forma esperada.
   */
  private parseScriptResult(rawResult: unknown): { allowed: boolean; remainingMicroTokens: number; retryAfterMs: number } {
    if (!Array.isArray(rawResult) || rawResult.length < 3) {
      throw new Error('RESPUESTA_LUA_INVALIDA: el script de Token Bucket no devolvio la estructura esperada de tres elementos.');
    }

    const allowedRaw = Number(rawResult[0]);
    const remainingRaw = Number(rawResult[1]);
    const retryRaw = Number(rawResult[2]);

    if (!Number.isFinite(allowedRaw) || !Number.isFinite(remainingRaw) || !Number.isFinite(retryRaw)) {
      throw new Error('RESPUESTA_LUA_INVALIDA: el script de Token Bucket devolvio valores no numericos.');
    }

    return {
      allowed: allowedRaw === 1,
      remainingMicroTokens: Math.min(remainingRaw, MAX_CAPACITY_MICRO_TOKENS),
      retryAfterMs: Math.max(0, retryRaw),
    };
  }
}

/**
 * Construye el limitador sobre el cliente Redis de la plataforma.
 *
 * @param redisClient - Cliente Redis unico ya construido.
 * @returns Limitador listo para aplicar las 8 politicas oficiales.
 */
export function createTokenBucketRateLimiter(redisClient: RedisClusterClient): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter(redisClient);
}
