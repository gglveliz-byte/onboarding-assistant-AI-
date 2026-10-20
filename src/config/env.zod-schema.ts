/**
 * @archivo src/config/env.zod-schema.ts
 * @modulo 00-foundations (Esquema Zod Estricto del Contrato de Entorno y Validaciones Cruzadas)
 * @proposito
 *   Declara la forma exacta de TODAS las variables de entorno del backend y las reglas
 *   cruzadas que deben cumplirse entre ellas (par de llaves EdDSA, origenes CORS en
 *   produccion y prohibicion absoluta de relajar el escudo Anti-SSRF en produccion).
 *   Este archivo es la unica autoridad de validacion: ningun modulo puede re-validar
 *   ni interpretar variables de entorno por su cuenta.
 *
 * @resumen_contenido
 *   - Esquemas primitivos: `networkPortSchema`, `absoluteUrlSchema`, `webSocketUrlSchema`,
 *     `redisNodeUrlSchema`, `dnsResolverAddressSchema` y `strongSecretSchema()`.
 *   - Helpers de llaves criptograficas: `decodePemKey()`, `isValidPemKey()`.
 *   - Esquema `rawEnvironmentSchema`: 60 variables con tipos, limites y valores por omision.
 *   - Esquema `refinedEnvironmentSchema`: Reglas cruzadas y endurecimiento en produccion.
 *
 * @dependencias_internas
 *   - Constantes de catalogo (`./env.contract.ts`): roles de Node Pool, entornos y niveles de log.
 *   - `buildConnectionIdentityFindings()` (`./env.connection-identity.ts`): auditoria de la identidad
 *     de conexion, que en produccion rechaza un rol de aplicacion igual al del propietario.
 *
 * @dependencias_externas
 *   - `zod` (Validacion estricta con mensajes de error en espanol).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: valida `DATABASE_URL`, `DATABASE_POOL_MAX` y tiempos de sentencia.
 *   - Redis: valida `REDIS_CLUSTER_URLS` (uno o varios nodos), prefijo y timeout de conexion.
 */

import { z } from 'zod';
import { buildConnectionIdentityFindings } from './env.connection-identity';
import { LOG_LEVELS, NODE_ENVIRONMENTS, NODE_POOL_ROLES } from './env.contract';

/** Puerto de red valido (1 a 65535). */
export const networkPortSchema = z.coerce
  .number()
  .int()
  .min(1, 'debe estar entre 1 y 65535')
  .max(65535, 'debe estar entre 1 y 65535');

/** URL absoluta con esquema y host obligatorios. */
export const absoluteUrlSchema = z
  .string()
  .trim()
  .min(1, 'no puede estar vacia')
  .refine((candidate) => {
    try {
      const parsed = new URL(candidate);
      return parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }, 'debe ser una URL absoluta valida con esquema y host (ejemplo: https://host:443/ruta)');

/** URL de socket usada por los adaptadores de voz en tiempo real. */
export const webSocketUrlSchema = absoluteUrlSchema.refine(
  (candidate) => candidate.startsWith('ws://') || candidate.startsWith('wss://'),
  'debe usar el esquema ws:// o wss://'
);

/** Nodo individual de Redis, ya sea instancia unica o miembro del cluster. */
export const redisNodeUrlSchema = z
  .string()
  .trim()
  .refine(
    (candidate) => candidate.startsWith('redis://') || candidate.startsWith('rediss://'),
    'cada nodo debe usar el esquema redis:// o rediss://'
  );

/** Direccion IPv4 o IPv6 valida para los resolutores DNS del escudo Anti-SSRF. */
export const dnsResolverAddressSchema = z
  .string()
  .trim()
  .refine(
    (candidate) =>
      z.string().ip({ version: 'v4' }).safeParse(candidate).success || z.string().ip({ version: 'v6' }).safeParse(candidate).success,
    'debe ser una direccion IP valida (IPv4 o IPv6)'
  );

/** Representaciones textuales del valor booleano verdadero admitidas en el archivo `.env`. */
const TRUE_LITERALS = new Set(['true', '1', 'yes', 'on', 'si', 'sí']);

/** Representaciones textuales del valor booleano falso admitidas en el archivo `.env`. */
const FALSE_LITERALS = new Set(['false', '0', 'no', 'off']);

/**
 * Esquema booleano seguro para variables de entorno.
 * Prohibido usar `z.coerce.boolean()` en este proyecto: `Boolean('false')` devuelve `true`
 * en JavaScript, por lo que la cadena `"false"` activaria banderas de seguridad como
 * `SSRF_ALLOW_PRIVATE_NETWORKS` o `DATABASE_SSL_REJECT_UNAUTHORIZED` de forma silenciosa.
 * Este esquema interpreta exclusivamente los literales oficiales y rechaza cualquier otro.
 *
 * @param defaultValue - Valor aplicado cuando la variable no esta declarada.
 * @returns Esquema Zod que normaliza la variable a un booleano estricto.
 */
export function booleanFromEnvironmentSchema(defaultValue: boolean): z.ZodEffects<z.ZodUnknown, boolean, unknown> {
  return z.unknown().transform((rawValue, context) => {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return defaultValue;
    }
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim().toLowerCase();
      if (TRUE_LITERALS.has(normalized)) {
        return true;
      }
      if (FALSE_LITERALS.has(normalized)) {
        return false;
      }
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'debe ser un valor booleano explicito: true/false, 1/0, yes/no u on/off',
    });
    return z.NEVER;
  });
}

/**
 * Construye un esquema de secreto de alta entropia con longitud minima obligatoria.
 *
 * @param minimumLength - Longitud minima aceptada para el secreto.
 * @param label - Etiqueta legible usada en el mensaje de error en espanol.
 * @returns Esquema Zod de cadena con la restriccion de longitud aplicada.
 */
export function strongSecretSchema(minimumLength: number, label: string): z.ZodString {
  return z.string().trim().min(minimumLength, `${label} debe tener al menos ${minimumLength} caracteres`);
}

/**
 * Convierte a `Buffer` el contenido PEM de una llave, admitiendo tanto el formato
 * codificado en Base64 de una sola linea como el formato multilinea tradicional.
 *
 * @param rawKey - Valor crudo de la variable de entorno.
 * @returns Buffer con el contenido PEM decodificado.
 */
export function decodePemKey(rawKey: string): Buffer {
  if (rawKey.includes('-----BEGIN')) {
    return Buffer.from(rawKey, 'utf8');
  }
  return Buffer.from(rawKey, 'base64');
}

/**
 * Verifica que un PEM decodificado corresponda al tipo de llave Ed25519 esperado.
 *
 * @param rawKey - Valor crudo de la variable de entorno.
 * @param headerLabel - Etiqueta PEM esperada, por ejemplo `PRIVATE KEY` o `PUBLIC KEY`.
 * @returns `true` cuando el contenido es un PEM valido con cabecera y cierre correctos.
 */
export function isValidPemKey(rawKey: string, headerLabel: string): boolean {
  const decoded = decodePemKey(rawKey).toString('utf8');
  return (
    decoded.includes(`-----BEGIN ${headerLabel}-----`) &&
    decoded.includes(`-----END ${headerLabel}-----`) &&
    decoded.length >= 64
  );
}

/**
 * Esquema crudo de variables de entorno: obligatoriedad, tipos primitivos, transformaciones
 * de listas separadas por coma y valores por omision seguros para desarrollo.
 */
export const rawEnvironmentSchema = z.object({
  // --- Aplicacion y Node Pool -------------------------------------------------
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  PORT: networkPortSchema.default(3000),
  VOICE_WS_PORT: networkPortSchema.default(3002),
  TRAINER_WS_PORT: networkPortSchema.default(3003),
  NODE_POOL_ROLE: z.enum(NODE_POOL_ROLES).default('API_CONTROL_PLANE'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SERVICE_INSTANCE_ID: z.string().trim().min(1).default(`node-${process.pid}`),

  // --- Persistencia PostgreSQL (Neon) ----------------------------------------
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, 'DATABASE_URL es obligatoria')
    .refine(
      (candidate) => candidate.startsWith('postgresql://') || candidate.startsWith('postgres://'),
      'DATABASE_URL debe usar el esquema postgresql:// o postgres://'
    ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  DATABASE_SSL_REJECT_UNAUTHORIZED: booleanFromEnvironmentSchema(true),
  /**
   * Cadena de conexion del PROPIETARIO de la base de datos.
   *
   * Se declara aparte de `DATABASE_URL` porque son dos identidades con privilegios distintos, y
   * confundirlas tiene consecuencias graves: `DATABASE_URL` la usa la aplicacion y su rol NO debe
   * tener `BYPASSRLS` —si lo tiene, las politicas de aislamiento multi-tenant dejan de aplicarse sin
   * que ninguna prueba funcional lo detecte—, mientras que esta la usan las migraciones y las tareas
   * administrativas, que si necesitan privilegio de propietario. Es opcional: si en un despliegue
   * ambos papeles los ejerce el mismo rol, basta con declarar `DATABASE_URL`.
   */
  DATABASE_OWNER_URL: z
    .string()
    .trim()
    .refine(
      (candidate) =>
        candidate.length === 0 || candidate.startsWith('postgresql://') || candidate.startsWith('postgres://'),
      'DATABASE_OWNER_URL debe usar el esquema postgresql:// o postgres://'
    )
    .optional(),

  // --- Cache, cuotas y sesiones (Redis Cluster) ------------------------------
  REDIS_CLUSTER_URLS: z
    .string()
    .trim()
    .min(1, 'REDIS_CLUSTER_URLS es obligatoria')
    .transform((raw) =>
      raw
        .split(',')
        .map((node) => node.trim())
        .filter((node) => node.length > 0)
    )
    .pipe(z.array(redisNodeUrlSchema).min(1, 'REDIS_CLUSTER_URLS debe declarar al menos un nodo')),
  REDIS_KEY_PREFIX: z.string().trim().min(1).default('oa'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),

  // --- Criptografia de identidad (JWT EdDSA / Ed25519) ----------------------
  JWT_EDDSA_PRIVATE_KEY_PEM: z.string().trim().optional(),
  JWT_EDDSA_PUBLIC_KEY_PEM: z.string().trim().optional(),
  JWT_ISSUER: z.string().trim().min(1).default('onboarding-assistant'),
  JWT_AUDIENCE: z.string().trim().min(1).default('onboarding-assistant-api'),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ARGON2_TIMING_FLOOR_MS: z.coerce.number().int().min(0).max(5000).default(350),

  // --- Llave fisica (FIDO2 / WebAuthn) ---------------------------------------
  /**
   * Identificador de la parte confiable: el dominio efectivo de la plataforma.
   *
   * Es imprescindible para verificar una asercion de llave fisica: sin el, no puede comprobarse que el
   * autenticador haya actuado **para este dominio** y no para otro, de modo que una asercion capturada
   * en un sitio ajeno seria aceptable. Se declara con valor por omision derivado del contrato, y debe
   * fijarse al dominio real en produccion.
   */
  WEBAUTHN_RP_ID: z.string().trim().min(1).default('onboarding-assistant'),
  /**
   * Origenes autorizados para las ceremonias de llave fisica, separados por comas.
   *
   * El navegador incluye el origen en los datos del cliente, y verificarlo es lo que impide que una
   * asercion generada en un sitio bajo control del atacante se presente como valida.
   */
  WEBAUTHN_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default('https://onboarding-assistant.local')
    .transform((candidate) =>
      candidate
        .split(',')
        .map((origen) => origen.trim())
        .filter((origen) => origen.length > 0)
    )
    .pipe(z.array(z.string().trim().min(1)).min(1, 'WEBAUTHN_ALLOWED_ORIGINS debe declarar al menos un origen')),

  // --- Cobros y suscripciones -------------------------------------------------
  //
  // `WHOP_API_KEY` es la clave de APLICACION (`apik_` emitido por el listing del app). NO sirve para
  // operar la pasarela: la API de cobros responde `403 App API key is not authorized for the scope`
  // y `400 Missing required parameter: company_id` cuando se llama con ella. Se conserva porque el
  // front la necesita como identificador publico del app, pero ningun adapter de cobros debe usarla.
  WHOP_API_KEY: strongSecretSchema(16, 'WHOP_API_KEY'),
  /**
   * Clave de API de la EMPRESA (`apik_` del dashboard de la compania). Es la UNICA credencial con
   * permisos reales sobre `checkout_configurations`, `plans`, `memberships` y `webhooks`, y la que
   * debe usarse en todas las llamadas server-side de cobro.
   */
  WHOP_COMPANY_API_KEY: strongSecretSchema(16, 'WHOP_COMPANY_API_KEY'),
  /**
   * Identificador de la cuenta/empresa en la pasarela, con prefijo `biz_`. La API v1 lo exige en
   * casi todas las operaciones; omitirlo produce `400 parameter_missing: company_id`.
   */
  WHOP_COMPANY_ID: z.string().trim().regex(/^biz_[A-Za-z0-9_]+$/u, 'WHOP_COMPANY_ID debe tener el formato biz_...').default('biz_'),
  /** Identificador del producto al que se asociaran los planes creados por la plataforma (`prod_...`). */
  WHOP_PRODUCT_ID: z.string().trim().regex(/^prod_[A-Za-z0-9_]+$/u, 'WHOP_PRODUCT_ID debe tener el formato prod_...').optional(),
  WHOP_WEBHOOK_SECRET: strongSecretSchema(24, 'WHOP_WEBHOOK_SECRET'),
  INTERNAL_CHECKOUT_HMAC_SECRET: strongSecretSchema(32, 'INTERNAL_CHECKOUT_HMAC_SECRET'),
  WHOP_API_BASE_URL: absoluteUrlSchema.default('https://api.whop.com'),
  WHOP_CHECKOUT_BASE_URL: absoluteUrlSchema.default('https://whop.com/checkout'),
  WHOP_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /**
   * Porcentaje de comision de la pasarela sobre cada transaccion, expresado en tanto por uno (0.035
   * = 3.5%). Composicion verificada contra la tarifa real de la cuenta: 2.7% de procesado de tarjeta
   * nacional mas 0.8% de orquestacion, que en esta cuenta esta habilitada.
   *
   * Se usa unicamente para recalcular el precio BRUTO que ve el cliente, de modo que el importe NETO
   * que liquida en el panel de la empresa coincida con el precio de lista del plan.
   */
  WHOP_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(0.30).default(0.035),
  /** Comision fija por transaccion en USD que la pasarela descuenta del importe bruto ($0.30). */
  WHOP_PLATFORM_FEE_FIXED_USD: z.coerce.number().min(0).max(10).default(0.30),

  // --- Motores de voz en tiempo real -----------------------------------------
  QWEN_REALTIME_WS_URL: webSocketUrlSchema,
  QWEN_API_KEY: strongSecretSchema(16, 'QWEN_API_KEY'),
  GEMINI_LIVE_WS_URL: webSocketUrlSchema,
  GEMINI_API_KEY: strongSecretSchema(16, 'GEMINI_API_KEY'),
  VOICE_PROVIDER_PRIMARY: z.enum(['QWEN', 'GEMINI']).default('QWEN'),
  VOICE_PROVIDER_FAILOVER_BUDGET_MS: z.coerce.number().int().min(100).max(10000).default(800),
  VOICE_BARGE_IN_BUDGET_MS: z.coerce.number().int().min(10).max(1000).default(50),
  VOICE_PCM_SAMPLE_RATE_HZ: z.coerce.number().int().min(8000).max(48000).default(16000),
  VOICE_RING_BUFFER_MAX_FRAMES: z.coerce.number().int().min(16).max(4096).default(512),
  VOICE_SESSION_MAX_MINUTES: z.coerce.number().int().min(1).max(480).default(60),

  // --- Navegador de entrenamiento remoto y escudo Anti-SSRF ------------------
  CHROMIUM_DMZ_ENDPOINT: absoluteUrlSchema,
  CHROMIUM_CONTAINER_IMAGE: z.string().trim().min(1).default('onboarding-assistant/chromium-dmz:1.0.0'),
  CHROMIUM_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  EXTERNAL_DNS_RESOLVERS: z
    .string()
    .trim()
    .default('1.1.1.1,8.8.8.8')
    .transform((raw) =>
      raw
        .split(',')
        .map((address) => address.trim())
        .filter((address) => address.length > 0)
    )
    .pipe(z.array(dnsResolverAddressSchema).min(1, 'EXTERNAL_DNS_RESOLVERS debe declarar al menos un resolutor DNS')),
  SSRF_DNS_LOOKUP_TIMEOUT_MS: z.coerce.number().int().min(200).max(15000).default(3000),
  SSRF_ALLOW_PRIVATE_NETWORKS: booleanFromEnvironmentSchema(false),

  // --- Endpoints publicos y limites de cuota ---------------------------------
  PUBLIC_API_BASE_URL: absoluteUrlSchema.default('http://127.0.0.1:3000'),
  // URL publica del gateway de voz (ws:// o wss://) que la demostracion anonima entrega a su socket.
  PUBLIC_VOICE_WS_URL: webSocketUrlSchema.optional(),
  PUBLIC_DEMO_SESSION_MAX_SECONDS: z.coerce.number().int().min(15).max(600).default(120),
  PUBLIC_DEMO_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(20),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    ),
});

/** Variables de entorno declaradas por el esquema crudo, en orden de declaracion. */
export const DECLARED_ENVIRONMENT_KEYS: readonly string[] = Object.keys(rawEnvironmentSchema.shape);

/**
 * Esquema refinado: aplica reglas cruzadas que dependen de mas de una variable y, en
 * produccion, eleva la exigencia de secretos y prohibe configuraciones inseguras.
 */
export const refinedEnvironmentSchema = rawEnvironmentSchema.superRefine((environment, context) => {
  const privateKey = environment.JWT_EDDSA_PRIVATE_KEY_PEM;
  const publicKey = environment.JWT_EDDSA_PUBLIC_KEY_PEM;
  const hasPrivateKey = typeof privateKey === 'string' && privateKey.length > 0;
  const hasPublicKey = typeof publicKey === 'string' && publicKey.length > 0;

  if (hasPrivateKey !== hasPublicKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_EDDSA_PRIVATE_KEY_PEM'],
      message: 'Las llaves EdDSA deben declararse siempre en par: la llave privada PKCS#8 y su llave publica SPKI.',
    });
  }

  if (hasPrivateKey && !isValidPemKey(privateKey as string, 'PRIVATE KEY')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_EDDSA_PRIVATE_KEY_PEM'],
      message: 'La llave privada EdDSA no contiene un PEM PKCS#8 valido (se espera -----BEGIN PRIVATE KEY----- tras decodificar Base64).',
    });
  }

  if (hasPublicKey && !isValidPemKey(publicKey as string, 'PUBLIC KEY')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_EDDSA_PUBLIC_KEY_PEM'],
      message: 'La llave publica EdDSA no contiene un PEM SPKI valido (se espera -----BEGIN PUBLIC KEY----- tras decodificar Base64).',
    });
  }

  if (environment.NODE_ENV === 'production') {
    if (!hasPrivateKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_EDDSA_PRIVATE_KEY_PEM'],
        message: 'En produccion el par de llaves EdDSA es obligatorio; queda prohibido firmar tokens con secretos simetricos.',
      });
    }
    if (environment.CORS_ALLOWED_ORIGINS.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'En produccion CORS_ALLOWED_ORIGINS debe declarar explicitamente los origenes autorizados del SDK y los paneles.',
      });
    }
    if (environment.SSRF_ALLOW_PRIVATE_NETWORKS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SSRF_ALLOW_PRIVATE_NETWORKS'],
        message: 'El escudo Anti-SSRF no puede permitir redes privadas en produccion (riesgo de acceso a metadatos de infraestructura).',
      });
    }
  }

  // Auditoria de la identidad de conexion (hallazgo C1-29): el contrato evalua con la MISMA autoridad
  // que el arranque si la identidad resuelta para la aplicacion es la del propietario declarado, lo
  // que desactivaria las politicas RLS sin error visible. Aqui solo se dispone de los valores ya
  // resueltos; la ambiguedad entre el archivo y el entorno la evalua `getEnvConfig()`, que es quien
  // tiene el ledger de sustituciones del cargador. En entornos no productivos el hallazgo no bloquea.
  for (const finding of buildConnectionIdentityFindings({
    databaseUrl: environment.DATABASE_URL,
    ownerUrl: environment.DATABASE_OWNER_URL,
    environmentName: environment.NODE_ENV,
    shadowedDeclarations: [],
  })) {
    if (finding.severity === 'BLOQUEANTE') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [finding.attribute],
        message: finding.description,
      });
    }
  }
});
