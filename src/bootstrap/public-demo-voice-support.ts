/**
 * @archivo src/bootstrap/public-demo-voice-support.ts
 * @modulo Bootstrap (Integracion de la Demostracion Publica con el Pool de Voz)
 * @proposito
 *   Cierra la costura documentada `OBSERVACION_BACKEND_DEMO_WS`: el borde que atiende el socket de
 *   voz no tenia forma de autorizar las sesiones efimeras de la demostracion publica porque el
 *   token emitido por el Modulo 07 (`oa:demo:token:*`) no era consumido por nadie y el handshake
 *   exigia la identidad completa del SDK (nonce + proyecto + organizacion + sesion persistida).
 *   Este soporte aporta las piezas aisladas del camino normal —un puerto de handshake que consume
 *   el token demo, un puerto RAG con el mapa funcional sintetico de la demostracion (los elementos
 *   reales del CRM simulado que el asistente opera: abrir el formulario, capturar el trato,
 *   guardarlo, facturacion y validacion CFDI) y un servicio de facturacion anulado— mas la puerta
 *   que valida la apertura y el despachador demo, que evita toda escritura en PostgreSQL. El camino
 *   SDK normal no cambia en absoluto: conserva sus puertos reales.
 *
 * @resumen_contenido
 *   - Constantes `PUBLIC_DEMO_*`: identidad sintetica y aviso de tiempo agotado.
 *   - Interfaces `PublicDemoOpening` y `PublicDemoVoiceIntegration`.
 *   - Funcion `createPublicDemoVoiceIntegration()`: puertos demo y puerta de validacion.
 *   - Funciones `resolvePublicDemoOpening()`, `createPublicDemoHandshakePort()` y
 *     `createPublicDemoRagPort()`: el mapa funcional operativo vive en
 *     `public-demo-functional-map.ts` y el despacho anulado en `public-demo-tool-dispatch.ts`.
 *   - `normalizeDemoVoiceModel()`: traduce el selector de la landing al motor que elegira el
 *     orquestador (QWEN o GEMINI), para respetar la preferencia del visitante.
 *   - Clase `PublicDemoMeteringService`: facturacion anulada para sesiones anonimas.
 *
 * @dependencias_internas
 *   - `readPublicDemoSessionById()` y `readPublicDemoToken()`
 *     (`../modules/07-public-commercial-and-sandbox/infrastructure/public-demo-session.reader`).
 *   - `VoiceSessionMeteringService` y contratos (`../modules/05-voice-realtime-gateway/application/*`).
 *   - Puertos del nucleo (`../shared/ports/core-modules.ports`).
 *   - Mapa funcional sintetico de la demo (`./public-demo-functional-map`).
 *   - Despachador de herramientas demo (`./public-demo-tool-dispatch`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:demo:token:<token>` (Consumo atomico `GETDEL` al abrir el socket) y
 *     `oa:demo:session:<id>` (Lectura no destructiva de validacion en la puerta).
 *   - PostgreSQL: ninguna (la demostracion no factura ni persiste sesiones, y su despachador de
 *     herramientas escribe sobre un repositorio anulado en memoria).
 */

import type { RedisClusterClient } from '../shared/infrastructure/redis/redis-cluster.client';
import type {
  IApiKeyAndHandshakePort,
  IVisualRagAndPromptPort,
  PortFailure,
} from '../shared/ports/core-modules.ports';
import type { VoiceWebSocketPorts } from '../modules/05-voice-realtime-gateway/application/voice-websocket.contracts';
import {
  VoiceSessionMeteringService,
  type MeteringDependencies,
  type MeteringSessionContext,
  type MeteringTickResult,
} from '../modules/05-voice-realtime-gateway/application/voice-session-metering.service';
import { createVoiceSessionMeteringStore } from '../modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store';
import { createLazyBillingPort } from '../modules/05-voice-realtime-gateway/infrastructure/billing-port.lazy-proxy';
import {
  PUBLIC_DEMO_TOKEN_KEY_PREFIX,
  readPublicDemoSessionById,
  readPublicDemoToken,
  type PublicDemoSessionRecord,
} from '../modules/07-public-commercial-and-sandbox/infrastructure/public-demo-session.reader';
import {
  PUBLIC_DEMO_ALLOWED_ACTIONS,
  PUBLIC_DEMO_MAP_METADATA,
  PUBLIC_DEMO_STEP_INSTRUCTION,
  PUBLIC_DEMO_SYSTEM_PROMPT,
  validatePublicDemoElementAction,
} from './public-demo-functional-map';
import { createPublicDemoToolDispatchUseCase } from './public-demo-tool-dispatch';
import type { BootstrappedSystem } from './module-autoloader';

/** Proyecto sintetico con el que se abren las sesiones de la demostracion publica. */
export const PUBLIC_DEMO_PROJECT_ID = 'public-demo';

/**
 * Organizacion sintetica de la demostracion publica.
 * No existe en PostgreSQL a proposito: solo agrupa a las visitas anonimas para los topes de
 * concurrencia del pool, sin que ninguna suscripcion real pueda recibir un debito por su causa.
 */
export const PUBLIC_DEMO_ORGANIZATION_ID = 'public-demo';

/** Aviso de cierre que el navegador recibe cuando la demostracion agota su duracion maxima. */
export const PUBLIC_DEMO_TIMEUP_MESSAGE =
  'La demostración pública llegó a su duración máxima. Crea tu cuenta para seguir conversando sin límite.';

/** Duracion por omision de la demostracion cuando el descriptor no la declara. */
const DEMO_DEFAULT_MAX_SECONDS = 90;

/** Limites de saneamiento de la duracion declarada por el descriptor (el tope alto deja gobernar hasta 10 min al SuperAdmin). */
const DEMO_MIN_MAX_SECONDS = 15;
const DEMO_MAX_MAX_SECONDS = 600;

/** Prefijo de sesion valido: los identificadores de demostracion siempre nacen con el. */
const DEMO_SESSION_ID_PREFIX = 'demo_';

/** Datos de apertura resueltos para una sesion de demostracion publica valida. */
export interface PublicDemoOpening {
  /** Proyecto sintetico de la demostracion. */
  readonly projectId: string;
  /** Organizacion sintetica de la demostracion. */
  readonly organizationId: string;
  /** Sesion efimera resuelta desde el descriptor de Redis. */
  readonly voiceSessionId: string;
  /** Duracion maxima saneada, en segundos. */
  readonly maxDurationSeconds: number;
  /** Motor de voz elegido por el visitante en el selector de la landing (QWEN o GEMINI). */
  readonly voiceModel: 'QWEN' | 'GEMINI';
}

/** Integracion completa de la demo publica con el pool de voz: puertos demo y puerta de validacion. */
export interface PublicDemoVoiceIntegration {
  /** Puertos demo-aware: solo se usan cuando `resolveOpening()` aprobo la conexion. */
  readonly ports: VoiceWebSocketPorts;
  /** Valida la URL de apertura y devuelve los datos canonicos, o `null` si no es resoluble. */
  readonly resolveOpening: (parsedUrl: URL) => Promise<PublicDemoOpening | null>;
}

/**
 * Ensambla la integracion de la demostracion publica para el borde de sockets.
 *
 * @param system - Sistema ensamblado (contenedor, pool y Redis).
 * @param basePorts - Puertos reales del pool; los compartidos se reutilizan por referencia.
 * @returns Puertos demo y puerta de validacion de apertura.
 */
export function createPublicDemoVoiceIntegration(
  system: BootstrappedSystem,
  basePorts: VoiceWebSocketPorts
): PublicDemoVoiceIntegration {
  const demoRagPort = createPublicDemoRagPort();
  const demoPorts: VoiceWebSocketPorts = {
    ...basePorts,
    // El orquestador y el pool se reutilizan tal cual; el mapa funcional y el despachador SI se
    // sustituyen: la demo opera unicamente los elementos sinteticos de su CRM y su repositorio
    // anulado jamas escribe en PostgreSQL (visita anonima sin trazabilidad contable).
    handshakePort: createPublicDemoHandshakePort(system.redisClient),
    ragPort: demoRagPort,
    dispatchToolUseCase: createPublicDemoToolDispatchUseCase(system, demoRagPort),
    meteringService: new PublicDemoMeteringService({
      billingPort: createLazyBillingPort(system.container),
      meteringStore: createVoiceSessionMeteringStore(system.databasePool),
    }),
  };
  return {
    ports: demoPorts,
    resolveOpening: async (parsedUrl: URL): Promise<PublicDemoOpening | null> =>
      resolvePublicDemoOpening(system.redisClient, parsedUrl),
  };
}

/**
 * Valida la apertura de una demostracion publica sin consumir todavia el token.
 * La lectura es no destructiva a proposito: el consumo de un solo uso ocurre en el handshake, de
 * modo que una conexion rechazada en esta puerta no quema el token que el visitante aun puede usar.
 * Las dos claves deben apuntarse mutuamente para descartar tokens cruzados o fabricados.
 *
 * @param redisClient - Cliente unico de Redis.
 * @param parsedUrl - URL de apertura del socket.
 * @returns Datos canonicos de apertura, o `null` cuando la demostracion no es resoluble.
 */
export async function resolvePublicDemoOpening(
  redisClient: RedisClusterClient,
  parsedUrl: URL
): Promise<PublicDemoOpening | null> {
  const sessionId = parsedUrl.searchParams.get('sessionId') ?? '';
  const ephemeralToken = parsedUrl.searchParams.get('nonce') ?? '';
  if (!sessionId.startsWith(DEMO_SESSION_ID_PREFIX) || ephemeralToken.length === 0) {
    return null;
  }
  const session = await readPublicDemoSessionById(redisClient, sessionId);
  if (session === null || session.isDemo !== true || session.ephemeralToken !== ephemeralToken) {
    return null;
  }
  const tokenRecord = await readPublicDemoToken(redisClient, ephemeralToken);
  if (tokenRecord === null || tokenRecord.sessionId !== sessionId) {
    return null;
  }
  const expiresAtMs = Date.parse(session.expiresAtIso);
  if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
    return null;
  }
  return {
    projectId: PUBLIC_DEMO_PROJECT_ID,
    organizationId: PUBLIC_DEMO_ORGANIZATION_ID,
    voiceSessionId: sessionId,
    maxDurationSeconds: sanitizeMaxDurationSeconds(session.maxDurationSeconds),
    voiceModel: normalizeDemoVoiceModel(session.voiceModel),
  };
}

/** Sanea la duracion declarada por el descriptor al rango publico permitido. */
function sanitizeMaxDurationSeconds(declaredSeconds: number): number {
  if (!Number.isFinite(declaredSeconds) || declaredSeconds <= 0) {
    return DEMO_DEFAULT_MAX_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(declaredSeconds), DEMO_MIN_MAX_SECONDS), DEMO_MAX_MAX_SECONDS);
}

/** Normaliza el motor elegido: solo `QWEN` activa el alterno; cualquier otro valor usa GEMINI. */
function normalizeDemoVoiceModel(declaredModel: string): 'QWEN' | 'GEMINI' {
  return declaredModel.trim().toUpperCase() === 'QWEN' ? 'QWEN' : 'GEMINI';
}

/** Fallo normalizado de un token de demostracion invalido, caducado o ya consumido. */
function demoTokenFailure(): PortFailure {
  return {
    ok: false,
    code: 'HANDSHAKE_NONCE_INVALID',
    reason: 'No fue posible autorizar la demostración pública.',
    retryable: false,
  };
}

/** Script Lua de consumo atomico: leer el token y borrarlo en una sola operacion de Redis. */
const LUA_ATOMIC_GETDEL = `
  local val = redis.call('GET', KEYS[1])
  if val then
    redis.call('DEL', KEYS[1])
  end
  return val
`;

/**
 * Puerto de handshake del camino demo: consume `oa:demo:token:<token>` con `GETDEL` atomico en
 * lugar del nonce del SDK. Solo se usa en conexiones que la puerta ya aprobo; aun asi revalida la
 * forma del descriptor, porque el consumo es el unico momento en el que el token deja de existir.
 *
 * @param redisClient - Cliente unico de Redis.
 * @returns Puerto de handshake con la firma de la interfaz del nucleo.
 */
export function createPublicDemoHandshakePort(redisClient: RedisClusterClient): IApiKeyAndHandshakePort {
  return {
    async validateSecretKey(): Promise<PortFailure> {
      // El camino demo no valida claves secretas: jamas se presenta una.
      return demoTokenFailure();
    },
    async validateSdkHandshake(): Promise<PortFailure> {
      // El camino demo no completa el handshake del SDK: su unica llave es el token efimero.
      return demoTokenFailure();
    },
    async consumeEphemeralWsNonce(
      nonceId: string
    ): Promise<{ readonly ok: true; readonly externalEndUserId: string | null; readonly organizationId: string } | PortFailure> {
      if (nonceId.length === 0) {
        return demoTokenFailure();
      }
      try {
        const raw = await redisClient.runScript(LUA_ATOMIC_GETDEL, [`${PUBLIC_DEMO_TOKEN_KEY_PREFIX}${nonceId}`], []);
        if (typeof raw !== 'string' || raw.length === 0) {
          return demoTokenFailure();
        }
        const record = JSON.parse(raw) as PublicDemoSessionRecord;
        if (record.isDemo !== true) {
          return demoTokenFailure();
        }
        const expiresAtMs = Date.parse(record.expiresAtIso);
        if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
          return demoTokenFailure();
        }
        return { ok: true, externalEndUserId: null, organizationId: PUBLIC_DEMO_ORGANIZATION_ID };
      } catch {
        return demoTokenFailure();
      }
    },
  };
}

/**
 * Puerto RAG del camino demo: prompt operativo, mapa funcional sintetico y barrera de seguridad.
 * A diferencia del mapa vacio original, la demo SI declara elementos accionables (los del CRM
 * simulado de la landing) y la barrera autoriza exactamente esos elementos con la accion que cada
 * uno admite. El despachador demo que consume este puerto jamas escribe en PostgreSQL.
 *
 * @returns Puerto RAG con la firma de la interfaz del nucleo.
 */
export function createPublicDemoRagPort(): IVisualRagAndPromptPort {
  return {
    async getActiveProjectPromptAndMapMeta() {
      return {
        ok: true as const,
        systemPrompt: PUBLIC_DEMO_SYSTEM_PROMPT,
        promptVersionNumber: 2,
        onboardingStepsJson: [],
        primaryVoiceModel: 'GEMINI',
        fallbackVoiceModel: 'QWEN',
        mapMetadata: PUBLIC_DEMO_MAP_METADATA,
      };
    },
    async getSlimmedRouteContext(_projectId: string, routePath: string, stepNumber: number) {
      return {
        ok: true as const,
        context: {
          routePath,
          stepNumber,
          stepInstruction: PUBLIC_DEMO_STEP_INSTRUCTION,
          allowedActions: PUBLIC_DEMO_ALLOWED_ACTIONS,
        },
      };
    },
    async validateElementActionGuardrail(
      _projectId: string,
      _functionalMapId: string,
      toolName: 'click_element' | 'type_text',
      targetElementKey: string,
      routePath: string
    ) {
      return validatePublicDemoElementAction(toolName, targetElementKey, routePath);
    },
  };
}

/**
 * Servicio de facturacion anulado para la demostracion publica.
 * La visita es anonima: no existe suscripcion que pueda recibir el debito, de modo que cada metodo
 * de cobro se neutraliza y la liquidacion final devuelve un resultado sin movimiento contable. El
 * unico tope economico de la demo es su duracion, que aplica el borde del socket.
 */
export class PublicDemoMeteringService extends VoiceSessionMeteringService {
  /**
   * @param dependencies - Dependencias del servicio base; la demostracion no ejecuta ningun cobro.
   */
  public constructor(dependencies: MeteringDependencies) {
    super(dependencies);
  }

  /** Sin alta contable: no hay minutos que acumular para una organizacion sintetica. */
  public override registerSession(_organizationId: string, _projectId: string, _voiceSessionId: string): void {
    // Intencionadamente vacio.
  }

  /** Sin pulso de cobro: la demostracion publica no se factura. */
  public override startTimer(
    _voiceSessionId: string,
    _contextProvider: () => Promise<MeteringSessionContext | null>,
    _onTerminationRequired: (result: MeteringTickResult) => void
  ): void {
    // Intencionadamente vacio.
  }

  /** Sin temporizador que detener. */
  public override stopTimer(_voiceSessionId: string): void {
    // Intencionadamente vacio.
  }

  /** Liquidacion sin movimiento contable que cierra la sesion en paz. */
  public override async settleAndClose(
    _voiceSessionId: string,
    _context: MeteringSessionContext
  ): Promise<MeteringTickResult> {
    return {
      billedSeconds: 0,
      coveredMinutes: '0.000000',
      overageMinutes: '0.000000',
      overageCostUsd: '0.000000',
      shouldTerminate: false,
      terminationReason: null,
      ledgerEntryId: '',
    };
  }
}
