# MÓDULO 1: ARQUITECTURA DE INTERFAZ DE USUARIO, IDENTIDAD, PANELES Y CUMPLIMIENTO LEGAL

Este documento especifica la arquitectura lógica completa del Frontend, los flujos de identidad y autenticación (Logins B2B, SSO y SuperAdmin), los mecanismos de recuperación de cuentas, la arquitectura de cumplimiento legal (Términos, Privacidad, DPA y Consentimiento de Voz), las cuatro aplicaciones web de la plataforma, el SDK instalable (`@onboarding-assistant/sdk`) y la matriz de control de acceso basado en roles (RBAC).

## 1. Arquitectura de Identidad, Logins y Recuperación de Cuentas

La plataforma separa de forma estricta el plano de identidad de clientes B2B (`Owner`, `Developer`, `Billing`, `Viewer`) del plano de identidad de operaciones internas (`SuperAdmin`).

### 1.1. Matriz de Accesos y Portales de Inicio de Sesión

| Portal de Acceso | Ruta Base / Subdominio | Métodos de Autenticación Permitidos | Requisitos de MFA y Seguridad | Destino Post-Login |
| :--- | :--- | :--- | :--- | :--- |
| **Login B2B Estándar** | `app.plataforma.com/auth/login` | Email + Password (Argon2id), OAuth 2.0 PKCE (Google Workspace, GitHub, Microsoft Entra ID) | MFA TOTP (RFC 6238) o WebAuthn Passkey opcional para `Developer`/`Viewer`, obligatorio si la organización activa `mfa_enforced = true` | `/dashboard/org/:orgSlug/overview` |
| **Login B2B Enterprise SSO** | `app.plataforma.com/auth/sso` | SAML 2.0 / OIDC federado (Okta, Azure AD, PingIdentity, OneLogin) | Delegado al IdP corporativo + validación de firma XML SAML con certificado X.509 rotativo por tenant | `/dashboard/org/:orgSlug/projects` |
| **Login CLI Developer** | `app.plataforma.com/auth/cli-device` | Device Authorization Flow (RFC 8628) mediante código de usuario de 8 caracteres (`XXXX-XXXX`) | Requiere sesión autenticada en navegador web + confirmación explícita de alcance (`training:write`, `maps:publish`) | Emite token efímero al binario CLI local |
| **Login Aislado SuperAdmin** | `admin.plataforma.com/internal/login` | Email corporativo interno + Password (Argon2id) + **Hardware Passkey FIDO2/WebAuthn obligatorio** | Bloqueado por Cloudflare Zero Trust / IP Allowlist corporativa; prohibido login social; sesión máxima de 4 horas sin renovación silenciosa | `/superadmin/control-center` |

### 1.2. Flujos Detallados de Registro e Inicio de Sesión (Componentes, Props, Estados y Eventos)

#### A. Flujo de Registro de Nueva Organización (`/auth/register`)
* **Componente Principal:** `<OrganizationSignUpWizard />`
* **Props de Entrada:** `{ initialPlanCode?: 'PAYG' | 'PLAN_5' | 'PLAN_10' | 'PLAN_30' | 'PLAN_50', referralCode?: string, utmParams?: Record<string, string> }`
* **Estados de la Máquina de Estados UI:**
  1. `STEP_1_ACCOUNT_CREDENTIALS`: Captura `fullName`, `workEmail`, `password` (validado en cliente con medidor de entropía mínima de 70 bits y verificación asíncrona contra contraseñas filtradas vía k-Anonymity), `organizationName` y `organizationSlug` (autocalculado y verificado vía `GET /api/v1/auth/check-slug?slug=...` con debounce de 300ms).
  2. `STEP_2_LEGAL_ACCEPTANCE`: Presenta casillas obligatorias independientes para:
     * Aceptación de **Términos y Condiciones del Servicio (ToS)** y **Política de Privacidad**.
     * Suscripción automática al **Acuerdo de Procesamiento de Datos (DPA)** para cumplimiento GDPR/CCPA.
     * Declaración de responsabilidad sobre la captura de elementos DOM y no indexación de campos sensibles (PCI-DSS / HIPAA).
  3. `STEP_3_EMAIL_OTP_VERIFICATION`: Envía un código numérico CSPRNG de 6 dígitos al correo (`POST /api/v1/auth/verify-email/send`). El componente `<OtpVerificationInput />` bloquea el acceso al Dashboard hasta que `POST /api/v1/auth/verify-email/confirm` devuelve `HTTP 200 OK`.
  4. `STEP_4_INITIAL_PROJECT_AND_BILLING`: Crea automáticamente el primer proyecto por defecto (`Default Project`) y permite continuar en modo **Sandbox Gratuito Limitado** (15 minutos de prueba única no renovables vinculados a huella de tarjeta/dominio) o redirigir al checkout de Whop.

#### B. Flujo de Login B2B Unificado (`/auth/login`)
* **Componente Principal:** `<B2BAuthenticationBoundary />`
* **Props de Entrada:** `{ returnToUrl?: string, invitationToken?: string }`
* **Subcomponentes y Eventos:**
  * `<DomainDiscoveryEmailInput />`:
    * **Evento `onBlur(email)`:** Ejecuta `POST /api/v1/auth/discover-tenant` enviando `{ email }`.
    * **Respuesta Backend:** `{ sso_enforced: boolean, sso_provider_url?: string }`. Si `sso_enforced === true`, oculta el campo `password` y transforma el botón principal en **"Continuar con SSO Corporativo"**, evitando que empleados de clientes Enterprise inicien sesión con contraseñas locales.
  * `<PasswordAuthForm />`:
    * **Campos:** `email`, `password`, `cloudflareTurnstileToken`.
    * **Botón:** `btn_submit_login` ("Iniciar Sesión").
    * **Evento `onSubmit`:** `POST /api/v1/auth/login`.
    * **Transiciones de Respuesta:**
      * `HTTP 200 OK`: Recibe `{ access_token, user, organizations, active_organization_id }` en el cuerpo JSON y establece la cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` con el `refresh_token`.
      * `HTTP 202 Accepted`: Recibe `{ mfa_required: true, mfa_ephemeral_token, available_factors: ['totp', 'webauthn', 'recovery_code'] }`. Renderiza `<MfaChallengeModal />`.
      * `HTTP 403 Forbidden (code: LEGAL_CONSENT_OUTDATED)`: Recibe `{ required_documents: [{ id, type, version, title, content_markdown, sha256_hash }] }`. Renderiza el bloqueador `<MandatoryLegalReconsentModal />` antes de emitir tokens de sesión.
      * `HTTP 423 Locked`: Cuenta bloqueada temporalmente tras 5 intentos fallidos consecutivos en 15 minutos; muestra temporizador regresivo sincronizado con la cabecera `Retry-After`.

#### C. Flujo de Invitación de Miembros a una Organización (`/auth/accept-invite`)
* **Componente Principal:** `<OrganizationInviteAcceptor />`
* **Props de Entrada:** `{ rawInviteToken: string }` (leído de query param `?token=`).
* **Flujo Lógico:**
  1. Al montar, ejecuta `GET /api/v1/auth/invitations/verify?token=<rawInviteToken>`.
  2. Si el correo invitado no existe en la tabla `users`, muestra formulario de creación de perfil (`fullName`, `password`, aceptación legal).
  3. Si el correo ya existe en `users`, solicita autenticación normal + MFA y ejecuta `POST /api/v1/auth/invitations/accept`, creando el registro en `memberships` con el rol predefinido (`Developer`, `Billing` o `Viewer`) y registrando el evento `member.invitation_accepted` en `audit_logs`.

### 1.3. Flujos de Recuperación de Cuenta, Contraseña y MFA

#### A. Recuperación de Contraseña Anti-Enumeración (`/auth/forgot-password` y `/auth/reset-password`)
* **Solicitud (`<ForgotPasswordView />`):**
  * Captura `email` y `turnstileToken`.
  * Botón `btn_request_password_reset` dispara `POST /api/v1/auth/password/forgot`.
  * El backend aplica un **Constant-Time Execution Floor de 350ms** (tanto si el correo existe como si no) y devuelve siempre `HTTP 200 OK` con mensaje idéntico.
  * Si el usuario existe y está activo, genera un token aleatorio de 32 bytes (`256 bits` en hex), guarda únicamente `SHA-256(token)` en la tabla `password_reset_tokens` con TTL de 15 minutos e invalida cualquier token de recuperación previo del mismo usuario.
* **Confirmación (`<ResetPasswordConfirmView />`):**
  * Captura `rawResetToken` (de la URL), `newPassword` y `confirmNewPassword`.
  * Botón `btn_confirm_new_password` dispara `POST /api/v1/auth/password/reset`.
  * El backend verifica `SHA-256(rawResetToken)`, comprueba `expires_at > NOW()` y `used_at IS NULL`, actualiza `password_hash` con Argon2id, marca `used_at = NOW()`, **incrementa `users.token_version = token_version + 1`** y elimina todas las sesiones activas en Redis y PostgreSQL, enviando correo de alerta de seguridad al usuario.

#### B. Recuperación de Cuenta por Pérdida de Dispositivo MFA (`/auth/mfa-recovery`)
* **Nivel 1 — Código de Recuperación Criptográfico (Autoservicio Instantáneo):**
  * Al activar MFA por primera vez, el sistema genera 10 códigos alfanuméricos de un solo uso con formato `XXXX-XXXX-XXXX` (hasheados con SHA-256 individualmente con sal en `user_mfa_recovery_codes`).
  * En `<MfaRecoveryCodeForm />`, el usuario introduce uno de sus códigos; al validarse, el código se marca como `consumed_at = NOW()` y se permite el acceso para enrolar un nuevo dispositivo MFA.
* **Nivel 2 — Reseteo Delegado por Owner de la Organización (Para roles `Developer`, `Billing`, `Viewer`):**
  * Si un miembro pierde su dispositivo MFA y sus códigos, solicita el reseteo a un `Owner` de su organización.
  * El `Owner`, autenticado con su propio MFA en `/dashboard/org/:orgSlug/team`, pulsa `btn_reset_member_mfa(userId)`.
  * Esto requiere re-autenticación sudo del `Owner` (`POST /api/v1/auth/sudo-confirm`), invalida los factores MFA del miembro (solo si el miembro pertenece exclusivamente a esa organización) y fuerza el re-enrolamiento en su próximo inicio de sesión.
* **Nivel 3 — Recuperación de Emergencia para `Owner` Único (Break-Glass Verification):**
  * Si el único `Owner` pierde tanto su MFA como sus códigos de respaldo, inicia el flujo en `/auth/owner-emergency-recovery`:
    1. Valida propiedad del correo electrónico mediante OTP.
    2. Valida propiedad del dominio verificado en `allowed_domains` publicando un registro TXT DNS efímero (`_onboarding-recovery.<dominio> = oa-verify-<token>`) **O** validando los metadatos de la última factura pagada en Whop (`whop_receipt_id`).
    3. Entra en estado `PENDING_SUPERADMIN_REVIEW` con un período de enfriamiento (cooling-off) de 24 horas durante el cual se envían alertas al correo y webhook de seguridad de la organización antes de que el SuperAdmin apruebe el reseteo desde el panel de auditoría.

## 2. Arquitectura Legal, Privacidad, Términos y Consentimiento (GDPR / CCPA / SOC2 / AI Act)

Dado que la plataforma procesa voz en tiempo real de usuarios finales e interactúa con el DOM de aplicaciones web de terceros, la arquitectura legal está integrada a nivel de motor de base de datos, SDK y API Gateway.

### 2.1. Catálogo de Instrumentos Legales Versionados en Base de Datos (`legal_documents`)

| Código de Documento (`doc_type`) | Audiencia Obligatoria | Mecanismo de Aceptación | Regla de Bloqueo Técnico en Plataforma |
| :--- | :--- | :--- | :--- |
| `TOS_B2B` (Términos y Condiciones de Servicio SaaS) | `Owner`, `Developer`, `Billing`, `Viewer` | Checkbox explícito en registro + Modal bloqueante ante cambios de versión (`major_version`) | Si `user_legal_acceptances` no registra la última versión obligatoria, el middleware HTTP devuelve `403 LEGAL_CONSENT_OUTDATED` en todos los endpoints excepto `/api/v1/legal/*` y `/api/v1/auth/logout`. |
| `PRIVACY_POLICY` (Política de Privacidad y Tratamiento de Datos) | Todos los usuarios y visitantes | Enlace público en `/legal/privacy` + Aceptación vinculada en registro | Registro inmutable de `ip_address`, `user_agent`, `accepted_at` y `document_sha256` en `legal_acceptances`. |
| `DPA_ENTERPRISE` (Data Processing Agreement & Subprocessors) | `Owner` de cada Organización | Firma electrónica / Aceptación clickwrap con sello criptográfico al activar el primer proyecto o checkout en Whop | Sin DPA vigente para la organización, el endpoint de Handshake del SDK (`POST /api/v1/sdk/handshake`) rechaza la inicialización en dominios de producción (`403 DPA_NOT_SIGNED`). |
| `AI_VOICE_AUP` (Política de Uso Aceptable de IA y Voz) | `Owner`, `Developer` | Confirmación al publicar el primer System Prompt o Mapa Funcional | Prohibición técnica y contractual de usar el asistente para suplantación de identidad, captura de credenciales bancarias o ingeniería social. |
| `END_USER_VOICE_CONSENT` (Aviso de Asistente de Voz IA para Usuario Final) | Usuario final del cliente B2B que usa el SDK | Banner/Tooltip integrado en el widget del `@onboarding-assistant/sdk` al pulsar el botón de micrófono por primera vez | El SDK no abre el stream `navigator.mediaDevices.getUserMedia({ audio: true })` ni el WebSocket de voz hasta que el usuario final confirma el consentimiento de sesión de voz (`consent_granted = true` enviado en el payload de apertura del WebSocket). |

### 2.2. Controles Técnicos de Privacidad y Protección de Datos (Privacy by Design)
1. **Sanitización y Enmascaramiento Automático en el DOM (PII/PCI Scrubber en el SDK y Navegador de Entrenamiento):**
   * El script inyectado en el Navegador de Entrenamiento Remoto y el paquete `@onboarding-assistant/sdk` bloquean por código la selección, lectura o escritura sobre elementos que coincidan con selectores de alta sensibilidad: `input[type="password"]`, `input[autocomplete^="cc-"]`, `[data-oa-sensitive="true"]`, `[data-private="true"]`, o iframes de pasarelas de pago (Stripe, Whop, PayPal, Adyen).
   * Cuando la herramienta `type_text` es invocada por la IA, el motor verifica en el cliente que el elemento destino no sea un campo de contraseña ni tarjeta bancaria; si lo es, aborta la acción localmente y devuelve al Gateway de Voz el error estructurado `ACTION_BLOCKED_SENSITIVE_FIELD`.
2. **Política de Retención Cero de Audio Crudo (Zero Raw Audio Persistence por Defecto):**
   * Los chunks de audio PCM16 transmitidos por WebSocket entre el navegador del usuario final, el Gateway de Voz y los proveedores `Qwen3.8-Omni-Flash-Realtime` / `Gemini 3.8 Live` se procesan **exclusivamente en buffers de memoria RAM volátil (Ring Buffers)** y se descartan inmediatamente tras su inferencia.
   * No se almacenan grabaciones `.wav` o `.mp3` en disco ni en Object Storage, salvo que el `Owner` active explícitamente el modo de depuración auditada (`opt_in_session_transcripts = true`) y declare el consentimiento correspondiente en su aviso de privacidad hacia sus usuarios finales.
3. **Derecho al Olvido y Borrado Criptográfico (GDPR Art. 17 / CCPA):**
   * En `/dashboard/org/:orgSlug/settings/privacy-compliance`, el `Owner` dispone de:
     * **Exportación de Datos Portables (`btn_export_org_data`):** Genera un archivo JSON/ZIP firmado con todos los mapas funcionales, logs de uso, sesiones y facturas (`POST /api/v1/organizations/:orgId/compliance/export`).
     * **Eliminación Definitiva de Organización (`btn_delete_organization`):** Requiere confirmación por MFA + escribir el slug exacto de la organización. Cancela suscripciones activas en Whop, purga en cascada `projects`, `functional_maps`, `map_elements`, `api_keys` y anonimiza los identificadores personales en `audit_logs` y `usage_ledger` (conservando solo los asientos contables agregados exigidos por ley tributaria durante 7 años).

---

## 3. Especificación Detallada de las Vistas y Paneles del Frontend

### 3.1. LANDING PÚBLICA COMERCIAL (`/` — Aplicación Web Pública)

#### A. Arquitectura de Componentes y Jerarquía Lógica
1. `<PublicCommercialHeader />`:
   * **Props:** `{ isAuthenticated: boolean, activeOrgSlug?: string }`
   * **Elementos y Acciones:** Enlaces de navegación (`#arquitectura`, `#demo-en-vivo`, `#calculadora-precios`, `/docs`, `/docs/sandbox`, `/legal/privacy`, `/legal/terms`). Si `isAuthenticated === false`, muestra `btn_nav_login` (`/auth/login`) y `btn_nav_signup` (`/auth/register`). Si `isAuthenticated === true`, muestra `btn_go_to_dashboard` (`/dashboard/org/:activeOrgSlug`).
2. `<HeroArchitectureShowcase />`:
   * **Props:** `{ supportedModels: ['Qwen3.8-Omni-Flash-Realtime', 'Gemini 3.8 Live'], latencySlaMs: number }`
   * **Estado Interno:** `{ selectedDemoScenario: 'CRM_ONBOARDING' | 'ERP_INVOICING' | 'SAAS_ANALYTICS' }`
   * **Acciones:** Botón primario `btn_start_free_sandbox` (redirige a `/auth/register?mode=sandbox`), botón secundario `btn_launch_cli_command` (copia al portapapeles `npx @onboarding-assistant/cli init` y emite evento de telemetría `POST /api/v1/telemetry/public-event`).
3. `<LiveInteractiveVoiceDemo />` (Demostración Interactiva en Vivo del Asistente):
   * **Propósito:** Permitir que un visitante anónimo pruebe en vivo cómo el asistente de voz conversa en tiempo real y mueve un cursor virtual haciendo click y escribiendo sobre una aplicación SaaS simulada incrustada en un contenedor DOM aislado (Shadow DOM), sin necesidad de registrarse.
   * **Props:** `{ demoProjectId: string, maxDemoDurationSeconds: 90, demoModel: 'Qwen3.8-Omni-Flash-Realtime' | 'Gemini 3.8 Live' }`
   * **Estados Internos:** `IDLE` ➔ `REQUESTING_MIC_PERMISSION` ➔ `FETCHING_DEMO_EPHEMERAL_TOKEN` ➔ `CONNECTED_LISTENING` ➔ `AI_SPEAKING` ➔ `EXECUTING_DOM_ACTION` ➔ `DEMO_COMPLETED` | `RATE_LIMITED`.
   * **Flujo de Conexión y Eventos:**
     * El visitante selecciona el escenario simulado (ej. *"Crear mi primer pipeline de ventas en el CRM demo"*) y el motor de IA (`Selector: Qwen3.8-Omni vs Gemini 3.8 Live`).
     * Al pulsar `btn_start_live_demo`:
       1. Solicita permiso `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 } })`.
       2. Llama a `POST /api/v1/public/demo-session` enviando `{ scenario_id, turnstile_token, preferred_model }`.
       3. El backend valida el rate limit por IP (máximo 2 sesiones demo de 90 segundos por IP cada 24 horas en Redis) y devuelve `{ ws_url, ephemeral_demo_jwt, simulated_functional_map }`.
       4. Abre conexión WebSocket a `wss://voice.plataforma.com/ws/v1/demo?token=<ephemeral_demo_jwt>`.
       5. Mientras el asistente habla, despacha eventos reales `click_element` y `type_text` sobre los elementos del `<SimulatedCrmCanvas />` (ej. resalta el botón `#demo-btn-new-deal`, mueve el puntero virtual, hace click, abre el modal simulado y escribe `"Contrato Anual Acme Corp"` en `#demo-input-deal-name`).
     * Incluye botón `btn_interrupt_assistant` (o simplemente hablar encima del asistente) para demostrar la capacidad de **Barge-in** en vivo, y botón `btn_end_demo_session`.
4. `<InteractivePricingCalculator />` (Calculadora Dinámica de Planes, Overage y Descuento por Volumen):
   * **Props:** `{ baseRatePerMinuteUsd: number, plans: PlanDefinition[], volumeDiscountTiers: VolumeTier[] }` (hidratados desde `GET /api/v1/public/pricing-matrix`).
   * **Controles de Entrada (Inputs/Sliders):**
     * `input_monthly_active_onboardings`: Número estimado de usuarios guiados por mes (`10` a `100,000`).
     * `input_avg_session_minutes`: Duración media por sesión en minutos (`1` a `30` min).
     * `select_billing_modality`: Selector entre `'AUTO_RECOMMEND'` | `'PAY_AS_YOU_GO'` | `'FIXED_PLAN_WITH_OVERAGE'`.
     * `select_ai_engine`: `'Qwen3.8-Omni-Flash-Realtime'` | `'Gemini 3.8 Live'` | `'Mixed (50/50)'`.
   * **Lógica de Cálculo en Tiempo Real (`calculateProjectedBilling()`):**
     * Calcula `totalMonthlyMinutes = monthlyActiveOnboardings * avgSessionMinutes`.
     * Compara el costo total mensual bajo:
       1. **Pago por Uso Puro (PAYG):** `totalMonthlyMinutes * baseRatePerMinuteUsd`.
       2. **Planes Fijos Mensuales ($5, $10, $30, $50 USD):** Muestra los minutos incluidos en cada plan. Si `totalMonthlyMinutes > includedMinutes`:
          * Para planes de **$5, $10 y $30 USD**, calcula el exceso a tarifa estándar o sugiere el salto automático al plan inmediato superior.
          * Para el **Plan de $50 USD (y régimen de exceso / Plan Masivo)**, aplica automáticamente la tabla de **Descuento por Volumen Escalonado** sobre cada minuto adicional consumido (ej. Tramo 1: 0% desc., Tramo 2: 15% desc., Tramo 3: 30% desc., Tramo 4: 45% desc.).
   * **Salidas Visuales y Acciones:**
     * Muestra desglose exacto: `Costo Base del Plan`, `Minutos Incluidos`, `Minutos en Exceso (Overage)`, `Porcentaje de Descuento por Volumen Aplicado`, `Tarifa Efectiva por Minuto ($/min)` y `Total Mensual Estimado (USD)`.
     * Botón `btn_checkout_selected_plan(planCode)`: Redirige a `/auth/register?plan=<planCode>&estimated_minutes=<totalMonthlyMinutes>` para encadenar el alta con el Checkout de Whop.

---

### 3.2. LANDING PÚBLICA DE DOCUMENTACIÓN & SANDBOX (`/docs` y `/docs/sandbox`)

#### A. Guía de Integración Paso a Paso del SDK (`/docs/quickstart` y `/docs/sdk-reference`)
* **Componente Principal:** `<DeveloperDocsLayout />` con árbol de navegación lateral, buscador semántico local (`Cmd+K`) y selector de framework (`React / Next.js`, `Vue 3 / Nuxt`, `Angular`, `Vanilla JS / HTML`).
* **Secciones Técnicas Documentadas:**
  1. **Instalación del paquete oficial:**
     * Comando: `npm install @onboarding-assistant/sdk` (o `pnpm add @onboarding-assistant/sdk` / `yarn add @onboarding-assistant/sdk`).
  2. **Inicialización del Proveedor (`<OnboardingAssistantProvider />` o `OnboardingAssistant.init()`):**
     * Documentación exhaustiva de parámetros de configuración:
       * `publicKey: string` (`pk_live_...` o `pk_test_...`).
       * `projectId: string` (`UUID` del proyecto).
       * `userContext?: { externalUserId: string, name?: string, role?: string, plan?: string, customAttributes?: Record<string, string | number | boolean> }` (inyectado como variables seguras en el System Prompt para personalizar el saludo y los pasos sin exponer secretos).
       * `routerAdapter?: { getCurrentPath: () => string, navigateTo: (path: string) => Promise<void> }` (para sincronizar cambios de ruta SPA en tiempo real con el motor de Context Slimming RAG).
       * `onActionBeforeExecute?: (event: ActionEventPayload) => boolean | Promise<boolean>` (hook opcional para que el desarrollador intercepte o valide una acción antes de que el SDK haga click o escriba en el DOM).
       * `onStepCompleted?: (stepIndex: number, stepId: string) => void`.
       * `onSessionEnded?: (summary: { durationSeconds: number, completedSteps: number, terminationReason: string }) => void`.
  3. **Atributos HTML recomendados para Selectores Inmutables:**
     * Guía de uso del atributo dedicado `data-oa-id="boton-crear-factura"` y buenas prácticas de accesibilidad (`aria-label`, `role`) para garantizar resiliencia ante refactorizaciones de clases CSS (Tailwind/CSS Modules).
  4. **Guía de la Herramienta CLI (`@onboarding-assistant/cli`):**
     * Uso de `npx @onboarding-assistant/cli login`, `npx @onboarding-assistant/cli train --url http://localhost:3000 --project <id>` (que levanta un túnel seguro TLS o conecta la sesión de entrenamiento) y `npx @onboarding-assistant/cli maps pull / push` para flujos CI/CD GitOps.

#### B. Visor de Especificación de la API y Sandbox Interactivo (`/docs/sandbox`)
* **Componente Principal:** `<InteractiveSdkSandboxEnvironment />`
* **Estructura de Pantalla Dividida (3 Paneles Sincronizados):**
  1. **Panel Izquierdo — Inspector de Especificación API & WebSocket (`<ApiAndProtocolSpecViewer />`):**
     * Documenta y permite probar los endpoints REST públicos/privados (configuración de System Prompt vía API `PUT /api/v1/projects/:projectId/prompt`, publicación de Mapas RAG `POST /api/v1/projects/:projectId/maps`, consulta de consumo `GET /api/v1/billing/usage`) y la especificación completa de tramas WebSocket del Gateway de Voz (`session.init`, `audio.input.pcm16`, `route.changed`, `tool.call.click_element`, `tool.call.type_text`, `tool.execution.ack`, `voice.barge_in`).
  2. **Panel Central — Lienzo DOM de Pruebas (`<SandboxTargetApplicationCanvas />`):**
     * Contiene una interfaz interactiva de prueba con múltiples componentes complejos: formularios con inputs controlados de React, selectores desplegables, modales dinámicos, pestañas, tablas con paginación y botones de acción con atributos `data-oa-id`, `id` y roles ARIA, además de un campo `input[type="password"]` para comprobar el bloqueo de seguridad PII.
     * Permite conmutar el viewport del lienzo entre **Desktop (`1440x900`)**, **Tablet (`768x1024`)** y **Mobile (`390x844`)** para verificar el recálculo de coordenadas relativas y bounding boxes en diseño responsive.
  3. **Panel Derecho — Despachador Manual y Simulador de Eventos (`<SandboxToolDispatcher />`):**
     * **Props:** `{ targetCanvasRef: RefObject<HTMLElement>, activeViewport: ViewportMode }`
     * **Controles Interactivos:**
       * Selector de herramienta: `'click_element'` | `'type_text'` | `'click_and_type'`.
       * Input `target_element_id` / `selector_strategy` (permite elegir un elemento del Mapa Funcional de ejemplo o escribir un selector CSS / `data-oa-id` / coordenadas normalizadas `{ x_norm, y_norm }`).
       * Input `text_to_type` (visible cuando la acción es `type_text` o `click_and_type`), velocidad de tipeo simulada (`instant` | `human_cadence_45ms`) y flag `clear_before_type: boolean`.
       * Botón `btn_dispatch_click_element` ("Probar click_element") y Botón `btn_dispatch_type_text` ("Probar type_text").
     * **Flujo al Ejecutar Prueba:**
       * El SDK renderiza el cursor asistido sobre el lienzo, desplaza suavemente el scroll si el elemento está fuera del viewport (`scrollIntoView({ behavior: 'smooth', block: 'center' })`), valida que el elemento sea visible y no esté cubierto por otro nodo (`document.elementFromPoint(x, y)`), despacha la secuencia completa de eventos nativos compatibles con React/Vue/Angular (`pointerdown` ➔ `mousedown` ➔ `focus` ➔ `mouseup` ➔ `click`, o setter nativo de `HTMLInputElement.prototype.value` + `new InputEvent('input', { bubbles: true })` + `change`) y muestra en la consola inferior el payload exacto de confirmación `tool.execution.ack` con el tiempo de ejecución en milisegundos.

---

### 3.3. DASHBOARD DEL DESARROLLADOR (`/dashboard/org/:orgSlug/*`)

El Dashboard del Desarrollador es la consola operativa B2B donde las organizaciones configuran sus proyectos, entrenan visualmente sus aplicaciones, redactan el System Prompt paso a paso, gestionan sus API Keys y controlan su facturación con Whop.

#### A. Estructura Global de Navegación y Contexto
* **Componente Shell:** `<DeveloperDashboardShell />`
* **Selectores Globales en Barra Superior:**
  * `<OrganizationSwitcher />`: Cambia entre organizaciones a las que pertenece el usuario.
  * `<ProjectSwitcher />`: Cambia entre proyectos de la organización (ej. `CRM Producción`, `CRM Staging`, `Portal Clientes`) y botón `btn_create_project`.
  * `<EnvironmentModeBadge />`: Indica el entorno activo del proyecto (`PRODUCTION` vs `SANDBOX_TEST`).
  * `<RealtimeBalancePill />`: Muestra en vivo los minutos restantes del plan o el saldo actual consumido en dólares, con alerta visual si supera el 85% del presupuesto mensual, más acceso rápido a `btn_topup_or_upgrade`.

#### B. Módulo 3.3.1: Gestión de Proyectos, Dominios Permitidos y API Keys (`/dashboard/org/:orgSlug/projects/:projectId/keys`)
* **Sub-panel 1: Lista Blanca de Dominios CORS y Handshake (`<AllowedDomainsManager />`)**
  * Permite registrar los orígenes autorizados para el SDK Web (ej. `https://app.micrm.com`, `https://*.staging.micrm.com`, `http://localhost:3000` solo para claves `pk_test_`).
  * **Componentes y Botones:**
    * Input `domain_pattern`, selector `environment` (`production` | `development`), botón `btn_add_allowed_domain` ➔ `POST /api/v1/projects/:projectId/domains`.
    * Botón `btn_verify_domain_dns(domainId)` (opcional para seguridad reforzada) y botón `btn_revoke_domain(domainId)` ➔ `DELETE /api/v1/projects/:projectId/domains/:domainId`.
* **Sub-panel 2: Generador y Gestor de API Keys (`<ApiKeyLifecycleManager />`)**
  * **Diferenciación Estricta de Claves:**
    1. **Clave Pública del SDK (`Publishable Key` — `pk_live_...` / `pk_test_...`):**
       * Diseñada para incrustarse en el frontend del cliente (`@onboarding-assistant/sdk`).
       * **Alcance único:** Solo puede invocar `POST /api/v1/sdk/handshake` desde un encabezado `Origin` que coincida exactamente con `allowed_domains` del proyecto. No puede leer ni modificar configuraciones, ni consultar facturación.
    2. **Clave Secreta de Backend (`Secret Key` — `sk_live_...` / `sk_test_...`):**
       * Diseñada exclusivamente para llamadas servidor-a-servidor (CI/CD, actualización programática del System Prompt, sincronización de Mapas Funcionales RAG, generación de tokens de sesión firmados desde el backend del cliente).
       * **Alcances (Scopes) configurables por clave:** `prompt:read`, `prompt:write`, `maps:read`, `maps:write`, `sessions:create`, `analytics:read`.
  * **Props del Componente `<ApiKeyTable />`:** `{ projectId: string, keys: ApiKeyMetadata[], userRole: RbacRole }`
  * **Eventos y Botones:**
    * `btn_create_api_key`: Abre `<CreateApiKeyModal />` donde se define `name`, `key_type` (`publishable` | `secret`), `environment` (`live` | `test`), `scopes[]` y `expires_at` (opcional). Dispara `POST /api/v1/projects/:projectId/api-keys`.
    * `<OneTimeSecretRevealDialog />`: Muestra el valor en texto plano (`sk_live_...`) **una única vez en toda su historia** con botón `btn_copy_key_clipboard` y advertencia de que solo se almacena su hash SHA-256.
    * `btn_rotate_api_key(keyId)`: Abre `<RotateApiKeyModal />` permitiendo elegir una **Ventana de Gracia de Transición** (`0h - Revocación Inmediata`, `1h`, `24h`, `72h`). Al confirmar (`POST /api/v1/projects/:projectId/api-keys/:keyId/rotate`), genera la nueva clave inmediatamente y programa la expiración automática (`grace_period_ends_at`) de la clave anterior para evitar caídas en producción durante el despliegue del cliente.
    * `btn_revoke_api_key_immediately(keyId)`: Ejecuta `DELETE /api/v1/projects/:projectId/api-keys/:keyId` e invalida en `<5ms` la clave en el caché de Redis (`DEL apikey:sha256:<hash>`).

#### C. Módulo 3.3.2: Estudio del Prompt del Asistente y Flujo Paso a Paso (`/dashboard/org/:orgSlug/projects/:projectId/prompt-studio`)
* **Propósito:** Permitir que el desarrollador configure con un único System Prompt maestro (y su estructura de pasos deterministas) la personalidad, las reglas de negocio y la secuencia exacta con la que el asistente de voz guiará al usuario final de principio a fin, tanto desde la interfaz gráfica como vía API REST.
* **Componente Principal:** `<AssistantPromptStudio />`
* **Props:** `{ projectId: string, activePromptVersion: PromptConfigVersion, availableMapRoutes: string[], supportedModels: ModelOption[] }`
* **Subcomponentes, Controles y Estados:**
  1. `<ModelAndVoiceConfigBar />`:
     * `select_primary_model`: `'Qwen3.8-Omni-Flash-Realtime'` | `'Gemini 3.8 Live'`.
     * `select_fallback_model`: Conmutación automática en caso de degradación del proveedor primario.
     * `select_voice_persona`: Selector de timbre vocal y velocidad de locución (`0.8x` a `1.25x`), idioma principal (`es-ES`, `es-MX`, `en-US`, `pt-BR`, `multilingual-auto`) y sensibilidad del detector de interrupción (`VAD / Barge-in Sensitivity`: `Low`, `Balanced`, `High`).
     * `input_temperature`: Control numérico (`0.0` a `1.0`, recomendado `0.2` para adherencia estricta a herramientas y pasos).
  2. `<UnifiedSystemPromptEditor />`:
     * Editor enriquecido basado en Monaco Editor con resaltado de variables dinámicas (`{{user.name}}`, `{{user.role}}`, `{{current_route}}`, `{{current_step}}`) y referencias directas a elementos del Mapa Funcional (`@[Botón Crear Cliente](el_uuid_123)`).
     * Permite redactar en un solo bloque el System Prompt completo, por ejemplo:
       > *"Eres el asistente técnico oficial de nuestro CRM. Debes guiar al cliente y atenderlo end-to-end con tono profesional y claro. Habla con él, confirma cada acción antes o mientras la realizas y ve por estos pasos uno a uno sin saltarte ninguno: Paso 1: Dirígete a la sección de Contactos y haz click en 'Nuevo Contacto'. Paso 2: Pregúntale el nombre de su empresa y escríbelo en el campo 'Nombre Comercial'. Paso 3: Haz click en 'Guardar y Continuar'..."*
  3. `<StepByStepFlowExtractorAndGuardrails />`:
     * **Sincronización Bidireccional:** Analiza el System Prompt (o permite definir explícitamente la lista ordenada de pasos `steps[]`) para que el motor de estado en el Gateway de Voz haga cumplir el avance secuencial (`Step 1` ➔ `Step 2` ➔ `Step 3`), verificando qué elementos del Mapa Funcional corresponden a cada paso y qué condición de validación DOM (`element_clicked`, `input_filled`, `route_reached`) marca el paso como completado.
     * Controles de reglas de seguridad del prompt (`Guardrails`):
       * `toggle_strict_step_enforcement`: Impide que la IA ejecute acciones de los pasos `N+1` si el paso `N` no ha sido confirmado por el SDK.
       * `toggle_ask_confirmation_before_submit`: Obliga al asistente a pedir confirmación verbal explícita del usuario antes de hacer click en botones clasificados como transaccionales o de envío final.
  4. `<PromptVersionHistoryAndApiSync />`:
     * Cada cambio guardado mediante `btn_save_prompt_draft` o publicado con `btn_publish_prompt_version` (`POST /api/v1/projects/:projectId/prompts`) crea una versión inmutable con número de revisión y autor.
     * Muestra el snippet listo para copiar para actualizar el System Prompt programáticamente vía API usando la `Secret Key` (`sk_live_...`):
       `PUT /api/v1/projects/:projectId/prompt` con payload `{ system_prompt, steps_schema, model_config, publish_immediately: true }`.

#### D. Módulo 3.3.3: Visor del Navegador de Entrenamiento Remoto (`/dashboard/org/:orgSlug/projects/:projectId/visual-trainer`)
* **Propósito:** Proveer una sesión de navegador aislado en la nube (o vinculado vía CLI local) donde el desarrollador navega por su aplicación real y, sin tomar capturas de pantalla ciegas, utiliza un puntero interactivo en capas (overlay) para inspeccionar, seleccionar y etiquetar elementos del DOM con precisión milimétrica tanto en Desktop como en Mobile.
* **Componente Principal:** `<RemoteVisualTrainerWorkspace />`
* **Estados de la Sesión de Entrenamiento:**
  `DISCONNECTED` ➔ `PROVISIONING_CONTAINER` ➔ `DNS_AND_SSRF_VALIDATING` ➔ `STREAMING_ACTIVE_NAVIGATION_MODE` ➔ `OVERLAY_CAPTURE_MODE` ➔ `ELEMENT_MODAL_OPEN` ➔ `COMPUTING_RESPONSIVE_COORDINATES` ➔ `PUBLISHING_RAG_MAP`.
* **Flujo de Inicio (Web o CLI):**
  * **Desde la Web:** El desarrollador introduce la `target_url` (ej. `https://app.micrm.com/dashboard`), selecciona si requiere inyectar cookies/headers de sesión de prueba, y pulsa `btn_start_remote_browser` (`POST /api/v1/projects/:projectId/training-sessions`).
  * **Desde el CLI:** El desarrollador ejecuta `npx @onboarding-assistant/cli train --url http://localhost:3000`. El CLI autenticado abre un túnel reverso seguro WebSocket/mTLS hacia el contenedor de entrenamiento efímero y devuelve la URL directa al Visor en el Dashboard.
* **Subcomponentes del Visor y Controles Interactivos:**
  1. `<TrainerToolbar />`:
     * Input de barra de direcciones `input_remote_url` con botón `btn_navigate_url`.
     * Conmutador de Modo de Interacción (`<InteractionModeToggle />`):
       * **Modo Navegación (`NAVIGATION_MODE`):** Permite al desarrollador iniciar sesión en su app de prueba, abrir menús desplegables o navegar hasta la vista que desea entrenar.
       * **Modo Captura con Puntero Overlay (`CAPTURE_OVERLAY_MODE`):** Activa la capa superpuesta de inspección DOM.
     * Selector de Viewport en Vivo (`<ResponsiveViewportSwitcher />`):
       * Botones `btn_viewport_desktop` (`1440x900`), `btn_viewport_tablet` (`768x1024`), `btn_viewport_mobile` (`390x844`).
       * Toggle `toggle_auto_responsive_recalculation`: Cuando está activo (por defecto), al guardar un elemento, el motor redimensiona silenciosamente el viewport en segundo plano a Desktop, Tablet y Mobile para capturar sus selectores y coordenadas relativas en las 3 resoluciones.
  2. `<InteractiveDomOverlayCanvas />` (Puntero Interactivo en Capas — Cero Screenshots Ciegos):
     * **Cómo funciona:** El contenedor Chromium remoto inyecta vía Chrome DevTools Protocol (`Page.addScriptToEvaluateOnNewDocument`) un agente ligero de telemetría DOM. Cuando el desarrollador mueve el ratón sobre el stream WebRTC/Canvas del navegador, las coordenadas `(clientX, clientY)` se envían por canal de datos de baja latencia (`RTCDataChannel` / WebSocket) al Chromium remoto.
     * El agente DOM ejecuta `document.elementFromPoint(x, y)` y devuelve en `<8ms` la geometría exacta del nodo (`getBoundingClientRect()`), su etiqueta HTML, atributos de accesibilidad (`role`, `aria-label`), texto visible e jerarquía DOM.
     * El componente `<InteractiveDomOverlayCanvas />` dibuja en el frontend del Dashboard un recuadro resaltado vectorial sobre el elemento bajo el puntero con una etiqueta flotante que muestra `<button data-oa-id="create-invoice">` y el puntaje de estabilidad del selector (`Selector Stability Score: 99/100`).
  3. `<ElementTaggingModal />` (Modal Desplegado al Marcar una Parte de la Pantalla):
     * Al hacer click sobre cualquier elemento resaltado en `CAPTURE_OVERLAY_MODE`, se congela el puntero y se abre el modal estructurado con los siguientes campos obligatorios y opcionales:
       * **Campo 1 — Título del Elemento (`input_element_title`):** Texto requerido (ej. `"Botón Crear Nueva Factura"`).
       * **Campo 2 — Descripción Funcional (`textarea_functional_description`):** Explicación semántica detallada para el RAG sobre qué hace este elemento, cuándo debe usarse y qué efecto produce en la pantalla (ej. `"Abre el formulario modal para emitir una nueva factura CFDI al cliente actual"`).
       * **Campo 3 — ¿Hacer acción? (`radio_is_actionable`):** Selector booleano obligatorio (`Sí` / `No`).
         * Si es **`No`**: El elemento se indexa como **Elemento Informativo / Ancla Visual** (la IA puede leerlo, señalarlo con el puntero o explicar qué significa, pero tiene prohibido hacer click o escribir en él).
         * Si es **`Sí`**: Se habilita dinámicamente el **Campo 4**.
       * **Campo 4 — Tipo de Acción Permitida (`select_action_type`):** Selector obligatorio entre:
         * `CLICK` (Solo hacer click sobre el elemento).
         * `TYPE` (Solo escritura de texto en input/textarea/contenteditable).
         * `BOTH` (`Click + Escritura (Type)`: hace click para enfocar/abrir el componente y acto seguido escribe el texto indicado).
       * **Sub-panel Técnico Autocalculado (Editable para usuarios avanzados):**
         * Muestra la cadena de selectores estables calculados por orden de prioridad:
           1. `primary_selector`: Atributo dedicado (`[data-oa-id="..."]`, `[data-testid="..."]`, `[data-cy="..."]`).
           2. `accessibility_selector`: Rol ARIA + Nombre accesible (`role=button[name="Crear Factura"]`).
           3. `structural_css_selector`: Ruta CSS resiliente libre de clases dinámicas hasheadas.
           4. `xpath_fallback`: XPath semántico basado en texto/jerarquía.
         * Muestra la matriz de geometría y coordenadas **Responsive / Móvil**:
           * `desktop_bbox`: `{ x_pct, y_pct, width_pct, height_pct, anchor_point: 'center' }`.
           * `tablet_bbox`: `{ x_pct, y_pct, width_pct, height_pct, is_visible_in_viewport, requires_scroll }`.
           * `mobile_bbox`: `{ x_pct, y_pct, width_pct, height_pct, is_hidden_behind_drawer, mobile_trigger_selector? }` (si en móvil el elemento pasa a estar dentro de un menú hamburguesa, permite vincular el selector del botón que abre dicho menú).
       * **Botones del Modal:** `btn_cancel_element_capture`, `btn_test_selector_highlight` (hace parpadear el elemento en el navegador remoto para verificar unicidad) y `btn_save_element_to_map` ("Guardar en Mapa RAG").

#### E. Módulo 3.3.4: Editor del Mapa Funcional RAG — Edición Visual y por Código JSON (`/dashboard/org/:orgSlug/projects/:projectId/rag-map-editor`)
* **Propósito:** Permitir al desarrollador revisar, auditar, versionar y modificar posteriormente toda la configuración capturada de dos formas totalmente sincronizadas: **1) Visualmente** mediante tarjetas y previsualización interactiva de rutas/elementos, o **2) Directamente editando el código JSON estructurado**, garantizando inmutabilidad criptográfica mediante hash `SHA-256`.
* **Componente Principal:** `<FunctionalMapDualEditor />`
* **Props:** `{ projectId: string, activeMapVersion: FunctionalMapDocument, draftElements: MapElementRecord[] }`
* **Modos de Edición Sincronizados en Tiempo Real:**
  1. **Vista de Edición Visual (`<VisualMapTreeAndCardEditor />`):**
     * Agrupa los elementos por ruta o patrón de URL (`url_pattern`, ej. `/dashboard`, `/clientes/:id/facturas`, `/configuracion`).
     * Permite arrastrar y reordenar prioridades, editar en línea el `Título`, la `Descripción Funcional`, el switch `¿Hacer acción? (Sí/No)`, el selector `Click / Type / Ambos`, los selectores CSS/ARIA y las coordenadas responsive sin necesidad de reabrir el navegador remoto, o pulsar `btn_reopen_in_visual_trainer(elementId)` para recalibrar un elemento específico en el navegador remoto.
  2. **Vista de Edición Directa de Código JSON (`<MonacoJsonSchemaMapEditor />`):**
     * Expone el documento completo del **Mapa Funcional JSON** validado en tiempo real contra un JSON Schema estricto (`draft-2020-12`).
     * Cualquier cambio en el JSON actualiza instantáneamente la vista visual y viceversa.
     * Incluye validador sintáctico y semántico en vivo: detecta IDs duplicados, selectores CSS inválidos, elementos con `is_actionable: true` sin `action_type` o coordenadas fuera del rango normalizado `[0.0, 1.0]`.
* **Sellado Criptográfico e Inmutabilidad (`SHA-256 Canonical Hashing`):**
  * Al pulsar `btn_publish_immutable_map` ("Publicar Nueva Versión del Mapa RAG"):
    1. El sistema serializa el JSON aplicando **RFC 8785 (JSON Canonicalization Scheme - JCS)** (ordenando alfabéticamente todas las llaves y eliminando espacios en blanco irrelevantes).
    2. Calcula el digest `SHA-256` del JSON canónico (`content_sha256_hash`).
    3. Genera los embeddings vectoriales (`vector(1536)`) de cada elemento combinando `title + functional_description + route_pattern + aria_role` para búsqueda híbrida semántica + exacta.
    4. Inserta una nueva versión inmutable en `functional_maps` (`version_number = N + 1`, `is_active = true`), desmarca la anterior e invalida/precalienta de inmediato la clave de caché en Redis (`rag_map:proj:<projectId>:active`).
  * Incluye botón `btn_rollback_to_version(versionId)` para revertir en `<50ms` a cualquier versión anterior del mapa funcional.

#### F. Módulo 3.3.5: Panel de Consumo, Minutos Utilizados, Facturación y Portal Whop (`/dashboard/org/:orgSlug/billing`)
* **Componente Principal:** `<OrganizationBillingAndUsageDashboard />`
* **Props:** `{ organizationId: string, subscription: WhopSubscriptionState, usageSummary: UsageMetrics, ledgerEntries: UsageLedgerRow[] }`
* **Secciones y Controles:**
  1. `<CurrentPlanAndBalanceCard />`:
     * Muestra el estado actual de la cuenta en Whop:
       * Modalidad activa: `Pago por Uso Puro (PAYG)` | `Plan $5/mes` | `Plan $10/mes` | `Plan $30/mes` | `Plan $50/mes (con Descuento por Volumen en Exceso)` | `Tarifa Personalizada Enterprise (Override SuperAdmin)`.
       * Barra de progreso de minutos incluidos en el ciclo actual vs. minutos consumidos en exceso (`Overage Minutes`).
       * Tarifa vigente por minuto (`effective_rate_per_minute_usd`) y tramo actual de descuento por volumen aplicable.
  2. `<WhopCheckoutAndPortalActions />`:
     * Botones de cambio de plan directo (`btn_subscribe_plan_5`, `btn_subscribe_plan_10`, `btn_subscribe_plan_30`, `btn_subscribe_plan_50`, `btn_switch_to_payg`): Invocan `POST /api/v1/billing/whop/checkout-session` que devuelve la URL firmada de Checkout de Whop con `metadata: { organization_id, target_plan_code, user_id }`.
     * Botón `btn_open_whop_customer_portal` ("Gestionar Membresía y Métodos de Pago en Whop"): Redirige al portal oficial de cliente en Whop para actualizar tarjetas, descargar recibos fiscales y gestionar la suscripción.
     * Configuración de recarga automática y límites de protección de gasto (`<SpendProtectionControls />`): Permite al `Owner` o `Billing` definir un tope máximo mensual de consumo en exceso (`hard_spend_cap_usd`) y alertas por correo/webhook al 50%, 80% y 100%.
  3. `<MinuteByMinuteUsageLedgerTable />`:
     * Tabla auditable con filtros por rango de fechas, proyecto y modelo de IA (`Qwen3.8-Omni-Flash-Realtime` vs `Gemini 3.8 Live`).
     * Muestra por cada sesión de voz: `session_id`, `started_at`, `ended_at`, `duration_seconds`, `billed_minutes`, `applied_unit_rate_usd`, `volume_discount_pct`, `total_cost_usd`, `balance_after_deduction` y botón `btn_export_usage_csv`.

---

### 3.4. DASHBOARD SUPERADMIN (`/superadmin/*` — Consola de Gobierno Global)

#### A. Módulo 3.4.1: Control Total de Organizaciones, Usuarios y Suspensión de Cuentas (`/superadmin/organizations` y `/superadmin/users`)
* **Componente Principal:** `<GlobalTenantGovernanceGrid />`
* **Capacidades Operativas y Botones de Acción:**
  * Búsqueda instantánea por `organization_id`, `slug`, `whop_company_id`, `whop_membership_id`, dominio o email de usuario.
  * **Acciones Críticas sobre Organizaciones:**
    * `btn_suspend_organization(orgId, reason)`: Abre modal con motivo obligatorio de auditoría. Al confirmar (`POST /api/v1/superadmin/organizations/:orgId/suspend`):
      1. Cambia `organizations.status = 'SUSPENDED'`.
      2. Revoca en Redis todas las claves de caché de API Keys de la organización.
      3. Envía señal de cierre inmediato (`CLOSE_CODE_4003_TENANT_SUSPENDED`) a todas las sesiones de voz WebSocket activas de esa organización en todos los nodos del Gateway.
    * `btn_reactivate_organization(orgId)`: Restaura el estado a `ACTIVE`.
    * `btn_force_global_logout_org(orgId)`: Incrementa `token_version` de todos los miembros de la organización simultáneamente.
    * `btn_approve_emergency_mfa_reset(ticketId)`: Aprueba solicitudes verificadas de recuperación Break-Glass de `Owners`.

#### B. Módulo 3.4.2: Matriz Global de Precios de Whop y Escalafón de Descuentos por Volumen (`/superadmin/pricing-matrix`)
* **Componente Principal:** `<GlobalWhopPricingMatrixEditor />`
* **Configuración de Tarifas Base y Planes Mensuales:**
  * Permite al SuperAdmin editar en caliente (con registro en `audit_logs` y sincronización de `whop_plan_id`) los parámetros globales:
    * **Tarifa Base Pago por Uso Puro (PAYG):** `base_payg_rate_per_minute_usd` (diferenciable opcionalmente por motor `Qwen3.8-Omni` vs `Gemini 3.8 Live`).
    * **Configuración de los 4 Planes Fijos ($5, $10, $30, $50 USD):**
      * `plan_code` (`PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50`).
      * `whop_plan_id`: ID del plan configurado en el panel de Whop.
      * `monthly_price_usd`: `$5.00`, `$10.00`, `$30.00`, `$50.00`.
      * `included_minutes`: Cantidad exacta de minutos incluidos en el mes (ej. 25 min, 55 min, 180 min, 350 min, totalmente editable por el SuperAdmin).
      * `overage_allowed`: Booleano que define si al agotar los minutos incluidos el cliente pasa a cobro por minuto de exceso.
      * `volume_discount_eligible`: Activo por defecto a partir del **Plan de $50 USD** (y configurable para planes superiores).
  * **Editor de la Tabla de Descuentos por Volumen Escalonado (`<VolumeDiscountTiersEditor />`):**
    * Permite definir los tramos automáticos de descuento sobre el precio por minuto cuando el cliente está en el Plan de $50 USD (o superior) y consume minutos adicionales, o cuando su facturación acumulada en el ciclo supera los umbrales:
      * Ejemplo configurable en UI:
        * **Tramo 1:** De `0` a `1,000` minutos extra ➔ `10% de descuento` sobre la tarifa base por minuto.
        * **Tramo 2:** De `1,001` a `5,000` minutos extra ➔ `20% de descuento` sobre la tarifa base por minuto.
        * **Tramo 3:** De `5,001` a `25,000` minutos extra ➔ `35% de descuento` sobre la tarifa base por minuto.
        * **Tramo 4 (Masivo):** Más de `25,000` minutos extra ➔ `50% de descuento` sobre la tarifa base por minuto.
    * Botón `btn_save_global_pricing_matrix` ➔ `PUT /api/v1/superadmin/pricing-matrix` (requiere firma MFA WebAuthn del SuperAdmin).

#### C. Módulo 3.4.3: Descuentos Manuales y Tarifas Especiales por Cliente/Organización (`/superadmin/custom-pricing-overrides`)
* **Componente Principal:** `<TenantPricingOverrideManager />`
* **Propósito:** Permitir que el SuperAdmin asigne condiciones comerciales a medida a cualquier usuario u organización específica, las cuales tienen **prioridad absoluta** sobre la matriz general en el motor de tarificación.
* **Controles por Organización (`POST /api/v1/superadmin/organizations/:orgId/pricing-override`):**
  * `custom_rate_per_minute_usd`: Fija un precio por minuto exacto para esa organización (ej. `$0.065/min`).
  * `manual_discount_percentage`: Aplica un porcentaje de descuento directo (`0%` a `100%`) sobre cualquier cobro por minuto o exceso.
  * `bonus_free_minutes_grant`: Botón `btn_grant_promotional_minutes` para acreditar minutos de cortesía o compensación SLA en el `usage_ledger` con asiento contable `CREDIT_SUPERADMIN_GRANT`.
  * `custom_volume_tiers_json`: Permite sobrescribir los tramos de descuento por volumen exclusivamente para ese cliente corporativo.
  * `effective_from` y `effective_until`: Vigencia temporal del descuento o tarifa especial.

#### D. Módulo 3.4.4: Monitor de Consumo de Infraestructura en Tiempo Real y Auditoría Global (`/superadmin/infrastructure` y `/superadmin/audit-logs`)
* **Monitor de Infraestructura (`<RealtimeInfraTelemetryPanel />`):**
  * Conectado vía Server-Sent Events (`GET /api/v1/superadmin/telemetry/stream`) muestra en tiempo real:
    * **Sesiones de Voz Concurrentes Activas:** Desglosadas por proveedor (`Qwen3.8-Omni-Flash-Realtime` vs `Gemini 3.8 Live`), región y organización.
    * **Minutos de IA Consumidos (Ventana de 1m, 1h, 24h, 30d):** Con comparativa entre latencia media de extremo a extremo (`p50`, `p95`, `p99`), tasa de interrupciones (`Barge-in rate`) y tasa de éxito de herramientas DOM (`click_element` / `type_text` ACK rate).
    * **Pool de Contenedores Efímeros de Entrenamiento:** Contenedores Chromium activos, uso de CPU/RAM, y alertas de intentos bloqueados por el escudo **Anti-SSRF** (mostrando IP de origen, organización, usuario y URL maliciosa interceptada).
    * **Kill-Switch de Proveedor IA (`btn_failover_voice_provider`):** Permite desviar en caliente el 100% del tráfico nuevo hacia `Gemini 3.8 Live` si `Qwen3.8-Omni-Flash-Realtime` presenta caída de servicio, o viceversa, sin reiniciar el Gateway.
* **Visor de Auditoría Global (`<ImmutableAuditLogExplorer />`):**
  * Consulta sobre la tabla append-only `audit_logs` con filtros por `actor_user_id`, `organization_id`, `action_type`, `ip_address`, `severity` (`INFO`, `WARN`, `CRITICAL_SECURITY`) y exportación firmada para auditorías SOC2.

---

## 4. Matriz RBAC Completa (Control de Acceso Basado en Roles)

El sistema implementa autorización determinista evaluada en dos capas: **Middleware de Dominio en Backend** (basado en el rol del usuario dentro de la organización activa) y **Row-Level Security (RLS) en PostgreSQL**.

| Dominio / Permiso Granular (`permission_code`) | `SuperAdmin` (Plataforma) | `Owner` (Organización) | `Developer` (Organización) | `Billing` (Organización) | `Viewer` (Organización) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Gobierno de Plataforma y Todos los Tenants** | | | | | |
| `superadmin:tenants:list_all` (Ver todas las organizaciones y usuarios) | **SÍ** | NO | NO | NO | NO |
| `superadmin:tenants:suspend` (Suspender/Reactivar cuentas y cortar sesiones) | **SÍ** | NO | NO | NO | NO |
| `superadmin:pricing:manage_global` (Editar planes $5-$50, tarifas base y tramos) | **SÍ** | NO | NO | NO | NO |
| `superadmin:pricing:override_tenant` (Asignar tarifas/descuentos manuales por cliente) | **SÍ** | NO | NO | NO | NO |
| `superadmin:infra:monitor_and_failover` (Ver telemetría global y conmutar motores IA) | **SÍ** | NO | NO | NO | NO |
| `superadmin:audit:read_global` (Consultar logs de auditoría y alertas SSRF globales) | **SÍ** | NO | NO | NO | NO |
| **Administración de Organización e Identidad** | | | | | |
| `org:settings:read` (Ver datos generales de la organización) | **SÍ** | **SÍ** | **SÍ** | **SÍ** | **SÍ** |
| `org:settings:update` (Editar nombre, políticas MFA, SSO SAML y retención) | **SÍ** | **SÍ** | NO | NO | NO |
| `org:legal:accept_dpa` (Firmar DPA y acuerdos legales en nombre de la empresa) | **SÍ** | **SÍ** | NO | NO | NO |
| `org:delete` (Eliminar organización y solicitar borrado GDPR) | **SÍ** | **SÍ** | NO | NO | NO |
| `org:members:read` (Ver lista de miembros y roles) | **SÍ** | **SÍ** | **SÍ** | **SÍ** | **SÍ** |
| `org:members:invite_and_manage` (Invitar miembros, cambiar roles, revocar acceso) | **SÍ** | **SÍ** | NO | NO | NO |
| `org:members:reset_mfa` (Resetear MFA de miembros no-Owner de la organización) | **SÍ** | **SÍ** | NO | NO | NO |
| **Proyectos, Dominios y API Keys** | | | | | |
| `projects:read` (Ver proyectos y configuración general) | **SÍ** | **SÍ** | **SÍ** | NO | **SÍ** |
| `projects:create_update_delete` (Crear, editar o eliminar proyectos) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| `domains:manage` (Añadir o eliminar `allowed_domains` para el SDK) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| `apikeys:read_metadata` (Ver prefijos, fechas de uso y estado de API Keys) | **SÍ** | **SÍ** | **SÍ** | NO | **SÍ** |
| `apikeys:create_rotate_revoke` (Generar, rotar o revocar `pk_live_` y `sk_live_`) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| **Entrenamiento Visual, Mapa RAG y Estudio del Prompt** | | | | | |
| `trainer:session:launch` (Iniciar navegador remoto o conectar CLI de entrenamiento) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| `rag_map:read` (Visualizar el Mapa Funcional RAG y sus elementos en UI o JSON) | **SÍ** | **SÍ** | **SÍ** | NO | **SÍ** |
| `rag_map:write_and_publish` (Capturar elementos, editar JSON y publicar versión SHA-256) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| `prompt_studio:read` (Ver el System Prompt, flujo de pasos e historial de versiones) | **SÍ** | **SÍ** | **SÍ** | NO | **SÍ** |
| `prompt_studio:write_and_publish` (Editar System Prompt en UI o vía API y publicar) | **SÍ** | **SÍ** | **SÍ** | NO | NO |
| **Sesiones de Voz, Analítica y Auditoría del Tenant** | | | | | |
| `voice_sessions:read_metrics` (Ver métricas de sesiones, pasos completados y acciones) | **SÍ** | **SÍ** | **SÍ** | **SÍ** | **SÍ** |
| `org:audit_logs:read` (Consultar bitácora de auditoría de su propia organización) | **SÍ** | **SÍ** | NO | **SÍ** | NO |
| **Facturación, Consumo y Whop** | | | | | |
| `billing:usage:read` (Ver minutos consumidos, saldo actual y libro mayor `usage_ledger`) | **SÍ** | **SÍ** | **SÍ** | **SÍ** | **SÍ** |
| `billing:whop:manage_subscription` (Contratar/Cambiar planes $5-$50, PAYG y Portal Whop) | **SÍ** | **SÍ** | NO | **SÍ** | NO |
| `billing:spend_limits:update` (Configurar topes de gasto mensual y alertas de exceso) | **SÍ** | **SÍ** | NO | **SÍ** | NO |
| `billing:invoices:export` (Descargar historial de cobros y exportar CSV contable) | **SÍ** | **SÍ** | NO | **SÍ** | NO |
