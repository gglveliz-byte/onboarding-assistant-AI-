/**
 * @archivo apps/web/src/lib/api-client/backend-contracts.types.ts
 * @modulo apps/web/src/lib/api-client (contratos tipados de transporte del frontend web)
 * @proposito
 *   Espejo tipado exacto de los DTO publicos del backend sellado (identidad, precios, demo
 *   publica y canal de voz) para que todos los portales del frente web consuman un unico
 *   contrato de transporte y no redefinan interfaces locales incompatibles.
 *
 * @resumen_contenido
 *   - Sobre de error estandar y catalogo de 15 codigos publicos con severidad de auditoria.
 *   - Identidad: usuario, organizacion, rol y respuestas de login/MFA, registro, refresh y logout.
 *   - Matriz publica de precios con tramos por volumen y planes canonicos de respaldo.
 *   - Sesion de demostracion publica, constantes binarias y mensajes del canal de voz en vivo.
 *   - Nombres de los eventos globales que emite el cliente HTTP de la aplicacion.
 *
 * @dependencias_internas
 *   - Ninguna (capa de tipos pura; la consumen `http-client.ts` y los componentes de portales).
 *
 * @dependencias_externas
 *   - Ninguna (solo tipos y constantes de TypeScript; sin codigo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (contratos de transporte: no acceden a datos de forma directa).
 */

// --- 1. Sobre de error del backend (espejo de `HttpErrorResult` de http-server.types.ts) ---
/** Codigos publicos de error que el backend entrega en `error.code` (catalogo del kernel). */
export type BackendErrorCode =
  | 'UNAUTHORIZED' | 'TOKEN_VERSION_REVOKED' | 'FORBIDDEN' | 'VALIDATION_FAILED'
  | 'NOT_FOUND' | 'CONFLICT' | 'TENANT_SUSPENDED' | 'LEGAL_CONSENT_OUTDATED'
  | 'DPA_NOT_SIGNED' | 'ORIGIN_NOT_ALLOWED' | 'SSRF_BLOCKED_IP' | 'INSUFFICIENT_FUNDS'
  | 'RATE_LIMIT_EXCEEDED' | 'PROVIDER_UNAVAILABLE' | 'INTERNAL_ERROR'
  // Emitido por la guardia de sesión (`session-auth.middleware.ts`) cuando al token le faltan
  // los scopes que exige la ruta.
  | 'INSUFFICIENT_PERMISSIONS';

/** Severidad de auditoria que el backend asocia a cada error en su bitacora inmutable. */
export type AuditSeverity = 'INFO' | 'WARN' | 'CRITICAL_SECURITY';

/** Envoltorio estandar del cuerpo JSON de toda respuesta de error del backend. */
export interface BackendErrorEnvelope {
  readonly error: {
    readonly code: BackendErrorCode;
    readonly message: string;
    readonly httpStatus: number;
    readonly wsCloseCode: number;
    readonly auditSeverity: AuditSeverity;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

// --- 2. Identidad (proyecciones publicas exactas de identity-public-projections.ts) ---
/** Proyeccion publica de un usuario: sin hashes, tokens ni datos internos de seguridad. */
export interface PublicUserDto {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly emailVerified: boolean;
  readonly mfaTotpEnabled: boolean;
  readonly mfaWebauthnEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}
/** Proyeccion publica de la organizacion activa del usuario autenticado. */
export interface PublicOrganizationDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}
/** Rol del usuario dentro de la plataforma; gobierna permisos y visibilidad de los portales. */
export type PlatformRole = 'SUPERADMIN' | 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';
/** Respuesta exitosa de inicio de sesion cuando no se exige segundo factor. */
export interface AuthLoginSuccessDto {
  readonly accessToken: string;
  readonly user: PublicUserDto;
  readonly organization: PublicOrganizationDto;
  readonly role: PlatformRole;
}
/** Respuesta intermedia de inicio de sesion cuando la cuenta exige segundo factor. */
export interface AuthMfaRequiredDto {
  readonly status: 'MFA_REQUIRED';
  readonly userId: string;
  readonly mfaChallengeToken: string;
  readonly availableFactors: readonly ('TOTP' | 'WEBAUTHN')[];
}
/** Union discriminada del inicio de sesion: exito directo o desafio de segundo factor. */
export type AuthLoginResponseDto = AuthLoginSuccessDto | AuthMfaRequiredDto;
/** Respuesta exitosa del registro de cuenta con su organizacion inicial. */
export interface AuthRegisterSuccessDto {
  readonly user: PublicUserDto;
  readonly organization: PublicOrganizationDto;
  readonly accessToken: string;
  readonly emailVerificationRequired: boolean;
}
/** Respuesta exitosa del refresco de sesion: renueva el token y rehidrata el contexto. */
export interface AuthRefreshSuccessDto {
  readonly accessToken: string;
  readonly user: PublicUserDto;
  readonly organization: PublicOrganizationDto | null;
}
/** Respuesta exitosa del cierre de sesion: confirma la revocacion del refresh vigente. */
export interface AuthLogoutSuccessDto {
  readonly revoked: boolean;
}

// --- 3. Matriz publica de precios (Modulo 07: public-demo-and-pricing.use-case.ts) ---
/** Tramo de descuento por volumen aplicable sobre el excedente de minutos del plan. */
export interface PublicVolumeDiscountTierDto {
  readonly minMinutes: number;
  readonly discountPercentage: number;
}
/** Plan de precios publico tal como lo expone la matriz oficial de la plataforma. */
export interface PublicPricingPlanDto {
  readonly planCode: string;
  readonly displayName: string;
  readonly monthlyFixedPriceUsd: string;
  /**
   * Importe BRUTO que cobra el checkout, con la comision de la pasarela trasladada al cliente.
   * Es la cifra que va a figurar en el recibo: anunciar solo `monthlyFixedPriceUsd` (el neto que
   * liquida en la empresa) mostraria un precio inferior al que el comprador paga realmente.
   */
  readonly whopGrossPriceUsd: string | null;
  /** `false` mientras el plan no exista en la pasarela: no debe ofrecerse como contratable. */
  readonly isProvisioned: boolean;
  readonly includedMinutes: string;
  readonly baseOverageRatePerMinuteUsd: string;
  readonly overageAllowed: boolean;
  readonly volumeDiscountEligible: boolean;
  readonly volumeDiscountTiers: readonly PublicVolumeDiscountTierDto[];
  readonly isActive: boolean;
}
/** Matriz completa de precios consumida por la calculadora comercial de la landing. */
export interface PublicPricingMatrixDto {
  readonly plans: readonly PublicPricingPlanDto[];
  readonly payAsYouGoRatePerMinuteUsd: string;
  readonly currency: 'USD';
  readonly synchronizedAtIso: string;
  readonly isDegraded: boolean;
  readonly degradedReason?: string | null;
}

/**
 * Planes canonicos de respaldo: espejo del fallback resiliente del backend para renderizar la
 * calculadora aunque la matriz oficial no este disponible (la respuesta llega marcada degradada).
 */
export const CANONICAL_PUBLIC_PLANS_FALLBACK: readonly PublicPricingPlanDto[] = [
  {
    planCode: 'PAYG',
    displayName: 'Pago por Uso (PAYG)',
    monthlyFixedPriceUsd: '0.00',
    includedMinutes: '0',
    baseOverageRatePerMinuteUsd: '0.20',
    overageAllowed: true,
    volumeDiscountEligible: false,
    volumeDiscountTiers: [],
    // Respaldo sin pasarela detras: sin bruto que anunciar y sin plan contratable.
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
    // Respaldo sin pasarela detras: sin bruto que anunciar y sin plan contratable.
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
    // Respaldo sin pasarela detras: sin bruto que anunciar y sin plan contratable.
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
    // Respaldo sin pasarela detras: sin bruto que anunciar y sin plan contratable.
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
    // Respaldo sin pasarela detras: sin bruto que anunciar y sin plan contratable.
    whopGrossPriceUsd: null,
    isProvisioned: false,
    isActive: true,
  },
];

/** Tarifa publica de respaldo del modo de pago por uso, en dolares por minuto. */
export const PAYG_RATE_PER_MINUTE_USD_FALLBACK = '0.20';

// --- 4. Sesion de demo publica (Modulo 07: POST /api/v1/public/demo-session) ---
/** Motor de voz en vivo ofrecible en la demostracion publica (perfil de voz en la interfaz). */
export type VoiceModelId = 'QWEN' | 'GEMINI';
/** Descripcion de una voz real disponible para un motor dado (nombre del proveedor + etiqueta). */
export interface DemoVoiceOption {
  readonly voiceName: string;
  readonly label: string;
}
/**
 * Catalogo de voces REALES por motor que la demo publica puede usar. El `voiceName` se envia tal
 * cual al proveedor segun el protocolo que efectivamente usamos:
 *   - GEMINI → Gemini **Live API** (`prebuiltVoiceConfig.voiceName`, 30 voces nominales multilingues).
 *   - QWEN   → Qwen **Omni-Realtime** (`session.update.voice`, voz nominal multilingue; defecto Sonrisa).
 * NO son IDs de Cloud Text-to-Speech (`es-XX-Polyglot-N`) ni de Qwen-TTS (`qwen-voice-*`): esos
 * productos tienen otra API y serian rechazados por los endpoints Live/Omni-Realtime que usamos.
 */
export const DEMO_VOICE_CATALOG: Readonly<Record<VoiceModelId, readonly DemoVoiceOption[]>> = {
  QWEN: [
    { voiceName: 'Sonrisa', label: 'Sonrisa · latina' },
    { voiceName: 'Tina', label: 'Tina · clara y asistencial' },
    { voiceName: 'Serena', label: 'Serena · suave' },
    { voiceName: 'Cici', label: 'Cici · dulce' },
    { voiceName: 'Maia', label: 'Maia · inteligente y cálida' },
    { voiceName: 'Ryan', label: 'Ryan · enérgico' },
    { voiceName: 'Evan', label: 'Evan · juvenil' },
    { voiceName: 'Jennifer', label: 'Jennifer · cinematográfica' },
    { voiceName: 'Bodega', label: 'Bodega · español cálido' },
    { voiceName: 'Andre', label: 'Andre · estable' },
  ],
  GEMINI: [
    { voiceName: 'Kore', label: 'Kore · firme' },
    { voiceName: 'Aoede', label: 'Aoede · fresca' },
    { voiceName: 'Leda', label: 'Leda · juvenil' },
    { voiceName: 'Despina', label: 'Despina · sedosa' },
    { voiceName: 'Sulafat', label: 'Sulafat · cálida' },
    { voiceName: 'Callirrhoe', label: 'Callirrhoe · relajada' },
    { voiceName: 'Zephyr', label: 'Zephyr · brillante' },
    { voiceName: 'Puck', label: 'Puck · animado' },
    { voiceName: 'Charon', label: 'Charon · informativo' },
    { voiceName: 'Orus', label: 'Orus · firme' },
    { voiceName: 'Algieba', label: 'Algieba · suave' },
  ],
};
/** Cuerpo de la solicitud de demostracion publica: verificacion anti-bot y preferencias. */
export interface PublicDemoSessionRequestDto {
  readonly turnstileToken: string;
  readonly preferredVoiceModel?: VoiceModelId;
  /** Voz real solicitada para el motor elegido; el backend la valida contra su allowlist. */
  readonly preferredVoiceName?: string;
  readonly userTimezone?: string;
}
/** Sesion efimera de demostracion emitida por el backend para el visitante anonimo. */
export interface PublicDemoSessionDto {
  readonly sessionId: string;
  readonly ephemeralToken: string;
  readonly handshakeNonce: string;
  readonly nonceId: string;
  readonly websocketUrl: string;
  readonly maxDurationSeconds: number;
  readonly voiceModel: VoiceModelId;
  /** Voz real efectiva que el backend resolvió y asignó a la sesión. */
  readonly voiceName: string;
  readonly expiresAtIso: string;
}

// --- 5. Protocolo binario del canal de voz (espejo de voice-frame.protocol.ts) ---
/** Tipo de trama: fragmento de audio del visitante hacia el motor de voz. */
export const FRAME_TYPE_AUDIO_UPLINK = 0x01;
/** Tipo de trama: mensaje de control JSON en cualquiera de las dos direcciones. */
export const FRAME_TYPE_CONTROL_JSON = 0x02;
/** Frecuencia de muestreo del audio de voz en vivo (16 kHz mono). */
export const AUDIO_SAMPLE_RATE_HZ = 16000;
/** Cantidad de muestras por fragmento canonico de 20 milisegundos. */
export const AUDIO_FRAME_SAMPLE_COUNT = 320;
/** Tamano total en bytes de una trama de audio uplink, incluido su byte de tipo. */
export const AUDIO_UPLINK_FRAME_BYTES = 1 + AUDIO_FRAME_SAMPLE_COUNT * 2;
/** Duracion maxima de la demostracion publica, en segundos. */
export const DEMO_SESSION_DURATION_SECONDS = 90;

/** Codigos de cierre del canal de voz alineados con la politica publica de la plataforma. */
export const VOICE_CLOSE_CODES = {
  UNAUTHORIZED: 4001,
  PAYMENT_REQUIRED: 4002,
  TENANT_SUSPENDED: 4003,
  RATE_LIMITED: 4007,
  PROVIDER_UNAVAILABLE: 4008,
} as const;

/** Maximo de demostraciones publicas que una misma direccion puede iniciar por dia. */
export const MAX_DEMOS_PER_IP_PER_DAY = 2;

/** Herramientas fisicas que el asistente puede ejecutar sobre la interfaz guiada. */
export type VoiceToolName = 'click_element' | 'type_text' | 'advance_onboarding_step';
/** Orden de ejecucion fisica despachada por el motor de voz hacia el cliente. */
export interface ToolExecuteMessageDto {
  readonly type: 'tool.execute';
  readonly providerToolCallId: string;
  readonly toolName: VoiceToolName;
  readonly targetElementKey: string;
  readonly primarySelector: string;
  readonly selectorCascade: readonly string[];
  readonly textPayload: string | null;
  readonly requiresUserConfirmation: boolean;
  readonly riskLevel: string;
}
/** Aviso de que la sesion quedo lista, con contexto de ruta cuando esta disponible. */
export interface SessionReadyMessageDto {
  readonly type: 'session.ready';
  readonly routePath?: string;
  readonly contextUnavailable?: string;
  readonly warning?: string;
}
/** Estado de elocucion del asistente, con transcripcion incremental opcional. */
export interface AssistantSpeakingMessageDto {
  readonly type: 'assistant.speaking';
  readonly transcript?: string;
  readonly isFinal?: boolean;
  readonly started?: boolean;
}
/** Aviso de cierre de sesion con el motivo publico traducido para el visitante. */
export interface SessionClosingMessageDto {
  readonly type: 'session.closing';
  readonly closeCode: number;
  readonly publicMessage: string;
  readonly status?: string;
}
/** Acuse de una orden fisica ejecutada, con el identificador original de la llamada. */
export interface ToolExecutionAckMessageDto {
  readonly type: 'tool.execution.ack';
  readonly providerToolCallId: string;
  readonly succeeded: boolean;
  readonly detail: string | null;
}
/** Trama que informa la interrupcion inmediata del audio del asistente (barge-in). */
export interface BargeInFrameDto {
  readonly type: 'voice.barge_in';
  readonly timestamp: number;
}
/** Trama que informa un cambio de ruta detectado en la aplicacion anfitriona. */
export interface RouteChangedFrameDto {
  readonly type: 'route.changed';
  readonly routePath: string;
  readonly timestamp: number;
}

/** Union de todos los mensajes de control JSON que viajan por el canal de voz. */
export type VoiceControlMessageDto =
  | ToolExecuteMessageDto
  | SessionReadyMessageDto
  | AssistantSpeakingMessageDto
  | SessionClosingMessageDto
  | ToolExecutionAckMessageDto;

// --- 6. Nombres de eventos publicos del cliente HTTP (los emite http-client.ts) ---
/** Nombres canonicos de los eventos globales que el cliente HTTP despacha en la ventana. */
export const HTTP_CLIENT_EVENT_NAMES = {
  LEGAL_CONSENT_OUTDATED: 'oa:http:legal-consent-outdated',
  SESSION_EXPIRED: 'oa:http:session-expired',
  TENANT_SUSPENDED: 'oa:http:tenant-suspended',
  RATE_LIMITED: 'oa:http:rate-limited',
  INSUFFICIENT_FUNDS: 'oa:http:insufficient-funds',
} as const;

/** Union de literales validos de los nombres de evento del cliente HTTP. */
export type HttpClientEventName = (typeof HTTP_CLIENT_EVENT_NAMES)[keyof typeof HTTP_CLIENT_EVENT_NAMES];
