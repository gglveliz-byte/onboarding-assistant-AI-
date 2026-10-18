/**
 * @archivo packages/sdk/src/ui/assistant-widget-shadow.ts
 * @modulo @onboarding-assistant/sdk (Widget de Asistente Aislado en Shadow DOM)
 * @proposito
 *   Burbuja flotante y panel del asistente de voz aislados en un `ShadowRoot` cerrado:
 *   paleta Atelier, consentimiento `END_USER_VOICE_CONSENT`, píldoras de estado, botones
 *   de interrupción/finalización y cursor asistido con pulso de acción.
 * @dependencias_externas
 *   - Solo APIs DOM estándar; nada de `document.body` en el constructor (solo en `mount()`).
 */

/** Tema visual del widget; todos los campos son opcionales. */
export interface AssistantWidgetTheme {
  /** Color de acento puntual (por defecto el Ember del Atelier: `#f54e00`). */
  readonly accentColor?: string;
  /** Esquina de anclaje de la burbuja flotante (por defecto `bottom-right`). */
  readonly position?: 'bottom-right' | 'bottom-left';
  /** URL de la política de voz del usuario final mostrada en «Ver política». */
  readonly consentPolicyUrl?: string;
}

/** Callbacks que el widget delega al integrador del SDK. */
export interface AssistantWidgetHandlers {
  /** El usuario aceptó el consentimiento y pidió activar el asistente. */
  readonly onStartRequested: () => void;
  /** El usuario pidió finalizar la sesión de voz. */
  readonly onStopRequested: () => void;
  /** El usuario pidió interrumpir manualmente al asistente (barge-in manual). */
  readonly onInterruptRequested: () => void;
}

/** Estado visible del asistente reflejado en las píldoras del panel. */
export type AssistantWidgetStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

/** Color de acento por defecto (Ember del Atelier, solo como acento puntual). */
const DEFAULT_ACCENT_COLOR = '#f54e00';
/** URL por defecto de la política de voz mostrada en el consentimiento. */
const DEFAULT_CONSENT_POLICY_URL = '/legal/end-user-voice-consent';
/** Orden canónico de las píldoras de estado. */
const WIDGET_STATUS_ORDER: readonly AssistantWidgetStatus[] = ['idle', 'connecting', 'listening', 'speaking', 'error'];

/**
 * Hoja de estilos inyectada dentro del `ShadowRoot` cerrado: paleta Atelier
 * (pergamino `#f7f7f4`, hueso `#f2f1ed`, lino `#e6e5e0`, tinta `#26251e`),
 * radios de 4px, tipografía del sistema y cero blanco/negro puro.
 */
const WIDGET_SHADOW_STYLES = `
:host { position: fixed; bottom: 24px; right: 24px; z-index: 2147483000; pointer-events: none; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #26251e; }
:host(.oa-widget-host--left) { right: auto; left: 24px; }
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
.oa-root { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
:host(.oa-widget-host--left) .oa-root { align-items: flex-start; }
.oa-bubble { position: relative; pointer-events: auto; display: inline-flex; align-items: center; justify-content: center; width: 46px; height: 46px; background-color: #f2f1ed; border: 1px solid #cdcdc9; border-radius: 4px; color: #26251e; cursor: pointer; box-shadow: rgba(38, 37, 30, 0.18) 0 12px 28px; transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
.oa-bubble:hover { background-color: #e6e5e0; border-color: #a1a19f; }
.oa-bubble:focus-visible { outline: 2px solid color-mix(in oklab, #26251e 45%, transparent); outline-offset: 2px; }
.oa-bubble.is-live { border-color: color-mix(in oklab, var(--oa-accent, #f54e00) 45%, #cdcdc9); }
.oa-bubble.is-live::after { content: ''; position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%; background-color: var(--oa-accent, #f54e00); border: 1px solid #f7f7f4; }
.oa-panel { pointer-events: auto; position: absolute; bottom: 56px; right: 0; width: min(320px, calc(100vw - 48px)); max-height: min(70vh, 560px); overflow-y: auto; background-color: #f7f7f4; border: 1px solid #cdcdc9; border-radius: 4px; box-shadow: rgba(38, 37, 30, 0.2) 0 18px 44px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
:host(.oa-widget-host--left) .oa-panel { right: auto; left: 0; }
.oa-panel__bar { display: flex; align-items: center; gap: 8px; }
.oa-panel__title { flex: 1; font-size: 14px; font-weight: 400; color: #26251e; }
.oa-icon-btn { pointer-events: auto; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background-color: transparent; border: 1px solid #cdcdc9; border-radius: 4px; color: #7a7974; font-size: 12px; line-height: 1; cursor: pointer; }
.oa-icon-btn:hover { background-color: #e6e5e0; color: #26251e; }
.oa-icon-btn:focus-visible { outline: 2px solid color-mix(in oklab, #26251e 45%, transparent); outline-offset: 2px; }
.oa-consent { display: flex; flex-direction: column; gap: 8px; background-color: #f2f1ed; border: 1px solid #cdcdc9; border-radius: 4px; padding: 12px; }
.oa-consent__eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #7a7974; }
.oa-consent__text { font-size: 13px; line-height: 1.5; color: #26251e; }
.oa-checkbox-row { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.4; color: #26251e; cursor: pointer; }
.oa-checkbox { margin-top: 2px; accent-color: var(--oa-accent, #f54e00); }
.oa-link { align-self: flex-start; font-size: 13px; color: var(--oa-accent, #f54e00); text-decoration: none; }
.oa-link:hover { text-decoration: underline; }
.oa-pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
.oa-pill { display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid #cdcdc9; border-radius: 4px; background-color: #e6e5e0; font-size: 12px; line-height: 1.5; color: #84847e; opacity: 0.6; }
.oa-pill.is-active { opacity: 1; color: #26251e; }
.oa-pill[data-status="connecting"].is-active { color: #c08532; border-color: color-mix(in oklab, #c08532 38%, #cdcdc9); }
.oa-pill[data-status="listening"].is-active { color: #1f8a65; border-color: color-mix(in oklab, #1f8a65 38%, #cdcdc9); }
.oa-pill[data-status="speaking"].is-active { color: var(--oa-accent, #f54e00); border-color: color-mix(in oklab, var(--oa-accent, #f54e00) 36%, #cdcdc9); }
.oa-pill[data-status="error"].is-active { color: #cf2d56; border-color: color-mix(in oklab, #cf2d56 38%, #cdcdc9); }
.oa-actions { display: flex; gap: 8px; }
.oa-btn { pointer-events: auto; display: inline-flex; align-items: center; justify-content: center; padding: 6px 12px; border: 1px solid transparent; border-radius: 4px; font-size: 13px; line-height: 1.4; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.oa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.oa-btn:focus-visible { outline: 2px solid color-mix(in oklab, #26251e 45%, transparent); outline-offset: 2px; }
.oa-btn--primary { flex: 1; background-color: #26251e; color: #f7f7f4; }
.oa-btn--primary:hover:not(:disabled) { background-color: color-mix(in oklab, #26251e 90%, #7a7974); }
.oa-btn--secondary { background-color: #e6e5e0; border-color: #cdcdc9; color: #26251e; }
.oa-btn--secondary:hover:not(:disabled) { background-color: color-mix(in oklab, #e6e5e0 82%, #cdcdc9); }
.oa-btn--crimson { background-color: transparent; border-color: #cf2d56; color: #cf2d56; }
.oa-btn--crimson:hover:not(:disabled) { background-color: color-mix(in oklab, #cf2d56 10%, transparent); }
.oa-cursor { pointer-events: none; position: fixed; left: 0; top: 0; width: 16px; height: 16px; margin: -8px 0 0 -8px; transform: translate3d(0, 0, 0); transition: transform 120ms cubic-bezier(0.22, 1, 0.36, 1); }
.oa-cursor::before { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in oklab, #26251e 35%, transparent); }
.oa-cursor::after { content: ''; position: absolute; left: 5px; top: 5px; width: 6px; height: 6px; border-radius: 50%; background-color: #26251e; }
.oa-cursor.is-pulsing::before { animation: oa-cursor-pulse 420ms ease-out 1; }
@keyframes oa-cursor-pulse { from { transform: scale(0.5); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .oa-cursor { transition: none; } .oa-cursor.is-pulsing::before { animation: none; } }
`;

/** Crea un elemento HTML con clase base y texto opcional. */
function createWidgetElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

/** Construye el icono monolineal de onda sonora (SVG inline, hereda `currentColor`). */
function createWaveIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const iconAttributes: ReadonlyArray<readonly [string, string]> = [
    ['viewBox', '0 0 24 24'],
    ['width', '22'],
    ['height', '22'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '1.6'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'],
  ];
  for (const [attributeName, attributeValue] of iconAttributes) {
    svg.setAttribute(attributeName, attributeValue);
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 12h2.2l1.8-5 2.6 10 2.8-14 2.8 12 1.8-3H21');
  svg.appendChild(path);
  return svg;
}

/** Widget flotante del asistente de voz aislado en un `ShadowRoot` cerrado; el DOM se crea solo en `mount()`. */
export class AssistantWidgetShadow {
  private readonly handlers: AssistantWidgetHandlers;
  private readonly theme: AssistantWidgetTheme;
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private bubble: HTMLButtonElement | null = null;
  private panel: HTMLDivElement | null = null;
  private consentBlock: HTMLDivElement | null = null;
  private consentCheckbox: HTMLInputElement | null = null;
  private startButton: HTMLButtonElement | null = null;
  private interruptButton: HTMLButtonElement | null = null;
  private finishButton: HTMLButtonElement | null = null;
  private cursor: HTMLDivElement | null = null;
  private pills: Record<AssistantWidgetStatus, HTMLSpanElement> | null = null;
  private status: AssistantWidgetStatus = 'idle';
  private panelOpen = false;

  /** Crea el widget con sus callbacks y un tema opcional (acento, esquina y URL de política). */
  public constructor(handlers: AssistantWidgetHandlers, theme?: AssistantWidgetTheme) {
    this.handlers = handlers;
    this.theme = theme ?? {};
  }

  /** Monta el host en `document.body` y construye el shadow; llamarlo dos veces no hace nada. */
  public mount(): void {
    if (this.host !== null) {
      return;
    }
    const host = document.createElement('div');
    host.className = 'oa-widget-host';
    if (this.theme.position === 'bottom-left') {
      host.classList.add('oa-widget-host--left');
    }
    host.style.setProperty('--oa-accent', this.theme.accentColor ?? DEFAULT_ACCENT_COLOR);
    const shadow = host.attachShadow({ mode: 'closed' });
    const styles = document.createElement('style');
    styles.textContent = WIDGET_SHADOW_STYLES;
    shadow.appendChild(styles);
    const root = createWidgetElement('div', 'oa-root');
    shadow.appendChild(root);
    const bubble = createWidgetElement('button', 'oa-bubble');
    bubble.type = 'button';
    bubble.setAttribute('aria-label', 'Abrir el asistente de ayuda');
    bubble.appendChild(createWaveIcon());
    bubble.addEventListener('click', (): void => {
      if (this.panelOpen) {
        this.closePanel();
      } else {
        this.openPanel();
      }
    });
    root.appendChild(bubble);
    const panel = this.buildPanel();
    root.appendChild(panel);
    const cursor = createWidgetElement('div', 'oa-cursor');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.addEventListener('animationend', (): void => {
      cursor.classList.remove('is-pulsing');
    });
    root.appendChild(cursor);
    host.addEventListener('keydown', this.handleHostKeydown);
    document.body.appendChild(host);
    this.host = host;
    this.shadow = shadow;
    this.bubble = bubble;
    this.panel = panel;
    this.cursor = cursor;
    this.applyStatus();
  }

  /** Remueve el host del documento y suelta listeners; seguro si nunca se montó. */
  public unmount(): void {
    if (this.host === null) {
      return;
    }
    this.host.removeEventListener('keydown', this.handleHostKeydown);
    this.host.remove();
    this.host = null;
    this.shadow = null;
    this.bubble = null;
    this.panel = null;
    this.consentBlock = null;
    this.consentCheckbox = null;
    this.startButton = null;
    this.interruptButton = null;
    this.finishButton = null;
    this.cursor = null;
    this.pills = null;
    this.panelOpen = false;
  }

  /** Actualiza el estado visible en píldoras y habilita «Interrumpir» solo al hablar. */
  public setStatus(status: AssistantWidgetStatus): void {
    this.status = status;
    this.applyStatus();
  }

  /** Desplaza el cursor asistido a (xPx, yPx) del viewport con transición de 120 ms por `transform`. */
  public moveVirtualCursor(xPx: number, yPx: number): void {
    if (this.cursor === null) {
      return;
    }
    this.cursor.style.transform = 'translate3d(' + xPx + 'px, ' + yPx + 'px, 0)';
  }

  /** Coloca el cursor en (xPx, yPx) y dispara el pulso de la acción recién ejecutada. */
  public pulseAt(xPx: number, yPx: number): void {
    this.moveVirtualCursor(xPx, yPx);
    if (this.cursor === null) {
      return;
    }
    this.cursor.classList.remove('is-pulsing');
    void this.cursor.offsetWidth;
    this.cursor.classList.add('is-pulsing');
  }

  /** Reexpone el banner de consentimiento y abre el panel (se monta si hace falta). */
  public showConsentOrPrompt(): void {
    if (this.host === null) {
      this.mount();
    }
    if (this.consentBlock !== null) {
      this.consentBlock.hidden = false;
    }
    this.openPanel();
  }

  /** Construye el contenido completo del panel: consentimiento, píldoras y acciones. */
  private buildPanel(): HTMLDivElement {
    const panel = createWidgetElement('div', 'oa-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Asistente de ayuda');
    panel.hidden = true;
    const bar = createWidgetElement('div', 'oa-panel__bar');
    bar.appendChild(createWidgetElement('span', 'oa-panel__title', 'Asistente'));
    const infoButton = createWidgetElement('button', 'oa-icon-btn', 'i');
    infoButton.type = 'button';
    infoButton.setAttribute('aria-label', 'Ver el aviso de voz y la política');
    infoButton.addEventListener('click', (): void => {
      this.showConsentOrPrompt();
    });
    bar.appendChild(infoButton);
    const closeButton = createWidgetElement('button', 'oa-icon-btn', 'x');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Cerrar el panel del asistente');
    closeButton.addEventListener('click', (): void => {
      this.closePanel();
    });
    bar.appendChild(closeButton);
    panel.appendChild(bar);
    const consentBlock = createWidgetElement('div', 'oa-consent');
    consentBlock.setAttribute('data-consent', 'END_USER_VOICE_CONSENT');
    consentBlock.appendChild(createWidgetElement('p', 'oa-consent__eyebrow', 'Consentimiento de voz'));
    consentBlock.appendChild(
      createWidgetElement(
        'p',
        'oa-consent__text',
        'Al activar el asistente, tu micrófono se encenderá y tu voz se procesará en tiempo real para guiarte durante este recorrido. Puedes finalizar la sesión cuando quieras.',
      ),
    );
    const checkboxRow = createWidgetElement('label', 'oa-checkbox-row');
    const consentCheckbox = createWidgetElement('input', 'oa-checkbox');
    consentCheckbox.type = 'checkbox';
    consentCheckbox.addEventListener('change', (): void => {
      if (this.startButton !== null) {
        this.startButton.disabled = !consentCheckbox.checked;
      }
    });
    checkboxRow.appendChild(consentCheckbox);
    checkboxRow.appendChild(createWidgetElement('span', 'oa-checkbox-label', 'Acepto el aviso de voz y el uso del micrófono.'));
    consentBlock.appendChild(checkboxRow);
    const policyLink = createWidgetElement('a', 'oa-link', 'Ver política');
    policyLink.href = this.theme.consentPolicyUrl ?? DEFAULT_CONSENT_POLICY_URL;
    policyLink.target = '_blank';
    policyLink.rel = 'noopener noreferrer';
    consentBlock.appendChild(policyLink);
    const startButton = createWidgetElement('button', 'oa-btn oa-btn--primary', 'Activar asistente');
    startButton.type = 'button';
    startButton.setAttribute('aria-label', 'Activar el asistente de voz');
    startButton.disabled = true;
    startButton.addEventListener('click', this.handleStartRequested);
    consentBlock.appendChild(startButton);
    panel.appendChild(consentBlock);
    const pillRow = createWidgetElement('div', 'oa-pill-row');
    const buildPill = (pillStatus: AssistantWidgetStatus, label: string): HTMLSpanElement => {
      const pill = createWidgetElement('span', 'oa-pill', label);
      pill.setAttribute('data-status', pillStatus);
      pillRow.appendChild(pill);
      return pill;
    };
    const pills: Record<AssistantWidgetStatus, HTMLSpanElement> = {
      idle: buildPill('idle', 'En espera'),
      connecting: buildPill('connecting', 'Conectando'),
      listening: buildPill('listening', 'Escuchando'),
      speaking: buildPill('speaking', 'Hablando'),
      error: buildPill('error', 'Error'),
    };
    panel.appendChild(pillRow);
    const actions = createWidgetElement('div', 'oa-actions');
    const interruptButton = createWidgetElement('button', 'oa-btn oa-btn--crimson', 'Interrumpir');
    interruptButton.type = 'button';
    interruptButton.setAttribute('aria-label', 'Interrumpir al asistente ahora');
    interruptButton.disabled = true;
    interruptButton.addEventListener('click', (): void => {
      this.handlers.onInterruptRequested();
    });
    actions.appendChild(interruptButton);
    const finishButton = createWidgetElement('button', 'oa-btn oa-btn--secondary', 'Finalizar');
    finishButton.type = 'button';
    finishButton.setAttribute('aria-label', 'Finalizar la sesión de voz');
    finishButton.addEventListener('click', (): void => {
      this.handlers.onStopRequested();
    });
    actions.appendChild(finishButton);
    panel.appendChild(actions);
    this.consentBlock = consentBlock;
    this.consentCheckbox = consentCheckbox;
    this.startButton = startButton;
    this.interruptButton = interruptButton;
    this.finishButton = finishButton;
    this.pills = pills;
    return panel;
  }

  /** Sincroniza píldoras, botón de interrupción y estado visual de la burbuja. */
  private applyStatus(): void {
    const pills = this.pills;
    if (pills === null) {
      return;
    }
    for (const status of WIDGET_STATUS_ORDER) {
      const pill = pills[status];
      pill.classList.toggle('is-active', status === this.status);
    }
    if (this.interruptButton !== null) {
      this.interruptButton.disabled = this.status !== 'speaking';
    }
    if (this.bubble !== null) {
      const isLive = this.status === 'listening' || this.status === 'speaking';
      this.bubble.classList.toggle('is-live', isLive);
    }
  }

  /** Abre el panel gestionando el foco hacia el primer control relevante. */
  private openPanel(): void {
    this.panelOpen = true;
    if (this.panel !== null) {
      this.panel.hidden = false;
    }
    const focusTarget = this.consentBlock !== null && !this.consentBlock.hidden ? this.consentCheckbox : this.finishButton;
    if (focusTarget !== null) {
      focusTarget.focus();
    }
  }

  /** Cierra el panel y devuelve el foco a la burbuja. */
  private closePanel(): void {
    this.panelOpen = false;
    if (this.panel !== null) {
      this.panel.hidden = true;
    }
    if (this.bubble !== null) {
      this.bubble.focus();
    }
  }

  /** Elementos enfocables visibles dentro del shadow (para la trampa de tabulación). */
  private collectFocusableElements(): readonly HTMLElement[] {
    if (this.shadow === null) {
      return [];
    }
    const candidates = Array.from(this.shadow.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])'));
    return candidates.filter((element) => element.closest('[hidden]') === null);
  }

  /** Maneja Escape y la rotación de foco dentro del panel abierto. */
  private readonly handleHostKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.panelOpen) {
      this.closePanel();
      return;
    }
    if (event.key !== 'Tab' || !this.panelOpen || this.shadow === null) {
      return;
    }
    const focusable = this.collectFocusableElements();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = this.shadow.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  /** Confirma el consentimiento, colapsa el banner y solicita el arranque. */
  private readonly handleStartRequested = (): void => {
    if (this.consentCheckbox === null || !this.consentCheckbox.checked) {
      return;
    }
    if (this.consentBlock !== null) {
      this.consentBlock.hidden = true;
    }
    this.handlers.onStartRequested();
    if (this.finishButton !== null) {
      this.finishButton.focus();
    }
  };
}
