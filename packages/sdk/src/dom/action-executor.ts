/**
 * @archivo packages/sdk/src/dom/action-executor.ts
 * @modulo @onboarding-assistant/sdk (Motor de Ejecución de Acciones Físicas en el DOM)
 * @proposito
 *   Recibe y ejecuta en el navegador del cliente las órdenes de herramientas (`tool.execute`)
 *   emitidas por el Gateway de Voz (`click_element`, `type_text`, `advance_onboarding_step`).
 *   Resuelve elementos mediante cascada de selectores o coordenadas responsive `bbox_norm`,
 *   aplica el scrubber de seguridad, anima el cursor asistido y despacha eventos nativos
 *   con compatibilidad universal para React, Vue, Angular y Vanilla JS.
 *
 * @resumen_contenido
 *   - Interfaces `ToolExecutePayload`, `ToolExecutionAckPayload`, `ResolvedDomElement`.
 *   - Clase `ActionExecutor`:
 *     - `executeTool(payload)`: Punto de entrada principal con medición de latencia.
 *     - `resolveElement(selectors, bboxNorm)`: Resolución resiliente en cascada.
 *     - `performClick(el)`: Secuencia completa de eventos de puntero y ratón.
 *     - `performType(el, text)`: Inyección reactiva usando setters nativos de prototipo.
 *     - `animateVirtualCursor(el)`: Guía visual fluida para el usuario final.
 *
 * @dependencias_internas
 *   - `SensitiveFieldScrubber`, `defaultSensitiveFieldScrubber` (../security/sensitive-field-scrubber.ts).
 */

import {
  SensitiveFieldScrubber,
  defaultSensitiveFieldScrubber,
} from '../security/sensitive-field-scrubber';

/** Payload de orden de herramienta recibido desde el Gateway de Voz. */
export interface ToolExecutePayload {
  readonly actionId: string;
  readonly toolName: 'click_element' | 'type_text' | 'advance_onboarding_step';
  readonly selectorCascade: readonly string[];
  readonly textToType?: string | undefined;
  readonly bboxNorm?: readonly [number, number, number, number] | undefined;
  readonly stepIndex?: number | undefined;
}

/** Estado de respuesta tras intentar ejecutar una acción en el DOM. */
export type ToolExecutionStatus =
  | 'ACK_SUCCESS'
  | 'ELEMENT_NOT_FOUND'
  | 'ACTION_REJECTED'
  | 'BLOCKED_SENSITIVE_FIELD';

/** Paquete de confirmación devuelto hacia el Gateway de Voz. */
export interface ToolExecutionAckPayload {
  readonly actionId: string;
  readonly status: ToolExecutionStatus;
  readonly durationMs: number;
  readonly resolvedSelector: string | null;
  readonly errorMessage: string | null;
}

/** Resultado de resolución de un elemento en el DOM. */
interface ResolvedDomElement {
  readonly element: Element;
  readonly matchingSelector: string;
}

/**
 * Motor físico de automatización y asistencia DOM en el navegador.
 */
export class ActionExecutor {
  public constructor(
    private readonly scrubber: SensitiveFieldScrubber = defaultSensitiveFieldScrubber,
    private readonly showVirtualCursor: boolean = true
  ) {}

  /**
   * Ejecuta una orden de herramienta solicitada por el asistente de voz.
   */
  public async executeTool(payload: ToolExecutePayload): Promise<ToolExecutionAckPayload> {
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    try {
      if (payload.toolName === 'advance_onboarding_step') {
        this.dispatchCustomEvent('oa:step_advanced', {
          stepIndex: payload.stepIndex,
          actionId: payload.actionId,
        });

        const elapsed = Math.round(
          ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime
        );

        return {
          actionId: payload.actionId,
          status: 'ACK_SUCCESS',
          durationMs: Math.max(1, elapsed),
          resolvedSelector: null,
          errorMessage: null,
        };
      }

      // 1. Resolución resiliente del elemento en el DOM
      const resolved = this.resolveElement(payload.selectorCascade, payload.bboxNorm);
      if (!resolved) {
        return {
          actionId: payload.actionId,
          status: 'ELEMENT_NOT_FOUND',
          durationMs: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime),
          resolvedSelector: null,
          errorMessage: `Ningún elemento de la cascada de selectores [${payload.selectorCascade.join(', ')}] fue encontrado en el DOM activo.`,
        };
      }

      const targetEl = resolved.element;

      // 2. Verificación estricta de privacidad y ciberseguridad
      if (this.scrubber.isElementSensitive(targetEl)) {
        return {
          actionId: payload.actionId,
          status: 'BLOCKED_SENSITIVE_FIELD',
          durationMs: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime),
          resolvedSelector: resolved.matchingSelector,
          errorMessage: 'Acción bloqueada: El campo objetivo está catalogado como sensible por la política de privacidad.',
        };
      }

      // 3. Animación guiada del cursor virtual hacia el elemento objetivo
      if (this.showVirtualCursor) {
        this.animateVirtualCursor(targetEl);
      }

      // 4. Ejecución física según la herramienta
      if (payload.toolName === 'click_element') {
        await this.performClick(targetEl);
      } else if (payload.toolName === 'type_text') {
        await this.performType(targetEl, payload.textToType ?? '');
      }

      const elapsed = Math.round(
        ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime
      );

      return {
        actionId: payload.actionId,
        status: 'ACK_SUCCESS',
        durationMs: Math.max(5, elapsed),
        resolvedSelector: resolved.matchingSelector,
        errorMessage: null,
      };
    } catch (error) {
      const elapsed = Math.round(
        ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime
      );
      const msg = error instanceof Error ? error.message : 'Error desconocido al ejecutar acción DOM';

      return {
        actionId: payload.actionId,
        status: 'ACTION_REJECTED',
        durationMs: Math.max(1, elapsed),
        resolvedSelector: payload.selectorCascade[0] ?? null,
        errorMessage: msg,
      };
    }
  }

  /**
   * Resuelve el elemento objetivo probando secuencialmente cada selector de la cascada.
   * Si fallan los selectores CSS, intenta localizar por coordenadas de pantalla normalizadas.
   */
  public resolveElement(
    selectors: readonly string[],
    bboxNorm?: readonly [number, number, number, number] | undefined
  ): ResolvedDomElement | null {
    if (typeof document === 'undefined') return null;

    // A. Probar selectores CSS en orden de prioridad
    for (const selector of selectors) {
      try {
        const found = document.querySelector(selector);
        if (found && this.isElementVisible(found)) {
          return { element: found, matchingSelector: selector };
        }
      } catch {
        // Selector CSS malformado o no soportado por el navegador
        continue;
      }
    }

    // B. Fallback a coordenadas normalizadas [ymin, xmin, ymax, xmax] (0 a 1000)
    if (bboxNorm && typeof window !== 'undefined') {
      const [ymin, xmin, ymax, xmax] = bboxNorm;
      const clientX = (((xmin + xmax) / 2) / 1000) * window.innerWidth;
      const clientY = (((ymin + ymax) / 2) / 1000) * window.innerHeight;

      if (typeof document.elementFromPoint === 'function') {
        const foundAtPoint = document.elementFromPoint(clientX, clientY);
        if (foundAtPoint && this.isElementVisible(foundAtPoint)) {
          return { element: foundAtPoint, matchingSelector: `bbox:[${bboxNorm.join(',')}]` };
        }
      }
    }

    return null;
  }

  /**
   * Ejecuta un clic sintético completo disparando la cadena nativa de eventos.
   */
  public async performClick(element: Element): Promise<void> {
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await this.sleep(40);
    }

    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { left: 0, top: 0, width: 10, height: 10 };
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: typeof window !== 'undefined' ? window : null,
      clientX,
      clientY,
    };

    // Secuencia Pointer Events + Mouse Events
    this.dispatchEventIfExists(element, 'pointerover', eventInit);
    this.dispatchEventIfExists(element, 'pointerenter', eventInit);
    this.dispatchEventIfExists(element, 'pointerdown', eventInit);
    this.dispatchEventIfExists(element, 'mousedown', eventInit);

    if (typeof (element as unknown as { focus?: () => void }).focus === 'function') {
      (element as unknown as { focus: () => void }).focus();
    }

    this.dispatchEventIfExists(element, 'pointerup', eventInit);
    this.dispatchEventIfExists(element, 'mouseup', eventInit);

    // Click nativo
    if (typeof (element as unknown as { click?: () => void }).click === 'function') {
      (element as unknown as { click: () => void }).click();
    } else {
      this.dispatchEventIfExists(element, 'click', eventInit);
    }
  }

  /**
   * Escribe texto en un input o textarea emulando la reactividad nativa de React/Vue/Angular.
   */
  public async performType(element: Element, textToType: string): Promise<void> {
    if (typeof (element as unknown as { focus?: () => void }).focus === 'function') {
      (element as unknown as { focus: () => void }).focus();
    }

    const tagName = element.tagName ? element.tagName.toUpperCase() : '';
    const isInput = tagName === 'INPUT' || (typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement);
    const isTextArea = tagName === 'TEXTAREA' || (typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement);

    if (isInput || isTextArea) {
      // Usar setter nativo de prototipo para saltar envolturas sintéticas de React 18/19
      const proto = typeof window !== 'undefined'
        ? (isInput ? window.HTMLInputElement?.prototype : window.HTMLTextAreaElement?.prototype)
        : undefined;
      const nativeValueSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;

      if (nativeValueSetter) {
        nativeValueSetter.call(element, textToType);
      } else {
        (element as { value?: string }).value = textToType;
      }

      // Disparar InputEvent y ChangeEvent de forma segura
      if (typeof InputEvent !== 'undefined') {
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: textToType,
          inputType: 'insertText',
        }));
      } else {
        this.dispatchEventIfExists(element, 'input', { bubbles: true, cancelable: true });
      }

      if (typeof Event !== 'undefined') {
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      } else {
        this.dispatchEventIfExists(element, 'change', { bubbles: true, cancelable: true });
      }
    } else {
      // Elementos contenteditable
      if (element.getAttribute('contenteditable') === 'true' || (element as { isContentEditable?: boolean }).isContentEditable) {
        element.textContent = textToType;
        if (typeof Event !== 'undefined') {
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  }

  /**
   * Renderiza y anima un cursor virtual flotante hacia el centro del elemento objetivo.
   */
  private animateVirtualCursor(element: Element): void {
    if (typeof document === 'undefined') return;

    let cursor = document.getElementById('oa-virtual-cursor');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = 'oa-virtual-cursor';
      cursor.style.position = 'fixed';
      cursor.style.width = '20px';
      cursor.style.height = '20px';
      cursor.style.borderRadius = '50%';
      cursor.style.backgroundColor = 'rgba(245, 78, 0, 0.85)'; // Color Ember característico
      cursor.style.boxShadow = '0 0 12px rgba(245, 78, 0, 0.6)';
      cursor.style.pointerEvents = 'none';
      cursor.style.zIndex = '999999';
      cursor.style.transition = 'all 280ms cubic-bezier(0.22, 1, 0.36, 1)';
      cursor.style.transform = 'translate(-50%, -50%)';
      cursor.style.opacity = '0';
      document.body?.appendChild(cursor);
    }

    if (element.getBoundingClientRect) {
      const rect = element.getBoundingClientRect();
      cursor.style.left = `${rect.left + rect.width / 2}px`;
      cursor.style.top = `${rect.top + rect.height / 2}px`;
      cursor.style.opacity = '1';

      // Ocultar suavemente después de 1.8 segundos
      setTimeout(() => {
        if (cursor) cursor.style.opacity = '0';
      }, 1800);
    }
  }

  /** Comprueba si el elemento está visible en el viewport y no tiene display none / hidden. */
  private isElementVisible(element: Element): boolean {
    if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
      if (element.offsetParent === null && element.tagName !== 'BODY') {
        return false;
      }
    }
    return true;
  }

  private dispatchEventIfExists(target: EventTarget, eventType: string, init: MouseEventInit): void {
    try {
      if (typeof MouseEvent !== 'undefined') {
        target.dispatchEvent(new MouseEvent(eventType, init));
      } else if (typeof CustomEvent !== 'undefined') {
        target.dispatchEvent(new CustomEvent(eventType, { detail: init }));
      } else if (typeof (target as { dispatchEvent?: (e: unknown) => boolean }).dispatchEvent === 'function') {
        (target as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent({ type: eventType });
      }
    } catch {
      // Tolera navegadores con restricciones en MouseEvent sintético
    }
  }

  private dispatchCustomEvent(name: string, detail: unknown): void {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
      } catch {
        // Entornos sin CustomEvent nativo
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
