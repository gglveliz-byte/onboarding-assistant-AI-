/**
 * @archivo apps/web/src/components/docs-sandbox/sandbox-contracts.types.ts
 * @modulo 08. Landing de Documentación & Sandbox — Contratos Compartidos del Sandbox
 * @proposito
 *   Congela los tipos, presets de viewport y constantes compartidas entre el panel
 *   izquierdo (inspector de tramas del protocolo en vivo) y el panel central (lienzo
 *   de la aplicación de prueba responsive con bloqueo de campos sensibles) del
 *   Sandbox interactivo de `/docs/sandbox`. Es un contrato de datos puro: sin lógica
 *   de red, sin estado y sin dependencias de frameworks.
 *
 * @resumen_contenido
 *   - `SandboxViewportId`, `SandboxViewportPreset` y `SANDBOX_VIEWPORT_PRESETS`
 *     (Desktop 1440x900, Tablet 768x1024 y Mobile 390x844).
 *   - `SandboxFrameDirection` y `SandboxWsFrameLogEntry`: bitácora de tramas del
 *     protocolo bidireccional en vivo.
 *   - `SandboxToolName`, `SandboxToolDispatchRequest` y `SandboxToolDispatchResult`:
 *     despacho local simulado de `click_element` y `type_text`.
 *   - `SandboxElementProbeResult`: sonda de un elemento instrumentado con su cascada
 *     de selectores y su condición de campo sensible.
 *   - `SANDBOX_SIMULATE_ACTION_PATH` y `SandboxSimulateActionBackendResponse`:
 *     contrato real de `POST /api/v1/public/sandbox/simulate-action`.
 *
 * @dependencias_internas
 *   - Consumido por `ApiAndProtocolSpecViewer.tsx`, `SandboxTargetApplicationCanvas.tsx`
 *     y por el orquestador del Sandbox (Subagente 2.8).
 *
 * @dependencias_externas
 *   - Ninguna (solo tipos y constantes de TypeScript).
 *
 * @notas
 *   - Los campos `isElementSensitive` y `bboxNorm` reflejan el esquema Zod real del
 *     backend (`src/modules/07-public-commercial-and-sandbox/domain/public-commercial.entities.ts`);
 *     el servidor bloquea la simulación cuando la cascada de selectores apunta a un
 *     campo de contraseña, tarjeta o CVV.
 */

/** Viewports responsive soportados por el lienzo de la aplicación de prueba. */
export type SandboxViewportId = 'desktop' | 'tablet' | 'mobile';

/** Preset de viewport: identifica el dispositivo y su dimensión lógica en píxeles. */
export interface SandboxViewportPreset {
  readonly id: SandboxViewportId;
  readonly label: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * Presets oficiales del conmutador responsive del lienzo central.
 * Composición visual del botón correspondiente: `<label> <widthPx>x<heightPx>`.
 */
export const SANDBOX_VIEWPORT_PRESETS: readonly SandboxViewportPreset[] = [
  { id: 'desktop', label: 'Desktop', widthPx: 1440, heightPx: 900 },
  { id: 'tablet', label: 'Tablet', widthPx: 768, heightPx: 1024 },
  { id: 'mobile', label: 'Mobile', widthPx: 390, heightPx: 844 },
];

/** Dirección de tráfico de una trama del protocolo de voz en vivo. */
export type SandboxFrameDirection = 'client_to_server' | 'server_to_client';

/** Entrada de la bitácora de tramas bidireccionales del protocolo en vivo. */
export interface SandboxWsFrameLogEntry {
  /** Identificador único de la trama dentro de la sesión de Sandbox. */
  readonly id: string;
  /** Dirección de tráfico de la trama respecto a la sesión. */
  readonly direction: SandboxFrameDirection;
  /** Tipo de trama (por ejemplo `tool.execute` o `tool.execution.ack`). */
  readonly frameType: string;
  /** Marca temporal de recepción de la trama en formato ISO 8601. */
  readonly timestampIso: string;
  /** Resumen legible de una línea para la lista del inspector en vivo. */
  readonly payloadPreview: string;
  /** JSON crudo de la trama, tal como viajó por el canal. */
  readonly rawJson: string;
  /** Latencia medida en milisegundos, solo cuando la trama la reporta. */
  readonly latencyMs?: number;
}

/**
 * Herramientas físicas que el Sandbox puede simular localmente.
 * Es un subconjunto del vocabulario real del motor de acciones del SDK
 * (`ToolExecutePayload.toolName`); el paso `advance_onboarding_step` no se expone
 * en esta superficie pública de demostración.
 */
export type SandboxToolName = 'click_element' | 'type_text';

/**
 * Solicitud de despacho local de una orden de herramienta sobre el lienzo.
 * Refleja fielmente los campos que el servidor exige en `sandboxSimulateActionSchema`
 * (cascada obligatoria de al menos un selector y bandera de elemento sensible).
 */
export interface SandboxToolDispatchRequest {
  /** Herramienta a simular. */
  readonly toolName: SandboxToolName;
  /** Ancla `data-oa-id` del elemento objetivo dentro de la aplicación de prueba. */
  readonly targetOaId: string;
  /** Cascada de selectores en orden de precedencia (del más específico al más laxo). */
  readonly selectorCascade: readonly string[];
  /** Texto a escribir cuando la herramienta es `type_text`. */
  readonly textValue?: string;
  /** Cadencia humana simulada en milisegundos entre pulsos de la acción. */
  readonly humanCadenceMs: number;
  /** Marca si el elemento objetivo es un campo sensible (dispara bloqueo del servidor). */
  readonly isElementSensitive: boolean;
}

/**
 * Resultado local del despacho simulado de una orden de herramienta.
 * El estado `BLOCKED_SENSITIVE_FIELD` replica el corte que el servidor aplica cuando
 * la cascada resuelve a un prefijo de contraseña, tarjeta o CVV.
 */
export interface SandboxToolDispatchResult {
  readonly status: 'SUCCESS' | 'BLOCKED_SENSITIVE_FIELD' | 'ERROR';
  /** Duración medida en milisegundos desde el disparo hasta la resolución. */
  readonly durationMs: number;
  /** Respuesta simulada legible que se muestra en el panel de salida. */
  readonly simulatedResponse: string;
  /** Selector de la cascada que resolvió al elemento (cadena vacía si no hubo). */
  readonly resolvedSelector: string;
  /** Verdadero cuando el scrubber de privacidad impidió la acción. */
  readonly blockedBySensitiveField: boolean;
}

/**
 * Sonda emitida por el lienzo cuando el usuario enfoca o pulsa un elemento
 * instrumentado (`data-oa-id`); los campos sensibles jamás emiten sonda normal.
 */
export interface SandboxElementProbeResult {
  /** Ancla `data-oa-id` del elemento instrumentado. */
  readonly oaId: string;
  /** Cascada realista de 2 a 3 selectores derivada del DOM en vivo. */
  readonly selectorCascade: readonly string[];
  /** Verdadero solo si el elemento es un campo bloqueado por privacidad. */
  readonly isSensitive: boolean;
}

/** Ruta real del endpoint de simulación del Sandbox en el backend. */
export const SANDBOX_SIMULATE_ACTION_PATH: string = '/api/v1/public/sandbox/simulate-action';

/**
 * Respuesta real del backend para `POST /api/v1/public/sandbox/simulate-action`.
 * Es la forma serializada de `SandboxSimulationResultEntity` del módulo 07: conserva
 * `success`, `blockedBySensitiveField`, `durationMs` y `simulatedResponse` íntegros.
 */
export interface SandboxSimulateActionBackendResponse {
  readonly success: boolean;
  readonly toolName: string;
  readonly resolvedSelector: string;
  /** Descripción legible de la acción aplicada (vacía si fue bloqueada). */
  readonly actionSimulated: string;
  readonly blockedBySensitiveField: boolean;
  readonly durationMs: number;
  readonly simulatedResponse: string;
}
