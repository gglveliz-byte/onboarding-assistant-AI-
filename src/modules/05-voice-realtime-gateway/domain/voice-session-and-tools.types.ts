/**
 * @archivo src/modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types.ts
 * @modulo 05-voice-realtime-gateway (Tipos de Sesion, Herramientas DOM y Maquina de Estados)
 * @proposito
 *   Define los contratos de datos inmutables, esquemas de declaraciones de herramientas
 *   Function Calling (click_element, type_text, advance_onboarding_step), estructuras de
 *   audio PCM16 en tiempo real y la maquina de estados secuencial de onboarding.
 *
 * @resumen_contenido
 *   - Declaraciones JSON Schema para Gemini Live y Qwen Omni.
 *   - Entidades de dominio: `VoiceSessionEntity` y `ActionEventEntity`.
 *   - Maquina de estados: `OnboardingStepStateMachine`.
 *   - Esquema Zod de inicio de sesion: `startVoiceSessionSchema`.
 *
 * @dependencias_internas
 *   - `@shared/ports/billing-voice-admin.ports.ts`: Estados oficiales de sesion.
 *   - `@shared/kernel/result-and-errors.ts`: Errores de dominio y tipo Result.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions`, `action_events`.
 *   - Redis: `voice_session:state:<id>`, `org:<id>:active_sessions`.
 */

import { z } from 'zod';
import {
  ToolInvocation,
  VoiceSessionStatus,
} from '@shared/ports/billing-voice-admin.ports';
import { ValidationError } from '@shared/kernel/result-and-errors';

/** Modelos de IA de voz admitidos en la plataforma. */
export type AiVoiceModelType = 'qwen-3.8-omni-flash-realtime' | 'gemini-3.8-live';

/** Herramientas fisicas que los modelos de voz pueden invocar en el navegador. */
export type PhysicalVoiceToolName = 'click_element' | 'type_text' | 'advance_onboarding_step';

/** Parametros de la herramienta `click_element`. */
export interface ClickElementParams {
  readonly elementKey: string;
  readonly reason?: string;
}

/** Parametros de la herramienta `type_text`. */
export interface TypeTextParams {
  readonly elementKey: string;
  readonly text: string;
  readonly submitAfterType?: boolean;
  readonly reason?: string;
}

/** Parametros de la herramienta `advance_onboarding_step`. */
export interface AdvanceStepParams {
  readonly currentStepNumber: number;
  readonly nextStepNumber: number;
  readonly notes?: string;
}

/** Definicion JSON Schema de una herramienta para Google Gemini Live (BidiGenerateContent). */
export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'OBJECT';
    readonly properties: Record<string, {
      readonly type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'INTEGER';
      readonly description: string;
    }>;
    readonly required: readonly string[];
  };
}

/**
 * Declaraciones oficiales de herramientas Function Calling para Gemini 3.8 Live.
 */
export const GEMINI_TOOL_DECLARATIONS: readonly GeminiFunctionDeclaration[] = [
  {
    name: 'click_element',
    description: 'Hace clic en un elemento interactivo (boton, enlace, tarjeta) identificado por su clave del mapa.',
    parameters: {
      type: 'OBJECT',
      properties: {
        elementKey: {
          type: 'STRING',
          description: 'Clave unica del elemento registrada en el mapa funcional (ej: "btn_comenzar").',
        },
        reason: {
          type: 'STRING',
          description: 'Explicacion breve de por que se realiza el clic para guiar al usuario.',
        },
      },
      required: ['elementKey'],
    },
  },
  {
    name: 'type_text',
    description: 'Escribe texto en un campo de entrada (input, textarea) identificado por su clave del mapa.',
    parameters: {
      type: 'OBJECT',
      properties: {
        elementKey: {
          type: 'STRING',
          description: 'Clave unica del campo de texto en el mapa funcional (ej: "input_email").',
        },
        text: {
          type: 'STRING',
          description: 'Texto que se introducira en el campo.',
        },
        reason: {
          type: 'STRING',
          description: 'Motivo de la escritura o indicacion para el usuario.',
        },
      },
      required: ['elementKey', 'text'],
    },
  },
  {
    name: 'advance_onboarding_step',
    description: 'Avanza formalmente al siguiente paso estructurado del flujo de onboarding guiado.',
    parameters: {
      type: 'OBJECT',
      properties: {
        currentStepNumber: {
          type: 'INTEGER',
          description: 'Numero del paso que se acaba de completar con exito.',
        },
        nextStepNumber: {
          type: 'INTEGER',
          description: 'Numero del paso al que se procede.',
        },
        notes: {
          type: 'STRING',
          description: 'Resumen de los logros del paso o estado alcanzado.',
        },
      },
      required: ['currentStepNumber', 'nextStepNumber'],
    },
  },
];

/** Entidad inmutable de una Sesion de Voz persistida en PostgreSQL. */
export interface VoiceSessionEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly functionalMapId: string;
  readonly apiKeyId: string | null;
  readonly externalEndUserId: string | null;
  readonly originDomain: string;
  readonly aiModelUsed: AiVoiceModelType;
  readonly status: VoiceSessionStatus;
  readonly endUserConsentVerified: boolean;
  readonly currentStepIndex: number;
  readonly totalStepsCompleted: number;
  readonly bargeInCount: number;
  readonly totalToolCallsCount: number;
  readonly durationSeconds: number;
  readonly billedMinutes: string;
  readonly totalBilledCostUsd: string;
  readonly clientIpHash: string;
  readonly userAgent: string | null;
  readonly deviceViewportType: 'desktop' | 'tablet' | 'mobile';
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly terminationReason: string | null;
  readonly createdAt: Date;
}

/** Entidad inmutable de un Evento de Accion fisica ejecutado por una herramienta. */
export interface ActionEventEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly voiceSessionId: string;
  readonly mapElementId: string | null;
  readonly providerToolCallId: string;
  readonly toolName: PhysicalVoiceToolName;
  readonly routePathAtExecution: string;
  readonly selectorUsed: string;
  readonly actionPayloadRedactedJson: Record<string, unknown>;
  readonly executionStatus: 'DISPATCHED' | 'ACK_SUCCESS' | 'REJECTED_BY_GUARDRAIL' | 'BLOCKED_SENSITIVE_FIELD' | 'FAILED_CLIENT_TIMEOUT';
  readonly executionLatencyMs: number | null;
  readonly errorCode: string | null;
  readonly dispatchedAt: Date;
  readonly acknowledgedAt: Date | null;
}

/**
 * Maquina de estados para gestionar el avance secuencial de pasos de onboarding.
 */
export class OnboardingStepStateMachine {
  private currentStep: number;
  private readonly totalSteps: number;
  private readonly strictEnforcement: boolean;

  public constructor(initialStep: number, totalSteps: number, strictEnforcement = true) {
    this.currentStep = Math.max(1, initialStep);
    this.totalSteps = Math.max(1, totalSteps);
    this.strictEnforcement = strictEnforcement;
  }

  public getCurrentStep(): number {
    return this.currentStep;
  }

  public getTotalSteps(): number {
    return this.totalSteps;
  }

  public isComplete(): boolean {
    return this.currentStep >= this.totalSteps;
  }

  public validateTransition(targetStep: number): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
    if (targetStep < 1 || targetStep > this.totalSteps) {
      return {
        allowed: false,
        reason: `El paso objetivo ${targetStep} esta fuera del rango [1, ${this.totalSteps}]`,
      };
    }

    if (this.strictEnforcement && targetStep !== this.currentStep + 1 && targetStep !== this.currentStep) {
      return {
        allowed: false,
        reason: `Avance secuencial estricto activado: no se puede saltar del paso ${this.currentStep} al paso ${targetStep}`,
      };
    }

    return { allowed: true };
  }

  public advance(targetStep: number): void {
    const check = this.validateTransition(targetStep);
    if (!check.allowed) {
      throw new ValidationError(check.reason);
    }
    this.currentStep = targetStep;
  }
}

/** Esquema Zod de entrada para iniciar o registrar una sesion de voz. */
export const startVoiceSessionSchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  functionalMapId: z.string().uuid(),
  apiKeyId: z.string().uuid().optional(),
  externalEndUserId: z.string().max(255).optional(),
  originDomain: z.string().min(1).max(255),
  aiModelUsed: z.enum(['qwen-3.8-omni-flash-realtime', 'gemini-3.8-live']),
  endUserConsentVerified: z.boolean().default(true),
  clientIp: z.string().min(1).max(64),
  userAgent: z.string().max(1024).optional(),
  deviceViewportType: z.enum(['desktop', 'tablet', 'mobile']).default('desktop'),
});

export type StartVoiceSessionInput = z.infer<typeof startVoiceSessionSchema>;
