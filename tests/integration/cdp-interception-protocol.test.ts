/**
 * @archivo tests/integration/cdp-interception-protocol.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba del Camino Real de Intercepcion)
 * @proposito
 *   Ejercita la conexion real con el Protocolo de Herramientas de Desarrollo contra un navegador
 *   simulado, para comprobar que el escudo Anti-SSRF **llega a decidir** sobre las peticiones y que
 *   la respuesta viaja al navegador con el nombre de campo correcto.
 *
 *   Esta prueba existe por un motivo concreto y documentado: la suite anterior del escudo entregaba
 *   la peticion **directamente** al decisor, fabricando un evento con un campo llamado
 *   `interceptionId` que **el navegador nunca emite**. El campo real es `requestId`. Consecuencia
 *   medida: en produccion la guarda abortaba siempre, el decisor no se invocaba ni una vez, el
 *   navegador respondia «parametros invalidos» y **todas las salidas de red quedaban sin validar**
 *   —incluido el acceso a los metadatos del proveedor de nube— mientras 118 aserciones certificaban
 *   que el escudo funcionaba.
 *
 *   La leccion que esta prueba codifica: **un doble nunca debe fabricar el evento que la produccion
 *   va a recibir.** Aqui el evento lo emite un servidor de sockets real, con la forma exacta que
 *   emite el navegador, y se comprueba la respuesta que produce el codigo de produccion.
 *
 * @resumen_contenido
 *   - Constante `PROTOCOL_TEST_TIMEOUT_MS` y utilidades de asercion.
 *   - Clase `FakeBrowserSocket`: Navegador simulado que emite eventos y captura respuestas.
 *   - Funcion `verifyShieldDecides()`: El decisor del escudo se invoca con la peticion real.
 *   - Funcion `verifyAllowedRequestContinues()`: Peticion permitida → `Fetch.continueRequest`.
 *   - Funcion `verifyBlockedRequestIsAborted()`: Peticion bloqueada → `Fetch.failRequest`.
 *   - Funcion `verifyMissingRequestIdIsIgnored()`: Evento sin identificador → sin respuesta.
 *
 * @dependencias_internas
 *   - `CdpWebSocketConnection` (`src/modules/03-visual-trainer-and-rag/infrastructure/cdp-websocket-connection.ts`).
 *   - `CdpInterceptedRequest` y `CdpInterceptionDecision` (`./cdp-transport.port.ts`).
 *
 * @dependencias_externas
 *   - `node:http` y `ws` (Servidor de sockets real, el mismo que usa el pool de voz).
 *   - `node:assert` (Aserciones nativas).
 *
 * @tablas_bd_o_redis
 *   - Ninguna. La prueba se ejecuta integramente en memoria y no toca la base de datos ni la cache.
 */

import * as assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpWebSocketConnection } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-websocket-connection';
import type { CdpInterceptedRequest, CdpInterceptionDecision } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-transport.port';

/** Presupuesto total de la prueba, para que un bloqueo se reporte como fallo y no como cuelgue. */
const PROTOCOL_TEST_TIMEOUT_MS = 20000;

/** Tiempo que se concede a cada respuesta del cliente antes de considerarla ausente. */
const RESPONSE_WAIT_MS = 3000;

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** Comando recibido del cliente, con su nombre y sus parametros. */
interface ReceivedCommand {
  /** Nombre del metodo del protocolo, por ejemplo `Fetch.continueRequest`. */
  readonly method: string;
  /** Parametros enviados con el comando. */
  readonly params: Record<string, unknown>;
}

/**
 * Navegador simulado que habla el protocolo por un socket real.
 *
 * Emite eventos con la **forma exacta** que emite el navegador y captura los comandos que el codigo
 * de produccion le devuelve, que es lo unico que permite comprobar el nombre de los campos.
 */
class FakeBrowserSocket {
  private readonly httpServer: Server;
  private readonly wsServer: WebSocketServer;
  private clientSocket: WebSocket | undefined;
  private listeningPort = 0;

  /** Comandos recibidos del cliente, en orden de llegada. */
  public readonly receivedCommands: ReceivedCommand[] = [];

  /** Indica si el cliente ya envio la habilitacion de la intercepcion. */
  public interceptionEnabled = false;

  public constructor() {
    this.httpServer = createServer();
    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on('connection', (socket: WebSocket) => {
      this.clientSocket = socket;
      socket.on('message', (data: Buffer) => {
        const parsed = JSON.parse(data.toString('utf8')) as {
          readonly id?: number;
          readonly method?: string;
          readonly params?: Record<string, unknown>;
        };
        if (typeof parsed.method === 'string') {
          this.receivedCommands.push({ method: parsed.method, params: parsed.params ?? {} });
          if (parsed.method === 'Fetch.enable') {
            this.interceptionEnabled = true;
          }
        }
        // Todo comando debe recibir respuesta: sin ella, el cliente agota su tiempo de espera y el
        // codigo de produccion no puede continuar, que es justo el sintoma que producia el defecto.
        if (typeof parsed.id === 'number') {
          socket.send(JSON.stringify({ id: parsed.id, result: {} }));
        }
      });
    });
  }

  /**
   * Abre el servidor en un puerto efimero.
   *
   * @returns URL del socket de depuracion al que debe conectarse el cliente.
   */
  public async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => {
        const address = this.httpServer.address();
        this.listeningPort = address !== null && typeof address === 'object' ? address.port : 0;
        resolve();
      });
    });
    return `ws://127.0.0.1:${this.listeningPort}`;
  }

  /**
   * Emite un evento con la forma exacta del navegador.
   *
   * @param method - Nombre del evento, por ejemplo `Fetch.requestPaused`.
   * @param params - Parametros del evento.
   */
  public emitEvent(method: string, params: Record<string, unknown>): void {
    this.clientSocket?.send(JSON.stringify({ method, params }));
  }

  /**
   * Espera a que llegue un comando concreto.
   *
   * @param method - Nombre del metodo esperado.
   * @param timeoutMs - Tiempo maximo de espera.
   * @returns Comando recibido, o `null` cuando no llego a tiempo.
   */
  public async waitForCommand(method: string, timeoutMs: number = RESPONSE_WAIT_MS): Promise<ReceivedCommand | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.receivedCommands.find((command) => command.method === method);
      if (found !== undefined) {
        return found;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  /** Cierra el servidor y libera el puerto. */
  public async stop(): Promise<void> {
    this.clientSocket?.close();
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}

/**
 * Construye el evento de peticion pausada con la forma EXACTA del navegador.
 *
 * @param requestId - Identificador de la peticion, tal como lo emite el navegador.
 * @param url - Direccion solicitada.
 * @returns Parametros del evento.
 */
function buildRequestPausedEvent(requestId: string, url: string): Record<string, unknown> {
  return {
    requestId,
    request: { url, method: 'GET', headers: {} },
    frameId: 'F1',
    resourceType: 'Document',
  };
}

/** Verifica que el escudo decide sobre una peticion emitida por el navegador simulado. */
async function verifyShieldDecides(): Promise<void> {
  const browser = new FakeBrowserSocket();
  const debuggerUrl = await browser.start();
  const connection = new CdpWebSocketConnection({ connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

  const decisions: CdpInterceptedRequest[] = [];
  try {
    await connection.connect(debuggerUrl);
    await connection.enableRequestInterception(async (request: CdpInterceptedRequest): Promise<CdpInterceptionDecision> => {
      decisions.push(request);
      return { allow: true, reason: 'PERMITIDA_EN_LA_PRUEBA' };
    });

    check(browser.interceptionEnabled, 'La conexion debe habilitar la intercepcion de peticiones al abrirse');
    check(decisions.length === 0, 'El decisor no debe invocarse antes de que el navegador emita un evento');

    browser.emitEvent('Fetch.requestPaused', buildRequestPausedEvent('1000.7', 'https://ejemplo.com/pagina'));
    const continueCommand = await browser.waitForCommand('Fetch.continueRequest');

    // Esta es la asercion central: si el decisor no se invoca, el escudo NO ESTA ARMADO y todas las
    // salidas de red del navegador quedan sin validar.
    check(decisions.length === 1, `El decisor del escudo DEBE invocarse una vez (obtenido: ${decisions.length})`);
    check(decisions[0]?.url === 'https://ejemplo.com/pagina', 'El decisor debe recibir la direccion solicitada');
    check(decisions[0]?.requestId === '1000.7', 'El decisor debe recibir el identificador que emitio el navegador');
    check(continueCommand !== null, 'Una peticion permitida debe responderse con la continuacion');
  } finally {
    await connection.close();
    await browser.stop();
  }
}

/** Verifica que el identificador viaja al navegador con el nombre correcto. */
async function verifyRequestIdFieldName(): Promise<void> {
  const browser = new FakeBrowserSocket();
  const debuggerUrl = await browser.start();
  const connection = new CdpWebSocketConnection({ connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

  try {
    await connection.connect(debuggerUrl);
    await connection.enableRequestInterception(async () => ({ allow: true, reason: 'PERMITIDA' }));

    browser.emitEvent('Fetch.requestPaused', buildRequestPausedEvent('4242.13', 'https://permitido.example/x'));
    const continuation = await browser.waitForCommand('Fetch.continueRequest');

    // El nombre del parametro es lo que distingue una respuesta aceptada de un «parametros
    // invalidos» que cuelga la peticion. Se comprueba de forma explicita.
    check(continuation !== null, 'La continuacion debe llegar al navegador');
    check(
      continuation?.params['requestId'] === '4242.13',
      `La continuacion debe llevar el parametro requestId (obtenido: ${JSON.stringify(continuation?.params)})`
    );
    check(
      continuation?.params['interceptionId'] === undefined,
      'La continuacion NO debe llevar un parametro interceptionId: el navegador no lo reconoce y responde «parametros invalidos»'
    );
  } finally {
    await connection.close();
    await browser.stop();
  }
}

/** Verifica que una peticion bloqueada se aborta con el mismo identificador. */
async function verifyBlockedRequestIsAborted(): Promise<void> {
  const browser = new FakeBrowserSocket();
  const debuggerUrl = await browser.start();
  const connection = new CdpWebSocketConnection({ connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

  try {
    await connection.connect(debuggerUrl);
    await connection.enableRequestInterception(async () => ({ allow: false, reason: 'ESCUDO_SSRF_METADATOS_DE_NUBE' }));

    browser.emitEvent('Fetch.requestPaused', buildRequestPausedEvent('7777.1', 'http://169.254.169.254/latest/meta-data/'));
    const failure = await browser.waitForCommand('Fetch.failRequest');

    check(failure !== null, 'Una peticion que viola el escudo DEBE abortarse');
    check(failure?.params['requestId'] === '7777.1', 'El aborto debe llevar el parametro requestId');
    check(
      typeof failure?.params['errorReason'] === 'string' && (failure.params['errorReason'] as string).length > 0,
      'El aborto debe declarar un motivo de error de red'
    );
    const continuation = browser.receivedCommands.find((command) => command.method === 'Fetch.continueRequest');
    check(continuation === undefined, 'Una peticion bloqueada NO debe continuar hacia la red');
  } finally {
    await connection.close();
    await browser.stop();
  }
}

/** Verifica que un evento sin identificador no provoca ninguna respuesta. */
async function verifyMissingRequestIdIsIgnored(): Promise<void> {
  const browser = new FakeBrowserSocket();
  const debuggerUrl = await browser.start();
  const connection = new CdpWebSocketConnection({ connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

  let decisionCount = 0;
  try {
    await connection.connect(debuggerUrl);
    await connection.enableRequestInterception(async () => {
      decisionCount += 1;
      return { allow: true, reason: 'PERMITIDA' };
    });

    // Evento con el nombre de campo equivocado: es exactamente lo que la version defectuosa leia, y
    // el navegador nunca lo emite. Debe ignorarse sin responder, no provocar un aborto.
    browser.emitEvent('Fetch.requestPaused', { interceptionId: 'nombre-inexistente', request: { url: 'https://x.example/' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    check(decisionCount === 0, 'Un evento sin identificador valido no debe llegar al decisor');
    check(
      browser.receivedCommands.every((command) => !command.method.startsWith('Fetch.continue') && !command.method.startsWith('Fetch.fail')),
      'Un evento sin identificador no debe producir ni continuacion ni aborto'
    );
  } finally {
    await connection.close();
    await browser.stop();
  }
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DEL CAMINO REAL DE INTERCEPCION DEL PROTOCOLO (ESCUDO ANTI-SSRF)');
  console.log('='.repeat(96));

  await verifyShieldDecides();
  console.log('[1/4] El escudo decide sobre una peticion emitida por el navegador simulado: APROBADO.');

  await verifyRequestIdFieldName();
  console.log('[2/4] El identificador viaja al navegador con el nombre de campo correcto: APROBADO.');

  await verifyBlockedRequestIsAborted();
  console.log('[3/4] Una peticion que viola el escudo se aborta y no continua: APROBADO.');

  await verifyMissingRequestIdIsIgnored();
  console.log('[4/4] Un evento sin identificador valido se ignora sin responder: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

const timeoutHandle = setTimeout(() => {
  console.error(`RESULTADO: FALLIDO. La prueba excedio ${PROTOCOL_TEST_TIMEOUT_MS} ms: alguna respuesta nunca llego.`);
  process.exit(1);
}, PROTOCOL_TEST_TIMEOUT_MS);

void main()
  .then(() => {
    clearTimeout(timeoutHandle);
    process.exit(0);
  })
  .catch((error: unknown) => {
    clearTimeout(timeoutHandle);
    console.error('RESULTADO: FALLIDO.');
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });
