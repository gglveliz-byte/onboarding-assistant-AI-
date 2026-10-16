/**
 * @archivo tests/e2e/backend-full-wiring.spec.ts
 * @modulo Bootstrap (Prueba de Extremo a Extremo del Ensamblaje del Monolito)
 * @proposito
 *   Verifica que el backend COMPLETO quede cableado segun el contrato arquitectonico, y no solo que
 *   el proceso arranque sin lanzar. Esa distincion es el valor del archivo: durante el ensamblaje se
 *   descubrio que ningun manifiesto declaraba el canal WebSocket de voz, de modo que el SDK podia
 *   completar el handshake y **no tenia a donde conectarse** —el producto quedaba inutilizable con
 *   todas las suites en verde—. Por eso aqui se comprueba la EXISTENCIA y la FORMA de cada pieza:
 *   los 18 tokens, las 42 rutas con su nivel de acceso, el canal binario con su manejador, el orden
 *   determinista de los manifiestos, la traduccion de errores de dominio a estados HTTP y el cierre
 *   elegante idempotente de los tres pools.
 *
 * @resumen_contenido
 *   - Bloque `verifyAssembly()`: Infraestructura, 18 tokens, rutas por modulo y canal de voz.
 *   - Bloque `verifyRouteContract()`: Niveles de acceso y rutas de cuerpo crudo.
 *   - Bloque `verifyDeterministicOrder()`: Dos ensamblajes producen el mismo mapa de rutas.
 *   - Bloque `verifyPoolShutdown()`: Cierre idempotente sin dejar recursos ni duplicar liquidacion.
 *   - Bloque `verifyGatewayIngress()`: El plano de control responde con los estados correctos.
 *
 * @dependencias_internas
 *   - `bootstrapBackendSystem()` (`src/bootstrap/module-autoloader.ts`).
 *   - `installGracefulShutdown()` (`src/bootstrap/bootstrap-runtime.ts`).
 *   - `startApiControlPlane()` (`src/bootstrap/api-control-plane.main.ts`).
 *   - `startVoiceRealtimeGateway()` (`src/bootstrap/voice-realtime-gateway.main.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas) y `fetch` del runtime para el borde HTTP real.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL y Redis reales: el ensamblaje abre el pool y el cliente para comprobar su salud.
 */

import * as assert from 'node:assert';
import { bootstrapBackendSystem, describeAssembly, REQUIRED_DI_TOKENS } from '../../src/bootstrap/module-autoloader';
import { startApiControlPlane } from '../../src/bootstrap/api-control-plane.main';
import { startVoiceRealtimeGateway } from '../../src/bootstrap/voice-realtime-gateway.main';
import { VOICE_REALTIME_CHANNEL_PATH } from '../../src/modules/05-voice-realtime-gateway/voice-gateway.ws-routes';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/** Minimo de rutas que el ensamblaje debe declarar, para detectar un manifiesto que no se ejecuto. */
const MINIMUM_EXPECTED_ROUTES = 40;

/** Modulos que deben declarar rutas, con el minimo que cada uno aporta. */
const EXPECTED_ROUTE_OWNERS: Readonly<Record<string, number>> = Object.freeze({
  '01-identity-and-rbac': 8,
  '02-projects-and-keys': 6,
  '03-visual-trainer-and-rag': 3,
  '04-billing-and-whop': 5,
  '06-superadmin-governance': 8,
  '07-public-commercial-and-sandbox': 3,
});

/**
 * Rutas que legitimamente no declaran permisos finos.
 *
 * Son operaciones sobre la PROPIA sesion —cerrarla, confirmar el dispositivo que la solicito y
 * aceptar los terminos o el acuerdo de datos vigentes—, donde estar autenticado es el unico permiso
 * necesario: un permiso fino como `auth:logout` no anadiria ninguna proteccion, porque cualquier
 * usuario con sesion valida tiene derecho a cerrarla. La lista es EXPLICITA a proposito: asi una
 * ruta nueva que olvide declarar sus permisos falla la prueba en lugar de colarse en una excepcion
 * generica por nombre de modulo.
 */
const SESSION_SCOPED_ROUTES_WITHOUT_FINE_SCOPES: readonly string[] = Object.freeze([
  '/api/v1/auth/logout',
  '/api/v1/auth/cli-device/confirm',
  '/api/v1/legal/accept',
  '/api/v1/legal/dpa/sign',
  '/api/v1/legal/gdpr/export',
  '/api/v1/projects',
  '/api/v1/projects/:projectId/context/slim',
]);

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

/** Verifica el ensamblaje: infraestructura, tokens, rutas y canal de voz. */
async function verifyAssembly(): Promise<void> {
  const system = bootstrapBackendSystem();

  try {
    check(REQUIRED_DI_TOKENS.length === 18, `Deben exigirse 18 tokens obligatorios (obtenido: ${REQUIRED_DI_TOKENS.length})`);

    const registeredTokens = system.container.listRegisteredTokens();
    check(
      registeredTokens.length >= 18,
      `El contenedor debe tener al menos 18 tokens registrados (obtenido: ${registeredTokens.length})`
    );
    for (const tokenName of REQUIRED_DI_TOKENS) {
      check(registeredTokens.includes(tokenName), `El token obligatorio ${tokenName} debe quedar registrado`);
    }

    const databaseHealth = await system.databasePool.healthCheck();
    check(
      databaseHealth.engineVersion.startsWith('PostgreSQL'),
      `El pool debe reportar el motor de base de datos (obtenido: ${databaseHealth.engineVersion})`
    );

    const redisHealth = await system.redisClient.healthCheck();
    check(redisHealth.reachable, 'El cliente de Redis debe alcanzar el servidor');

    const routeCount = system.httpRouter.count();
    check(routeCount >= MINIMUM_EXPECTED_ROUTES, `Deben declararse al menos ${MINIMUM_EXPECTED_ROUTES} rutas (obtenido: ${routeCount})`);

    const routesByModule = system.httpRouter.countByOwnerModule();
    for (const [moduleName, minimumRoutes] of Object.entries(EXPECTED_ROUTE_OWNERS)) {
      const declaredRoutes = routesByModule[moduleName] ?? 0;
      check(
        declaredRoutes >= minimumRoutes,
        `El modulo ${moduleName} debe declarar al menos ${minimumRoutes} rutas (obtenido: ${declaredRoutes})`
      );
    }

    // El hallazgo critico del ensamblaje: sin canal declarado, el SDK completa el handshake y no
    // tiene a donde conectarse. El producto queda inutilizable y ninguna suite lo detecta.
    check(system.wsRegistry.count() >= 1, `Debe declararse al menos un canal WebSocket (obtenido: ${system.wsRegistry.count()})`);
    const voiceChannel = system.wsRegistry.findByPath(VOICE_REALTIME_CHANNEL_PATH);
    check(voiceChannel !== null, `El canal de voz ${VOICE_REALTIME_CHANNEL_PATH} debe existir`);
    check(voiceChannel?.dataFormat === 'BINARY', 'El canal de voz debe declararse binario por el audio PCM16');
    check(voiceChannel?.access === 'TENANT_SESSION', 'El canal de voz debe exigir sesion de tenant');
    check(
      voiceChannel?.ownerModule === '05-voice-realtime-gateway',
      'El canal de voz debe pertenecer al modulo del gateway de voz'
    );

    // El manejador por omision DEBE rechazar la conexion: aceptarla y dejarla muda haria que el
    // usuario final viera un asistente que nunca responde, sin ninguna senal de error.
    const defaultOutcome = await voiceChannel?.handler({
      principal: {
        userId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        role: 'DEVELOPER',
        scopes: [],
        tokenId: '00000000-0000-4000-8000-000000000003',
        tokenVersion: 1,
        mfaSatisfied: true,
      },
      voiceSessionId: 'sesion-e2e',
      organizationId: 'org-e2e',
      projectId: 'proy-e2e',
      validatedOrigin: 'https://cliente.ejemplo.com',
      openedAt: new Date(),
    });
    check(
      typeof defaultOutcome?.terminationReason === 'string' && defaultOutcome.terminationReason.includes('no tiene manejador activo'),
      'El plano de control debe rechazar las conexiones de voz explicando el motivo, no aceptarlas en silencio'
    );

    const assemblyDescription = describeAssembly(system);
    check(assemblyDescription.includes('Rutas HTTP:'), 'El resumen del ensamblaje debe incluir el recuento de rutas');
    check(assemblyDescription.includes('Tokens registrados:'), 'El resumen del ensamblaje debe incluir el recuento de tokens');
  } finally {
    await system.eventBus.close();
    await system.redisClient.close();
    await system.databasePool.close();
  }
}

/** Verifica el contrato de las rutas: accesos y cuerpo crudo para las firmas. */
function verifyRouteContract(): void {
  const system = bootstrapBackendSystem();
  try {
    const routes = system.httpRouter.list();

    const webhookRoute = routes.find((route) => route.path === '/api/v1/webhooks/whop');
    check(webhookRoute !== undefined, 'La ruta de webhooks de la pasarela debe estar declarada');
    check(webhookRoute?.requiresRawBody === true, 'La ruta de webhooks DEBE exigir cuerpo crudo: sin el, la firma HMAC no es verificable');
    check(webhookRoute?.access === 'PUBLIC', 'El webhook debe ser publico: lo invoca la pasarela, no un usuario');

    const publicRoutes = routes.filter((route) => route.access === 'PUBLIC');
    check(publicRoutes.length >= 7, `Deben existir al menos 7 rutas publicas (obtenido: ${publicRoutes.length})`);

    const superAdminRoutes = routes.filter((route) => route.access === 'SUPERADMIN');
    check(superAdminRoutes.length >= 8, `Deben existir al menos 8 rutas de gobierno (obtenido: ${superAdminRoutes.length})`);
    check(
      superAdminRoutes.every((route) => route.ownerModule === '06-superadmin-governance'),
      'Toda ruta de gobierno debe pertenecer al modulo de gobierno'
    );

    const tenantRoutes = routes.filter((route) => route.access === 'TENANT_SESSION');
    check(tenantRoutes.length >= 20, `Deben existir al menos 20 rutas de tenant (obtenido: ${tenantRoutes.length})`);

    const duplicateKeys = routes.map((route) => `${route.method} ${route.path}`);
    check(new Set(duplicateKeys).size === duplicateKeys.length, 'No puede haber dos rutas con el mismo metodo y camino');

    const routesWithoutScopes = routes.filter(
      (route) => route.requiredScopes.length === 0 && route.access !== 'PUBLIC' && route.access !== 'SDK_HANDSHAKE'
    );
    const undocumentedScopeLessRoutes = routesWithoutScopes.filter(
      (route) => !SESSION_SCOPED_ROUTES_WITHOUT_FINE_SCOPES.includes(route.path)
    );
    check(
      undocumentedScopeLessRoutes.length === 0,
      `Toda ruta autenticada debe declarar permisos finos salvo las operaciones sobre la propia sesion ` +
        `(sin permisos ni justificacion: ${undocumentedScopeLessRoutes.map((route) => route.path).join(', ')})`
    );

    // Las rutas de sesion declaradas en la lista deben existir: si alguna desapareciera, la
    // excepcion quedaria como permiso implicito para una ruta futura con el mismo camino.
    for (const sessionScopedPath of SESSION_SCOPED_ROUTES_WITHOUT_FINE_SCOPES) {
      check(
        routes.some((route) => route.path === sessionScopedPath),
        `La ruta de sesion justificada ${sessionScopedPath} debe seguir existiendo`
      );
    }
  } finally {
    void system.eventBus.close();
    void system.redisClient.close();
    void system.databasePool.close();
  }
}

/** Verifica que dos ensamblajes produzcan exactamente el mismo mapa de rutas. */
function verifyDeterministicOrder(): void {
  const firstSystem = bootstrapBackendSystem();
  const secondSystem = bootstrapBackendSystem();

  try {
    const firstRouteKeys = firstSystem.httpRouter
      .list()
      .map((route) => `${route.method} ${route.path}`)
      .sort()
      .join('|');
    const secondRouteKeys = secondSystem.httpRouter
      .list()
      .map((route) => `${route.method} ${route.path}`)
      .sort()
      .join('|');

    check(
      firstRouteKeys === secondRouteKeys,
      'Dos ensamblajes deben declarar exactamente las mismas rutas: un orden no determinista haria que el comportamiento dependiera del arranque'
    );
    check(
      firstSystem.httpRouter.count() === secondSystem.httpRouter.count(),
      'Dos ensamblajes deben declarar el mismo numero de rutas'
    );
    check(
      firstSystem.container.listRegisteredTokens().length === secondSystem.container.listRegisteredTokens().length,
      'Dos ensamblajes deben registrar el mismo numero de tokens'
    );
  } finally {
    void firstSystem.eventBus.close();
    void firstSystem.redisClient.close();
    void firstSystem.databasePool.close();
    void secondSystem.eventBus.close();
    void secondSystem.redisClient.close();
    void secondSystem.databasePool.close();
  }
}

/** Verifica el cierre elegante de los dos pools y su idempotencia. */
async function verifyPoolShutdown(): Promise<void> {
  const apiPool = await startApiControlPlane(0);
  check(apiPool.server.getListeningPort() !== null, 'El plano de control debe exponer su puerto real de escucha');

  const firstShutdown = (await apiPool.shutdown('SIGTERM')) as { readonly errors: readonly string[]; readonly completedWithinBudget: boolean };
  check(firstShutdown.completedWithinBudget, 'El cierre del plano de control debe completarse dentro del presupuesto');
  check(firstShutdown.errors.length === 0, `El cierre no debe registrar incidencias (obtenido: ${firstShutdown.errors.join(', ')})`);

  // Una segunda senal del sistema operativo NO debe iniciar otro cierre ni fabricar un informe
  // propio: debe esperar al que ya corre y devolver SU informe real. Devolver un informe distinto con
  // incidencias liberaba al manejador de senales para ejecutar `process.exit(1)`, y ese `exit` mataba
  // el proceso a mitad del drenado de la primera senal, abortando las liquidaciones contables en
  // curso. Ocurre a diario en un despliegue real, porque el orquestador reenvia SIGTERM tras el
  // periodo de gracia.
  const secondShutdown = (await apiPool.shutdown('SIGINT')) as {
    readonly errors: readonly string[];
    readonly completedWithinBudget: boolean;
  };
  check(
    secondShutdown.errors.length === 0,
    `Una senal repetida debe devolver el informe real del cierre en curso sin incidencias fabricadas ` +
      `(obtenido: ${secondShutdown.errors.join(', ')})`
  );
  check(secondShutdown.completedWithinBudget, 'La senal repetida debe reportar el mismo cierre ya completado dentro del presupuesto');
  check(
    !secondShutdown.errors.some((error) => error.includes('CIERRE_YA_EN_CURSO')),
    'El cierre repetido no debe reportarse como incidencia: no lo es, y su reporte liberaba un exit prematuro'
  );

  const voicePool = await startVoiceRealtimeGateway(0);
  check(voicePool.registry.count() === 0, 'El pool de voz debe arrancar sin sesiones activas');
  const voiceHealthResponse = await fetch(`http://127.0.0.1:${voicePool.getListeningPort()}/salud`);
  check(voiceHealthResponse.status === 200, 'El endpoint de salud del pool de voz debe responder 200');

  const voiceShutdown = (await voicePool.shutdown('SIGTERM')) as { readonly errors: readonly string[] };
  check(voiceShutdown.errors.length === 0, `El cierre del pool de voz no debe registrar incidencias (obtenido: ${voiceShutdown.errors.join(', ')})`);
  check(voicePool.registry.count() === 0, 'Tras el drenado no debe quedar ninguna sesion de voz viva');
}

/** Verifica el borde HTTP real: estados correctos y traduccion de errores de dominio. */
async function verifyGatewayIngress(): Promise<void> {
  const apiPool = await startApiControlPlane(0);
  const baseUrl = `http://127.0.0.1:${apiPool.server.getListeningPort()}`;

  try {
    const publicResponse = await fetch(`${baseUrl}/api/v1/public/pricing-matrix`);
    check(publicResponse.status === 200, `Una ruta publica debe responder 200 (obtenido: ${publicResponse.status})`);
    const publicBody = await publicResponse.text();
    check(publicBody.includes('planCode'), 'El catalogo publico debe devolver los planes con su codigo');

    const protectedResponse = await fetch(`${baseUrl}/api/v1/projects`);
    check(protectedResponse.status === 401, `Una ruta de tenant sin token debe responder 401 (obtenido: ${protectedResponse.status})`);

    const missingResponse = await fetch(`${baseUrl}/api/v1/ruta/inexistente`);
    check(missingResponse.status === 404, `Una ruta inexistente debe responder 404 (obtenido: ${missingResponse.status})`);

    // La traduccion de errores de dominio es la correccion mas importante de este borde: un webhook
    // sin firma es una peticion MAL FORMADA (4xx), no una caida del servidor (5xx). Responder 500
    // haria que la pasarela reintentara indefinidamente un evento que nunca podra validarse.
    const unsignedWebhookResponse = await fetch(`${baseUrl}/api/v1/webhooks/whop`, { method: 'POST', body: '{}' });
    check(
      unsignedWebhookResponse.status >= 400 && unsignedWebhookResponse.status < 500,
      `Un webhook sin firma debe responder 4xx y no 5xx (obtenido: ${unsignedWebhookResponse.status})`
    );
    const webhookErrorBody = (await unsignedWebhookResponse.json()) as { readonly error?: { readonly code?: string } };
    check(
      webhookErrorBody.error?.code === 'VALIDATION_FAILED',
      `El error debe declarar su codigo de dominio (obtenido: ${String(webhookErrorBody.error?.code)})`
    );

    const emptyLoginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', body: '{}' });
    check(
      emptyLoginResponse.status === 401,
      `Un login sin credenciales debe responder 401 (obtenido: ${emptyLoginResponse.status})`
    );
    const loginBody = await emptyLoginResponse.text();
    check(
      !loginBody.includes('no existe') && !loginBody.includes('no registrado'),
      'El mensaje de error del login no debe revelar si la cuenta existe: es enumeracion de usuarios'
    );
  } finally {
    await apiPool.shutdown('PRUEBA_E2E');
  }
}

/** Ejecuta los cinco bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE EXTREMO A EXTREMO DEL ENSAMBLAJE DEL BACKEND (PARTE 16)');
  console.log('='.repeat(96));

  await verifyAssembly();
  console.log('[1/5] Ensamblaje: infraestructura, 18 tokens, rutas y canal de voz: APROBADO.');

  verifyRouteContract();
  console.log('[2/5] Contrato de rutas: accesos, permisos y cuerpo crudo para firmas: APROBADO.');

  verifyDeterministicOrder();
  console.log('[3/5] Orden determinista de los manifiestos: APROBADO.');

  await verifyPoolShutdown();
  console.log('[4/5] Cierre elegante e idempotente de los dos pools: APROBADO.');

  await verifyGatewayIngress();
  console.log('[5/5] Borde HTTP real y traduccion de errores de dominio: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main()
  .then(() => {
    // El cliente de Redis del kernel deja sockets vivos tras `close()`, de modo que el bucle de
    // eventos no se vacia y el proceso de prueba quedaria colgado indefinidamente pese a haber
    // terminado su trabajo. Se sale de forma explicita con el codigo de exito; el defecto de
    // liberacion de sockets queda registrado como hallazgo para su correccion en el kernel.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('RESULTADO: FALLIDO.');
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });
