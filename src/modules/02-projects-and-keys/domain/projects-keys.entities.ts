/**
 * @archivo src/modules/02-projects-and-keys/domain/projects-keys.entities.ts
 * @modulo 02-projects-and-keys (Dominio de Proyectos, Dominios Permitidos y Claves de API)
 * @proposito
 *   Define las entidades de dominio, tipos de valor, DTOs y reglas de validacion para la
 *   gestion multi-tenant de proyectos, listas blancas de origenes para el SDK Web y ciclo
 *   de vida de claves de API criptograficas (`pk_live_` / `sk_live_`) con checksum CRC32.
 *
 * @resumen_contenido
 *   - Entidades: `ProjectEntity`, `ApiKeyEntity`, `AllowedDomainEntity`.
 *   - Tipos de valor: `VoiceModelEnum`, `ApiKeyEnvEnum`, `ApiKeyTypeEnum`.
 *   - DTOs: `CreateProjectInput`, `UpdateProjectInput`, `CreateApiKeyInput`, `RotateApiKeyInput`,
 *     `CreateAllowedDomainInput`, `SdkHandshakeInput`, `SdkHandshakeSessionToken`.
 *   - Utilidades de dominio: `normalizeOriginPattern()`, `isOriginMatchingPattern()`.
 *
 * @dependencias_internas
 *   - `@shared/kernel/result-and-errors.ts`: Dominio desacoplado y monada Result.
 *   - `@shared/kernel/api-key.util.ts`: Tipos oficiales ApiKeyType y ApiKeyEnvironment.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `api_keys`, `allowed_domains`.
 *   - Redis: `oa:apikey:sha256:<hash>`, `oa:proj:<id>:allowed_domains`.
 */

import { ApiKeyEnvironment, ApiKeyType } from '@shared/kernel/api-key.util';

/** Modelos de voz realtime autorizados en el sistema. */
export type VoiceModelType = 'GEMINI_3_8_LIVE' | 'QWEN_3_8_OMNI_FLASH_REALTIME';

/** Sensibilidad del Voice Activity Detector (VAD) para interrupciones (barge-in). */
export type VadSensitivity = 'LOW' | 'BALANCED' | 'HIGH';

/**
 * Entidad de dominio que representa un Proyecto dentro de una Organizacion.
 */
export interface ProjectEntity {
  /** Identificador unico UUID v4 del proyecto. */
  readonly id: string;
  /** Identificador de la organizacion propietaria (RLS tenant). */
  readonly organizationId: string;
  /** Nombre comercial amigable del proyecto. */
  readonly name: string;
  /** Slug unico dentro de la organizacion para URLs y referencias. */
  readonly slug: string;
  /** Entorno operativo del proyecto. */
  readonly environment: ProjectEnvironment;
  /** Modelo primario de voz en tiempo real. */
  readonly primaryVoiceModel: VoiceModelType;
  /** Modelo de respaldo inmediato ante indisponibilidad del primario. */
  readonly fallbackVoiceModel: VoiceModelType;
  /** Codigo del perfil de voz seleccionado. */
  readonly voicePersonaCode: string;
  /** Velocidad de locucion (0.50 a 2.00). */
  readonly speechSpeed: number;
  /** Sensibilidad del VAD para cortes de habla del usuario. */
  readonly vadBargeInSensitivity: VadSensitivity;
  /** Temperatura estocastica del modelo (0.00 a 1.00). */
  readonly modelTemperature: number;
  /** Prompt maestro del sistema con instrucciones de comportamiento. */
  readonly systemPrompt: string;
  /** Pasos estructurados de onboarding en formato JSON. */
  readonly onboardingStepsJson: readonly Record<string, unknown>[];
  /** Si se exige ejecucion secuencial estricta de los pasos. */
  readonly strictStepEnforcement: boolean;
  /** Si se debe solicitar confirmacion explicita del usuario antes de enviar formularios. */
  readonly askConfirmationBeforeSubmit: boolean;
  /** Identificador del mapa funcional RAG activo actualmente. */
  readonly activeFunctionalMapId: string | null;
  /** Numero secuencial de la version del prompt activa. */
  readonly activePromptVersionNumber: number;
  /** Estado de habilitacion operativa del proyecto. */
  readonly isActive: boolean;
  /** Identificador del usuario que creo el proyecto. */
  readonly createdByUserId: string | null;
  /** Marca temporal de creacion. */
  readonly createdAt: Date;
  /** Marca temporal de ultima modificacion. */
  readonly updatedAt: Date;
}

/**
 * Entidad de dominio para una Clave de API publica o secreta.
 */
export interface ApiKeyEntity {
  /** Identificador unico UUID v4 de la clave. */
  readonly id: string;
  /** Organizacion duena de la clave (RLS). */
  readonly organizationId: string;
  /** Proyecto asociado. */
  readonly projectId: string;
  /** Nombre descriptivo para auditoria y paneles. */
  readonly name: string;
  /** Tipo de clave: publica para SDK o secreta para backend. */
  readonly keyType: ApiKeyType;
  /** Entorno de ejecucion: LIVE o TEST. */
  readonly environment: ProjectEnvironment;

  /** Prefijo visible de 16 caracteres. */
  readonly keyPrefix: string;
  /** Ultimos cuatro caracteres mostrados en listas. */
  readonly lastFour: string;
  /** Digest SHA-256 de 64 caracteres de la clave cruda. */
  readonly keyHash: string;
  /** Lista de permisos o scopes concedidos a esta clave. */
  readonly scopes: readonly string[];
  /** Si fue rotada, identificador de la clave antecesora. */
  readonly rotatedFromKeyId: string | null;
  /** Limite de la ventana de gracia para despliegues sin interrupciones. */
  readonly gracePeriodEndsAt: Date | null;
  /** Ultima marca temporal en que la clave fue consumida. */
  readonly lastUsedAt: Date | null;
  /** Ultima direccion IP de origen registrada. */
  readonly lastUsedIp: string | null;
  /** Fecha programada de expiracion. */
  readonly expiresAt: Date | null;
  /** Fecha de revocacion forzosa. */
  readonly revokedAt: Date | null;
  /** Usuario que ejecuto la revocacion. */
  readonly revokedByUserId: string | null;
  /** Usuario que emitio la clave. */
  readonly createdByUserId: string | null;
  /** Marca temporal de creacion. */
  readonly createdAt: Date;
}

/**
 * Entidad de dominio para un origen autorizado del SDK Web.
 */
export interface AllowedDomainEntity {
  /** Identificador unico UUID v4 del dominio registrado. */
  readonly id: string;
  /** Organizacion propietaria (RLS). */
  readonly organizationId: string;
  /** Proyecto protegido. */
  readonly projectId: string;
  /** Patron de origen (ej. `https://app.ejemplo.com` o `https://*.ejemplo.com`). */
  readonly originPattern: string;
  /** Si se permite `http://localhost:*` o `http://127.0.0.1:*` para desarrollo local. */
  readonly allowLocalhostDev: boolean;
  /** Token aleatorio para verificacion por registro DNS TXT. */
  readonly dnsVerificationToken: string | null;
  /** Marca temporal en que se valido el registro DNS. */
  readonly dnsVerifiedAt: Date | null;
  /** Estado de habilitacion. */
  readonly isActive: boolean;
  /** Usuario creador. */
  readonly createdByUserId: string | null;
  /** Fecha de creacion. */
  readonly createdAt: Date;
}

/** Entornos oficiales de proyecto y credenciales. */
export type ProjectEnvironment = 'LIVE' | 'TEST';

/** Entrada requerida para crear un nuevo proyecto. */
export interface CreateProjectInput {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly environment?: ProjectEnvironment | undefined;
  readonly primaryVoiceModel?: VoiceModelType | undefined;
  readonly fallbackVoiceModel?: VoiceModelType | undefined;
  readonly voicePersonaCode?: string | undefined;
  readonly speechSpeed?: number | undefined;
  readonly vadBargeInSensitivity?: VadSensitivity | undefined;
  readonly modelTemperature?: number | undefined;
  readonly systemPrompt?: string | undefined;
  readonly onboardingStepsJson?: readonly Record<string, unknown>[] | undefined;
  readonly strictStepEnforcement?: boolean | undefined;
  readonly askConfirmationBeforeSubmit?: boolean | undefined;
  readonly createdByUserId?: string | undefined;
}

/** Entrada para actualizar la configuracion de un proyecto. */
export interface UpdateProjectInput {
  readonly name?: string | undefined;
  readonly primaryVoiceModel?: VoiceModelType | undefined;
  readonly fallbackVoiceModel?: VoiceModelType | undefined;
  readonly voicePersonaCode?: string | undefined;
  readonly speechSpeed?: number | undefined;
  readonly vadBargeInSensitivity?: VadSensitivity | undefined;
  readonly modelTemperature?: number | undefined;
  readonly systemPrompt?: string | undefined;
  readonly onboardingStepsJson?: readonly Record<string, unknown>[] | undefined;
  readonly strictStepEnforcement?: boolean | undefined;
  readonly askConfirmationBeforeSubmit?: boolean | undefined;
  readonly isActive?: boolean | undefined;
}

/** Entrada para crear una clave de API. */
export interface CreateApiKeyInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly keyType: ApiKeyType;
  readonly environment: ProjectEnvironment;
  readonly scopes?: readonly string[] | undefined;
  readonly expiresAt?: Date | undefined;
  readonly createdByUserId?: string | undefined;
}

/** Entrada para rotar una clave de API con ventana de gracia. */
export interface RotateApiKeyInput {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly gracePeriodHours: number;
  readonly createdByUserId?: string | undefined;
}

/** Entrada para registrar un origen permitido. */
export interface CreateAllowedDomainInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly originPattern: string;
  readonly allowLocalhostDev?: boolean | undefined;
  readonly createdByUserId?: string | undefined;
}

/** Datos recibidos en el endpoint del Handshake del SDK Web. */
export interface SdkHandshakeInput {
  readonly publishableKey: string;
  readonly origin: string;
  readonly projectId: string;
  readonly clientIp: string;
  readonly endUserConsentGranted: boolean;
  readonly externalEndUserId?: string | undefined;
}


/** Respuesta emitida al widget del SDK tras un Handshake exitoso. */
export interface SdkHandshakeResult {
  readonly ephemeralWsToken: string;
  readonly nonceId: string;
  readonly expiresInSeconds: number;
  readonly projectId: string;
  readonly organizationId: string;
  readonly voiceSettings: {
    readonly primaryModel: VoiceModelType;
    readonly voicePersonaCode: string;
    readonly speechSpeed: number;
    readonly vadSensitivity: VadSensitivity;
  };
}

/**
 * Normaliza un patron de origen eliminando barras finales y convirtiendo a minusculas.
 *
 * @param origin - Origen a normalizar.
 * @returns Origen limpio y estandarizado.
 */
export function normalizeOriginPattern(origin: string): string {
  const trimmed = origin.trim().toLowerCase();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Evalua si un origen real presentado por un navegador coincide con un patron autorizado.
 * Soporta origenes exactos, localhost para desarrollo y comodines wildcard `*.dominio.com`.
 *
 * @param presentedOrigin - Origen crudo de la cabecera `Origin` o `Referer`.
 * @param registeredPattern - Patron configurado en la lista blanca de dominios.
 * @param allowLocalhost - Si se permite localhost para este patron.
 * @returns `true` si el origen es compatible y seguro.
 */
export function isOriginMatchingPattern(
  presentedOrigin: string,
  registeredPattern: string,
  allowLocalhost: boolean
): boolean {
  const normalizedOrigin = normalizeOriginPattern(presentedOrigin);
  const normalizedPattern = normalizeOriginPattern(registeredPattern);

  // 1. Verificacion especial de localhost en entornos de prueba / desarrollo
  if (allowLocalhost) {
    const isLocalhost =
      normalizedOrigin.startsWith('http://localhost:') ||
      normalizedOrigin === 'http://localhost' ||
      normalizedOrigin.startsWith('http://127.0.0.1:') ||
      normalizedOrigin === 'http://127.0.0.1';
    if (isLocalhost) {
      return true;
    }
  }

  // 2. Coincidencia exacta
  if (normalizedOrigin === normalizedPattern) {
    return true;
  }

  // 3. Coincidencia con wildcard (ej. https://*.midominio.com)
  if (normalizedPattern.includes('*')) {
    try {
      const originUrl = new URL(normalizedOrigin);
      const patternUrl = new URL(normalizedPattern.replace('*', 'placeholder'));

      if (originUrl.protocol !== patternUrl.protocol) {
        return false;
      }

      const patternHost = normalizedPattern.slice(normalizedPattern.indexOf('://') + 3);
      if (patternHost.startsWith('*.')) {
        const domainSuffix = patternHost.slice(2);
        return originUrl.hostname.endsWith(`.${domainSuffix}`) || originUrl.hostname === domainSuffix;
      }
    } catch {
      return false;
    }
  }

  return false;
}
