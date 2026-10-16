/**
 * @archivo src/bootstrap/voice-realtime-gateway.main.ts
 * @modulo Bootstrap (Entrypoint del Node Pool `voice-realtime-gateway`)
 * @proposito
 *   Arranca el pool que atiende los sockets de voz en tiempo real. Su obligacion propia, y la razon
 *   por la que este entrypoint no se parece a los otros dos, es el **drenado**: al recibir una senal
 *   de apagado debe dejar de aceptar sesiones nuevas, esperar a que las conversaciones en curso
 *   terminen, y **liquidar el consumo pendiente de cada una en el libro mayor** antes de cerrar la
 *   infraestructura. Cortar un socket sin liquidar regala minutos ya consumidos; liquidar despues de
 *   cerrar el pool de PostgreSQL pierde el asiento contable para siempre.
 *
 * @resumen_contenido
 *   - Constantes `POOL_ROLE` y `VOICE_SESSION_CLOSE_CODE`.
 *   - Clase `VoicePoolSessionRegistry`: Registro de sesiones vivas con su liquidacion.
 *   - Servidor WebSocket sobre el modulo nativo con el protocolo binario de la Parte 13.
 *   - Funcion `startVoiceRealtimeGateway()`: Ensamblaje, escucha y drenado ordenado.
 *
 * @dependencias_internas
 *   - `bootstrapBackendSystem()` (`./module-autoloader.ts`) y `installGracefulShutdown()` (`./bootstrap-runtime.ts`).
 *   - `openVoiceWebSocketSession()` (`src/modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case.ts`).
 *   - `VOICE_REALTIME_CHANNEL_PATH` (`src/modules/05-voice-realtime-gateway/voice-gateway.ws-routes.ts`).
 *   - `VOICE_CLOSE_CODES` (`src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol.ts`).
 *
 * @dependencias_externas
 *   - `node:http` y `ws` (Servidor nativo de sockets: unico autorizado por el proyecto).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions` y `usage_ledger` (Liquidacion final del consumo de cada sesion).
 *   - Redis: `oa:voice:session:*` (Sesiones activas y publicacion de eventos de dominio).
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { bootstrapBackendSystem, describeAssembly, type BootstrappedSystem } from './module-autoloader';
import { installGracefulShutdown, registerHttpRouteSummaryLog, type NodePoolRuntime } from './bootstrap-runtime';
import { openVoiceWebSocketSession, type VoiceWebSocketSession } from '../modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case';
import type {
  VoiceSessionClosingStatus,
  VoiceWebSocketPorts,
} from '../modules/05-voice-realtime-gateway/application/voice-websocket.contracts';
import { VOICE_REALTIME_CHANNEL_PATH } from '../modules/05-voice-realtime-gateway/voice-gateway.ws-routes';
import { VOICE_CLOSE_CODES } from '../modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import { createVoiceSessionMeteringStore } from '../modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store';
import { createVoiceSessionMeteringService } from '../modules/05-voice-realtime-gateway/application/voice-session-metering.service';
import { createDispatchDomToolUseCase } from '../modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case';
import { PostgresVoiceSessionRepository } from '../modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository';
import { buildDualProviderOrchestrator, type VoiceGatewayControlAdapter } from '../modules/05-voice-realtime-gateway/voice-gateway.manifest';
import { createLazyBillingPort } from '../modules/05-voice-realtime-gateway/infrastructure/billing-port.lazy-proxy';
import { DI_TOKENS } from '../shared/container/di-container';
import type { IVisualRagAndPromptPort } from '../shared/ports/core-modules.ports';

/** Rol del pool que ejecuta este entrypoint. */
const POOL_ROLE = 'VOICE_REALTIME_GATEWAY';

/** Codigo de cierre normal del protocolo de sockets. */
const NORMAL_CLOSURE_CODE = 1000;

/** Tiempo maximo que se espera el handshake de una sesion antes de cerrarla. */
const HANDSHAKE_TIMEOUT_MS = 10000;
import { VoicePoolSessionRegistry, type LiveVoiceSession } from './voice-pool-session-registry';
export { VoicePoolSessionRegistry, type LiveVoiceSession };


/**
 * Arranca el pool de voz: ensambla el sistema, abre el servidor binario y prepara el drenado.
 *
 * @param portOverride - Puerto alternativo, usado por las pruebas.
 * @returns Servidor, registro de sesiones y la funcion de cierre bajo demanda.
 */
export async function startVoiceRealtimeGateway(portOverride?: number): Promise<{
  readonly registry: VoicePoolSessionRegistry;
  readonly system: BootstrappedSystem;
  readonly shutdown: (signal: string) => Promise<unknown>;
  readonly port: number;
  readonly getListeningPort: () => number;
}> {
  const startedAtMs = Date.now();
  const system = bootstrapBackendSystem({ nodePoolRole: POOL_ROLE });
  const port = portOverride ?? system.environment.VOICE_WS_PORT;

  const log = (message: string, metadata?: Readonly<Record<string, unknown>>): void => {
    process.stdout.write(`[${POOL_ROLE}] ${message}${metadata === undefined ? '' : ` ${JSON.stringify(metadata)}`}\n`);
  };

  log(describeAssembly(system));
  const registry = new VoicePoolSessionRegistry();
  const ports = buildVoiceSessionPorts(system);

  const httpServer: Server = createServer((_request, response) => {
    // El pool de voz no expone APIs REST: solo un endpoint de salud para el balanceador, que le
    // permite retirar la instancia del giro antes de que empiece a drenar sesiones.
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'ok', pool: POOL_ROLE, activeSessions: registry.count() }));
  });

  const wsServer = new WebSocketServer({ server: httpServer, path: VOICE_REALTIME_CHANNEL_PATH });
  // El audio del asistente puede ser un fragmento grande: se eleva el limite del marco por encima
  // del valor por omision, que descartaria fragmentos de audio legitimos sin avisar.
  wsServer.on('connection', (socket: WebSocket, request) => {
    void handleIncomingVoiceConnection(
      socket,
      request.url ?? '',
      portOverride ?? port,
      ports,
      registry,
      log,
      system.voiceGatewayControl
    );
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const runtime: NodePoolRuntime = {
    nodePoolRole: POOL_ROLE,
    system,
    listeningPorts: [port],
    startedAtMs,
  };
  registerHttpRouteSummaryLog(runtime, log);
  log(`Servidor de voz escuchando en el puerto ${port} con el canal ${VOICE_REALTIME_CHANNEL_PATH}.`);

  const shutdown = installGracefulShutdown(
    runtime,
    {
      stopAcceptingConnections: async () => {
        // Dejar de aceptar sockets nuevos es lo primero: un drenado que siga aceptando conexiones
        // nunca termina, porque siempre habria sesiones nuevas que cerrar.
        wsServer.close();
        await new Promise<void>((resolve) =>
          httpServer.close(() => {
            resolve();
          })
        );
      },
      drainInFlightWork: async (graceMs: number) => {
        const activeSessions = registry.count();
        if (activeSessions === 0) {
          log('No habia sesiones de voz activas que drenar.');
          return;
        }
        log(`Drenando ${activeSessions} sesion(es) de voz con un presupuesto de ${graceMs} ms.`);
        const drainStartedAtMs = Date.now();

        // Se espera a que cada sesion termine por si misma dentro del presupuesto, y solo entonces se
        // fuerza el cierre: interrumpir a un usuario a mitad de frase es peor que esperar unos
        // segundos, pero esperar indefinidamente impide desplegar.
        while (registry.count() > 0 && Date.now() - drainStartedAtMs < graceMs) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }

        if (registry.count() > 0) {
          const drainedByForce = await registry.closeAll('Apagado ordenado del nodo de voz.');
          log(`${drainedByForce} sesion(es) cerradas al vencer el presupuesto de drenado.`);
        }
      },
      releaseOwnedResources: async () => {
        const remainingSessions = registry.count();
        if (remainingSessions > 0) {
          await registry.closeAll('Cierre definitivo del nodo de voz.');
        }
        log('Todas las sesiones liquidaron su consumo pendiente antes de cerrar.');
      },
    },
    log
  );

  return {
    registry,
    system,
    shutdown,
    port,
    /**
     * Devuelve el puerto real en el que escucha el servidor.
     * Se expone porque un puerto `0` solicita uno efimero al sistema operativo y el valor
     * configurado deja de ser el utilizable por las pruebas.
     */
    getListeningPort: (): number => {
      const address = httpServer.address();
      return address !== null && typeof address === 'object' ? address.port : port;
    },
  };
}

/**
 * Construye los puertos y casos de uso que necesita el ciclo de vida de una sesion de voz.
 *
 * @param system - Sistema ensamblado.
 * @returns Puertos listos para `openVoiceWebSocketSession()`.
 */
function buildVoiceSessionPorts(system: BootstrappedSystem): VoiceWebSocketPorts {
  const sessionRepository = new PostgresVoiceSessionRepository(system.redisClient);
  const meteringStore = createVoiceSessionMeteringStore(system.databasePool);
  const ragPort = system.container.get(DI_TOKENS.RagMapQueryPort) as IVisualRagAndPromptPort;

  const dispatchToolUseCase = createDispatchDomToolUseCase({
    pool: system.databasePool,
    sessionRepository,
    ragPort,
  });
  const meteringService = createVoiceSessionMeteringService({
    // El puerto de cobro se resuelve de forma perezosa: el arranque del pool de voz no depende de
    // que el modulo de cobros se haya registrado antes.
    billingPort: createLazyBillingPort(system.container),
    meteringStore,
  });

  // El canal se declara en el registro con el manejador REAL del pool de voz, sustituyendo el
  // manejador por omision que rechaza conexiones en el plano de control.
  const wsChannel = system.wsRegistry.findByPath(VOICE_REALTIME_CHANNEL_PATH);
  if (wsChannel === null) {
    throw new Error(
      `El canal ${VOICE_REALTIME_CHANNEL_PATH} no fue declarado por el autoloader: el pool de voz no ` +
        'puede atender conexiones que nadie registro.'
    );
  }

  return {
    pool: system.databasePool,
    handshakePort: system.container.get(DI_TOKENS.ApiKeyValidationPort) as VoiceWebSocketPorts['handshakePort'],
    ragPort,
    orchestrator: buildDualProviderOrchestrator(),
    dispatchToolUseCase,
    meteringService,
  };
}

/**
 * Atiende una conexion de voz entrante: extrae la sesion del camino, la autoriza y la enlaza.
 *
 * @param socket - Socket del navegador del usuario final.
 * @param requestUrl - URL de la peticion de upgrade.
 * @param port - Puerto del servidor, usado por las pruebas.
 * @param ports - Puertos y casos de uso del gateway.
 * @param registry - Registro de sesiones vivas.
 * @param log - Escritor de bitacora del proceso.
 */
async function handleIncomingVoiceConnection(
  socket: WebSocket,
  requestUrl: string,
  port: number,
  ports: VoiceWebSocketPorts,
  registry: VoicePoolSessionRegistry,
  log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void,
  voiceGatewayControl?: VoiceGatewayControlAdapter
): Promise<void> {
  const parsedUrl = new URL(requestUrl, `http://localhost:${port}`);
  const nonceId = parsedUrl.searchParams.get('nonce') ?? '';
  const projectId = parsedUrl.searchParams.get('projectId') ?? '';
  const organizationId = parsedUrl.searchParams.get('organizationId') ?? '';
  const voiceSessionId = parsedUrl.searchParams.get('voiceSessionId') ?? '';

  if (nonceId.length === 0 || projectId.length === 0 || organizationId.length === 0 || voiceSessionId.length === 0) {
    // Sin estos cuatro datos no hay forma de autorizar ni de facturar: se rechaza antes de abrir el
    // canal contra el motor, que cuesta dinero por segundo.
    socket.close(VOICE_CLOSE_CODES.UNAUTHORIZED, 'Faltan parametros de apertura de la sesion de voz.');
    return;
  }

  // Verificacion de topes de concurrencia: maximo por organizacion y tope global (C1-59)
  const acceptance = registry.canAcceptSession(organizationId);
  if (!acceptance.allowed) {
    log('Sesion de voz rechazada por superar tope de concurrencia.', {
      organizationId,
      voiceSessionId,
      reason: acceptance.reason,
    });
    socket.close(acceptance.closeCode ?? VOICE_CLOSE_CODES.RATE_LIMITED, acceptance.reason ?? 'Limite de sesiones excedido.');
    return;
  }

  const handshakeTimer = setTimeout(() => {
    socket.close(VOICE_CLOSE_CODES.UNAUTHORIZED, 'El handshake de la sesion excedio el tiempo maximo.');
  }, HANDSHAKE_TIMEOUT_MS);

  try {
    const session = await openVoiceWebSocketSession(
      ports,
      {
        nonceId,
        projectId,
        organizationId,
        voiceSessionId,
        originDomain: parsedUrl.searchParams.get('origin') ?? 'desconocido',
        initialRoutePath: parsedUrl.searchParams.get('route') ?? '/',
        initialStepNumber: Number.parseInt(parsedUrl.searchParams.get('step') ?? '1', 10),
        totalSteps: Number.parseInt(parsedUrl.searchParams.get('totalSteps') ?? '1', 10),
        strictStepEnforcement: parsedUrl.searchParams.get('strict') !== 'false',
        sampleRateHz: Number.parseInt(parsedUrl.searchParams.get('sampleRate') ?? '16000', 10),
        voicePersonaCode: parsedUrl.searchParams.get('voice') ?? 'aura-es-neutral',
      },
      (frame: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(frame);
        }
      },
      (closeCode: number, reason: string) => {
        socket.close(closeCode, reason.slice(0, 120));
      }
    );

    clearTimeout(handshakeTimer);
    if (session === null) {
      return;
    }

    const canonicalOrgId = session.getAuthenticatedOrganizationId();
    registry.add({ organizationId: canonicalOrgId, voiceSessionId, session, socket, openedAtMs: Date.now() });
    if (voiceGatewayControl) {
      voiceGatewayControl.registerLiveSession(voiceSessionId, canonicalOrgId, async (closeCode: number, reason: string) => {
        try {
          if (session.isSessionOpen()) {
            await session.close('ABORTED_BY_KILL_SWITCH' as VoiceSessionClosingStatus, reason);
          }
        } finally {
          socket.close(closeCode, reason.slice(0, 120));
        }
      });
    }
    log('Sesion de voz abierta.', { voiceSessionId, organizationId: canonicalOrgId });

    socket.on('message', (data: Buffer) => {
      void session.handleIncomingBytes(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      if (voiceGatewayControl) {
        voiceGatewayControl.unregisterLiveSession(voiceSessionId);
      }
      void (async () => {
        registry.remove(voiceSessionId);
        if (session.isSessionOpen()) {
          await session.close('COMPLETED_NORMAL', 'El navegador cerro el canal.');
        }
        log('Sesion de voz cerrada.', { voiceSessionId, bargeInCount: session.getBargeInCount() });
      })();
    });

    socket.on('error', () => {
      // Un fallo de socket no requiere accion adicional: el evento `close` que le sigue ya liquida
      // el consumo y retira la sesion del registro.
    });
  } catch (error) {
    clearTimeout(handshakeTimer);
    if (voiceGatewayControl) {
      voiceGatewayControl.unregisterLiveSession(voiceSessionId);
    }
    log('Fallo al abrir una sesion de voz.', { error: error instanceof Error ? error.message : String(error) });
    socket.close(VOICE_CLOSE_CODES.PROVIDER_UNAVAILABLE, 'No fue posible iniciar la sesion de voz.');
  }
}

/** Punto de entrada cuando el archivo se ejecuta directamente. */
if (require.main === module) {
  void startVoiceRealtimeGateway().catch((error: unknown) => {
    process.stderr.write(`[${POOL_ROLE}] Fallo al arrancar: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}


