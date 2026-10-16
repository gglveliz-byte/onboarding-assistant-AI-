/**
 * @archivo tests/integration/support/voice-gateway-doubles.ts
 * @modulo 05-voice-realtime-gateway (Dobles de Prueba del Gateway de Voz)
 * @proposito
 *   Reune los dobles que permiten certificar las barreras de seguridad y el despacho de herramientas
 *   sin abrir ninguna conexion ni tocar la base de datos: un canal de motor que registra los
 *   resultados devueltos al modelo, un puerto del mapa funcional con la respuesta que la prueba
 *   necesite, un cliente transaccional minimo y un repositorio de sesiones que captura lo que se
 *   persiste. Tener los dobles en un solo lugar evita que cada prueba construya los suyos y acabe
 *   midiendo comportamientos distintos para el mismo componente.
 *
 * @resumen_contenido
 *   - Interfaces `ProviderStreamDouble` y `SessionRepositoryDouble`.
 *   - Funciones `buildPcmFrame()`, `buildInvocation()`, `buildFakePoolClient()`.
 *   - Funciones `buildFakeProviderStream()`, `buildFakeRagPort()`, `buildFakeSessionRepository()`.
 *   - Funcion `buildDispatchRequest()`: Solicitud completa lista para el caso de uso.
 *
 * @dependencias_internas
 *   - `DomToolDispatchRequest` (`src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case.ts`).
 *   - Puertos del nucleo (`src/shared/ports/`).
 *
 * @dependencias_externas
 *   - `pg` (Solo el tipo `PoolClient` de los dobles).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Dobles en memoria: la prueba verifica el rechazo ANTES de tocar la base de datos).
 */

import type { PoolClient } from 'pg';
import type {
  DomToolDispatchRequest,
  ToolAckOutcome,
} from '../../../src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case';
import type { IActiveProviderStream, ToolInvocation } from '../../../src/shared/ports/billing-voice-admin.ports';
import type { IVisualRagAndPromptPort } from '../../../src/shared/ports/core-modules.ports';

/** Resultado que la barrera de seguridad del mapa funcional debe devolver en la prueba. */
export type GuardrailStub =
  | {
      readonly ok: true;
      readonly primarySelector: string;
      readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      readonly requiresUserConfirmation: boolean;
    }
  | { readonly ok: false; readonly code: 'ELEMENT_NOT_FOUND'; readonly reason: string; readonly retryable: boolean };

/** Canal de motor falso con el registro de resultados devueltos al modelo. */
export interface ProviderStreamDouble {
  /** Canal activo del motor. */
  readonly stream: IActiveProviderStream;
  /** Resultados de herramienta devueltos al motor, en orden. */
  readonly toolResults: { readonly callId: string; readonly succeeded: boolean; readonly payload: unknown }[];
}

/** Repositorio de sesiones falso con el registro de lo persistido. */
export interface SessionRepositoryDouble {
  /** Repositorio que se inyecta en el caso de uso. */
  readonly repository: never;
  /** Eventos de accion creados, en orden. */
  readonly createdEvents: Record<string, unknown>[];
  /** Actualizaciones de estado aplicadas. */
  readonly statusUpdates: {
    readonly status: string;
    readonly latencyMs: number | undefined;
    readonly errorCode: string | undefined;
  }[];
}

/** Contador de verificaciones superadas durante la ejecucion de una prueba. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
export function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`FALLO: ${description}`);
  }
  passedAssertions += 1;
}

/**
 * Devuelve el numero de aserciones superadas hasta el momento.
 *
 * @returns Total acumulado de aserciones superadas.
 */
export function countPassedAssertions(): number {
  return passedAssertions;
}

/**
 * Construye un fragmento PCM16 de amplitud constante.
 *
 * @param amplitude - Amplitud de la muestra, en el rango de PCM16 signado.
 * @param sampleCount - Numero de muestras del fragmento.
 * @returns Buffer PCM16 little-endian.
 */
export function buildPcmFrame(amplitude: number, sampleCount: number): Buffer {
  const frame = Buffer.alloc(sampleCount * 2);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    frame.writeInt16LE(amplitude, sampleIndex * 2);
  }
  return frame;
}

/**
 * Construye una invocacion de herramienta sintetica.
 *
 * @param overrides - Campos a sobrescribir respecto de la invocacion base.
 * @returns Invocacion completa.
 */
export function buildInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    providerToolCallId: 'call-prueba-1',
    toolName: 'click_element',
    targetElementKey: 'btn_comenzar',
    textPayload: null,
    ...overrides,
  };
}

/**
 * Construye un doble del cliente transaccional con RLS.
 *
 * @returns Cliente falso con el contrato minimo consumido.
 */
export function buildFakePoolClient(): never {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  } as never;
}

/**
 * Construye un canal de motor falso que registra los resultados de herramienta enviados.
 *
 * @returns Canal falso con el registro de lo enviado.
 */
export function buildFakeProviderStream(): ProviderStreamDouble {
  const toolResults: { readonly callId: string; readonly succeeded: boolean; readonly payload: unknown }[] = [];
  const stream: IActiveProviderStream = {
    providerKind: 'QWEN',
    providerRole: 'PRIMARY',
    streamId: 'stream-prueba',
    openedAtIso: new Date().toISOString(),
    sendAudioFrame: () => undefined,
    sendToolResult: (providerToolCallId: string, succeeded: boolean, payload: unknown) => {
      toolResults.push({ callId: providerToolCallId, succeeded, payload });
    },
    requestBargeIn: () => undefined,
    close: async () => undefined,
  };
  return { stream, toolResults };
}

/**
 * Construye un doble del puerto del mapa funcional con la respuesta indicada.
 *
 * @param guardrailResult - Resultado que debe devolver la barrera de seguridad de elementos.
 * @returns Puerto falso del mapa funcional.
 */
export function buildFakeRagPort(guardrailResult: GuardrailStub): IVisualRagAndPromptPort {
  return {
    getActiveProjectPromptAndMapMeta: async () => ({
      ok: true as const,
      systemPrompt: 'Prompt de prueba',
      promptVersionNumber: 1,
      onboardingStepsJson: [],
      primaryVoiceModel: 'gemini-3.8-live',
      fallbackVoiceModel: 'qwen-3.8-omni-flash-realtime',
      mapMetadata: {
        functionalMapId: 'mapa-prueba',
        versionNumber: 1,
        canonicalSha256: 'a'.repeat(64),
        routes: ['/'],
        totalElementsCount: 1,
        publishedAtIso: new Date().toISOString(),
      },
    }),
    getSlimmedRouteContext: async () => ({
      ok: true as const,
      context: { routePath: '/', stepNumber: 1, stepInstruction: 'Completa el paso', allowedActions: [] },
    }),
    validateElementActionGuardrail: async () => guardrailResult,
  };
}

/**
 * Construye un doble del repositorio de sesiones que registra los eventos de accion.
 *
 * @returns Repositorio falso con el registro de lo persistido.
 */
export function buildFakeSessionRepository(): SessionRepositoryDouble {
  const createdEvents: Record<string, unknown>[] = [];
  const statusUpdates: { readonly status: string; readonly latencyMs: number | undefined; readonly errorCode: string | undefined }[] = [];
  let eventCounter = 0;

  const repository = {
    incrementToolCallsCount: async () => 1,
    createActionEvent: async (_client: unknown, data: Record<string, unknown>) => {
      createdEvents.push(data);
      eventCounter += 1;
      return { id: `evento-${eventCounter}` };
    },
    updateActionEventStatus: async (
      _client: unknown,
      _eventId: string,
      status: string,
      latencyMs?: number,
      errorCode?: string
    ) => {
      statusUpdates.push({ status, latencyMs, errorCode });
    },
  } as never;

  return { repository, createdEvents, statusUpdates };
}

/**
 * Construye una solicitud completa de despacho con dobles inyectados.
 *
 * @param overrides - Campos a sobrescribir respecto de la base.
 * @returns Solicitud lista para el caso de uso.
 */
export function buildDispatchRequest(overrides: Partial<DomToolDispatchRequest> = {}): DomToolDispatchRequest {
  const providerDoubles = buildFakeProviderStream();
  const sessionDoubles = buildFakeSessionRepository();

  return {
    organizationId: '00000000-0000-4000-8000-00000000b111',
    projectId: '00000000-0000-4000-8000-00000000b222',
    functionalMapId: '00000000-0000-4000-8000-00000000b333',
    voiceSessionId: '00000000-0000-4000-8000-00000000b444',
    client: buildFakePoolClient(),
    routePath: '/panel/inicio',
    currentStepNumber: 1,
    invocation: buildInvocation(),
    stepStateMachine: null,
    providerStream: providerDoubles.stream,
    sendFrameToClient: () => undefined,
    awaitClientAck: async (): Promise<ToolAckOutcome> => ({ succeeded: true, detail: null }),
    ...overrides,
  };
}
