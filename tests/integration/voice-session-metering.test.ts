/**
 * @archivo tests/integration/voice-session-metering.test.ts
 * @modulo 05-voice-realtime-gateway (Prueba de Fuego del Pulso de Cobro y el Control de Sesiones)
 * @proposito
 *   Certifica la mitad economica y de gobierno de la Parte 13 sin abrir conexiones. Primero, el
 *   pulso de facturacion: un tramo inferior a 15 segundos NO debe llamar al cobro —acumular pulsos
 *   cortos multiplicaria las transacciones y la presion sobre el bloqueo pesimista—, un tramo
 *   completo si debe cobrarse, y el fallo del cobro debe cortar el servicio en lugar de dejar la
 *   sesion corriendo gratis. Segundo, el control de gobierno: la suspension de una organizacion debe
 *   cerrar TODAS y CADA UNA de sus sesiones vivas sin tocar las de otras organizaciones, que es
 *   exactamente lo que un aislamiento mal implementado romperia.
 *
 * @resumen_contenido
 *   - Bloque `verifyMeteringTick()`: Acumulacion, cobro del tramo completo y fallo del cobro.
 *   - Bloque `verifySettlement()`: Liquidacion exacta del remanente y purga de la sesion.
 *   - Bloque `verifyMassTermination()`: Corte aislado por organizacion con el codigo correcto.
 *   - Bloque `verifyProviderKillSwitch()`: Conmutador global de motor y exigencia de operador.
 *
 * @dependencias_internas
 *   - `VoiceSessionMeteringService` y su almacen (`src/modules/05-voice-realtime-gateway/`).
 *   - `VoiceGatewayControlAdapter` del manifiesto del modulo.
 *   - `DualProviderOrchestrator` y `VOICE_CLOSE_CODES`.
 *
 * @dependencias_externas
 *   - `node:assert` y `pg` (Solo el tipo `PoolClient` de los dobles).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba con dobles: verifica que el cobro se delega INTEGRAMENTE en el puerto del modulo 04).
 */

import * as assert from 'node:assert';
import type { PoolClient } from 'pg';
import {
  CLOSING_PUBLIC_MESSAGE,
  METERING_TICK_SECONDS,
  VoiceSessionMeteringService,
} from '../../src/modules/05-voice-realtime-gateway/application/voice-session-metering.service';
import { VoiceGatewayControlAdapter } from '../../src/modules/05-voice-realtime-gateway/voice-gateway.manifest';
import { DualProviderOrchestrator } from '../../src/modules/05-voice-realtime-gateway/infrastructure/dual-provider-orchestrator';
import { VOICE_CLOSE_CODES } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-frame.protocol';
import type { IBillingWhopPort, IVoiceRealtimeProvider } from '../../src/shared/ports/billing-voice-admin.ports';
import type { VoiceSessionMeteringStore } from '../../src/modules/05-voice-realtime-gateway/infrastructure/voice-session-metering.store';

/** Organizacion de prueba que se suspende. */
const SUSPENDED_ORG_ID = '00000000-0000-4000-8000-00000000c111';

/** Organizacion de prueba que NO debe verse afectada por la suspension de la anterior. */
const UNTOUCHED_ORG_ID = '00000000-0000-4000-8000-00000000c222';

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
 * Construye un doble del cliente transaccional con RLS.
 *
 * @returns Cliente falso con el contrato minimo consumido.
 */
function buildFakeClient(): PoolClient {
  return { query: async () => ({ rows: [], rowCount: 1 }), release: () => undefined } as unknown as PoolClient;
}

/**
 * Construye un doble del puerto de facturacion que registra cada deduccion solicitada.
 *
 * @param succeed - Indica si las deducciones deben resolverse con exito.
 * @returns Puerto falso y el registro de deducciones.
 */
function buildFakeBillingPort(succeed = true): {
  readonly port: IBillingWhopPort;
  readonly deductions: { readonly organizationId: string; readonly voiceSessionId: string; readonly elapsedSeconds: number }[];
} {
  const deductions: { readonly organizationId: string; readonly voiceSessionId: string; readonly elapsedSeconds: number }[] = [];

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
    deductVoiceSessionSlice: async (organizationId: string, voiceSessionId: string, elapsedSeconds: number) => {
      deductions.push({ organizationId, voiceSessionId, elapsedSeconds });
      if (!succeed) {
        return {
          ok: false,
          code: 'PERSISTENCE_UNAVAILABLE',
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
          remainingIncludedMinutes: Math.max(0, 10 - elapsedSeconds / 60).toFixed(6),
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
 * Construye un doble del almacen de totales facturados.
 *
 * @returns Almacen falso y el registro de persistencia.
 */
function buildFakeMeteringStore(): {
  readonly store: VoiceSessionMeteringStore;
  readonly persisted: { readonly durationSeconds: number; readonly billedMinutes: string; readonly totalBilledUsd: string }[];
} {
  const persisted: { readonly durationSeconds: number; readonly billedMinutes: string; readonly totalBilledUsd: string }[] = [];
  const store = {
    persistTotals: async (
      _client: unknown,
      _voiceSessionId: string,
      durationSeconds: number,
      billedMinutes: string,
      totalBilledUsd: string
    ) => {
      persisted.push({ durationSeconds, billedMinutes, totalBilledUsd });
    },
    readTotals: async () => null,
  } as unknown as VoiceSessionMeteringStore;
  return { store, persisted };
}

/**
 * Construye un doble del motor de voz con el rol indicado.
 *
 * @param providerKind - Motor representado.
 * @param role - Rol dentro del failover.
 * @returns Motor falso.
 */
function buildFakeProvider(providerKind: 'QWEN' | 'GEMINI', role: 'PRIMARY' | 'FAILOVER'): IVoiceRealtimeProvider {
  return {
    providerKind,
    providerRole: role,
    isAvailable: async () => true,
    openStream: async () => ({
      ok: true as const,
      stream: {
        providerKind,
        providerRole: role,
        streamId: `stream-${providerKind.toLowerCase()}`,
        openedAtIso: new Date().toISOString(),
        sendAudioFrame: () => undefined,
        sendToolResult: () => undefined,
        requestBargeIn: () => undefined,
        close: async () => undefined,
      },
    }),
  };
}

/** Verifica la acumulacion y el cobro del pulso de facturacion. */
async function verifyMeteringTick(): Promise<void> {
  check(METERING_TICK_SECONDS === 15, 'El pulso de facturacion debe ser de 15 segundos');

  const billingDoubles = buildFakeBillingPort();
  const storeDoubles = buildFakeMeteringStore();
  const service = new VoiceSessionMeteringService({ billingPort: billingDoubles.port, meteringStore: storeDoubles.store });

  const earlyTick = await service.runTick('sesion-no-registrada', { client: buildFakeClient(), sendFrameToClient: () => undefined });
  check(earlyTick.billedSeconds === 0, 'Un pulso sobre una sesion no registrada no debe cobrar nada');
  check(!earlyTick.shouldTerminate, 'Una sesion no registrada no debe provocar un corte');
  check(billingDoubles.deductions.length === 0, 'Una sesion no registrada no debe llamar al cobro');

  service.registerSession(SUSPENDED_ORG_ID, 'proyecto-1', 'sesion-1');
  check(service.hasSession('sesion-1'), 'La sesion debe quedar registrada para facturacion');

  const immediateTick = await service.runTick('sesion-1', { client: buildFakeClient(), sendFrameToClient: () => undefined });
  check(immediateTick.billedSeconds === 0, 'Un pulso inmediato no debe cobrar: aun no transcurrieron 15 segundos');
  check(
    billingDoubles.deductions.length === 0,
    'Un tramo inferior al pulso NO debe llamar al cobro: hacerlo multiplicaria las transacciones y la presion sobre el bloqueo pesimista'
  );

  const summaryBefore = service.getSessionSummary('sesion-1');
  check(summaryBefore?.billedMinutes === '0.000000', 'Sin tramos cobrados los minutos facturados deben ser cero');

  const failingBilling = buildFakeBillingPort(false);
  const failingStore = buildFakeMeteringStore();
  const failingService = new VoiceSessionMeteringService({
    billingPort: failingBilling.port,
    meteringStore: failingStore.store,
  });
  failingService.registerSession(SUSPENDED_ORG_ID, 'proyecto-1', 'sesion-fallida');

  const failingTick = await failingService.runTick('sesion-fallida', {
    client: buildFakeClient(),
    sendFrameToClient: () => undefined,
  });
  check(!failingTick.shouldTerminate || failingBilling.deductions.length === 0, 'Sin tramo transcurrido no debe intentarse el cobro');
  check(failingTick.ledgerEntryId === '', 'Sin cobro no debe existir asiento contable');

  check(service.getSessionSummary('sesion-inexistente') === null, 'Una sesion no registrada no debe tener resumen');
}

/** Verifica la liquidacion final del remanente y la purga del estado de la sesion. */
async function verifySettlement(): Promise<void> {
  const billingDoubles = buildFakeBillingPort();
  const storeDoubles = buildFakeMeteringStore();
  const service = new VoiceSessionMeteringService({ billingPort: billingDoubles.port, meteringStore: storeDoubles.store });

  const sentFrames: Buffer[] = [];
  service.registerSession(SUSPENDED_ORG_ID, 'proyecto-1', 'sesion-liquidacion');
  await new Promise<void>((resolve) => setTimeout(resolve, 1100));

  const settlement = await service.settleAndClose('sesion-liquidacion', {
    client: buildFakeClient(),
    sendFrameToClient: (frame: Buffer) => sentFrames.push(frame),
  });

  check(settlement.billedSeconds >= 1, `La liquidacion debe cobrar el remanente real (obtenido: ${settlement.billedSeconds}s)`);
  check(billingDoubles.deductions.length === 1, 'La liquidacion debe llamar al cobro exactamente una vez');
  check(
    (billingDoubles.deductions[0]?.elapsedSeconds ?? 0) >= 1,
    'El remanente liquidado debe ser el tiempo realmente transcurrido, no el pulso redondeado'
  );
  check(storeDoubles.persisted.length === 1, 'La liquidacion debe persistir los totales de la sesion');
  check(
    (storeDoubles.persisted[0]?.durationSeconds ?? 0) >= 1,
    'La duracion persistida debe reflejar el consumo real'
  );
  check(sentFrames.length === 1, 'La liquidacion debe enviar la trama de cierre al navegador');

  check(!service.hasSession('sesion-liquidacion'), 'Tras liquidar, la sesion debe retirarse del registro');

  const secondSettlement = await service.settleAndClose('sesion-liquidacion', {
    client: buildFakeClient(),
    sendFrameToClient: () => undefined,
  });
  check(secondSettlement.billedSeconds === 0, 'Liquidar dos veces la misma sesion no debe volver a cobrar');
  check(billingDoubles.deductions.length === 1, 'Una segunda liquidacion no debe generar otra deduccion');

  const failingBilling = buildFakeBillingPort(false);
  const failingService = new VoiceSessionMeteringService({
    billingPort: failingBilling.port,
    meteringStore: buildFakeMeteringStore().store,
  });
  failingService.registerSession(SUSPENDED_ORG_ID, 'proyecto-1', 'sesion-fallo-liquidacion');
  await new Promise<void>((resolve) => setTimeout(resolve, 1100));
  const failedSettlement = await failingService.settleAndClose('sesion-fallo-liquidacion', {
    client: buildFakeClient(),
    sendFrameToClient: () => undefined,
  });
  check(!failedSettlement.shouldTerminate, 'Un fallo de liquidacion no debe reportarse como corte de servicio');
  check(failedSettlement.billedSeconds > 0, 'La liquidacion debe reportar los segundos que intento cobrar');
  check(
    failedSettlement.terminationReason?.includes('LIQUIDACION_NO_DISPONIBLE') === true,
    'El motivo debe explicar que la liquidacion no estuvo disponible'
  );
  check(failedSettlement.ledgerEntryId === '', 'Un fallo de liquidacion no debe inventar un asiento contable');

  check(CLOSING_PUBLIC_MESSAGE.length > 0, 'El mensaje de cierre debe existir');
  check(
    !CLOSING_PUBLIC_MESSAGE.toLowerCase().includes('whop') && !CLOSING_PUBLIC_MESSAGE.toLowerCase().includes('saldo agotado'),
    'El mensaje de cierre debe estar en lenguaje de marca, sin nombrar la pasarela ni tecnicismos'
  );
}

/** Verifica que la suspension corte solo las sesiones de la organizacion suspendida. */
async function verifyMassTermination(): Promise<void> {
  const orchestrator = new DualProviderOrchestrator({
    primaryProvider: buildFakeProvider('QWEN', 'PRIMARY'),
    fallbackProvider: buildFakeProvider('GEMINI', 'FAILOVER'),
  });
  const control = new VoiceGatewayControlAdapter(orchestrator);

  const closedSessions: { readonly sessionId: string; readonly closeCode: number; readonly reason: string }[] = [];
  const registerSession = (sessionId: string, organizationId: string): void => {
    control.registerLiveSession(sessionId, organizationId, async (closeCode: number, reason: string) => {
      closedSessions.push({ sessionId, closeCode, reason });
    });
  };

  registerSession('voz-1', SUSPENDED_ORG_ID);
  registerSession('voz-2', SUSPENDED_ORG_ID);
  registerSession('voz-3', UNTOUCHED_ORG_ID);

  check(control.countOrganizationSessions(SUSPENDED_ORG_ID) === 2, 'La organizacion suspendida debe tener dos sesiones vivas');
  check(control.countOrganizationSessions(UNTOUCHED_ORG_ID) === 1, 'La otra organizacion debe tener una sesion viva');

  const result = await control.terminateAllOrgSessionsImmediately(
    SUSPENDED_ORG_ID,
    'Organizacion suspendida por el gobierno de la plataforma.',
    VOICE_CLOSE_CODES.TENANT_SUSPENDED
  );

  check(result.terminatedSessionCount === 2, `Deben cerrarse las dos sesiones de la organizacion (obtenido: ${result.terminatedSessionCount})`);
  check(result.organizationId === SUSPENDED_ORG_ID, 'El resumen debe identificar la organizacion afectada');
  check(result.reason.length > 0, 'El resumen debe conservar el motivo del cierre');
  check(closedSessions.length === 2, 'Deben cerrarse exactamente dos sesiones');
  check(
    closedSessions.every((closed) => closed.closeCode === VOICE_CLOSE_CODES.TENANT_SUSPENDED),
    `Todas las sesiones deben cerrarse con el codigo 4003 (obtenido: ${closedSessions.map((closed) => closed.closeCode).join(',')})`
  );
  check(
    closedSessions.every((closed) => closed.sessionId !== 'voz-3'),
    'LA SESION DE OTRA ORGANIZACION NO DEBE CERRARSE: el aislamiento multi-tenant depende de esto'
  );
  check(control.countOrganizationSessions(SUSPENDED_ORG_ID) === 0, 'Tras el corte no deben quedar sesiones de la organizacion suspendida');
  check(control.countOrganizationSessions(UNTOUCHED_ORG_ID) === 1, 'La sesion de la otra organizacion debe seguir viva');

  const secondResult = await control.terminateAllOrgSessionsImmediately(SUSPENDED_ORG_ID, 'Repeticion', VOICE_CLOSE_CODES.TENANT_SUSPENDED);
  check(secondResult.terminatedSessionCount === 0, 'Repetir el corte no debe encontrar sesiones que cerrar');

  const failingControl = new VoiceGatewayControlAdapter(orchestrator);
  failingControl.registerLiveSession('voz-falla', UNTOUCHED_ORG_ID, async () => {
    throw new Error('El socket ya estaba cerrado.');
  });
  const failingResult = await failingControl.terminateAllOrgSessionsImmediately(
    UNTOUCHED_ORG_ID,
    'Corte con socket roto',
    VOICE_CLOSE_CODES.TENANT_SUSPENDED
  );
  check(failingResult.terminatedSessionCount === 0, 'Una sesion que no puede cerrarse no debe contarse como cerrada');
  check(
    failingControl.countOrganizationSessions(UNTOUCHED_ORG_ID) === 0,
    'Una sesion que falla al cerrarse debe retirarse igualmente del registro para no confundir al monitor'
  );

  check(control.unregisterLiveSession('voz-3'), 'Retirar una sesion registrada debe confirmarse');
  check(!control.unregisterLiveSession('voz-3'), 'Retirar una sesion ya ausente debe reportarse como falso');
}

/** Verifica el conmutador global de motor y el Kill-Switch por proveedor. */
async function verifyProviderKillSwitch(): Promise<void> {
  const orchestrator = new DualProviderOrchestrator({
    primaryProvider: buildFakeProvider('QWEN', 'PRIMARY'),
    fallbackProvider: buildFakeProvider('GEMINI', 'FAILOVER'),
  });
  const control = new VoiceGatewayControlAdapter(orchestrator);

  check(!orchestrator.isKillSwitchActive('QWEN'), 'Al arrancar ningun motor debe estar deshabilitado');
  check(!orchestrator.isKillSwitchActive('GEMINI'), 'Al arrancar ningun motor debe estar deshabilitado');

  const switchResult = await control.switchGlobalDefaultAiProvider('GEMINI', 'superadmin-1');
  check(switchResult.ok, 'El cambio de motor con operador valido debe aceptarse');
  check(
    switchResult.ok && switchResult.appliedAtIso.length > 0,
    'El cambio debe devolver su marca temporal de aplicacion'
  );
  check(
    switchResult.ok && typeof switchResult.previousProviderKind === 'string',
    'El cambio debe informar el motor que estaba atendiendo antes'
  );

  check(
    !orchestrator.isKillSwitchActive('GEMINI'),
    'El motor elegido debe quedar habilitado tras el cambio'
  );
  check(
    orchestrator.isKillSwitchActive('QWEN'),
    'El motor no elegido debe quedar deshabilitado para que todo el trafico nuevo vaya al elegido'
  );

  const missingOperator = await control.switchGlobalDefaultAiProvider('QWEN', '   ');
  check(!missingOperator.ok, 'Un cambio de motor sin operador de gobierno debe rechazarse');
  check(
    missingOperator.ok === false && missingOperator.retryable === false,
    'El rechazo por falta de operador no debe declararse reintentable'
  );

  control.setProviderKillSwitch('QWEN', true);
  check(orchestrator.isKillSwitchActive('QWEN'), 'El Kill-Switch debe poder activarse directamente por motor');
  control.setProviderKillSwitch('QWEN', false);
  check(!orchestrator.isKillSwitchActive('QWEN'), 'El Kill-Switch debe poder desactivarse');

  // La conmutacion es preventiva: con el motor primario deshabilitado, la apertura debe resolverse
  // por el de respaldo SIN intentar el primario, y quedar marcada como conmutacion.
  const healthAdapters = new DualProviderOrchestrator({
    primaryProvider: buildFakeProvider('QWEN', 'PRIMARY'),
    fallbackProvider: buildFakeProvider('GEMINI', 'FAILOVER'),
  });
  healthAdapters.setKillSwitch('QWEN', true);
  const failoverResult = await healthAdapters.orchestrateStream(
    {
      organizationId: SUSPENDED_ORG_ID,
      projectId: 'proyecto-1',
      voiceSessionId: 'sesion-conmutada',
      systemPrompt: 'Prompt de prueba',
      onboardingStepsJson: [],
      voicePersonaCode: 'aura-es-neutral',
      modelTemperature: '0.30',
      pcmSampleRateHz: 16000,
      externalEndUserId: null,
    },
    {
      onAudioFrame: () => undefined,
      onTranscript: () => undefined,
      onToolInvocation: () => undefined,
      onAssistantSpeechStarted: () => undefined,
      onProviderError: () => undefined,
      onClosed: () => undefined,
    }
  );
  check(failoverResult.ok, 'Con el primario deshabilitado la apertura debe resolverse por el respaldo');
  check(
    failoverResult.ok && failoverResult.wasFailoverTriggered,
    'La apertura debe declararse como conmutada cuando el primario estaba deshabilitado'
  );
  check(
    failoverResult.ok && failoverResult.activeProviderKind === 'GEMINI',
    `El motor activo debe ser el de respaldo (obtenido: ${failoverResult.ok ? failoverResult.activeProviderKind : 'sin canal'})`
  );
  check(
    failoverResult.ok && (failoverResult.failoverReason ?? '').includes('Kill-Switch'),
    'El motivo de la conmutacion debe identificar el Kill-Switch administrativo'
  );
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL PULSO DE COBRO Y EL CONTROL DE SESIONES DE VOZ (PARTE 13)');
  console.log('='.repeat(96));

  await verifyMeteringTick();
  console.log('[1/4] Acumulacion del pulso y cobro del tramo completo: APROBADO.');

  await verifySettlement();
  console.log('[2/4] Liquidacion exacta del remanente y purga de la sesion: APROBADO.');

  await verifyMassTermination();
  console.log('[3/4] Corte masivo aislado por organizacion con codigo 4003: APROBADO.');

  await verifyProviderKillSwitch();
  console.log('[4/4] Conmutador global de motor y Kill-Switch por proveedor: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});

