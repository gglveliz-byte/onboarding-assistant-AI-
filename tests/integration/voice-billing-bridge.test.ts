/**
 * @archivo tests/integration/voice-billing-bridge.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego del Puente Perezoso hacia el Modulo de Cobros)
 * @proposito
 *   Certifica que el gateway de voz y el modulo de cobros queden desacoplados en el ARRANQUE. El
 *   gateway necesita el puerto de facturacion para cobrar cada pulso, pero construirlo de forma
 *   anticipada ataria el arranque a que el manifiesto de cobros se hubiera ejecutado antes: una
 *   dependencia de orden que solo se manifiesta en produccion y con un mensaje criptico. La prueba
 *   verifica contra el contenedor real que crear el puente NO exige que el puerto exista, que usarlo
 *   sin registrarlo falla con un mensaje que nombra al modulo responsable, y que una vez registrado
 *   delega las tres operaciones exactamente como el contrato del nucleo espera.
 *
 * @resumen_contenido
 *   - Bloque `verifyDeferredResolution()`: Creacion sin registro y fallo explicativo al usarlo.
 *   - Bloque `verifyDelegation()`: Delegacion exacta de las tres operaciones del puerto.
 *   - Bloque `verifyBootDiagnostics()`: Comprobacion de disponibilidad sin instanciar.
 *
 * @dependencias_internas
 *   - `createLazyBillingPort()` y `hasBillingPort()` (`src/modules/05-voice-realtime-gateway/infrastructure/`).
 *   - `DependencyContainer` y `DI_TOKENS` (`src/shared/container/di-container.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba de cableado en memoria: el cobro real lo cubre la suite de facturacion).
 */

import * as assert from 'node:assert';
import { DependencyContainer, DI_TOKENS } from '../../src/shared/container/di-container';
import { createLazyBillingPort, hasBillingPort } from '../../src/modules/05-voice-realtime-gateway/infrastructure/billing-port.lazy-proxy';
import type { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

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

/**
 * Construye un puerto de facturacion falso que registra cada llamada recibida.
 *
 * @returns Puerto falso y el registro de invocaciones.
 */
function buildFakeBillingPort(): {
  readonly port: IBillingWhopPort;
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
} {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];

  const port: IBillingWhopPort = {
    checkOrganizationSolvency: async (organizationId: string) => {
      calls.push({ method: 'checkOrganizationSolvency', args: [organizationId] });
      return {
        ok: true,
        snapshot: {
          availableMinutes: '42.000000',
          creditBalanceUsd: '7.000000',
          effectiveRatePerMinuteUsd: '0.166700',
          planCode: 'PLAN_30',
          canStartSession: true,
          blockedReason: null,
        },
      };
    },
    deductVoiceSessionSlice: async (organizationId: string, voiceSessionId: string, elapsedSeconds: number) => {
      calls.push({ method: 'deductVoiceSessionSlice', args: [organizationId, voiceSessionId, elapsedSeconds] });
      return {
        ok: true,
        deduction: {
          coveredMinutes: '0.500000',
          overageMinutes: '0.000000',
          overageCostUsd: '0.000000',
          remainingIncludedMinutes: '41.500000',
          remainingCreditUsd: '7.000000',
          shouldTerminateSession: false,
          ledgerEntryId: 'asiento-puente',
        },
      };
    },
    grantPromotionalMinutes: async (organizationId: string, minutesToGrant: string, reason: string, grantedBySuperAdminId: string) => {
      calls.push({ method: 'grantPromotionalMinutes', args: [organizationId, minutesToGrant, reason, grantedBySuperAdminId] });
      return { ok: true, remainingIncludedMinutes: '52.000000', ledgerEntryId: 'asiento-regalo' };
    },
  };

  return { port, calls };
}

/** Verifica que el puente se cree sin el puerto registrado y falle con un mensaje util. */
function verifyDeferredResolution(): void {
  const container = new DependencyContainer();

  check(!hasBillingPort(container), 'Sin registrar, el contenedor no debe declarar el puerto de cobros disponible');

  // La creacion del puente NO debe lanzar: si lo hiciera, el gateway ataria su arranque al modulo 04.
  const bridge = createLazyBillingPort(container);
  check(bridge !== null && bridge !== undefined, 'El puente debe poder construirse sin el puerto registrado');

  check(hasBillingPort(container) === false, 'Construir el puente no debe registrar nada por si mismo');

  let capturedError: unknown = null;
  try {
    void bridge.checkOrganizationSolvency('00000000-0000-4000-8000-00000000b111');
  } catch (error) {
    capturedError = error;
  }
  check(capturedError instanceof Error, 'Usar el puente sin el modulo de cobros debe fallar de forma explicita');
  check(
    capturedError instanceof Error && capturedError.message.includes('registerBillingWhopModule'),
    'El mensaje debe nombrar el manifiesto responsable para que el fallo sea accionable'
  );
  check(
    capturedError instanceof Error && capturedError.message.includes('Modulo 04'),
    'El mensaje debe identificar el modulo que falta'
  );
}

/** Verifica que una vez registrado el puerto, las tres operaciones se deleguen sin alteracion. */
async function verifyDelegation(): Promise<void> {
  const container = new DependencyContainer();
  const bridge = createLazyBillingPort(container);
  const billingDoubles = buildFakeBillingPort();

  // El registro ocurre DESPUES de construir el puente: exactamente el escenario que la resolucion
  // perezosa debe soportar sin que el orden de arranque importe.
  container.registerInstance(DI_TOKENS.BillingDeductionPort, billingDoubles.port);
  check(hasBillingPort(container), 'Tras registrarlo, el contenedor debe declarar el puerto disponible');

  const solvency = await bridge.checkOrganizationSolvency('org-1');
  check(solvency.ok, 'La consulta de solvencia debe resolverse a traves del puente');
  check(
    solvency.ok && solvency.snapshot.availableMinutes === '42.000000',
    'La instantanea debe llegar sin alteracion a traves del puente'
  );
  check(
    billingDoubles.calls.some((call) => call.method === 'checkOrganizationSolvency'),
    'La llamada debe llegar al puerto registrado, no al puente'
  );
  check(
    billingDoubles.calls[0]?.args[0] === 'org-1',
    'El identificador de organizacion debe propagarse intacto'
  );

  const deduction = await bridge.deductVoiceSessionSlice('org-2', 'sesion-9', 30);
  check(deduction.ok, 'La deduccion debe resolverse a traves del puente');
  check(
    deduction.ok && deduction.deduction.ledgerEntryId === 'asiento-puente',
    'El asiento contable devuelto por el modulo de cobros debe llegar intacto'
  );
  const deductionCall = billingDoubles.calls.find((call) => call.method === 'deductVoiceSessionSlice');
  check(deductionCall?.args[0] === 'org-2', 'La organizacion debe propagarse a la deduccion');
  check(deductionCall?.args[1] === 'sesion-9', 'La sesion de voz debe propagarse a la deduccion');
  check(deductionCall?.args[2] === 30, 'Los segundos transcurridos deben propagarse sin redondear');

  const granted = await bridge.grantPromotionalMinutes('org-3', '10.000000', 'Compensacion por incidencia', 'admin-1');
  check(granted.ok, 'El otorgamiento de minutos debe resolverse a traves del puente');
  const grantCall = billingDoubles.calls.find((call) => call.method === 'grantPromotionalMinutes');
  check(grantCall?.args[1] === '10.000000', 'Los minutos a otorgar deben propagarse en formato decimal fijo');
  check(grantCall?.args[2] === 'Compensacion por incidencia', 'El motivo del otorgamiento debe propagarse para la auditoria');
  check(grantCall?.args[3] === 'admin-1', 'El operador que autoriza debe propagarse para la auditoria');

  check(billingDoubles.calls.length === 3, `Deben registrarse exactamente tres llamadas (obtenido: ${billingDoubles.calls.length})`);

  const secondBridge = createLazyBillingPort(container);
  const secondSolvency = await secondBridge.checkOrganizationSolvency('org-4');
  check(secondSolvency.ok, 'Un segundo puente sobre el mismo contenedor debe funcionar igualmente');
  check(billingDoubles.calls.length === 4, 'El segundo puente debe delegar en el mismo puerto registrado');
}

/** Verifica que el diagnostico de arranque no instancie el modulo de cobros. */
function verifyBootDiagnostics(): void {
  const emptyContainer = new DependencyContainer();
  check(!hasBillingPort(emptyContainer), 'Un contenedor vacio no debe declarar el puerto de cobros');

  const filledContainer = new DependencyContainer();
  filledContainer.registerInstance(DI_TOKENS.BillingDeductionPort, buildFakeBillingPort().port);
  check(hasBillingPort(filledContainer), 'Un contenedor con el puerto registrado debe declararlo disponible');

  const parent = new DependencyContainer();
  parent.registerInstance(DI_TOKENS.BillingDeductionPort, buildFakeBillingPort().port);
  const child = parent.createScope();
  check(hasBillingPort(child), 'Un contenedor hijo debe ver el puerto registrado en su contenedor padre');

  const emptyParent = new DependencyContainer();
  const orphanChild = emptyParent.createScope();
  check(!hasBillingPort(orphanChild), 'Un contenedor hijo sin el puerto en su padre no debe declararlo disponible');
}

/** Ejecuta los tres bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL PUENTE PEREZOSO HACIA EL MODULO DE COBROS (PARTE 13)');
  console.log('='.repeat(96));

  verifyDeferredResolution();
  console.log('[1/3] Creacion sin registro y fallo explicativo al usarlo: APROBADO.');

  await verifyDelegation();
  console.log('[2/3] Delegacion exacta de las tres operaciones del puerto: APROBADO.');

  verifyBootDiagnostics();
  console.log('[3/3] Diagnostico de arranque sin instanciar el modulo de cobros: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
