/**
 * @archivo tests/unit/route-scope-catalog.test.ts
 * @modulo QA (Prueba de Fuego del Catalogo de Permisos y de la Cookie de Sesion)
 * @proposito
 *   Blindar el contrato de autorizacion del plano de control con dos aserciones ejecutables:
 *   (1) **todo** scope que exige una ruta HTTP debe existir en el catalogo RBAC real
 *   (`ROLE_PERMISSIONS_MAP`), de modo que ninguna mutacion vuelva a quedar insatisfecha por
 *   construccion (el fallo que dejo al dashboard entero en 403 `INSUFFICIENT_PERMISSIONS`); y
 *   (2) la lectura de la cookie de refresh `__Host-oa_rt` desde el encabezado `Cookie`, que es
 *   la unica via por la que el navegador puede renovar la sesion.
 *
 * @resumen_contenido
 *   - `collectRouteScopes()`: Extrae los `requiredScopes` declarados en los manifiestos de ruta.
 *   - `readCookieValue()`: Extrae una cookie concreta del encabezado `Cookie`.
 *   - Bloque `main`: Ejecuta las aserciones e informa del resultado final.
 *
 * @dependencias_internas
 *   - `ROLE_PERMISSIONS_MAP` (src/modules/01-identity-and-rbac/domain/identity.entities.ts).
 *   - `readCookieValue` (src/modules/01-identity-and-rbac/identity.manifest.ts).
 *
 * @dependencias_externas
 *   - `node:assert` (aserciones nativas), `node:fs` y `node:path` (lectura de los manifiestos).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (prueba puramente estatica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROLE_PERMISSIONS_MAP } from '../../src/modules/01-identity-and-rbac/domain/identity.entities';
import { readCookieValue } from '../../src/modules/01-identity-and-rbac/identity.manifest';

/** Manifiestos HTTP que declaran `requiredScopes` y por tanto consumen el catalogo RBAC. */
const ROUTE_MANIFESTS: readonly string[] = [
  'src/modules/01-identity-and-rbac/identity.manifest.ts',
  'src/modules/02-projects-and-keys/projects-keys.manifest.ts',
  'src/modules/02-projects-and-keys/end-user-voice-consent.manifest.ts',
  'src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest.ts',
  'src/modules/04-billing-and-whop/billing-whop.manifest.ts',
  'src/modules/05-voice-realtime-gateway/voice-gateway.manifest.ts',
  'src/modules/06-superadmin-governance/superadmin-governance.manifest.ts',
  'src/modules/07-public-commercial-and-sandbox/public-commercial.manifest.ts',
  'src/bootstrap/auth-essential-http.routes.ts',
];

/** Radiz del repositorio para resolver las rutas relativas de los manifiestos. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Extrae todos los scopes declarados en `requiredScopes` de los manifiestos indicados.
 *
 * @returns Lista de pares `{ scope, archivo }` con cada scope declarado en el código.
 */
function collectRouteScopes(): Array<{ readonly scope: string; readonly file: string }> {
  const found: Array<{ readonly scope: string; readonly file: string }> = [];
  for (const relativePath of ROUTE_MANIFESTS) {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    const pattern = /requiredScopes:\s*\[([^\]]*)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const scopeList = match[1] ?? '';
      for (const rawScope of scopeList.split(',')) {
        const scope = rawScope.trim().replace(/^['"]|['"]$/g, '');
        if (scope.length > 0) {
          found.push({ scope, file: relativePath });
        }
      }
    }
  }
  return found;
}

/**
 * Bloque principal de la prueba: verifica el catalogo de scopes y la lectura de cookies.
 */
function main(): void {
  const assertions: string[] = [];

  // 1. Todo scope de ruta debe existir en el catalogo RBAC que llena el reclamo `scopes` del token.
  const catalogScopes = new Set<string>();
  for (const permissions of Object.values(ROLE_PERMISSIONS_MAP)) {
    for (const permission of permissions) {
      catalogScopes.add(permission);
    }
  }
  const routeScopes = collectRouteScopes();
  assert.ok(routeScopes.length > 0, 'Se esperaba encontrar scopes declarados en los manifiestos HTTP');
  for (const { scope, file } of routeScopes) {
    assert.ok(
      catalogScopes.has(scope),
      `El scope '${scope}' de ${file} no existe en ROLE_PERMISSIONS_MAP: la ruta seria inaccesible`,
    );
  }
  assertions.push(`Los ${routeScopes.length} scopes declarados en las rutas existen en el catalogo RBAC`);

  // 2. La cookie de refresh debe poder leerse del encabezado `Cookie`.
  assert.strictEqual(readCookieValue(undefined, '__Host-oa_rt'), '');
  assert.strictEqual(readCookieValue('', '__Host-oa_rt'), '');
  assert.strictEqual(
    readCookieValue('otra=1; __Host-oa_rt=abc123; mas=2', '__Host-oa_rt'),
    'abc123',
  );
  assert.strictEqual(readCookieValue('otra=1', '__Host-oa_rt'), '');
  assert.strictEqual(
    readCookieValue('__Host-oa_rt=con%20espacios', '__Host-oa_rt'),
    'con espacios',
  );
  assert.strictEqual(
    readCookieValue(['__Host-oa_rt=primero', 'extra=1'], '__Host-oa_rt'),
    'primero',
  );
  assertions.push('La cookie __Host-oa_rt se lee correctamente del encabezado Cookie');

  console.log('\n=== PRUEBA DE FUEGO: CATALOGO DE PERMISOS Y COOKIE DE SESION ===');
  for (const assertion of assertions) {
    console.log(`  [OK] ${assertion}`);
  }
  console.log(`\nRESULTADO: ${assertions.length}/${assertions.length} grupos de aserciones APROBADOS`);
}

main();
