/**
 * @archivo src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case.ts
 * @modulo 07-public-commercial-and-sandbox (Endpoints Públicos Comerciales, Demo y Sandbox)
 * @proposito
 *   Orquesta las operaciones públicas consumidas por la Landing Comercial y la Documentación:
 *   1. `GetPublicPricingMatrixUseCase`: Consulta y expone la matriz oficial de planes Whop.
 *   2. `CreatePublicLiveDemoSessionUseCase`: Valida Cloudflare Turnstile, aplica Rate Limit por IP
 *      en Redis con el límite gobernable por el SuperAdmin (defecto 2 demos/día y 90 s) y emite token
 *      efímero de sesión de voz con la voz real elegida (`&voice=` en la URL del WebSocket).
 *   3. `ValidateSandboxActionUseCase`: Valida y simula acciones físicas en el Sandbox de Docs.
 *
 * @resumen_contenido
 *   - `GetPublicPricingMatrixUseCase`: Matriz pública de planes Whop y tramos de volumen.
 *   - `CreatePublicLiveDemoSessionUseCase`: Demostración interactiva pública con control Anti-Bot.
 *   - `ValidateSandboxActionUseCase`: Simulador de órdenes DOM para desarrolladores.
 *
 * @dependencias_internas
 *   - `RlsDatabasePool` (@shared/infrastructure/database/rls-pool.ts).
 *   - `RedisClusterClient` (@shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `CryptoUtils` (@shared/kernel/crypto.util.ts).
 *   - `Result`, `RateLimitExceededError`, `ValidationError`, `toAppError`, `AppError` (@shared/kernel/result-and-errors.ts).
 *   - Entidades del Módulo 07 (@modules/07-public-commercial-and-sandbox/domain/public-commercial.entities.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`.
 *   - Redis: `oa:demo:ip:<sha256(ip)>` (contador 24h), `oa:demo:session:<sessionId>`.
 */

import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../../shared/infrastructure/redis/redis-cluster.client';
import { CryptoUtils } from '../../../shared/kernel/crypto.util';
import {
  Result,
  RateLimitExceededError,
  ProviderUnavailableError,
  ValidationError,
  toAppError,
  AppError,
} from '../../../shared/kernel/result-and-errors';
import type {
  PublicPricingPlanEntity,
  PublicPricingMatrixEntity,
  DemoSessionRequestInput,
  PublicLiveDemoSessionEntity,
  SandboxSimulateActionInput,
  SandboxSimulationResultEntity,
  PublicVolumeDiscountTier,
} from '../domain/public-commercial.entities';
import { readPublicDemoConfig } from '../../06-superadmin-governance/application/public-demo-config.use-case';

/** Planes canónicos oficiales Whop utilizados como base y respaldo. */
const CANONICAL_PUBLIC_PLANS: readonly PublicPricingPlanEntity[] = [
  {
    planCode: 'PAYG',
    displayName: 'Pago por Uso (PAYG)',
    monthlyFixedPriceUsd: '0.00',
    includedMinutes: '0',
    baseOverageRatePerMinuteUsd: '0.20',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    // Respaldo sin pasarela detras: no hay bruto que anunciar ni plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
  {
    planCode: 'PLAN_5',
    displayName: 'Starter ($5 USD)',
    monthlyFixedPriceUsd: '5.00',
    includedMinutes: '30',
    baseOverageRatePerMinuteUsd: '0.18',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    // Respaldo sin pasarela detras: no hay bruto que anunciar ni plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
  {
    planCode: 'PLAN_10',
    displayName: 'Growth ($10 USD)',
    monthlyFixedPriceUsd: '10.00',
    includedMinutes: '70',
    baseOverageRatePerMinuteUsd: '0.16',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    // Respaldo sin pasarela detras: no hay bruto que anunciar ni plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
  {
    planCode: 'PLAN_30',
    displayName: 'Pro ($30 USD)',
    monthlyFixedPriceUsd: '30.00',
    includedMinutes: '250',
    baseOverageRatePerMinuteUsd: '0.14',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    // Respaldo sin pasarela detras: no hay bruto que anunciar ni plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
  {
    planCode: 'PLAN_50',
    displayName: 'Enterprise Scale ($50 USD)',
    monthlyFixedPriceUsd: '50.00',
    includedMinutes: '500',
    baseOverageRatePerMinuteUsd: '0.12',
    overageAllowed: true,
    volumeDiscountEligible: true,
    volumeDiscountTiers: [
      { minMinutes: 1000, discountPercentage: 10 },
      { minMinutes: 5000, discountPercentage: 20 },
      { minMinutes: 25000, discountPercentage: 35 },
      { minMinutes: 50000, discountPercentage: 50 },
    ],
    // Respaldo sin pasarela detras: no hay bruto que anunciar ni plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
];

/** Dependencias para la consulta pública de precios. */
export interface PublicPricingDependencies {
  readonly rlsPool: RlsDatabasePool;
}

interface RawDbTierShape {
  readonly minMinutes?: unknown;
  readonly discountPercentage?: unknown;
  readonly min_overage_minutes?: unknown;
  readonly discount_pct?: unknown;
}

/** Normaliza los tramos de descuento por volumen leídos desde PostgreSQL (soportando tanto snake_case como camelCase). */
function normalizeVolumeDiscountTiers(rawTiers: unknown): PublicVolumeDiscountTier[] {
  if (!Array.isArray(rawTiers)) {
    return [];
  }
  return rawTiers.map((raw): PublicVolumeDiscountTier => {
    const rawObj = (typeof raw === 'object' && raw !== null ? raw : {}) as RawDbTierShape;
    const rawMin = rawObj.minMinutes ?? rawObj.min_overage_minutes ?? 0;
    const rawPct = rawObj.discountPercentage ?? rawObj.discount_pct ?? 0;
    const minMinutes = Math.round(typeof rawMin === 'number' ? rawMin : Number(rawMin));
    const discountPercentage = Math.round(typeof rawPct === 'number' ? rawPct : Number(rawPct));
    return {
      minMinutes: Number.isFinite(minMinutes) ? Math.max(0, minMinutes) : 0,
      discountPercentage: Number.isFinite(discountPercentage) ? Math.min(100, Math.max(0, discountPercentage)) : 0,
    };
  });
}

/** Caso de uso: Obtener la matriz pública de precios para la Landing Comercial. */
export class GetPublicPricingMatrixUseCase {
  public constructor(private readonly deps: PublicPricingDependencies) {}

  public async execute(): Promise<Result<PublicPricingMatrixEntity, AppError>> {
    try {
      const plans = await this.deps.rlsPool.withClient(async (client) => {
        const queryRes = await client.query<{
          plan_code: string;
          display_name: string;
          monthly_fixed_price_usd: string;
          included_minutes: string;
          base_overage_rate_per_minute_usd: string;
          overage_allowed: boolean;
          volume_discount_eligible: boolean;
          volume_discount_tiers_json: unknown;
          is_active: boolean;
          whop_gross_price_usd: string | null;
          whop_plan_is_live: boolean;
        }>(
          `SELECT plan_code, display_name, monthly_fixed_price_usd, included_minutes,
                  base_overage_rate_per_minute_usd, overage_allowed, volume_discount_eligible,
                  volume_discount_tiers_json, is_active, whop_gross_price_usd, whop_plan_is_live
           FROM pricing_plans_config
           WHERE is_active = true
           ORDER BY monthly_fixed_price_usd::numeric ASC`
        );

        if (queryRes.rows.length === 0) {
          return CANONICAL_PUBLIC_PLANS;
        }

        return queryRes.rows.map((row): PublicPricingPlanEntity => ({
          planCode: row.plan_code,
          displayName: row.display_name,
          monthlyFixedPriceUsd: row.monthly_fixed_price_usd,
          // El bruto es lo que cobra el checkout. Si el plan todavia no esta aprovisionado en la
          // pasarela no hay bruto que anunciar: se deja null y la interfaz lo dice en vez de
          // inventar una cifra o ofrecer un plan que no se puede contratar.
          whopGrossPriceUsd: row.whop_gross_price_usd,
          isProvisioned: row.whop_plan_is_live === true,
          includedMinutes: row.included_minutes,
          baseOverageRatePerMinuteUsd: row.base_overage_rate_per_minute_usd,
          overageAllowed: row.overage_allowed,
          volumeDiscountEligible: row.volume_discount_eligible,
          volumeDiscountTiers: normalizeVolumeDiscountTiers(row.volume_discount_tiers_json),
          isActive: row.is_active,
        }));
      });

      return Result.ok({
        plans: [...plans],
        payAsYouGoRatePerMinuteUsd: '0.20',
        currency: 'USD' as const,
        synchronizedAtIso: new Date().toISOString(),
        isDegraded: false,
        degradedReason: null,
      });
    } catch (error) {
      // Fallback resiliente a planes canónicos Whop si la base de datos no está disponible, marcando como degradada (C1-15)
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Result.ok({
        plans: [...CANONICAL_PUBLIC_PLANS],
        payAsYouGoRatePerMinuteUsd: '0.20',
        currency: 'USD' as const,
        synchronizedAtIso: new Date().toISOString(),
        isDegraded: true,
        degradedReason: `DATABASE_UNAVAILABLE: ${errorMsg}`,
      });
    }
  }
}

/** Script Lua para incremento atómico de rate limit con expiración en primera visita (C1-13). */
const LUA_ATOMIC_DEMO_RATE_LIMIT = `
local current = redis.call('GET', KEYS[1])
local n = current and tonumber(current) or 0
local max = tonumber(ARGV[2]) or 2
if n >= max then
  return n + 1
end
local nextVal = redis.call('INCR', KEYS[1])
if nextVal == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return nextVal
`;

/**
 * Allowlist de voces REALES por motor. Los nombres coinciden EXACTAMENTE con `DEMO_VOICE_CATALOG`
 * del frontend: GEMINI usa las nominales de la **Live API**; QWEN, las de **Omni-Realtime** (default
 * Tina). El defecto QWEN lo decide el producto: «Sonrisa», la persona latina del catalogo oficial. No se aceptan IDs de Cloud TTS (`es-XX-Polyglot-N`) ni de Qwen-TTS (`qwen-voice-*`): no
 * existen en los protocolos Live/Omni-Realtime que usamos y el proveedor los rechazaria.
 */
const DEMO_VOICE_ALLOWLIST: Readonly<Record<'QWEN' | 'GEMINI', readonly string[]>> = {
  QWEN: ['Tina', 'Serena', 'Cici', 'Maia', 'Ryan', 'Evan', 'Jennifer', 'Sonrisa', 'Bodega', 'Andre'],
  GEMINI: ['Kore', 'Aoede', 'Leda', 'Despina', 'Sulafat', 'Callirrhoe', 'Zephyr', 'Puck', 'Charon', 'Orus', 'Algieba'],
};

/** Voz por defecto de cada motor cuando el visitante no elige una valida (QWEN: decision de producto; GEMINI: defecto del proveedor). */
const DEMO_VOICE_DEFAULTS: Readonly<Record<'QWEN' | 'GEMINI', string>> = { QWEN: 'Sonrisa', GEMINI: 'Kore' };

/**
 * Resuelve la voz real de la demostración: acepta únicamente nombres de la allowlist del motor
 * elegido; cualquier otro valor (o ausencia) cae al defecto del proveedor. Evita filtrar cadenas
 * arbitrarias a la API del motor y garantiza que la voz exista realmente en ese proveedor.
 */
function resolveDemoVoiceName(voiceModel: 'QWEN' | 'GEMINI', preferred: string | undefined): string {
  const trimmed = (preferred ?? '').trim();
  return DEMO_VOICE_ALLOWLIST[voiceModel].includes(trimmed) ? trimmed : DEMO_VOICE_DEFAULTS[voiceModel];
}

/** Dependencias para la emisión de sesiones de demo en vivo. */
export interface PublicLiveDemoDependencies {  readonly redisClient?: RedisClusterClient | undefined;
  readonly turnstileSecretKey?: string | undefined;
  readonly isProduction?: boolean | undefined;
  readonly websocketBaseUrl?: string | undefined;
}

/** Caso de uso: Crear una sesión de demostración pública en vivo con Turnstile y Rate Limit. */
export class CreatePublicLiveDemoSessionUseCase {
  public constructor(private readonly deps: PublicLiveDemoDependencies) {}

  public async execute(
    clientIp: string,
    input: DemoSessionRequestInput
  ): Promise<Result<PublicLiveDemoSessionEntity, AppError>> {
    try {
      // 1. Verificación Cloudflare Turnstile Anti-Bot
      await this.verifyTurnstile(input.turnstileToken, clientIp);

      // 2. Control de Frecuencia por IP en Redis (límite gobernable por el SuperAdmin, por defecto 2/24h)
      // C1-13: Fallar cerrado si el limitador de Redis no está disponible
      if (!this.deps.redisClient) {
        throw new ProviderUnavailableError(
          'PRIMARY',
          'El servicio de demostración pública no está disponible en este momento debido a indisponibilidad del limitador de frecuencia.'
        );
      }

      // Configuración gobernable: duración máxima y demos por IP/día (defectos 150 s y 2 si no hay config).
      const config = await readPublicDemoConfig(this.deps.redisClient);
      const ipHash = CryptoUtils.sha256Hex(clientIp);
      const rateLimitKey = `oa:demo:ip:${ipHash}`;

      // Incremento atómico en Redis vía script Lua para evitar carreras (C1-13). ARGV[2] = tope por IP.
      const currentCount = await this.deps.redisClient.runScript(
        LUA_ATOMIC_DEMO_RATE_LIMIT,
        [rateLimitKey],
        [86400, String(config.demosPerIpPerDay)]
      );

      if (Number(currentCount) > config.demosPerIpPerDay) {
        throw new RateLimitExceededError(
          86400,
          `demo:ip:${ipHash}`,
          { details: { message: `Has alcanzado el límite diario de ${config.demosPerIpPerDay} demostraciones interactivas por IP. Regístrate para acceso ilimitado.` } }
        );
      }

      // 3. Generar identificador de sesión efímera y token temporal (duración gobernable, def. 150 s)
      const sessionId = `demo_${CryptoUtils.generateCsprngToken(16)}`;
      const ephemeralToken = `demo_tok_${CryptoUtils.generateCsprngToken(32)}`;
      const voiceModel = input.preferredVoiceModel ?? 'GEMINI';
      const voiceName = resolveDemoVoiceName(voiceModel, input.preferredVoiceName);
      const durationSeconds = config.maxDurationSeconds;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
      // TTL del descriptor con margen sobre la duración gobernable (escala si el SuperAdmin sube los segundos).
      const descriptorTtlSeconds = durationSeconds + 30;

      // 4. Guardar descriptor de sesión en Redis con hash de IP y descriptor de token para WebSocket
      const sessionPayload = {
        sessionId,
        clientIp,
        clientIpHash: ipHash,
        voiceModel,
        voiceName,
        ephemeralToken,
        maxDurationSeconds: durationSeconds,
        expiresAtIso: expiresAt.toISOString(),
        isDemo: true,
      };

      await this.deps.redisClient.json.setJson(
        `oa:demo:session:${sessionId}`,
        sessionPayload,
        descriptorTtlSeconds
      );
      await this.deps.redisClient.json.setJson(
        `oa:demo:token:${ephemeralToken}`,
        sessionPayload,
        descriptorTtlSeconds
      );

      const wsBase = this.deps.websocketBaseUrl ?? 'wss://voice.plataforma.com/ws/v1/realtime';
      // C1-14: Alinear nombres de contrato tanto para SDK (?sessionId=...&nonce=...&handshakeNonce=...) como Gateway.
      // `voice` viaja la voz real elegida; el borde del socket la lee como `voicePersonaCode` y la entrega al motor.
      const websocketUrl = `${wsBase}?token=${ephemeralToken}&sessionId=${sessionId}&nonce=${ephemeralToken}&handshakeNonce=${ephemeralToken}&demo=true&voice=${encodeURIComponent(voiceName)}`;

      return Result.ok({
        sessionId,
        ephemeralToken,
        handshakeNonce: ephemeralToken,
        nonceId: ephemeralToken,
        websocketUrl,
        maxDurationSeconds: durationSeconds,
        voiceModel,
        voiceName,
        expiresAtIso: expiresAt.toISOString(),
      });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }

  /**
   * Valida el token Cloudflare Turnstile contra el endpoint de verificación oficial.
   */
  private async verifyTurnstile(token: string, clientIp: string): Promise<void> {
    // En entorno de pruebas o desarrollo se permite token de prueba sin llamada externa
    if (!this.deps.isProduction && (token === 'turnstile-test-passed' || !this.deps.turnstileSecretKey)) {
      return;
    }

    if (!token) {
      throw new ValidationError('El token de Cloudflare Turnstile es requerido');
    }

    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: this.deps.turnstileSecretKey ?? '',
          response: token,
          remoteip: clientIp,
        }),
      });

      const outcome = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
      if (!outcome.success) {
        throw new ValidationError('Verificación Turnstile rechazada por detección de tráfico automatizado');
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // Si la llamada externa falla por red en dev/staging se tolera con aviso
      if (!this.deps.isProduction) return;
      throw new ValidationError('Fallo de conectividad con el servicio de verificación Turnstile');
    }
  }
}

/** Caso de uso: Validar y simular acciones DOM en el Sandbox de Documentación. */
export class ValidateSandboxActionUseCase {
  public execute(input: SandboxSimulateActionInput): Result<SandboxSimulationResultEntity, AppError> {
    try {
      const startTime = Date.now();
      const primarySelector = input.selectorCascade[0] ?? '#unknown';

      // 1. Detección preventiva de campos sensibles
      const isSensitive =
        input.isElementSensitive ||
        primarySelector.toLowerCase().includes('password') ||
        primarySelector.toLowerCase().includes('credit') ||
        primarySelector.toLowerCase().includes('cvv');

      if (isSensitive) {
        return Result.ok({
          success: false,
          toolName: input.toolName,
          resolvedSelector: primarySelector,
          actionSimulated: input.toolName,
          blockedBySensitiveField: true,
          durationMs: Date.now() - startTime,
          simulatedResponse: 'Acción bloqueada: El campo objetivo está catalogado como sensible por el scrubber de privacidad.',
        });
      }

      // 2. Simulación de ejecución según herramienta
      let responseMsg = '';
      if (input.toolName === 'click_element') {
        responseMsg = `Elemento '${primarySelector}' clickeado exitosamente tras disparar secuencia pointerover -> pointerdown -> click.`;
      } else if (input.toolName === 'type_text') {
        responseMsg = `Texto '${input.textToType ?? ''}' escrito exitosamente en '${primarySelector}' emulando eventos React input/change.`;
      } else {
        responseMsg = `Paso de onboarding avanzado al paso ${input.stepIndex ?? 1}.`;
      }

      return Result.ok({
        success: true,
        toolName: input.toolName,
        resolvedSelector: primarySelector,
        actionSimulated: input.toolName,
        blockedBySensitiveField: false,
        durationMs: Math.max(12, Date.now() - startTime),
        simulatedResponse: responseMsg,
      });
    } catch (error) {
      return Result.fail(toAppError(error));
    }
  }
}
