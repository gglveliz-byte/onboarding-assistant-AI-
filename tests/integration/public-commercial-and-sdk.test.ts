/**
 * @archivo tests/integration/public-commercial-and-sdk.test.ts
 * @modulo 07-public-commercial-and-sandbox (Prueba de Fuego Integral: Endpoints Comerciales y SDK Web)
 * @proposito
 *   Verifica en 5 fases rigurosas los contratos, seguridad y comportamiento del Módulo 07
 *   y del paquete cliente `@onboarding-assistant/sdk`:
 *   1. Matriz pública de precios Whop con fallback resiliente y esquemas Zod estrictos.
 *   2. Creación de sesiones de demostración efímeras de 90s con Turnstile y WebSocket seguro.
 *   3. Rate limiting estricto por IP en Redis (bloqueo al superar 2 demos en 24h).
 *   4. Scrubber de privacidad del SDK bloqueando contraseñas, tarjetas y selectores protegidos.
 *   5. Ejecutor de acciones DOM en cascada, despacho de eventos y simulador de Sandbox.
 *
 * @dependencias_internas
 *   - `GetPublicPricingMatrixUseCase`, `CreatePublicLiveDemoSessionUseCase`, `ValidateSandboxActionUseCase`.
 *   - `publicPricingMatrixResponseSchema`, `demoSessionRequestSchema`, `sandboxSimulateActionSchema`.
 *   - `SensitiveFieldScrubber`, `ActionExecutor`, `OnboardingAssistantClient`.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pricing_plans_config`.
 *   - Redis: `oa:demo:ip:<sha256(ip)>`, `oa:demo:session:<sessionId>`.
 */

import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import type { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import {
  GetPublicPricingMatrixUseCase,
  CreatePublicLiveDemoSessionUseCase,
  ValidateSandboxActionUseCase,
} from '../../src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case';
import {
  publicPricingMatrixResponseSchema,
  demoSessionRequestSchema,
  sandboxSimulateActionSchema,
} from '../../src/modules/07-public-commercial-and-sandbox/domain/public-commercial.entities';
import {
  SensitiveFieldScrubber,
  defaultSensitiveFieldScrubber,
} from '../../packages/sdk/src/security/sensitive-field-scrubber';
import { ActionExecutor } from '../../packages/sdk/src/dom/action-executor';
import { OnboardingAssistantClient } from '../../packages/sdk/src/core/sdk-client';

// =============================================================================
// DOBLES DE PRUEBA EN MEMORIA (POSTGRES Y REDIS)
// =============================================================================

/** Doble de prueba para simular consultas a PostgreSQL en transacciones de lectura pública. */
class FakeRlsDatabasePool {
  public shouldFail = false;
  public returnEmptyRows = false;

  public async withClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.shouldFail) {
      throw new Error('Conexión caída con el cluster PostgreSQL de lectura pública');
    }

    const fakeClient = {
      query: async <R = unknown>(_text: string): Promise<{ rows: R[]; rowCount: number }> => {
        if (this.returnEmptyRows) {
          return { rows: [] as R[], rowCount: 0 };
        }
        const fakeRows = [
          {
            plan_code: 'STARTER',
            display_name: 'Starter Plan',
            monthly_fixed_price_usd: '49.00',
            included_minutes: '200',
            base_overage_rate_per_minute_usd: '0.35',
            overage_allowed: true,
            volume_discount_eligible: false,
            volume_discount_tiers_json: [],
            is_active: true,
          },
          {
            plan_code: 'PRO',
            display_name: 'Pro Plan',
            monthly_fixed_price_usd: '199.00',
            included_minutes: '1000',
            base_overage_rate_per_minute_usd: '0.25',
            overage_allowed: true,
            volume_discount_eligible: true,
            volume_discount_tiers_json: [{ minMinutes: 2000, discountPercentage: 15 }],
            is_active: true,
          },
        ];
        return { rows: fakeRows as unknown as R[], rowCount: fakeRows.length };
      },
    } as unknown as PoolClient;

    return await callback(fakeClient);
  }
}

/** Doble de prueba para Redis con soporte de almacenamiento de strings y TTL. */
class FakeRedisClusterClient {
  public readonly storage = new Map<string, string>();

  public async runScript(
    _script: string,
    keys: readonly string[],
    _args: readonly (string | number)[]
  ): Promise<unknown> {
    const key = keys[0]!;
    const current = Number(this.storage.get(key) ?? '0');
    if (current >= 2) {
      return current + 1;
    }
    const nextVal = current + 1;
    this.storage.set(key, String(nextVal));
    return nextVal;
  }

  public readonly json = {
    getJson: async <T>(key: string): Promise<T | null> => {
      const raw = this.storage.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    },
    setJson: async (key: string, value: unknown, _ttlSeconds: number = 0): Promise<void> => {
      this.storage.set(key, JSON.stringify(value));
    },
    getText: async (key: string): Promise<string | null> => {
      return this.storage.get(key) ?? null;
    },
    setText: async (key: string, value: string, _ttlSeconds: number = 0): Promise<void> => {
      this.storage.set(key, value);
    },
  };
}

// =============================================================================
// DOBLE DE ELEMENTO DOM SIMULADO PARA ENTORNO NODE.JS
// =============================================================================

class MockDomElement {
  public tagName: string;
  public id: string = '';
  public name: string = '';
  public type: string = 'text';
  public value: string = '';
  public parentElement: MockDomElement | null = null;
  public attributes = new Map<string, string>();
  public dispatchedEvents: string[] = [];
  public style: Record<string, string> = {};

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  public closest(selector: string): MockDomElement | null {
    if (selector.includes('data-oa-sensitive') && this.attributes.get('data-oa-sensitive') === 'true') {
      return this;
    }
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  public getBoundingClientRect(): DOMRect {
    return {
      x: 50,
      y: 100,
      width: 150,
      height: 35,
      top: 100,
      right: 200,
      bottom: 135,
      left: 50,
      toJSON: () => ({}),
    } as unknown as DOMRect;
  }

  public dispatchEvent(event: { type: string }): boolean {
    this.dispatchedEvents.push(event.type);
    return true;
  }

  public focus(): void {
    this.dispatchEvent({ type: 'focus' });
  }

  public click(): void {
    this.dispatchEvent({ type: 'click' });
  }
}

// =============================================================================
// EJECUCIÓN PRINCIPAL DE LA BATERÍA DE PRUEBAS
// =============================================================================

async function runPublicCommercialAndSdkSuite(): Promise<void> {
  console.log('>>> [SUITE] Iniciando verificación del Módulo 07 y SDK Web...');

  // ---------------------------------------------------------------------------
  // FASE 1: Matriz Pública de Precios Whop (GetPublicPricingMatrixUseCase)
  // ---------------------------------------------------------------------------
  console.log('\n--- Fase 1: Matriz Pública de Precios Whop & Fallback Resiliente ---');
  {
    const rlsPool = new FakeRlsDatabasePool() as unknown as RlsDatabasePool;
    const useCase = new GetPublicPricingMatrixUseCase({ rlsPool });

    // 1.1 Consulta exitosa con filas en BD
    const res = await useCase.execute();
    assert.strictEqual(res.ok, true, 'El caso de uso debe devolver Ok');
    assert.strictEqual(res.value.currency, 'USD');
    assert.strictEqual(res.value.plans.length, 2, 'Debe devolver los 2 planes configurados en BD');
    assert.strictEqual(res.value.plans[0]?.planCode, 'STARTER');

    // Validación estricta con el esquema Zod público
    const parsed = publicPricingMatrixResponseSchema.parse(res.value);
    assert.strictEqual(parsed.plans.length, 2);

    // 1.2 Fallback estático cuando la BD no tiene filas o falla la conexión
    const failingPool = new FakeRlsDatabasePool();
    failingPool.shouldFail = true;
    const fallbackUseCase = new GetPublicPricingMatrixUseCase({ rlsPool: failingPool as unknown as RlsDatabasePool });

    const fallbackRes = await fallbackUseCase.execute();
    assert.strictEqual(fallbackRes.ok, true, 'Debe responder con fallback ante fallo de BD');
    assert.strictEqual(fallbackRes.value.plans.length, 5, 'El catálogo fallback debe contener los 5 planes canónicos');
    const planCodes = fallbackRes.value.plans.map((p) => p.planCode);
    assert.deepStrictEqual(planCodes, ['PAYG', 'PLAN_5', 'PLAN_10', 'PLAN_30', 'PLAN_50']);
    console.log('  [PASS] Matriz pública de precios y fallback estático validados.');
  }

  // ---------------------------------------------------------------------------
  // FASE 2: Creación de Sesión de Demostración Efímera (90s)
  // ---------------------------------------------------------------------------
  console.log('\n--- Fase 2: Creación de Sesión de Demostración Efímera (90s) ---');
  {
    const redisClient = new FakeRedisClusterClient();
    const useCase = new CreatePublicLiveDemoSessionUseCase({
      redisClient: redisClient as unknown as RedisClusterClient,
      turnstileSecretKey: 'mock-turnstile-secret',
      isProduction: false,
      websocketBaseUrl: 'wss://voice.test.domain/ws/v1/realtime',
    });

    const parsedRequest = demoSessionRequestSchema.parse({
      turnstileToken: 'turnstile-test-passed',
      preferredVoiceModel: 'GEMINI',
      language: 'es',
    });

    const result = await useCase.execute('203.0.113.45', parsedRequest);
    assert.strictEqual(result.ok, true, 'La creación de sesión de demo debe ser exitosa');

    const session = result.value;
    assert.ok(session.sessionId.startsWith('demo_'), 'El sessionId debe tener prefijo demo_');
    assert.ok(session.ephemeralToken.startsWith('demo_tok_'), 'El token debe tener prefijo demo_tok_');
    assert.strictEqual(session.maxDurationSeconds, 90, 'La demo debe durar exactamente 90 segundos');
    assert.strictEqual(session.voiceModel, 'GEMINI');
    assert.ok(session.websocketUrl.includes('sessionId='), 'La URL WebSocket debe contener el sessionId');
    assert.ok(session.websocketUrl.includes('demo=true'), 'La URL WebSocket debe contener la marca demo=true');

    // Verificar persistencia en Redis del descriptor de sesión
    const sessionKey = `oa:demo:session:${session.sessionId}`;
    const storedSessionJson = await redisClient.json.getText(sessionKey);
    assert.ok(storedSessionJson, 'La sesión debe haberse persistido en Redis');
    const parsedStored = JSON.parse(storedSessionJson!);
    assert.strictEqual(parsedStored.sessionId, session.sessionId);
    assert.strictEqual(parsedStored.clientIp, '203.0.113.45');
    console.log('  [PASS] Sesión efímera de 90s y persistencia en Redis validadas.');
  }

  // ---------------------------------------------------------------------------
  // FASE 3: Rate Limiting Estricto por IP en Demostración Pública
  // ---------------------------------------------------------------------------
  console.log('\n--- Fase 3: Rate Limiting Estricto por IP en Demostración Pública ---');
  {
    const redisClient = new FakeRedisClusterClient();
    const useCase = new CreatePublicLiveDemoSessionUseCase({
      redisClient: redisClient as unknown as RedisClusterClient,
      isProduction: false,
    });

    const clientIp = '198.51.100.88';
    const demoReq = demoSessionRequestSchema.parse({ turnstileToken: 'turnstile-test-passed' });

    // Demostración 1: Permitida (contador = 1)
    const demo1 = await useCase.execute(clientIp, demoReq);
    assert.strictEqual(demo1.ok, true, 'Demo 1 de 2 debe permitirse');

    // Demostración 2: Permitida (contador = 2)
    const demo2 = await useCase.execute(clientIp, demoReq);
    assert.strictEqual(demo2.ok, true, 'Demo 2 de 2 debe permitirse');

    // Demostración 3: Bloqueada con RateLimitExceededError (429)
    const demo3 = await useCase.execute(clientIp, demoReq);
    assert.strictEqual(demo3.ok, false, 'Demo 3 debe ser rechazada por exceder cuota diaria');
    assert.strictEqual(demo3.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(demo3.error.httpStatus, 429);

    // Verificar que la clave en Redis utiliza el hash SHA-256 de la IP
    const ipHash = CryptoUtils.sha256Hex(clientIp);
    const storedRateLimit = await redisClient.json.getText(`oa:demo:ip:${ipHash}`);
    assert.strictEqual(storedRateLimit, '2', 'El contador en Redis debe registrar 2 demostraciones emitidas');
    console.log('  [PASS] Rate limit por IP (máx 2 demos/24h) bloquea con código 429.');
  }

  // ---------------------------------------------------------------------------
  // FASE 4: Sanitización de Campos Sensibles en Cliente (SensitiveFieldScrubber)
  // ---------------------------------------------------------------------------
  console.log('\n--- Fase 4: Sanitización de Campos Sensibles (SensitiveFieldScrubber) ---');
  {
    const scrubber = new SensitiveFieldScrubber();

    // 4.1 Input tipo password
    const passwordInput = new MockDomElement('input');
    passwordInput.type = 'password';
    assert.strictEqual(scrubber.isElementSensitive(passwordInput as unknown as Element), true);

    // 4.2 Input tipo credit card por autocomplete
    const ccInput = new MockDomElement('input');
    ccInput.setAttribute('autocomplete', 'cc-number');
    assert.strictEqual(scrubber.isElementSensitive(ccInput as unknown as Element), true);

    // 4.3 Elemento dentro de un contenedor con data-oa-sensitive="true"
    const formContainer = new MockDomElement('div');
    formContainer.setAttribute('data-oa-sensitive', 'true');
    const childInput = new MockDomElement('input');
    childInput.name = 'safe_field';
    childInput.parentElement = formContainer;
    assert.strictEqual(scrubber.isElementSensitive(childInput as unknown as Element), true);

    // 4.4 Elemento seguro ordinario
    const safeInput = new MockDomElement('input');
    safeInput.name = 'user_search_query';
    safeInput.setAttribute('placeholder', 'Buscar productos o servicios');
    assert.strictEqual(scrubber.isElementSensitive(safeInput as unknown as Element), false);

    // 4.5 Enmascaramiento de PAN de tarjeta de crédito (16 dígitos)
    const rawPanText = 'Mi tarjeta es 4111 2222 3333 4444 con fecha 12/26';
    const scrubbedPan = scrubber.scrubSensitiveText(rawPanText);
    assert.ok(!scrubbedPan.includes('4111'), 'El número de tarjeta no debe figurar en el texto sanitizado');
    assert.ok(scrubbedPan.includes('[CARD_REDACTED]'), 'Debe reemplazarse por [CARD_REDACTED]');

    // 4.6 Detección preventiva de selectores CSS sensibles
    assert.strictEqual(scrubber.isSelectorTargetingSensitiveField('input[type="password"]'), true);
    assert.strictEqual(scrubber.isSelectorTargetingSensitiveField('#credit-card-cvv'), true);
    assert.strictEqual(scrubber.isSelectorTargetingSensitiveField('button#btn-submit-search'), false);
    console.log('  [PASS] Scrubber de privacidad bloquea campos sensibles y enmascara PANs.');
  }

  // ---------------------------------------------------------------------------
  // FASE 5: Ejecutor de Acciones DOM, Simulador de Sandbox y SDK Client
  // ---------------------------------------------------------------------------
  console.log('\n--- Fase 5: Ejecutor de Acciones DOM, Sandbox y SDK Client ---');
  {
    // 5.1 Simulador de Sandbox de Documentación
    const sandboxUseCase = new ValidateSandboxActionUseCase();
    const validSandboxPayload = sandboxSimulateActionSchema.parse({
      toolName: 'click_element',
      selectorCascade: ['#tour-next-btn', '[data-oa-id="next-step"]'],
      isElementSensitive: false,
    });
    const sandboxRes = sandboxUseCase.execute(validSandboxPayload);
    assert.strictEqual(sandboxRes.ok, true);
    assert.strictEqual(sandboxRes.value.success, true);
    assert.strictEqual(sandboxRes.value.resolvedSelector, '#tour-next-btn');

    // 5.2 Sandbox detectando elemento sensible
    const sensitiveSandboxPayload = sandboxSimulateActionSchema.parse({
      toolName: 'type_text',
      selectorCascade: ['#user_password'],
      textToType: 'super-secret-123',
    });
    const sensitiveSandboxRes = sandboxUseCase.execute(sensitiveSandboxPayload);
    assert.strictEqual(sensitiveSandboxRes.ok, true);
    assert.strictEqual(sensitiveSandboxRes.value.success, false);
    assert.strictEqual(sensitiveSandboxRes.value.blockedBySensitiveField, true);

    // 5.3 Simulación de ActionExecutor con DOM simulado
    const actionExecutor = new ActionExecutor(defaultSensitiveFieldScrubber, false);

    // Configurar global document simulado
    const mockButton = new MockDomElement('button');
    mockButton.id = 'login-cta-button';

    const originalDocument = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector === '#login-cta-button') return mockButton;
        return null;
      },
      elementFromPoint: () => null,
      getElementById: () => null,
      createElement: (tag: string) => new MockDomElement(tag),
      body: new MockDomElement('body'),
    };

    // Ejecución de click sobre selector válido
    const execResult = await actionExecutor.executeTool({
      actionId: 'act_101',
      toolName: 'click_element',
      selectorCascade: ['#inexistente', '#login-cta-button'],
    });

    assert.strictEqual(execResult.status, 'ACK_SUCCESS');
    assert.strictEqual(execResult.resolvedSelector, '#login-cta-button');
    assert.strictEqual(execResult.actionId, 'act_101');
    assert.ok(mockButton.dispatchedEvents.includes('click'), 'Debe haber despachado el evento click nativo');

    // Ejecución sobre elemento inexistente
    const notFoundResult = await actionExecutor.executeTool({
      actionId: 'act_102',
      toolName: 'click_element',
      selectorCascade: ['#no-existe-1', '#no-existe-2'],
    });
    assert.strictEqual(notFoundResult.status, 'ELEMENT_NOT_FOUND');

    // Restaurar entorno global
    if (originalDocument) {
      (globalThis as unknown as { document: unknown }).document = originalDocument;
    } else {
      delete (globalThis as unknown as { document?: unknown }).document;
    }

    // 5.4 Inicialización de OnboardingAssistantClient
    const validClient = OnboardingAssistantClient.init({
      publishableKey: 'pk_live_8392193821039120',
      debug: false,
    });
    assert.strictEqual(validClient.isActive(), false);
    assert.strictEqual(validClient.getSessionId(), null);

    // Rechazo de clave inválida en constructor
    assert.throws(
      () => OnboardingAssistantClient.init({ publishableKey: 'sk_secret_clave_invalida' }),
      /Clave inválida/
    );

    console.log('  [PASS] ActionExecutor, simulador de Sandbox e inicialización de SDK validados.');
  }

  console.log('\n================================================================');
  console.log('>>> [EXITO] 5/5 Fases superadas con éxito en Módulo 07 & SDK <<<');
  console.log('================================================================\n');
}

runPublicCommercialAndSdkSuite().catch((err) => {
  console.error('\n[ERROR FATAL] Fallo en la suite de pruebas del Módulo 07 & SDK:', err);
  process.exit(1);
});
