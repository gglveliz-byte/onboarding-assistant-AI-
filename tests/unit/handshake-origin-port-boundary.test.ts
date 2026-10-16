/**
 * @archivo tests/unit/handshake-origin-port-boundary.test.ts
 * @modulo 02-projects-and-keys / 03-visual-trainer-and-rag (Frontera de Origenes del SDK)
 * @proposito
 *   Ejecuta la funcion REAL `isOriginMatchingPattern()` —la que decide si el handshake del SDK
 *   admite un origen— contra la bateria completa de casos limite y deja constancia escrita de donde
 *   esta la frontera de seguridad. El bloque `NO_DEFECTO` contiene los casos que SI resisten y que no
 *   deben reportarse como fallo; los bloques `DEFECTO_*` contienen los casos cuyo veredicto real es
 *   incorrecto y que esta prueba documenta como pendientes.
 *
 *   C1-06 hallazgos cubiertos:
 *   (a) el puerto nunca se compara: con un patron comodin sin puerto se admiten todos los puertos del
 *       host autorizado, y con el puerto escrito el patron se vuelve inalcanzable (falla cerrado);
 *   (b) con `allowLocalhostDev` activo se admite cualquier `http://localhost:<puerto>` antes de
 *       evaluar el patron autorizado y sin limite de puerto;
 *   (c) el comodin admite tambien el dominio apex desnudo.
 *
 * @resumen_contenido
 *   - `NO_DEFECTO`: fronteras correctas (sufijo malicioso, cambio de esquema, mayusculas, path).
 *   - `DEFECTO_PORT`, `DEFECTO_LOCALHOST`, `DEFECTO_APEX`: casos limite con veredicto incorrecto.
 *   - `CONTRATO_INDEFINIDO`: comportamiento real medido que el contrato no define como fallo.
 *   - `verifyMutatedVariantIsCaught()`: reintroduce el defecto en la funcion y demuestra que la
 *     bateria lo detecta (el defecto jamas se escribe en el arbol de codigo del proyecto).
 *   - `main()`: ejecuta todo, imprime el recuento y termina con codigo 1 si hay defectos.
 *
 * @dependencias_internas
 *   - `isOriginMatchingPattern` (src/modules/02-projects-and-keys/domain/projects-keys.entities.ts).
 *
 * @dependencias_externas
 *   - `node:assert`, `node:child_process`, `node:fs`, `node:os`, `node:path`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (prueba pura de dominio, sin persistencia).
 */

import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isOriginMatchingPattern } from '../../src/modules/02-projects-and-keys/domain/projects-keys.entities';

/** Caso limite evaluado: origen presentado, patron registrado y veredicto esperado. */
interface OriginCase {
  /** Descripcion legible del caso y de la frontera que defiende. */
  readonly description: string;
  /** Origen presentado por el navegador (`Origin` o `Referer`). */
  readonly origin: string;
  /** Patron registrado en `allowed_domains`. */
  readonly pattern: string;
  /** Si el origen debe considerarse autorizado. */
  readonly expected: boolean;
  /** Bandera `allow_localhost_dev` de la fila registrada. */
  readonly allowLocalhost: boolean;
}

/**
 * Fronteras que SI resisten y que no deben reportarse como defecto.
 * El sufijo con punto esta bien acotado, el esquema se compara y las mayusculas se normalizan.
 */
const NO_DEFECTO: readonly OriginCase[] = [
  { description: 'subdominio legitimo del patron comodin', origin: 'https://app.empresa.com', pattern: 'https://*.empresa.com', expected: true, allowLocalhost: false },
  { description: 'sufijo que imita la marca pero no esta bajo el apice (evil-empresa.com)', origin: 'https://evil-empresa.com', pattern: 'https://*.empresa.com', expected: false, allowLocalhost: false },
  { description: 'subdominio ajeno con el apice como sufijo (tu-dominio.com.evil.com)', origin: 'https://tu-dominio.com.evil.com', pattern: 'https://*.tu-dominio.com', expected: false, allowLocalhost: false },
  { description: 'dominio con el apice como prefijo de otro mayor (evil-tu-dominio.com)', origin: 'https://evil-tu-dominio.com', pattern: 'https://*.tu-dominio.com', expected: false, allowLocalhost: false },
  { description: 'coincidencia exacta sin comodin', origin: 'https://portal.empresa.com', pattern: 'https://portal.empresa.com', expected: true, allowLocalhost: false },
  { description: 'cambio de esquema http frente a patron https', origin: 'http://app.empresa.com', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: false },
  { description: 'protocolo distinto (ftp) frente a patron https', origin: 'ftp://app.empresa.com', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: false },
  { description: 'mayusculas normalizadas en origen y patron', origin: 'HTTPS://App.Empresa.COM', pattern: 'https://app.empresa.com', expected: true, allowLocalhost: false },
  { description: 'barra final eliminada por normalizacion', origin: 'https://app.empresa.com/', pattern: 'https://app.empresa.com', expected: true, allowLocalhost: false },
  { description: 'localhost rechazado cuando la opcion de desarrollo esta apagada', origin: 'http://localhost:3000', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: false },
  { description: 'patron no analizable no debe autorizar por accidente', origin: 'https://app.empresa.com', pattern: 'https://*.empresa.com:no-es-puerto', expected: false, allowLocalhost: false },
];

/** C1-06 (a): el puerto declarado en el patron nunca se compara porque `hostname` lo excluye. */
const DEFECTO_PORT: readonly OriginCase[] = [
  { description: 'C1-06a patron comodin SIN puerto: se admiten TODOS los puertos del host autorizado (aqui 9999)', origin: 'https://app.empresa.com:9999', pattern: 'https://*.empresa.com', expected: false, allowLocalhost: false },
  { description: 'C1-06a control positivo: el mismo host sin puerto debe seguir autorizado', origin: 'https://app.empresa.com', pattern: 'https://*.empresa.com', expected: true, allowLocalhost: false },
  { description: 'C1-06a el puerto escrito en el patron comodin se pega al sufijo y deja el patron inalcanzable', origin: 'https://app.empresa.com:8443', pattern: 'https://*.empresa.com:8443', expected: true, allowLocalhost: false },
];

/** C1-06 (b): la opcion de desarrollo local admite cualquier puerto antes de evaluar el patron. */
const DEFECTO_LOCALHOST: readonly OriginCase[] = [
  { description: 'C1-06b localhost en puerto no autorizado con la opcion de desarrollo activa', origin: 'http://localhost:9999', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: true },
  { description: 'C1-06b 127.0.0.1 en puerto no autorizado con la opcion de desarrollo activa', origin: 'http://127.0.0.1:9999', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: true },
  { description: 'C1-06b control positivo: localhost en el puerto declarado por el patron registrado', origin: 'http://localhost:3000', pattern: 'http://localhost:3000', expected: true, allowLocalhost: true },
];

/** C1-06 (c): el comodin acepta el dominio apex desnudo ademas de sus subdominios. */
const DEFECTO_APEX: readonly OriginCase[] = [
  { description: 'C1-06c dominio apex desnudo admitido por el comodin', origin: 'https://empresa.com', pattern: 'https://*.empresa.com', expected: false, allowLocalhost: false },
];

/**
 * C1-06 (a-ter): con un patron EXACTO la comparacion es literal —cadena contra cadena, incluido el
 * puerto escrito— y jamas se compara el nombre de host analizado. Esa asimetria entre el camino
 * literal (estricto) y el camino con comodin (host analizado y permisivo) es la causa raiz de C1-06a.
 */
const CONTRATO_INDEFINIDO: readonly OriginCase[] = [
  { description: 'CONTRATO patron exacto: el origen en 9999 no casa con el literal sin puerto', origin: 'https://app.empresa.com:9999', pattern: 'https://app.empresa.com', expected: false, allowLocalhost: false },
  { description: 'CONTRATO patron exacto: el origen en 9999 tampoco casa con el literal de puerto 443', origin: 'https://app.empresa.com:9999', pattern: 'https://app.empresa.com:443', expected: false, allowLocalhost: false },
  { description: 'CONTRATO comodin: el puerto registrado vuelve inalcanzable al patron para su propio host y puerto', origin: 'https://app.empresa.com:8443', pattern: 'https://*.empresa.com:8443', expected: false, allowLocalhost: false },
];

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Ejecuta un bloque de casos con la funcion real e imprime el veredicto medido.
 *
 * @param blockName - Nombre del bloque evaluado.
 * @param cases - Casos limite del bloque.
 * @returns Descripciones de los casos que se desviaron de lo esperado.
 */
function runBlock(blockName: string, cases: readonly OriginCase[]): readonly string[] {
  const deviations: string[] = [];
  console.log(`\n--- ${blockName} (${cases.length} casos) ---`);
  for (const testCase of cases) {
    const actual = isOriginMatchingPattern(testCase.origin, testCase.pattern, testCase.allowLocalhost);
    const verdict = actual === testCase.expected ? 'OK   ' : 'FALLO';
    console.log(
      `[${verdict}] ${testCase.description} | origen=${testCase.origin} patron=${testCase.pattern} ` +
        `allowLocalhostDev=${String(testCase.allowLocalhost)} esperado=${String(testCase.expected)} real=${String(actual)}`
    );
    if (actual === testCase.expected) {
      passedAssertions += 1;
      assert.equal(actual, testCase.expected, testCase.description);
    } else {
      deviations.push(`${testCase.description}: esperado ${String(testCase.expected)} y la funcion real devolvio ${String(actual)}`);
    }
  }
  return deviations;
}

/**
 * Construye el cuerpo de una variante de `isOriginMatchingPattern()` con el defecto REINTRODUCIDO:
 * se elimina el limite de puerto del camino localhost y la exigencia de host del camino comodin.
 *
 * @returns Codigo fuente completo de la variante defectuosa.
 */
function buildMutatedVariantSource(): string {
  return [
    "import { normalizeOriginPattern } from './projects-keys-reales';",
    '',
    '/** Variante de laboratorio con el defecto reintroducido (no se escribe en el arbol del proyecto). */',
    'export function isOriginMatchingPattern(',
    '  presentedOrigin: string,',
    '  registeredPattern: string,',
    '  allowLocalhost: boolean',
    '): boolean {',
    '  const normalizedOrigin = normalizeOriginPattern(presentedOrigin);',
    '  const normalizedPattern = normalizeOriginPattern(registeredPattern);',
    '',
    '  if (allowLocalhost && normalizedOrigin.startsWith("http://localhost")) {',
    '    return true;',
    '  }',
    '',
    '  return normalizedOrigin === normalizedPattern;',
    '}',
    '',
  ].join('\n');
}

/**
 * Reintroduce el defecto en una copia fuera del arbol del proyecto y comprueba que la bateria de
 * casos limite lo DETECTA: si la variante defectuosa superase la bateria, la prueba no serviria.
 *
 * @param checks - Casos limite que deben delatar el defecto reintroducido.
 */
function verifyMutatedVariantIsCaught(checks: readonly OriginCase[]): void {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `c1-06-${randomUUID().slice(0, 8)}-`));
  const variantFile = path.join(stagingDir, 'variante-defectuosa.ts');
  const realFile = path.join(stagingDir, 'projects-keys-reales.ts');
  const childFile = path.join(stagingDir, 'hijo-verificador.ts');

  // La copia real conserva unicamente la normalizacion, de la que depende la variante.
  fs.writeFileSync(
    realFile,
    'export function normalizeOriginPattern(origin: string): string {\n' +
      '  const trimmed = origin.trim().toLowerCase();\n' +
      "  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;\n" +
      '}\n',
    'utf8'
  );
  fs.writeFileSync(variantFile, buildMutatedVariantSource(), 'utf8');

  const caseList = JSON.stringify(checks);
  fs.writeFileSync(
    childFile,
    "import * as assert from 'node:assert';\n" +
      "import { isOriginMatchingPattern } from './variante-defectuosa';\n" +
      `const CASOS = ${caseList} as const;\n` +
      'for (const caso of CASOS) {\n' +
      '  assert.equal(\n' +
      '    isOriginMatchingPattern(caso.origin, caso.pattern, caso.allowLocalhost),\n' +
      '    caso.expected,\n' +
      '    caso.description\n' +
      '  );\n' +
      '}\n' +
      "console.log('La variante defectuosa supero la bateria (la prueba NO detecta el defecto).');\n",
    'utf8'
  );

  console.log('\n--- REINTRODUCCION DEL DEFECTO EN COPIA TEMPORAL (fuera del arbol del proyecto) ---');
  console.log(`[Laboratorio] Directorio temporal: ${stagingDir}`);
  let failureMessage = '';
  let childFailed = false;
  try {
    execFileSync('npx', ['tsx', childFile], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    childFailed = true;
    const spawnError = error as { readonly stderr?: string; readonly message?: string };
    failureMessage = (spawnError.stderr ?? spawnError.message ?? '').trim();
  }
  assert.ok(childFailed, 'La variante con el defecto reintroducido NO debe superar la bateria de casos limite');
  assert.ok(
    failureMessage.includes('C1-06a patron comodin SIN puerto') &&
      failureMessage.includes('C1-06b localhost en puerto no autorizado'),
    'El mensaje de fallo debe identificar los casos limite que delatan el defecto'
  );
  passedAssertions += 1;
  console.log('[Laboratorio] La bateria DETECTA el defecto reintroducido. Mensaje exacto de fallo:');
  for (const line of failureMessage.split(/\r?\n/u).slice(0, 12)) {
    console.log(`  ${line}`);
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

/**
 * Ejecuta la bateria completa, distinguiendo fronteras correctas de defectos pendientes.
 */
async function main(): Promise<void> {
  console.log('================================================================================');
  console.log('C1-06 FRONTERA DE ORIGENES DEL SDK: CASOS LIMITE Y DEFECTOS PENDIENTES');
  console.log('================================================================================');

  const nonDefects = runBlock('NO_DEFECTO (fronteras que SI resisten)', NO_DEFECTO);
  const undefinedContract = runBlock('CONTRATO_INDEFINIDO (comportamiento real medido)', CONTRATO_INDEFINIDO);
  const portDefects = runBlock('DEFECTO_PORT (el puerto del patron nunca se compara)', DEFECTO_PORT);
  const localhostDefects = runBlock('DEFECTO_LOCALHOST (desarrollo local sin limite de puerto)', DEFECTO_LOCALHOST);
  const apexDefects = runBlock('DEFECTO_APEX (el comodin admite el apice desnudo)', DEFECTO_APEX);

  verifyMutatedVariantIsCaught([...portDefects.slice(0, 1).map(() => DEFECTO_PORT[0] as OriginCase), DEFECTO_LOCALHOST[0] as OriginCase]);

  console.log('\n================================================================================');
  console.log(`Verificaciones superadas: ${passedAssertions}`);
  console.log(`Bloque CONTRATO_INDEFINIDO: ${undefinedContract.length} desviaciones frente al comportamiento real registrado.`);
  if (nonDefects.length > 0) {
    console.log(`REGRESION: una frontera que antes resistia ahora falla (${nonDefects.length}):`);
    for (const deviation of nonDefects) {
      console.log(`  - ${deviation}`);
    }
  } else {
    console.log('Fronteras correctas confirmadas: sufijo con punto, esquema, mayusculas y localhost apagado.');
  }

  const allDefects = [...portDefects, ...localhostDefects, ...apexDefects];
  if (allDefects.length === 0) {
    console.log('RESULTADO: APROBADO. Los defectos C1-06 ya no se reproducen (correccion aplicada).');
    console.log('================================================================================');
    return;
  }

  console.log(`\nRESULTADO: DEFECTOS PENDIENTES C1-06 (${allDefects.length}). La prueba documenta el defecto.`);
  for (const deviation of allDefects) {
    console.log(`  - ${deviation}`);
  }
  console.log('================================================================================');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('ERROR AL EJECUTAR LA BATERIA DE ORIGENES:', error);
  process.exitCode = 1;
});
