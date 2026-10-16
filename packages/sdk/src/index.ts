/**
 * @archivo packages/sdk/src/index.ts
 * @modulo @onboarding-assistant/sdk (Punto de Entrada del Paquete del SDK)
 * @proposito
 *   Exporta la API pública del cliente oficial `@onboarding-assistant/sdk`:
 *   inicializador `OnboardingAssistant`, tipos de configuración, motor de ejecución
 *   de acciones físicas en el DOM y filtros de ciberseguridad y privacidad.
 */

export {
  OnboardingAssistantClient,
  type OnboardingAssistantOptions,
} from './core/sdk-client';

export {
  ActionExecutor,
  type ToolExecutePayload,
  type ToolExecutionAckPayload,
  type ToolExecutionStatus,
} from './dom/action-executor';

export {
  SensitiveFieldScrubber,
  SensitiveFieldAccessBlockedError,
  defaultSensitiveFieldScrubber,
} from './security/sensitive-field-scrubber';

import { OnboardingAssistantClient, type OnboardingAssistantOptions } from './core/sdk-client';

/**
 * Objeto global de conveniencia para inicialización rápida del SDK.
 */
export const OnboardingAssistant = {
  init(options: OnboardingAssistantOptions): OnboardingAssistantClient {
    return OnboardingAssistantClient.init(options);
  },
};

export default OnboardingAssistant;
