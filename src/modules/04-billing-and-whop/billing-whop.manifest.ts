/**
 * @archivo src/modules/04-billing-and-whop/billing-whop.manifest.ts
 * @modulo 04-billing-and-whop (Manifiesto del Modulo y Montaje de Rutas HTTP)
 * @proposito
 *   Manifiesto autonomo del modulo 04. Registra el adaptador del puerto `IBillingWhopPort` en el
 *   contenedor de inyeccion de dependencias y monta las cinco rutas HTTP del modulo: consulta de
 *   consumo, historial contable paginado, exportacion CSV, apertura de checkout firmado y recepcion
 *   de webhooks de la pasarela. La ruta de webhooks declara `requiresRawBody` porque la firma HMAC
 *   solo es verificable sobre el cuerpo crudo exacto: si el framework reserializa el JSON, la firma
 *   deja de coincidir y se rechazan eventos legitimamente firmados.
 *
 * @resumen_contenido
 *   - Constante `OWNER_MODULE`.
 *   - Funciones `assertPrincipal()`, `wrapHandler()`, `readBoundedInteger()` y `buildWebhookHeaders()`.
 *   - Funcion `createGatewayFromEnvironment()`: Adaptador de la pasarela desde el entorno validado.
 *   - Funcion `readDpaSignature()`: Estado del acuerdo de procesamiento de datos.
 *   - Funcion `readCheckoutInput()`: Validacion del cuerpo de apertura de pago.
 *   - Funcion `registerBillingWhopModule()`: Registro en DI y montaje de las 5 rutas HTTP.
 *
 * @dependencias_internas
 *   - `BillingWhopPortAdapter` (`./billing-whop.port-adapter.ts`).
 *   - `DependencyContainer`, `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *   - Casos de uso del modulo (`./application/*.use-case.ts`).
 *   - `PostgresBillingRepository` y `WhopApiAndHmacAdapter` (infraestructura del modulo).
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para las credenciales de cobro.
 *
 * @dependencias_externas
 *   - Ninguna (El transporte HTTP y la persistencia llegan por el contenedor de inyeccion).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger` y `organizations` (Lectura y escritura con RLS).
 *   - Redis: `oa:whop:webhook:evt:<id>` (Marca de idempotencia de los webhooks entrantes).
 */

import { getEnvConfig } from '../../config/env.schema';
import { DependencyContainer, DI_TOKENS } from '../../shared/container/di-container';
import { RlsDatabasePool } from '../../shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../shared/infrastructure/redis/redis-cluster.client';
import {
  AuthenticatedPrincipal,
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRequestLike,
  HttpRouteHandler,
  HttpRouterRegistry,
} from '../../shared/infrastructure/http/http-server.types';
import { UnauthorizedError, ValidationError } from '../../shared/kernel/result-and-errors';
import { PostgresBillingRepository } from './infrastructure/postgres-billing.repository';
import { WhopApiAndHmacAdapter, type WhopWebhookHeaders } from './infrastructure/whop-api-and-hmac.adapter';
import { BillingWhopPortAdapter } from './billing-whop.port-adapter';
import {
  createWhopCheckoutUseCase,
  type CreateCheckoutInput,
  type CreateWhopCheckoutUseCase,
} from './application/create-whop-checkout.use-case';
import { createDeductSessionMinutesUseCase } from './application/deduct-session-minutes.use-case';
import {
  createBillingDashboardQueriesUseCase,
  DEFAULT_LEDGER_PAGE_SIZE,
  MAX_LEDGER_PAGE_SIZE,
} from './application/billing-dashboard-queries.use-case';
import { createProcessWhopWebhookUseCase } from './application/process-whop-webhook.use-case';
import type { CheckoutUseCaseDependencies } from './application/checkout-use-case.dependencies';

/** Nombre con el que el modulo se identifica en las rutas y en los diagnosticos. */
const OWNER_MODULE = '04-billing-and-whop';

/**
 * Exige una sesion autenticada y devuelve su identidad.
 *
 * @param context - Contexto autenticado resuelto por el middleware.
 * @returns Identidad del solicitante.
 * @throws UnauthorizedError cuando no hay sesion.
 */
function assertPrincipal(context: AuthenticatedRequestContext): AuthenticatedPrincipal {
  if (context.principal === undefined || context.principal === null) {
    throw new UnauthorizedError('Se requiere una sesion autenticada para operar sobre la facturacion.');
  }
  return context.principal;
}

/**
 * Adapta un manejador tipado al contrato generico del enrutador.
 *
 * @param handler - Manejador que produce la respuesta tipada.
 * @returns Manejador compatible con el registro de rutas.
 */
function wrapHandler(
  handler: (request: HttpRequestLike, context: AuthenticatedRequestContext) => Promise<HttpHandlerResult>
): HttpRouteHandler<never> {
  return handler as unknown as HttpRouteHandler<never>;
}

/**
 * Extrae un parametro entero no negativo de la cadena de consulta.
 *
 * @param rawValue - Valor crudo del parametro.
 * @param fallbackValue - Valor por omision cuando el parametro no es valido.
 * @param maxValue - Cota superior admitida.
 * @returns Entero acotado dentro del rango permitido.
 */
function readBoundedInteger(rawValue: string | undefined, fallbackValue: number, maxValue: number): number {
  if (rawValue === undefined) {
    return fallbackValue;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackValue;
  }
  return Math.min(parsed, maxValue);
}

/**
 * Extrae las cabeceras de firma del webhook entrante.
 *
 * @param request - Solicitud HTTP normalizada.
 * @returns Cabeceras de firma del webhook.
 * @throws ValidationError cuando falta alguna cabecera obligatoria.
 */
function buildWebhookHeaders(request: HttpRequestLike): WhopWebhookHeaders {
  const readHeader = (headerName: string): string => {
    const value = request.headers[headerName];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0] as string;
    }
    throw new ValidationError(`El webhook no declara la cabecera obligatoria "${headerName}".`);
  };

  return {
    eventId: readHeader('x-whop-event-id'),
    timestampHeader: readHeader('x-whop-timestamp'),
    signatureHeader: readHeader('x-whop-signature'),
    eventNameHeader: readHeader('x-whop-event-type'),
  };
}

/**
 * Construye el adaptador de la pasarela desde las variables de entorno ya validadas.
 *
 * @returns Adaptador configurado con las credenciales y los endpoints del entorno.
 * @throws Error cuando el entorno no declara las credenciales de cobro.
 */
function createGatewayFromEnvironment(): WhopApiAndHmacAdapter {
  const environment = getEnvConfig();
  return new WhopApiAndHmacAdapter({
    apiKey: environment.WHOP_API_KEY,
    webhookSecret: environment.WHOP_WEBHOOK_SECRET,
    checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
    apiBaseUrl: environment.WHOP_API_BASE_URL,
    checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
    webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
  });
}

/**
 * Lee la fecha de firma del acuerdo de procesamiento de datos de una organizacion.
 * Se consulta con privilegio de gobierno porque el cobro puede iniciarse antes de que exista
 * contexto de tenant resoluble para la organizacion.
 *
 * @param pool - Pool con contexto RLS.
 * @param organizationId - Organizacion consultada.
 * @returns Marca ISO de la firma, o `null` cuando no esta firmado.
 */
async function readDpaSignature(pool: RlsDatabasePool, organizationId: string): Promise<string | null> {
  return pool.withClient(async (client) => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_superadmin', 'true', true)`);
    try {
      const result = await client.query<{ dpa_signed_at: Date | null }>(
        `SELECT dpa_signed_at FROM organizations WHERE id = $1 LIMIT 1`,
        [organizationId]
      );
      await client.query('COMMIT');
      const signedAt = result.rows[0]?.dpa_signed_at ?? null;
      return signedAt === null ? null : signedAt.toISOString();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Lee y valida el cuerpo de una solicitud de apertura de checkout.
 *
 * @param request - Solicitud HTTP normalizada.
 * @param principal - Identidad autenticada del solicitante.
 * @returns Entrada del caso de uso de checkout, sin los campos que aporta la sesion.
 * @throws ValidationError cuando falta un campo obligatorio o la sesion no declara organizacion.
 */
function readCheckoutInput(
  request: HttpRequestLike,
  principal: AuthenticatedPrincipal
): Omit<CreateCheckoutInput, 'organizationId' | 'actorUserId'> {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const planCode = body['planCode'];
  const checkoutMode = body['checkoutMode'];
  const redirectUrl = body['redirectUrl'];

  if (typeof planCode !== 'string' || typeof checkoutMode !== 'string' || typeof redirectUrl !== 'string') {
    throw new ValidationError('Se exigen los campos planCode, checkoutMode y redirectUrl para abrir un enlace de pago.');
  }
  if (principal.organizationId.length === 0) {
    throw new ValidationError('La sesion autenticada no declara organizacion.');
  }

  const topUpAmountUsd = body['topUpAmountUsd'];
  return {
    planCode: planCode as CreateCheckoutInput['planCode'],
    checkoutMode: checkoutMode as CreateCheckoutInput['checkoutMode'],
    redirectUrl,
    ...(typeof topUpAmountUsd === 'string' ? { topUpAmountUsd } : {}),
  };
}

/**
 * Registra el Modulo 04 en el contenedor de dependencias y monta sus rutas HTTP.
 * Construye los casos de uso con las dependencias ya resueltas por el contenedor, de modo que el
 * modulo sea autonomo y no imponga un orden de arranque a los demas.
 *
 * @param container - Contenedor de inyeccion de dependencias del monolito.
 * @param router - Registro de rutas HTTP del plano de control.
 */
export function registerBillingWhopModule(container: DependencyContainer, router: HttpRouterRegistry): void {
  const pool = container.get(DI_TOKENS.RlsDatabasePool) as RlsDatabasePool;
  const redisClient = container.get(DI_TOKENS.RedisClusterClient) as RedisClusterClient;

  const repository = new PostgresBillingRepository(pool);
  const gateway = createGatewayFromEnvironment();
  const dependencies: CheckoutUseCaseDependencies = {
    gateway,
    billingRepository: repository,
    redisClient,
    dpaVerifier: {
      isDpaSigned: async (organizationId: string) => {
        const signedAtIso = await readDpaSignature(pool, organizationId);
        return signedAtIso === null
          ? { signed: false as const, reason: 'La organizacion no tiene firmado el acuerdo de procesamiento de datos.' }
          : { signed: true as const, signedAtIso };
      },
    },
  };

  const createCheckout: CreateWhopCheckoutUseCase = createWhopCheckoutUseCase(dependencies);
  const deductMinutes = createDeductSessionMinutesUseCase(dependencies);
  const dashboardQueries = createBillingDashboardQueriesUseCase(dependencies);
  const processWebhook = createProcessWhopWebhookUseCase(dependencies);

  container.registerInstance(
    DI_TOKENS.BillingDeductionPort,
    new BillingWhopPortAdapter(repository, pool, deductMinutes, dashboardQueries)
  );

  // GET /api/v1/billing/consumption — Instantanea del consumo del periodo vigente.
  router.register({
    method: 'GET',
    path: '/api/v1/billing/consumption',
    access: 'TENANT_SESSION',
    requiredScopes: ['billing:read'],
    ownerModule: OWNER_MODULE,
    requiresRawBody: false,
    handler: wrapHandler(async (_request: HttpRequestLike, context: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(context);
      return { status: 200, body: await dashboardQueries.getConsumptionSnapshot(principal.organizationId) };
    }),
  });

  // GET /api/v1/billing/ledger — Historial contable paginado del libro mayor.
  router.register({
    method: 'GET',
    path: '/api/v1/billing/ledger',
    access: 'TENANT_SESSION',
    requiredScopes: ['billing:read'],
    ownerModule: OWNER_MODULE,
    requiresRawBody: false,
    handler: wrapHandler(async (request: HttpRequestLike, context: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(context);
      const pageSize = readBoundedInteger(request.query['pageSize'], DEFAULT_LEDGER_PAGE_SIZE, MAX_LEDGER_PAGE_SIZE);
      const cursorIso = request.query['cursor'] ?? null;
      const page = await dashboardQueries.getLedgerHistory(principal.organizationId, cursorIso, pageSize);
      return { status: 200, body: page };
    }),
  });

  // GET /api/v1/billing/ledger/export — Exportacion contable del periodo en CSV.
  router.register({
    method: 'GET',
    path: '/api/v1/billing/ledger/export',
    access: 'TENANT_SESSION',
    requiredScopes: ['billing:export_invoice'],
    ownerModule: OWNER_MODULE,
    requiresRawBody: false,
    handler: wrapHandler(async (_request: HttpRequestLike, context: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(context);
      const document = await dashboardQueries.exportLedgerCsv(principal.organizationId);
      return {
        status: 200,
        body: document.csvContent,
        headers: {
          'content-type': document.contentType,
          'content-disposition': `attachment; filename="${document.fileName}"`,
        },
      };
    }),
  });

  // POST /api/v1/billing/checkout — Apertura de un enlace de pago firmado.
  router.register({
    method: 'POST',
    path: '/api/v1/billing/checkout',
    access: 'TENANT_SESSION',
    requiredScopes: ['billing:manage_sub'],
    ownerModule: OWNER_MODULE,
    requiresRawBody: false,
    handler: wrapHandler(async (request: HttpRequestLike, context: AuthenticatedRequestContext): Promise<HttpHandlerResult> => {
      const principal = assertPrincipal(context);
      const input = readCheckoutInput(request, principal);
      const session = await createCheckout.execute({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        ...input,
      });
      return { status: 201, body: session };
    }),
  });

  // POST /api/v1/webhooks/whop — Recepcion de eventos de la pasarela con firma verificada.
  router.register({
    method: 'POST',
    path: '/api/v1/webhooks/whop',
    access: 'PUBLIC',
    requiredScopes: [],
    ownerModule: OWNER_MODULE,
    // El cuerpo crudo es imprescindible: la firma se calcula sobre el texto exacto recibido.
    requiresRawBody: true,
    handler: wrapHandler(async (request: HttpRequestLike): Promise<HttpHandlerResult> => {
      const outcome = await processWebhook.execute(request.rawBody, buildWebhookHeaders(request));
      return { status: 202, body: outcome };
    }),
  });
}
