/**
 * @archivo src/bootstrap/module-autoloader.ts
 * @modulo Bootstrap (Ensamblaje Automatico del Monolito Modular Hexagonal)
 * @proposito
 *   Instancia la infraestructura compartida una sola vez por proceso, ejecuta los siete manifiestos
 *   de modulo en un orden determinista y **verifica al arrancar** que todos los `DI_TOKENS` tengan
 *   implementacion antes de aceptar trafico. Esa verificacion es el valor real del archivo: sin ella,
 *   una cadena de manifiestos incompleta no falla al levantar, sino cuando un usuario final intenta
 *   hablar o pagar, con un mensaje criptico y en el peor momento posible. Cada manifiesto tiene una
 *   firma distinta —el de voz recibe el bus de eventos y devuelve el adaptador de control, y tres
 *   reciben el registro de canales— de modo que el orden y los argumentos se declaran aqui de forma
 *   explicita y verificable.
 *
 * @resumen_contenido
 *   - Constante `REQUIRED_DI_TOKENS`: Tokens que deben quedar resueltos tras el ensamblaje.
 *   - Interface `BootstrapOptions` y `BootstrappedSystem`.
 *   - Funcion `bootstrapBackendSystem()`: Infraestructura, manifiestos y verificacion de tokens.
 *   - Funciones `verifyRequiredTokens()` y `describeAssembly()`: Diagnostico de arranque.
 *
 * @dependencias_internas
 *   - Los siete manifiestos de modulo (`src/modules/<modulo>/<archivo>.manifest.ts`).
 *   - `DependencyContainer`, `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *   - Registros de rutas (`src/shared/infrastructure/http/http-router.registry.ts`).
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para las credenciales de la infraestructura.
 *
 * @dependencias_externas
 *   - Ninguna (El transporte y la persistencia son adaptadores ya construidos en el kernel).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `RlsDatabasePool` sobre `DATABASE_URL` (Unico pool por proceso).
 *   - Redis: `RedisClusterClient` sobre `REDIS_CLUSTER_URLS` (Unico cliente por proceso).
 */

import { getEnvConfig } from '../config/env.schema';
import type { AppEnvironment } from '../config/env.contract';
import { DependencyContainer, DI_TOKENS } from '../shared/container/di-container';
import { RlsDatabasePool } from '../shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../shared/infrastructure/redis/redis-cluster.client';
import { DomainEventBus } from '../shared/infrastructure/event-bus/domain-event-bus';
import { TokenBucketRateLimiter } from '../shared/infrastructure/redis/token-bucket.lua';
import {
  createRouterRegistries,
  HttpRouterRegistryImpl,
  WsRouteRegistryImpl,
} from '../shared/infrastructure/http/http-router.registry';
import { UnifiedSessionTokenVerifier } from '../shared/infrastructure/auth/unified-session-verifier';
import { registerIdentityModule } from '../modules/01-identity-and-rbac/identity.manifest';
import { registerAuthEssentialRoutes } from './auth-essential-http.routes';
import { registerProjectsKeysModule } from '../modules/02-projects-and-keys/projects-keys.manifest';
import { registerVisualTrainerRagModule } from '../modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest';
import type { VisualRagAndPromptPortAdapter } from '../modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest';
import { registerBillingWhopModule } from '../modules/04-billing-and-whop/billing-whop.manifest';
import { registerVoiceGatewayModule } from '../modules/05-voice-realtime-gateway/voice-gateway.manifest';
import { registerVoiceGatewayWsRoute } from '../modules/05-voice-realtime-gateway/voice-gateway.ws-routes';
import type { VoiceGatewayControlAdapter } from '../modules/05-voice-realtime-gateway/voice-gateway.manifest';
import { registerSuperAdminGovernanceModule } from '../modules/06-superadmin-governance/superadmin-governance.manifest';
import { registerPublicCommercialModule } from '../modules/07-public-commercial-and-sandbox/public-commercial.manifest';

/**
 * Tokens que deben quedar resueltos tras el ensamblaje.
 * Se declaran por NOMBRE y no por referencia para que el diagnostico pueda listar exactamente cual
 * falta en lugar de detenerse en el primero que no responde.
 */
export const REQUIRED_DI_TOKENS: readonly string[] = Object.freeze([
  'EnvironmentConfig',
  'LoggerPort',
  'RlsDatabasePool',
  'RedisClusterClient',
  'RateLimiter',
  'DomainEventBus',
  'IdentityAuthPort',
  'ApiKeyValidationPort',
  'BillingDeductionPort',
  'VoiceRealtimeProvider',
  'VoiceGatewayControlPort',
  'AuditLoggerPort',
  'RagMapQueryPort',
  'VisualTrainerPort',
  'SuperAdminGovernancePort',
  'SdkHandshakePort',
  'HttpRouterRegistry',
  'WsRouteRegistry',
]);

/** Opciones del ensamblaje del monolito. */
export interface BootstrapOptions {
  /** Contenedor existente a reutilizar; se construye uno nuevo cuando no se inyecta. */
  readonly container?: DependencyContainer;
  /** Cliente Redis a reutilizar en pruebas; se construye desde el entorno cuando no se inyecta. */
  readonly redisClient?: RedisClusterClient;
  /** Pool de PostgreSQL a reutilizar en pruebas. */
  readonly databasePool?: RlsDatabasePool;
  /** Rol del Node Pool que ejecuta este proceso, incluido en cada evento emitido. */
  readonly nodePoolRole?: string;
  /** Configuracion publica del modulo comercial, inyectada por el entrypoint. */
  readonly publicCommercialOptions?: {
    readonly turnstileSecretKey?: string;
    readonly isProduction?: boolean;
    readonly websocketBaseUrl?: string;
  };
}

/** Sistema ensamblado, listo para que un entrypoint lo ponga a escuchar. */
export interface BootstrappedSystem {
  /** Contenedor con los 18 tokens resueltos. */
  readonly container: DependencyContainer;
  /** Registro de rutas HTTP declaradas por los manifiestos. */
  readonly httpRouter: HttpRouterRegistryImpl;
  /** Registro de canales WebSocket declarados por los manifiestos. */
  readonly wsRegistry: WsRouteRegistryImpl;
  /** Pool de PostgreSQL con contexto RLS. */
  readonly databasePool: RlsDatabasePool;
  /** Cliente unico de Redis. */
  readonly redisClient: RedisClusterClient;
  /** Limitador de cuota con el script Lua ya cargado. */
  readonly rateLimiter: TokenBucketRateLimiter;
  /** Bus de eventos local y global. */
  readonly eventBus: DomainEventBus;
  /** Adaptador de control del gateway de voz, para registrar y cortar sesiones vivas. */
  readonly voiceGatewayControl: VoiceGatewayControlAdapter;
  /** Adaptador del mapa funcional, usado por el gateway de voz para el Context Slimming. */
  readonly ragPort: VisualRagAndPromptPortAdapter;
  /** Verificador unificado de sesiones con soporte de revocacion y fallback a PostgreSQL (C1-35). */
  readonly authVerifier: UnifiedSessionTokenVerifier;
  /** Contrato de entorno validado vigente. */
  readonly environment: AppEnvironment;
  /** Marcas temporales de cada fase del arranque, para el diagnostico de latencia. */
  readonly assemblyTimingsMs: Readonly<Record<string, number>>;
}

/**
 * Instancia la infraestructura compartida y ejecuta los siete manifiestos en orden determinista.
 *
 * El orden NO es decorativo: el modulo de cobros se registra antes que el gateway de voz para que el
 * diagnostico de arranque detecte de inmediato una cadena de cobros incompleta, y el de gobierno
 * despues de ambos porque consume sus puertos al construir sus casos de uso.
 *
 * @param options - Contenedor, infraestructura y configuracion publica opcionales.
 * @returns Sistema ensamblado y verificado.
 * @throws Error cuando falta algun token obligatorio tras ejecutar los manifiestos.
 */
export function bootstrapBackendSystem(options: BootstrapOptions = {}): BootstrappedSystem {
  const assemblyTimingsMs: Record<string, number> = {};
  const startedAtMs = Date.now();

  const environment = getEnvConfig();
  const container = options.container ?? new DependencyContainer();
  const { httpRouter, wsRegistry } = createRouterRegistries();

  // 1. Infraestructura compartida: una sola instancia por proceso. Duplicar el pool o el cliente de
  // Redis multiplicaria las conexiones y romperia la coherencia del estado de sesion.
  const databasePool =
    options.databasePool ??
    new RlsDatabasePool({
      connectionString: environment.DATABASE_URL,
      maxConnections: environment.DATABASE_POOL_MAX,
      statementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
    });
  const redisClient = options.redisClient ?? createRedisClientFromEnvironment(environment);
  const rateLimiter = new TokenBucketRateLimiter(redisClient);
  const eventBus = new DomainEventBus({
    redisClient,
    emittedByPool: options.nodePoolRole ?? environment.NODE_POOL_ROLE,
  });

  container.registerInstance(DI_TOKENS.EnvironmentConfig, environment);
  container.registerInstance(DI_TOKENS.RlsDatabasePool, databasePool);
  container.registerInstance(DI_TOKENS.RedisClusterClient, redisClient);
  container.registerInstance(DI_TOKENS.RateLimiter, rateLimiter);
  container.registerInstance(DI_TOKENS.DomainEventBus, eventBus);
  container.registerInstance(DI_TOKENS.HttpRouterRegistry, httpRouter);
  container.registerInstance(DI_TOKENS.WsRouteRegistry, wsRegistry);
  // El logger se registra como marcador de posicion: el entrypoint lo sustituye por el logger
  // estructurado real cuando conoce el nombre del pool que ejecuta el proceso.
  container.registerInstance(DI_TOKENS.LoggerPort, buildPlaceholderLogger(options.nodePoolRole ?? environment.NODE_POOL_ROLE));

  // Verificador unificado de sesiones (C1-35): registrado antes de los manifiestos para gobernar
  // la verificacion con soporte de revocacion y fallback a PostgreSQL bajo RLS.
  const authVerifier = new UnifiedSessionTokenVerifier(databasePool, redisClient);
  container.registerInstance(DI_TOKENS.IdentityAuthPort, authVerifier);

  assemblyTimingsMs['infrastructure'] = Date.now() - startedAtMs;

  // 2. Manifiestos de modulo, en orden determinista y con la firma EXACTA de cada uno. Tres reciben
  // el registro de canales, el de voz recibe el bus de eventos y el de gobierno HTTP sus propias
  // dependencias: el plan maestro sugiere una firma uniforme que no coincide con la realidad.
  const afterIdentityMs = Date.now();
  registerIdentityModule(container, httpRouter, wsRegistry);
  registerAuthEssentialRoutes(container, httpRouter);
  assemblyTimingsMs['01-identity-and-rbac'] = Date.now() - afterIdentityMs;

  const afterProjectsMs = Date.now();
  registerProjectsKeysModule(container, httpRouter, wsRegistry);
  assemblyTimingsMs['02-projects-and-keys'] = Date.now() - afterProjectsMs;

  const afterRagMs = Date.now();
  registerVisualTrainerRagModule(container, httpRouter);
  assemblyTimingsMs['03-visual-trainer-and-rag'] = Date.now() - afterRagMs;

  const afterBillingMs = Date.now();
  registerBillingWhopModule(container, httpRouter);
  assemblyTimingsMs['04-billing-and-whop'] = Date.now() - afterBillingMs;

  const afterVoiceMs = Date.now();
  const voiceGatewayControl = registerVoiceGatewayModule(container, eventBus);
  // El canal de voz se declara SIEMPRE, incluso en el plano de control: si no se declarara, el SDK
  // completaria el handshake y no tendria a donde conectarse. En el pool de voz, su entrypoint
  // sustituye el manejador por omision por el manejador real del ciclo de vida del socket.
  registerVoiceGatewayWsRoute(wsRegistry);
  assemblyTimingsMs['05-voice-realtime-gateway'] = Date.now() - afterVoiceMs;

  const afterGovernanceMs = Date.now();
  registerSuperAdminGovernanceModule(container, httpRouter);
  assemblyTimingsMs['06-superadmin-governance'] = Date.now() - afterGovernanceMs;

  const afterPublicMs = Date.now();
  registerPublicCommercialModule(
    container,
    httpRouter,
    options.publicCommercialOptions ?? {
      isProduction: environment.NODE_ENV === 'production',
      // Sin URL publica configurada, la demo entrega un destino de ejemplo; con ella, el socket de
      // la demostracion apunta al gateway de voz real del despliegue (ws:// o wss://).
      ...(environment.PUBLIC_VOICE_WS_URL === undefined ? {} : { websocketBaseUrl: environment.PUBLIC_VOICE_WS_URL }),
    }
  );
  assemblyTimingsMs['07-public-commercial-and-sandbox'] = Date.now() - afterPublicMs;

  // 3. Verificacion de la cadena completa ANTES de aceptar trafico.
  verifyRequiredTokens(container);
  assemblyTimingsMs['total'] = Date.now() - startedAtMs;

  return {
    container,
    httpRouter,
    wsRegistry,
    databasePool,
    redisClient,
    rateLimiter,
    eventBus,
    voiceGatewayControl,
    ragPort: container.get(DI_TOKENS.RagMapQueryPort) as VisualRagAndPromptPortAdapter,
    authVerifier,
    environment,
    assemblyTimingsMs: Object.freeze(assemblyTimingsMs),
  };
}

/**
 * Comprueba que todos los tokens obligatorios tengan implementacion registrada.
 *
 * @param container - Contenedor ya poblado por los manifiestos.
 * @throws Error cuando falta al menos un token, listando TODOS los ausentes.
 */
export function verifyRequiredTokens(container: DependencyContainer): void {
  const missingTokens = REQUIRED_DI_TOKENS.filter((tokenName) => {
    const token = (DI_TOKENS as unknown as Record<string, unknown>)[tokenName];
    return token === undefined || !container.has(token as never);
  });

  if (missingTokens.length > 0) {
    const registered = container.listRegisteredTokens().join(', ');
    throw new Error(
      `ENSAMBLAJE_INCOMPLETO: faltan ${missingTokens.length} token(s) obligatorio(s): ${missingTokens.join(', ')}. ` +
        `Tokens registrados actualmente: ${registered.length > 0 ? registered : '(ninguno)'}. ` +
        `Verifique que los siete manifiestos de modulo se ejecutaron y en el orden declarado.`
    );
  }
}

/**
 * Describe el ensamblaje para la bitacora de arranque.
 *
 * @param system - Sistema ensamblado.
 * @returns Resumen legible con rutas, canales, tokens y tiempos de cada fase.
 */
export function describeAssembly(system: BootstrappedSystem): string {
  const routesByModule = system.httpRouter.countByOwnerModule();
  const moduleLines = Object.entries(routesByModule)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleName, routeCount]) => `    ${moduleName}: ${routeCount} ruta(s)`)
    .join('\n');

  const timingLines = Object.entries(system.assemblyTimingsMs)
    .map(([phaseName, elapsedMs]) => `    ${phaseName}: ${elapsedMs} ms`)
    .join('\n');

  return [
    `Ensamblaje del monolito completado en ${system.assemblyTimingsMs['total'] ?? 0} ms.`,
    `  Rutas HTTP: ${system.httpRouter.count()}`,
    moduleLines,
    `  Canales WebSocket: ${system.wsRegistry.count()}`,
    `  Tokens registrados: ${system.container.listRegisteredTokens().length}`,
    '  Tiempos por fase:',
    timingLines,
  ].join('\n');
}

/**
 * Construye el cliente unico de Redis a partir del contrato de entorno.
 *
 * @param environment - Contrato de entorno validado.
 * @returns Cliente de Redis configurado.
 */
function createRedisClientFromEnvironment(environment: AppEnvironment): RedisClusterClient {
  return new RedisClusterClient({
    clusterUrls: environment.REDIS_CLUSTER_URLS,
    keyPrefix: environment.REDIS_KEY_PREFIX,
    connectTimeoutMs: environment.REDIS_CONNECT_TIMEOUT_MS,
  });
}

/**
 * Construye un logger de arranque minimo con la interfaz del puerto.
 * El entrypoint lo sustituye por el logger estructurado definitivo una vez conoce su rol de pool.
 *
 * @param nodePoolRole - Rol del Node Pool que ejecuta el proceso.
 * @returns Logger que escribe en la salida estandar.
 */
function buildPlaceholderLogger(nodePoolRole: string): {
  readonly debug: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly child: (bindings: Readonly<Record<string, unknown>>) => unknown;
} {
  const emit = (level: string, message: string, metadata?: Readonly<Record<string, unknown>>): void => {
    const payload = metadata === undefined ? '' : ` ${JSON.stringify(metadata)}`;
    process.stdout.write(`{"level":"${level}","pool":"${nodePoolRole}","message":${JSON.stringify(message)}}${payload}\n`);
  };

  return {
    debug: (message, metadata) => emit('debug', message, metadata),
    info: (message, metadata) => emit('info', message, metadata),
    warn: (message, metadata) => emit('warn', message, metadata),
    error: (message, metadata) => emit('error', message, metadata),
    child: () => buildPlaceholderLogger(nodePoolRole),
  };
}


