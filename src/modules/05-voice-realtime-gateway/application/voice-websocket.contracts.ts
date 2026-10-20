/**
 * @archivo src/modules/05-voice-realtime-gateway/application/voice-websocket.contracts.ts
 * @modulo 05-voice-realtime-gateway (Contratos de Apertura y Dependencias de una Sesion de Voz)
 * @proposito
 *   Declara lo que hace falta para abrir una sesion de voz —los datos del handshake y los puertos
 *   que el gateway necesita— junto con los tipos de envio y cierre de tramas. Se aisla del
 *   orquestador para que sus consumidores (el manifiesto del modulo, las pruebas y el servidor de
 *   sockets) puedan importar el contrato sin arrastrar la implementacion del ciclo de vida.
 *
 * @resumen_contenido
 *   - Constantes `MAX_BARGE_IN_PER_SESSION`, `SESSION_INITIAL_TEMPERATURE` y
 *     `UNAUTHORIZED_CLOSE_REASON`.
 *   - Tipos `ClientFrameSender`, `ClientCloser` y `VoiceSessionClosingStatus`.
 *   - Interfaces `VoiceWebSocketOpenRequest` y `VoiceWebSocketPorts`.
 *
 * @dependencias_internas
 *   - `DualProviderOrchestrator` (`../infrastructure/dual-provider-orchestrator.ts`).
 *   - `DispatchDomToolUseCase` (`./dispatch-dom-tool.use-case.ts`).
 *   - `VoiceSessionMeteringService` (`./voice-session-metering.service.ts`).
 *   - Puertos del nucleo (`src/shared/ports/core-modules.ports.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Contrato puro de inyeccion de dependencias).
 *
 * @tablas_bd_o_redis
 *   - Redis: `sdk_handshake:nonce:<jti>` (El nonce de apertura se declara aqui y se consume en el
 *     orquestador con una operacion atomica).
 *   - PostgreSQL: `voice_sessions` (La sesion declarada en la apertura es la que se persiste).
 */

import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type { VoiceProviderKind, VoiceSessionStatus } from '../../../shared/ports/billing-voice-admin.ports';
import type { IApiKeyAndHandshakePort, IVisualRagAndPromptPort } from '../../../shared/ports/core-modules.ports';
import type { DispatchDomToolUseCase } from './dispatch-dom-tool.use-case';
import type { VoiceSessionMeteringService } from './voice-session-metering.service';
import type { DualProviderOrchestrator } from '../infrastructure/dual-provider-orchestrator';

/** Maximo de interrupciones admitidas en una sesion antes de cerrarla. */
export const MAX_BARGE_IN_PER_SESSION = 30;

/** Temperatura de muestreo inicial de la sesion, en formato decimal fijo. */
export const SESSION_INITIAL_TEMPERATURE = '0.30';

/**
 * Motivo con el que se rechaza una sesion que no pudo autorizarse.
 * Se redacta sin tecnicismos y sin revelar si el nonce existia: informar de que "el nonce expiro"
 * permitiria a un atacante distinguir un nonce valido de uno inventado.
 */
export const UNAUTHORIZED_CLOSE_REASON = 'No fue posible autorizar la sesion de voz.';

/** Envio de tramas hacia el navegador del usuario final. */
export type ClientFrameSender = (frame: Buffer) => void;

/** Cierre del socket del cliente con su codigo y motivo. */
export type ClientCloser = (closeCode: number, reason: string) => void;

/**
 * Estado final admitido al cerrar una sesion de voz.
 *
 * Se deriva del contrato del kernel EXCLUYENDO los dos estados transitorios: una sesion no puede
 * "cerrarse hacia" el handshake ni hacia el streaming activo. Derivarlo en lugar de enumerarlo a mano
 * evita el defecto que tuvo la primera version de este tipo: omitia `TERMINATED_TENANT_SUSPENDED`, de
 * modo que una sesion cortada por suspension de la organizacion se persistia como cierre normal y la
 * auditoria de gobierno perdia el motivo real del corte.
 */
export type VoiceSessionClosingStatus = Exclude<VoiceSessionStatus, 'HANDSHAKE_ISSUED' | 'ACTIVE_STREAMING'>;

/** Peticion de apertura de una sesion de voz. */
export interface VoiceWebSocketOpenRequest {
  /** Identificador del nonce efimero emitido por el SDK. */
  readonly nonceId: string;
  /** Proyecto al que pertenece la sesion. */
  readonly projectId: string;
  /** Organizacion propietaria. */
  readonly organizationId: string;
  /** Sesion de voz persistida. */
  readonly voiceSessionId: string;
  /** Dominio de origen declarado por el navegador. */
  readonly originDomain: string;
  /** Ruta inicial en la que se encuentra el usuario final. */
  readonly initialRoutePath: string;
  /** Paso de onboarding con el que arranca la sesion. */
  readonly initialStepNumber: number;
  /** Total de pasos del flujo, usado por la maquina de estados. */
  readonly totalSteps: number;
  /** Indica si el proyecto exige cumplimiento estricto del orden de pasos. */
  readonly strictStepEnforcement: boolean;
  /** Frecuencia de muestreo negociada. */
  readonly sampleRateHz: number;
  /** Persona de voz configurada por el proyecto. */
  readonly voicePersonaCode: string;
  /**
   * Motor de voz preferido por quien abre la sesion (demo: el selector de la landing). Si se omite,
   * el orquestador usa el primario configurado por entorno y su respaldo; sin este campo el toggle
   * `VOZ ULTRA-RAPIDA / ULTRA-PRECISA` no llegaba al proveedor y siempre terminaba en el mismo motor.
   */
  readonly preferredVoiceModel?: VoiceProviderKind;
  /**
   * Turno inicial hablado que el motor debe enunciar apenas confirme el canal (demo publica: saludo
   * de bienvenida). Opcional: las sesiones de producto escuchan pasivamente y esperan la primera
   * palabra del usuario. Omitirlo deja al asistente naciendo mudo hasta que alguien hable.
   */
  readonly introductorySpokenPrompt?: string;
}

/** Puertos y casos de uso que el gateway necesita para atender una sesion. */
export interface VoiceWebSocketPorts {
  /** Pool con contexto RLS para la trazabilidad transaccional. */
  readonly pool: RlsDatabasePool;
  /** Puerto de handshake y claves del modulo 02. */
  readonly handshakePort: IApiKeyAndHandshakePort;
  /** Puerto del mapa funcional y del prompt vigente. */
  readonly ragPort: IVisualRagAndPromptPort;
  /** Orquestador dual de motores de voz. */
  readonly orchestrator: DualProviderOrchestrator;
  /** Despachador validado de herramientas fisicas. */
  readonly dispatchToolUseCase: DispatchDomToolUseCase;
  /** Servicio de facturacion por pulso. */
  readonly meteringService: VoiceSessionMeteringService;
}

