/**
 * @archivo src/shared/ports/core-modules.ports.ts
 * @modulo 00-kernel (Contratos Publicos Inmutables de los Modulos 01, 02 y 03)
 * @proposito
 *   Declara los puertos que permiten al Gateway de Voz y al resto de modulos consumir identidad,
 *   claves de API y mapa RAG sin conocer sus implementaciones concretas. Estos contratos se
 *   congelan al cerrar la Parte 3 y son la frontera que hace posible el trabajo paralelo de dos
 *   agentes de IA: el Carril 2 implementa estos puertos en los modulos 01, 02 y 03, y el Carril 1
 *   los consume desde los modulos 04, 05 y 06 sin tocar sus archivos.
 *
 * @resumen_contenido
 *   - Tipos compartidos: `PortFailureCode`, `PortFailure`, `RiskLevel` y `RouteContextReference`.
 *   - Interface `IIdentityAuthPort`: `verifyAccessTokenAndVersion()` y `assertOrganizationActive()`.
 *   - Interface `IApiKeyAndHandshakePort`: `validateSecretKey()`, `validateSdkHandshake()` y
 *     `consumeEphemeralWsNonce()`.
 *   - Interface `IVisualRagAndPromptPort`: `getActiveProjectPromptAndMapMeta()`,
 *     `getSlimmedRouteContext()` y `validateElementActionGuardrail()`.
 *   - Tipo `CoreModuleManifest`: Firma estandar de registro de los modulos del nucleo.
 *
 * @dependencias_internas
 *   - `RiskLevel` y `RouteContextReference` se declaran aqui como contrato compartido.
 *   - `DependencyContainer` (`../container/di-container.ts`) para la firma del manifiesto.
 *
 * @dependencias_externas
 *   - Ninguna (Solo interfaces: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users`, `organizations`, `memberships`, `auth_sessions`, `api_keys`,
 *     `allowed_domains`, `functional_maps`, `map_elements`, `prompt_versions`.
 *   - Redis: `auth:user_tv:<id>`, `apikey:sha256:<hash>`, `sdk_handshake:nonce:<jti>`,
 *     `rag_map:proj:<id>:meta` y `rag_map:proj:<id>:routes`.
 */

import type { DependencyContainer } from '../container/di-container';

/** Codigos de fallo que un puerto puede devolver sin lanzar excepcion. */
export type PortFailureCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_VERSION_REVOKED'
  | 'TENANT_SUSPENDED'
  | 'DPA_NOT_SIGNED'
  | 'LEGAL_CONSENT_OUTDATED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'API_KEY_INVALID'
  | 'API_KEY_REVOKED'
  | 'API_KEY_EXPIRED'
  | 'HANDSHAKE_NONCE_INVALID'
  | 'HANDSHAKE_NONCE_REPLAYED'
  | 'SCOPE_NOT_GRANTED'
  | 'MAP_NOT_PUBLISHED'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_ACTION_NOT_ALLOWED'
  | 'SENSITIVE_FIELD_BLOCKED'
  | 'RESOURCE_NOT_FOUND'
  | 'PERSISTENCE_UNAVAILABLE';

/** Resultado fallido normalizado de cualquier puerto del nucleo. */
export interface PortFailure {
  /** Discriminante de fallo. */
  readonly ok: false;
  /** Codigo estable del motivo de rechazo. */
  readonly code: PortFailureCode;
  /** Explicacion en espanol apta para bitacora; nunca debe revelar si un recurso existe. */
  readonly reason: string;
  /** Indica si el cliente puede reintentar la operacion sin cambios. */
  readonly retryable: boolean;
}

/** Nivel de riesgo de una accion fisica sobre el DOM. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Referencia compacta a la ruta y el paso de onboarding vigentes. */
export interface RouteContextReference {
  /** Ruta normalizada sobre la que ocurre la accion (por ejemplo `/checkout`). */
  readonly routePath: string;
  /** Numero de paso del onboarding en el que se encuentra el usuario final. */
  readonly stepNumber: number;
  /** Identificador inmutable de la version del mapa funcional usada como contexto. */
  readonly functionalMapId: string;
  /** Checksum SHA-256 canonico del mapa, para detectar deriva entre nodos. */
  readonly canonicalSha256: string;
}

/** Identidad autenticada resuelta por el modulo de identidad. */
export interface AuthenticatedActor {
  /** Identificador del usuario autenticado. */
  readonly userId: string;
  /** Organizacion activa del token. */
  readonly organizationId: string;
  /** Rol RBAC vigente dentro de la organizacion. */
  readonly role: 'SUPERADMIN' | 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';
  /** Permisos finos otorgados al token. */
  readonly scopes: readonly string[];
  /** Version de token vigente, usada para la revocacion instantanea. */
  readonly tokenVersion: number;
  /** Indica si la sesion acredito un segundo factor. */
  readonly mfaSatisfied: boolean;
  /** Identificador unico del token, util para auditoria. */
  readonly tokenId: string;
}

/**
 * Puerto de identidad y control de acceso (Modulo 01).
 * Es el unico autorizado a interpretar el JWT de acceso y a decidir si una organizacion puede
 * operar (estado activo, DPA firmado y documentos legales vigentes aceptados).
 */
export interface IIdentityAuthPort {
  /**
   * Verifica la firma EdDSA del token de acceso, su vigencia y que su `token_version` no haya
   * sido revocado globalmente. La comprobacion de version consulta Redis en sub-milisegundo.
   *
   * @param accessToken - Token JWT recibido en la cabecera de autorizacion.
   * @returns Actor autenticado, o fallo normalizado con el motivo exacto del rechazo.
   */
  verifyAccessTokenAndVersion(
    accessToken: string
  ): Promise<{ readonly ok: true; readonly actor: AuthenticatedActor } | PortFailure>;

  /**
   * Comprueba que la organizacion este activa, con el DPA vigente firmado y sin documentos
   * legales obligatorios pendientes de aceptacion.
   *
   * @param organizationId - Organizacion a validar.
   * @param userId - Usuario cuyo cumplimiento legal se verifica.
   * @returns Confirmacion con la version de DPA vigente, o fallo normalizado.
   */
  assertOrganizationActive(
    organizationId: string,
    userId: string
  ): Promise<
    | { readonly ok: true; readonly dpaVersionTag: string; readonly organizationSlug: string }
    | PortFailure
  >;
}

/** Resultado de la validacion de una clave secreta de backend. */
export interface SecretKeyValidationSuccess {
  readonly ok: true;
  /** Organizacion propietaria de la clave. */
  readonly organizationId: string;
  /** Proyecto al que pertenece la clave. */
  readonly projectId: string;
  /** Identificador de la clave para auditoria. */
  readonly apiKeyId: string;
  /** Permisos otorgados a la clave. */
  readonly scopes: readonly string[];
  /** Entorno declarado por la clave. */
  readonly environment: 'LIVE' | 'TEST';
}

/**
 * Puerto de validacion de claves de API y handshake del SDK (Modulo 02).
 */
export interface IApiKeyAndHandshakePort {
  /**
   * Valida una clave secreta `sk_live_...` o `sk_test_...` presentada por un backend.
   * El checksum CRC32 se verifica antes de consultar Redis o PostgreSQL.
   *
   * @param rawSecretKey - Clave cruda recibida en la cabecera de autorizacion.
   * @param requiredScope - Permiso minimo exigido por la operacion solicitada.
   * @returns Contexto autorizado, o fallo normalizado.
   */
  validateSecretKey(rawSecretKey: string, requiredScope?: string): Promise<SecretKeyValidationSuccess | PortFailure>;

  /**
   * Valida el handshake del SDK: origen contra `allowed_domains`, clave publica `pk_live_...` y
   * disponibilidad operativa del proyecto.
   *
   * @param rawPublishableKey - Clave publica presentada por el widget.
   * @param origin - Origen HTTP declarado por el navegador del usuario final.
   * @param projectId - Proyecto sobre el que se solicita la sesion.
   * @returns Contexto autorizado del navegador, o fallo normalizado.
   */
  validateSdkHandshake(
    rawPublishableKey: string,
    origin: string,
    projectId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly organizationId: string;
        readonly projectId: string;
        readonly issuedNonceId: string;
        readonly nonceTtlSeconds: number;
      }
    | PortFailure
  >;

  /**
   * Consume un nonce efimero de un solo uso emitido durante el handshake.
   * Si el nonce ya fue usado o expiro, devuelve fallo por repeticion.
   *
   * @param nonceId - Identificador del nonce recibido al abrir el canal de voz.
   * @param projectId - Proyecto que debe coincidir con el emisor del nonce.
   * @returns Identidad del usuario final autorizado, o fallo normalizado.
   */
  consumeEphemeralWsNonce(
    nonceId: string,
    projectId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly externalEndUserId: string | null;
        /**
         * Organizacion autenticada a la que pertenece el proyecto del nonce.
         *
         * Se devuelve porque es la UNICA fuente autoritativa de la identidad del tenant en la
         * apertura de un canal de voz: el identificador que llegue por la URL es un dato del cliente
         * y aceptarlo permitiria a un proyecto facturar su consumo a otra organizacion o evadir el
         * corte masivo de sesiones de una organizacion suspendida.
         */
        readonly organizationId: string;
      }
    | PortFailure
  >;
}

/** Metadatos del Mapa Funcional activo de un proyecto. */
export interface ActiveMapMetadata {
  /** Identificador inmutable de la version del mapa. */
  readonly functionalMapId: string;
  /** Numero de version publicado. */
  readonly versionNumber: number;
  /** Checksum SHA-256 canonico del mapa. */
  readonly canonicalSha256: string;
  /** Rutas cubiertas por el mapa. */
  readonly routes: readonly string[];
  /** Numero total de elementos etiquetados. */
  readonly totalElementsCount: number;
  /** Fecha de publicacion en formato ISO 8601. */
  readonly publishedAtIso: string;
}

/** Contexto depurado de una ruta para el prompt del motor de voz. */
export interface SlimmedRouteContext {
  /** Ruta normalizada consultada. */
  readonly routePath: string;
  /** Paso de onboarding vigente. */
  readonly stepNumber: number;
  /** Descripcion textual del paso que debe narrar el asistente. */
  readonly stepInstruction: string;
  /** Acciones permitidas en la ruta, ya depuradas de campos sensibles. */
  readonly allowedActions: readonly {
    readonly elementKey: string;
    readonly title: string;
    readonly functionalDescription: string;
    readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
    readonly primarySelector: string;
    readonly riskLevel: RiskLevel;
  }[];
}

/**
 * Puerto del Mapa Funcional RAG y del estudio del prompt (Modulo 03).
 */
export interface IVisualRagAndPromptPort {
  /**
   * Devuelve el prompt de sistema vigente del proyecto y los metadatos del mapa activo.
   *
   * @param projectId - Proyecto consultado.
   * @returns Prompt y metadatos del mapa, o fallo normalizado si no hay mapa publicado.
   */
  getActiveProjectPromptAndMapMeta(
    projectId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly systemPrompt: string;
        readonly promptVersionNumber: number;
        readonly onboardingStepsJson: readonly unknown[];
        readonly primaryVoiceModel: string;
        readonly fallbackVoiceModel: string;
        readonly mapMetadata: ActiveMapMetadata;
      }
    | PortFailure
  >;

  /**
   * Devuelve el contexto minimo necesario de una ruta (Context Slimming), evitando enviar al
   * motor de voz elementos irrelevantes o campos sensibles.
   *
   * @param projectId - Proyecto consultado.
   * @param routePath - Ruta sobre la que se encuentra el usuario final.
   * @param stepNumber - Paso de onboarding vigente.
   * @returns Contexto depurado de la ruta, o fallo normalizado.
   */
  getSlimmedRouteContext(
    projectId: string,
    routePath: string,
    stepNumber: number
  ): Promise<{ readonly ok: true; readonly context: SlimmedRouteContext } | PortFailure>;

  /**
   * Valida que una accion fisica propuesta por el motor de voz respete el mapa funcional y las
   * barreras de seguridad (campos sensibles y elementos no accionables).
   *
   * @param projectId - Proyecto sobre el que se propone la accion.
   * @param functionalMapId - Version inmutable del mapa que sirve de contexto.
   * @param toolName - Herramienta invocada por el motor (`click_element` o `type_text`).
   * @param targetElementKey - Elemento del mapa sobre el que se propone actuar.
   * @param routePath - Ruta en la que se ejecutaria la accion.
   * @returns Autorizacion con el selector validado y el nivel de riesgo, o fallo normalizado.
   */
  validateElementActionGuardrail(
    projectId: string,
    functionalMapId: string,
    toolName: 'click_element' | 'type_text',
    targetElementKey: string,
    routePath: string
  ): Promise<
    | {
        readonly ok: true;
        readonly primarySelector: string;
        readonly riskLevel: RiskLevel;
        readonly requiresUserConfirmation: boolean;
      }
    | PortFailure
  >;
}

/** Firma estandar del manifiesto de registro de un modulo del nucleo. */
export type CoreModuleManifest = (container: DependencyContainer) => void;
