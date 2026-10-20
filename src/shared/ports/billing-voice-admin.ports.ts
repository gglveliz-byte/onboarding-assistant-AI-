/**
 * @archivo src/shared/ports/billing-voice-admin.ports.ts
 * @modulo 00-kernel (Contratos Publicos Inmutables de los Modulos 04, 05 y 06)
 * @proposito
 *   Declara los puertos que conectan la facturacion, el motor de voz en tiempo real y el gobierno
 *   de la plataforma. Son los contratos mas delicados del sistema: la deduccion de minutos exige
 *   bloqueo pesimista para impedir el doble gasto entre sesiones concurrentes, el motor de voz
 *   debe poder conmutar por failover sin perder audio, y la bitacora de auditoria se encadena
 *   criptograficamente para que un registro pasado no pueda alterarse sin invalidar los siguientes.
 *
 * @resumen_contenido
 *   - Interface `IBillingWhopPort`: `checkOrganizationSolvency()`, `deductVoiceSessionSlice()`,
 *     `grantPromotionalMinutes()`.
 *   - Interface `IVoiceRealtimeProvider` e `IActiveProviderStream`: contrato del motor de voz.
 *   - Interface `IVoiceGatewayControlPort`: `terminateAllOrgSessionsImmediately()`,
 *     `switchGlobalDefaultAiProvider()`.
 *   - Interface `IAuditLoggerPort`: `appendImmutableAuditLog()` con encadenamiento SHA-256.
 *   - Tipos compartidos: `VoiceProviderKind`, `VoiceSessionStatus`, `ToolInvocation`.
 *
 * @dependencias_internas
 *   - `PortFailure` (`./core-modules.ports.ts`) como contrato comun de fallo normalizado.
 *   - `RiskLevel` (`./core-modules.ports.ts`) para el nivel de riesgo de una herramienta.
 *
 * @dependencias_externas
 *   - Ninguna (Solo interfaces; los adaptadores concretos viven en cada modulo).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions`, `usage_ledger`, `voice_sessions`, `action_events`,
 *     `audit_logs`, `pricing_plans_config`, `organization_pricing_overrides`.
 *   - Redis: `org:<id>:billing`, `voice_session:state:<id>`, `org:<id>:active_sessions`,
 *     `whop:webhook:evt:<id>`.
 */

import type { PoolClient } from 'pg';
import type { PortFailure, RiskLevel } from './core-modules.ports';

export type { PortFailure, RiskLevel };

/** Motor de voz en tiempo real disponible en la plataforma. */
export type VoiceProviderKind = 'QWEN' | 'GEMINI';

/** Rol del motor dentro de la estrategia de conmutacion por failover. */
export type VoiceProviderRole = 'PRIMARY' | 'FAILOVER';

/** Estado del ciclo de vida de una sesion de voz, alineado con el enum de PostgreSQL. */
export type VoiceSessionStatus =
  | 'HANDSHAKE_ISSUED'
  | 'ACTIVE_STREAMING'
  | 'COMPLETED_NORMAL'
  | 'TERMINATED_BARGE_IN_LIMIT'
  | 'TERMINATED_INSUFFICIENT_FUNDS'
  | 'TERMINATED_TENANT_SUSPENDED'
  | 'FAILED_PROVIDER_ERROR';

/** Invocacion de herramienta solicitada por el motor de voz al navegador del usuario final. */
export interface ToolInvocation {
  /** Identificador de la llamada emitido por el motor, usado para casar la confirmacion. */
  readonly providerToolCallId: string;
  /** Herramienta invocada. */
  readonly toolName: 'click_element' | 'type_text' | 'advance_onboarding_step';
  /** Elemento del mapa funcional sobre el que se actua. */
  readonly targetElementKey: string;
  /** Texto a escribir cuando la herramienta es `type_text`; `null` en los demas casos. */
  readonly textPayload: string | null;
}

/** Resultado de la verificacion de solvencia de una organizacion. */
export interface SolvencySnapshot {
  /** Minutos incluidos disponibles en el periodo. */
  readonly availableMinutes: string;
  /** Saldo de credito disponible en USD. */
  readonly creditBalanceUsd: string;
  /** Tarifa efectiva por minuto aplicable en este instante. */
  readonly effectiveRatePerMinuteUsd: string;
  /** Plan contratado por la organizacion. */
  readonly planCode: string;
  /** Indica si la organizacion puede iniciar una nueva sesion de voz. */
  readonly canStartSession: boolean;
  /** Motivo del rechazo cuando `canStartSession` es falso. */
  readonly blockedReason: string | null;
}

/** Desglose de una deduccion de consumo aplicada al libro mayor. */
export interface BillingDeductionResult {
  /** Minutos cubiertos por la cuota incluida del periodo. */
  readonly coveredMinutes: string;
  /** Minutos que excedieron la cuota y se cobran por separado. */
  readonly overageMinutes: string;
  /** Importe en USD del excedente aplicado. */
  readonly overageCostUsd: string;
  /** Minutos incluidos restantes despues de la deduccion. */
  readonly remainingIncludedMinutes: string;
  /** Saldo de credito restante en USD. */
  readonly remainingCreditUsd: string;
  /** Indica si la sesion debe cerrarse por agotamiento de saldo. */
  readonly shouldTerminateSession: boolean;
  /** Identificador del asiento contable inmutable registrado en `usage_ledger`. */
  readonly ledgerEntryId: string;
}

/**
 * Puerto de facturacion y cobros (Modulo 04).
 * Concentra la unica ruta autorizada de deduccion de minutos: toda deduccion pasa por aqui y se
 * ejecuta dentro del bloqueo pesimista `SELECT ... FOR UPDATE` sobre la suscripcion.
 */
export interface IBillingWhopPort {
  /**
   * Verifica si una organizacion puede iniciar o continuar una sesion de voz, devolviendo la
   * tarifa efectiva aplicable (base, tramo de volumen y override manual del SuperAdmin).
   *
   * @param organizationId - Organizacion evaluada.
   * @returns Instantanea de solvencia con la tarifa efectiva, o fallo normalizado.
   */
  checkOrganizationSolvency(organizationId: string): Promise<{ readonly ok: true; readonly snapshot: SolvencySnapshot } | PortFailure>;

  /**
   * Deduce de forma atomica los segundos consumidos por una sesion de voz.
   * Adquiere el bloqueo pesimista sobre la suscripcion antes de calcular, de modo que dos sesiones
   * concurrentes de la misma organizacion no puedan leer el mismo saldo y deducir dos veces.
   *
   * @param organizationId - Organizacion que consume.
   * @param voiceSessionId - Sesion de voz que reporta el consumo.
   * @param elapsedSeconds - Segundos transcurridos desde el ultimo pulso de facturacion.
   * @returns Desglose de la deduccion con la bandera de corte, o fallo normalizado.
   */
  deductVoiceSessionSlice(
    organizationId: string,
    voiceSessionId: string,
    elapsedSeconds: number,
    /**
     * Conexion del llamador, cuando ya tiene una abierta dentro de su transaccion.
     *
     * Se acepta para que la deduccion **reutilice** esa conexion en lugar de tomar una segunda del
     * pool. Abrir una propia mientras el llamador retiene la primera es lo que agotaba el pool a partir
     * de unas pocas sesiones concurrentes, y ademas perdia el contexto de inquilino que el llamador ya
     * habia fijado. Es opcional para que los llamadores que no tengan transaccion en curso —como la
     * liquidacion final— sigan funcionando sin cambios.
     */
    callerClient?: PoolClient
  ): Promise<{ readonly ok: true; readonly deduction: BillingDeductionResult } | PortFailure>;

  /**
   * Otorga minutos promocionales o de compensacion, registrando el asiento correspondiente.
   *
   * @param organizationId - Organizacion beneficiada.
   * @param minutesToGrant - Minutos a otorgar, en formato decimal fijo de 6 decimales.
   * @param reason - Motivo del otorgamiento, obligatorio para la auditoria.
   * @param grantedBySuperAdminId - Operador de gobierno que autoriza la entrega.
   * @returns Saldo resultante, o fallo normalizado.
   */
  grantPromotionalMinutes(
    organizationId: string,
    minutesToGrant: string,
    reason: string,
    grantedBySuperAdminId: string
  ): Promise<{ readonly ok: true; readonly remainingIncludedMinutes: string; readonly ledgerEntryId: string } | PortFailure>;
}

/** Configuracion de apertura de un canal contra el motor de voz. */
export interface VoiceStreamOpenRequest {
  /** Organizacion propietaria de la sesion. */
  readonly organizationId: string;
  /** Proyecto cuyo mapa funcional gobierna la sesion. */
  readonly projectId: string;
  /** Identificador de la sesion de voz persistida. */
  readonly voiceSessionId: string;
  /** Prompt de sistema vigente del proyecto. */
  readonly systemPrompt: string;
  /** Pasos de onboarding serializados que el asistente debe recorrer. */
  readonly onboardingStepsJson: readonly unknown[];
  /** Persona de voz seleccionada para el proyecto. */
  readonly voicePersonaCode: string;
  /** Temperatura del modelo, en formato decimal fijo. */
  readonly modelTemperature: string;
  /** Frecuencia de muestreo del audio PCM16 negociada. */
  readonly pcmSampleRateHz: number;
  /** Identificador del usuario final externo, cuando el proyecto lo declara. */
  readonly externalEndUserId: string | null;
}

/** Canal activo contra un motor de voz, con el contrato minimo de streaming. */
export interface IActiveProviderStream {
  /** Motor que atiende este canal. */
  readonly providerKind: VoiceProviderKind;
  /** Rol del motor dentro de la estrategia de failover. */
  readonly providerRole: VoiceProviderRole;
  /** Identificador del canal asignado por el proveedor. */
  readonly streamId: string;
  /** Marca temporal de apertura del canal. */
  readonly openedAtIso: string;

  /**
   * Envia una trama de audio PCM16 del usuario final hacia el motor.
   *
   * @param pcmFrame - Audio PCM16 little-endian sin cabecera.
   */
  sendAudioFrame(pcmFrame: Buffer): void;

  /**
   * Envia el resultado de una herramienta ejecutada en el navegador del usuario final.
   *
   * @param providerToolCallId - Identificador de la llamada que se esta confirmando.
   * @param succeeded - Indica si la accion fisica se completo.
   * @param payload - Datos adicionales del resultado (mensaje de error o valor leido).
   */
  sendToolResult(providerToolCallId: string, succeeded: boolean, payload: unknown): void;

  /**
   * Cancela de inmediato la reproduccion en curso (interrupcion del usuario).
   * Debe completarse dentro del presupuesto de barge-in configurado (`VOICE_BARGE_IN_BUDGET_MS`).
   */
  requestBargeIn(): void;

  /**
   * Cierra el canal de forma ordenada liberando los recursos del proveedor.
   *
   * @param status - Estado final de la sesion de voz.
   */
  close(status: VoiceSessionStatus): Promise<void>;
}

/** Manejadores de los eventos que el motor de voz emite hacia la aplicacion. */
export interface VoiceProviderEventHandlers {
  /** Audio PCM16 generado por el asistente, listo para reenviar al navegador. */
  readonly onAudioFrame: (pcmFrame: Buffer) => void;
  /** Transcripcion parcial o final del audio del usuario final. */
  readonly onTranscript: (text: string, isFinal: boolean) => void;
  /** Invocacion de herramienta solicitada por el motor. */
  readonly onToolInvocation: (invocation: ToolInvocation) => void;
  /** Indica que el asistente comenzo a hablar (usado por el detector de interrupcion). */
  readonly onAssistantSpeechStarted: () => void;
  /** Fallo del canal: habilita la ruta de conmutacion por failover. */
  readonly onProviderError: (reason: string) => void;
  /** Canal cerrado por el proveedor. */
  readonly onClosed: (status: VoiceSessionStatus) => void;
}

/**
 * Contrato exacto del motor de voz en tiempo real (Modulo 05).
 * Lo implementan los dos adaptadores (primario y de respaldo) y lo consume el enrutador de
 * failover sin conocer el protocolo BidiGenerateContent ni el stream nativo de cada proveedor.
 */
export interface IVoiceRealtimeProvider {
  /** Motor que implementa este adaptador. */
  readonly providerKind: VoiceProviderKind;
  /** Rol con el que este adaptador fue configurado. */
  readonly providerRole: VoiceProviderRole;

  /**
   * Abre un canal de streaming bidireccional contra el motor de voz.
   *
   * @param request - Configuracion de la sesion y el prompt vigente.
   * @param handlers - Manejadores de los eventos emitidos por el motor.
   * @returns Canal activo listo para enviar audio, o fallo normalizado de disponibilidad.
   */
  openStream(
    request: VoiceStreamOpenRequest,
    handlers: VoiceProviderEventHandlers
  ): Promise<{ readonly ok: true; readonly stream: IActiveProviderStream } | PortFailure>;

  /**
   * Comprueba la disponibilidad del motor antes de intentar abrir un canal.
   *
   * @returns `true` cuando el motor responde y admite nuevas sesiones.
   */
  isAvailable(): Promise<boolean>;
}

/** Resultado de una orden de terminacion masiva de sesiones. */
export interface MassTerminationResult {
  /** Numero de sesiones efectivamente cerradas. */
  readonly terminatedSessionCount: number;
  /** Organizacion sobre la que se aplico la orden. */
  readonly organizationId: string;
  /** Motivo registrado en cada cierre. */
  readonly reason: string;
}

/**
 * Puerto de control del Gateway de Voz (Modulo 05).
 * Permite al gobierno de la plataforma cortar el servicio sin conocer los detalles del socket.
 */
export interface IVoiceGatewayControlPort {
  /**
   * Cierra de inmediato todas las sesiones de voz activas de una organizacion.
   * El cierre usa el codigo de socket correspondiente al motivo (`4002` por saldo agotado y
   * `4003` por organizacion suspendida) y notifica al usuario final con lenguaje de marca.
   *
   * @param organizationId - Organizacion cuyas sesiones se cierran.
   * @param reason - Motivo del cierre, registrado en auditoria.
   * @param closeCode - Codigo de cierre del socket a enviar al cliente.
   * @returns Resumen de la terminacion masiva.
   */
  terminateAllOrgSessionsImmediately(
    organizationId: string,
    reason: string,
    closeCode: number
  ): Promise<MassTerminationResult>;

  /**
   * Cambia el motor de voz que atiende las nuevas sesiones y propaga la orden a todos los nodos.
   *
   * @param providerKind - Motor que pasara a atender las sesiones nuevas.
   * @param switchedBySuperAdminId - Operador de gobierno que autoriza el cambio.
   * @returns Confirmacion del cambio con la marca temporal de aplicacion.
   */
  switchGlobalDefaultAiProvider(
    providerKind: VoiceProviderKind,
    switchedBySuperAdminId: string
  ): Promise<{ readonly ok: true; readonly appliedAtIso: string; readonly previousProviderKind: VoiceProviderKind } | PortFailure>;
}

/** Severidad de una entrada de auditoria. */
export type AuditSeverityLevel = 'INFO' | 'WARN' | 'CRITICAL_SECURITY';

/** Entrada de auditoria a registrar en la bitacora encadenada. */
export interface AuditLogEntry {
  /** Organizacion afectada, o `null` para eventos de plataforma. */
  readonly organizationId: string | null;
  /** Usuario o clave de API que origino el evento. */
  readonly actorUserId: string | null;
  /** Categoria del evento (por ejemplo `GOVERNANCE` o `SECURITY`). */
  readonly eventCategory: string;
  /** Accion concreta registrada. */
  readonly eventAction: string;
  /** Severidad del evento. */
  readonly severity: AuditSeverityLevel;
  /** Tipo del recurso afectado. */
  readonly targetResourceType: string | null;
  /** Identificador del recurso afectado. */
  readonly targetResourceId: string | null;
  /** Estado previo serializable, cuando la accion lo modifica. */
  readonly beforeStateJson: unknown;
  /** Estado posterior serializable, cuando la accion lo modifica. */
  readonly afterStateJson: unknown;
}

/**
 * Puerto de bitacora de auditoria inmutable (Modulo 06).
 * Cada registro se encadena con el digest SHA-256 del anterior, de modo que alterar un evento
 * pasado invalida toda la cadena posterior y la manipulacion queda demostrable.
 */
export interface IAuditLoggerPort {
  /**
   * Anexa un registro inmutable a la bitacora de auditoria.
   *
   * @param entry - Contenido del evento a registrar.
   * @returns Identificador del registro y digest de encadenamiento, o fallo normalizado.
   */
  appendImmutableAuditLog(
    entry: AuditLogEntry
  ): Promise<{ readonly ok: true; readonly auditLogId: string; readonly recordSha256: string; readonly previousRecordSha256: string | null } | PortFailure>;

  /**
   * Verifica la integridad de la cadena de auditoria de una organizacion.
   *
   * @param organizationId - Organizacion cuya cadena se verifica.
   * @param sampleSize - Numero de registros recientes a recomputar.
   * @returns Resultado de la verificacion con el primer registro inconsistente detectado.
   */
  verifyAuditChainIntegrity(
    organizationId: string,
    sampleSize?: number
  ): Promise<{ readonly ok: true; readonly verifiedRecords: number; readonly firstBrokenRecordId: string | null } | PortFailure>;

  /**
   * Registra un intento bloqueado por el escudo Anti-SSRF o por una barrera de seguridad.
   *
   * @param riskLevel - Nivel de riesgo atribuido al intento.
   * @param entry - Contenido del evento de seguridad.
   * @returns Confirmacion del registro.
   */
  recordSecurityBlock(
    riskLevel: RiskLevel,
    entry: AuditLogEntry
  ): Promise<{ readonly ok: true; readonly auditLogId: string } | PortFailure>;
}

/** Parametros para suspender un tenant por gobierno. */
export interface SuspendTenantParams {
  readonly organizationId: string;
  readonly reason: string;
  readonly superAdminUserId: string;
}

/** Parametros para reactivar un tenant suspendido. */
export interface ReactivateTenantParams {
  readonly organizationId: string;
  readonly superAdminUserId: string;
}

/** Parametros para fijar override de tarificacion a un tenant. */
export interface SetTenantPricingOverrideParams {
  readonly organizationId: string;
  readonly customRatePerMinuteUsd?: string | undefined;
  readonly manualDiscountPercentage?: number | undefined;
  readonly forceVolumeDiscountTiers?: boolean | undefined;
  readonly customVolumeTiersJson?: readonly unknown[] | undefined;
  readonly overrideNotes: string;
  readonly superAdminUserId: string;
}

/** Parametros para actualizar un plan global de precios. */
export interface UpdateGlobalPricingPlanParams {
  readonly planCode: string;
  readonly monthlyFixedPriceUsd: string;
  readonly includedMinutes: string;
  readonly baseOverageRatePerMinuteUsd: string;
  readonly overageAllowed: boolean;
  readonly volumeDiscountEligible: boolean;
  readonly volumeDiscountTiersJson: readonly unknown[];
  readonly superAdminUserId: string;
  /**
   * Identificador REAL del plan en la pasarela (prefijo `plan_`). Se omite para conservar el que ya
   * esta aprovisionado: el adaptador JAMAS inventa uno, porque un identificador fabricado convierte
   * el checkout en un fallo garantido de la pasarela.
   */
  readonly whopPlanId?: string;
  /** Nombre comercial mostrado en la landing y los paneles. Se omite para conservar el vigente. */
  readonly displayName?: string;
}

/**
 * Puerto de gobierno global de la plataforma (Modulo 06).
 * Permite a la consola de SuperAdmin suspender tenants, fijar overrides y controlar kill-switches.
 */
export interface ISuperAdminGovernancePort {
  suspendTenant(params: SuspendTenantParams): Promise<{ readonly ok: true; readonly suspendedAtIso: string } | PortFailure>;
  reactivateTenant(params: ReactivateTenantParams): Promise<{ readonly ok: true; readonly reactivatedAtIso: string } | PortFailure>;
  setTenantPricingOverride(params: SetTenantPricingOverrideParams): Promise<{ readonly ok: true; readonly overrideId: string } | PortFailure>;
  updateGlobalPricingPlan(params: UpdateGlobalPricingPlanParams): Promise<{ readonly ok: true; readonly updatedPlanCode: string } | PortFailure>;
  isPlatformVoiceKillSwitchActive(): Promise<boolean>;
  setPlatformVoiceKillSwitch(params: { readonly active: boolean; readonly reason: string; readonly superAdminUserId: string }): Promise<{ readonly ok: true; readonly active: boolean } | PortFailure>;
}


