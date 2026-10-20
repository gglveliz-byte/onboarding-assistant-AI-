/**
 * @archivo src/modules/07-public-commercial-and-sandbox/domain/public-commercial.entities.ts
 * @modulo 07-public-commercial-and-sandbox (Endpoints Públicos Comerciales, Demo y Sandbox)
 * @proposito
 *   Define los contratos de datos, entidades inmutables y esquemas Zod rigurosos para
 *   los endpoints públicos consumidos por la Landing Comercial (/) y la Documentación/Sandbox:
 *   matriz de precios Whop, sesiones efímeras de demostración en vivo (con Turnstile y Rate Limit)
 *   y simulación de eventos DOM en el Sandbox.
 *
 * @resumen_contenido
 *   - `publicPricingPlanSchema` y `publicPricingMatrixResponseSchema`: Estructura pública de planes.
 *   - `demoSessionRequestSchema`: Validación del inicio de demo pública (Turnstile y modelo preferido).
 *   - `sandboxSimulateActionSchema`: Validación de acciones simuladas en el Sandbox.
 *   - Entidades de dominio: `PublicPricingPlanEntity`, `PublicPricingMatrixEntity`,
 *     `PublicLiveDemoSessionEntity`, `SandboxSimulationResultEntity`.
 *
 * @dependencias_internas
 *   - Ninguna (Capa de Dominio Hexagonal pura).
 *
 * @dependencias_externas
 *   - `zod` para validación estricta de esquemas.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config` (lectura pública desclasificada).
 *   - Redis: `oa:demo:ip:<sha256(ip)>` (contador atómico de demos).
 */

import { z } from 'zod';

/** Tramos de volumen para descuentos en la matriz pública de precios. */
export const publicVolumeDiscountTierSchema = z.object({
  minMinutes: z.number().int().nonnegative(),
  discountPercentage: z.number().min(0).max(100),
});

export type PublicVolumeDiscountTier = z.infer<typeof publicVolumeDiscountTierSchema>;

/** Plan de precios oficial expuesto a la landing comercial. */
export const publicPricingPlanSchema = z.object({
  planCode: z.string().min(1).max(50),
  displayName: z.string().min(1).max(100),
  monthlyFixedPriceUsd: z.string(),
  /**
   * Importe BRUTO que se cobra efectivamente en el checkout, con la comision de la pasarela ya
   * trasladada al cliente. Se expone porque lo que ve el comprador en la landing debe coincidir con
   * lo que le va a figurar en el recibo: anunciar $5 y cobrar $5.50 es una discrepancia de precio
   * visible, no un detalle redondo. `null` mientras el plan no este aprovisionado en la pasarela.
   */
  whopGrossPriceUsd: z.string().nullable().default(null),
  /** `true` cuando el plan existe de verdad en la pasarela y por tanto puede contratarse. */
  isProvisioned: z.boolean().default(false),
  includedMinutes: z.string(),
  baseOverageRatePerMinuteUsd: z.string(),
  overageAllowed: z.boolean(),
  volumeDiscountEligible: z.boolean(),
  volumeDiscountTiers: z.array(publicVolumeDiscountTierSchema),
  isActive: z.boolean(),
});

export type PublicPricingPlanEntity = z.infer<typeof publicPricingPlanSchema>;

/** Matriz completa de precios consumida por la calculadora de la Landing. */
export const publicPricingMatrixResponseSchema = z.object({
  plans: z.array(publicPricingPlanSchema),
  payAsYouGoRatePerMinuteUsd: z.string(),
  currency: z.literal('USD'),
  synchronizedAtIso: z.string(),
  isDegraded: z.boolean().default(false),
  degradedReason: z.string().nullable().optional(),
});

export type PublicPricingMatrixEntity = z.infer<typeof publicPricingMatrixResponseSchema>;

/** Esquema del payload para solicitar una sesión de demostración pública en vivo. */
export const demoSessionRequestSchema = z.object({
  turnstileToken: z.string().min(1, 'El token de verificación Cloudflare Turnstile es obligatorio'),
  preferredVoiceModel: z.enum(['QWEN', 'GEMINI']).optional().default('GEMINI'),
  preferredVoiceName: z.string().max(24, 'Nombre de voz demasiado largo').optional(),
  userTimezone: z.string().optional(),
});

export type DemoSessionRequestInput = z.infer<typeof demoSessionRequestSchema>;

/** Entidad de sesión de demostración pública emitida. */
export interface PublicLiveDemoSessionEntity {
  readonly sessionId: string;
  readonly ephemeralToken: string;
  readonly handshakeNonce: string; // Compatibilidad de contrato con el SDK (C1-14)
  readonly nonceId: string; // Alias adicional para consistencia de transporte
  readonly websocketUrl: string;
  readonly maxDurationSeconds: number;
  readonly voiceModel: 'QWEN' | 'GEMINI';
  /** Voz real resuelta contra la allowlist del motor y asignada al WebSocket (`&voice=...`). */
  readonly voiceName: string;
  readonly expiresAtIso: string;
}

/** Acciones físicas soportadas por el simulador del Sandbox. */
export const sandboxToolNameSchema = z.enum([
  'click_element',
  'type_text',
  'advance_onboarding_step',
]);

export type SandboxToolName = z.infer<typeof sandboxToolNameSchema>;

/** Esquema para simular una acción de asistente en el Sandbox de Documentación. */
export const sandboxSimulateActionSchema = z.object({
  toolName: sandboxToolNameSchema,
  selectorCascade: z.array(z.string().min(1)).min(1, 'Al menos un selector es requerido'),
  textToType: z.string().optional(),
  bboxNorm: z.tuple([
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
  ]).optional(),
  stepIndex: z.number().int().nonnegative().optional(),
  isElementSensitive: z.boolean().optional().default(false),
});

export type SandboxSimulateActionInput = z.infer<typeof sandboxSimulateActionSchema>;

/** Resultado de una simulación de acción en el Sandbox. */
export interface SandboxSimulationResultEntity {
  readonly success: boolean;
  readonly toolName: SandboxToolName;
  readonly resolvedSelector: string;
  readonly actionSimulated: string;
  readonly blockedBySensitiveField: boolean;
  readonly durationMs: number;
  readonly simulatedResponse: string;
}
