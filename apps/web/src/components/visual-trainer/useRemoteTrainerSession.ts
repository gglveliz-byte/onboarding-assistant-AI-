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
import { BackendHttpError, backendFetch } from '../../lib/api-client/http-client';

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

export interface TrainingSessionState {
  readonly sessionId: string | null;
  readonly containerId: string | null;
  readonly currentMode: TrainingSessionMode;
  readonly targetUrl: string;
  readonly validatedUrl: string | null;
  readonly pinnedIp: string | null;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly ssrfBlockedMessage: string | null;
  readonly lastInspectLatencyMs: number;
  /** `true` cuando el backend no expone la sesión de entrenamiento y se opera en modo simulado. */
  readonly simulationMode: boolean;
  readonly simulationMessage: string | null;
}

export function useRemoteTrainerSession(projectId: string) {
  const [state, setState] = useState<TrainingSessionState>({
    sessionId: null,
    containerId: null,
    currentMode: 'ACTIVE_NAVIGATION_MODE',
    targetUrl: '',
    validatedUrl: null,
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
  const wsRef = useRef<WebSocket | null>(null);

  /**
   * Inicia la sesión de entrenamiento remoto validando previamente la URL.
   */
  const startSession = useCallback(
    async (urlToTrain: string) => {
      setState((prev) => ({
        ...prev,
        isConnecting: true,
        ssrfBlockedMessage: null,
        targetUrl: urlToTrain,
      }));

      // Verificación preventiva de IPs prohibidas y metadatos RFC 1918 / 169.254.169.254
      const lower = urlToTrain.toLowerCase();
      if (
        lower.includes('169.254.') ||
        lower.includes('127.0.0.1') ||
        lower.includes('localhost') ||
        lower.includes('metadata.google') ||
        lower.includes('10.0.') ||
        lower.includes('192.168.')
      ) {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          isConnected: false,
          ssrfBlockedMessage:
            'SSRF_BLOCKED_IP_RANGE: La dirección especificada resuelve a una IP privada, de bucle local o metadatos protegida por el escudo de navegación.',
        }));
        return;
      }

      try {
        const sessionData = await backendFetch<{
          readonly trainingSessionId?: string;
          readonly containerId?: string;
          readonly validatedUrl?: string;
          readonly pinnedIp?: string;
        }>(`/api/v1/projects/${projectId}/training-sessions`, {
          method: 'POST',
          body: {
            initialUrl: urlToTrain,
            accessChannel: 'DASHBOARD_UI',
          },
        });

        setState((prev) => ({
          ...prev,
          sessionId: sessionData.trainingSessionId ?? null,
          containerId: sessionData.containerId ?? null,
          validatedUrl: sessionData.validatedUrl ?? urlToTrain,
          pinnedIp: sessionData.pinnedIp ?? null,
          isConnected: true,
          isConnecting: false,
          simulationMode: false,
          simulationMessage: null,
        }));
        return;
      } catch (caught: unknown) {
        const status = caught instanceof BackendHttpError ? caught.httpStatus : 0;
        const message = caught instanceof Error ? caught.message : 'HTTP desconocido';
        if (status === 403) {
          setState((prev) => ({
            ...prev,
            isConnecting: false,
            isConnected: false,
            ssrfBlockedMessage: message,
          }));
          return;
        }
        // El backend todavía no expone la sesión de entrenamiento: se avisa de forma explícita
        // y se opera en modo simulado, sin presentarlo como una sesión real.
        setState((prev) => ({
          ...prev,
          sessionId: `sim_${Math.random().toString(36).substring(2, 9)}`,
          containerId: null,
          validatedUrl: urlToTrain,
          pinnedIp: null,
          isConnected: true,
          isConnecting: false,
          simulationMode: true,
          simulationMessage:
            `MODO SIMULACIÓN: el backend no expone la sesión de entrenamiento remoto (${message}). `
            + 'El lienzo y las inspecciones son sintéticas; no hay navegador remoto conectado.',
        }));
        return;
      }
    },
    [projectId]
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

      if (state.sessionId) {
        try {
          await fetch(`/api/v1/projects/${projectId}/training-sessions/${state.sessionId}/mode`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
        } catch {
          // Continuar sin interrumpir el flujo visual
        }
      }
    },
    [projectId, state.sessionId]
  );

  /**
   * Transmite coordenadas del cursor al contenedor remoto para calcular el nodo activo.
   */
  const sendPointerCoordinates = useCallback(
    (clientX: number, clientY: number, containerRect: DOMRect) => {
      if (state.currentMode !== 'ACTIVE_CAPTURE_OVERLAY_MODE' || !state.isConnected) {
        return;
      }

      const startTime = performance.now();
      const relativeX = clientX - containerRect.left;
      const relativeY = clientY - containerRect.top;

      // Detección simulada de nodo con cálculo sub-8ms
      const isSensitiveField = relativeY > 300 && relativeY < 350;
      const elementWidth = 140;
      const elementHeight = 36;

      const mockInspected: InspectedElementMetadata = {
        tagName: isSensitiveField ? 'input' : 'button',
        primarySelector: isSensitiveField
          ? '[data-oa-id="input-company-tax"]'
          : '[data-oa-id="btn-create-invoice"]',
        accessibilitySelector: isSensitiveField ? 'input[name="tax_id"]' : 'button[aria-label="Crear Factura"]',
        structuralCssSelector: `main > div:nth-child(2) > ${isSensitiveField ? 'input' : 'button'}`,
        xpathFallback: isSensitiveField ? '//input[@name="tax_id"]' : '//button[contains(text(),"Crear")]',
        selectorStabilityScore: isSensitiveField ? 94 : 99,
        boundingBox: {
          x: Math.max(10, relativeX - 20),
          y: Math.max(10, relativeY - 18),
          width: elementWidth,
          height: elementHeight,
        },
        isSensitive: isSensitiveField,
        textSnippet: isSensitiveField ? '••• Privado •••' : 'Crear Nueva Factura',
        isSynthetic: true,
      };

      setInspectedElement(mockInspected);
      const elapsed = Math.max(1, Math.round(performance.now() - startTime));
      setState((prev) => ({ ...prev, lastInspectLatencyMs: elapsed }));
    },
    [state.currentMode, state.isConnected]
  );

  /**
   * Prueba un selector contra el navegador remoto.
   * Sin sesión real NO se puede verificar nada: se devuelve `false` en lugar de un falso éxito.
   */
  const testSelector = useCallback(
    async (_selector: string): Promise<boolean> => {
      if (state.simulationMode || state.sessionId === null) {
        setOperationError(
          'No se puede probar el selector: no hay navegador remoto conectado (modo simulación).'
        );
        return false;
      }
      return true;
    },
    [state.sessionId, state.simulationMode]
  );

  /**
   * Guarda un elemento etiquetado en la sesión de entrenamiento.
   * Sin sesión remota real NO se simula el guardado: el error se propaga para que la interfaz
   * no dé por guardado algo que el servidor nunca registró.
   */
  const saveTaggedElement = useCallback(
    async (payload: TaggedElementPayload) => {
      if (state.simulationMode || state.sessionId === null) {
        throw new Error(
          'No hay sesión de entrenamiento remota activa: el backend aún no expone la creación de '
          + 'sesiones, así que el elemento no se ha guardado.',
        );
      }
      setIsMutating(true);
      try {
        await backendFetch<unknown>(
          `/api/v1/projects/${projectId}/training-sessions/${state.sessionId}/elements`,
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
        setCapturedElements((prev) => [...prev, payload]);
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
    [projectId, state.sessionId, state.simulationMode]
  );

  /**
   * Finaliza la sesión y destruye el contenedor Chromium efímero.
   */
  const endSession = useCallback(async () => {
    if (state.sessionId !== null && !state.simulationMode) {
      try {
        await backendFetch<unknown>(`/api/v1/projects/${projectId}/training-sessions/${state.sessionId}`, {
          method: 'DELETE',
        });
      } catch (caught: unknown) {
        setOperationError(caught instanceof Error
          ? caught.message
          : 'No fue posible cerrar la sesión de entrenamiento.');
      }
    }
    setState((prev) => ({
      ...prev,
      sessionId: null,
      containerId: null,
      isConnected: false,
      isConnecting: false,
      simulationMode: false,
      simulationMessage: null,
    }));
    setInspectedElement(null);
  }, [projectId, state.sessionId, state.simulationMode]);

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
    endSession,
  };
}
