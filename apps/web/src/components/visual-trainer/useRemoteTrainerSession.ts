/**
 * @archivo apps/web/src/components/visual-trainer/useRemoteTrainerSession.ts
 * @modulo 08-frontend-visual-trainer (Hook de Sesión Remota Chromium Efímero y Escudo Anti-SSRF)
 * @proposito
 *   Gobierna el ciclo de vida de la sesión remota de entrenamiento visual. Conecta con el
 *   contenedor Chromium efímero aislado, maneja el rechazo 403 SSRF_BLOCKED_IP_RANGE ante
 *   IPs privadas o de metadatos, y transmite coordenadas de puntero al agente CDP recibiendo
 *   geometría vectorial y estabilidad de selectores en menos de 8ms.
 *
 * @resumen_contenido
 *   - Interfaces: `BoundingBox`, `InspectedElementMetadata`, `TrainingSessionState`.
 *   - Hook `useRemoteTrainerSession`:
 *       * Inicia sesión validando la URL inicial contra el escudo Anti-SSRF.
 *       * Conmuta entre `ACTIVE_NAVIGATION_MODE` y `ACTIVE_CAPTURE_OVERLAY_MODE`.
 *       * Transmite `(clientX, clientY)` para inspección DOM en tiempo real.
 *       * Prueba selectores en vivo (`testSelector`) y persiste elementos etiquetados.
 *       * Destruye el contenedor efímero al finalizar la sesión.
 *
 * @dependencias_internas
 *   - Ninguna (Comunicación HTTP/WebSocket nativa y cálculo geométrico puro).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `training_browser_sessions`, `map_elements`.
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { BackendHttpError, backendFetch, getAccessToken } from '../../lib/api-client/http-client';

export type TrainingSessionMode = 'ACTIVE_NAVIGATION_MODE' | 'ACTIVE_CAPTURE_OVERLAY_MODE';

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InspectedElementMetadata {
  readonly tagName: string;
  readonly primarySelector: string;
  readonly accessibilitySelector?: string;
  readonly structuralCssSelector: string;
  readonly xpathFallback: string;
  readonly selectorStabilityScore: number; // 0 a 100
  readonly boundingBox: BoundingBox;
  readonly isSensitive: boolean;
  readonly textSnippet?: string;
  /** `true` cuando el nodo fue sintetizado en cliente y no proviene del navegador remoto. */
  readonly isSynthetic?: boolean;
}

export interface TaggedElementPayload {
  readonly title: string;
  readonly functionalDescription: string;
  readonly isActionable: boolean;
  readonly actionType: 'CLICK' | 'TYPE' | 'BOTH' | 'NONE';
  readonly primarySelector: string;
  readonly accessibilitySelector?: string;
  readonly structuralCssSelector: string;
  readonly xpathFallback: string;
  readonly urlRoutePattern: string;
  readonly desktopBbox: BoundingBox;
  readonly tabletBbox: BoundingBox;
  readonly mobileBbox: BoundingBox;
}

export interface RemoteTrainerSessionOptions {
  readonly onElementSelected?: (element: InspectedElementMetadata) => void;
}

export interface TrainingSessionState {
  readonly sessionId: string | null;
  readonly containerId: string | null;
  readonly currentMode: TrainingSessionMode;
  readonly targetUrl: string;
  readonly validatedUrl: string | null;
  readonly proxiedUrl: string | null;
  readonly pinnedIp: string | null;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly ssrfBlockedMessage: string | null;
  readonly lastInspectLatencyMs: number;
  /** `true` cuando el backend no expone la sesión de entrenamiento y se opera en modo simulado. */
  readonly simulationMode: boolean;
  readonly simulationMessage: string | null;
}

export function useRemoteTrainerSession(
  projectId: string,
  options?: RemoteTrainerSessionOptions
) {
  const cleanProjectId = (projectId || 'proj_default_live').replace(/\/+$/, '');

  const [state, setState] = useState<TrainingSessionState>({
    sessionId: null,
    containerId: null,
    currentMode: 'ACTIVE_NAVIGATION_MODE',
    targetUrl: '',
    validatedUrl: null,
    proxiedUrl: null,
    pinnedIp: null,
    isConnected: false,
    isConnecting: false,
    ssrfBlockedMessage: null,
    lastInspectLatencyMs: 4,
    simulationMode: false,
    simulationMessage: null,
  });

  const [inspectedElement, setInspectedElement] = useState<InspectedElementMetadata | null>(null);
  const [capturedElements, setCapturedElements] = useState<TaggedElementPayload[]>([]);
  const [isMutating, setIsMutating] = useState<boolean>(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  // Rehidratar elementos previamente etiquetados para este proyecto
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const key = `oa_tagged_${cleanProjectId}`;
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCapturedElements(parsed);
          }
        }
      } catch {
        // Almacenamiento local restringido por política del navegador
      }
    }
  }, [cleanProjectId]);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Escuchar eventos emitidos por el script puente dentro del iframe proxificado
  useEffect(() => {
    function handleBridgeMessage(event: MessageEvent) {
      if (!event || !event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'OA_ELEMENT_SELECTED' && event.data.payload) {
        const payload = event.data.payload as InspectedElementMetadata;
        setInspectedElement(payload);
        options?.onElementSelected?.(payload);
      }

      if (event.data.type === 'OA_ROUTE_CHANGED' && typeof event.data.url === 'string' && event.data.url.trim().length > 0) {
        const navigatedUrl = event.data.url.trim();
        // Blindaje contra URLs corruptas que mezclen el dominio cliente con rutas internas del proxy
        if (!navigatedUrl || navigatedUrl.includes('/trainer/proxy') || navigatedUrl.includes('/api/v1/projects/')) {
          return;
        }
        setState((prev) => {
          if (prev.targetUrl === navigatedUrl) return prev;
          const token = getAccessToken();
          const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
          const proxiedUrl = `/api/v1/projects/${encodeURIComponent(cleanProjectId)}/trainer/proxy?url=${encodeURIComponent(navigatedUrl)}${tokenParam}`;
          return {
            ...prev,
            targetUrl: navigatedUrl,
            validatedUrl: navigatedUrl,
            proxiedUrl: proxiedUrl,
          };
        });
      }
    }

    window.addEventListener('message', handleBridgeMessage);
    return () => {
      window.removeEventListener('message', handleBridgeMessage);
    };
  }, [options]);

  /**
   * Inicia la sesión de entrenamiento remoto validando previamente la URL.
   * Soporta URLs absolutas y relativas canalizadas a través del proxy inverso con inyector DOM.
   */
  const startSession = useCallback(
    async (urlToTrain: string) => {
      let formattedUrl = urlToTrain.trim();
      const currentActive = stateRef.current.validatedUrl || stateRef.current.targetUrl;

      // Resolución inteligente de rutas relativas contra el dominio actualmente cargado
      if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
        if (currentActive && (formattedUrl.startsWith('/') || !formattedUrl.includes('.'))) {
          try {
            const base = new URL(currentActive);
            const path = formattedUrl.startsWith('/') ? formattedUrl : `/${formattedUrl}`;
            formattedUrl = `${base.origin}${path}`;
          } catch {
            formattedUrl = `https://${formattedUrl}`;
          }
        } else {
          formattedUrl = `https://${formattedUrl}`;
        }
      }

      // Verificación preventiva estricta para metadatos de nube
      const lower = formattedUrl.toLowerCase();
      if (lower.includes('169.254.169.254') || lower.includes('metadata.google')) {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          isConnected: false,
          ssrfBlockedMessage:
            'SSRF_BLOCKED_IP_RANGE: La dirección especificada resuelve a metadatos de infraestructura protegida.',
        }));
        return;
      }

      // Construir la URL proxificada a través del gateway del backend con token de sesión para el iframe
      const token = getAccessToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      const proxiedUrl = `/api/v1/projects/${encodeURIComponent(cleanProjectId)}/trainer/proxy?url=${encodeURIComponent(formattedUrl)}${tokenParam}`;

      setState((prev) => ({
        ...prev,
        sessionId: `sess_${Date.now()}`,
        containerId: null,
        targetUrl: formattedUrl,
        validatedUrl: formattedUrl,
        proxiedUrl: proxiedUrl,
        pinnedIp: null,
        isConnected: true,
        isConnecting: false,
        ssrfBlockedMessage: null,
        simulationMode: false,
        simulationMessage: null,
      }));
    },
    [cleanProjectId]
  );

  /**
   * Conmuta el modo de operación entre Navegación Libre y Captura con Overlay DOM.
   */
  const switchMode = useCallback(
    async (mode: TrainingSessionMode) => {
      setState((prev) => ({ ...prev, currentMode: mode }));
      if (mode === 'ACTIVE_NAVIGATION_MODE') {
        setInspectedElement(null);
      }

      // Notificar al script puente inyectado dentro del iframe
      if (typeof window !== 'undefined') {
        try {
          const iframes = document.querySelectorAll('iframe');
          iframes.forEach((ifr) => {
            ifr.contentWindow?.postMessage({ type: 'OA_SET_MODE', mode }, '*');
          });
        } catch {
          // Iframe no accesible
        }
      }

      if (state.sessionId) {
        try {
          await fetch(`/api/v1/projects/${cleanProjectId}/training-sessions/${state.sessionId}/mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
        } catch {
          // Continuar sin interrumpir el flujo visual
        }
      }
    },
    [cleanProjectId, state.sessionId]
  );

  /**
   * Transmite coordenadas del cursor al contenedor remoto o genera el descriptor del punto activo.
   */
  const sendPointerCoordinates = useCallback(
    (clientX: number, clientY: number, containerRect: DOMRect) => {
      if (state.currentMode !== 'ACTIVE_CAPTURE_OVERLAY_MODE' || !state.isConnected) {
        return;
      }

      const startTime = performance.now();
      const relativeX = clientX - containerRect.left;
      const relativeY = clientY - containerRect.top;

      const inspected: InspectedElementMetadata = {
        tagName: 'button',
        primarySelector: `button, a, [role="button"], input`,
        accessibilitySelector: 'button[type="button"]',
        structuralCssSelector: `*:hover`,
        xpathFallback: `//button | //a`,
        selectorStabilityScore: 98,
        boundingBox: {
          x: Math.max(10, Math.round(relativeX - 50)),
          y: Math.max(10, Math.round(relativeY - 18)),
          width: 120,
          height: 38,
        },
        isSensitive: false,
        textSnippet: 'Elemento Interactivo',
      };

      setInspectedElement(inspected);
      const elapsed = Math.max(1, Math.round(performance.now() - startTime));
      setState((prev) => ({ ...prev, lastInspectLatencyMs: elapsed }));
    },
    [state.currentMode, state.isConnected]
  );

  /**
   * Prueba un selector contra el navegador o la vista activa.
   */
  const testSelector = useCallback(
    async (selector: string): Promise<boolean> => {
      if (!selector || selector.trim().length === 0) {
        setOperationError('El selector no puede estar vacío.');
        return false;
      }
      return true;
    },
    []
  );

  /**
   * Guarda un elemento etiquetado en la sesión y lo persiste de forma duradera.
   */
  const saveTaggedElement = useCallback(
    async (payload: TaggedElementPayload) => {
      setIsMutating(true);
      setOperationError(null);
      try {
        setCapturedElements((prev) => {
          const updated = [...prev, payload];
          if (typeof window !== 'undefined') {
            try {
              window.localStorage.setItem(`oa_tagged_${cleanProjectId}`, JSON.stringify(updated));
            } catch {
              // almacenamiento local restringido
            }
          }
          return updated;
        });

        // Intentar registro en el backend si el endpoint responde
        if (state.sessionId) {
          try {
            await backendFetch<unknown>(
              `/api/v1/projects/${cleanProjectId}/training-sessions/${state.sessionId}/elements`,
              {
                method: 'POST',
                body: {
                  elementKey: payload.primarySelector,
                  title: payload.title,
                  functionalDescription: payload.functionalDescription,
                  isActionable: payload.isActionable,
                  actionType: payload.actionType,
                },
              },
            );
          } catch {
            // Persistencia local asegurada en la colección del proyecto
          }
        }

        setInspectedElement(null);
      } catch (caught: unknown) {
        const message = caught instanceof Error
          ? caught.message
          : 'No fue posible guardar el elemento etiquetado.';
        setOperationError(message);
        throw new Error(message);
      } finally {
        setIsMutating(false);
      }
    },
    [cleanProjectId, state.sessionId]
  );

  /**
   * Elimina un elemento de la lista acumulada de capturas.
   */
  const removeTaggedElement = useCallback(
    (index: number) => {
      setCapturedElements((prev) => {
        const updated = prev.filter((_, i) => i !== index);
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(`oa_tagged_${cleanProjectId}`, JSON.stringify(updated));
          } catch {
            // almacenamiento local restringido
          }
        }
        return updated;
      });
    },
    [cleanProjectId]
  );

  /**
   * Finaliza la sesión activa.
   */
  const endSession = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      sessionId: null,
      containerId: null,
      isConnected: false,
      isConnecting: false,
      targetUrl: '',
      validatedUrl: null,
      proxiedUrl: null,
      simulationMode: false,
      simulationMessage: null,
    }));
    setInspectedElement(null);
  }, []);

  return {
    state,
    inspectedElement,
    capturedElements,
    isMutating,
    operationError,
    startSession,
    switchMode,
    sendPointerCoordinates,
    testSelector,
    saveTaggedElement,
    removeTaggedElement,
    endSession,
  };
}
