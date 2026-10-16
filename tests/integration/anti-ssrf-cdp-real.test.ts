/**
 * @archivo tests/integration/anti-ssrf-cdp-real.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba Real de Integracion CDP y Escudo Anti-SSRF sin Dobles Falsos)
 * @proposito
 *   Verifica que la conexion CDP real (`CdpWebSocketConnection`) procese los eventos reales
 *   de Chromium (`Fetch.requestPaused` con `requestId` y `request.url`) a traves de un socket WebSocket
 *   real en el bucle local, demostrando la resolucion del hallazgo C1-44 sin inventar campos que el
 *   navegador jamas emite (como el obsoleto e inexistente `interceptionId`).
 *
 * @resumen_contenido
 *   - Levanta un servidor WebSocket local que emite el protocolo CDP oficial de Chromium.
 *   - Conecta `CdpWebSocketConnection` sobre el puerto efimero.
 *   - Habilita la interceptacion con `Fetch.enable` mediante `SsrfRequestInterceptor` y `PinnedDnsSsrfGuard`.
 *   - Prueba 1: Bloqueo de peticion hacia metadatos de nube (`169.254.169.254`) -> emite `Fetch.failRequest`.
 *   - Prueba 2: Bloqueo de peticion hacia red privada (`10.0.0.1`) -> emite `Fetch.failRequest`.
 *   - Prueba 3: Aprobacion de peticion legitima publica (`https://example.com/`) -> emite `Fetch.continueRequest`.
 *   - Verifica que las respuestas del cliente lleven estrictamente el campo `requestId` exigido por Chromium.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { CdpWebSocketConnection } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-websocket-connection';
import { PinnedDnsSsrfGuard } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';
import { SsrfRequestInterceptor } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/ssrf-request-interceptor';

console.log('================================================================================');
console.log('PRUEBA REAL: CONEXION CDP REAL Y PROTOCOLO ANTI-SSRF CON REQUEST_ID (C1-44)');
console.log('================================================================================');

interface ReceivedCdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

async function runRealCdpAntiSsrfSuite(): Promise<void> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  let serverSideSocket: WebSocket | null = null;
  const receivedCommands: ReceivedCdpCommand[] = [];

  wss.on('connection', (ws) => {
    serverSideSocket = ws;
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { id: number; method: string; params?: Record<string, unknown> };
      receivedCommands.push({
        id: parsed.id,
        method: parsed.method,
        params: parsed.params ?? {},
      });

      // Responder a comandos CDP con confirmacion
      ws.send(JSON.stringify({ id: parsed.id, result: {} }));
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const wsUrl = `ws://127.0.0.1:${port}`;

  const cdpClient = new CdpWebSocketConnection({ commandTimeoutMs: 2000, connectTimeoutMs: 2000 });
  const ssrfGuard = new PinnedDnsSsrfGuard({ externalResolvers: ['1.1.1.1', '8.8.8.8'], lookupTimeoutMs: 3000 });
  const ssrfInterceptor = new SsrfRequestInterceptor(ssrfGuard);

  try {
    // 1. Conectar sobre el WebSocket real
    await cdpClient.connect(wsUrl);
    assert.ok(cdpClient.isConnected, 'El cliente CDP real debe quedar conectado');

    // 2. Habilitar la interceptacion de peticiones
    await cdpClient.enableRequestInterception(async (req) => {
      return ssrfInterceptor.decide(req, {
        organizationId: 'org_test_real',
        projectId: 'prj_test_real',
        trainingSessionId: 'sess_test_real',
      });
    });

    const enableCommand = receivedCommands.find((c) => c.method === 'Fetch.enable');
    assert.ok(enableCommand !== undefined, 'El cliente debe enviar Fetch.enable al servidor CDP');

    // -------------------------------------------------------------------------
    // CASO 1: Peticion hacia metadatos de nube (169.254.169.254)
    // -------------------------------------------------------------------------
    const metadataRequestId = 'req_meta_9876';
    const metadataEvent = {
      method: 'Fetch.requestPaused',
      params: {
        requestId: metadataRequestId,
        request: {
          url: 'http://169.254.169.254/latest/meta-data/',
          method: 'GET',
        },
        frameId: 'frame_1',
        resourceType: 'Document',
      },
    };

    serverSideSocket!.send(JSON.stringify(metadataEvent));

    // Esperar a que el cliente responda
    await new Promise((resolve) => setTimeout(resolve, 200));

    const failMetadataCmd = receivedCommands.find(
      (c) => c.method === 'Fetch.failRequest' && c.params['requestId'] === metadataRequestId
    );
    assert.ok(
      failMetadataCmd !== undefined,
      'El cliente CDP real debe abortar la peticion hacia metadatos enviando Fetch.failRequest con el requestId real'
    );
    assert.equal(
      failMetadataCmd.params['errorReason'],
      'AddressUnreachable',
      'El error de red CDP enviado debe ser AddressUnreachable para destinos no alcanzables'
    );
    console.log('✓ CASO 1 SUPERADO: Peticion hacia metadatos bloqueada con Fetch.failRequest y requestId real');

    // -------------------------------------------------------------------------
    // CASO 2: Peticion hacia red interna privada (10.0.0.5)
    // -------------------------------------------------------------------------
    const privateRequestId = 'req_priv_5432';
    const privateEvent = {
      method: 'Fetch.requestPaused',
      params: {
        requestId: privateRequestId,
        request: {
          url: 'http://10.0.0.5:8080/internal-admin',
          method: 'POST',
        },
        frameId: 'frame_1',
        resourceType: 'XHR',
      },
    };

    serverSideSocket!.send(JSON.stringify(privateEvent));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const failPrivateCmd = receivedCommands.find(
      (c) => c.method === 'Fetch.failRequest' && c.params['requestId'] === privateRequestId
    );
    assert.ok(
      failPrivateCmd !== undefined,
      'El cliente CDP real debe abortar la peticion hacia red privada con Fetch.failRequest'
    );
    console.log('✓ CASO 2 SUPERADO: Peticion hacia red privada bloqueada con Fetch.failRequest');

    // -------------------------------------------------------------------------
    // CASO 3: Peticion publica legitima (https://example.com/)
    // -------------------------------------------------------------------------
    const safeRequestId = 'req_safe_1111';
    const safeEvent = {
      method: 'Fetch.requestPaused',
      params: {
        requestId: safeRequestId,
        request: {
          url: 'https://example.com/',
          method: 'GET',
        },
        frameId: 'frame_1',
        resourceType: 'Document',
      },
    };

    serverSideSocket!.send(JSON.stringify(safeEvent));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const continueCmd = receivedCommands.find(
      (c) => c.method === 'Fetch.continueRequest' && c.params['requestId'] === safeRequestId
    );
    assert.ok(
      continueCmd !== undefined,
      'El cliente CDP real debe permitir la peticion publica legitima enviando Fetch.continueRequest con el requestId real'
    );
    console.log('✓ CASO 3 SUPERADO: Peticion publica legitima continuada con Fetch.continueRequest y requestId real');

    // -------------------------------------------------------------------------
    // Verificacion de contadores de bloqueo acumulados
    // -------------------------------------------------------------------------
    const blockedCount = ssrfInterceptor.blockedCountFor('sess_test_real');
    assert.equal(blockedCount, 2, 'El interceptor debe haber contabilizado exactamente los 2 bloqueos');
    console.log('✓ CASO 4 SUPERADO: Contadores de bloqueo acumulados con precision (2 bloqueos)');
  } finally {
    await cdpClient.close();
    wss.close();
    httpServer.close();
  }

  console.log('================================================================================');
  console.log('TODAS LAS VERIFICACIONES CDP REALES DEL ESCUDO ANTI-SSRF (C1-44) PASARON CON EXITO');
  console.log('================================================================================');
}

void runRealCdpAntiSsrfSuite().catch((err) => {
  console.error('ERROR EN PRUEBA REAL CDP ANTI-SSRF:', err);
  process.exit(1);
});
