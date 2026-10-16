# PLAN MAESTRO DE CONSTRUCCIÓN DEL FRONTEND — DIVISIÓN 2 DE 4: IA #2 (IDENTIDAD B2B/SSO/FIDO2, LEGAL/DPA, DOCUMENTACIÓN, SANDBOX Y SDK — PARTES 5 A 8)

Este documento define la hoja de ruta exacta para la **IA #2 (Cerebro Orquestador: Identidad B2B, Cumplimiento Legal, Portal de Docs, Sandbox Interactivo y SDK)** dentro de la arquitectura de construcción simultánea con **4 IAs Cabezas (`T = 0`)**, donde cada cabeza actúa como cerebro coordinador que registra el estado en el Ledger y despliega **9 Subagentes Especializados** (para un total de **36 Subagentes en el sistema global**), invocando el sistema de diseño **Cursor Light (Warm Parchment Atelier)** y conectándose contra el **Backend Hexagonal ya construido**.

---

## 1. Arquitectura de Ejecución Simultánea para las 4 IAs Cabezas (Fronteras Físicas de Directorio)

Dado que el **Backend está 100% construido y sellado** en `src/modules/*` con contratos de identidad, legal, handshake SDK y WebSockets de voz, las 4 IAs Cabezas arrancan en simultáneo sin bloquearse gracias al particionamiento físico estricto de directorios:

| IA Cabeza (Cerebro) | Dominio Asignado | Partes | Subagentes | Directorios Exclusivos de Escritura (Prohibido a otras IAs) | Skills Obligatorias del Escuadrón |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **IA #1** *(Doc 1)* | Cimientos HTTP/WS + Landing Pública Comercial (`/`) | **1 a 4** | **1.1 al 1.9** (9 Subagentes) | `apps/web/src/lib/api-client/`, `apps/web/src/styles/landing-auros-light.css`, `apps/web/src/app/(commercial)/`, `apps/web/src/components/landing/` | `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #2** *(Este Doc)* | Auth B2B/SSO/FIDO2, Legal DPA, Docs (`/docs`), Sandbox y SDK | **5 a 8** | **2.1 al 2.9** (9 Subagentes) | `apps/web/src/styles/dashboard-docs-cursor-atelier.css`, `apps/web/src/components/atelier-primitives/`, `apps/web/src/app/(auth)/`, `apps/web/src/app/legal/`, `apps/web/src/app/docs/`, `apps/web/src/components/auth-legal/`, `apps/web/src/components/docs-sandbox/`, `packages/sdk/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `import-guardian` |
| **IA #3** *(Doc 3)* | Dashboard Dev: Proyectos, API Keys, Visor Trainer Overlay, RAG SHA-256 y Prompt Studio | **9 a 12** | **3.1 al 3.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/` (excepto `billing`), `apps/web/src/components/dashboard-dev/`, `visual-trainer/`, `rag-editor/`, `prompt-studio/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #4** *(Doc 4)* | Facturación Whop (`/billing`), Consola SuperAdmin, Telemetría SSE y Ensamblaje E2E | **13 a 16** | **4.1 al 4.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/billing/`, `apps/web/src/app/superadmin/`, `apps/web/src/components/billing-whop/`, `apps/web/src/components/superadmin/`, `tests/e2e-frontend/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `pruebas-verificacion-integracion` |

---

## 2. Protocolo del Cerebro Orquestador IA #2 y sus 9 Subagentes Especializados

### 2.1. El Rol del Cerebro Orquestador (IA #2)
La **IA Cabeza #2** actúa como el cerebro coordinador de su carril:
1. **Registro Previo en el Ledger:** Antes de iniciar cualquier trabajo, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` sus directorios reservados bajo el estado `EN_CONSTRUCCION_IA2`.
2. **Despliegue Coordinado de los 9 Subagentes:** Asigna a cada uno de sus 9 subagentes una misión quirúrgica de 2 a 3 archivos (máximo 300 líneas por archivo, nunca superando las 500 líneas físicas).
3. **Publicación Temprana de Primitivas Atelier:** Una vez que el **Subagente 2.1** finaliza los tokens CSS y `<AtelierUiPrimitives.tsx>`, el cerebro publica inmediatamente en el Ledger `PRIMITIVAS_ATELIER_LISTAS` para que las IAs #3 y #4 puedan reutilizar los componentes compartidos.
4. **Protección de Archivos Preexistentes en SDK:** Para el **Subagente 2.8**, el cerebro impone la skill `import-guardian` para asegurar que el código base ya construido en `packages/sdk/src/` (Módulo 15 del Backend) sea **extendido y preservado**, nunca sobreescrito a ciegas.
5. **Supervisión de Auditoría y Entrega:** Recibe el reporte del **Subagente 2.9** (auditoría `wc -l < 500` y `tsc --noEmit`), actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` a `COMPLETADO` y notifica en el buzón inter-IA.

### 2.2. Regla de Convivencia y No Intromisión Físico-Lógica
* **Cero Modificaciones Ajenas:** Si la IA #2 o sus subagentes observan archivos en `(commercial)/`, `dashboard/` o `superadmin/`, **no los tocan bajo ninguna circunstancia**.
* **Buzón Inter-IA:** Cualquier caso dependiente de otra IA se documenta en el `Buzón de Notificaciones y Dependencias Inter-IA` de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

---

## 3. Asignación Exhaustiva de los 9 Subagentes de la IA #2

```
IA #2 (CEREBRO)
├── Subagente 2.1: Tokens CSS Cursor Atelier & Primitivas UI Compartidas
├── Subagente 2.2: Contexto de Sesión en Memoria RAM & Wizard Registro Multi-Paso
├── Subagente 2.3: Login B2B (Descubrimiento SSO), CLI Device & SuperAdmin FIDO2
├── Subagente 2.4: Retos MFA (TOTP/Passkeys), Recovery & Break-Glass Owner
├── Subagente 2.5: Modal Bloqueante Re-Consentimiento ToS/DPA & Visor Legal
├── Subagente 2.6: Shell de Documentación '/docs' & Referencia Interactiva SDK
├── Subagente 2.7: Sandbox Paneles Izquierdo y Central (Inspector WS + Lienzo DOM)
├── Subagente 2.8: Sandbox Panel Derecho & Extensión del SDK (@onboarding-assistant/sdk)
└── Subagente 2.9: Ensamblador del SDK, Auditoría Estricta <500 Líneas & Cierre Ledger
```

---

### SUBAGENTE 2.1 — Tokens CSS Cursor Atelier & Primitivas UI Compartidas
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/styles/dashboard-docs-cursor-atelier.css` (`~220 líneas`):
     - Superficies Cursor Atelier: `--color-parchment: #f7f7f4`, `--color-bone: #f2f1ed`, `--color-linen: #e6e5e0`, `--color-stone: #cdcdc9`.
     - Tintas y estados: `--color-ink: #26251e`, `--color-ember: #f54e00`, `--color-amber: #c08532`, `--color-forest: #34785c`, `--color-crimson: #cf2d56`.
     - Trío tipográfico: `CursorGothic 400`, `EB Garamond` y `berkeleyMono 12px` con `font-feature-settings: "tnum"`.
     - Radios estrictos: `4px` en botones/tarjetas y `8px` únicamente en modales. Sombra `--shadow-xl`.
  2. `apps/web/src/components/atelier-primitives/AtelierUiPrimitives.tsx` (`~260 líneas`):
     - Primitivas técnicas para toda la plataforma: `<AtelierPrimaryButton />`, `<AtelierSecondaryButton />`, `<AtelierAmberActionButton />`, `<AtelierForestConfirmButton />`, `<AtelierCrimsonDangerButton />`.
     - `<WindowMockupFrame />` (Marco macOS en `#f2f1ed` con 3 botones de control, pestañas mono y `--shadow-xl`), `<TerminalCommandBox />` y `<MonoMetadataTag />`.

---

### SUBAGENTE 2.2 — Contexto de Sesión en Memoria RAM & Wizard Registro Multi-Paso
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/identity.manifest.ts`, `src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/auth-legal/useAuthSessionContext.tsx` (`~250 líneas`):
     - Proveedor React que almacena el `access_token` JWT EdDSA en memoria volátil.
     - Ejecuta rotación silenciosa contra `POST /api/v1/auth/refresh` 60 segundos antes de expirar.
     - Soporta logout global instantáneo (`POST /api/v1/auth/logout-all`) y chequeo de permisos RBAC `hasPermission(permCode)`.
  2. `apps/web/src/app/(auth)/auth/register/page.tsx` (`~260 líneas`):
     - Componente `<OrganizationSignUpWizard />` de 4 pasos:
       * `STEP_1`: Credenciales con medidor de entropía de 70 bits y verificación de slug (`GET /api/v1/auth/check-slug`).
       * `STEP_2`: Checkboxes obligatorios independientes de `TOS_B2B`, `PRIVACY_POLICY`, `DPA_ENTERPRISE` y `AI_VOICE_AUP`.
       * `STEP_3`: Verificación de email con OTP de 6 dígitos (`POST /api/v1/auth/verify-email/confirm`).
       * `STEP_4`: Encadenamiento automático hacia el Checkout de Whop si viene con `?plan=PLAN_50` desde la Landing.

---

### SUBAGENTE 2.3 — Login B2B (Descubrimiento SSO), CLI Device & SuperAdmin FIDO2
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/application/sso-saml-and-cli-device.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/app/(auth)/auth/login/page.tsx` (`~240 líneas`):
     - `<B2BAuthenticationBoundary />` con `<DomainDiscoveryEmailInput />` (ejecuta `POST /api/v1/auth/discover-tenant` en `onBlur` y conmuta a SSO SAML 2.0 si `sso_enforced === true`).
     - Manejo de cuenta bloqueada (`HTTP 423 Locked` con cuenta regresiva `Retry-After`) y flujo de autorización CLI (`/auth/cli-device` con código `XXXX-XXXX`).
  2. `apps/web/src/app/(auth)/internal/superadmin-login/page.tsx` (`~220 líneas`):
     - Acceso aislado para SuperAdmin que exige contraseña Argon2id + **autenticación física Passkey FIDO2 / WebAuthn** (`navigator.credentials.get()`) para emitir sesión máxima de 4 horas.

---

### SUBAGENTE 2.4 — Retos MFA (TOTP/Passkeys), Recuperación Anti-Enumeración & Break-Glass
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/application/mfa-and-webauthn.use-case.ts`, `src/modules/01-identity-and-rbac/application/password-reset-and-invites.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/auth-legal/MfaChallengeAndEnrollmentModal.tsx` (`~290 líneas`):
     - Modal de radio `8px` (`#f7f7f4` sobre `--shadow-xl`) que resuelve el estado `HTTP 202 Accepted (mfa_required)` permitiendo autenticar con TOTP de 6 dígitos, WebAuthn FIDO2 o un código de recuperación `XXXX-XXXX-XXXX`, más asistente de enrolamiento.
  2. `apps/web/src/app/(auth)/auth/recovery/page.tsx` (`~270 líneas`):
     - Vistas unificadas para `<ForgotPasswordView />` (`POST /api/v1/auth/password/forgot`), `<ResetPasswordConfirmView />` e `<OrganizationInviteAcceptor />`.
  3. `apps/web/src/app/(auth)/auth/owner-emergency-recovery/page.tsx` (`~260 líneas`):
     - Asistente de recuperación **Break-Glass** para `Owner` único: OTP de correo + verificación DNS TXT o recibo de Whop + período de enfriamiento de 24h (`COOLING_OFF_24H`).

---

### SUBAGENTE 2.5 — Modal Bloqueante Re-Consentimiento ToS/DPA & Visor Legal
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/application/legal-privacy-compliance.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/auth-legal/MandatoryLegalReconsentModal.tsx` (`~270 líneas`):
     - Modal bloqueante que intercepta `HTTP 403 LEGAL_CONSENT_OUTDATED` o `403 DPA_NOT_SIGNED`. Muestra el documento en Markdown con su hash `SHA-256` en `berkeleyMono 12px` y firma electrónicamente en `POST /api/v1/legal/accept`.
  2. `apps/web/src/app/legal/[docSlug]/page.tsx` (`~270 líneas`):
     - Visor público editorial con subtítulos en `EB Garamond` para consultar versiones vigentes de `TOS_B2B`, `PRIVACY_POLICY`, `DPA_ENTERPRISE`, `AI_VOICE_AUP` y `END_USER_VOICE_CONSENT`.

---

### SUBAGENTE 2.6 — Shell de Documentación '/docs' & Referencia Interactiva SDK
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/07-public-commercial-and-sandbox/public-commercial.manifest.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/docs-sandbox/DeveloperDocsShell.tsx` (`~280 líneas`):
     - Layout en `#f7f7f4` (`max-width: 1300px`), barra superior de `52px`, árbol lateral en `#f2f1ed` Bone, buscador semántico `Cmd+K` y selector de framework (`React / Next.js`, `Vue 3`, `Angular`, `Vanilla JS`).
  2. `apps/web/src/app/docs/page.tsx` (`~290 líneas`):
     - Guías de instalación (`npm install @onboarding-assistant/sdk`), inicialización del proveedor, guía de selectores inmutables `data-oa-id`, uso del CLI y sincronización del System Prompt vía API REST (`PUT /api/v1/projects/:id/prompt`).

---

### SUBAGENTE 2.7 — Sandbox Paneles Izquierdo y Central (Inspector WS + Lienzo DOM)
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/docs-sandbox/ApiAndProtocolSpecViewer.tsx` (`~290 líneas`):
     - **Panel Izquierdo:** Inspector interactivo de tramas WebSocket (`session.init`, `audio.input.pcm16`, `route.changed`, `tool.execute`, `tool.execution.ack`, `voice.barge_in`).
  2. `apps/web/src/components/docs-sandbox/SandboxTargetApplicationCanvas.tsx` (`~310 líneas`):
     - **Panel Central:** Aplicación de prueba con inputs controlados, selectores, modales, campo `input[type="password"]` para comprobar el bloqueo `ACTION_BLOCKED_SENSITIVE_FIELD`, y conmutador de viewport (`Desktop 1440x900`, `Tablet 768x1024`, `Mobile 390x844`).

---

### SUBAGENTE 2.8 — Sandbox Panel Derecho & Extensión del SDK (@onboarding-assistant/sdk)
* **Skills Obligatorias:** `import-guardian`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `packages/sdk/src/core/sdk-client.ts`, `packages/sdk/src/dom/action-executor.ts`.
* **Archivos Asignados a Crear / Extender:**
  1. `apps/web/src/app/docs/sandbox/page.tsx` (`~310 líneas`):
     - Ensambla el Sandbox de 3 paneles dentro de `<WindowMockupFrame />` con el **Panel Derecho (`<SandboxToolDispatcher />`)**: botones para probar `click_element` y `type_text`, selector de cadencia humana (`45ms`) y consola de respuesta con latencia.
  2. `packages/sdk/src/audio/pcm16-worklet-and-vad.ts` (`~300 líneas`):
     - `AudioWorkletProcessor` para captura a `16kHz PCM16` en tramas de `20ms` (`640 bytes`, prefijo `0x01`) y VAD local que ante voz del usuario vacía la cola en `<5ms` y emite `voice.barge_in`.
  3. `packages/sdk/src/ui/assistant-widget-shadow.ts` (`~270 líneas`):
     - Widget flotante aislado en `ShadowRoot` con banner de consentimiento `END_USER_VOICE_CONSENT`, cursor asistido en pantalla y botón de interrupción manual.

---

### SUBAGENTE 2.9 — Ensamblador del SDK, Auditoría Estricta <500 Líneas & Cierre Ledger
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `import-guardian`.
* **Archivos Asignados a Crear / Modificar:**
  1. `packages/sdk/src/index.tsx` (`~290 líneas`):
     - Exporta `OnboardingAssistant.init()`, componentes `<OnboardingAssistantProvider />` (maneja handshake con `POST /api/v1/sdk/handshake`, WebSocket efímero y Context Slimming vía `route.changed`).
  2. **Auditoría Técnica Automática:** Ejecuta `node scripts/check-file-lines.mjs` certificando que todos los archivos de la División 2 tengan `< 500 líneas` y verifica `npx tsc --noEmit`.
  3. **Cierre y Notificación en Ledger:** Actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` registrando la División 2 como `LISTO_PARA_CONSUMO`.

---

## 4. Prompt Maestro de Activación para la IA #2 (`Copy & Paste`)

```markdown
Actúa como la **IA #2 (Cerebro Orquestador: Identidad, Legal, Documentación, Sandbox & SDK)** ejecutando las **Partes 5, 6, 7 y 8** del documento `12_PLAN_MAESTRO_FRONTEND_IA2_AUTH_LEGAL_DOCS_SANDBOX_Y_SDK.md`.

REGLAS DE ORQUESTACIÓN CON 9 SUBAGENTES:
1. Actúas como el Cerebro Orquestador: Antes de escribir código, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` que la División 2 entra en construcción.
2. Despliega y coordina de forma organizada a tus **9 Subagentes Especializados (2.1 al 2.9)** siguiendo la división exacta de archivos y misiones de este plan:
   - Subagente 2.1: Tokens CSS Cursor Atelier (`dashboard-docs-cursor-atelier.css`) y Primitivas UI Compartidas (`AtelierUiPrimitives.tsx`).
   - Subagente 2.2: Contexto de Sesión en Memoria RAM (`useAuthSessionContext.tsx`) y Wizard de Registro Multi-Paso.
   - Subagente 2.3: Login B2B con Descubrimiento SSO, CLI Device y Login Aislado SuperAdmin FIDO2.
   - Subagente 2.4: Retos MFA (TOTP, WebAuthn, Códigos SHA-256), Recuperación de Contraseña y Break-Glass de Owner.
   - Subagente 2.5: Modal Bloqueante de Re-Consentimiento Legal ToS/DPA y Visor Editorial Legal.
   - Subagente 2.6: Shell de Documentación '/docs' con Buscador Cmd+K y Referencia Interactiva del SDK.
   - Subagente 2.7: Sandbox Paneles Izquierdo y Central (Inspector WS + Lienzo DOM Responsive).
   - Subagente 2.8: Sandbox Panel Derecho Despachador y Extensión del SDK Web `@onboarding-assistant/sdk` (AudioWorklet PCM16, VAD local <5ms, Widget Shadow DOM). Aplica obligatoriamente la skill `import-guardian` para extender y no sobreescribir `packages/sdk/src/core/sdk-client.ts`.
   - Subagente 2.9: Ensamblador del SDK (`packages/sdk/src/index.tsx`), Auditoría estricta `wc -l < 500`, validación `tsc` y reporte de cierre en Ledger.
3. Aplica obligatoriamente las skills `estilo-paneles-y-docs-cursor-atelier` y `reglas-globales-construccion-codigo`: Fondo cálido `#f7f7f4`, tarjetas `#f2f1ed`, radios de `4px` (y `8px` solo en modales), tipografía CursorGothic/Garamond/BerkeleyMono y cabecera en español en la línea 1.
4. Escribe únicamente dentro de tus directorios asignados (`apps/web/src/styles/dashboard-docs-cursor-atelier.css`, `apps/web/src/components/atelier-primitives/`, `apps/web/src/app/(auth)/`, `apps/web/src/app/legal/`, `apps/web/src/app/docs/`, `apps/web/src/components/auth-legal/`, `apps/web/src/components/docs-sandbox/`, `packages/sdk/`). Si detectas dependencias con las IAs #1, #3 o #4, anótalas en el "Buzón de Notificaciones y Dependencias Inter-IA" de `docs/LIVE_ARCHITECTURE_LEDGER.md`.
```
