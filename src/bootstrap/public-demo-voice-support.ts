/**
 * @archivo src/bootstrap/public-demo-voice-support.ts
 * @modulo Bootstrap (Integracion de la Demostracion Publica con el Pool de Voz)
 * @proposito
 *   Cierra la costura documentada `OBSERVACION_BACKEND_DEMO_WS`: el borde que atiende el socket de
 *   voz no tenia forma de autorizar las sesiones efimeras de la demostracion publica porque el
 *   token emitido por el Modulo 07 (`oa:demo:token:*`) no era consumido por nadie y el handshake
 *   exigia la identidad completa del SDK (nonce + proyecto + organizacion + sesion persistida).
 *   Este soporte aporta tres piezas aisladas del camino normal —un puerto de handshake que consume
 *   el token demo, un puerto RAG con prompt generico de 90 segundos sin elementos accionables y un
 *   servicio de facturacion anulado— mas la puerta que valida la apertura antes de conectar el
 *   motor. El camino SDK normal no cambia en absoluto: conserva sus puertos reales.
 *
 * @resumen_contenido
 *   - Constantes `PUBLIC_DEMO_*`: identidad sintetica, prompt generico y aviso de tiempo agotado.
 *   - Interfaces `PublicDemoOpening` y `PublicDemoVoiceIntegration`.
 *   - Funcion `createPublicDemoVoiceIntegration()`: puertos demo y puerta de validacion.
 *   - Funciones `resolvePublicDemoOpening()`, `createPublicDemoHandshakePort()` y
 *     `createPublicDemoRagPort()`.
 *   - Clase `PublicDemoMeteringService`: facturacion anulada para sesiones anonimas.
 *
 * @dependencias_internas
 *   - `readPublicDemoSessionById()` y `readPublicDemoToken()`
 *     (`../modules/07-public-commercial-and-sandbox/infrastructure/public-demo-session.reader`).
 *   - `VoiceSessionMeteringService` y contratos (`../modules/05-voice-realtime-gateway/application/*`).
 *   - Puertos del nucleo (`../shared/ports/core-modules.ports`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:demo:token:<token>` (Consumo atomico `GETDEL` al abrir el socket) y
 *     `oa:demo:session:<id>` (Lectura no destructiva de validacion en la puerta).
 *   - PostgreSQL: ninguna (la demostracion no factura, ni persiste sesiones, ni opera interfaces).
 */

import type { RedisClusterClient } from '../shared/infrastructure/redis/redis-cluster.client';
import type {
  ActiveMapMetadata,
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

/** Limites de saneamiento de la duracion declarada por el descriptor. */
const DEMO_MIN_MAX_SECONDS = 15;
const DEMO_MAX_MAX_SECONDS = 120;

/** Prefijo de sesion valido: los identificadores de demostracion siempre nacen con el. */
const DEMO_SESSION_ID_PREFIX = 'demo_';

/**
 * Prompt generico de la demostracion publica.
 * Deliberadamente sin mapa funcional: la visita anonima no tiene proyecto real, de modo que el
 * asistente conversa, descubre el objetivo del visitante y cierra invitando a crear una cuenta, sin
 * intentar operar una interfaz que no existe.
 */
const PUBLIC_DEMO_SYSTEM_PROMPT = [
  'Eres el asistente de voz de Onboarding Assistant en una demostración pública de 90 segundos.',
  'Habla en español neutro, con calidez y frases breves: máximo dos oraciones por turno.',
  'Preséntate, pregunta el nombre de quien te habla y descubre qué quiere lograr con un asistente',
  'que guía a los usuarios dentro de su producto, opera la interfaz por ellos y reduce el soporte.',
  'No intentes ejecutar acciones sobre ninguna pantalla: esta demostración no tiene interfaz conectada.',
  'Si te piden operar algo, explica amablemente que la demostración en vivo es de conversación y que',
  'la operación de interfaz se activa al crear una cuenta. Cierra invitando a registrarse.',
].join(' ');

/** Metadatos simbolicos del mapa de la demostracion: no carga mapas reales ni persiste nada. */
const PUBLIC_DEMO_MAP_METADATA: ActiveMapMetadata = {
  functionalMapId: 'public-demo-functional-map',
  versionNumber: 1,
  canonicalSha256: 'checksum-simbolico-de-demostracion-publica',
  routes: ['/'],
  totalElementsCount: 0,
  publishedAtIso: '2026-01-01T00:00:00.000Z',
};

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
  const demoPorts: VoiceWebSocketPorts = {
    ...basePorts,
    // El orquestador, el pool y el despachador de herramientas se reutilizan tal cual: el despacho
    // real degrada en falso educado porque el mapa de la demo no declara elementos accionables.
    handshakePort: createPublicDemoHandshakePort(system.redisClient),
    ragPort: createPublicDemoRagPort(),
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
  };
}

/** Sanea la duracion declarada por el descriptor al rango publico permitido. */
function sanitizeMaxDurationSeconds(declaredSeconds: number): number {
  if (!Number.isFinite(declaredSeconds) || declaredSeconds <= 0) {
    return DEMO_DEFAULT_MAX_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(declaredSeconds), DEMO_MIN_MAX_SECONDS), DEMO_MAX_MAX_SECONDS);
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
 * Puerto RAG del camino demo: prompt generico, sin pasos de onboarding y sin elementos accionables.
 * La validacion de acciones siempre falla en falso: si el motor propone una herramienta, el
 * despachador real la rechaza en la barrera de guardarrailes sin tocar la base de datos.
 *
 * @returns Puerto RAG con la firma de la interfaz del nucleo.
 */
export function createPublicDemoRagPort(): IVisualRagAndPromptPort {
  return {
    async getActiveProjectPromptAndMapMeta() {
      return {
        ok: true as const,
        systemPrompt: PUBLIC_DEMO_SYSTEM_PROMPT,
        promptVersionNumber: 1,
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
          stepInstruction: 'Demostración pública: conversa, descubre el objetivo del visitante y cierra invitando a crear una cuenta.',
          allowedActions: [],
        },
      };
    },
    async validateElementActionGuardrail() {
      return {
        ok: false as const,
        code: 'MAP_NOT_PUBLISHED' as const,
        reason: 'La demostración pública no incluye acciones sobre interfaces.',
        retryable: false,
      };
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
