/**
 * @archivo packages/sdk/src/security/sensitive-field-scrubber.ts
 * @modulo @onboarding-assistant/sdk (Ciberseguridad y Privacidad en el Navegador del Cliente)
 * @proposito
 *   Bloqueador de seguridad ejecutado 100% en el cliente (Browser DOM). Impide que el
 *   asistente de voz lea, seleccione, manipule o ejecute acciones (`type_text`, `click_element`)
 *   sobre campos clasificados como sensibles (contraseñas, tarjetas de crédito, PINs, SSN)
 *   o marcados explícitamente con `data-oa-sensitive="true"`.
 *
 * @resumen_contenido
 *   - Constantes de detección: `SENSITIVE_INPUT_TYPES`, `SENSITIVE_AUTOCOMPLETE_PREFIXES`, `SENSITIVE_KEYWORDS`.
 *   - Clase `SensitiveFieldScrubber`:
 *     - `isElementSensitive(el)`: Inspección jerárquica con `closest()`.
 *     - `isSelectorTargetingSensitiveField(selector)`: Evaluación estática preventiva de selectores.
 *     - `scrubSensitiveText(text)`: Enmascaramiento de patrones PAN / CVV.
 *     - `assertElementSafe(el, action)`: Barrera de aserción previa al despacho de eventos.
 *
 * @dependencias_internas
 *   - Ninguna (Cero dependencias externas en el bundle del SDK).
 */

/** Tipos de input HTML estrictamente bloqueados por seguridad. */
const SENSITIVE_INPUT_TYPES = new Set<string>([
  'password',
  'hidden',
]);

/** Prefijos o valores de autocomplete de tarjetas de crédito y credenciales. */
const SENSITIVE_AUTOCOMPLETE_VALUES = new Set<string>([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-type',
  'bday',
  'transaction-amount',
]);

/** Palabras clave en identificadores, nombres o clases que denotan información sensible. */
const SENSITIVE_NAME_OR_ID_PATTERNS = [
  /password/i,
  /passwd/i,
  /pin/i,
  /cvv/i,
  /cvc/i,
  /credit[-_]?card/i,
  /card[-_]?num/i,
  /ssn/i,
  /social[-_]?sec/i,
  /secret/i,
  /token/i,
];

/** Expresión regular para enmascarar posibles números de tarjeta de crédito (13-19 dígitos). */
const CREDIT_CARD_PAN_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/** Expresión regular para enmascarar CVV/CVC de 3 o 4 dígitos aislados. */
const CVV_REGEX = /\b\d{3,4}\b/g;

/** Excepción lanzada cuando el asistente intenta interactuar con un campo protegido. */
export class SensitiveFieldAccessBlockedError extends Error {
  public readonly code = 'BLOCKED_SENSITIVE_FIELD';

  public constructor(message: string) {
    super(message);
    this.name = 'SensitiveFieldAccessBlockedError';
  }
}

/**
 * Escudo de privacidad y ciberseguridad en el navegador del cliente.
 */
export class SensitiveFieldScrubber {
  /**
   * Determina si un elemento DOM es sensible evaluando sus atributos, tipo,
   * metadatos de accesibilidad o herencia de ancestros protegidos.
   */
  public isElementSensitive(element: Element | null): boolean {
    if (!element) return false;

    // 1. Verificación de exclusión explícita declarada por el desarrollador
    if (element.closest('[data-oa-sensitive="true"]')) {
      return true;
    }

    // 2. Elementos dentro de iframes de pasarelas de pago o dominios externos
    const iframeAncestor = element.closest('iframe');
    if (iframeAncestor) {
      const src = iframeAncestor.getAttribute('src') ?? '';
      if (/stripe|paypal|whop|braintree|adyen|checkout/i.test(src)) {
        return true;
      }
    }

    // 3. Si es un input o textarea, verificar tipo y atributos específicos
    const tagName = element.tagName ? element.tagName.toUpperCase() : '';
    const isInputOrTextArea =
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      (typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement);

    if (isInputOrTextArea) {
      const inputType = (element.getAttribute('type') ?? (element as { type?: string }).type ?? 'text').toLowerCase();
      if (SENSITIVE_INPUT_TYPES.has(inputType)) {
        return true;
      }

      const autocomplete = element.getAttribute('autocomplete')?.toLowerCase() ?? '';
      if (SENSITIVE_AUTOCOMPLETE_VALUES.has(autocomplete)) {
        return true;
      }

      // Evaluar nombre, id y atributo aria-label
      const name = element.getAttribute('name') ?? '';
      const id = element.getAttribute('id') ?? '';
      const ariaLabel = element.getAttribute('aria-label') ?? '';
      const placeholder = element.getAttribute('placeholder') ?? '';

      const targetText = `${name} ${id} ${ariaLabel} ${placeholder}`;
      for (const pattern of SENSITIVE_NAME_OR_ID_PATTERNS) {
        if (pattern.test(targetText)) {
          return true;
        }
      }

      // 4. Estilos de texto ofuscado (-webkit-text-security)
      try {
        if (typeof window !== 'undefined' && window.getComputedStyle) {
          const style = window.getComputedStyle(element);
          const textSecurity = (style as CSSStyleDeclaration & { webkitTextSecurity?: string }).webkitTextSecurity;
          if (textSecurity && textSecurity !== 'none') {
            return true;
          }
        }
      } catch {
        // En entornos sin getComputedStyle completo se continúa
      }
    }

    return false;
  }

  /**
   * Inspección preventiva estática de una cadena de selector CSS.
   * Si el selector menciona atributos explícitos de passwords o tarjetas, se bloquea.
   */
  public isSelectorTargetingSensitiveField(selector: string): boolean {
    const lower = selector.toLowerCase();

    if (lower.includes('type="password"') || lower.includes("type='password'")) {
      return true;
    }

    for (const keyword of ['cvv', 'cvc', 'password', 'credit_card', 'cardnumber', 'ssn']) {
      if (lower.includes(keyword)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Garantiza que el elemento sea seguro antes de ejecutar una acción física.
   * Lanza `SensitiveFieldAccessBlockedError` si el elemento está protegido.
   */
  public assertElementSafeForAction(element: Element, actionName: string): void {
    if (this.isElementSensitive(element)) {
      throw new SensitiveFieldAccessBlockedError(
        `Acción '${actionName}' rechazada: El elemento objetivo '${element.tagName.toLowerCase()}' está protegido por la política de ciberseguridad y privacidad.`
      );
    }
  }

  /**
   * Enmascara números de tarjetas de crédito y patrones sensibles en cadenas de texto
   * antes de enviar datos al WebSocket o generar transcripciones locales.
   */
  public scrubSensitiveText(text: string): string {
    if (!text) return text;
    return text
      .replace(CREDIT_CARD_PAN_REGEX, '[CARD_REDACTED]')
      .replace(CVV_REGEX, '[CVV_REDACTED]');
  }
}

/** Instancia única compartida del scrubber para el SDK. */
export const defaultSensitiveFieldScrubber = new SensitiveFieldScrubber();
