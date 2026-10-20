/**
 * @archivo src/modules/06-superadmin-governance/application/public-demo-config.use-case.ts
 * @modulo 06-superadmin-governance (Gobierno de la Configuración de la Demostración Pública)
 * @proposito
 *   Sustituye el hardcodeo de la demostración pública (90 s de duración y 2 demos por IP al día) por
 *   una configuración gobernable desde el panel SuperAdmin, persistida en Redis (`oa:demo:config`, sin
 *   caducidad). Vive en el módulo de gobierno porque las RUTAS `/api/v1/superadmin/*` que la escriben
 *   deben pertenecer a este módulo (invariante verificada por el ensamblaje E2E). El Módulo 07 importa
 *   únicamente `readPublicDemoConfig()` para aplicar la configuración al emitir sesiones.
 *
 * @resumen_contenido
 *   - `PublicDemoConfig`, `DEMO_CONFIG_DEFAULTS` y `PUBLIC_DEMO_CONFIG_KEY`.
 *   - `readPublicDemoConfig()`: lectura tolerante a fallos con defectos y recorte a rangos duros.
 *   - `GetPublicDemoConfigUseCase` y `UpdatePublicDemoConfigUseCase`: lectura/escritura para SuperAdmin.
 *
 * @dependencias_internas
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `Result`, `ValidationError`, `toAppError`, `AppError` (@shared/kernel/result-and-errors.ts).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:demo:config` (JSON `PublicDemoConfig`, sin caducidad; la escribe el SuperAdmin, la lee el Módulo 07).
 */

import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import { Result, ValidationError, toAppError } from '../../../shared/kernel/result-and-errors';
import type { AppError } from '../../../shared/kernel/result-and-errors';

/** Configuración gobernable de la demostración pública. */
export interface PublicDemoConfig {
  /** Duración máxima de cada demostración, en segundos. */
  readonly maxDurationSeconds: number;
  /** Demostraciones permitidas por IP dentro de la ventana de 24 horas. */
  readonly demosPerIpPerDay: number;
}

/** Defectos equivalentes al antiguo hardcodeo (90 s y 2 demos por IP al día). */
export const DEMO_CONFIG_DEFAULTS: PublicDemoConfig = Object.freeze({ maxDurationSeconds: 90, demosPerIpPerDay: 2 });

/** Clave Redis única (sin caducidad) que guarda la configuración de la demo pública. */
export const PUBLIC_DEMO_CONFIG_KEY = 'oa:demo:config';

/** Rangos duros que la plataforma permite gobernar, más allá del validador Zod de la entrada. */
const MIN_DURATION_SECONDS = 15;
const MAX_DURATION_SECONDS = 600;
const MIN_DEMOS_PER_IP = 1;
const MAX_DEMOS_PER_IP = 1000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Recorta una configuración leída o recibida a los rangos duros de la plataforma. */
function normalizeConfig(raw: Partial<PublicDemoConfig> | null | undefined): PublicDemoConfig {
  return {
    maxDurationSeconds: clamp(raw?.maxDurationSeconds ?? DEMO_CONFIG_DEFAULTS.maxDurationSeconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS),
    demosPerIpPerDay: clamp(raw?.demosPerIpPerDay ?? DEMO_CONFIG_DEFAULTS.demosPerIpPerDay, MIN_DEMOS_PER_IP, MAX_DEMOS_PER_IP),
  };
}

/**
 * Lee la configuración vigente de la demo. Sin Redis, clave ausente o JSON corrupto devuelve los
 * defectos: la demo SIEMPRE debe poder emitirse con valores razonables aunque el plano de gobierno
 * esté caído (fail-soft deliberado, porque no es un control de seguridad sino de producto).
 */
export async function readPublicDemoConfig(redisClient: RedisClusterClient | undefined): Promise<PublicDemoConfig> {
  if (!redisClient) return DEMO_CONFIG_DEFAULTS;
  try {
    const raw = await redisClient.json.getJson<Partial<PublicDemoConfig>>(PUBLIC_DEMO_CONFIG_KEY);
    return normalizeConfig(raw);
  } catch {
    return DEMO_CONFIG_DEFAULTS;
  }
}

/** Dependencias de los casos de uso de configuración de la demo. */
export interface PublicDemoConfigDependencies {
  readonly redisClient?: RedisClusterClient | undefined;
}

/** Caso de uso: el SuperAdmin consulta la configuración actual de la demostración pública. */
export class GetPublicDemoConfigUseCase {
  public constructor(private readonly deps: PublicDemoConfigDependencies) {}

  public async execute(): Promise<Result<PublicDemoConfig, AppError>> {
    try {
      return Result.ok(await readPublicDemoConfig(this.deps.redisClient));
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}

/** Caso de uso: el SuperAdmin fija duración y límite por IP de la demostración pública. */
export class UpdatePublicDemoConfigUseCase {
  public constructor(private readonly deps: PublicDemoConfigDependencies) {}

  public async execute(input: PublicDemoConfig): Promise<Result<PublicDemoConfig, AppError>> {
    try {
      if (!this.deps.redisClient) {
        throw new ValidationError('El plano de gobierno no está disponible (Redis ausente).');
      }
      const next = normalizeConfig(input);
      await this.deps.redisClient.json.setJson(PUBLIC_DEMO_CONFIG_KEY, next, 0);
      return Result.ok(next);
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
