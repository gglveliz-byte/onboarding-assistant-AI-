/**
 * @archivo src/modules/05-voice-realtime-gateway/application/voice-session-metering.service.ts
 * @modulo 05-voice-realtime-gateway (Pulso Determinista de Facturacion y Liquidacion Final)
 * @proposito
 *   Cobra el consumo de una sesion de voz en pulsos de 15 segundos y liquida el remanente exacto al
 *   cerrarse el socket. El diseno responde a dos riesgos concretos: un temporizador basado en
 *   intervalos acumula deriva y, si el proceso se reinicia, se pierden minutos consumidos que nadie
 *   factura; por eso el pulso se calcula comparando el reloj contra la marca del ultimo cobro, de
 *   modo que un retraso del bucle se cobra igual en el siguiente pulso en lugar de perderse. Al
 *   cerrar, el remanente se liquida con su valor exacto —no redondeado al pulso— porque esos
 *   segundos ya se consumieron. Si la organizacion se queda sin fondos o alcanza su tope de gasto,
 *   el servicio ordena el cierre con el codigo `4002` y un mensaje cortes en lenguaje de marca.
 *
 * @resumen_contenido
 *   - Constantes `METERING_TICK_SECONDS` y `CLOSING_PUBLIC_MESSAGE`.
 *   - Interfaces `MeteringTickResult`, `MeteringSessionContext` y `MeteringDependencies`.
 *   - Clase `VoiceSessionMeteringService`:
 *       * `registerSession()`: Alta de la sesion con su marca temporal inicial.
 *       * `runTick()`: Cobro del tramo transcurrido desde el ultimo pulso.
 *       * `settleAndClose()`: Liquidacion exacta del remanente y orden de cierre.
 *       * `startTimer()` y `stopTimer()`: Temporizador determinista del pulso.
 *
 * @dependencias_internas
 *   - `IBillingWhopPort.deductVoiceSessionSlice()` (`src/shared/ports/billing-voice-admin.ports.ts`).
 *   - `PostgresVoiceSessionRepository` (`../infrastructure/postgres-voice-session.repository.ts`).
 *   - `VOICE_CLOSE_CODES` y `encodeSessionClosingFrame()` (`../infrastructure/voice-frame.protocol.ts`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de la conexion transaccional con RLS).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions` (`duration_seconds`, `billed_minutes`, `total_billed_cost_usd`).
 *   - PostgreSQL: `whop_subscriptions` y `usage_ledger` (A traves del puerto de facturacion).
 */

import type { PoolClient } from 'pg';
import type { IBillingWhopPort } from '../../../shared/ports/billing-voice-admin.ports';
import type { VoiceSessionMeteringStore } from '../infrastructure/voice-session-metering.store';
import { encodeSessionClosingFrame, VOICE_CLOSE_CODES } from '../infrastructure/voice-frame.protocol';

/** Segundos que abarca un pulso de facturacion. */
export const METERING_TICK_SECONDS = 15;

/**
 * Mensaje con el que el asistente se despide cuando el servicio se corta por falta de fondos.
 * Se redacta en lenguaje de marca y sin tecnicismos: el usuario final no debe leer "saldo agotado"
 * ni el nombre de ninguna pasarela de pago.
 */
export const CLOSING_PUBLIC_MESSAGE =
  'Hemos alcanzado el limite de uso de esta sesion. Para seguir, pide a tu administrador que amplie el plan o recargue saldo.';

/** Estado del cobro de una sesion de voz. */
interface MeteringSessionState {
  /** Organizacion que consume. */
  readonly organizationId: string;
  /** Proyecto de la sesion. */
  readonly projectId: string;
  /** Sesion de voz facturada. */
  readonly voiceSessionId: string;
  /** Marca del ultimo instante ya cobrado, en milisegundos. */
  lastBilledAtMs: number;
  /** Segundos acumulados pendientes de liquidar al cierre. */
  pendingSeconds: number;
  /** Minutos totales facturados en la sesion. */
  billedMinutes: string;
  /** Importe total facturado en la sesion, en USD. */
  totalBilledUsd: string;
  /** Identificador del temporizador activo, o `null` cuando no hay pulso en curso. */
  timerHandle: NodeJS.Timeout | null;
}

/** Resultado de un pulso de facturacion. */
export interface MeteringTickResult {
  /** Segundos efectivamente cobrados en este pulso. */
  readonly billedSeconds: number;
  /** Minutos cubiertos por la cuota incluida del periodo. */
  readonly coveredMinutes: string;
  /** Minutos que excedieron la cuota. */
  readonly overageMinutes: string;
  /** Importe del exceso cobrado en el pulso, en USD. */
  readonly overageCostUsd: string;
  /** Indica si la sesion debe cerrarse por falta de fondos o tope alcanzado. */
  readonly shouldTerminate: boolean;
  /** Motivo del corte cuando `shouldTerminate` es verdadero. */
  readonly terminationReason: string | null;
  /** Identificador del asiento contable registrado, vacio cuando no hubo consumo. */
  readonly ledgerEntryId: string;
}

/** Contexto necesario para cobrar un tramo de consumo. */
export interface MeteringSessionContext {
  /** Conexion transaccional con contexto RLS. */
  readonly client: PoolClient;
  /** Envio de la trama de cierre al navegador del usuario final. */
  readonly sendFrameToClient: (frame: Buffer) => void;
}

/** Dependencias del servicio de facturacion de sesiones. */
export interface MeteringDependencies {
  /** Puerto de facturacion del modulo 04: unica ruta autorizada de deduccion. */
  readonly billingPort: IBillingWhopPort;
  /** Almacen especializado en los totales facturados de la sesion. */
  readonly meteringStore: VoiceSessionMeteringStore;
}

/**
 * Servicio de facturacion por pulso de una sesion de voz.
 * Mantiene un estado por sesion y delega todo cobro en el puerto de facturacion del modulo 04.
 */
export class VoiceSessionMeteringService {
  private readonly dependencies: MeteringDependencies;
  private readonly sessions = new Map<string, MeteringSessionState>();

  /**
   * @param dependencies - Puerto de facturacion y almacen de totales de la sesion.
   */
  public constructor(dependencies: MeteringDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Registra una sesion en el servicio y arranca su marca temporal de cobro.
   *
   * @param organizationId - Organizacion que consume.
   * @param projectId - Proyecto de la sesion.
   * @param voiceSessionId - Sesion de voz facturada.
   */
  public registerSession(organizationId: string, projectId: string, voiceSessionId: string): void {
    this.sessions.set(voiceSessionId, {
      organizationId,
      projectId,
      voiceSessionId,
      lastBilledAtMs: Date.now(),
      pendingSeconds: 0,
      billedMinutes: '0.000000',
      totalBilledUsd: '0.000000',
      timerHandle: null,
    });
  }

  /**
   * Indica si una sesion ya esta registrada para facturacion.
   *
   * @param voiceSessionId - Sesion consultada.
   * @returns `true` cuando la sesion esta registrada.
   */
  public hasSession(voiceSessionId: string): boolean {
    return this.sessions.has(voiceSessionId);
  }

  /**
   * Devuelve el resumen acumulado de una sesion.
   *
   * @param voiceSessionId - Sesion consultada.
   * @returns Minutos e importe acumulados, o `null` cuando la sesion no esta registrada.
   */
  public getSessionSummary(voiceSessionId: string): { readonly billedMinutes: string; readonly totalBilledUsd: string } | null {
    const session = this.sessions.get(voiceSessionId);
    return session === undefined ? null : { billedMinutes: session.billedMinutes, totalBilledUsd: session.totalBilledUsd };
  }

  /**
   * Ejecuta un pulso de facturacion cobrando el tiempo transcurrido desde el ultimo cobro.
   * El tramo se calcula comparando el reloj contra la marca del ultimo cobro en lugar de asumir que
   * el temporizador desperto a tiempo: un retraso del bucle se cobra igual en el pulso siguiente, en
   * lugar de conceder minutos gratuitos por cada evento de retraso.
   *
   * @param voiceSessionId - Sesion que reporta el consumo.
   * @param context - Conexion transaccional y envio de tramas al navegador.
   * @returns Resultado del pulso.
   */
  public async runTick(voiceSessionId: string, context: MeteringSessionContext): Promise<MeteringTickResult> {
    const session = this.sessions.get(voiceSessionId);
    if (session === undefined) {
      return this.buildNoChargeResult(session === undefined);
    }

    const nowMs = Date.now();
    const elapsedSeconds = Math.floor((nowMs - session.lastBilledAtMs) / 1000);

    if (elapsedSeconds < METERING_TICK_SECONDS) {
      // Aun no se completo un pulso: se acumula para la liquidacion final sin llamar al cobro.
      session.pendingSeconds = elapsedSeconds;
      return this.buildNoChargeResult(false);
    }

    const deduction = await this.dependencies.billingPort.deductVoiceSessionSlice(
      session.organizationId,
      session.voiceSessionId,
      elapsedSeconds,
      // Se pasa la conexion que el pulso YA tiene abierta: sin ella, la deduccion tomaba una segunda
      // del pool mientras esta seguia retenida dentro de su transaccion, y ademas perdia el contexto de
      // inquilino. Con el maximo configurado, eso agotaba el pool a partir de unas pocas sesiones
      // concurrentes: con cincuenta sesiones simultaneas se perdian siete cobros y se regalaban casi
      // dos minutos de consumo.
      context.client
    );

    if (!deduction.ok) {
      // La marca de ultimo cobro NO se avanza: se deja intacta para que la liquidacion final vuelva a
      // intentar cobrar este mismo tramo. Avanzarla aqui lo marcaba como ya consumido y lo volvia
      // incobrable para siempre, porque la liquidacion final calcula su remanente justamente desde esa
      // marca. Era una fuga de dinero **silenciosa**: los segundos no cobrados desaparecian sin que
      // ningun registro lo delatara, y ademas la sesion se cortaba, de modo que tampoco habia un pulso
      // posterior que los recuperara.
      return {
        billedSeconds: elapsedSeconds,
        coveredMinutes: '0.000000',
        overageMinutes: '0.000000',
        overageCostUsd: '0.000000',
        shouldTerminate: true,
        terminationReason: `FACTURACION_NO_DISPONIBLE: ${deduction.reason}`,
        ledgerEntryId: '',
      };
    }

    // Solo un cobro CONFIRMADO hace avanzar la marca y limpia lo pendiente.
    session.lastBilledAtMs = nowMs;
    session.pendingSeconds = 0;
    session.billedMinutes = this.sumMinutes(session.billedMinutes, this.secondsToMinutes(elapsedSeconds));
    session.totalBilledUsd = this.sumMinutes(session.totalBilledUsd, deduction.deduction.overageCostUsd);
    await this.persistSessionTotals(context.client, session);

    return {
      billedSeconds: elapsedSeconds,
      coveredMinutes: deduction.deduction.coveredMinutes,
      overageMinutes: deduction.deduction.overageMinutes,
      overageCostUsd: deduction.deduction.overageCostUsd,
      shouldTerminate: deduction.deduction.shouldTerminateSession,
      terminationReason: deduction.deduction.shouldTerminateSession ? 'FONDOS_O_TOPE_ALCANZADO' : null,
      ledgerEntryId: deduction.deduction.ledgerEntryId,
    };
  }

  /**
   * Liquida el remanente exacto y ordena el cierre cortes de la sesion.
   * El remanente se cobra con su valor exacto, sin redondear al pulso: esos segundos ya se
   * consumieron, y perdonarlos en cada sesion seria regalar una fraccion del servicio.
   *
   * @param voiceSessionId - Sesion que se cierra.
   * @param context - Conexion transaccional y envio de tramas al navegador.
   * @returns Resultado de la liquidacion final.
   */
  public async settleAndClose(voiceSessionId: string, context: MeteringSessionContext): Promise<MeteringTickResult> {
    const session = this.sessions.get(voiceSessionId);
    if (session === undefined) {
      return this.buildNoChargeResult(true);
    }

    this.stopTimer(voiceSessionId);

    const elapsedSeconds = Math.floor((Date.now() - session.lastBilledAtMs) / 1000);
    let finalResult = this.buildNoChargeResult(false);

    if (elapsedSeconds > 0) {
      const deduction = await this.dependencies.billingPort.deductVoiceSessionSlice(
        session.organizationId,
        session.voiceSessionId,
        elapsedSeconds
      );

      if (deduction.ok) {
        session.billedMinutes = this.sumMinutes(session.billedMinutes, this.secondsToMinutes(elapsedSeconds));
        session.totalBilledUsd = this.sumMinutes(session.totalBilledUsd, deduction.deduction.overageCostUsd);
        finalResult = {
          billedSeconds: elapsedSeconds,
          coveredMinutes: deduction.deduction.coveredMinutes,
          overageMinutes: deduction.deduction.overageMinutes,
          overageCostUsd: deduction.deduction.overageCostUsd,
          shouldTerminate: false,
          terminationReason: null,
          ledgerEntryId: deduction.deduction.ledgerEntryId,
        };
      } else {
        finalResult = {
          billedSeconds: elapsedSeconds,
          coveredMinutes: '0.000000',
          overageMinutes: '0.000000',
          overageCostUsd: '0.000000',
          shouldTerminate: false,
          terminationReason: `LIQUIDACION_NO_DISPONIBLE: ${deduction.reason}`,
          ledgerEntryId: '',
        };
      }
    }

    await this.persistSessionTotals(context.client, session);
    context.sendFrameToClient(encodeSessionClosingFrame(VOICE_CLOSE_CODES.PAYMENT_REQUIRED, CLOSING_PUBLIC_MESSAGE));
    this.sessions.delete(voiceSessionId);

    return finalResult;
  }

  /**
   * Arranca el temporizador determinista del pulso de facturacion.
   *
   * @param voiceSessionId - Sesion que se factura.
   * @param contextProvider - Fabrica del contexto transaccional, evaluada en cada pulso.
   * @param onTerminationRequired - Aviso de que la sesion debe cerrarse por falta de fondos.
   */
  public startTimer(
    voiceSessionId: string,
    contextProvider: () => Promise<MeteringSessionContext | null>,
    onTerminationRequired: (result: MeteringTickResult) => void
  ): void {
    const session = this.sessions.get(voiceSessionId);
    if (session === undefined || session.timerHandle !== null) {
      return;
    }

    session.timerHandle = setInterval(() => {
      void (async () => {
        const context = await contextProvider();
        if (context === null) {
          return;
        }
        const result = await this.runTick(voiceSessionId, context);
        if (result.shouldTerminate) {
          onTerminationRequired(result);
        }
      })();
    }, METERING_TICK_SECONDS * 1000);

    // El temporizador no debe mantener vivo el proceso cuando no quedan sesiones activas.
    session.timerHandle.unref();
  }

  /**
   * Detiene el temporizador de una sesion sin liquidarla.
   *
   * @param voiceSessionId - Sesion cuyo pulso se detiene.
   */
  public stopTimer(voiceSessionId: string): void {
    const session = this.sessions.get(voiceSessionId);
    if (session === undefined || session.timerHandle === null) {
      return;
    }
    clearInterval(session.timerHandle);
    session.timerHandle = null;
  }

  /**
   * Persiste los totales acumulados de la sesion en su registro de PostgreSQL.
   *
   * @param client - Conexion transaccional con contexto RLS.
   * @param session - Estado acumulado de la sesion.
   */
  private async persistSessionTotals(client: PoolClient, session: MeteringSessionState): Promise<void> {
    await this.dependencies.meteringStore.persistTotals(
      client,
      session.voiceSessionId,
      this.roundSecondsAccumulated(session),
      session.billedMinutes,
      session.totalBilledUsd
    );
  }

  /**
   * Calcula los segundos totales transcurridos desde la apertura de la sesion.
   *
   * @param session - Estado de la sesion.
   * @returns Segundos transcurridos, redondeados hacia abajo.
   */
  private roundSecondsAccumulated(session: MeteringSessionState): number {
    const elapsedMs = Date.now() - (session.lastBilledAtMs - session.pendingSeconds * 1000);
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }

  /**
   * Convierte segundos a minutos con la representacion decimal de 6 cifras.
   *
   * @param seconds - Segundos transcurridos.
   * @returns Minutos en formato decimal fijo.
   */
  private secondsToMinutes(seconds: number): string {
    const wholeMinutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const fractionalMicros = Math.round((remainingSeconds / 60) * 1_000_000);
    return `${wholeMinutes}.${fractionalMicros.toString().padStart(6, '0')}`;
  }

  /**
   * Suma dos cantidades en formato decimal de 6 cifras sin perdida.
   *
   * @param leftValue - Valor de partida.
   * @param rightValue - Valor a sumar.
   * @returns Suma con 6 decimales exactos.
   */
  private sumMinutes(leftValue: string, rightValue: string): string {
    const leftMicros = this.toMicros(leftValue);
    const rightMicros = this.toMicros(rightValue);
    return this.fromMicros(leftMicros + rightMicros);
  }

  /**
   * Convierte una cadena decimal de 6 cifras a micro-unidades enteras.
   *
   * @param fixed6Value - Valor en formato decimal fijo.
   * @returns Valor en millonésimas de unidad.
   */
  private toMicros(fixed6Value: string): number {
    const parsed = Number.parseFloat(fixed6Value);
    return Number.isFinite(parsed) ? Math.round(parsed * 1_000_000) : 0;
  }

  /**
   * Convierte micro-unidades enteras a la representacion decimal de 6 cifras.
   *
   * @param micros - Valor en millonésimas de unidad.
   * @returns Cadena decimal canonica de 6 cifras.
   */
  private fromMicros(micros: number): string {
    const isNegative = micros < 0;
    const absoluteMicros = Math.abs(micros);
    const whole = Math.trunc(absoluteMicros / 1_000_000);
    const fraction = (absoluteMicros % 1_000_000).toString().padStart(6, '0');
    return `${isNegative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * Construye el resultado de un pulso sin consumo facturable.
   *
   * @param sessionMissing - Indica si el resultado se debe a que la sesion no esta registrada.
   * @returns Resultado sin movimiento contable ni corte de servicio.
   */
  private buildNoChargeResult(sessionMissing: boolean): MeteringTickResult {
    return {
      billedSeconds: 0,
      coveredMinutes: '0.000000',
      overageMinutes: '0.000000',
      overageCostUsd: '0.000000',
      shouldTerminate: false,
      terminationReason: sessionMissing ? 'SESION_NO_REGISTRADA' : null,
      ledgerEntryId: '',
    };
  }
}

/**
 * Ensambla el servicio de facturacion de sesiones de voz.
 *
 * @param dependencies - Puerto de facturacion y repositorio de sesiones.
 * @returns Servicio listo para el gateway de voz.
 */
export function createVoiceSessionMeteringService(dependencies: MeteringDependencies): VoiceSessionMeteringService {
  return new VoiceSessionMeteringService(dependencies);
}


