/**
 * @archivo src/shared/infrastructure/http/http-server.types.ts
 * @modulo 00-kernel (Contratos Tipados de HTTP, Contexto Autenticado y Registros de Rutas)
 * @proposito
 *   Define los contratos abstractos que desacoplan a los modulos de aplicacion del servidor
 *   HTTP concreto. Los casos de uso no conocen el framework: reciben un `AuthenticatedRequestContext`
 *   ya resuelto por la capa de transporte y devuelven un `HttpHandlerResult`. Esto permite que
 *   cada modulo registre sus rutas mediante su propio manifiesto de auto-conexion sin que ningun
 *   agente de IA tenga que editar un archivo central de rutas ni superar el tope de 500 lineas.
 *
 * @resumen_contenido
 *   - Tipos base: `HttpMethod`, `WebSocketDataFormat`, `RouteAccessLevel`, `HttpHeaders`.
 *   - Contexto autenticado: `AuthenticatedPrincipal` y `AuthenticatedRequestContext`.
 *   - Transporte: `HttpRequestLike`, `HttpHandlerResult` y `HttpRouteHandler`.
 *   - Registro HTTP: `HttpRouteRegistration` y `HttpRouterRegistry`.
 *   - Registro de sockets: `WsAuthenticatedContext`, `WsRouteRegistration` y `WsRouteRegistry`.
 *   - Contexto de aplicacion: `ApplicationServiceContext` (acceso a pool, cache y logger).
 *
 * @dependencias_internas
 *   - Codigos de error (`../../kernel/result-and-errors.ts`) para tipar las respuestas de fallo.
 *
 * @dependencias_externas
 *   - Ninguna (Solo tipos: cero costo en tiempo de ejecucion).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Contratos de transporte; el acceso a datos ocurre en los adaptadores concretos).
 */

import type { AppErrorCode, AuditSeverity } from '../../kernel/result-and-errors';

/** Metodos HTTP admitidos por el enrutador de la plataforma. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/** Formato de las tramas intercambiadas por un canal WebSocket. */
export type WebSocketDataFormat = 'JSON' | 'BINARY';

/**
 * Nivel de acceso exigido por una ruta, evaluado por el middleware antes de invocar el caso de uso.
 * - `PUBLIC`: Abierta (landing comercial, calculadora de planes y health check).
 * - `SDK_HANDSHAKE`: Exige la clave publica del SDK y el origen autorizado del proyecto.
 * - `TENANT_SESSION`: Exige JWT de acceso valido con `org_id` y rol RBAC verificado.
 * - `SUPERADMIN`: Exige membresia activa con rol SUPERADMIN y deja traza en `audit_logs`.
 */
export type RouteAccessLevel = 'PUBLIC' | 'SDK_HANDSHAKE' | 'TENANT_SESSION' | 'SUPERADMIN';

/** Cabeceras HTTP normalizadas a minusculas, con soporte de valores repetidos. */
export type HttpHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Identidad autenticada resuelta por el middleware a partir del JWT de acceso. */
export interface AuthenticatedPrincipal {
  /** Identificador del usuario autenticado (`sub` del token). */
  readonly userId: string;
  /** Organizacion activa del token (`org_id`). */
  readonly organizationId: string;
  /** Rol RBAC vigente dentro de la organizacion. */
  readonly role: 'SUPERADMIN' | 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';
  /** Permisos finos otorgados al token (`scp`). */
  readonly scopes: readonly string[];
  /** Version de token vigente (`tv`) usada para la revocacion instantanea. */
  readonly tokenVersion: number;
  /** Indica si la sesion acredito un segundo factor de autenticacion. */
  readonly mfaSatisfied: boolean;
  /** Identificador unico del token (`jti`), util para auditoria y trazabilidad. */
  readonly tokenId: string;
}

/** Contexto completo de una solicitud autenticada, listo para los casos de uso. */
export interface AuthenticatedRequestContext {
  /** Identidad autenticada; es `null` unicamente en rutas de nivel `PUBLIC`. */
  readonly principal: AuthenticatedPrincipal | null;
  /** Organizacion resuelta para la operacion (del token o de la clave publica del SDK). */
  readonly organizationId: string | null;
  /** Proyecto resuelto a partir de la clave de API o del cuerpo de la solicitud. */
  readonly projectId: string | null;
  /** Proyecto resuelto cuando la ruta opera sobre un mapa funcional concreto. */
  readonly functionalMapId: string | null;
  /** Origen HTTP validado contra `allowed_domains`; `null` si la ruta no lo exige. */
  readonly validatedOrigin: string | null;
  /** Identificador de correlacion para trazar la solicitud en logs y auditoria. */
  readonly requestId: string;
  /** Direccion IP del cliente (resuelta respetando la cadena de proxies de confianza). */
  readonly clientIp: string;
  /** Cabecera `User-Agent` recibida, util para auditoria forense. */
  readonly userAgent: string;
  /** Momento de recepcion de la solicitud. */
  readonly receivedAt: Date;
}

/** Abstraccion minima de una solicitud HTTP entrante, independiente del framework. */
export interface HttpRequestLike {
  /** Metodo HTTP de la solicitud. */
  readonly method: HttpMethod;
  /** Ruta normalizada sin parametros de consulta (por ejemplo `/api/v1/projects/:projectId`). */
  readonly path: string;
  /** Parametros de consulta ya decodificados. */
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Cabeceras normalizadas a minusculas. */
  readonly headers: HttpHeaders;
  /** Cuerpo crudo sin reserializar; obligatorio para verificar firmas HMAC de webhooks. */
  readonly rawBody: Buffer;
  /** Cuerpo ya parseado, o `undefined` cuando el contenido no es JSON valido. */
  readonly body: unknown;
  /** Direccion IP de origen del cliente. */
  readonly clientIp: string;
}

/** Respuesta producida por un manejador de ruta HTTP. */
export interface HttpHandlerResult<TBody = unknown> {
  /** Estado HTTP de la respuesta. */
  readonly status: number;
  /** Cuerpo serializable de la respuesta. */
  readonly body: TBody;
  /** Cabeceras adicionales a enviar (por ejemplo `Set-Cookie` o `Retry-After`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Respuesta de error estandarizada que produce el middleware al traducir un `AppError`. */
export interface HttpErrorResult {
  /** Estado HTTP recomendado por la jerarquia de errores. */
  readonly status: number;
  /** Cuerpo JSON con el codigo y el mensaje publico del error. */
  readonly body: {
    readonly error: {
      readonly code: AppErrorCode;
      readonly message: string;
      readonly httpStatus: number;
      readonly wsCloseCode: number;
      readonly auditSeverity: AuditSeverity;
      readonly details: Readonly<Record<string, unknown>>;
    };
  };
}

/**
 * Manejador de una ruta HTTP.
 * Recibe la solicitud cruda y el contexto ya autenticado, y devuelve la respuesta tipada.
 *
 * @param request - Solicitud HTTP normalizada.
 * @param context - Contexto autenticado resuelto por el middleware.
 * @returns Respuesta del caso de uso.
 */
export type HttpRouteHandler<TBody = unknown> = (
  request: HttpRequestLike,
  context: AuthenticatedRequestContext
) => Promise<HttpHandlerResult<TBody>>;

/** Declaracion completa de una ruta HTTP registrada por el manifiesto de un modulo. */
export interface HttpRouteRegistration {
  /** Metodo HTTP de la ruta. */
  readonly method: HttpMethod;
  /** Ruta absoluta con parametros nombrados (por ejemplo `/api/v1/projects/:projectId/api-keys`). */
  readonly path: string;
  /** Nivel de acceso exigido por el middleware de seguridad. */
  readonly access: RouteAccessLevel;
  /** Permisos finos requeridos por el token para autorizar la operacion. */
  readonly requiredScopes: readonly string[];
  /** Manifiesto o modulo propietario de la ruta, usado en diagnostico y auditoria. */
  readonly ownerModule: string;
  /** Indica si la ruta requiere cuerpo crudo para verificar firmas criptograficas. */
  readonly requiresRawBody: boolean;
  /** Manejador que ejecuta el caso de uso correspondiente. */
  readonly handler: HttpRouteHandler<never>;
}

/** Registro de rutas HTTP que cada manifiesto de modulo utiliza para auto-conectarse. */
export interface HttpRouterRegistry {
  /**
   * Registra una ruta HTTP en el enrutador de la aplicacion.
   *
   * @param registration - Declaracion completa de la ruta.
   */
  register(registration: HttpRouteRegistration): void;

  /**
   * Devuelve una copia inmutable de todas las rutas registradas hasta el momento.
   *
   * @returns Listado de rutas registradas.
   */
  list(): readonly HttpRouteRegistration[];
}

/** Contexto autenticado disponible al abrir un canal WebSocket. */
export interface WsAuthenticatedContext {
  /** Identidad autenticada que abrio el canal. */
  readonly principal: AuthenticatedPrincipal;
  /** Identificador de la sesion de voz creada para este canal. */
  readonly voiceSessionId: string;
  /** Organizacion propietaria de la sesion. */
  readonly organizationId: string;
  /** Proyecto al que pertenece el mapa funcional en ejecucion. */
  readonly projectId: string;
  /** Origen validado del navegador del usuario final. */
  readonly validatedOrigin: string;
  /** Momento exacto de apertura del canal. */
  readonly openedAt: Date;
}

/** Declaracion de una ruta WebSocket registrada por el manifiesto de un modulo. */
export interface WsRouteRegistration {
  /** Ruta del canal (por ejemplo `/ws/v1/realtime`). */
  readonly path: string;
  /** Formato de las tramas esperadas: binario PCM16 o JSON de control. */
  readonly dataFormat: WebSocketDataFormat;
  /** Nivel de acceso exigido por el middleware de handshake. */
  readonly access: RouteAccessLevel;
  /** Manifiesto o modulo propietario del canal. */
  readonly ownerModule: string;
  /**
   * Manejador del canal: recibe el contexto autenticado y controla el ciclo de vida del
   * socket hasta su cierre, devolviendo el motivo de finalizacion de la sesion.
   *
   * @param context - Contexto autenticado del canal.
   * @returns Motivo de finalizacion de la sesion de voz.
   */
  readonly handler: (context: WsAuthenticatedContext) => Promise<{ readonly terminationReason: string }>;
}

/** Registro de canales WebSocket que cada manifiesto de modulo utiliza para auto-conectarse. */
export interface WsRouteRegistry {
  /**
   * Registra un canal WebSocket en el servidor de aplicacion.
   *
   * @param registration - Declaracion completa del canal.
   */
  register(registration: WsRouteRegistration): void;

  /**
   * Devuelve una copia inmutable de todos los canales registrados hasta el momento.
   *
   * @returns Listado de canales WebSocket registrados.
   */
  list(): readonly WsRouteRegistration[];
}

/** Acceso a la infraestructura compartida disponible para los casos de uso. */
export interface ApplicationServiceContext {
  /** Pool de PostgreSQL con contexto RLS ya establecido para la solicitud. */
  readonly databasePool: unknown;
  /** Cliente de Redis Cluster para cuotas, cache y estado de sesiones. */
  readonly redisClient: unknown;
  /** Logger estructurado con el identificador de correlacion ya inyectado. */
  readonly logger: unknown;
  /** Contrato de entorno validado vigente del proceso. */
  readonly environment: unknown;
}
