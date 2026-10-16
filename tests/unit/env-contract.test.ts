/**
 * @archivo tests/unit/env-contract.test.ts
 * @modulo 00-foundations (Prueba de Fuego del Contrato de Entorno y del Ledger de Migraciones)
 * @proposito
 *   Blinda el contrato de borde de la Parte 1 con aserciones ejecutables sobre los casos que
 *   mas riesgo operativo concentran: la interpretacion de banderas booleanas de seguridad
 *   (critico: `Boolean('false') === true` en JavaScript), la exigencia del par de llaves
 *   EdDSA en produccion y el rechazo de configuraciones peligrosas del escudo Anti-SSRF.
 *
 * @resumen_contenido
 *   - Constantes `DEVELOPMENT_ENVIRONMENT_BASE` y `VALID_EDDSA_*`: Entorno minimo y llaves reales.
 *   - Funcion `expectValid()`: Aserta que una configuracion debe ser aceptada.
 *   - Funcion `expectInvalid()`: Aserta que una configuracion debe ser rechazada con un motivo.
 *   - Bloque `main`: Ejecuta los 5 grupos de aserciones e informa el resultado final.
 *
 * @dependencias_internas
 *   - `refinedEnvironmentSchema` y `DECLARED_ENVIRONMENT_KEYS` (`src/config/env.zod-schema.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente estatica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import { DECLARED_ENVIRONMENT_KEYS, refinedEnvironmentSchema } from '../../src/config/env.zod-schema';

/** Variables de entorno minimas de un proceso de desarrollo valido. */
const DEVELOPMENT_ENVIRONMENT_BASE: Readonly<Record<string, string>> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://usuario:secreto@host-pooler.region.aws.neon.tech/neondb?sslmode=require',
  REDIS_CLUSTER_URLS: 'redis://localhost:6379,rediss://cache-2:6380',
  WHOP_API_KEY: 'clave_de_cobros_de_prueba_123456',
  WHOP_WEBHOOK_SECRET: 'secreto_de_firma_de_webhooks_de_prueba',
  INTERNAL_CHECKOUT_HMAC_SECRET: 'secreto_interno_de_checkout_de_prueba_32',
  QWEN_REALTIME_WS_URL: 'wss://motor-primario.interno/api-ws/v1/realtime',
  QWEN_API_KEY: 'credencial_motor_primario_de_prueba',
  GEMINI_LIVE_WS_URL: 'wss://motor-respaldo.interno/ws/v1/live',
  GEMINI_API_KEY: 'credencial_motor_respaldo_de_prueba',
  CHROMIUM_DMZ_ENDPOINT: 'https://navegador-aislado.interno:9222',
  EXTERNAL_DNS_RESOLVERS: '1.1.1.1,8.8.8.8',
};

/** Llave privada Ed25519 PKCS#8 de prueba, codificada en Base64 (una sola linea). */
const VALID_EDDSA_PRIVATE_KEY =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUMwYjkvaGZjRXFwTFVoTTNIdjBHTDUrd0o1WEx2Z3Y1NFh6TitrUit1L24KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=';

/** Llave publica Ed25519 SPKI de prueba, codificada en Base64 (una sola linea). */
const VALID_EDDSA_PUBLIC_KEY =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQVArUzNFd3FRYWtWUUdCeVVDZTFvYUtRTytVblpwWEZiTjUrdU5HQm82SnM9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta que una configuracion de entorno debe ser aceptada y devuelve el resultado tipado.
 *
 * @param overrides - Variables que sobrescriben la base de desarrollo.
 * @param scenarioName - Nombre legible del escenario evaluado.
 * @returns Configuracion normalizada resultante de la validacion.
 */
function expectValid(overrides: Readonly<Record<string, string>>, scenarioName: string) {
  const result = refinedEnvironmentSchema.safeParse({ ...DEVELOPMENT_ENVIRONMENT_BASE, ...overrides });
  assert.strictEqual(result.success, true, `El escenario "${scenarioName}" debia ser aceptado pero fue rechazado.`);
  passedAssertions += 1;
  return result.success ? result.data : undefined;
}

/**
 * Aserta que una configuracion de entorno debe ser rechazada y que el motivo esperado
 * aparezca en el listado de incumplimientos reportado por el esquema.
 *
 * @param overrides - Variables que sobrescriben la base de desarrollo.
 * @param expectedPath - Ruta de la variable que debe figurar como invalida.
 * @param scenarioName - Nombre legible del escenario evaluado.
 */
function expectInvalid(overrides: Readonly<Record<string, string>>, expectedPath: string, scenarioName: string): void {
  const result = refinedEnvironmentSchema.safeParse({ ...DEVELOPMENT_ENVIRONMENT_BASE, ...overrides });
  assert.strictEqual(result.success, false, `El escenario "${scenarioName}" debia ser rechazado pero fue aceptado.`);

  if (!result.success) {
    const offendingPaths = result.error.issues.map((issue) => issue.path.join('.'));
    const matchesExpectedPath = offendingPaths.some(
      (offendingPath) => offendingPath === expectedPath || offendingPath.startsWith(`${expectedPath}.`)
    );
    assert.ok(
      matchesExpectedPath,
      `El escenario "${scenarioName}" debia senalar "${expectedPath}" y senalo: ${offendingPaths.join(', ')}`
    );
  }
  passedAssertions += 1;
}

/**
 * Grupo 1: interpretacion de banderas booleanas de seguridad.
 * Regresion critica: `z.coerce.boolean()` convertiria la cadena `"false"` en `true`,
 * habilitando en silencio el acceso a redes privadas desde el escudo Anti-SSRF.
 */
function verifySecurityBooleanFlags(): void {
  const hardened = expectValid({ SSRF_ALLOW_PRIVATE_NETWORKS: 'false', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }, 'banderas en falso');
  assert.strictEqual(hardened?.SSRF_ALLOW_PRIVATE_NETWORKS, false, 'La cadena "false" debe producir el booleano false.');
  assert.strictEqual(hardened?.DATABASE_SSL_REJECT_UNAUTHORIZED, false, 'La cadena "false" debe producir el booleano false.');
  passedAssertions += 1;

  const enabled = expectValid({ SSRF_ALLOW_PRIVATE_NETWORKS: 'true' }, 'bandera en verdadero');
  assert.strictEqual(enabled?.SSRF_ALLOW_PRIVATE_NETWORKS, true, 'La cadena "true" debe producir el booleano true.');
  passedAssertions += 1;

  const numeric = expectValid({ SSRF_ALLOW_PRIVATE_NETWORKS: '1' }, 'bandera numerica');
  assert.strictEqual(numeric?.SSRF_ALLOW_PRIVATE_NETWORKS, true, 'El literal "1" debe producir el booleano true.');
  passedAssertions += 1;

  const byDefault = expectValid({}, 'bandera omitida');
  assert.strictEqual(byDefault?.SSRF_ALLOW_PRIVATE_NETWORKS, false, 'Sin declarar, el escudo Anti-SSRF debe permanecer cerrado.');
  passedAssertions += 1;

  expectInvalid({ SSRF_ALLOW_PRIVATE_NETWORKS: 'quizas' }, 'SSRF_ALLOW_PRIVATE_NETWORKS', 'bandera ambigua');
}

/** Grupo 2: exigencia del par de llaves EdDSA segun el entorno de ejecucion. */
function verifyEddsaKeyPairRules(): void {
  expectInvalid({ JWT_EDDSA_PRIVATE_KEY_PEM: VALID_EDDSA_PRIVATE_KEY }, 'JWT_EDDSA_PRIVATE_KEY_PEM', 'llave privada sin publica');
  expectInvalid({ JWT_EDDSA_PUBLIC_KEY_PEM: VALID_EDDSA_PUBLIC_KEY }, 'JWT_EDDSA_PRIVATE_KEY_PEM', 'llave publica sin privada');
  expectInvalid({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://panel.interno' }, 'JWT_EDDSA_PRIVATE_KEY_PEM', 'produccion sin par EdDSA');

  expectInvalid(
    { JWT_EDDSA_PRIVATE_KEY_PEM: 'bm9fZXNfdW5fcGVtX3ZhbGlkbw==' },
    'JWT_EDDSA_PRIVATE_KEY_PEM',
    'llave privada con PEM invalido'
  );

  const productionEnvironment = expectValid(
    {
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://panel.interno,https://sdk.interno',
      JWT_EDDSA_PRIVATE_KEY_PEM: VALID_EDDSA_PRIVATE_KEY,
      JWT_EDDSA_PUBLIC_KEY_PEM: VALID_EDDSA_PUBLIC_KEY,
    },
    'produccion con par EdDSA y CORS explicito'
  );
  assert.strictEqual(productionEnvironment?.NODE_ENV, 'production');
  passedAssertions += 1;
}

/** Grupo 3: prohibiciones absolutas de configuracion insegura en produccion. */
function verifyProductionHardening(): void {
  expectInvalid(
    {
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://panel.interno',
      JWT_EDDSA_PRIVATE_KEY_PEM: VALID_EDDSA_PRIVATE_KEY,
      JWT_EDDSA_PUBLIC_KEY_PEM: VALID_EDDSA_PUBLIC_KEY,
      SSRF_ALLOW_PRIVATE_NETWORKS: 'true',
    },
    'SSRF_ALLOW_PRIVATE_NETWORKS',
    'produccion con redes privadas habilitadas'
  );

  expectInvalid(
    {
      NODE_ENV: 'production',
      JWT_EDDSA_PRIVATE_KEY_PEM: VALID_EDDSA_PRIVATE_KEY,
      JWT_EDDSA_PUBLIC_KEY_PEM: VALID_EDDSA_PUBLIC_KEY,
    },
    'CORS_ALLOWED_ORIGINS',
    'produccion sin origenes CORS declarados'
  );
}

/** Grupo 4: normalizacion de listas y validacion de endpoints criticos. */
function verifyNormalizationAndEndpoints(): void {
  const normalized = expectValid({}, 'normalizacion de listas');
  assert.deepStrictEqual(
    normalized?.REDIS_CLUSTER_URLS,
    ['redis://localhost:6379', 'rediss://cache-2:6380'],
    'La lista de nodos Redis debe normalizarse como arreglo sin espacios.'
  );
  assert.deepStrictEqual(normalized?.EXTERNAL_DNS_RESOLVERS, ['1.1.1.1', '8.8.8.8'], 'Los resolutores DNS deben normalizarse.');
  assert.deepStrictEqual(normalized?.CORS_ALLOWED_ORIGINS, [], 'CORS vacio debe normalizarse como arreglo vacio.');
  passedAssertions += 3;

  expectInvalid({ DATABASE_URL: 'mysql://usuario:secreto@host:3306/bd' }, 'DATABASE_URL', 'motor de base de datos no soportado');
  expectInvalid({ REDIS_CLUSTER_URLS: 'http://localhost:6379' }, 'REDIS_CLUSTER_URLS', 'nodo Redis con esquema invalido');
  expectInvalid({ QWEN_REALTIME_WS_URL: 'https://motor.interno/realtime' }, 'QWEN_REALTIME_WS_URL', 'endpoint de voz sin esquema ws');
  expectInvalid({ EXTERNAL_DNS_RESOLVERS: '1.1.1.1,999.999.1.1' }, 'EXTERNAL_DNS_RESOLVERS', 'resolutor DNS invalido');
  expectInvalid({ WHOP_WEBHOOK_SECRET: 'corto' }, 'WHOP_WEBHOOK_SECRET', 'secreto de firma por debajo del minimo');
  expectInvalid({ DATABASE_POOL_MAX: '0' }, 'DATABASE_POOL_MAX', 'tamano de pool fuera de rango');
}

/** Grupo 5: cobertura del contrato declarado frente a los contratos de borde exigidos. */
function verifyDeclaredContractCoverage(): void {
  const requiredKeys = [
    'DATABASE_URL',
    'REDIS_CLUSTER_URLS',
    'JWT_EDDSA_PRIVATE_KEY_PEM',
    'JWT_EDDSA_PUBLIC_KEY_PEM',
    'WHOP_API_KEY',
    'WHOP_WEBHOOK_SECRET',
    'INTERNAL_CHECKOUT_HMAC_SECRET',
    'QWEN_REALTIME_WS_URL',
    'QWEN_API_KEY',
    'GEMINI_LIVE_WS_URL',
    'GEMINI_API_KEY',
    'CHROMIUM_DMZ_ENDPOINT',
    'EXTERNAL_DNS_RESOLVERS',
    'NODE_POOL_ROLE',
  ];

  const missingKeys = requiredKeys.filter((key) => !DECLARED_ENVIRONMENT_KEYS.includes(key));
  assert.deepStrictEqual(missingKeys, [], `El contrato de entorno no declara: ${missingKeys.join(', ')}`);
  assert.ok(DECLARED_ENVIRONMENT_KEYS.length >= 40, 'El contrato de entorno debe declarar al menos 40 variables.');
  passedAssertions += 2;
}

/** Ejecuta los 5 grupos de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE FUEGO: CONTRATO DE ENTORNO Y CIMIENTOS DE LA PARTE 1');
  console.log('='.repeat(96));

  verifySecurityBooleanFlags();
  console.log('[1/5] Banderas booleanas de seguridad: APROBADO (incluye regresion de la cadena "false").');

  verifyEddsaKeyPairRules();
  console.log('[2/5] Par de llaves EdDSA y exigencia en produccion: APROBADO.');

  verifyProductionHardening();
  console.log('[3/5] Endurecimiento de produccion y escudo Anti-SSRF: APROBADO.');

  verifyNormalizationAndEndpoints();
  console.log('[4/5] Normalizacion de listas y validacion de endpoints: APROBADO.');

  verifyDeclaredContractCoverage();
  console.log('[5/5] Cobertura del contrato declarado: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main();
