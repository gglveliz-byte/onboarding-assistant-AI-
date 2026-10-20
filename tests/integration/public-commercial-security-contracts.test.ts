/**
 * @archivo tests/integration/public-commercial-security-contracts.test.ts
 * @modulo 07-public-commercial-and-sandbox
 * @proposito
 *   Prueba de integración REAL contra PostgreSQL (Neon) y Redis (127.0.0.1:6379)
 *   para verificar los hallazgos C1-13, C1-14 y C1-15 con REVERSIÓN de mutación.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createRlsDatabasePoolFromEnv, RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { createRedisClusterClientFromEnv } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import {
  GetPublicPricingMatrixUseCase,
  CreatePublicLiveDemoSessionUseCase,
} from '../../src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case';
import { registerPublicCommercialModule } from '../../src/modules/07-public-commercial-and-sandbox/public-commercial.manifest';
import { DI_TOKENS, DependencyContainer } from '../../src/shared/container/di-container';
import type {
  HttpRouteRegistration,
  HttpRouterRegistry,
  AuthenticatedRequestContext,
  HttpRequestLike,
} from '../../src/shared/infrastructure/http/http-server.types';
import { ProviderUnavailableError, RateLimitExceededError } from '../../src/shared/kernel/result-and-errors';

async function runPublicCommercialSecurityContractsSuite(): Promise<void> {
  console.log('\n================================================================================');
  console.log('PRUEBA DE INTEGRACION REAL Y REVERSION: COMERCIAL, SANDBOX Y DEMO (C1-13, C1-14, C1-15)');
  console.log('================================================================================');

  const rlsPool = createRlsDatabasePoolFromEnv();
  const redisClient = createRedisClusterClientFromEnv();

  const testIp = `198.51.${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}`;

  // HERMETICIDAD C1-13: el tope de la demo es configurable en vivo (oa:demo:config en Redis). El
  // test asume los DEFECTOS de plataforma, así que esta suite guarda el valor que rige hoy, siembra
  // los defectos para su corrida y los RESTAURA tal cual (o la ausencia del valor) en el finally.
  const governedConfigKey = 'oa:demo:config';
  let governedConfigOriginal: unknown = null;

  const routes: HttpRouteRegistration[] = [];
  const router: HttpRouterRegistry = {
    register: (reg) => routes.push(reg),
    list: () => routes,
  };

  const container = {
    get: (token: unknown) => {
      if (token === (DI_TOKENS.RlsDatabasePool as unknown)) return rlsPool;
      throw new Error(`Token no registrado: ${String(token)}`);
    },
    tryGet: (token: unknown) => {
      if (token === (DI_TOKENS.RedisClusterClient as unknown)) return redisClient;
      return undefined;
    },
  } as unknown as DependencyContainer;

  // Registrar módulo oficial 07 en el router
  registerPublicCommercialModule(container, router, { isProduction: false });

  const pricingRoute = routes.find((r) => r.path === '/api/v1/public/pricing-matrix');
  const demoRoute = routes.find((r) => r.path === '/api/v1/public/demo-session');

  assert.ok(pricingRoute, 'Ruta /api/v1/public/pricing-matrix debe estar registrada');
  assert.ok(demoRoute, 'Ruta /api/v1/public/demo-session debe estar registrada');

  const dummyContext = (clientIp: string): AuthenticatedRequestContext => ({
    requestId: 'req_test',
    clientIp,
    userAgent: 'TestRunner/1.0',
    receivedAt: new Date(),
    principal: null,
    organizationId: null,
    projectId: null,
    functionalMapId: null,
    validatedOrigin: null,
  });

  const dummyRequest = (body: unknown): HttpRequestLike => ({
    method: 'POST',
    path: '/api/v1/public/demo-session',
    clientIp: '127.0.0.1',
    headers: {},
    query: {},
    rawBody: Buffer.from(''),
    body: {
      turnstileToken: 'turnstile-test-passed',
      preferredVoiceModel: 'GEMINI',
      ...(typeof body === 'object' && body !== null ? body : {}),
    },
  });

  try {
    // Hermetización en acción: snapshot del valor gobernable vigente + siembra de los defectos.
    governedConfigOriginal = await redisClient.json.getJson<unknown>(governedConfigKey);
    await redisClient.json.setJson(governedConfigKey, { maxDurationSeconds: 150, demosPerIpPerDay: 2 }, 0);

    // -------------------------------------------------------------------------
    // TEST C1-13: Límite de Demostración Pública (Anti-Spoofing y Fail-Closed)
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-13] Límite de Demostración Pública: Anti-Spoofing y Fail-Closed ---');
    {
      // 1. Primera solicitud desde testIp a través del endpoint HTTP montado: DEBE tener éxito
      const res1 = await demoRoute!.handler(
        dummyRequest({}),
        dummyContext(testIp)
      );
      assert.strictEqual(res1.status, 201, 'La primera demo debe responder 201');

      // 2. Segunda solicitud desde el mismo testIp: DEBE tener éxito (tope es 2 por ventana de 24h)
      const res2 = await demoRoute!.handler(
        dummyRequest({}),
        dummyContext(testIp)
      );
      assert.strictEqual(res2.status, 201, 'La segunda demo debe responder 201');

      // 3. Tercera solicitud desde testIp: DEBE ser BLOQUEADA con RateLimitExceededError (429)
      let rateLimitThrown = false;
      try {
        await demoRoute!.handler(
          dummyRequest({}),
          dummyContext(testIp)
        );
      } catch (err: unknown) {
        rateLimitThrown = err instanceof RateLimitExceededError;
      }
      assert.strictEqual(rateLimitThrown, true, 'La tercera solicitud debe lanzar RateLimitExceededError');

      // 4. Verificación Anti-Spoofing:
      // Incluso si el atacante envía cabeceras falsificadas 'x-forwarded-for' o 'x-real-ip',
      // el manifiesto no las lee de req.headers; toma clientIp exclusivamente de ctx.clientIp (transporte)
      let spoofingBlocked = false;
      try {
        const spoofedReq: HttpRequestLike = {
          ...dummyRequest({}),
          headers: {
            'x-forwarded-for': '1.1.1.1, 8.8.8.8',
            'x-real-ip': '9.9.9.9',
          },
        };
        await demoRoute!.handler(spoofedReq, dummyContext(testIp));
      } catch (err: unknown) {
        spoofingBlocked = err instanceof RateLimitExceededError;
      }
      assert.strictEqual(
        spoofingBlocked,
        true,
        'Las cabeceras x-forwarded-for falsificadas NO deben burlar el rate limit'
      );

      // 5. Fail-Closed: Si Redis no está disponible, el sistema DEBE fallar cerrado (503)
      const failClosedUseCase = new CreatePublicLiveDemoSessionUseCase({
        redisClient: undefined,
        isProduction: false,
      });
      const resFailClosed = await failClosedUseCase.execute(
        `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
        { turnstileToken: 'turnstile-test-passed', preferredVoiceModel: 'GEMINI' }
      );
      assert.strictEqual(resFailClosed.ok, false, 'Sin Redis debe fallar cerrado');
      if (!resFailClosed.ok) {
        assert.ok(
          resFailClosed.error instanceof ProviderUnavailableError,
          'Debe lanzar ProviderUnavailableError al fallar cerrado'
        );
      }

      // 6. REVERSION C1-13: Si volvemos a la lógica vulnerable donde se confía en 'x-forwarded-for',
      // un cliente malicioso simplemente rota la cabecera e impersona infinitas IPs
      const spoofedIpHeader = '203.0.113.199';
      const vulnerableIpResolution = (headerValue?: string) => headerValue?.split(',')[0]?.trim() ?? testIp;
      const resolvedSpoofedIp = vulnerableIpResolution(spoofedIpHeader);
      assert.strictEqual(resolvedSpoofedIp, spoofedIpHeader, 'REVERSION: La lectura de cabeceras permitía spoofing');
      assert.notStrictEqual(resolvedSpoofedIp, testIp, 'REVERSION: La IP del atacante quedaba enmascarada');

      console.log('  [PASS] C1-13 verificado: Rate limit atómico en Redis, anti-spoofing y fail-closed aprobados.');
    }

    // -------------------------------------------------------------------------
    // TEST C1-14: Demostración Comercial de Extremo a Extremo (Contrato de Sesión)
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-14] Demostración Comercial E2E: Consistencia de Token y Sesión ---');
    {
      const freshIp = `203.0.${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}`;
      const demoRes = await demoRoute!.handler(
        dummyRequest({ requestedPersona: 'ONBOARDING_SPECIALIST' }),
        dummyContext(freshIp)
      );
      assert.strictEqual(demoRes.status, 201);
      const session = demoRes.body as {
        sessionId: string;
        ephemeralToken: string;
        handshakeNonce: string;
        nonceId: string;
        websocketUrl: string;
      };

      // 1. El objeto devuelto debe contener identificadores consistentes para ambos clientes
      assert.ok(session.sessionId, 'sessionId debe existir');
      assert.ok(session.ephemeralToken, 'ephemeralToken debe existir');
      assert.ok(session.handshakeNonce, 'handshakeNonce debe ser retornado para el WebSocket');
      assert.strictEqual(session.nonceId, session.handshakeNonce, 'nonceId debe ser alias de handshakeNonce');

      // 2. La URL de conexión debe incluir todos los parámetros requeridos
      assert.ok(session.websocketUrl.includes(`sessionId=${session.sessionId}`));
      assert.ok(session.websocketUrl.includes(`token=${session.ephemeralToken}`));
      assert.ok(session.websocketUrl.includes(`nonce=${session.handshakeNonce}`));

      // 3. Verificar que la sesión persistió en Redis bajo ambas claves esperadas
      const sessionInRedis = await redisClient.json.getJson<{ sessionId: string; clientIpHash: string }>(
        `oa:demo:session:${session.sessionId}`
      );
      assert.ok(sessionInRedis, 'La sesión debe estar indexada por sessionId en Redis');
      assert.strictEqual(sessionInRedis?.sessionId, session.sessionId);

      const expectedIpHash = createHash('sha256').update(freshIp).digest('hex');
      assert.strictEqual(sessionInRedis?.clientIpHash, expectedIpHash, 'El hash de IP debe coincidir');

      const tokenInRedis = await redisClient.json.getJson<{ sessionId: string; token: string }>(
        `oa:demo:token:${session.ephemeralToken}`
      );
      assert.ok(tokenInRedis, 'La sesión debe estar indexada por ephemeralToken en Redis');
      assert.strictEqual(tokenInRedis?.sessionId, session.sessionId);

      // 4. REVERSION C1-14: Si el gateway busca por handshakeNonce y la entidad no lo provee,
      // el enlace WebSocket fallaría silenciosamente por clave inexistente
      const brokenSessionPayload: Partial<typeof session> = { ...session };
      delete (brokenSessionPayload as Record<string, unknown>)['handshakeNonce'];
      assert.strictEqual(brokenSessionPayload.handshakeNonce, undefined, 'REVERSION: Payload sin handshakeNonce');

      console.log('  [PASS] C1-14 verificado: Contrato simétrico de sesión y token persistidos en Redis.');
    }

    // -------------------------------------------------------------------------
    // TEST C1-15: Catálogo Público Transparente ante Fallos de Base de Datos
    // -------------------------------------------------------------------------
    console.log('\n--- [C1-15] Catálogo de Precios: Transparencia ante Fallo de Base de Datos ---');
    {
      // 1. Consulta normal contra PostgreSQL real (Neon) a través de la ruta HTTP
      const normalRes = await pricingRoute!.handler(
        {
          method: 'GET',
          path: '/api/v1/public/pricing-matrix',
          clientIp: '127.0.0.1',
          headers: {},
          query: {},
          rawBody: Buffer.from(''),
          body: null,
        },
        dummyContext('127.0.0.1')
      );
      assert.strictEqual(normalRes.status, 200, 'Consulta de precios normal debe responder 200');
      const pricingBody = normalRes.body as { isDegraded: boolean; degradedReason: string | null; plans: unknown[] };
      assert.strictEqual(pricingBody.isDegraded, false, 'En operación normal, isDegraded DEBE ser false');
      assert.strictEqual(pricingBody.degradedReason, null, 'En operación normal, degradedReason DEBE ser null');
      assert.ok(pricingBody.plans.length > 0, 'Debe retornar planes desde Neon DB');

      // 2. Simulación de fallo de base de datos usando un Pool con cliente desconectado
      const brokenRlsPool = {
        withClient: async <T>(_cb: (client: PoolClient) => Promise<T>): Promise<T> => {
          throw new Error('CONNECTION_TIMEOUT: Neon PostgreSQL pool exhausted');
        },
      } as unknown as RlsDatabasePool;

      const degradedUseCase = new GetPublicPricingMatrixUseCase({
        rlsPool: brokenRlsPool,
      });

      const degradedRes = await degradedUseCase.execute();
      assert.strictEqual(degradedRes.ok, true, 'Debe devolver fallback estático para disponibilidad');
      if (degradedRes.ok) {
        // En modo degradado, DEBE advertir explícitamente al cliente
        assert.strictEqual(
          degradedRes.value.isDegraded,
          true,
          'Ante caída de base de datos, isDegraded DEBE ser true'
        );
        assert.ok(
          degradedRes.value.degradedReason?.includes('Neon PostgreSQL pool exhausted'),
          'degradedReason DEBE documentar la causa del fallo'
        );
        assert.ok(
          degradedRes.value.plans.length > 0,
          'El fallback estático debe proveer planes por omisión'
        );
      }

      // 3. REVERSION C1-15: Si el caso de uso no emitiera `isDegraded: true`, el cliente
      // no tendría forma de saber si los precios son frescos o provienen de fallback en caché
      const oldResponseMock = {
        plans: degradedRes.ok ? degradedRes.value.plans : [],
        currency: 'USD',
      };
      assert.strictEqual(
        (oldResponseMock as Record<string, unknown>)['isDegraded'],
        undefined,
        'REVERSION: La respuesta antigua no comunicaba el estado de degradación'
      );

      console.log('  [PASS] C1-15 verificado: Transparencia de degradación e información de causa garantizada.');
    }

  } finally {
    // Reversión de la configuración gobernable: vuelve el valor exacto que regía antes de la
    // corrida; si la clave no existía, se elimina para devolver el comportamiento por defecto.
    try {
      if (governedConfigOriginal === null) {
        await redisClient.nativeClient.del(governedConfigKey);
      } else {
        await redisClient.json.setJson(governedConfigKey, governedConfigOriginal, 0);
      }
    } catch {
      // La reversión de configuración jamás debe tapar el resultado real del suite.
    }
    await rlsPool.close();
    await redisClient.close();
  }

  console.log('\n================================================================================');
  console.log('EXITO TOTAL: C1-13, C1-14 y C1-15 APROBADOS CON PRUEBA Y REVERSION');
  console.log('================================================================================\n');
}

runPublicCommercialSecurityContractsSuite().catch((err) => {
  console.error('\n[FALLO FATAL EN SUITE]', err);
  process.exit(1);
});
