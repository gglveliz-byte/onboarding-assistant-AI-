/**
 * @archivo packages/sdk/src/index.tsx
 * @modulo @onboarding-assistant/sdk (Ensamblador React del SDK Web)
 * @proposito
 *   Ensambla la superficie React del SDK Web: fachada aditiva del inicializador global
 *   `OnboardingAssistant.init()`, el componente `OnboardingAssistantProvider` con contexto
 *   de sesión/captura/widget, y los re-exports públicos de los subsistemas de captura de
 *   voz (`./audio/pcm16-worklet-and-vad`) y del widget aislado en Shadow DOM
 *   (`./ui/assistant-widget-shadow`) para aplicaciones React/Next.js anfitrionas.
 *
 * @resumen_contenido
 *   - `OnboardingAssistant`: fachada congelada que deriva la superficie real de `./index`
 *     y delega `init(options)` sin alterar la semántica del punto de entrada base.
 *   - `OnboardingAssistantWidgetConfig` / `OnboardingAssistantCaptureConfig`: bloques
 *     opt-in que montan el widget aislado y habilitan el pipeline de captura.
 *   - `OnboardingAssistantProviderProps` + `OnboardingAssistantProvider`: provider que
 *     renderiza SIEMPRE `children`; sin bloques de configuración no monta nada ni abre
 *     red alguna (la sesión de voz arranca solo cuando el integrador llama `startSession`).
 *   - `OnboardingAssistantContextValue` + `useOnboardingAssistant()`: contrato del contexto
 *     y hook de acceso tolerante (`null` fuera del provider, sin lanzar excepciones).
 *   - Re-exports aditivos de audio y del widget con sus nombres públicos reales.
 *
 * @dependencias_internas
 *   - `OnboardingAssistant` de `./index`; `OnboardingAssistantClient` de `./core/sdk-client`.
 *   - `Pcm16CapturePipeline` y tipos de captura de `./audio/pcm16-worklet-and-vad`.
 *   - `AssistantWidgetShadow` y tipos del widget de `./ui/assistant-widget-shadow`.
 *
 * @dependencias_externas
 *   - Solo `react` (hooks y tipos). Sin `next/*`, sin `react-dom` directo y sin
 *     dependencias nuevas.
 *
 * @notas
 *   - Sin ciclos: `index.ts` y el resto del SDK jamás deben importar este archivo.
 *   - `./index` resuelve a `index.ts` (preferencia estándar de `.ts` sobre `.tsx` en
 *     TypeScript y empaquetadores), por lo que la fachada nunca se auto-importa.
 *   - Integraciones opt-in por prop: `clientOptions` (cliente sin red al construirse),
 *     `widget` (montaje en `document.body` dentro de un efecto) y `capture` (grafo de
 *     audio montado solo al invocar `startCapture` con una pista de micrófono).
 *   - Memoriza los bloques de configuración en el integrador para evitar recreaciones.
 */

'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { OnboardingAssistant as CoreOnboardingAssistant } from './index';
import type { OnboardingAssistantClient, OnboardingAssistantOptions } from './core/sdk-client';
import type { Pcm16CaptureHandlers, Pcm16CaptureOptions } from './audio/pcm16-worklet-and-vad';
import { Pcm16CapturePipeline } from './audio/pcm16-worklet-and-vad';
import type {
  AssistantWidgetHandlers,
  AssistantWidgetStatus,
  AssistantWidgetTheme,
} from './ui/assistant-widget-shadow';
import { AssistantWidgetShadow } from './ui/assistant-widget-shadow';

/**
 * Fachada aditiva y congelada del inicializador global del SDK. Deriva su superficie de
 * `./index` (mismo contrato `init(options) → OnboardingAssistantClient`) y delega la
 * construcción en el cliente oficial sin alterar la semántica del punto de entrada base.
 */
export const OnboardingAssistant = Object.freeze({
  ...CoreOnboardingAssistant,
  /**
   * Inicializa el cliente oficial del SDK a partir de las opciones reales de configuración.
   * La construcción NO abre red: el handshake y el canal de voz inician con `start()`.
   *
   * @param options - Clave publicable y ajustes tipados de `OnboardingAssistantOptions`.
   * @returns Instancia nueva de `OnboardingAssistantClient`.
   */
  init(options: OnboardingAssistantOptions): OnboardingAssistantClient {
    return CoreOnboardingAssistant.init(options);
  },
});

/** Bloque opt-in de widget: su sola presencia monta el widget aislado en Shadow DOM. */
export interface OnboardingAssistantWidgetConfig {
  /** Callbacks del widget (activar, finalizar e interrumpir) enlazados por el integrador. */
  readonly handlers: AssistantWidgetHandlers;
  /** Tema visual opcional (acento, esquina y URL de la política de voz). */
  readonly theme?: AssistantWidgetTheme | undefined;
  /** Estado visible inicial de las píldoras del widget (por defecto `idle`). */
  readonly initialStatus?: AssistantWidgetStatus | undefined;
}

/** Bloque opt-in de captura: su sola presencia habilita `startCapture()` en el contexto. */
export interface OnboardingAssistantCaptureConfig {
  /** Handlers de tramas codificadas, barge-in local y nivel RMS del pipeline real. */
  readonly handlers: Pcm16CaptureHandlers;
  /** Ajustes opcionales del VAD local y umbrales (tipo real `Pcm16CaptureOptions`). */
  readonly options?: Pcm16CaptureOptions | undefined;
}

/** Propiedades del provider React del SDK. */
export interface OnboardingAssistantProviderProps {
  /** Contenido anfitrión; se renderiza SIEMPRE, con o sin configuración del SDK. */
  readonly children: ReactNode;
  /** Configuración real del cliente; sin ella el contexto expone `assistant: null`. */
  readonly clientOptions?: OnboardingAssistantOptions | undefined;
  /** Bloque opt-in del widget aislado (se monta únicamente si está presente). */
  readonly widget?: OnboardingAssistantWidgetConfig | undefined;
  /** Bloque opt-in del pipeline de captura (se habilita únicamente si está presente). */
  readonly capture?: OnboardingAssistantCaptureConfig | undefined;
}

/** Contrato aditivo del contexto del SDK expuesto a los componentes anfitriones. */
export interface OnboardingAssistantContextValue {
  /** Cliente oficial si se proporcionó `clientOptions`; `null` en caso contrario. */
  readonly assistant: OnboardingAssistantClient | null;
  /** Widget montado si se proporcionó `widget`; `null` en caso contrario. */
  readonly widget: AssistantWidgetShadow | null;
  /** Pipeline de captura listo si se proporcionó `capture`; `null` en caso contrario. */
  readonly capture: Pcm16CapturePipeline | null;
  /** Inicia la sesión de voz del cliente (handshake + canal en tiempo real). No-op sin cliente. */
  startSession(): Promise<void>;
  /** Detiene la sesión activa del cliente sin desmontarlo. No-op sin cliente. */
  stopSession(): void;
  /** Monta el grafo de captura sobre una pista de micrófono. No-op sin bloque `capture`. */
  startCapture(source: MediaStream, audioContext?: AudioContext): Promise<void>;
  /** Desmonta el grafo de captura (seguro aunque nunca se haya iniciado). No-op sin bloque `capture`. */
  stopCapture(): void;
  /** Refleja el estado visible en las píldoras del widget. No-op sin widget montado. */
  setWidgetStatus(status: AssistantWidgetStatus): void;
}

/** Contexto interno del ensamblador; `null` mientras no haya un provider montado. */
const OnboardingAssistantContext = createContext<OnboardingAssistantContextValue | null>(null);

/**
 * Provider React aditivo del SDK. Crea el cliente oficial (sin abrir sockets), monta el
 * widget aislado y/o habilita el pipeline de captura según los bloques opt-in, publica
 * ambas instancias y las operaciones de sesión en el contexto, y renderiza `children`
 * en todos los escenarios.
 *
 * @param props - Contenido hijo y bloques de configuración con los tipos reales del SDK.
 * @returns Los `children` envueltos en el contexto del SDK.
 */
export function OnboardingAssistantProvider(props: OnboardingAssistantProviderProps): ReactElement {
  const { children, clientOptions, widget, capture } = props;

  const [assistant, setAssistant] = useState<OnboardingAssistantClient | null>(null);
  const [widgetInstance, setWidgetInstance] = useState<AssistantWidgetShadow | null>(null);

  // El cliente se crea solo con configuración explícita; su construcción NO abre red.
  useEffect(() => {
    if (clientOptions === undefined) {
      setAssistant(null);
      return;
    }
    const instance = OnboardingAssistant.init(clientOptions);
    setAssistant(instance);
    return () => {
      instance.stop('Provider del SDK desmontado');
    };
  }, [clientOptions]);

  // Widget opt-in: el DOM se monta dentro del efecto y solo en el navegador.
  useEffect(() => {
    if (widget === undefined) {
      setWidgetInstance(null);
      return;
    }
    const instance = new AssistantWidgetShadow(widget.handlers, widget.theme);
    instance.mount();
    if (widget.initialStatus !== undefined) {
      instance.setStatus(widget.initialStatus);
    }
    setWidgetInstance(instance);
    return () => {
      instance.unmount();
    };
  }, [widget]);

  // Pipeline opt-in: la construcción es pura (sin DOM ni audio) y se libera al desmontar.
  const capturePipeline = useMemo<Pcm16CapturePipeline | null>(() => {
    if (capture === undefined) {
      return null;
    }
    const captureOptions = capture.options;
    if (captureOptions === undefined) {
      return new Pcm16CapturePipeline({ handlers: capture.handlers });
    }
    return new Pcm16CapturePipeline({ ...captureOptions, handlers: capture.handlers });
  }, [capture]);

  useEffect(() => {
    if (capturePipeline === null) {
      return;
    }
    return () => {
      capturePipeline.stop();
    };
  }, [capturePipeline]);

  const startSession = useCallback(async (): Promise<void> => {
    if (assistant !== null) {
      await assistant.start();
    }
  }, [assistant]);

  const stopSession = useCallback((): void => {
    if (assistant !== null) {
      assistant.stop();
    }
  }, [assistant]);

  const startCapture = useCallback(
    async (source: MediaStream, audioContext?: AudioContext): Promise<void> => {
      if (capturePipeline !== null) {
        await capturePipeline.start(source, audioContext);
      }
    },
    [capturePipeline],
  );

  const stopCapture = useCallback((): void => {
    if (capturePipeline !== null) {
      capturePipeline.stop();
    }
  }, [capturePipeline]);

  const setWidgetStatus = useCallback(
    (status: AssistantWidgetStatus): void => {
      if (widgetInstance !== null) {
        widgetInstance.setStatus(status);
      }
    },
    [widgetInstance],
  );

  const contextValue = useMemo<OnboardingAssistantContextValue>(
    () => ({
      assistant,
      widget: widgetInstance,
      capture: capturePipeline,
      startSession,
      stopSession,
      startCapture,
      stopCapture,
      setWidgetStatus,
    }),
    [assistant, widgetInstance, capturePipeline, startSession, stopSession, startCapture, stopCapture, setWidgetStatus],
  );

  return (
    <OnboardingAssistantContext.Provider value={contextValue}>{children}</OnboardingAssistantContext.Provider>
  );
}

/**
 * Hook de acceso al contexto del SDK.
 *
 * @returns El contrato completo del contexto, o `null` si no hay provider montado.
 */
export function useOnboardingAssistant(): OnboardingAssistantContextValue | null {
  return useContext(OnboardingAssistantContext);
}

// ---------------------------------------------------------------------------
// Re-exports aditivos de los subsistemas del SDK (nombres públicos reales)
// ---------------------------------------------------------------------------

export { OnboardingAssistantClient, type OnboardingAssistantOptions } from './index';

export {
  PCM16_SAMPLE_RATE,
  PCM16_FRAME_MS,
  PCM16_FRAME_BYTES,
  PCM16_FRAME_HEADER_BYTE,
  PCM16_WORKLET_PROCESSOR_NAME,
  buildPcm16WorkletSource,
  createPcm16WorkletBlobUrl,
  Pcm16CapturePipeline,
  type Pcm16CaptureHandlers,
  type Pcm16CaptureOptions,
} from './audio/pcm16-worklet-and-vad';

export {
  AssistantWidgetShadow,
  type AssistantWidgetTheme,
  type AssistantWidgetHandlers,
  type AssistantWidgetStatus,
} from './ui/assistant-widget-shadow';
