/**
 * @archivo scripts/provision-whop-webhook.ts
 * @modulo 04-billing-and-whop (Gobierno del Endpoint de Webhooks de la Pasarela)
 * @proposito
 *   Dejanos de un webhook que apunta al raiz del sitio. El unico endpoint registrado en la cuenta
 *   (`hook_6bpF6sgYIWXNe`) entregaba sus 91 eventos en `https://neurochat.com.ec/`, que es la landing
 *   comercial: el backend nunca recibio un cobro, y la pasarela ya acumulaba 6 fallos consecutivos.
 *
 *   La operacion es una ACTUALIZACION en lugar de un borrado y alta deliberados: el recurso webhook no
 *   expone su secreto en las lecturas (`webhook_secret` devuelve `null`), asi que destruir el endpoint
 *   existente obligaria a rotar `WHOP_WEBHOOK_SECRET` en el entorno y en el panel a la vez. Cambiando
 *   `url` y `events` sobre el mismo `hook_...` el secreto sigue siendo el mismo y `.env` no se toca.
 *
 *   Tambien reduce la suscripcion a los seis eventos que el backend procesa. Los otros 85 eran ruido:
 *   cada alta de plan, pago de nomina o movimiento de ledger reintentaba contra la landing.
 *
 * @resumen_contenido
 *   - Constante `BILLING_EVENTS`: unicos eventos que el receptor sabe procesar.
 *   - Funcion `listWebhooks()` y `applyWebhookUpdate()`: lectura y correccion del endpoint.
 *   - Funcion `main()`: orquestacion con diagnostico por consola.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) y `resolveWhopEnvironment()` (cliente del modulo 04).
 *
 * @dependencias_externas
 *   - `@whop/sdk` (`WhopClient`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Solo configura el extremo remoto de la pasarela).
 *
 * @uso
 *   npx tsx scripts/provision-whop-webhook.ts --url=https://neurochat.com.ec/api/v1/webhooks/whop
 */

import { WhopClient } from '@whop/sdk';
import { getEnvConfig } from '../src/config/env.schema';
import { resolveWhopEnvironment } from '../src/modules/04-billing-and-whop/infrastructure/whop-sdk-client';

/**
 * Eventos que el backend procesa realmente.
 *
 * `membership.updated` se incluye porque la pasarela reenvia alli tambien la activacion: escucharlo
 * cubre el ciclo completo aunque se pierda un `membership.activated` individual.
 */
const BILLING_EVENTS = [
  'membership.activated',
  'membership.updated',
  'membership.deactivated',
  'payment.succeeded',
  'payment.failed',
  'refund.created',
] as const;

/** Ruta publica del receptor de webhooks, relativa al origen de la aplicacion. */
const WEBHOOK_ROUTE_PATH = '/api/v1/webhooks/whop';

/**
 * NO existe destino por omision, a proposito.
 *
 * Esta version del script apuntaba por defecto a `neurochat.com.ec`, y resulto ser un dominio que
 * pertenece a otra pagina: la pasarela habria estado entregando alli los eventos de cobro de esta
 * plataforma, acumulando 404 y fallos consecutivos. El dominio publico es decision del operador y se
 * exige de forma explicita con `--url=`; preferimos un arranque que falla ruidosamente a uno que
 * entrega dinero a una direccion ajena.
 */

/** Representacion reducida del recurso webhook que interesa gobernar. */
interface WebhookSummary {
  readonly id: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly eventCount: number;
  readonly consecutiveFailures: number;
}

/** Extrae un registro de respuesta paginado o simple. */
function asRecords(payload: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload as Record<string, unknown>[];
  }
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

/** Lista los webhooks registrados en la cuenta. */
async function listWebhooks(whop: WhopClient, companyId: string): Promise<readonly WebhookSummary[]> {
  // La API actual filtra por `account_id`; `company_id` solo existia en las versiones legacy.
  const response = (await whop.webhooks.list({ account_id: companyId })) as unknown;
  return asRecords(response).map((hook) => ({
    id: String(hook['id'] ?? ''),
    url: String(hook['url'] ?? ''),
    enabled: hook['enabled'] === true,
    eventCount: Array.isArray(hook['events']) ? (hook['events'] as unknown[]).length : 0,
    consecutiveFailures: Number(hook['consecutive_failures'] ?? 0),
  }));
}

/**
 * Re-apunta un webhook existente a la ruta del backend y lo limita a los eventos de cobro.
 *
 * @param whop - Cliente autenticado de la empresa.
 * @param hookId - Identificador `hook_...` del endpoint a corregir.
 * @param targetUrl - URL publica HTTPS del receptor.
 * @returns Verdadero cuando la pasarela acepto la actualizacion.
 */
async function applyWebhookUpdate(whop: WhopClient, hookId: string, targetUrl: string): Promise<boolean> {
  try {
    const events = [...BILLING_EVENTS] as unknown as NonNullable<Parameters<typeof whop.webhooks.update>[0]['events']>;
    await whop.webhooks.update({ id: hookId, url: targetUrl, events, enabled: true });
    return true;
  } catch (error) {
    console.error(`  No se pudo actualizar ${hookId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Desactiva todos los webhooks de la cuenta.
 *
 * Se usa cuando el dominio publico del API aun no existe: un webhook apuntando a una direccion que
 * no es de este sistema acumula fallos y golpea a un tercero con eventos de cobro que nunca podra
 * procesar. Desactivar es reversible y no toca planes, claves ni secretos.
 *
 * @param whop - Cliente autenticado de la empresa.
 * @param hooks - Webhooks registrados en la cuenta.
 * @returns Cantidad de endpoints desactivados.
 */
async function disableWebhooks(whop: WhopClient, hooks: readonly WebhookSummary[]): Promise<number> {
  let disabled = 0;
  for (const hook of hooks) {
    if (!hook.enabled) {
      continue;
    }
    try {
      await whop.webhooks.update({ id: hook.id, enabled: false });
      disabled += 1;
      console.log(`  ${hook.id}: DESACTIVADO (apuntaba a ${hook.url})`);
    } catch (error) {
      console.error(`  ${hook.id}: no se pudo desactivar -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return disabled;
}

/** Orquesta la revision y correccion del endpoint de webhooks. */
async function main(): Promise<void> {
  const environment = getEnvConfig();
  const whop = new WhopClient({ token: environment.WHOP_COMPANY_API_KEY, environment: resolveWhopEnvironment() });

  // Modo de emergencia: --disable deja la cuenta sin entregas activas y sale.
  if (process.argv.includes('--disable')) {
    console.log('=================================================================');
    console.log('DESACTIVACION DE WEBHOOKS DE LA PASARELA');
    console.log(`Cuenta: ${environment.WHOP_COMPANY_ID}`);
    console.log('=================================================================');
    const currentHooks = await listWebhooks(whop, environment.WHOP_COMPANY_ID);
    for (const hook of currentHooks) {
      console.log(`  antes: ${hook.id} url=${hook.url} enabled=${hook.enabled} fallos=${hook.consecutiveFailures}`);
    }
    const disabledCount = await disableWebhooks(whop, currentHooks);
    console.log(`\nEndpoints desactivados: ${disabledCount}. Reactiva con --url=https://... cuando exista el dominio.`);
    return;
  }

  const urlArgument = process.argv.find((argument) => argument.startsWith('--url='));
  if (urlArgument === undefined) {
    throw new Error(
      `Falta --url=. Declare el dominio PUBLICO donde este sistema expone la ruta ${WEBHOOK_ROUTE_PATH}, ` +
        'o use --disable para dejar la cuenta sin entregas activas. ' +
        'No se asume ningun dominio: entregar los eventos de cobro a una direccion ajena es irreversible en el peor caso.'
    );
  }
  const targetUrl = urlArgument.slice('--url='.length);

  if (!/^https:\/\//u.test(targetUrl)) {
    throw new Error(`La URL del webhook debe ser HTTPS publica, se recibio "${targetUrl}".`);
  }

  console.log('=================================================================');
  console.log('GOBIERNO DEL ENDPOINT DE WEBHOOKS');
  console.log(`Cuenta: ${environment.WHOP_COMPANY_ID} | Destino: ${targetUrl}`);
  console.log(`Eventos a mantener: ${BILLING_EVENTS.join(', ')}`);
  console.log('=================================================================');

  const hooks = await listWebhooks(whop, environment.WHOP_COMPANY_ID);

  if (hooks.length === 0) {
    console.log('\nLa cuenta NO tiene ningun webhook registrado. Creelo desde el panel o con webhooks.create.');
    return;
  }

  console.log('\nWebhooks actuales:');
  for (const hook of hooks) {
    console.log(`  ${hook.id}  url=${hook.url}  enabled=${hook.enabled}  eventos=${hook.eventCount}  fallos=${hook.consecutiveFailures}`);
  }

  const candidates = hooks.filter((hook) => hook.url !== targetUrl || hook.eventCount !== BILLING_EVENTS.length);
  if (candidates.length === 0) {
    console.log('\nTodo webhook ya apunta al destino correcto con la suscripcion minima. Sin cambios.');
    return;
  }

  console.log('\nAplicando correcciones:');
  for (const hook of candidates) {
    const applied = await applyWebhookUpdate(whop, hook.id, targetUrl);
    console.log(`  ${hook.id}: ${applied ? 'CORREGIDO' : 'FALLO'}`);
  }

  const after = await listWebhooks(whop, environment.WHOP_COMPANY_ID);
  console.log('\nEstado final:');
  for (const hook of after) {
    console.log(`  ${hook.id}  url=${hook.url}  eventos=${hook.eventCount}  enabled=${hook.enabled}`);
  }
}

main().catch((error) => {
  console.error('GOBIERNO DE WEBHOOK FALLIDO:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
