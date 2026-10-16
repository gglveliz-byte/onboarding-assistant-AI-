/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-scripts.ts
 * @modulo 03-visual-trainer-and-rag (Scripts Instrumentados para el Navegador de Entrenamiento)
 * @proposito
 *   Contiene el codigo JavaScript que se inyecta en el Chromium efimero mediante
 *   `Page.addScriptToEvaluateOnNewDocument` y `Runtime.evaluate`. Este codigo se ejecuta DENTRO
 *   del navegador, por lo que no puede importar modulos de Node ni usar el sistema de modulos:
 *   se entrega como cadenas autocontenidas. Su responsabilidad es triple: dibujar la capa
 *   interactiva (Overlay) para que el desarrollador senale elementos sobre la pagina real sin
 *   capturas ciegas, aplicar el filtro de privacidad que jamas expone campos sensibles, y calcular
 *   la cascada de selectores estables junto con las cajas geometricas en los tres viewports.
 *
 * @resumen_contenido
 *   - Constante `SENSITIVE_FIELD_MARKERS`: Marcadores canonicos de campo sensible (espejo del SDK).
 *   - Constante `OVERLAY_INSTALL_SCRIPT`: Instalador con el filtro de privacidad y la cascada de selectores.
 *   - Constante `OVERLAY_RUNTIME_SCRIPT`: API de ejecucion (activar, resaltar, capturar metadatos).
 *   - Constante `VIEWPORT_PRESETS`: Los tres viewports oficiales del entrenamiento.
 *   - Funcion `buildOverlayInstallScript()`: Ensambla el instalador con la configuracion de sesion.
 *
 * @dependencias_internas
 *   - Ninguna (Cadenas autocontenidas: el navegador remoto no comparte el runtime de Node).
 *
 * @dependencias_externas
 *   - Ninguna (JavaScript puro ejecutado dentro del navegador).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements` (Los datos calculados alimentan `primary_selector`, `*_bbox_json`).
 *   - PostgreSQL: `training_browser_sessions` (El overlay solo se activa en modo captura).
 */

/** Marcadores canonicos que identifican un campo sensible (espejo exacto del SDK Web). */
export const SENSITIVE_FIELD_MARKERS: readonly string[] = Object.freeze([
  'input[type="password"]',
  'input[autocomplete^="cc-"]',
  'input[name*="card" i]',
  'input[id*="cvv" i]',
  'input[name*="cvc" i]',
  'input[data-oa-sensitive="true"]',
  '[data-oa-sensitive="true"]',
]);

/** Viewports oficiales del entrenamiento visual, con su nombre canonico en la base de datos. */
export const VIEWPORT_PRESETS: readonly { readonly name: 'desktop' | 'tablet' | 'mobile'; readonly width: number; readonly height: number }[] =
  Object.freeze([
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ]);

/**
 * Cuerpo del instalador: se serializa a texto y se inyecta en cada documento nuevo.
 * Define `window.__OA_TRAINER__` con el filtro de privacidad, la cascada de selectores y el overlay.
 */
const OVERLAY_INSTALL_BODY = `
(function installOnboardingAssistantOverlay() {
  if (window.__OA_TRAINER_INSTALLED__) { return; }
  window.__OA_TRAINER_INSTALLED__ = true;

  var SENSITIVE_SELECTORS = __SENSITIVE_SELECTORS__;
  var OVERLAY_ROOT_ID = '__oa-trainer-overlay-root';

  /** Determina si un nodo es un campo sensible que jamas debe exponerse ni etiquetarse. */
  function isSensitiveElement(element) {
    if (!element || element.nodeType !== 1) { return true; }
    for (var index = 0; index < SENSITIVE_SELECTORS.length; index += 1) {
      try {
        if (element.matches(SENSITIVE_SELECTORS[index])) { return true; }
      } catch (error) { /* Selector no soportado por este motor: se ignora. */ }
    }
    if (element.closest && element.closest('[data-oa-sensitive="true"]')) { return true; }
    var tagName = element.tagName ? element.tagName.toLowerCase() : '';
    return tagName === 'script' || tagName === 'style' || tagName === 'meta' || tagName === 'link';
  }

  /** Indica si un elemento es visible y ocupa area suficiente para ser etiquetado. */
  function isVisibleElement(element) {
    var rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) { return false; }
    var styles = window.getComputedStyle(element);
    return styles.visibility !== 'hidden' && styles.display !== 'none' && Number(styles.opacity) > 0.05;
  }

  /** Calcula el selector estable principal: atributo propio, identidad o ruta estructural. */
  function computePrimarySelector(element) {
    var explicitId = element.getAttribute('data-oa-id');
    if (explicitId) { return '[data-oa-id="' + explicitId + '"]'; }
    if (element.id && !/^[0-9]/.test(element.id) && !/:/.test(element.id)) { return '#' + element.id; }
    var testId = element.getAttribute('data-testid');
    if (testId) { return '[data-testid="' + testId + '"]'; }
    return computeStructuralSelector(element);
  }

  /** Construye una ruta CSS basada en etiqueta y posicion, evitando hashes dinamicos. */
  function computeStructuralSelector(element) {
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 5) {
      var tag = current.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') { parts.unshift(tag); break; }
      var parent = current.parentElement;
      var sameTagSiblings = parent ? Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === current.tagName;
      }) : [];
      if (sameTagSiblings.length > 1) {
        tag += ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(tag);
      current = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  /** Calcula el selector por accesibilidad (rol ARIA y nombre accesible) si esta disponible. */
  function computeAccessibilitySelector(element) {
    var role = element.getAttribute('role');
    if (!role) {
      var tag = element.tagName ? element.tagName.toLowerCase() : '';
      if (tag === 'button') { role = 'button'; }
      else if (tag === 'a') { role = 'link'; }
      else if (tag === 'input') { role = element.type === 'submit' ? 'button' : 'textbox'; }
      else if (tag === 'select') { role = 'combobox'; }
    }
    if (!role) { return null; }
    var accessibleName = element.getAttribute('aria-label') || element.textContent ? (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60) : '';
    return accessibleName.length > 0 ? role + '[name="' + accessibleName + '"]' : role;
  }

  /** Calcula un XPath de respaldo con indice posicional, estable frente a cambios de estilo. */
  function computeXPathFallback(element) {
    var segments = [];
    var current = element;
    while (current && current.nodeType === 1) {
      var tag = current.tagName.toLowerCase();
      if (tag === 'html') { segments.unshift('html'); break; }
      var parent = current.parentElement;
      var position = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === current.tagName; });
        position = siblings.indexOf(current) + 1;
      }
      segments.unshift(tag + '[' + position + ']');
      current = parent;
    }
    return '/' + segments.join('/');
  }

  /**
   * Puntua la estabilidad del selector de 0 a 100 penalizando identificadores volatiles.
   * Se consideran volatiles los identificadores que contienen numeros largos, hashes o marcas de
   * framework (clases generadas por CSS-in-JS), porque cambian entre compilaciones.
   */
  function computeStabilityScore(element, primarySelector) {
    var score = 60;
    if (element.getAttribute('data-oa-id')) { score = 100; }
    else if (element.getAttribute('data-testid')) { score = 92; }
    else if (element.id && /^[a-zA-Z][\\w-]*$/.test(element.id)) { score = 85; }
    else if (/nth-of-type/.test(primarySelector)) { score = 55; }

    var volatilePattern = /(?:[0-9a-f]{6,}|css-[a-z0-9]{4,}|sc-[a-zA-Z0-9]{4,}|jsx-[0-9]+)/;
    var classAttribute = element.getAttribute('class') || '';
    if (volatilePattern.test(classAttribute)) { score -= 20; }
    if (volatilePattern.test(element.id || '')) { score -= 25; }
    if (/nth-of-type\\(\\d{2,}\\)/.test(primarySelector)) { score -= 10; }

    return Math.max(0, Math.min(100, score));
  }

  /** Determina la accion fisica probable segun la semantica del elemento. */
  function inferActionType(element) {
    var tag = element.tagName ? element.tagName.toLowerCase() : '';
    var isTextEntry = tag === 'input' && ['text', 'email', 'tel', 'number', 'search', 'url'].indexOf(element.type) >= 0;
    var isTextArea = tag === 'textarea';
    var isEditable = element.isContentEditable === true;
    if (isTextEntry || isTextArea || isEditable) { return 'TYPE'; }
    if (tag === 'button' || tag === 'a' || tag === 'select' || element.getAttribute('role') === 'button') { return 'CLICK'; }
    if (element.onclick || element.getAttribute('onclick')) { return 'CLICK'; }
    return 'NONE';
  }

  /** Extrae la descripcion funcional legible del elemento, con respaldo por etiqueta asociada. */
  function extractFunctionalDescription(element) {
    var ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) { return ariaLabel.trim().slice(0, 200); }
    var placeholder = element.getAttribute('placeholder');
    if (placeholder) { return placeholder.trim().slice(0, 200); }
    var title = element.getAttribute('title');
    if (title) { return title.trim().slice(0, 200); }
    if (element.id) {
      var label = document.querySelector('label[for="' + element.id.replace(/"/g, '\\\\"') + '"]');
      if (label && label.textContent) { return label.textContent.trim().slice(0, 200); }
    }
    var text = (element.textContent || '').trim().replace(/\\s+/g, ' ');
    return text.slice(0, 200);
  }

  /** Normaliza una caja geometrica a coordenadas relativas al viewport actual. */
  function computeBoundingBox(element) {
    var rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  /** Extrae los metadatos completos de un elemento, sin exponer jamas datos sensibles. */
  function extractElementDescriptor(element, index) {
    if (isSensitiveElement(element) || !isVisibleElement(element)) { return null; }
    var primarySelector = computePrimarySelector(element);
    var tag = element.tagName ? element.tagName.toLowerCase() : 'desconocido';
    return {
      elementKey: 'el_' + index.toString(36) + '_' + tag,
      tagName: tag,
      primarySelector: primarySelector,
      accessibilitySelector: computeAccessibilitySelector(element),
      structuralCssSelector: computeStructuralSelector(element),
      xpathFallback: computeXPathFallback(element),
      selectorStabilityScore: computeStabilityScore(element, primarySelector),
      actionType: inferActionType(element),
      functionalDescription: extractFunctionalDescription(element),
      bbox: computeBoundingBox(element),
      elementMetadata: {
        role: element.getAttribute('role') || null,
        inputType: element.getAttribute('type') || null,
        isDisabled: Boolean(element.disabled),
        isRequired: Boolean(element.required),
      },
    };
  }

  /** Recorre el documento y devuelve los descriptores de todos los elementos etiquetables. */
  function collectLabelableElements(limit) {
    var candidates = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [contenteditable="true"], [data-oa-id]');
    var descriptors = [];
    for (var index = 0; index < candidates.length && descriptors.length < limit; index += 1) {
      var descriptor = extractElementDescriptor(candidates[index], descriptors.length);
      if (descriptor !== null) { descriptors.push(descriptor); }
    }
    return descriptors;
  }

  /** Crea la raiz del overlay si aun no existe, aislada del CSS del sitio anfitrion. */
  function ensureOverlayRoot() {
    var existing = document.getElementById(OVERLAY_ROOT_ID);
    if (existing) { return existing; }
    var root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    root.setAttribute('data-oa-sensitive', 'false');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:system-ui,sans-serif;';
    document.documentElement.appendChild(root);
    return root;
  }

  /** Dibuja los marcadores numerados del overlay sobre cada elemento etiquetable. */
  function renderOverlayMarkers(descriptors) {
    var root = ensureOverlayRoot();
    root.innerHTML = '';
    for (var index = 0; index < descriptors.length; index += 1) {
      var descriptor = descriptors[index];
      var marker = document.createElement('button');
      marker.type = 'button';
      marker.textContent = String(index + 1);
      marker.setAttribute('data-oa-marker', descriptor.elementKey);
      marker.style.cssText = 'position:absolute;pointer-events:auto;cursor:pointer;border:none;border-radius:9999px;' +
        'width:22px;height:22px;font-size:11px;font-weight:600;color:#f7f7f4;background:#f54e00;' +
        'left:' + descriptor.bbox.x + 'px;top:' + descriptor.bbox.y + 'px;transform:translate(-50%,-50%);' +
        'box-shadow:0 0 0 1px rgba(38,37,30,0.24);';
      root.appendChild(marker);
    }
    return descriptors.length;
  }

  /** Elimina todos los marcadores del overlay sin afectar al documento anfitrion. */
  function clearOverlayMarkers() {
    var root = document.getElementById(OVERLAY_ROOT_ID);
    if (root) { root.innerHTML = ''; }
  }

  /** Resalta temporalmente un elemento concreto para probar un selector en vivo. */
  function highlightSelector(selector) {
    var element = null;
    try { element = document.querySelector(selector); } catch (error) { return null; }
    if (!element || isSensitiveElement(element)) { return null; }
    var previousOutline = element.style.outline;
    element.style.outline = '3px solid #f54e00';
    window.setTimeout(function restoreOutline() { element.style.outline = previousOutline; }, 2000);
    return extractElementDescriptor(element, 0);
  }

  window.__OA_TRAINER__ = {
    version: '1.0.0',
    isSensitiveElement: isSensitiveElement,
    collectLabelableElements: collectLabelableElements,
    computeBoundingBox: computeBoundingBox,
    computePrimarySelector: computePrimarySelector,
    computeStabilityScore: computeStabilityScore,
    renderOverlayMarkers: renderOverlayMarkers,
    clearOverlayMarkers: clearOverlayMarkers,
    highlightSelector: highlightSelector,
    describeCurrentRoute: function describeCurrentRoute() {
      return { path: window.location.pathname, title: document.title, readyState: document.readyState };
    },
  };
})();
`;

/**
 * Ensambla el instalador del overlay con la lista de selectores sensibles ya serializada.
 *
 * @returns Codigo JavaScript autocontenido listo para `Page.addScriptToEvaluateOnNewDocument`.
 */
export function buildOverlayInstallScript(): string {
  return OVERLAY_INSTALL_BODY.replace('__SENSITIVE_SELECTORS__', JSON.stringify(SENSITIVE_FIELD_MARKERS)).trim();
}

/**
 * Script de ejecucion que recolecta los elementos etiquetables del documento actual.
 * Recibe el limite maximo de elementos como argumento de `Runtime.evaluate`.
 */
export const OVERLAY_RUNTIME_COLLECT_SCRIPT = `
(function collectForOnboardingAssistant(limit) {
  if (!window.__OA_TRAINER__) { return { ok: false, reason: 'OVERLAY_NO_INSTALADO', elements: [] }; }
  var elements = window.__OA_TRAINER__.collectLabelableElements(limit || 200);
  var route = window.__OA_TRAINER__.describeCurrentRoute();
  return { ok: true, route: route, elements: elements };
})
`;

/**
 * Script de ejecucion que activa el overlay y devuelve el resumen de lo dibujado.
 */
export const OVERLAY_RUNTIME_ACTIVATE_SCRIPT = `
(function activateOverlayForOnboardingAssistant(limit) {
  if (!window.__OA_TRAINER__) { return { ok: false, reason: 'OVERLAY_NO_INSTALADO', rendered: 0 }; }
  var elements = window.__OA_TRAINER__.collectLabelableElements(limit || 200);
  var rendered = window.__OA_TRAINER__.renderOverlayMarkers(elements);
  return { ok: true, rendered: rendered, elements: elements };
})
`;

/**
 * Script de ejecucion que apaga el overlay y limpia los marcadores.
 */
export const OVERLAY_RUNTIME_DEACTIVATE_SCRIPT = `
(function deactivateOverlayForOnboardingAssistant() {
  if (!window.__OA_TRAINER__) { return { ok: false, reason: 'OVERLAY_NO_INSTALADO' }; }
  window.__OA_TRAINER__.clearOverlayMarkers();
  return { ok: true };
})
`;

/**
 * Script de ejecucion que resalta un selector concreto para probarlo en vivo.
 * Recibe el selector como argumento de `Runtime.evaluate`.
 */
export const OVERLAY_RUNTIME_HIGHLIGHT_SCRIPT = `
(function highlightForOnboardingAssistant(selector) {
  if (!window.__OA_TRAINER__) { return { ok: false, reason: 'OVERLAY_NO_INSTALADO' }; }
  var descriptor = window.__OA_TRAINER__.highlightSelector(selector);
  if (!descriptor) { return { ok: false, reason: 'SELECTOR_NO_RESUELTO_O_SENSIBLE' }; }
  return { ok: true, descriptor: descriptor };
})
`;
