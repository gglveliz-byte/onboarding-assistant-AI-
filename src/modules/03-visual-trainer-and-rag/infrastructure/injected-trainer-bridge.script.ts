/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/injected-trainer-bridge.script.ts
 * @modulo 03-visual-trainer-and-rag (Script Puente Inyectado en la Web Proxificada)
 * @proposito
 *   Genera el código JavaScript que el proxy inverso inyecta al vuelo antes del cierre
 *   de `</body>` de cualquier página web inspeccionada. Neutraliza frame-busting,
 *   restringe la navegación interna para que no escape del visor, proyecta el recuadro
 *   de hover interactivo en modo captura y envía las coordenadas DOM exactas y selectores
 *   estables hacia la ventana del dashboard mediante `window.parent.postMessage`.
 *
 * @resumen_contenido
 *   - Funcion `buildInjectedTrainerBridgeScript(proxyEndpointBase: string)`:
 *     Construye la cadena autocontenida que se inyecta en el HTML devuelto por el proxy.
 *   - Lógica de neutralización de frame-busting (`window.top` protegido).
 *   - Conmutador de modo operativo (`NAVIGATION` vs `CAPTURE`) vía `postMessage`.
 *   - Interceptor de enlaces (`<a>`) para mantener la navegación dentro del proxy.
 *   - Algoritmo de extracción de selectores primarios (`data-oa-id`, `id`, `data-testid`, CSS).
 *   - Proyector visual de hover con borde naranja fuego (`#f54e00`).
 *
 * @dependencias_internas
 *   - Ninguna (Código JavaScript puro para ejecución en el navegador cliente).
 *
 * @tablas_bd_o_redis
 *   - Ninguna directa (los metadatos son capturados y guardados por el dashboard).
 */

/**
 * Genera el script autocontenido que se inyecta en cada página proxificada.
 *
 * @param proxyEndpointBase - Ruta base del proxy (ej: `/api/v1/projects/:id/trainer/proxy?url=`).
 * @param targetOrigin - Origen real de la web inspeccionada (ej: `https://mi-web.com`).
 * @returns Cadena JavaScript lista para embeber dentro de `<script>...</script>`.
 */
export function buildInjectedTrainerBridgeScript(proxyEndpointBase: string, targetOrigin: string = ''): string {
  const safeProxyBase = JSON.stringify(proxyEndpointBase);
  const safeTargetOrigin = JSON.stringify(targetOrigin);

  return `
(function initOnboardingAssistantBridge() {
  if (window.__OA_TRAINER_BRIDGE_INSTALLED__) { return; }
  window.__OA_TRAINER_BRIDGE_INSTALLED__ = true;

  var PROXY_BASE = ${safeProxyBase};
  var TARGET_ORIGIN = ${safeTargetOrigin};
  var currentMode = 'NAVIGATION';

  // 1. Blindaje Anti Frame-Busting: neutralizar intentos del sitio de secuestrar window.top
  try {
    if (window.top !== window.self) {
      Object.defineProperty(window, 'top', {
        get: function () { return window.self; },
        configurable: false,
      });
      Object.defineProperty(window, 'parent', {
        get: function () { return window.self; },
        configurable: false,
      });
    }
  } catch (err) {
    // Entorno protegido por política estricta
  }

  // 2. Elementos DOM del Recuadro de Inspección Vectorial
  var highlightBox = document.createElement('div');
  highlightBox.id = '__oa_trainer_highlight_box__';
  highlightBox.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'border: 2px solid #f54e00',
    'background: rgba(245, 78, 0, 0.12)',
    'box-shadow: 0 0 14px rgba(245, 78, 0, 0.4)',
    'z-index: 2147483647',
    'display: none',
    'transition: top 60ms ease-out, left 60ms ease-out, width 60ms ease-out, height 60ms ease-out',
    'box-sizing: border-box',
    'border-radius: 4px',
  ].join(';');

  var badgeTag = document.createElement('div');
  badgeTag.style.cssText = [
    'position: absolute',
    'top: -26px',
    'left: 0',
    'background: #26251e',
    'color: #f7f7f4',
    'font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    'font-size: 11px',
    'font-weight: 500',
    'padding: 2px 7px',
    'border-radius: 3px',
    'white-space: nowrap',
    'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35)',
    'display: flex',
    'align-items: center',
    'gap: 4px',
    'pointer-events: none',
  ].join(';');

  highlightBox.appendChild(badgeTag);

  function ensureHighlightMounted() {
    if (!document.body) { return; }
    if (!document.getElementById('__oa_trainer_highlight_box__')) {
      document.body.appendChild(highlightBox);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureHighlightMounted);
  } else {
    ensureHighlightMounted();
  }

  // 3. Algoritmo de cálculo de selectores estables
  function computePrimarySelector(element) {
    if (!element || element.nodeType !== 1) { return 'div'; }
    var explicitId = element.getAttribute('data-oa-id');
    if (explicitId) { return '[data-oa-id="' + explicitId + '"]'; }
    if (element.id && !/^[0-9]/.test(element.id) && !/:/.test(element.id) && !/[0-9a-f]{8,}/.test(element.id)) {
      return '#' + element.id;
    }
    var testId = element.getAttribute('data-testid');
    if (testId) { return '[data-testid="' + testId + '"]'; }
    return computeStructuralSelector(element);
  }

  function computeStructuralSelector(element) {
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 4) {
      var tag = current.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') { parts.unshift(tag); break; }
      if (current.id && !/^[0-9]/.test(current.id) && !/[0-9a-f]{8,}/.test(current.id)) {
        parts.unshift('#' + current.id);
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var sameTagSiblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName;
        });
        if (sameTagSiblings.length > 1) {
          var index = sameTagSiblings.indexOf(current) + 1;
          tag += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(tag);
      current = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function computeXPath(element) {
    var segments = [];
    var current = element;
    while (current && current.nodeType === 1) {
      var tag = current.tagName.toLowerCase();
      if (tag === 'html') { segments.unshift('html'); break; }
      var parent = current.parentElement;
      var position = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName;
        });
        position = siblings.indexOf(current) + 1;
      }
      segments.unshift(tag + '[' + position + ']');
      current = parent;
    }
    return '/' + segments.join('/');
  }

  function isSensitiveElement(element) {
    if (!element || element.nodeType !== 1) { return false; }
    var tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (element.type || '').toLowerCase();
      if (type === 'password') { return true; }
      var name = (element.name || '').toLowerCase();
      if (name.indexOf('card') >= 0 || name.indexOf('cvv') >= 0 || name.indexOf('cvc') >= 0) { return true; }
    }
    return element.getAttribute('data-oa-sensitive') === 'true';
  }

  function calculateStabilityScore(element, selector) {
    var score = 65;
    if (element.getAttribute('data-oa-id')) { return 100; }
    if (element.getAttribute('data-testid')) { return 95; }
    if (element.id && !/[0-9a-f]{6,}/.test(element.id)) { score = 88; }
    else if (/nth-of-type/.test(selector)) { score = 55; }
    return Math.max(20, Math.min(100, score));
  }

  function extractText(element) {
    if (!element) { return ''; }
    var aria = element.getAttribute('aria-label');
    if (aria) { return aria.trim().slice(0, 80); }
    var placeholder = element.getAttribute('placeholder');
    if (placeholder) { return placeholder.trim().slice(0, 80); }
    var text = (element.textContent || '').trim().replace(/\\s+/g, ' ');
    return text.slice(0, 80);
  }

  // 4. Conmutador de Modos vía Mensaje del Dashboard
  window.addEventListener('message', function (ev) {
    if (!ev || !ev.data) { return; }
    if (ev.data.type === 'OA_SET_MODE' && typeof ev.data.mode === 'string') {
      currentMode = ev.data.mode === 'ACTIVE_CAPTURE_OVERLAY_MODE' ? 'CAPTURE' : 'NAVIGATION';
      if (currentMode !== 'CAPTURE') {
        highlightBox.style.display = 'none';
      }
    }
  });

  // 5. Rastreo del cursor (Hover) en Modo Captura
  document.addEventListener('pointermove', function (e) {
    if (currentMode !== 'CAPTURE') { return; }
    ensureHighlightMounted();

    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === highlightBox || highlightBox.contains(target)) { return; }
    var tag = target.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      highlightBox.style.display = 'none';
      return;
    }

    var rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) { return; }

    highlightBox.style.top = rect.top + 'px';
    highlightBox.style.left = rect.left + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';
    highlightBox.style.display = 'block';

    var primary = computePrimarySelector(target);
    badgeTag.innerHTML = '<span>🎯</span><span>' + primary + '</span><span style="color:#52be7f;margin-left:4px">Clic para etiquetar</span>';
  }, { passive: true });

  // 6. Captura de Elementos al hacer Clic en Modo Captura
  document.addEventListener('click', function (e) {
    if (currentMode !== 'CAPTURE') {
      // En modo navegación: interceptar enlaces para que naveguen a través del proxy
      var anchor = e.target && e.target.closest ? e.target.closest('a') : null;
      if (anchor && anchor.href && !anchor.href.startsWith('javascript:') && !anchor.href.startsWith('#')) {
        e.preventDefault();
        e.stopPropagation();
        var targetDestination = anchor.href;
        var proxiedUrl = PROXY_BASE + encodeURIComponent(targetDestination);
        window.location.href = proxiedUrl;
      }
      return;
    }

    // En modo captura: DETENER navegación y registrar elemento
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var target = e.target;
    if (target === highlightBox || highlightBox.contains(target)) {
      highlightBox.style.display = 'none';
      target = document.elementFromPoint(e.clientX, e.clientY);
    }
    if (!target) { return false; }

    var rect = target.getBoundingClientRect();
    var primarySelector = computePrimarySelector(target);
    var structuralSelector = computeStructuralSelector(target);
    var xpath = computeXPath(target);
    var textSnippet = extractText(target);
    var isSensitive = isSensitiveElement(target);
    var stabilityScore = calculateStabilityScore(target, primarySelector);

    var payload = {
      tagName: target.tagName.toLowerCase(),
      primarySelector: primarySelector,
      structuralCssSelector: structuralSelector,
      xpathFallback: xpath,
      selectorStabilityScore: stabilityScore,
      boundingBox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      isSensitive: isSensitive,
      textSnippet: textSnippet,
    };

    // Notificar al Dashboard
    try {
      window.parent.postMessage({
        type: 'OA_ELEMENT_SELECTED',
        payload: payload,
      }, '*');
    } catch (postErr) {
      // Ignorar fallo de envío
    }

    return false;
  }, true);

  // 7. Notificar cambio de ruta y carga inicial al Dashboard
  function notifyRoute() {
    try {
      var currentHref = window.location.href;
      var rawTarget = currentHref;
      var match = currentHref.match(/[?&]url=([^&]+)/);
      if (match && match[1]) {
        try { rawTarget = decodeURIComponent(match[1]); } catch (pErr) {}
      } else if (TARGET_ORIGIN) {
        var cleanOrigin = TARGET_ORIGIN.replace(/\/+$/, '');
        var path = window.location.pathname || '/';
        rawTarget = cleanOrigin + path + window.location.search + window.location.hash;
      }

      window.parent.postMessage({
        type: 'OA_ROUTE_CHANGED',
        url: rawTarget,
        pathname: window.location.pathname,
      }, '*');
    } catch (rErr) {}
  }

  notifyRoute();
  window.addEventListener('popstate', notifyRoute);

  // Interceptar navegación programática de SPAs (React, Vue, Next.js)
  try {
    var originalPush = history.pushState;
    if (typeof originalPush === 'function') {
      history.pushState = function () {
        var result = originalPush.apply(this, arguments);
        setTimeout(notifyRoute, 10);
        return result;
      };
    }
    var originalReplace = history.replaceState;
    if (typeof originalReplace === 'function') {
      history.replaceState = function () {
        var result = originalReplace.apply(this, arguments);
        setTimeout(notifyRoute, 10);
        return result;
      };
    }
  } catch (hErr) {}
})();
`;
}
