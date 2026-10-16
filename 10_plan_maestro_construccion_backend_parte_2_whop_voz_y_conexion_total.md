# PLAN MAESTRO DE CONSTRUCCIÓN DEL BACKEND POR PARTES (VOLUMEN 2: WHOP, MOTOR DE VOZ REALTIME, SUPERADMIN Y AUTO-CONEXIÓN TOTAL — PARTES 9 A 16)

Este documento continúa el Plan Maestro de Construcción del Backend desde la **Parte 9 hasta la Parte 16**, cubriendo la pasarela de pagos **Whop**, el motor de cobro por minuto con bloqueo pesimista y descuentos por volumen desde `$50 USD`, el **Gateway de Voz Realtime** con adaptador dual para **Qwen3.8-Omni-Flash-Realtime** y **Gemini 3.8 Live**, la consola de gobierno **SuperAdmin**, los endpoints públicos de demostración/sandbox y el ensamblaje automático final de los 3 Node Pools de producción.

---

## 1. Especificación Exhaustiva de Trabajo: PARTES 9 A 16

> **Recordatorio Operativo:** Cada Parte mantiene un volumen de salida de **`1,150 a 1,750 líneas` repartidas en `4 a 6 archivos`** (`<400 líneas` por archivo). Tanto **Gemini 3.8 Flash** (`~3,000–3,500 líneas` seguras) como **DeepSeek V4.1 Flash** (`~18,000–19,000 líneas` seguras) pueden ejecutar cada Parte sin resumir ni omitir una sola línea de código.

---

### PARTE 9: Módulo 04-A — Integración con Pasarela WHOP (Checkout Firmado, Portal de Cliente y Webhooks HMAC-SHA256 con Idempotencia)

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,340 líneas` repartidas en `4 archivos` (`310 a 360 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/crypto.util.ts`, `src/shared/infrastructure/database/rls-pool.ts`, `src/shared/ports/billing-voice-admin.ports.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/04-billing-and-whop/domain/billing-whop.entities.ts` (`~310 líneas`):
     * Cabecera documental en español.
     * Define las entidades y contratos de datos para `PricingPlanConfig` (`PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50`), `VolumeDiscountTier`, `OrganizationPricingOverride`, `WhopSubscriptionState`, `UsageLedgerEntry` y los payloads tipados de los eventos de Webhook de Whop (`membership.went_valid`, `membership.went_invalid`, `payment.succeeded`).
  2. `src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter.ts` (`~330 líneas`):
     * Cliente HTTP hacia la API v2 de Whop (`createCheckoutSession`, `getCustomerPortalUrl`, `fetchMembershipStatus`) firmando los metadatos `{ organization_id, actor_user_id, internal_plan_code }` con `HMAC-SHA256`.
     * Verificador criptográfico de Webhooks (`verifyWhopWebhookSignature(rawBodyBuffer, signatureHeader, timestampHeader)`):
       * Valida ventana anti-replay (`<= 300 segundos`).
       * Calcula `HMAC-SHA256(timestamp + "." + rawBody, WHOP_WEBHOOK_SECRET)` y compara con `CryptoUtils.timingSafeEqualHex()`.
  3. `src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository.ts` (`~360 líneas`):
     * Consultas transaccionales con RLS sobre `whop_subscriptions`, `usage_ledger`, `pricing_plans_config` y `organization_pricing_overrides`.
     * Implementa las operaciones de lectura y actualización bajo bloqueo pesimista exclusivo `SELECT ... FROM whop_subscriptions WHERE organization_id = $1 FOR UPDATE`.
  4. `src/modules/04-billing-and-whop/application/whop-checkout-and-webhooks.use-case.ts` (`~340 líneas`):
     * `CreateWhopCheckoutSessionUseCase`: Genera la URL de Checkout en Whop para contratar planes de `$5`, `$10`, `$30`, `$50 USD/mes`, activar `PAYG` o realizar recargas de saldo (`Top-Up`), verificando que la organización haya firmado previamente el `DPA_ENTERPRISE`.
     * `ProcessWhopWebhookUseCase`:
       1. Garantiza idempotencia atómica en Redis (`SET whop:webhook:evt:<event_id> "PROCESSING" NX EX 172800`) y en `usage_ledger.external_whop_event_id UNIQUE`.
       2. Para **`membership.went_valid`**: Adquiere bloqueo `FOR UPDATE`, activa la suscripción, asigna `period_included_minutes_remaining` según el plan contratado e inserta asiento `PLAN_ACTIVATION_GRANT` en `usage_ledger`.
       3. Para **`membership.went_invalid`**: Adquiere bloqueo `FOR UPDATE`, marca estado `PAST_DUE_OR_INVALID`, congela minutos incluidos, actualiza Redis y si no tiene saldo prepagado corta nuevas sesiones.
       4. Para **`payment.succeeded`**: Adquiere bloqueo `FOR UPDATE`, renueva el cupo mensual de minutos incluidos y reinicia el contador de excesos (`period_overage_minutes_used = 0`) con asiento `PAYMENT_SUCCEEDED_RENEWAL`, o suma saldo prepagado en dólares con asiento `PAYMENT_SUCCEEDED_TOPUP`.

---

### PARTE 10: Módulo 04-B — Algoritmo Matemático de Tarificación (Planes $5-$50, Escalafón de Descuento por Volumen $50+, Overrides SuperAdmin) y Deducción Pesimista de Minutos

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,290 líneas` repartidas en `4 archivos` (`290 a 350 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/decimal.util.ts`, `src/modules/04-billing-and-whop/infrastructure/postgres-billing.repository.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/04-billing-and-whop/application/calculate-effective-rate.use-case.ts` (`~330 líneas`):
     * Implementa el motor matemático determinista con precisión de 6 decimales (`DecimalMath`):
       * Evalúa los minutos incluidos restantes del plan (`$5`, `$10`, `$30`, `$50`).
       * Calcula la partición exacta cuando una sesión cruza el límite entre minutos incluidos y minutos en exceso (`Overage`).
       * Determina la tarifa base aplicando prioridad absoluta al **Override del SuperAdmin** (`organization_pricing_overrides.custom_rate_per_minute_usd`) si está vigente.
       * Aplica automáticamente el **Escalafón de Descuento por Volumen Escalonado** cuando el cliente está en el **Plan de `$50 USD`** (o supera los `$50 USD` de consumo mensual / tiene flag `force_volume_discount_tiers = true`), evaluando los tramos (`0-1,000 min: 10%`, `1,001-5,000 min: 20%`, `5,001-25,000 min: 35%`, `>25,000 min: 50%` o los tramos personalizados de esa organización).
       * Aplica el `manual_discount_percentage` asignado por el SuperAdmin si existe.
  2. `src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case.ts` (`~340 líneas`):
     * `DeductSessionMinutesUseCase`:
       * Ejecuta la transacción con bloqueo pesimista `RlsDatabasePool.runWithPessimisticOrgLock(organizationId, ...)` eliminando al 100% las condiciones de carrera entre múltiples sesiones de voz concurrentes.
       * Descuenta los minutos incluidos o el saldo en dólares, actualiza `whop_subscriptions`, inserta el asiento inmutable `VOICE_MINUTE_DEDUCTION` en `usage_ledger` y comprueba si se alcanzó el tope de protección de gasto (`hard_spend_cap_usd`) o agotamiento de fondos.
  3. `src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case.ts` (`~300 líneas`):
     * Consultas para el Panel de Consumo del Desarrollador (`/dashboard/org/:orgSlug/billing`): estado actual del plan, minutos restantes, tramo de descuento activo, configuración de topes de gasto (`hard_spend_cap_usd`), historial paginado de `usage_ledger` y exportador CSV contable.
  4. `src/modules/04-billing-and-whop/billing-whop.manifest.ts` (`~320 líneas`):
     * Implementa el puerto `IBillingWhopPort` y registra todos los endpoints `/api/v1/billing/*` y `/api/v1/webhooks/whop` (con soporte de `rawBody`) en `registerBillingWhopModule()`.

---

### PARTE 11: Módulo 05-A — Adaptador en Tiempo Real para `Qwen3.8-Omni-Flash-Realtime`

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,180 líneas` repartidas en `4 archivos` (`270 a 320 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/ports/billing-voice-admin.ports.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types.ts` (`~290 líneas`):
     * Define las declaraciones JSON Schema estrictas de las 3 herramientas físicas del asistente (`click_element`, `type_text`, `advance_onboarding_step`), la estructura de los frames binarios de audio (`PCM16 Little-Endian 16kHz / 24kHz`), y la máquina de estados del flujo paso a paso (`OnboardingStepStateMachine`).
  2. `src/modules/05-voice-realtime-gateway/infrastructure/audio-pcm16-ring-buffer.ts` (`~270 líneas`):
     * Implementa un **Ring Buffer en Memoria Volátil (Zero Raw Audio Persistence)** que procesa chunks de audio de `20ms` (`640 bytes`), calcula energía RMS para asistir al detector de silencio/voz (VAD) y sobrescribe inmediatamente la memoria tras enviar los frames, cumpliendo por diseño la política de privacidad de no almacenar grabaciones crudas en disco.
  3. `src/modules/05-voice-realtime-gateway/infrastructure/qwen-38-omni.adapter.ts` (`~340 líneas`):
     * Implementa `IVoiceRealtimeProvider` e `IActiveProviderStream` para **`Qwen3.8-Omni-Flash-Realtime`**:
       * Conexión WebSocket persistente con cabeceras de autenticación, envío de `session.update` con el System Prompt paso a paso, voz seleccionada, temperatura y declaraciones de herramientas (`click_element`, `type_text`, `advance_onboarding_step`).
       * Streaming de entrada `input_audio_buffer.append` y actualización en caliente de contexto por ruta (`updateDynamicRouteContext`) cuando el usuario navega en su aplicación.
       * Ejecución instantánea de **Barge-in** (`triggerImmediateBargeInCancel`) enviando `response.cancel` + `output_audio_buffer.clear` en `<5ms`.
       * Recepción de llamadas a herramientas (`response.function_call_arguments.done`) y envío de resultados (`conversation.item.create` con `function_call_output` tras recibir el ACK del SDK).
  4. `src/modules/05-voice-realtime-gateway/infrastructure/qwen-protocol.mapper.ts` (`~280 líneas`):
     * Mapeador y validador de tramas de protocolo específicas de Qwen3.8-Omni, manejo de reconexión transparente de stream y traducción de errores a `ProviderStreamError`.

---

### PARTE 12: Módulo 05-B — Adaptador en Tiempo Real para `Gemini 3.8 Live` y Conmutador Dual con Failover Automático

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,220 líneas` repartidas en `4 archivos` (`280 a 330 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/ports/billing-voice-admin.ports.ts`, `src/modules/05-voice-realtime-gateway/domain/voice-session-and-tools.types.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/05-voice-realtime-gateway/infrastructure/gemini-38-live.adapter.ts` (`~340 líneas`):
     * Implementa `IVoiceRealtimeProvider` e `IActiveProviderStream` para **`Gemini 3.8 Live`** (`BidiGenerateContent`):
       * Envío de trama inicial `setup` (`model: "models/gemini-3.8-live"`, `generationConfig: { responseModalities: ["AUDIO"], temperature, speechConfig }`, `systemInstruction` con los pasos del desarrollador y `tools: [{ functionDeclarations }]`).
       * Transmisión continua de audio PCM16 a 16kHz en `realtimeInput.mediaChunks`, recepción de audio de salida (`serverContent.modelTurn.parts[].inlineData`) y transcripción incremental.
       * Manejo nativo de interrupción (`serverContent.interrupted === true` y corte inmediato ante `triggerImmediateBargeInCancel()`).
       * Recepción de `toolCall.functionCalls` (`click_element`, `type_text`, `advance_onboarding_step`) y envío de `toolResponse.functionResponses` cuando el SDK confirma la ejecución en el DOM.
  2. `src/modules/05-voice-realtime-gateway/infrastructure/gemini-protocol.mapper.ts` (`~280 líneas`):
     * Serializador/deserializador de mensajes `BidiGenerateContent` de Gemini 3.8 Live, conversión de sample-rate si se requiere y control de latencia `TTFA` (Time-To-First-Audio).
  3. `src/modules/05-voice-realtime-gateway/infrastructure/dual-provider-orchestrator.ts` (`~310 líneas`):
     * Orquestador que selecciona para cada sesión el proveedor configurado en el proyecto (`primary_voice_model`), respeta el **Kill-Switch Global** del SuperAdmin si un proveedor fue deshabilitado en caliente, y ejecuta **Failover Automático** en `<800ms` hacia el modelo de respaldo (`fallback_voice_model`) si el proveedor primario falla al abrir el stream o supera el umbral de timeout.
  4. `src/modules/05-voice-realtime-gateway/infrastructure/postgres-voice-session.repository.ts` (`~290 líneas`):
     * Persistencia RLS para `voice_sessions` y `action_events`, más sincronización de estado en vivo en Redis (`voice_session:state:<session_id>` y registro en `org:<org_id>:active_sessions`).

---

### PARTE 13: Módulo 05-C — Servidor WebSocket del Gateway de Voz, Barge-in `<50ms`, Context Slimming en Vivo, Despacho de Herramientas DOM y Pulso de Cobro cada 15s

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,480 líneas` repartidas en `4 archivos` (`350 a 390 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/modules/05-voice-realtime-gateway/infrastructure/dual-provider-orchestrator.ts`, `src/shared/ports/core-modules.ports.ts`, `src/shared/ports/billing-voice-admin.ports.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case.ts` (`~360 líneas`):
     * `DispatchDomToolUseCase`:
       1. Recibe la solicitud `click_element`, `type_text` o `advance_onboarding_step` emitida por `Qwen3.8-Omni` o `Gemini 3.8 Live`.
       2. Verifica contra la máquina de estados del proyecto si `strict_step_enforcement === true` (impidiendo saltar al paso `N+1` sin completar el paso `N`).
       3. Invoca `IVisualRagAndPromptPort.validateElementActionGuardrail()` para confirmar que el `element_id` pertenece a la ruta activa, tiene `is_actionable === true` y soporta la acción solicitada (`CLICK`, `TYPE` o `BOTH`). Si no cumple, devuelve `REJECTED_BY_GUARDRAIL` al modelo IA sin enviarlo al navegador.
       4. Registra el evento en `action_events` (`status = 'DISPATCHED'`), envía la trama `tool.execute` con la cascada de selectores y coordenadas responsive al `@onboarding-assistant/sdk`, espera el `tool.execution.ack` (con timeout de seguridad de 5s), actualiza `action_events` (`ACK_SUCCESS` o `BLOCKED_SENSITIVE_FIELD`) y reenvía el resultado al modelo de voz.
  2. `src/modules/05-voice-realtime-gateway/application/voice-session-metering.service.ts` (`~350 líneas`):
     * Ejecuta el temporizador determinista de **Pulso de Deducción cada 15 segundos** (`Metering Tick`) y la liquidación exacta al cerrarse el WebSocket:
       * Llama a `IBillingWhopPort.deductVoiceSessionSlicePessimistic(orgId, projectId, sessionId, elapsedSeconds)`.
       * Si el módulo de facturación devuelve `INSUFFICIENT_FUNDS` o `SPEND_CAP_REACHED`, ordena al stream de voz pronunciar un mensaje breve de cierre cortés, envía la trama de control al SDK y cierra el WebSocket con código `4002_PAYMENT_REQUIRED`.
  3. `src/modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case.ts` (`~390 líneas`):
     * Orquesta el ciclo de vida completo de una conexión WebSocket en `wss://voice.plataforma.com/ws/v1/realtime`:
       * Consume de forma atómica (`GETDEL`) el nonce efímero de handshake (`sdk_handshake:nonce:<jti>`).
       * Carga el System Prompt paso a paso y ejecuta el primer *Context Slimming* para la ruta inicial.
       * Procesa tramas binarias `0x01` (Audio PCM16 Uplink) y tramas JSON `0x02` (`route.changed` ➔ dispara *Context Slimming* en `<2ms` e inyecta los nuevos elementos DOM al modelo IA; `voice.barge_in` ➔ invoca `triggerImmediateBargeInCancel()` en `<5ms` e incrementa `barge_in_count`; `tool.execution.ack` ➔ resuelve la promesa de la herramienta activa).
  4. `src/modules/05-voice-realtime-gateway/voice-gateway.manifest.ts` (`~380 líneas`):
     * Implementa `IVoiceGatewayControlPort` (suscrito al `DomainEventBus` para cerrar en `<10ms` todas las sesiones de una organización con código `4003_TENANT_SUSPENDED` si el SuperAdmin la suspende) y registra el servidor WebSocket y endpoints de métricas de sesiones en `registerVoiceGatewayModule()`.

---

### PARTE 14: Módulo 06 — Consola de Gobierno SuperAdmin (Suspensión de Cuentas, Matriz Global Whop, Overrides por Cliente, Monitor de Infraestructura y Auditoría Inmutable)

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,360 líneas` repartidas en `4 archivos` (`320 a 360 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/ports/billing-voice-admin.ports.ts`, `src/shared/infrastructure/database/rls-pool.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/06-superadmin-governance/infrastructure/postgres-superadmin-audit.repository.ts` (`~350 líneas`):
     * Implementa `IAuditLoggerPort` insertando registros en `audit_logs` encadenados criptográficamente (`record_sha256 = SHA-256(prev_record_sha256 + payload_canonico)`) para cumplir auditorías SOC2.
     * Consultas globales (ejecutadas bajo `RlsDatabasePool.runInSuperAdminTransaction()`) para listar y filtrar todas las organizaciones, usuarios, sesiones de voz activas y eventos de seguridad (incluyendo intentos bloqueados por el escudo Anti-SSRF).
  2. `src/modules/06-superadmin-governance/application/tenant-governance.use-case.ts` (`~330 líneas`):
     * `SuspendOrganizationUseCase`: Cambia `organizations.status = 'SUSPENDED'`, purga de Redis todas las claves de API Keys de esa organización, publica el evento `TENANT_SUSPENDED` en `DomainEventBus` (cortando en vivo todos sus WebSockets activos en todos los nodos del Gateway) y registra en `audit_logs`.
     * `ReactivateOrganizationUseCase`, `ForceGlobalLogoutOrganizationUseCase` y `ApproveBreakGlassMfaResetUseCase`.
  3. `src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case.ts` (`~340 líneas`):
     * `UpdateGlobalWhopPricingMatrixUseCase`: Permite al SuperAdmin actualizar las tarifas por minuto de Pago por Uso Puro (`PAYG`), los minutos incluidos y precios de los planes de `$5`, `$10`, `$30` y `$50 USD`, y los tramos globales de descuento por volumen escalonado (`volume_discount_tiers_json`).
     * `SetOrganizationPricingOverrideUseCase` y `GrantPromotionalMinutesUseCase`: Permite asignar una tarifa personalizada por minuto (`custom_rate_per_minute_usd`), un porcentaje de descuento manual (`0% a 100%`), tramos de volumen exclusivos o acreditar minutos de cortesía a un cliente específico.
  4. `src/modules/06-superadmin-governance/superadmin.manifest.ts` (`~340 líneas`):
     * Incluye el endpoint de telemetría en tiempo real vía Server-Sent Events (`GET /api/v1/superadmin/telemetry/stream`), el **Kill-Switch de Proveedor de Voz IA** (`POST /api/v1/superadmin/infrastructure/voice-provider-switch`) y registra todas las rutas `/api/v1/superadmin/*` protegidas con `requireSuperAdminFido2()` en `registerSuperAdminModule()`.

---

### PARTE 15: Endpoints Públicos Comerciales (Demo de Voz en Vivo, Calculadora de Precios Whop y Simulador del Sandbox de Documentación) + Paquete `@onboarding-assistant/sdk` Core

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,410 líneas` repartidas en `5 archivos` (`260 a 310 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `01_MODULO_1_ARQUITECTURA_UI_IDENTIDAD_PANELES_Y_LEGAL.md`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case.ts` (`~310 líneas`):
     * `GetPublicPricingMatrixUseCase` (`GET /api/v1/public/pricing-matrix`): Devuelve las tarifas base, los planes de `$5`, `$10`, `$30`, `$50 USD` y los tramos de descuento por volumen para hidratar en tiempo real la `<InteractivePricingCalculator />` de la Landing Comercial.
     * `CreatePublicLiveDemoSessionUseCase` (`POST /api/v1/public/demo-session`): Valida token Cloudflare Turnstile y Rate Limit por IP en Redis (máximo 2 demos de 90 segundos por IP cada 24h) y emite un JWT efímero aislado para probar `Qwen3.8-Omni` o `Gemini 3.8 Live` sobre el lienzo simulado de la Landing Comercial.
  2. `src/modules/07-public-commercial-and-sandbox/public-commercial.manifest.ts` (`~260 líneas`):
     * Registra los endpoints públicos `/api/v1/public/*` y el validador de eventos de prueba `click_element` / `type_text` para el Sandbox de Documentación (`/docs/sandbox`).
  3. `packages/sdk/src/security/sensitive-field-scrubber.ts` (`~250 líneas`):
     * Implementa el bloqueador de seguridad en cliente que impide leer, seleccionar o ejecutar `type_text` / `click_element` sobre inputs `type="password"`, `autocomplete^="cc-"`, `[data-oa-sensitive="true"]` o iframes de pago.
  4. `packages/sdk/src/dom/action-executor.ts` (`~310 líneas`):
     * Motor físico del SDK que recibe las órdenes `tool.execute` (`click_element` y `type_text`) desde el Gateway de Voz, resuelve la cascada de selectores o las coordenadas responsive (`bbox_norm`), anima el cursor asistido, dispara la secuencia de eventos nativos compatibles con React/Vue/Angular y devuelve el paquete `tool.execution.ack` con la duración en milisegundos.
  5. `packages/sdk/src/core/sdk-client.ts` (`~280 líneas`):
     * Cliente oficial `@onboarding-assistant/sdk` (`OnboardingAssistant.init()`): verifica el consentimiento de voz del usuario final, ejecuta el handshake `POST /api/v1/sdk/handshake`, abre el WebSocket binario PCM16 con `AudioWorklet`, detecta *Barge-in* local en `<5ms`, emite `route.changed` al navegar en SPAs y coordina el `action-executor`.

---

### PARTE 16: Ensamblaje Automático del Monolito Modular Hexagonal, Los 3 Entrypoints de Despliegue y Verificación Integral End-to-End

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (o `Gemini 3.8 Flash`).
* **Presupuesto Total Estimado:** `~1,150 líneas` repartidas en `5 archivos` (`190 a 270 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md` y los manifiestos `*.manifest.ts` de las Partes 5, 6, 8, 10, 13, 14 y 15.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/bootstrap/module-autoloader.ts` (`~260 líneas`):
     * Instancia `RlsDatabasePool`, `RedisClusterClient`, `TokenBucketRateLimiter`, `DomainEventBus` y `DependencyContainer`.
     * Invoca en orden determinista los manifiestos de todos los módulos (`registerIdentityModule`, `registerProjectsKeysModule`, `registerVisualTrainerRagModule`, `registerBillingWhopModule`, `registerVoiceGatewayModule`, `registerSuperAdminModule`, `registerPublicCommercialModule`), verificando al arrancar que todos los símbolos de `DI_TOKENS` tengan una implementación registrada.
  2. `src/bootstrap/api-control-plane.main.ts` (`~210 líneas`):
     * Entrypoint de producción para el pool `api-control-plane` (APIs REST de Auth, Dashboard, Mapas RAG, Webhooks Whop y SuperAdmin) con cierre elegante (`Graceful Shutdown` en `SIGTERM`/`SIGINT`).
  3. `src/bootstrap/voice-realtime-gateway.main.ts` (`~220 líneas`):
     * Entrypoint de producción optimizado para el pool `voice-realtime-gateway` (Servidor WebSocket binario de baja latencia, drenado limpio de sesiones de voz activas y liquidación final en `usage_ledger` antes de apagar un nodo).
  4. `src/bootstrap/visual-trainer-orchestrator.main.ts` (`~200 líneas`):
     * Entrypoint aislado en la red DMZ para el pool `visual-trainer-orchestrator` (gestión de contenedores efímeros Chromium con escudo Anti-SSRF y destrucción garantizada de contenedores al apagar).
  5. `tests/e2e/backend-full-wiring.spec.ts` (`~260 líneas`):
     * Prueba de integración de extremo a extremo que verifica que todos los puertos, adaptadores, políticas RLS, deducción pesimista de Whop, *Context Slimming* y despacho de `click_element` / `type_text` están conectados y responden según el contrato arquitectónico.

---

## 2. Plantilla de Prompt Exacta para Entregar cada Parte a tus IAs (`Copy & Paste`)

Cada vez que vayas a ejecutar una de las 16 Partes en **Gemini 3.8 Flash** o **DeepSeek V4.1 Flash**, usa exactamente este prompt de activación:

```markdown
Actúa como nuestro Principal Software Architect implementando en código de producción la **[ESCRIBIR AQUÍ: PARTE X]** del Plan Maestro de Construcción del Backend (`09_PLAN_MAESTRO...` / `10_PLAN_MAESTRO...`).

REGLAS OBLIGATORIAS DE EJECUCIÓN:
1. Aplica estrictamente la skill `reglas-globales-construccion-codigo` y la skill `documentadora-live-contexto`.
2. Lee primero `docs/LIVE_ARCHITECTURE_LEDGER.md` y únicamente los archivos listados en "Archivos de Lectura Previa Obligatoria" de la PARTE X.
3. Crea TODOS los archivos listados en la PARTE X con su código 100% completo y listo para producción. Está terminantemente prohibido resumir código, truncar funciones o escribir placeholders (`// TODO`, `// implementar aquí`, `...`).
4. Ningún archivo puede superar las 500 líneas de código (mantén cada archivo dentro del presupuesto de 200 a 390 líneas indicado en la PARTE X; si necesitas más espacio, crea un sub-archivo auxiliar adicional).
5. Incluye en la línea 1 de cada archivo el bloque de cabecera documental en español (`@archivo`, `@modulo`, `@proposito`, `@resumen_contenido`, `@dependencias_internas`, `@tablas_bd_o_redis`) y comenta cada función/método en español.
6. Al terminar de escribir los archivos, verifica el conteo de líneas con `wc -l` y actualiza obligatoriamente `docs/LIVE_ARCHITECTURE_LEDGER.md` registrando los archivos creados, sus líneas reales y sus exportaciones.
```
