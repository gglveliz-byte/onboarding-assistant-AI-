# PLAN MAESTRO DE CONSTRUCCIÓN DEL FRONTEND — DIVISIÓN 3 DE 4: IA #3 (DASHBOARD DEL DESARROLLADOR, API KEYS, VISOR DE ENTRENAMIENTO REMOTO, MAPA RAG Y ESTUDIO DEL PROMPT — PARTES 9 A 12)

Este documento define la hoja de ruta exacta para la **IA #3 (Cerebro Orquestador: Dashboard del Desarrollador, API Keys, Visor de Entrenamiento con Overlay DOM, Editor Dual RAG SHA-256 y Estudio del Prompt)** dentro de la arquitectura de construcción simultánea con **4 IAs Cabezas (`T = 0`)**, donde cada cabeza actúa como cerebro coordinador que registra el estado en el Ledger y despliega **9 Subagentes Especializados** (para un total de **36 Subagentes en el sistema global**), invocando el sistema de diseño **Cursor Light (Warm Parchment Atelier)** y conectándose contra el **Backend Hexagonal ya construido**.

---

## 1. Arquitectura de Ejecución Simultánea para las 4 IAs Cabezas (Fronteras Físicas de Directorio)

Dado que el **Backend está 100% construido y sellado** en `src/modules/*` con contratos de proyectos, claves criptográficas, entrenamiento efímero y RAG vectorial, las 4 IAs Cabezas arrancan en simultáneo sin bloquearse gracias al particionamiento físico estricto de directorios:

| IA Cabeza (Cerebro) | Dominio Asignado | Partes | Subagentes | Directorios Exclusivos de Escritura (Prohibido a otras IAs) | Skills Obligatorias del Escuadrón |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **IA #1** *(Doc 1)* | Cimientos HTTP/WS + Landing Pública Comercial (`/`) | **1 a 4** | **1.1 al 1.9** (9 Subagentes) | `apps/web/src/lib/api-client/`, `apps/web/src/styles/landing-auros-light.css`, `apps/web/src/app/(commercial)/`, `apps/web/src/components/landing/` | `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #2** *(Doc 2)* | Auth B2B/SSO/FIDO2, Legal DPA, Docs (`/docs`), Sandbox y SDK | **5 a 8** | **2.1 al 2.9** (9 Subagentes) | `apps/web/src/styles/dashboard-docs-cursor-atelier.css`, `apps/web/src/components/atelier-primitives/`, `apps/web/src/app/(auth)/`, `apps/web/src/app/legal/`, `apps/web/src/app/docs/`, `packages/sdk/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `import-guardian` |
| **IA #3** *(Este Doc)* | Dashboard Dev: Proyectos, API Keys, Visor Trainer Overlay, RAG SHA-256 y Prompt Studio | **9 a 12** | **3.1 al 3.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/` (excepto `billing`), `apps/web/src/components/dashboard-dev/`, `visual-trainer/`, `rag-editor/`, `prompt-studio/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #4** *(Doc 4)* | Facturación Whop (`/billing`), Consola SuperAdmin, Telemetría SSE y Ensamblaje E2E | **13 a 16** | **4.1 al 4.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/billing/`, `apps/web/src/app/superadmin/`, `apps/web/src/components/billing-whop/`, `apps/web/src/components/superadmin/`, `tests/e2e-frontend/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `pruebas-verificacion-integracion` |

---

## 2. Protocolo del Cerebro Orquestador IA #3 y sus 9 Subagentes Especializados

### 2.1. El Rol del Cerebro Orquestador (IA #3)
La **IA Cabeza #3** actúa como el cerebro coordinador de su carril:
1. **Registro Previo en el Ledger:** Antes de iniciar cualquier trabajo, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` sus directorios reservados bajo el estado `EN_CONSTRUCCION_IA3`.
2. **Despliegue Coordinado de los 9 Subagentes:** Asigna a cada uno de sus 9 subagentes una misión quirúrgica de 2 a 3 archivos (máximo 300 líneas por archivo, nunca superando las 500 líneas físicas).
3. **Independencia en Enlaces Cruzados:** En el sidebar del Dashboard (`<DeveloperDashboardShell />`), la IA #3 incluye el enlace de navegación hacia `/dashboard/org/${orgSlug}/billing` sin escribir en la carpeta `billing/` (que pertenece a la IA #4).
4. **Supervisión de Auditoría y Entrega:** Recibe el reporte del **Subagente 3.9** (auditoría `wc -l < 500` y `tsc --noEmit`), actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` a `COMPLETADO` y notifica a las demás IAs en el buzón.

### 2.2. Regla de Convivencia y No Intromisión Físico-Lógica
* **Cero Modificaciones Ajenas:** Si la IA #3 o sus subagentes observan archivos en `(commercial)/`, `(auth)/`, `billing/` o `superadmin/`, **no los tocan bajo ninguna circunstancia**.
* **Buzón Inter-IA:** Cualquier caso dependiente de otra IA se documenta en el `Buzón de Notificaciones y Dependencias Inter-IA` de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

---

## 3. Asignación Exhaustiva de los 9 Subagentes de la IA #3

```
IA #3 (CEREBRO)
├── Subagente 3.1: Shell del Dashboard, Sidebar, Org/Project Switchers & Equipo GDPR
├── Subagente 3.2: Hook de Proyectos/Dominios & Gestor de Dominios CORS
├── Subagente 3.3: Tabla de API Keys (pk_live_/sk_live_), Reveal SHA-256 & Rotación
├── Subagente 3.4: Hook Sesión Chromium Efímero, Anti-SSRF Guard & DataChannel
├── Subagente 3.5: Barra de Instrumentación, Switcher Responsive & Lienzo Overlay DOM
├── Subagente 3.6: Modal de Etiquetado DOM (ElementTaggingModal) & Página Trainer
├── Subagente 3.7: Editor Dual RAG: Visual Árbol/Tarjetas + JSON RFC 8785 + SHA-256
├── Subagente 3.8: Hook Prompt Studio, Barra de Modelos & Editor con Guardrails
└── Subagente 3.9: Páginas RAG/Prompt, Auditoría Estricta <500 Líneas & Cierre Ledger
```

---

### SUBAGENTE 3.1 — Shell del Dashboard, Sidebar, Org/Project Switchers & Equipo GDPR
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/identity.manifest.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/dashboard-dev/DeveloperDashboardShell.tsx` (`~260 líneas`):
     - Sidebar fijo en `#f2f1ed` (Bone) separado del lienzo `#f7f7f4` (Parchment) por borde capilar de `1px solid #cdcdc9` (cero sombras).
     - Barra superior con `<OrganizationSwitcher />`, `<ProjectSwitcher />`, `<EnvironmentModeBadge />` (`LIVE` vs `TEST`) y `<RealtimeBalancePill />` (minutos restantes en `berkeleyMono 12px tabular-nums` con alerta al 85%).
  2. `apps/web/src/app/dashboard/org/[orgSlug]/team/page.tsx` (`~240 líneas`):
     - Gestión de miembros de la organización (`OWNER`, `DEVELOPER`, `BILLING`, `VIEWER`), invitación por correo, reseteo sudo de MFA de miembros (`btn_reset_member_mfa`) y controles GDPR (`btn_export_org_data` y `btn_delete_organization`).

---

### SUBAGENTE 3.2 — Hook de Proyectos/Dominios & Gestor de Dominios CORS
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/02-projects-and-keys/application/manage-projects-and-domains.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/dashboard-dev/useProjectsAndApiKeys.ts` (`~250 líneas`):
     - Hooks tipados para crear/cambiar proyectos, gestionar `allowed_domains` (`POST/DELETE /api/v1/projects/:id/domains`), crear claves públicas `pk_live_` y secretas `sk_live_` (`POST /api/v1/projects/:id/api-keys`), rotar claves con ventana de gracia (`0h`, `1h`, `24h`, `72h`) y revocar (`DELETE /api/v1/projects/:id/api-keys/:keyId`).
  2. `apps/web/src/components/dashboard-dev/AllowedDomainsManager.tsx` (`~220 líneas`):
     - Gestor de orígenes autorizados para el Handshake del SDK (`https://app.micrm.com`, bloqueo visual y de cliente de `http://localhost` cuando el proyecto está en modo `LIVE`, y verificador DNS opcional).

---

### SUBAGENTE 3.3 — Tabla de API Keys (pk_live_/sk_live_), Reveal SHA-256 & Rotación
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/02-projects-and-keys/application/api-key-lifecycle.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/dashboard-dev/ApiKeyLifecycleManager.tsx` (`~270 líneas`):
     - Tabla en `#f2f1ed` (`4px` radius) que muestra `key_prefix` (`sk_live_9f8a7b...`), `last_four`, alcances (`scopes[]`), estado de gracia y último uso en `berkeleyMono 12px`.
     - `<CreateApiKeyModal />`, `<OneTimeSecretRevealDialog />` (que muestra la clave completa una sola vez advirtiendo que solo se almacena su `SHA-256`) y `<RotateApiKeyModal />`.
  2. `apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/keys/page.tsx` (`~220 líneas`):
     - Ensambla la vista de Dominios y API Keys aplicando control de permisos RBAC (`apikeys:create_rotate_revoke` deshabilitado para rol `VIEWER` o `BILLING`).

---

### SUBAGENTE 3.4 — Hook Sesión Chromium Efímero, Anti-SSRF Guard & DataChannel
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/03-visual-trainer-and-rag/application/training-session.use-case.ts`, `src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-injected-agent.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/visual-trainer/useRemoteTrainerSession.ts` (`~310 líneas`):
     - Inicia sesión en `POST /api/v1/projects/:id/training-sessions` enviando `{ target_url }` o enlaza una sesión iniciada desde el túnel del CLI (`npx @onboarding-assistant/cli train`).
     - Maneja explícitamente el rechazo `HTTP 403 SSRF_BLOCKED_IP_RANGE` si el desarrollador introduce una IP privada o de metadatos cloud (`169.254.169.254`, `127.0.0.1`, RFC 1918), mostrando alerta en `#cf2d56` (Crimson).
     - Envía las coordenadas del puntero `(clientX, clientY)` por WebSocket/DataChannel al contenedor Chromium efímero y recibe en `<8ms` la geometría del elemento bajo el cursor, su cascada de selectores y su `selector_stability_score` (`0-100`).

---

### SUBAGENTE 3.5 — Barra de Instrumentación, Switcher Responsive & Lienzo Overlay DOM
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/visual-trainer/TrainerToolbarAndViewportSwitcher.tsx` (`~280 líneas`):
     - Barra superior dentro del `<WindowMockupFrame />` con barra de URL remota, conmutador entre **Modo Navegación (`NAVIGATION_MODE`)** y **Modo Captura con Puntero Overlay (`CAPTURE_OVERLAY_MODE`)**, botones de resolución en vivo (`Desktop 1440x900`, `Tablet 768x1024`, `Mobile 390x844`) y toggle `toggle_auto_responsive_recalculation`.
  2. `apps/web/src/components/visual-trainer/InteractiveDomOverlayCanvas.tsx` (`~310 líneas`):
     - Lienzo interactivo (cero screenshots ciegos) que renderiza el stream del navegador remoto y superpone en tiempo real la caja vectorial de inspección sobre cada nodo DOM al pasar el puntero, mostrando `<button data-oa-id="..."> · Estabilidad: 99/100` en `berkeleyMono 12px` y bloqueando visualmente campos sensibles (`type="password"`, tarjetas `cc-*`).

---

### SUBAGENTE 3.6 — Modal de Etiquetado DOM (ElementTaggingModal) & Página Trainer
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/visual-trainer/ElementTaggingModal.tsx` (`~330 líneas`):
     - Modal flotante (`border-radius: 8px`, fondo `#f7f7f4`, borde `1px solid #cdcdc9`, sombra `--shadow-xl`) con los 4 campos requeridos:
       * **Campo 1 (`input_element_title`):** Título del elemento.
       * **Campo 2 (`textarea_functional_description`):** Descripción funcional semántica para el RAG.
       * **Campo 3 (`radio_is_actionable`):** Conmutador segmentado `¿Hacer acción? (Sí / No)`.
       * **Campo 4 (`select_action_type`):** Habilitado cuando `is_actionable === true` (`CLICK`, `TYPE`, `BOTH`).
       * **Sub-panel Técnico:** Cascada de selectores (`primary_selector`, `accessibility_selector`, `structural_css_selector`, `xpath_fallback`), coordenadas responsive (`desktop_bbox`, `tablet_bbox`, `mobile_bbox`), botón de test highlight y `<AtelierForestConfirmButton />` (`"Guardar en Mapa RAG"`).
  2. `apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/visual-trainer/page.tsx` (`~290 líneas`):
     - Ensambla el `<RemoteVisualTrainerWorkspace />` completo con lista lateral de elementos capturados en la sesión.

---

### SUBAGENTE 3.7 — Editor Dual RAG: Visual Árbol/Tarjetas + JSON RFC 8785 + SHA-256
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/03-visual-trainer-and-rag/application/publish-and-edit-rag-map.use-case.ts`, `src/shared/kernel/crypto.util.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/rag-editor/useFunctionalMapDualEditor.ts` (`~290 líneas`):
     - Mantiene sincronizados en tiempo real el árbol de elementos en memoria y el documento JSON completo.
     - Valida esquema (detecta IDs duplicados o inconsistencias de acción) y calcula en tiempo real en cliente el hash `SHA-256` bajo RFC 8785 (`crypto.subtle.digest('SHA-256', ...)`), gestionando `POST /api/v1/projects/:id/maps/publish` y el rollback instantáneo (`POST /api/v1/projects/:id/maps/:versionId/rollback`).
  2. `apps/web/src/components/rag-editor/VisualMapTreeAndCardEditor.tsx` (`~300 líneas`):
     - **Panel Izquierdo (50%):** agrupa los elementos por `url_route_pattern`, permite editar en línea título, descripción, tipo de acción y coordenadas responsive, o pulsar `btn_reopen_in_visual_trainer(elementId)`.
  3. `apps/web/src/components/rag-editor/CanonicalJsonCodeEditor.tsx` (`~280 líneas`):
     - **Panel Derecho (50%):** editor de código JSON en `berkeleyMono 12px` dentro de un marco `#f2f1ed` con numeración de líneas tabular, resaltado de errores semánticos y formateador RFC 8785.

---

### SUBAGENTE 3.8 — Hook Prompt Studio, Barra de Modelos & Editor con Guardrails
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/03-visual-trainer-and-rag/application/prompt-studio-and-slimming.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/prompt-studio/useAssistantPromptStudio.ts` (`~270 líneas`):
     - Sincroniza la configuración del proyecto (`primary_voice_model`, `fallback_voice_model`, `speech_speed`, `vad_barge_in_sensitivity`, `model_temperature`, `system_prompt`, `onboarding_steps_json`) contra `PUT /api/v1/projects/:id/prompt`.
     - Extrae y vincula menciones del Mapa RAG (`@[Botón Crear Factura](uuid)`) con cada paso ordenado (`Step 1` ➔ `Step 2` ➔ `Step 3`).
  2. `apps/web/src/components/prompt-studio/ModelAndVoiceConfigBar.tsx` (`~250 líneas`):
     - Controles en `#f2f1ed` (`4px` radius) para elegir motor (`Gemini 3.8 Live` vs `Qwen3.8-Omni`), velocidad vocal (`0.8x-1.25x`), sensibilidad de Barge-in y temperatura (`0.0-1.0`).
  3. `apps/web/src/components/prompt-studio/UnifiedSystemPromptEditor.tsx` (`~290 líneas`):
     - Editor enmarcado en `<WindowMockupFrame />` con pestañas en `berkeleyMono 12px` (`system-prompt.md`, `steps-schema.json`, `api-curl-snippet.sh`), autocompletado de variables y anclas RAG resaltadas en `#f54e00` (Ember).
  4. `apps/web/src/components/prompt-studio/StepByStepFlowExtractorAndGuardrails.tsx` (`~270 líneas`):
     - Constructor visual de la secuencia de pasos, condición de completitud por paso (`element_clicked`, `input_filled`, `route_reached`) y guardrails (`strict_step_enforcement` y `ask_confirmation_before_submit`).

---

### SUBAGENTE 3.9 — Páginas RAG/Prompt, Auditoría Estricta <500 Líneas & Cierre Ledger
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`.
* **Archivos Asignados a Crear / Modificar:**
  1. `apps/web/src/components/rag-editor/MapVersionHistoryAndShaBar.tsx` (`~260 líneas`):
     - Barra superior con digest `content_sha256_hash` en `berkeleyMono 12px` (etiqueta `SHA-256 VERIFIED` en `#1f8a65` Verdant), selector de versiones con diff visual y rollback.
  2. `apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/rag-map-editor/page.tsx` (`~260 líneas`): Ensambla la vista 50/50 `<FunctionalMapDualEditor />`.
  3. `apps/web/src/app/dashboard/org/[orgSlug]/projects/[projectId]/prompt-studio/page.tsx` (`~260 líneas`): Ensambla el `<AssistantPromptStudio />` con panel de sincronización API REST (`PUT /api/v1/projects/:id/prompt` con `sk_live_...`).
  4. **Auditoría Técnica Automática:** Ejecuta `node scripts/check-file-lines.mjs` certificando `< 500 líneas` en todos los archivos de la División 3 y corre `npx tsc --noEmit`.
  5. **Cierre y Notificación en Ledger:** Actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` registrando la División 3 como `LISTO_PARA_CONSUMO`.

---

## 4. Prompt Maestro de Activación para la IA #3 (`Copy & Paste`)

```markdown
Actúa como la **IA #3 (Cerebro Orquestador: Dashboard del Desarrollador, Proyectos, API Keys, Visor Trainer, Mapa RAG y Prompt Studio)** ejecutando las **Partes 9, 10, 11 y 12** del documento `13_PLAN_MAESTRO_FRONTEND_IA3_DASHBOARD_DEV_TRAINER_RAG_Y_PROMPT.md`.

REGLAS DE ORQUESTACIÓN CON 9 SUBAGENTES:
1. Actúas como el Cerebro Orquestador: Antes de escribir código, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` que la División 3 entra en construcción.
2. Despliega y coordina de forma organizada a tus **9 Subagentes Especializados (3.1 al 3.9)** siguiendo la división exacta de archivos y misiones de este plan:
   - Subagente 3.1: Shell del Dashboard, Sidebar, Org/Project Switchers y Gestión de Equipo/GDPR.
   - Subagente 3.2: Hook de Proyectos/Dominios y Gestor de Dominios CORS (`AllowedDomainsManager.tsx`).
   - Subagente 3.3: Tabla de API Keys (`pk_live_`/`sk_live_`), Reveal SHA-256 y Rotación con Gracia.
   - Subagente 3.4: Hook de Sesión Chromium Efímero, Anti-SSRF Guard y DataChannel de baja latencia.
   - Subagente 3.5: Barra de Instrumentación, Switcher Responsive y Lienzo Overlay DOM interactivo.
   - Subagente 3.6: Modal de Etiquetado DOM (`ElementTaggingModal.tsx`) y Ensamblaje `/visual-trainer`.
   - Subagente 3.7: Editor Dual RAG: Visual Árbol/Tarjetas + JSON RFC 8785 + Hashing SHA-256 en cliente.
   - Subagente 3.8: Hook Prompt Studio, Barra de Modelos de Voz y Editor Unificado con Guardrails.
   - Subagente 3.9: Barra SHA-256, Páginas `/rag-map-editor` y `/prompt-studio`, Auditoría estricta `wc -l < 500`, validación `tsc` y reporte de cierre en Ledger.
3. Aplica obligatoriamente las skills `estilo-paneles-y-docs-cursor-atelier` y `reglas-globales-construccion-codigo`: Superficies cálidas `#f7f7f4`, tarjetas `#f2f1ed`, radios `4px` (y `8px` solo en modales), tipografía CursorGothic/berkeleyMono con números tabulares y cabecera en español en la línea 1.
4. Escribe únicamente dentro de tus directorios asignados (`apps/web/src/app/dashboard/org/[orgSlug]/` excepto `billing/`, y tus carpetas de componentes `dashboard-dev/`, `visual-trainer/`, `rag-editor/` y `prompt-studio/`). Si necesitas que la IA #4 enlace la facturación o la IA #2 enlace la autenticación, regístralo en el "Buzón de Notificaciones y Dependencias Inter-IA" de `docs/LIVE_ARCHITECTURE_LEDGER.md`.
```
