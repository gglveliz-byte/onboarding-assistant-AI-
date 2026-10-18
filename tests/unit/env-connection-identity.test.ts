/**
 * @archivo tests/unit/env-connection-identity.test.ts
 * @modulo 00-foundations (Prueba de Fuego de la Identidad de Conexion y de la Precedencia del Entorno)
 * @proposito
 *   Blinda el hallazgo C1-29: la identidad de conexion a PostgreSQL puede quedar sustituida por una
 *   variable heredada del proceso y desactivar las politicas RLS SIN NINGUNA SENAL. La prueba recorre
 *   el camino REAL —el archivo `.env` del repositorio, el cargador `loadDotEnvFile()`, el contrato
 *   `refinedEnvironmentSchema` y el punto de acceso `getEnvConfig()`— y exige tres cosas:
 *     1) que la precedencia de doce factores NO se altere (el entorno sigue ganando al archivo);
 *     2) que cuando el entorno hereda la identidad del propietario el sistema LO DIGA por su salida
 *        de error estandar y lo exponga como hallazgo estructurado;
 *     3) que con el entorno limpio la identidad sea la del archivo y NO exista ningun hallazgo, de
 *        modo que la prueba no pueda pasar por vacuidad.
 *   No usa dobles ni fabrica cadenas sinteticas: reproduce la contaminacion con la identidad de
 *   propietario REAL leida del propio `.env` y restaura el entorno del proceso al terminar.
 *
 * @resumen_contenido
 *   - Constantes `REPOSITORY_ENVIRONMENT_FILE` y `CONNECTION_IDENTITY_KEYS`.
 *   - Funcion `readDeclarationFromEnvironmentFile()`: Lee una variable del `.env` real.
 *   - Funcion `captureStandardError()`: Intercepta la salida de error estandar durante una operacion.
 *   - Funcion `describeRoles()`: Rotula las identidades implicadas sin revelar credenciales.
 *   - Bloque `main`: Ejecuta los 4 escenarios (contaminado, limpio, produccion y precedencia) e informa.
 *
 * @dependencias_internas
 *   - `getEnvConfig`, `resetEnvConfigCache`, `describeConnectionIdentity`, `loadDotEnvFile` y
 *     `parseConnectionRoleIdentity` (`src/config/env.schema.ts`).
 *   - `refinedEnvironmentSchema` (`src/config/env.zod-schema.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas) y `node:fs` (Lectura del archivo `.env` real).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (La prueba no abre conexiones: mide la configuracion resuelta, no la base de datos).
 */

import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refinedEnvironmentSchema } from '../../src/config/env.zod-schema';
import {
  describeConnectionIdentity,
  getEnvConfig,
  loadDotEnvFile,
  parseConnectionRoleIdentity,
  resetEnvConfigCache,
} from '../../src/config/env.schema';

/** Ruta del archivo de variables real del repositorio. */
const REPOSITORY_ENVIRONMENT_FILE = resolve(process.cwd(), '.env');

/** Claves de identidad de conexion implicadas en el hallazgo C1-29. */
const CONNECTION_IDENTITY_KEYS = ['DATABASE_URL', 'DATABASE_OWNER_URL'] as const;

/** Entorno del proceso al arrancar la prueba, para restaurarlo intacto al terminar. */
const ORIGINAL_PROCESS_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {
  DATABASE_URL: process.env['DATABASE_URL'],
  NODE_ENV: process.env['NODE_ENV'],
};

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Lee una declaracion directamente del archivo `.env` real del repositorio, sin pasar por el
 * cargador, para disponer de la identidad que el proyecto declara de forma explicita.
 *
 * @param keyName - Nombre de la variable buscada.
 * @returns Valor sin comillas, o `null` cuando no esta declarada.
 */
function readDeclarationFromEnvironmentFile(keyName: string): string | null {
  const fileContents = readFileSync(REPOSITORY_ENVIRONMENT_FILE, 'utf8');
  for (const rawLine of fileContents.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine.startsWith(`${keyName}=`)) {
      continue;
    }
    return trimmedLine.slice(keyName.length + 1).trim().replace(/^["']|["']$/gu, '');
  }
  return null;
}

/**
 * Ejecuta una operacion interceptando temporalmente la salida de error estandar, para comprobar si
 * el sistema dijo algo. Se intercepta el flujo de salida, no la logica: la operacion es la real.
 *
 * @param operation - Operacion cuyo efecto sobre la salida de error se quiere observar.
 * @returns Texto escrito en la salida de error estandar y valor devuelto por la operacion.
 */
function captureStandardError<T>(operation: () => T): { readonly standardError: string; readonly value: T } {
  const capturedChunks: string[] = [];
  const originalWrite = process.stderr.write;
  const replacementWrite = ((chunk: unknown): boolean => {
    capturedChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  process.stderr.write = replacementWrite;
  try {
    const value = operation();
    return { standardError: capturedChunks.join(''), value };
  } finally {
    process.stderr.write = originalWrite;
  }
}

/**
 * Rotula el rol de una cadena de conexion, o indica que no es interpretable. Nunca expone
 * credenciales: solo el nombre del rol y el host.
 *
 * @param connectionString - Cadena de conexion a rotular.
 * @returns Etiqueta legible de la identidad.
 */
function describeRoles(connectionString: string | undefined): string {
  const identity = parseConnectionRoleIdentity(connectionString);
  return identity === null ? '(no interpretable)' : `rol "${identity.roleName}" en ${identity.hostName}`;
}

/**
 * Escenario 1: el entorno ya exporta la identidad del PROPIETARIO (reproduccion exacta del hallazgo
 * C1-29, medida y no simulada). Exige que la precedencia se conserve y que el sistema lo diga.
 *
 * @param ownerUrlFromFile - Identidad de propietario declarada en el `.env` real.
 * @returns Hallazgos expuestos por el sistema en el estado contaminado.
 */
function verifyContaminatedEnvironment(ownerUrlFromFile: string): ReturnType<typeof describeConnectionIdentity> {
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = ownerUrlFromFile;

  const loadedKeys = loadDotEnvFile();
  assert.ok(
    !loadedKeys.includes('DATABASE_URL'),
    'El cargador NO debe aplicar la identidad del archivo cuando el entorno ya define DATABASE_URL: la precedencia de doce factores seria la rota.'
  );
  passedAssertions += 1;

  resetEnvConfigCache();
  const captured = captureStandardError(() => getEnvConfig());

  assert.strictEqual(
    captured.value.DATABASE_URL,
    ownerUrlFromFile,
    'La precedencia de doce factores debe conservarse: el proceso sigue mandando sobre el archivo.'
  );
  passedAssertions += 1;

  assert.ok(
    captured.standardError.includes('DE IDENTIDAD DE CONEXION'),
    'El sistema arranco con la identidad del propietario SIN DECIRLO: no se escribio ningun aviso de identidad de conexion en la salida de error estandar.'
  );
  assert.ok(
    captured.standardError.includes('rolbypassrls'),
    'El aviso de identidad de conexion debe explicar la consecuencia concreta: un rol con rolbypassrls anula las politicas RLS.'
  );
  passedAssertions += 2;

  const findings = describeConnectionIdentity();
  const ownerIdentityFinding = findings.find((finding) => finding.code === 'IDENTIDAD_APLICACION_IGUAL_A_PROPIETARIO');
  assert.ok(
    ownerIdentityFinding,
    'La identidad resuelta para la aplicacion es la del propietario declarado y el sistema NO la denuncio: ' +
      `hallazgos obtenidos = [${findings.map((finding) => finding.code).join(', ') || 'ninguno'}].`
  );
  assert.strictEqual(
    ownerIdentityFinding.severity,
    'ALERTA',
    'Fuera de produccion el hallazgo debe ser ALERTA (no bloqueante) para no impedir la ejecucion de las suites.'
  );
  passedAssertions += 2;

  const shadowFinding = findings.find((finding) => finding.code === 'IDENTIDAD_DECLARADA_ENMASCARADA_POR_EL_ENTORNO');
  assert.ok(
    shadowFinding,
    'El archivo declara una identidad de conexion distinta de la que usara el proceso y la ambiguedad NO quedo registrada: ' +
      'el cargador no esta anotando la sustitucion.'
  );
  assert.ok(
    shadowFinding.description.includes('DATABASE_URL'),
    'El hallazgo de ambiguedad debe nombrar la variable sustituida.'
  );
  passedAssertions += 2;

  return findings;
}

/**
 * Escenario 2: entorno limpio. La identidad debe ser la declarada en el archivo y no debe existir
 * ningun hallazgo. Sin esta comprobacion, la prueba pasaria aunque el detector se disparara siempre.
 *
 * @param applicationUrlFromFile - Identidad de aplicacion declarada en el `.env` real.
 */
function verifyCleanEnvironment(applicationUrlFromFile: string): void {
  delete process.env['DATABASE_URL'];
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'development';

  loadDotEnvFile();
  resetEnvConfigCache();
  const captured = captureStandardError(() => getEnvConfig());

  assert.strictEqual(
    captured.value.DATABASE_URL,
    applicationUrlFromFile,
    'Sin variable heredada, el cargador debe aplicar la identidad declarada en el archivo.'
  );
  passedAssertions += 1;

  const applicationRole = parseConnectionRoleIdentity(captured.value.DATABASE_URL)?.roleName;
  const ownerRole = parseConnectionRoleIdentity(captured.value.DATABASE_OWNER_URL)?.roleName;
  assert.ok(
    applicationRole !== undefined && ownerRole !== undefined && applicationRole !== ownerRole,
    'El archivo del repositorio debe declarar dos identidades de conexion DISTINTAS (aplicacion y propietario).'
  );
  passedAssertions += 1;

  const findings = describeConnectionIdentity();
  assert.deepStrictEqual(
    findings.map((finding) => finding.code),
    [],
    'Con el entorno limpio no debe existir ningun hallazgo de identidad de conexion: el detector estaria disparando por defecto.'
  );
  assert.strictEqual(
    captured.standardError.includes('DE IDENTIDAD DE CONEXION'),
    false,
    'Con el entorno limpio el sistema no debe emitir ningun aviso de identidad de conexion.'
  );
  passedAssertions += 2;
}

/**
 * Escenario 3: produccion. El contrato debe RECHAZAR la configuracion y el punto de acceso debe
 * abortar el arranque: es la garantia de que el estado peligroso no llega a atender trafico.
 *
 * @param ownerUrlFromFile - Identidad de propietario declarada en el `.env` real.
 */
function verifyProductionRefusesToStart(ownerUrlFromFile: string): void {
  process.env['DATABASE_URL'] = ownerUrlFromFile;
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
  loadDotEnvFile();

  const parsed = refinedEnvironmentSchema.safeParse(process.env);
  assert.strictEqual(
    parsed.success,
    false,
    'En produccion el contrato de entorno debe RECHAZAR una identidad de aplicacion igual a la del propietario.'
  );

  if (!parsed.success) {
    const offendingIssue = parsed.error.issues.find((issue) => issue.path.join('.') === 'DATABASE_URL');
    assert.ok(offendingIssue, 'El incumplimiento debe senalar DATABASE_URL como variable culpable.');
    assert.ok(
      offendingIssue.message.includes('rolbypassrls'),
      'El mensaje del contrato debe explicar que un rol con rolbypassrls anula las politicas RLS.'
    );
  }
  passedAssertions += 3;

  resetEnvConfigCache();
  assert.throws(
    () => getEnvConfig(),
    (error: unknown) => error instanceof Error && error.message.includes('CONFIGURACION_ENTORNO_INVALIDA'),
    'En produccion getEnvConfig() debe abortar el arranque en lugar de servir una identidad que omite RLS.'
  );
  passedAssertions += 1;

  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'development';
}

/** Restaura el entorno del proceso tal como estaba antes de la prueba. */
function restoreProcessEnvironment(): void {
  for (const key of Object.keys(ORIGINAL_PROCESS_ENVIRONMENT)) {
    const originalValue = ORIGINAL_PROCESS_ENVIRONMENT[key];
    if (originalValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = originalValue;
  }
}

/** Ejecuta los escenarios de la prueba e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE FUEGO: IDENTIDAD DE CONEXION Y PRECEDENCIA DEL ENTORNO (HALLAZGO C1-29)');
  console.log('='.repeat(96));

  const applicationUrlFromFile = readDeclarationFromEnvironmentFile(CONNECTION_IDENTITY_KEYS[0]);
  const ownerUrlFromFile = readDeclarationFromEnvironmentFile(CONNECTION_IDENTITY_KEYS[1]);
  assert.ok(applicationUrlFromFile !== null, 'El archivo .env del repositorio debe declarar DATABASE_URL.');
  assert.ok(ownerUrlFromFile !== null, 'El archivo .env del repositorio debe declarar DATABASE_OWNER_URL.');

  const applicationIdentity = parseConnectionRoleIdentity(applicationUrlFromFile);
  const ownerIdentity = parseConnectionRoleIdentity(ownerUrlFromFile);
  assert.ok(
    applicationIdentity !== null && ownerIdentity !== null,
    'Ambas identidades declaradas en el archivo deben ser cadenas de conexion interpretables.'
  );
  assert.ok(
    applicationIdentity.roleName !== ownerIdentity.roleName,
    'El archivo debe declarar un rol de aplicacion distinto del propietario; de lo contrario el aislamiento RLS ya estaria anulado en el propio archivo.'
  );

  console.log(`Identidad declarada en el archivo -> aplicacion: ${describeRoles(applicationUrlFromFile)}`);
  console.log(`Identidad declarada en el archivo -> propietario: ${describeRoles(ownerUrlFromFile)}`);
  console.log(`Entorno del proceso al iniciar -> DATABASE_URL: ${describeRoles(ORIGINAL_PROCESS_ENVIRONMENT['DATABASE_URL'])}`);
  console.log('-'.repeat(96));

  try {
    verifyContaminatedEnvironment(ownerUrlFromFile);
    console.log('[1/3] Entorno contaminado con el rol propietario: APROBADO (el sistema lo dice y la precedencia se conserva).');

    verifyCleanEnvironment(applicationUrlFromFile);
    console.log('[2/3] Entorno limpio: APROBADO (identidad del archivo y cero hallazgos).');

    verifyProductionRefusesToStart(ownerUrlFromFile);
    console.log('[3/3] Produccion: APROBADO (el contrato rechaza y el arranque se aborta).');
  } finally {
    restoreProcessEnvironment();
  }

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main();
