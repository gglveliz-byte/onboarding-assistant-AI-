/**
 * @archivo apps/web/src/app/docs/page.tsx
 * @modulo 08. Landing de Documentación & Sandbox — Guía de Instalación del SDK
 * @proposito
 *   Guía editorial de integración de `@onboarding-assistant/sdk` montada dentro de
 *   `DeveloperDocsShell`: instalación con npm, inicialización adaptada al framework
 *   seleccionado (React/Next.js, Vue 3, Angular o Vanilla JS), convención de selectores
 *   inmutables `data-oa-id`, uso del CLI de la plataforma y sincronización del System
 *   Prompt vía API REST con sello SHA-256 inmutable.
 * @resumen_contenido
 *   - `REACT_INIT_SNIPPET`, `VUE_INIT_SNIPPET`, `ANGULAR_INIT_SNIPPET`, `VANILLA_INIT_SNIPPET`
 *     y `FRAMEWORK_INIT_SNIPPETS`: ejemplos reales de inicialización que mutan según el
 *     framework activo publicado por `useDocsFramework()`.
 *   - `SYSTEM_PROMPT_CURL_SNIPPET`: llamada real a `PUT /api/v1/projects/:projectId/prompt`.
 *   - `SELECTOR_CRITERIA_ROWS` / `SELECTOR_BEST_PRACTICES`: cuadro de la cascada de
 *     selectores y buenas prácticas de instrumentación del DOM.
 *   - `DeveloperCodeBlock`: bloque de código multi-línea sobre la caja de terminal Atelier.
 *   - `DeveloperDocsGuidePage`: página anfitriona de la guía en `/docs`.
 * @dependencias_internas
 *   - `DeveloperDocsShell`, `DOCS_FRAMEWORKS` y `useDocsFramework`
 *     (`../../components/docs-sandbox/DeveloperDocsShell.tsx`).
 *   - `TerminalCommandBox` y `MonoMetadataTag`
 *     (`../../components/atelier-primitives/AtelierUiPrimitives.tsx`).
 * @dependencias_externas
 *   - Solo `react`. Prohibido `next/*`: los enlaces usan `<a href>`.
 * @tablas_bd_o_redis
 *   - Ninguna (página de documentación; solo enlaza la API REST y las páginas legales).
 */

'use client';

import type { CSSProperties, ReactElement } from 'react';
import { MonoMetadataTag, TerminalCommandBox } from '../../components/atelier-primitives/AtelierUiPrimitives';
import {
  DeveloperDocsShell, DOCS_FRAMEWORKS, type DocsFrameworkId, useDocsFramework,
} from '../../components/docs-sandbox/DeveloperDocsShell';

/** Ejemplo real de inicialización en React / Next.js. */
const REACT_INIT_SNIPPET = `import { useEffect } from 'react';
import { OnboardingAssistant } from '@onboarding-assistant/sdk';

export function AssistantLoader() {
  useEffect(() => {
    const assistant = OnboardingAssistant.init({
      publishableKey: 'pk_live_9f8a7b6c',
      showVirtualCursor: true,
    });

    void assistant.start();
    return () => assistant.stop('React desmontó el componente');
  }, []);

  return null;
}`;

/** Ejemplo real de inicialización en Vue 3 (composición con `onMounted`). */
const VUE_INIT_SNIPPET = `<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { OnboardingAssistant } from '@onboarding-assistant/sdk';

let assistant = null;

onMounted(() => {
  assistant = OnboardingAssistant.init({ publishableKey: 'pk_live_9f8a7b6c' });
  assistant.start();
});

onBeforeUnmount(() => assistant?.stop('Vue desmontó el componente'));
</script>`;

/** Ejemplo real de inicialización en Angular dentro del ciclo `ngAfterViewInit`. */
const ANGULAR_INIT_SNIPPET = `import { AfterViewInit, Component, OnDestroy } from '@angular/core';
import { OnboardingAssistant, type OnboardingAssistantClient } from '@onboarding-assistant/sdk';

@Component({ selector: 'app-root', template: '<router-outlet />' })
export class AppComponent implements AfterViewInit, OnDestroy {
  private assistant: OnboardingAssistantClient | null = null;

  ngAfterViewInit(): void {
    this.assistant = OnboardingAssistant.init({ publishableKey: 'pk_live_9f8a7b6c' });
    void this.assistant.start();
  }

  ngOnDestroy(): void {
    this.assistant?.stop('Angular destruyó el componente');
  }
}`;

/** Ejemplo real de inicialización en Vanilla JS tras `DOMContentLoaded`. */
const VANILLA_INIT_SNIPPET = `<script type="module">
  import { OnboardingAssistant } from '@onboarding-assistant/sdk';

  window.addEventListener('DOMContentLoaded', () => {
    const assistant = OnboardingAssistant.init({
      publishableKey: 'pk_live_9f8a7b6c',
      autoTrackSpaRoutes: true,
    });

    assistant.start();
  });
</script>`;

/** Mapa de ejemplo por framework, indexado por el id publicado por el shell. */
const FRAMEWORK_INIT_SNIPPETS: Record<DocsFrameworkId, string> = {
  'react-nextjs': REACT_INIT_SNIPPET,
  vue3: VUE_INIT_SNIPPET,
  angular: ANGULAR_INIT_SNIPPET,
  vanilla: VANILLA_INIT_SNIPPET,
};

/** Ejemplo real de sincronización del System Prompt sobre `PUT /api/v1/projects/:projectId/prompt`. */
const SYSTEM_PROMPT_CURL_SNIPPET = `curl --request PUT \\
  --url https://api.plataforma.com/api/v1/projects/prj_9f2c1a84/prompt \\
  --header 'Authorization: Bearer $OA_SESSION_TOKEN' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "systemPrompt": "Guía al usuario para emitir su primera factura y confirma antes de enviarla.",
    "strictStepEnforcement": true,
    "askConfirmationBeforeSubmit": true
  }'`;

/** Filas del cuadro de la cascada de localización de elementos del DOM. */
const SELECTOR_CRITERIA_ROWS: readonly { readonly selector: string; readonly example: string; readonly usage: string }[] = [
  { selector: '[data-oa-id]', example: 'data-oa-id="btn-crear-factura"', usage: 'Primer criterio y recomendado: identificador inmutable declarado por ti.' },
  { selector: '[aria-label]', example: 'aria-label="Crear factura"', usage: 'Respaldo: reutiliza la etiqueta de accesibilidad ya presente en tu interfaz.' },
  { selector: 'css-path', example: 'main > form > button:nth-child(2)', usage: 'Último recurso: ruta estructural calculada por el asistente sobre el DOM.' },
];

/** Buenas prácticas editoriales para conservar selectores estables entre despliegues. */
const SELECTOR_BEST_PRACTICES: readonly string[] = [
  'Trata los data-oa-id como contrato público de tu interfaz: no los renombres entre despliegues sin avisar al asistente.',
  'Mantén un identificador único por vista y acción (btn-crear-factura, input-numero-factura, modal-confirmacion).',
  'Nunca dependas de clases generadas por tu pipeline de estilos (css-1x2y3z) ni de posiciones dinámicas :nth-child.',
];

/**
 * Resuelve la etiqueta legible del framework activo desde el catálogo del shell.
 * @param frameworkId - Framework activo publicado por `useDocsFramework()`.
 * @returns Etiqueta editorial («React / Next.js», «Vue 3», «Angular» o «Vanilla JS»).
 */
function resolveFrameworkLabel(frameworkId: DocsFrameworkId): string {
  const matchedFramework = DOCS_FRAMEWORKS.find((framework) => framework.id === frameworkId);
  return matchedFramework === undefined ? 'React / Next.js' : matchedFramework.label;
}

/** Propiedades del bloque de código multi-línea sobre la caja de terminal Atelier. */
interface DeveloperCodeBlockProps {
  readonly label: string;
  readonly code: string;
  readonly footnote?: string;
}

/** Bloque de código con etiqueta mono en mayúsculas y cuerpo desplazable en `.atelier-mono`. */
function DeveloperCodeBlock(props: DeveloperCodeBlockProps): ReactElement {
  const { label, code, footnote } = props;
  return (
    <div className="atelier-terminal">
      <p className="atelier-terminal__label">{label}</p>
      <pre className="atelier-mono" style={{ margin: 0, overflowX: 'auto', color: 'var(--color-ink)' }}>
        {code}
      </pre>
      {footnote === undefined ? null : (
        <p className="atelier-help-text" style={{ margin: '8px 0 0' }}>{footnote}</p>
      )}
    </div>
  );
}

/** Estilo común de las secciones editoriales con ancla de navegación. */
const SECTION_STYLE: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '16px', scrollMarginTop: '72px',
};

/** Estilo de las celdas de cabecera de la tabla de selectores. */
const TABLE_HEAD_STYLE: CSSProperties = {
  padding: '10px 14px', fontSize: '12px', fontWeight: 400, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--color-ash)',
};

/** Estilo de las celdas de cuerpo de la tabla de selectores. */
const TABLE_CELL_STYLE: CSSProperties = { padding: '10px 14px', verticalAlign: 'top', color: 'var(--color-ink)' };

function DeveloperDocsGuideContent(): ReactElement {
  const { frameworkId } = useDocsFramework();
  const frameworkLabel = resolveFrameworkLabel(frameworkId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '56px' }}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '780px' }}>
          <p className="atelier-eyebrow">Documentación para desarrolladores</p>
          <h1 className="atelier-heading-lg">Integra el asistente en tu producto en minutos</h1>
          <p className="atelier-prose" style={{ margin: 0 }}>
            El asistente comprende la interfaz de tu aplicación, guía a las personas paso a paso y ejecuta acciones
            directamente en pantalla. Esta guía cubre la instalación del SDK, la instrumentación del DOM con
            selectores inmutables, el CLI de la plataforma y la sincronización del System Prompt por API.
          </p>
        </header>

        <section id="instalacion" style={SECTION_STYLE}>
          <p className="atelier-eyebrow">Paso 01</p>
          <h2 className="atelier-heading">Instalación</h2>
          <p className="atelier-prose" style={{ margin: 0, maxWidth: '780px' }}>
            Instala el cliente oficial. El paquete expone <code className="atelier-mono">OnboardingAssistant.init()</code>{' '}
            como punto de entrada único; entre sus opciones reales están <code className="atelier-mono">publishableKey</code>,{' '}
            <code className="atelier-mono">apiUrl</code>, <code className="atelier-mono">websocketUrl</code>,{' '}
            <code className="atelier-mono">showVirtualCursor</code>, <code className="atelier-mono">autoTrackSpaRoutes</code>,{' '}
            <code className="atelier-mono">debug</code> y los callbacks <code className="atelier-mono">onStepAdvanced</code> y{' '}
            <code className="atelier-mono">onSessionTerminated</code>.
          </p>
          <TerminalCommandBox command="npm install @onboarding-assistant/sdk" label="Terminal" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <MonoMetadataTag label="Inicialización" value={frameworkLabel} tone="neutral" />
              <span className="atelier-help-text">Cambia el ejemplo con el selector de framework de la barra lateral.</span>
            </div>
            <DeveloperCodeBlock label="Inicialización del asistente" code={FRAMEWORK_INIT_SNIPPETS[frameworkId]}
              footnote="Al llamar a start(), el SDK completa el handshake seguro (POST /api/v1/sdk/handshake) validando tu clave publicable y el origen declarado antes de abrir el canal de voz." />
          </div>
        </section>

        <section id="selectores" style={SECTION_STYLE}>
          <p className="atelier-eyebrow">Paso 02</p>
          <h2 className="atelier-heading">Selectores inmutables data-oa-id</h2>
          <p className="atelier-prose" style={{ margin: 0, maxWidth: '780px' }}>
            El asistente localiza cada elemento con una cascada de criterios:{' '}
            <code className="atelier-mono">[data-oa-id]</code> → <code className="atelier-mono">[aria-label]</code> →{' '}
            <code className="atelier-mono">css-path</code>. Declara el primer criterio directamente en tu interfaz para
            que el asistente no dependa de clases volátiles ni de la posición del elemento en el documento.
          </p>
          <div className="atelier-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--color-linen)', textAlign: 'left' }}>
                  <th style={TABLE_HEAD_STYLE}>Criterio</th>
                  <th style={TABLE_HEAD_STYLE}>Cómo se escribe</th>
                  <th style={TABLE_HEAD_STYLE}>Cuándo se usa</th>
                </tr>
              </thead>
              <tbody>
                {SELECTOR_CRITERIA_ROWS.map((row) => (
                  <tr key={row.selector} style={{ borderTop: '1px solid var(--color-stone)' }}>
                    <td style={TABLE_CELL_STYLE}><code className="atelier-mono">{row.selector}</code></td>
                    <td style={TABLE_CELL_STYLE}><code className="atelier-mono">{row.example}</code></td>
                    <td style={TABLE_CELL_STYLE}>{row.usage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {SELECTOR_BEST_PRACTICES.map((practice) => (
              <li key={practice} className="atelier-prose" style={{ fontSize: '15px' }}>{practice}</li>
            ))}
          </ul>
        </section>
        <section id="cli" style={SECTION_STYLE}>
          <p className="atelier-eyebrow">Paso 03</p>
          <h2 className="atelier-heading">CLI de la plataforma</h2>
          <p className="atelier-prose" style={{ margin: 0, maxWidth: '780px' }}>
            Autentica la CLI con el flujo de código de dispositivo: la terminal muestra un código{' '}
            <code className="atelier-mono">XXXX-XXXX</code> y lo confirmas desde el navegador en{' '}
            <a className="atelier-link" href="/auth/cli-device">/auth/cli-device</a>. Al completar la vinculación, la CLI
            queda autorizada para sincronizar la configuración de tu proyecto desde la terminal.
          </p>
          <TerminalCommandBox command="npx @onboarding-assistant login" label="Terminal" />
        </section>

        <section id="system-prompt" style={SECTION_STYLE}>
          <p className="atelier-eyebrow">Paso 04</p>
          <h2 className="atelier-heading">Sincroniza tu System Prompt por API</h2>
          <p className="atelier-prose" style={{ margin: 0, maxWidth: '780px' }}>
            Actualiza el prompt y los pasos de onboarding de tu proyecto con{' '}
            <code className="atelier-mono">PUT /api/v1/projects/:projectId/prompt</code> autenticado con{' '}
            <code className="atelier-mono">Authorization: Bearer</code>. Cada publicación sella el mapa funcional con
            canonicalización determinista y SHA-256: las versiones son inmutables y toda sesión de voz apunta
            exactamente a la revisión que publicaste.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <MonoMetadataTag label="SHA-256" value="3f9a8c…c21b" tone="success" />
            <span className="atelier-help-text">Sello de la revisión publicada del mapa funcional.</span>
          </div>
          <DeveloperCodeBlock label="Terminal — Sincronización del System Prompt" code={SYSTEM_PROMPT_CURL_SNIPPET}
            footnote="El historial conserva cada versión sellada: puedes comparar hashes para auditar cuándo cambió el comportamiento del asistente." />
        </section>

        <section id="consentimiento" className="atelier-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px', scrollMarginTop: '72px' }}>
          <p className="atelier-eyebrow">Uso responsable</p>
          <h2 className="atelier-heading-sm">Consentimiento de voz</h2>
          <p className="atelier-prose" style={{ margin: 0, fontSize: '15px' }}>
            El canal de voz se activa únicamente cuando la persona usuaria final otorga su consentimiento. Antes de
            publicar tu integración revisa la{' '}
            <a className="atelier-link" href="/legal/ai-voice-aup">Política de Uso Aceptable de Voz IA</a> y el{' '}
            <a className="atelier-link" href="/legal/end-user-voice-consent">Consentimiento de voz del usuario final</a>.
          </p>
        </section>
      </div>
    );
  }

/**
 * Guía editorial de instalación e integración del SDK sobre `DeveloperDocsShell`.
 */
export default function DeveloperDocsGuidePage(): ReactElement {
  return (
    <DeveloperDocsShell currentPath="/docs">
      <DeveloperDocsGuideContent />
    </DeveloperDocsShell>
  );
}

