/**
 * @archivo tests/integration/metering-billing-failure.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de la Perdida de Cobro ante Fallo)
 * @proposito
 *   Verifica que un fallo del cobro **no haga desaparecer el tramo consumido**. Es la prueba que
 *   protege el dinero de una fuga silenciosa medida en la auditoria: la marca de ultimo cobro avanzaba
 *   **antes** de intentar la deduccion, de modo que un tramo fallido quedaba marcado como ya consumido
 *   y se volvia incobrable para siempre, porque la liquidacion final calcula su remanente justamente
 *   desde esa marca. Y como ademas la sesion se cortaba, tampoco habia un pulso posterior que lo
 *   recuperara: los segundos no cobrados desaparecian sin que ningun registro lo delatara.
 *
 *   La prueba comprueba tambien la segunda mitad del defecto: que el pulso **reutilice su propia
 *   conexion** en lugar de tomar una segunda del pool mientras la primera sigue retenida. Con el maximo
 *   configurado, eso agotaba el pool a partir de unas pocas sesiones concurrentes —medido: siete de
 *   cincuenta cobros perdidos y casi dos minutos de consumo regalados— y ademas perdia el contexto de
 *   inquilino, porque una conexion nueva no lo tiene.
 *
 * @resumen_contenido
 *   - Bloque `verifyFailedChargeKeepsItsSlice()`: El tramo fallido sigue siendo cobrable.
 *   - Bloque `verifyFinalSettlementRecoversTheSlice()`: La liquidacion final cobra lo que quedo pendiente.
 *   - Bloque `verifyCallerConnectionIsReused()`: El pulso pasa su conexion en lugar de abrir otra.
 *   - Bloque `verifyConfirmedChargeAdvancesTheMark()`: Un cobro correcto si avanza la marca.
 *
 * @dependencias_internas
 *   - `createVoiceSessionMeteringService()` (`src/modules/05-voice-realtime-gateway/application/voice-session-metering.service.ts`).
 *   - `METERING_TICK_SECONDS` (mismo archivo).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas). El servicio se ejercita con dobles, sin tocar servicios.
 *
 * @tablas_bd_o_redis
 *   - Ninguna: el puerto de facturacion y el almacen de sesiones se sustituyen por dobles que registran
 *     las llamadas, de modo que la prueba mide el COMPORTAMIENTO y no el estado de la base de datos.
 */

import * as assert from 'node:assert';
import type { PoolClient } from 'pg';
import {
  createVoiceSessionMeteringService,
  METERING_TICK_SECONDS,
  type VoiceSessionMeteringService,
} from '../../src/modules/05-voice-realtime-gateway/application/voice-session-metering.service';
import type { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';
import type { VoiceSessionMeteringStore } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store';

/** Organizacion de la prueba. */
const TEST_ORG_ID = '00000000-0000-4000-8000-0000000f0001';

/** Proyecto de la prueba. */
const TEST_PROJECT_ID = '00000000-0000-4000-8000-0000000f0002';

/** Sesion de voz de la prueba. */
const TEST_SESSION_ID = 'sesion-fallo-de-cobro';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/** Deduccion solicitada al puerto de facturacion. */
interface RecordedDeduction {
  /** Segundos declarados en la solicitud. */
  readonly elapsedSeconds: number;
  /** Conexion del llamador recibida, si la hubo. */
  readonly callerClient: PoolClient | undefined;
}

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
 * Construye un doble del cliente transaccional que se identifica a si mismo.
 *
 * La identidad importa: es lo que permite comprobar que el servicio paso **su propia** conexion.
 *
 * @param etiqueta - Nombre con el que el cliente se identifica.
 * @returns Cliente falso con el contrato minimo consumido.
 */
function buildFakeClient(etiqueta: string): PoolClient {
  return {
    query: async () => ({ rows: [], rowCount: 1 }),
    release: () => undefined,
    etiquetaDePrueba: etiqueta,
  } as unknown as PoolClient;
}

/**
 * Construye el puerto de facturacion con un guion de resultados por orden de llamada.
 *
 * @param resultados - Secuencia de exitos y fallos. El ultimo valor se repite si hay mas llamadas.
 * @returns Puerto falso y el registro de deducciones solicitadas.
 */
function buildFakeBillingPort(resultados: readonly boolean[]): {
  readonly port: IBillingWhopPort;
  readonly deductions: RecordedDeduction[];
} {
  const deductions: RecordedDeduction[] = [];

  const port: IBillingWhopPort = {
    checkOrganizationSolvency: async () => ({
      ok: true,
      snapshot: {
        availableMinutes: '10.000000',
        creditBalanceUsd: '0.000000',
        effectiveRatePerMinuteUsd: '0.166700',
        planCode: 'PLAN_30',
        canStartSession: true,
        blockedReason: null,
      },
    }),
    deductVoiceSessionSlice: async (
      _organizationId: string,
      _voiceSessionId: string,
      elapsedSeconds: number,
      callerClient?: PoolClient
    ) => {
      deductions.push({ elapsedSeconds, callerClient });
      const indice = Math.min(deductions.length - 1, resultados.length - 1);
      if (resultados[indice] !== true) {
        return {
          ok: false,
          code: 'PERSISTENCE_UNAVAILABLE' as const,
          reason: 'El libro mayor no responde.',
          retryable: true,
        };
      }
      const covered = Math.min(elapsedSeconds / 60, 1);
      const overage = Math.max(0, elapsedSeconds / 60 - covered);
      return {
        ok: true,
        deduction: {
          coveredMinutes: covered.toFixed(6),
          overageMinutes: overage.toFixed(6),
          overageCostUsd: (overage * 0.1667).toFixed(6),
          remainingIncludedMinutes: '10.000000',
          remainingCreditUsd: '0.000000',
          shouldTerminateSession: false,
          ledgerEntryId: `asiento-${deductions.length}`,
        },
      };
    },
    grantPromotionalMinutes: async () => ({ ok: true, remainingIncludedMinutes: '10.000000', ledgerEntryId: 'asiento-x' }),
  };

  return { port, deductions };
}

/**
 * Construye un doble del almacen de totales de sesion.
 *
 * @returns Almacen falso con el contrato minimo consumido.
 */
function buildFakeStore(): VoiceSessionMeteringStore {
  return {
    persistTotals: async () => undefined,
  } as unknown as VoiceSessionMeteringStore;
}

/**
 * Construye el servicio con el puerto y el almacen sustituidos.
 *
 * @param resultados - Secuencia de exitos y fallos del cobro.
 * @returns Servicio listo para ejercitar, el registro de deducciones y el cliente del pulso.
 */
function buildService(resultados: readonly boolean[]): {
  readonly service: VoiceSessionMeteringService;
  readonly deductions: RecordedDeduction[];
  readonly client: PoolClient;
} {
  const { port, deductions } = buildFakeBillingPort(resultados);
  const service = createVoiceSessionMeteringService({
    billingPort: port,
    meteringStore: buildFakeStore(),
  } as unknown as Parameters<typeof createVoiceSessionMeteringService>[0]);
  return { service, deductions, client: buildFakeClient('conexion-del-pulso') };
}

/**
 * Espera a que transcurra al menos un pulso completo de facturacion.
 *
 * @param pulsos - Numero de pulsos que se desean dejar transcurrir.
 */
async function esperarPulsos(pulsos: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, METERING_TICK_SECONDS * 1000 * pulsos + 250));
}

/** Verifica que el tramo fallido siga siendo cobrable, en lugar de perderse para siempre. */
async function verifyFailedChargeKeepsItsSlice(): Promise<void> {
  const { service, deductions, client } = buildService([false, true]);
  service.registerSession(TEST_ORG_ID, TEST_PROJECT_ID, TEST_SESSION_ID);

  await esperarPulsos(1);
  const fallido = await service.runTick(TEST_SESSION_ID, { client, sendFrameToClient: () => undefined });

  check(fallido.shouldTerminate === true, 'Un fallo del cobro debe cortar la sesion para no consumir gratis');
  check(fallido.terminationReason?.startsWith('FACTURACION_NO_DISPONIBLE') === true, 'El corte debe declarar el motivo');
  check(deductions.length === 1, 'El pulso debe haber intentado el cobro una vez');

  // LA ASERCION CENTRAL: el tramo no se cobro, de modo que debe seguir pendiente. Si la marca de ultimo
  // cobro hubiera avanzado pese al fallo, la liquidacion final no lo recuperaria.
  const resumen = service.getSessionSummary(TEST_SESSION_ID);
  check(
    resumen?.billedMinutes === '0.000000',
    `Un cobro fallido NO debe sumar minutos facturados (obtenido: ${String(resumen?.billedMinutes)})`
  );
}

/** Verifica que el tramo perdido se recupere de verdad en un cobro posterior. */
async function verifyFinalSettlementRecoversTheSlice(): Promise<void> {
  // El guion es: primer pulso FALLA, segundo pulso acierta. Lo que se mide es **cuanto tiempo se cobra
  // en total**, y esa es la unica medicion que distingue las dos versiones del codigo.
  //
  // Se deja constancia de un error propio: la primera version de este bloque afirmaba que «la
  // liquidacion final llama al cobro», y se comprobo que **no distinguia** —con el defecto presente, la
  // liquidacion inmediata encontraba un remanente cercano a cero y tampoco llamaba, de modo que la
  // prueba pasaba en ambos casos y no protegia nada—. La causa es que `settleAndClose` calcula su
  // remanente como `lastBilledAtMs - pendingSeconds * 1000`, de modo que hay DOS campos capaces de
  // recuperar el tramo y avanzar solo uno no siempre se nota de inmediato. Medir el total si lo nota.
  const { service, deductions, client } = buildService([false, true]);
  service.registerSession(TEST_ORG_ID, TEST_PROJECT_ID, TEST_SESSION_ID);
  const contexto = { client, sendFrameToClient: () => undefined };

  await esperarPulsos(1);
  const fallido = await service.runTick(TEST_SESSION_ID, contexto);
  check(fallido.shouldTerminate === true, 'El primer pulso debe fallar y cortar la sesion');

  // LA LIQUIDACION ES INMEDIATA, sin dejar transcurrir otro pulso. Esa demora es la que decide si la
  // prueba sirve: con un pulso de mas, el intervalo siguiente recalcula su tiempo desde la marca y el
  // total converge, de modo que la perdida queda enmascarada y la prueba pasa en ambas versiones. Se
  // comprobo midiendo: con la demora, las dos versiones cobraban 30 s; sin ella, la defectuosa cobra
  // **15 s de 30** y la corregida cobra los 30.
  await service.settleAndClose(TEST_SESSION_ID, contexto);

  const segundosFallidos = deductions[0]?.elapsedSeconds ?? 0;
  const segundosRecuperados = deductions.slice(1).reduce((total, d) => total + d.elapsedSeconds, 0);
  const totalCobrado = deductions.reduce((total, d) => total + d.elapsedSeconds, 0);

  check(segundosFallidos >= METERING_TICK_SECONDS, 'El primer intento debio cubrir al menos un pulso');

  // LA ASERCION QUE DISTINGUE: el tiempo del intento fallido NO puede desaparecer. Con el defecto, la
  // marca de ultimo cobro avanzaba pese al fallo y ese tramo se volvia incobrable para siempre.
  check(
    segundosRecuperados >= segundosFallidos,
    `El tramo del cobro fallido DEBE recuperarse despues: se recuperaron ${segundosRecuperados}s de ${segundosFallidos}s`
  );
  check(
    totalCobrado >= METERING_TICK_SECONDS * 2,
    `El total cobrado debe cubrir los dos tramos transcurridos (obtenido: ${totalCobrado}s)`
  );
}

/** Verifica que el pulso entregue su propia conexion en lugar de dejar que se abra otra. */
async function verifyCallerConnectionIsReused(): Promise<void> {
  const { service, deductions, client } = buildService([true]);
  service.registerSession(TEST_ORG_ID, TEST_PROJECT_ID, TEST_SESSION_ID);

  await esperarPulsos(1);
  await service.runTick(TEST_SESSION_ID, { client, sendFrameToClient: () => undefined });

  // Sin esto, la deduccion tomaba una segunda conexion del pool mientras el pulso retenia la primera:
  // es lo que agotaba el pool a partir de unas pocas sesiones concurrentes.
  check(deductions.length === 1, 'El pulso debe haber solicitado la deduccion');
  check(
    deductions[0]?.callerClient === client,
    'La deduccion DEBE recibir la conexion del pulso, no abrir una propia'
  );
  check(
    (deductions[0]?.callerClient as unknown as { etiquetaDePrueba?: string })?.etiquetaDePrueba === 'conexion-del-pulso',
    'La conexion entregada debe ser exactamente la del pulso'
  );
}

/** Verifica que un cobro confirmado si haga avanzar la marca y sume los minutos. */
async function verifyConfirmedChargeAdvancesTheMark(): Promise<void> {
  const { service, deductions, client } = buildService([true]);
  service.registerSession(TEST_ORG_ID, TEST_PROJECT_ID, TEST_SESSION_ID);

  await esperarPulsos(1);
  const confirmado = await service.runTick(TEST_SESSION_ID, { client, sendFrameToClient: () => undefined });

  check(deductions.length === 1, 'Un cobro confirmado debe haberse solicitado');
  check(confirmado.shouldTerminate === false, 'Un cobro confirmado no debe cortar la sesion');

  const resumen = service.getSessionSummary(TEST_SESSION_ID);
  const minutos = Number(resumen?.billedMinutes ?? '0');
  check(
    minutos > 0,
    `Un cobro confirmado SI debe sumar minutos facturados (obtenido: ${String(resumen?.billedMinutes)})`
  );

  // Y un segundo pulso inmediato no debe volver a cobrar el mismo tramo ya confirmado.
  const inmediato = await service.runTick(TEST_SESSION_ID, { client, sendFrameToClient: () => undefined });
  check(inmediato.billedSeconds === 0, 'Un pulso inmediato no debe volver a cobrar el tramo ya confirmado');
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE LA PERDIDA DE COBRO ANTE FALLO DEL LIBRO MAYOR');
  console.log('='.repeat(96));

  await verifyFailedChargeKeepsItsSlice();
  console.log('[1/4] Un cobro fallido NO hace desaparecer el tramo consumido: APROBADO.');

  await verifyFinalSettlementRecoversTheSlice();
  console.log('[2/4] La liquidacion final recupera el tramo pendiente: APROBADO.');

  await verifyCallerConnectionIsReused();
  console.log('[3/4] El pulso entrega su conexion en lugar de abrir una segunda: APROBADO.');

  await verifyConfirmedChargeAdvancesTheMark();
  console.log('[4/4] Un cobro confirmado si avanza la marca y no se recobra: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('RESULTADO: FALLIDO.');
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });


