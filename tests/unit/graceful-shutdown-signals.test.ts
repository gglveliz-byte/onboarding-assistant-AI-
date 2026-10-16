/**
 * @archivo tests/unit/graceful-shutdown-signals.test.ts
 * @modulo Tests Unitarios (Bootstrap Graceful Shutdown - C2-06)
 * @proposito
 *   Verifica de forma estricta que la concurrencia de señales de proceso (SIGTERM / SIGINT)
 *   no interrumpa el drenado en curso, garantizando que una segunda señal espere a la
 *   misma promesa inFlightShutdown sin salir prematuramente.
 */

import { installGracefulShutdown, type NodePoolRuntime } from '../../src/bootstrap/bootstrap-runtime';
import type { BootstrappedSystem } from '../../src/bootstrap/module-autoloader';

async function runTest(): Promise<void> {
  const logs: string[] = [];
  const logMock = (msg: string, meta?: Readonly<Record<string, unknown>>) => {
    logs.push(`${msg} ${meta ? JSON.stringify(meta) : ''}`);
  };

  let drainExecutedCount = 0;
  let drainFinished = false;

  const mockSystem = {
    eventBus: { close: () => {} },
    redisClient: { close: async () => {} },
    databasePool: { close: async () => {} },
  } as unknown as BootstrappedSystem;

  const mockRuntime: NodePoolRuntime = {
    nodePoolRole: 'TEST_POOL',
    system: mockSystem,
    listeningPorts: [9999],
    startedAtMs: Date.now() - 5000,
  };

  const shutdownFn = installGracefulShutdown(
    mockRuntime,
    {
      drainInFlightWork: async (_remainingMs) => {
        drainExecutedCount++;
        // Simular trabajo de liquidacion contable que toma 150ms
        await new Promise((resolve) => setTimeout(resolve, 150));
        drainFinished = true;
      },
    },
    logMock,
    1000
  );

  const startMs = Date.now();

  // Disparar senal 1
  const promise1 = shutdownFn('SIGTERM');

  // Disparar senal 2 mientras la senal 1 esta a mitad del drenado (a los 30ms)
  await new Promise((r) => setTimeout(r, 30));
  if (drainFinished) {
    throw new Error('FALLO: El drenado no deberia haber terminado todavia a los 30ms.');
  }

  const promise2 = shutdownFn('SIGINT');

  // Ambas promesas deben esperar al drenado completo
  const [report1, report2] = await Promise.all([promise1, promise2]);
  const elapsedMs = Date.now() - startMs;

  // Aserciones rigurosas
  if (drainExecutedCount !== 1) {
    throw new Error(`FALLO: El drenado debe ejecutarse exactamente 1 vez, se ejecuto ${drainExecutedCount} veces.`);
  }

  if (!drainFinished) {
    throw new Error('FALLO: El drenado debio haber concluido antes de resolver los reportes.');
  }

  if (elapsedMs < 140) {
    throw new Error(`FALLO: El cierre termino demasiado rapido (${elapsedMs}ms), senal concurrente corto el proceso.`);
  }

  if (report1 !== report2) {
    throw new Error('FALLO: La segunda senal debe retornar la MISMA instancia de reporte que la primera.');
  }

  if (report1.errors.length > 0) {
    throw new Error(`FALLO: Hubo errores inesperados en el reporte: ${report1.errors.join(', ')}`);
  }

  const loggedRepeatedSignal = logs.some((l) => l.includes('Cierre ya en curso'));
  if (!loggedRepeatedSignal) {
    throw new Error('FALLO: No se registro en bitacora la advertencia de senal repetida en curso.');
  }

  process.stdout.write('PASS tests/unit/graceful-shutdown-signals.test.ts (C2-06 verificado: 0 interrupciones prematuras)\n');
}

void runTest().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
