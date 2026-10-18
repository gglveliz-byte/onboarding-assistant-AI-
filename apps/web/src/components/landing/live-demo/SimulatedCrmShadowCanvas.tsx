/**
 * @archivo apps/web/src/components/landing/live-demo/SimulatedCrmShadowCanvas.tsx
 * @modulo apps/web/src/components/landing/live-demo (demostración de voz pública de la landing)
 * @proposito
 *   Mini CRM ficticio "Nexo CRM" en Shadow DOM (modo abierto) que el asistente de voz opera de
 *   forma física: cascada defensiva de resolución del objetivo, caja de inspección previa,
 *   secuencia real de eventos de puntero y clic, escritura nativa de texto y anclaje de
 *   coordenadas normalizadas para el puntero bioluminiscente de la orquestación (Subagente 3).
 *   Estilizado con tokens Light Premium (#F2FAF8, #EAF7F4, #C5E8E1, #43E7DB, #8052FF) y anclas
 *   congeladas (btn-new-deal, input-company-tax, btn-validate-cfdi, nav-billing).
 *
 * @resumen_contenido
 *   - Contrato `CrmShadowCanvasHandle`: prepareDirective / commitDirective / resetCanvas /
 *     resolveAnchorViewportCenter; el shadowRoot vive en un ref para el handle.
 *   - Estilos propios inyectados como <style> dentro del shadow (aislamiento estricto, no hereda Tailwind):
 *     barra superior #EAF7F4, inputs #FFFFFF borde #C5E8E1, botones con acento #43E7DB/#8052FF,
 *     tabla con filas alternadas #FFFFFF / #F2FAF8.
 *   - Cascada defensiva: (a) `data-oa-id` canónico y tolerancia `demo-`, (b) claves extraídas de
 *     `primarySelector`/`selectorCascade`, (c) selectores directos, (d) fallback controlado.
 *   - Responsive móvil preservado: navegación horizontal < 640px y scroll táctil en `.nexo-main`.
 *
 * @dependencias_internas
 *   - `./usePublicVoiceDemoSession` (tipo `VoiceToolDirective`).
 *
 * @dependencias_externas
 *   - `react` (hooks y tipos); listener delegado único para clics reales y despachados.
 */

'use client';

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { VoiceToolDirective } from './usePublicVoiceDemoSession';

/** Contrato congelado del escenario CRM simulado que consume la orquestación del demo. */
export interface CrmShadowCanvasHandle {
  prepareDirective(directive: VoiceToolDirective): void;
  commitDirective(directive: VoiceToolDirective): { readonly success: boolean; readonly detail: string | null };
  resetCanvas(): void;
  resolveAnchorViewportCenter(anchorKey: string): { readonly xNorm: number; readonly yNorm: number } | null;
}
/** Propiedades del lienzo del CRM simulado. */
export interface SimulatedCrmShadowCanvasProps {
  readonly onCanvasReady?: (handle: CrmShadowCanvasHandle) => void;
  readonly className?: string;
}

/** Resultado de una acción física ejecutada sobre el CRM simulado. */
type PhysicalOutcome = { readonly success: boolean; readonly detail: string | null };
/** Claves físicas canónicas con efecto propio y soporte de anclas data-oa-id. */
const CLAVES = {
  NUEVO_TRATO: 'btn-new-deal',
  GUARDAR_TRATO: 'btn-save-deal',
  FACTURACION: 'nav-billing',
  VALIDAR_CFDI: 'btn-validate-cfdi',
  RFC_EMPRESA: 'input-company-tax',
} as const;
const MENSAJE_NO_LOCALIZADO = 'Elemento no localizado en el CRM simulado.';
const PATRON_DATA_OA_ID = /data-oa-id\s*=\s*["']([^"']+)["']/;
/** Filas de tratos de ejemplo (ficticias) y etapas del selector de etapa. */
const FILAS_TRATO_INICIALES: ReadonlyArray<readonly [string, string, string]> = [['Renovación ACME S.A.', 'Cierre', 'Ayer'], ['Portal de clientes', 'Propuesta', 'Hace 2 días']];
const ETAPAS_TRATO = ['Prospección', 'Propuesta', 'Cierre'] as const;
/** Hoja de estilos completa del shadow root: tokens Light Premium oficiales (#F2FAF8, #EAF7F4, #C5E8E1, #43E7DB, #8052FF). */
const ESTILOS_NEXO_CRM = `
:host { display: block; height: 100%; font-family: 'Matter', 'Inter', 'DM Sans', ui-sans-serif, system-ui, sans-serif; color: #062D2A; }
* { box-sizing: border-box; margin: 0; }
.nexo-root { position: relative; display: flex; flex-direction: column; min-height: 100%; background: #F2FAF8; border-radius: 16px; overflow: hidden; }
.nexo-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 12px; font-size: 11px; background: #EAF7F4; border-bottom: 1px solid #C5E8E1; }
.nexo-brand { font-size: 11px; font-weight: 500; letter-spacing: -0.01em; color: #062D2A; }
.nexo-status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #245954; background: #DDF3EE; border: 1px solid #C5E8E1; border-radius: 6px; }
.nexo-body { display: grid; grid-template-columns: 130px 1fr; flex: 1; min-height: 0; }
.nexo-sidebar { display: flex; flex-direction: column; gap: 4px; padding: 10px 8px; background: #EAF7F4; border-right: 1px solid #C5E8E1; }
.nexo-nav-item { padding: 5px 8px; font-size: 11px; color: #245954; border: 1px solid transparent; border-radius: 6px; cursor: pointer; transition: background-color 120ms ease; }
.nexo-nav-item--activo { color: #062D2A; background: #FFFFFF; border-color: #C5E8E1; font-weight: 500; }
.nexo-main { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; min-width: 0; overflow-y: auto; max-height: calc(100% - 36px); -webkit-overflow-scrolling: touch; }
.nexo-panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: #FFFFFF; border: 1px solid #C5E8E1; border-radius: 12px; }
.nexo-panel-title { font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: #245954; }
.nexo-input, .nexo-select { min-height: 30px; padding: 6px 10px; font: inherit; font-size: 11px; color: #062D2A; background: #FFFFFF; border: 1px solid #C5E8E1; border-radius: 6px; }
.nexo-input::placeholder { color: #769792; }
.nexo-input:focus, .nexo-select:focus { outline: none; border-color: #43E7DB; }
.nexo-btn { align-self: flex-start; min-height: 30px; padding: 6px 10px; font: inherit; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #062D2A; background: #EAF7F4; border: 1px solid #C5E8E1; border-radius: 6px; cursor: pointer; transition: background-color 140ms ease; }
.nexo-btn:hover { background: #DDF3EE; }
.nexo-btn--primario { color: #062D2A; background: linear-gradient(135deg, rgba(67, 231, 219, 0.22) 0%, rgba(128, 82, 255, 0.22) 100%), #FFFFFF; border: 1px solid #43E7DB; font-weight: 500; }
.nexo-btn--primario:hover { background: linear-gradient(135deg, rgba(67, 231, 219, 0.32) 0%, rgba(128, 82, 255, 0.32) 100%), #FFFFFF; }
.nexo-chip-slot { display: flex; gap: 6px; min-height: 20px; align-items: center; }
.nexo-chip { display: inline-flex; align-items: center; padding: 2px 6px; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #581585; background: #F9E8FF; border: 1px solid #E7CDF6; border-radius: 6px; }
.nexo-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.nexo-table th { padding: 5px 8px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; text-align: left; color: #547B76; border-bottom: 1px solid #C5E8E1; background: #EAF7F4; }
.nexo-table tr:nth-child(odd) td { background: #FFFFFF; }
.nexo-table tr:nth-child(even) td { background: #F2FAF8; }
.nexo-table td { padding: 5px 8px; color: #245954; border-bottom: 1px solid #D7EBE6; }
.nexo-inspected { outline: 2px solid #43E7DB; outline-offset: 2px; }
.nexo-inspection-label { position: absolute; z-index: 6; padding: 2px 7px; font-size: 10px; letter-spacing: 0.08em; white-space: nowrap; color: #F2FAF8; background: #062D2A; border-radius: 6px; pointer-events: none; }
@media (max-width: 640px) {
  .nexo-body { display: flex; flex-direction: column; }
  .nexo-sidebar { flex-direction: row; overflow-x: auto; border-bottom: 1px solid #C5E8E1; border-right: none; padding: 6px 8px; gap: 4px; }
  .nexo-nav-item { white-space: nowrap; flex-shrink: 0; padding: 4px 6px; font-size: 10px; }
  .nexo-main { padding: 6px 8px; gap: 6px; overflow-y: auto; max-height: calc(100% - 36px); -webkit-overflow-scrolling: touch; }
  .nexo-panel { padding: 8px; gap: 6px; border-radius: 10px; }
  .nexo-topbar { padding: 6px 10px; font-size: 11px; }
}
`;
/** Nodos internos del mini SaaS que necesitan los efectos físicos. */
interface NexoDomRefs {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  readonly inputTax: HTMLInputElement;
  readonly select: HTMLSelectElement;
  readonly tbody: HTMLTableSectionElement;
  readonly chipSlot: HTMLElement;
  readonly navItems: readonly HTMLElement[];
}
/** Crea un nodo con clase, texto y clave `data-oa-id` opcionales. */
function crearTag<K extends keyof HTMLElementTagNameMap>(tag: K, clase: string, texto?: string, oaId?: string): HTMLElementTagNameMap[K] {
  const nodo = document.createElement(tag);
  if (clase.length > 0) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  if (oaId !== undefined) nodo.setAttribute('data-oa-id', oaId);
  return nodo;
}

/** Construye una fila de la tablita de tratos. */
function crearFilaTrato(nombre: string, etapa: string, actividad: string): HTMLTableRowElement {
  const fila = document.createElement('tr');
  for (const texto of [nombre, etapa, actividad]) fila.append(Object.assign(document.createElement('td'), { textContent: texto }));
  return fila;
}

/** Construye TODO el esqueleto del mini CRM con DOM imperativo (sin Tailwind). */
function construirEstructuraCrm(): NexoDomRefs {
  const root = crearTag('div', 'nexo-root');
  const topbar = crearTag('header', 'nexo-topbar');
  topbar.append(crearTag('span', 'nexo-brand', 'Nexo CRM'), crearTag('span', 'nexo-status-pill', 'Sesión guiada'));

  const navItems = [
    crearTag('span', 'nexo-nav-item', 'Panel', 'nav-panel'),
    crearTag('span', 'nexo-nav-item', 'Tratos', 'nav-deals'),
    crearTag('span', 'nexo-nav-item nexo-nav-item--activo', 'Facturación', CLAVES.FACTURACION),
    crearTag('span', 'nexo-nav-item', 'Reportes', 'nav-reports'),
  ];
  const sidebar = crearTag('nav', 'nexo-sidebar');
  sidebar.append(...navItems);

  const input = crearTag('input', 'nexo-input', undefined, 'demo-input-deal-name');
  input.placeholder = 'Nombre del trato';
  const select = crearTag('select', 'nexo-select', undefined, 'demo-select-stage');
  for (const etapa of ETAPAS_TRATO) select.append(new Option(etapa, etapa));
  const botonNuevo = crearTag('button', 'nexo-btn nexo-btn--primario', 'Nuevo trato', CLAVES.NUEVO_TRATO);
  const botonGuardar = crearTag('button', 'nexo-btn', 'Guardar trato', CLAVES.GUARDAR_TRATO);
  const botonCfdi = crearTag('button', 'nexo-btn', 'Validar CFDI', CLAVES.VALIDAR_CFDI);
  for (const boton of [botonNuevo, botonGuardar, botonCfdi]) boton.type = 'button';
  const formPanel = crearTag('section', 'nexo-panel');
  formPanel.append(crearTag('p', 'nexo-panel-title', 'Trato nuevo'), input, select, botonNuevo, botonGuardar);

  const inputTax = crearTag('input', 'nexo-input', undefined, CLAVES.RFC_EMPRESA);
  inputTax.placeholder = 'RFC de la empresa';
  const chipSlot = crearTag('div', 'nexo-chip-slot');
  const billingPanel = crearTag('section', 'nexo-panel');
  billingPanel.append(crearTag('p', 'nexo-panel-title', 'Facturación'), inputTax, botonCfdi, chipSlot);

  const encabezado = crearTag('tr', '');
  for (const columna of ['Trato', 'Etapa', 'Actividad']) encabezado.append(crearTag('th', '', columna));
  const thead = crearTag('thead', '');
  thead.append(encabezado);
  const tbody = crearTag('tbody', '');
  tbody.append(...FILAS_TRATO_INICIALES.map(([nombre, etapa, actividad]) => crearFilaTrato(nombre, etapa, actividad)));
  const tabla = crearTag('table', 'nexo-table');
  tabla.append(thead, tbody);
  const tablaPanel = crearTag('section', 'nexo-panel');
  tablaPanel.append(crearTag('p', 'nexo-panel-title', 'Últimos tratos'), tabla);

  const main = crearTag('main', 'nexo-main');
  main.append(formPanel, billingPanel, tablaPanel);
  const body = crearTag('div', 'nexo-body');
  body.append(sidebar, main);
  root.append(topbar, body);
  return { root, input, inputTax, select, tbody, chipSlot, navItems };
}

/** Consulta un nodo por su clave `data-oa-id` escapada. */
function consultarPorClave(shadow: ShadowRoot, clave: string): HTMLElement | null {
  return shadow.querySelector<HTMLElement>(`[data-oa-id="${CSS.escape(clave)}"]`);
}

/** Resuelve un nodo con la cascada defensiva completa dentro del shadow root. */
function resolverNodo(shadow: ShadowRoot, claves: readonly string[], selectores: readonly string[]): HTMLElement | null {
  for (const clave of claves) {
    const limpia = clave.replace(/^demo-/, '');
    const candidatos = [clave, limpia, `demo-${limpia}`];
    for (const candidato of candidatos) {
      const directo = consultarPorClave(shadow, candidato);
      if (directo !== null) return directo;
    }
  }
  const clavesCascada = new Set<string>();
  for (const selector of selectores) {
    const capturada = PATRON_DATA_OA_ID.exec(selector)?.[1];
    if (capturada !== undefined && capturada.length > 0) {
      const limpia = capturada.replace(/^demo-/, '');
      clavesCascada.add(capturada);
      clavesCascada.add(limpia);
      clavesCascada.add(`demo-${limpia}`);
    }
  }
  for (const clave of clavesCascada) {
    const nodo = consultarPorClave(shadow, clave);
    if (nodo !== null) return nodo;
  }
  for (const selector of selectores) {
    try {
      const nodo = shadow.querySelector<HTMLElement>(selector);
      if (nodo !== null) return nodo;
    } catch {
      /* Selector no válido dentro del shadow root: se continúa con el siguiente. */
    }
  }
  return null;
}

/** Dispara la secuencia física real de eventos: punteros del navegador y clic final. */
function despacharSecuenciaFisica(elemento: HTMLElement): void {
  const opciones: EventInit = { bubbles: true, cancelable: true, composed: true };
  const secuencia: ReadonlyArray<readonly [string, boolean]> = [['pointerover', true], ['pointerenter', true], ['pointerdown', true], ['mousedown', false], ['pointerup', true], ['mouseup', false], ['click', false]];
  for (const [tipo, esPuntero] of secuencia) elemento.dispatchEvent(esPuntero ? new PointerEvent(tipo, opciones) : new MouseEvent(tipo, opciones));
}

/** Escribe texto en un input usando el setter nativo + eventos `input` y `change`. */
function escribirTextoNativo(elemento: HTMLInputElement, texto: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (descriptor?.set !== undefined) descriptor.set.call(elemento, texto);
  else elemento.value = texto;
  elemento.dispatchEvent(new Event('input', { bubbles: true }));
  elemento.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Lienzo del CRM simulado confinado en un Shadow DOM con estilos propios. */
export function SimulatedCrmShadowCanvas(props: SimulatedCrmShadowCanvasProps): ReactElement {
  const { onCanvasReady, className } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadowRootRef.current = shadow;
    shadow.replaceChildren(Object.assign(document.createElement('style'), { textContent: ESTILOS_NEXO_CRM }));
    const refs = construirEstructuraCrm();
    shadow.append(refs.root);

    let ultimoResultado: PhysicalOutcome | null = null;
    let elementoInspeccionado: HTMLElement | null = null;
    let etiquetaInspeccion: HTMLElement | null = null;
    const disposers: Array<() => void> = [];

    /** Retira la caja de inspección y la micro-etiqueta vigentes. */
    const limpiarInspeccion = (): void => {
      for (const atributo of ['data-oa-inspected', 'aria-description']) elementoInspeccionado?.removeAttribute(atributo);
      elementoInspeccionado?.classList.remove('nexo-inspected');
      elementoInspeccionado = null;
      etiquetaInspeccion?.remove();
      etiquetaInspeccion = null;
    };

    /** Activa la sección "Facturación" y apaga el resto del menú lateral. */
    const activarFacturacion = (): void => {
      for (const item of refs.navItems) {
        const itemClave = item.getAttribute('data-oa-id')?.replace(/^demo-/, '') ?? '';
        item.classList.toggle('nexo-nav-item--activo', itemClave === 'nav-billing');
      }
    };

    /** Restaura la tablita de tratos con las filas de ejemplo. */
    const restaurarFilasIniciales = (): void => {
      refs.tbody.replaceChildren(...FILAS_TRATO_INICIALES.map(([nombre, etapa, actividad]) => crearFilaTrato(nombre, etapa, actividad)));
    };

    /** Aplica el efecto físico de una clave conocida; si no lo es, responde el detalle genérico. */
    const aplicarEfectoFisico = (clave: string, detalleGenerico: string): PhysicalOutcome => {
      const claveNorm = clave.replace(/^demo-/, '');
      switch (claveNorm) {
        case 'btn-new-deal':
          refs.input.value = '';
          refs.select.selectedIndex = 0;
          return { success: true, detail: 'Formulario de trato abierto y limpio para capturar.' };
        case 'btn-save-deal': {
          const nombre = refs.input.value.trim().length === 0 ? 'Trato sin nombre' : refs.input.value.trim();
          const etapa = refs.select.value.length === 0 ? 'Prospección' : refs.select.value;
          while (refs.tbody.children.length >= 6) refs.tbody.firstElementChild?.remove();
          refs.tbody.append(crearFilaTrato(nombre, etapa, 'Ahora'));
          refs.input.value = '';
          return { success: true, detail: `Trato "${nombre}" (${etapa}) registrado en la tabla.` };
        }
        case 'nav-billing':
          activarFacturacion();
          return { success: true, detail: 'Sección "Facturación" activada en el menú lateral.' };
        case 'btn-validate-cfdi':
          if (refs.chipSlot.querySelector('.nexo-chip') === null) refs.chipSlot.append(crearTag('span', 'nexo-chip', 'CFDI validado'));
          return { success: true, detail: 'Comprobante de factura validado (efecto ficticio de la demostración).' };
        case 'input-company-tax':
          refs.inputTax.focus();
          return { success: true, detail: 'Campo de identificación fiscal enfocado para captura.' };
        default:
          return { success: true, detail: detalleGenerico };
      }
    };

    /** Listener delegado único: clics reales y despachados comparten la misma ruta física. */
    const manejarClicDelegado = (event: Event): void => {
      if (!(event.target instanceof HTMLElement)) return;
      const clave = event.target.closest<HTMLElement>('[data-oa-id]')?.getAttribute('data-oa-id') ?? null;
      if (clave === null) return;
      ultimoResultado = aplicarEfectoFisico(clave, `Acción física ejecutada sobre ${clave}.`);
    };
    refs.root.addEventListener('click', manejarClicDelegado);
    disposers.push(() => refs.root.removeEventListener('click', manejarClicDelegado));

    /** Resuelve el nodo objetivo de una directiva con la cascada defensiva completa. */
    const resolverNodoDirigido = (directive: VoiceToolDirective): HTMLElement | null =>
      resolverNodo(shadow, [directive.targetElementKey], [directive.primarySelector, ...directive.selectorCascade]);

    const handle: CrmShadowCanvasHandle = {
      prepareDirective: (directive): void => {
        limpiarInspeccion();
        const objetivo = resolverNodoDirigido(directive);
        if (objetivo === null) return;
        elementoInspeccionado = objetivo;
        objetivo.classList.add('nexo-inspected');
        objetivo.setAttribute('data-oa-inspected', 'true');
        objetivo.setAttribute('aria-description', `Objetivo de la directiva: ${directive.targetElementKey}`);
        const etiqueta = crearTag('span', 'nexo-inspection-label', directive.targetElementKey);
        etiqueta.style.left = `${Math.max(0, objetivo.offsetLeft)}px`;
        etiqueta.style.top = `${Math.max(0, objetivo.offsetTop - 14)}px`;
        refs.root.append(etiqueta);
        etiquetaInspeccion = etiqueta;
      },
      commitDirective: (directive): PhysicalOutcome => {
        const objetivo = resolverNodoDirigido(directive);
        if (objetivo === null) return { success: false, detail: MENSAJE_NO_LOCALIZADO };
        if (directive.toolName === 'type_text') {
          if (!(objetivo instanceof HTMLInputElement)) return { success: false, detail: 'El elemento objetivo no admite escritura de texto.' };
          const texto = directive.textPayload ?? '';
          escribirTextoNativo(objetivo, texto);
          return { success: true, detail: `Texto capturado en el trato: "${texto}".` };
        }
        const clave = objetivo.getAttribute('data-oa-id') ?? directive.targetElementKey;
        const detalleGenerico = directive.toolName === 'advance_onboarding_step' ? 'Paso de onboarding avanzado en el CRM simulado.' : `Acción física ejecutada sobre ${clave}.`;
        ultimoResultado = null;
        despacharSecuenciaFisica(objetivo);
        return ultimoResultado === null ? { success: true, detail: detalleGenerico } : ultimoResultado;
      },
      resetCanvas: (): void => {
        limpiarInspeccion();
        refs.input.value = '';
        refs.inputTax.value = '';
        refs.select.selectedIndex = 0;
        restaurarFilasIniciales();
        activarFacturacion();
        refs.chipSlot.replaceChildren();
      },
      resolveAnchorViewportCenter: (anchorKey): { readonly xNorm: number; readonly yNorm: number } | null => {
        const host = hostRef.current;
        const shadowActual = shadowRootRef.current;
        if (host === null || shadowActual === null) return null;
        const nodo = resolverNodo(shadowActual, [anchorKey], []);
        if (nodo === null) return null;
        const hostRect = host.getBoundingClientRect();
        const rect = nodo.getBoundingClientRect();
        const hostWidth = Math.max(1, hostRect.width);
        const hostHeight = Math.max(1, hostRect.height);
        const relX = rect.left + rect.width / 2 - hostRect.left;
        const relY = rect.top + rect.height / 2 - hostRect.top;
        return {
          xNorm: Math.min(1, Math.max(0, relX / hostWidth)),
          yNorm: Math.min(1, Math.max(0, relY / hostHeight)),
        };
      },
    };

    onCanvasReady?.(handle);

    return () => {
      for (const dispose of disposers) dispose();
      limpiarInspeccion();
      shadowRootRef.current = null;
    };
  }, []);

  return <div ref={hostRef} className={['relative', className].filter((fragmento) => fragmento !== undefined && fragmento.length > 0).join(' ')} aria-label="CRM simulado para la demostración en vivo" />;
}
