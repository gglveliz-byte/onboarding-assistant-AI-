/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/whop-sdk-client.ts
 * @modulo 04-billing-and-whop (Cliente Oficial de la Pasarela de Cobros)
 * @proposito
 *   Punto UNICO de construccion del cliente oficial de la pasarela. Existir en un solo lugar resuelve
 *   los dos fallos que dejaron la integracion sin cobrar nada: (1) se llamaba a la API con
 *   `WHOP_API_KEY`, la clave publica del app, que la pasarela rechaza con `403 ... not authorized for
 *   the company:balance:read scope` y `400 Missing required parameter: company_id` — la credencial que
 *   si tiene permisos de cobro es `WHOP_COMPANY_API_KEY`; (2) cada consumidor montaba su propia URL
 *   base y su propio `fetch`, de modo que el versionado `Api-Version-Date` y los reintentos no eran
 *   configurables de forma central.
 *
 *   El cliente apunta a `https://api.whop.com/api/v1`, que es la version actual. La rama `v2` esta
 *   deprecada y su cabecera `Sunset` vence el 13-nov-2026, asi que queda prohibido reconstruir URLs
 *   `v2` a mano.
 *
 * @resumen_contenido
 *   - Constante `WHOP_REQUEST_TIMEOUT_SECONDS` y `WHOP_MAX_RETRIES`.
 *   - Funcion `resolveWhopEnvironment()`: Eleccion explicita entre produccion y sandbox.
 *   - Funcion `createWhopClientFromEnv()`: Construccion con la credencial de empresa validada.
 *   - Funcion `getWhopClient()`: Cliente memoizado por proceso.
 *   - Funcion `resetWhopClientCache()`: Invalidacion para pruebas.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`src/config/env.schema.ts`): unica puerta autorizada a `process.env`.
 *
 * @dependencias_externas
 *   - `@whop/sdk` (`WhopClient`, `WhopEnvironment`): cliente oficial versionado de la pasarela.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Solo construye el transporte HTTP autenticado).
 */

import { WhopClient, WhopEnvironment } from '@whop/sdk';
import { getEnvConfig } from '../../../config/env.schema';

/** Tiempo maximo de espera por llamada a la pasarela, en segundos. */
const WHOP_REQUEST_TIMEOUT_SECONDS = 12;

/** Reintentos internos del cliente ante fallos transitorios de la pasarela. */
const WHOP_MAX_RETRIES = 2;

/** Cliente memoizado por proceso; se reconstruye solo cuando se invalida explicitamente. */
let cachedClient: WhopClient | null = null;

/** Par de URLs de la pasarela: produccion o sandbox, segun el entorno declarado. */
type WhopEnvironmentUrls = typeof WhopEnvironment.Production | typeof WhopEnvironment.Sandbox;

/**
 * Resuelve el entorno de la pasarela de forma explicita y sin ambiguedad.
 *
 * La eleccion es en blanco: se produce contra el entorno real de la empresa y se prueba contra el
 * sandbox, y mezclarlos publicaria cobros falsos o exponenciales credenciales reales contra recursos
 * de prueba. Cuando el entorno no declara sandbox, la produccion es el unico destino posible.
 *
 * @returns Par de URLs de la pasarela correspondiente al entorno deseado.
 */
export function resolveWhopEnvironment(): WhopEnvironmentUrls {
  const environment = getEnvConfig();
  const wantsSandbox = environment.WHOP_API_BASE_URL.includes('sandbox');
  return wantsSandbox ? WhopEnvironment.Sandbox : WhopEnvironment.Production;
}

/**
 * Construye un cliente nuevo de la pasarela con la credencial de la empresa.
 *
 * @throws Error cuando falta la clave de empresa o su identificador: son dos piezas sin las cuales
 *   la API no puede autorizar ni enrutar ninguna operacion de cobro.
 * @returns Cliente autenticado, versionado y con reintentos configurados.
 */
export function createWhopClientFromEnv(): WhopClient {
  const environment = getEnvConfig();

  if (environment.WHOP_COMPANY_API_KEY.trim().length === 0) {
    throw new Error(
      'CREDENCIAL_DE_EMPRESA_AUSENTE: la pasarela exige WHOP_COMPANY_API_KEY para operar cobros; ' +
        'WHOP_API_KEY es la clave publica del app y no tiene permisos sobre checkout_configurations.'
    );
  }
  if (!/^biz_[A-Za-z0-9_]+$/u.test(environment.WHOP_COMPANY_ID)) {
    throw new Error(
      `CUENTA_DE_EMPRESA_INVALIDA: WHOP_COMPANY_ID debe tener el formato biz_... (recibido "${environment.WHOP_COMPANY_ID}").`
    );
  }

  return new WhopClient({
    token: environment.WHOP_COMPANY_API_KEY,
    environment: resolveWhopEnvironment(),
    timeoutInSeconds: WHOP_REQUEST_TIMEOUT_SECONDS,
    maxRetries: WHOP_MAX_RETRIES,
  });
}

/**
 * Devuelve el cliente de la pasarela compartido por el proceso.
 *
 * @returns Cliente memoizado, construido perezosamente en el primer uso.
 */
export function getWhopClient(): WhopClient {
  if (cachedClient === null) {
    cachedClient = createWhopClientFromEnv();
  }
  return cachedClient;
}

/**
 * Descarta el cliente memoizado. Solo para pruebas y para recargar credenciales en caliente.
 */
export function resetWhopClientCache(): void {
  cachedClient = null;
}
