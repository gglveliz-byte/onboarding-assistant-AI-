---
name: estilo-paneles-y-docs-cursor-atelier
description: >-
  Sistema de diseño visual, tokens CSS/Tailwind v4 y reglas de componentes estilo Cursor Light (Warm Parchment Atelier lit by embers) para el Dashboard del Desarrollador, Dashboard SuperAdmin, paneles CRM/Autenticación y Landing Pública de Documentación & Sandbox. Úsalo siempre que construyas o edites vistas de documentación, sandbox, paneles privados, editores RAG, visor de entrenamiento o tablas de facturación.
---

# Skill Global 04: Sistema de Diseño para Dashboard del Desarrollador, SuperAdmin, CRM y Documentación Pública (Cursor Light - Warm Parchment Atelier)

Esta skill define el sistema de diseño obligatorio para todas las superficies técnicas, operativas y documentales de la plataforma: **Landing Pública de Documentación & Sandbox (`/docs`, `/docs/sandbox`)**, **Portales de Login/Recuperación (`/auth/*`)**, **Dashboard del Desarrollador (`/dashboard/*`)** y **Dashboard de SuperAdmin (`/superadmin/*`)**.

**Estado actual (2026-10-18):** todas estas superficies están construidas y consolidadas en **tema claro estricto** dentro del workspace único `apps/web` (grupos de rutas `(auth)/*`, `legal/*`, `docs/*` + `docs/sandbox`, `dashboard/org/[orgSlug]/*`, `superadmin/*`). Cero modo oscuro. Las rutas reales del repositorio son la fuente de verdad (`docs/LIVE_ARCHITECTURE_LEDGER.md`, Sección 1: mapa de enrutamiento). La **Landing Comercial (`/`)** es la única superficie que NO se rige por esta skill: le corresponde la skill hermana `estilo-landing-comercial-auros-claro` (lienzo Auros con fondo de constelación viva).

## Cuándo Activar esta Skill

Activa y aplica estas directrices siempre que construyas o modifiques:

- La **Landing de Documentación y el Sandbox Interactivo** de 3 paneles (`click_element` y `type_text`).
- El **Dashboard del Desarrollador** (Gestor de API Keys `pk_live_`/`sk_live_`, Estudio del Prompt paso a paso, Visor del Navegador de Entrenamiento Remoto, Editor Dual Visual/JSON del Mapa RAG y Panel de Facturación Whop).
- El **Dashboard de SuperAdmin** (Gobierno de organizaciones, Matriz global de precios Whop, Overrides por cliente, Monitor de infraestructura en vivo y Explorador de `audit_logs`).
- Todos los formularios de inicio de sesión, SSO SAML, retos MFA y modales de consentimiento legal (ToS / Privacidad / DPA).

---

## 1. Filosofía Visual: "Warm Parchment Atelier Lit by Embers" (Tema Claro Editorial y Técnico)

El entorno de trabajo del desarrollador y del administrador rechaza el aspecto genérico de plantillas SaaS blancas/azules brillantes. Adopta la estética de **Atelier en Pergamino Cálido de Cursor**:

- **Papel sobre Papel (Cero Blanco Puro `#FFFFFF`, Cero Negro Puro `#000000`):** El lienzo base es crema pergamino (`#f7f7f4` Parchment), las tarjetas y paneles reposan sobre hueso cálido (`#f2f1ed` Bone) y los elementos interactivos secundarios sobre lino (`#e6e5e0` Linen), con texto en tinta casi negra cálida (`#26251e` Ink).
- **Autoridad por Contención Tipográfica:** Todos los encabezados usan `CursorGothic` en **peso `400` (Regular)** con `letter-spacing` progresivamente más cerrado a medida que crece el tamaño (`-0.005em` a `-0.03em`). **Nunca se usa negrita (`600` o `700`) en titulares.**
- **Trío Tipográfico de Precisión:**
  1. `CursorGothic` (`--font-cursorgothic`) para la estructura UI, navegación y titulares en peso `400`.
  2. `EB Garamond` (`--font-eb-garamond`) para subtítulos editoriales en la documentación, prosa explicativa y notas de auditoría.
  3. `berkeleyMono` (`--font-berkeleymono`, `12px-13px`) para todos los comandos CLI (`npm install @onboarding-assistant/sdk`), selectores DOM (`[data-oa-id]`), hashes `SHA-256`, claves `pk_live_`/`sk_live_` y telemetría de tiempos en milisegundos.
- **Geometría Cortada a Bisturí (`4px` Border Radius Universal):** Todos los botones, tarjetas, tablas, pestañas, bloques de terminal e inputs tienen exactamente `border-radius: 4px` (`8px` únicamente para modales flotantes como el `<ElementTaggingModal />`).

---

## 2. Tokens Oficiales de Color, Tipografía, Espaciado y Sombras (`CSS` & `Tailwind v4`)

### 2.1. Paleta Cromática Estricta

| Nombre | Valor Hex | Variable CSS | Rol en Paneles, CRM y Documentación |
| :--- | :--- | :--- | :--- |
| **Parchment** | `#f7f7f4` | `--color-parchment` | Lienzo de fondo principal de todas las páginas del Dashboard, SuperAdmin, Auth y Documentación. |
| **Bone** | `#f2f1ed` | `--color-bone` | Superficie de tarjetas (`Default Product Card`), barra lateral de navegación, paneles del Sandbox y contenedores de tablas. |
| **Linen** | `#e6e5e0` | `--color-linen` | Relleno de botones secundarios, pestañas seleccionadas, chips de metadatos y cabeceras de tablas densas. |
| **Stone** | `#cdcdc9` | `--color-stone` | Bordes capilares de `1px solid`, líneas divisoras de paneles y bordes de inputs en reposo. |
| **Mist** | `#a1a19f` | `--color-mist` | Texto de ayuda terciario, placeholders de formularios y marcas de agua de pasos inactivos. |
| **Driftwood** | `#84847e` | `--color-driftwood` | Texto secundario de párrafos, descripciones de tablas (`usage_ledger`, `audit_logs`) y subtítulos. |
| **Ash** | `#7a7974` | `--color-ash` | Relleno de iconos monolineales, etiquetas de formulario, símbolos de terminal (`$`, `>`) y metadatos técnicos. |
| **Ink** | `#26251e` | `--color-ink` | Texto primario, fondo del botón de acción principal (`Primary Filled Button`) y cursores activos. |
| **Ember** | `#f54e00` | `--color-ember` | Acento naranja brasa **exclusivo para enlaces de texto inline, etiquetas de estado activo y énfasis puntual** (jamás como fondo de botón primario ni superficie grande). |
| **Amber** | `#c08532` | `--color-amber` | Relleno de botones de acción técnica dentro del producto (`Iniciar Entrenamiento`, `Probar Evento en Sandbox`, `Rotar API Key`). |
| **Forest** | `#34785c` | `--color-forest` | Botón de confirmación estructural (`Publicar Mapa RAG SHA-256`, `Aprobar Override`, `Guardar System Prompt`). |
| **Verdant** | `#1f8a65` | `--color-verdant` | Acento de texto para estados verificados (`ACK_SUCCESS`, `WHM_VALID`, `SHA-256 VERIFIED`). |
| **Crimson** | `#cf2d56` | `--color-crimson` | Acento de texto y borde para acciones destructivas o alertas críticas (`SSRF_BLOCKED`, `Suspender Organización`, `Revocar Clave`). |

### 2.2. Configuración Lista para Producción (`dashboard-docs-cursor-atelier.css`)

```css
:root[data-portal="workspace-atelier"] {
  /* Colores Base */
  --color-parchment: #f7f7f4;
  --color-bone: #f2f1ed;
  --color-linen: #e6e5e0;
  --color-stone: #cdcdc9;
  --color-mist: #a1a19f;
  --color-driftwood: #84847e;
  --color-ash: #7a7974;
  --color-ink: #26251e;
  --color-ember: #f54e00;
  --color-amber: #c08532;
  --color-forest: #34785c;
  --color-verdant: #1f8a65;
  --color-crimson: #cf2d56;

  /* Superficies Semánticas */
  --surface-canvas: #f7f7f4;
  --surface-card: #f2f1ed;
  --surface-elevated: #e6e5e0;
  --surface-outline: #cdcdc9;
  --border-hairline: color-mix(in oklab, #26251e 8%, transparent);

  /* Familias Tipográficas */
  --font-cursorgothic: 'CursorGothic', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-eb-garamond: 'EB Garamond', 'Georgia', ui-serif, serif;
  --font-berkeleymono: 'berkeleyMono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-system-ui: system-ui, -apple-system, sans-serif;

  /* Escala Tipográfica (Titulares siempre en peso 400 con tracking progresivo) */
  --text-eyebrow: 12px;
  --leading-eyebrow: 1.63;
  --text-body-sm: 14px;
  --leading-body-sm: 1.5;
  --tracking-body-sm: 0.01em;
  --text-heading-sm: 22px;
  --leading-heading-sm: 1.3;
  --tracking-heading-sm: -0.005em;
  --text-heading: 26px;
  --leading-heading: 1.25;
  --tracking-heading: -0.012em;
  --text-heading-lg: 36px;
  --leading-heading-lg: 1.2;
  --tracking-heading-lg: -0.02em;
  --text-display: 72px;
  --leading-display: 1.1;
  --tracking-display: -0.03em;

  /* Espaciado Compacto (Base 4px) */
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-48: 48px;
  --spacing-64: 64px;

  /* Radios Estrictos */
  --radius-cards: 4px;
  --radius-tiles: 4px;
  --radius-inputs: 4px;
  --radius-buttons: 4px;
  --radius-modals: 8px;

  /* Sombras Cálidas (Solo para Marcos de Ventana, Visor Remoto y Popovers) */
  --shadow-xl: rgba(0, 0, 0, 0.14) 0px 28px 70px 0px, rgba(0, 0, 0, 0.1) 0px 14px 32px 0px, oklab(0.263084 -0.00230259 0.0124794 / 0.1) 0px 0px 0px 1px;
  --shadow-subtle: rgb(235, 234, 229) 0px 0px 0px 2px;
}

::selection {
  background-color: #8BC4F8;
  color: #26251e;
}
```

---

## 3. Reglas de Diseño por Módulo de la Plataforma

### 3.1. Landing Pública de Documentación & Sandbox (`/docs` y `/docs/sandbox`)

- **Layout de Documentación (`/docs`):**
  - Lienzo `#f7f7f4` (`max-width: 1300px` centrado, padding exterior `24px`).
  - Barra superior transparente de `52px` de altura con logo en `CursorGothic 14px weight 500`, enlaces centrales en `14px weight 400` y buscador `Cmd+K` en `berkeleyMono 12px`.
  - Los títulos de sección usan `CursorGothic 36px weight 400` (`tracking -0.02em`), las introducciones conceptuales usan `EB Garamond 17px` (`line-height 1.45`) y cada comando de instalación (`npm install @onboarding-assistant/sdk`) usa el componente **Terminal Input Field** (`#f2f1ed` Bone, borde `1px solid color-mix(in oklab, #26251e 10%, transparent)`, radio `4px`, padding `10px 12px`, fuente `berkeleyMono 12px`, prompt `$` en `#7a7974`).
- **Sandbox Interactivo de 3 Paneles (`/docs/sandbox`):**
  - Enmarcado dentro de un **Window Mockup Frame** (`#f2f1ed`, radio `4px`, borde `1px` + `--shadow-xl`, barra superior con 3 puntos grises macOS y pestañas de archivo en `berkeleyMono 12px`).
  - Los botones de disparo manual `"Probar click_element"` y `"Probar type_text"` usan el **Amber Action Button** (`background: #c08532`, texto `#f7f7f4`, radio `4px`, padding `6px 12px`).
  - La consola de salida de confirmaciones `tool.execution.ack` muestra las métricas de latencia con **Mono Metadata Tags** (`berkeleyMono 12px`, estado `SUCCESS` en `#1f8a65` Verdant).

### 3.2. Dashboard del Desarrollador (`/dashboard/org/:orgSlug/*`)

1. **Shell y Navegación Lateral:**
   - Sidebar fijo en `#f2f1ed` (Bone) separado del lienzo `#f7f7f4` (Parchment) únicamente por un borde capilar de `1px solid #cdcdc9` (cero sombras).
   - El ítem de navegación activo usa fondo `#e6e5e0` (Linen) con texto `#26251e` (Ink) y un indicador puntual en `#34785c` (Forest) o enlace en `#f54e00` (Ember).
2. **Gestor de API Keys (`pk_live_` / `sk_live_`):**
   - Cada fila de API Key se muestra sobre una tarjeta plana `#f2f1ed` con radio `4px` y borde `1px solid #cdcdc9`.
   - Los prefijos `pk_live_9f8a7b...` y los hashes `SHA-256` se muestran siempre en `berkeleyMono 12px` con números tabulares (`font-variant-numeric: tabular-nums`).
   - El botón `"Generar Nueva Clave"` usa el **Primary Filled Button** (`#26251e` Ink sobre texto `#f7f7f4`, radio `4px`), acompañado del botón secundario `"Rotar con Ventana de Gracia"` en **Secondary Filled Button** (`#e6e5e0` Linen con texto `#26251e`).
3. **Estudio del Prompt del Asistente (`/prompt-studio`):**
   - El editor del System Prompt se presenta como un **Window Mockup Frame** con pestañas en `berkeleyMono 12px` (`system-prompt.md`, `steps-schema.json`, `api-curl-snippet.sh`).
   - Las variables dinámicas (`{{user.name}}`) y las anclas a elementos del Mapa RAG (`@[Botón Crear Factura]`) se resaltan con texto `#f54e00` (Ember) sobre fondo sutil `color-mix(in oklab, #f54e00 8%, #f2f1ed)`.
   - El botón `"Publicar Versión del Prompt"` usa el **Forest Action Button** (`#34785c`, borde `1px solid #34785c`, radio `4px`, texto `#f7f7f4`).
4. **Visor del Navegador de Entrenamiento Remoto y Modal DOM (`/visual-trainer`):**
   - El contenedor del stream Chromium remoto utiliza el marco de ventana macOS en `#f2f1ed` con elevación cálida `--shadow-xl`.
   - El **Modal de Etiquetado DOM (`<ElementTaggingModal />`)** que se despliega al marcar una parte de la pantalla utiliza `border-radius: 8px`, fondo `#f7f7f4`, borde `1px solid #cdcdc9` y sombra `--shadow-xl-2`:
     - Inputs de `Título del elemento` y `Descripción funcional` con fondo `#f2f1ed`, borde `1px solid #cdcdc9` y radio `4px`.
     - Conmutadores de `¿Hacer acción? (Sí / No)` y `Click / Escritura (Type) / Ambos` construidos con botones segmentados de radio `4px` (`#26251e` activo vs `#e6e5e0` inactivo).
     - Previsualización de selectores (`[data-oa-id]`, ARIA role) y coordenadas responsive (`desktop_bbox`, `tablet_bbox`, `mobile_bbox`) en `berkeleyMono 12px`.
5. **Editor Dual del Mapa Funcional RAG (`/rag-map-editor`):**
   - Pantalla dividida 50/50 con divisor capilar `#cdcdc9`: a la izquierda las tarjetas visuales en `#f2f1ed` (`4px` radius, `24px` padding) y a la derecha el código JSON canónico en `berkeleyMono 12px`, mostrando en la barra superior el sello `SHA-256` en tiempo real.
6. **Panel de Facturación y Consumo Whop (`/billing`):**
   - Las tarjetas de los planes de `$5`, `$10`, `$30` y `$50 USD/mes` siguen la estructura de `Default Product Card` (`#f2f1ed`, radio `4px`, padding `24px`).
   - Las cifras monetarias y el libro mayor minuto a minuto (`usage_ledger`) activan obligatoriamente `font-feature-settings: "tnum"` para alineación vertical milimétrica de los decimales USD.

### 3.3. Dashboard de SuperAdmin (`/superadmin/*`)

- Utiliza exactamente la misma paleta cálida (`Parchment` / `Bone` / `Ink`) con densidad compacta (`--element-gap: 8px`, `--card-padding: 20px-24px`) para maximizar la legibilidad de tablas de alta densidad (organizaciones, matriz de precios Whop, overrides manuales y monitor de sesiones de voz concurrentes).
- Las alertas de seguridad del escudo Anti-SSRF (`169.254.169.254` bloqueado) y los botones de suspensión de cuenta o *Kill-Switch* de proveedor IA se señalizan con `--color-crimson` (`#cf2d56`) en texto/borde de `1px`, manteniendo la sobriedad instrumental sin fondos rojos estridentes.

---

## 4. Reglas Inquebrantables de Consistencia (Do's & Don'ts)

- **SÍ:** Usa `4px` de `border-radius` en todos los botones, tarjetas, inputs y bloques de código (`8px` solo en modales).
- **SÍ:** Mantén todos los encabezados en `CursorGothic` peso `400` con `letter-spacing` negativo según la escala.
- **SÍ:** Combina siempre un botón primario oscuro (`#26251e` Ink) con un botón secundario claro (`#e6e5e0` Linen) o un botón ghost; nunca apiles dos botones oscuros juntos.
- **NO:** Nunca uses blanco puro (`#ffffff`) ni negro puro (`#000000`) en ningún componente del Dashboard, CRM, Auth o Documentación.
- **NO:** Nunca uses gradientes, brillos (`glows`), fondos difuminados tipo cristal frío (`backdrop-filter` azulado) ni bordes redondeados tipo píldora (`9999px`) en estos paneles.
- **NO:** Nunca uses el color `#f54e00` (Ember) como relleno de fondo de un botón o tarjeta; es exclusivamente un acento tipográfico e inline.
