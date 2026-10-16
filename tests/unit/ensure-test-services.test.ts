/**
 * @archivo tests/unit/ensure-test-services.test.ts
 * @modulo Tests Unitarios (Infraestructura de Pruebas - C1-53)
 * @proposito
 *   Verifica que la utilidad de pre-vuelo de servicios detecta adecuadamente puertos abiertos
 *   y cerrados y confirma la disponibilidad de Redis y PostgreSQL sin producir falsos positivos.
 */

import { isPortOpen, ensureRedisRunning, ensureDatabaseReachable } from '../../scripts/ensure-test-services';

async function runTest(): Promise<void> {
  // 1. Probar un puerto que garantizadamente esta cerrado (ej. 59999)
  const closedPortOpen = await isPortOpen(59999, '127.0.0.1', 200);
  if (closedPortOpen) {
    throw new Error('FALLO: isPortOpen reporto puerto abierto en un puerto cerrado (59999).');
  }

  // 2. Probar que Redis esta activo y responde en el puerto 6379
  const redisRunning = await ensureRedisRunning(6379);
  if (!redisRunning) {
    throw new Error('FALLO: ensureRedisRunning no pudo verificar Redis en 6379.');
  }

  // 3. Probar que PostgreSQL responde ping
  const dbOk = await ensureDatabaseReachable();
  if (!dbOk) {
    throw new Error('FALLO: ensureDatabaseReachable no pudo conectar con PostgreSQL.');
  }

  process.stdout.write('PASS tests/unit/ensure-test-services.test.ts (C1-53 verificado: deteccion real y auto-arranque)\n');
}

void runTest().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
