# BACKLOG DE TRABAJO AUDITADO Y TAREAS FUTURAS

**Fecha de Auditoría:** 2026-10-14  
**Origen:** Auditoría Adversarial de las 16 Partes del Backend  
**Estado:** PENDIENTE DE ASIGNACIÓN Y DIVISIÓN POR EL USUARIO  
**Regla de Ejecución:** NO EJECUTAR NINGUNA TAREA HASTA AUTORIZACIÓN EXPLÍCITA.

---

## 1. BLOQUEANTES DE PRODUCCIÓN (Lo que impide desplegar)

Tareas críticas indispensables para habilitar el despliegue a producción de forma segura y operativa:

- [x] **BP-01: Corrección de Suplantación de Organización (Tenant Spoofing) en WebSocket de Voz**
  - **Ubicación:** `src/bootstrap/voice-realtime-gateway.main.ts` y `src/modules/02-projects-and-keys/application/sdk-handshake.use-case.ts`.
  - **Estado:** RESUELTO Y VERIFICADO. `consumeEphemeralWsNonce` devuelve el `organizationId` canónico persistido al emitir el nonce, `handle-voice-websocket.use-case.ts` rechaza cualquier discrepancia con `VOICE_CLOSE_CODES.UNAUTHORIZED`, y el entrypoint `voice-realtime-gateway.main.ts` enlaza el registro y el control de sesiones vivas con `session.getAuthenticatedOrganizationId()`.

- [x] **BP-02: Idempotencia y Blindaje contra Doble Señal en Cierre Elegante**
  - **Ubicación:** `src/bootstrap/bootstrap-runtime.ts`.
  - **Estado:** RESUELTO Y VERIFICADO. Las señales concurrentes (`SIGINT`/`SIGTERM`) se encadenan a la promesa `inFlightShutdown: Promise<unknown> | null` sin interrumpir liquidaciones ni abortar con código 1 prematuramente. Verificado en `tests/unit/graceful-shutdown-signals.test.ts`.

- [x] **BP-03: Montaje del Pipeline de Autenticación EdDSA JWT en el Servidor HTTP del Plano de Control**
  - **Ubicación:** `src/bootstrap/api-control-plane.server.ts` y `src/bootstrap/session-auth.middleware.ts`.
  - **Estado:** RESUELTO Y VERIFICADO. Se extrajo y conectó el middleware `session-auth.middleware.ts` enlazado con `system.authVerifier`. Todas las rutas protegidas evalúan autenticación y RBAC eliminando por completo el error HTTP 503. Verificado en `tests/integration/api-control-plane-auth-border.test.ts`.

- [x] **BP-04: Configuración del Rol de Base de Datos `oa_app` sin `BYPASSRLS`**
  - **Ubicación:** `migrations/007_application_role_without_bypassrls_and_identity_rls.sql` y `scripts/verify-production.ts`.
  - **Estado:** DDL Y COBERTURA RESUELTOS. El rol `oa_app` sin `BYPASSRLS` y las políticas RLS sobre tablas de identidad están completamente definidos en la migración 007. Para despliegue productivo solo resta aprovisionar credenciales en variables de entorno de la nube.

---

## 2. SEGURIDAD

Refuerzo de defensas en profundidad, políticas RLS y mitigación de fugas de información:

- [ ] **SEG-01: Cobertura RLS en las 6 Tablas de Identidad y Catálogo Huérfanas**
  - **Ubicación:** `migrations/` y esquema PostgreSQL.
  - **Detalle:** Las tablas `users`, `auth_sessions`, `password_reset_tokens`, `user_mfa_recovery_codes`, `legal_documents` y `pricing_plans_config` no tienen habilitado `ROW LEVEL SECURITY`.
  - **Acción:** Evaluar y crear migración con políticas RLS basadas en `app.current_user_id` y `app.is_superadmin` para aislar sesiones y tokens de recuperación, manteniendo `pricing_plans_config` y `legal_documents` como solo lectura para usuarios autenticados y mutables solo por SuperAdmin.

- [ ] **SEG-02: Mitigación de Enumeración de Usuarios en Endpoints Públicos de Autenticación**
  - **Ubicación:** `src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts` y `src/bootstrap/api-control-plane.server.ts`.
  - **Detalle:** `POST /api/v1/auth/register` lanza `ConflictError('El correo electronico ya se encuentra registrado...')`, y el servidor HTTP propaga textualmente el mensaje al cliente, permitiendo deducir si un email existe en la plataforma.
  - **Acción:** Homogeneizar los mensajes de error en endpoints públicos y aplicar retrasos temporales constantes para evitar la discriminación por tiempo o mensaje.

- [ ] **SEG-03: Gestión y Rotación Segura de Claves EdDSA (Ed25519)**
  - **Ubicación:** `src/config/env.zod-schema.ts` y despliegue.
  - **Detalle:** Las claves privadas PKCS#8 y públicas SPKI residen en variables de entorno planas (`AUTH_ED25519_PRIVATE_KEY_PEM`).
  - **Acción:** Integrar soporte para proveedores de secretos en la nube (AWS Secrets Manager, GCP Secret Manager o HashiCorp Vault) y diseñar el mecanismo de rotación sin caída con soporte de doble verificación (clave actual y clave previa mediante `kid`).

- [ ] **SEG-04: Corrección de Nivel de Acceso de la Ruta `/api/v1/sdk/handshake`**
  - **Ubicación:** `src/modules/02-projects-and-keys/projects-keys.manifest.ts`.
  - **Detalle:** La ruta declara `access: 'PUBLIC'` en lugar de `access: 'SDK_HANDSHAKE'`, saltándose la verificación preliminar de la cabecera `Origin` en el servidor HTTP de borde.
  - **Acción:** Actualizar la declaración a `access: 'SDK_HANDSHAKE'` para mantener coherencia con `RouteAccessLevel`.

- [ ] **SEG-05: Validación y Rotación de Secretos HMAC en Webhooks de Whop**
  - **Ubicación:** `src/modules/04-billing-and-whop/application/process-whop-webhook.use-case.ts`.
  - **Detalle:** Soporte de rotación suave del secreto de webhook de Whop para permitir renovación periódica sin interrumpir eventos de cobro en vuelo.

---

## 3. RENDIMIENTO

Optimización de tiempos de respuesta, consultas de base de datos y memoria:

- [ ] **PERF-01: Índices Compuestos para Rutas de Alta Frecuencia**
  - **Ubicación:** `migrations/`.
  - **Detalle:** Las consultas de telemetría, facturación y auditoría realizan filtrados frecuentes sobre tuplas específicas.
  - **Acción:** Crear índices compuestos en:
    - `voice_sessions (organization_id, status)`
    - `usage_ledger (organization_id, created_at DESC)`
    - `action_events (voice_session_id, step_number)`
    - `audit_logs (organization_id, created_at DESC)`

- [ ] **PERF-02: Erradicación de Patrones N+1 en Listados de Proyectos y Dominios**
  - **Ubicación:** `src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository.ts`.
  - **Detalle:** Obtener proyectos junto con sus dominios permitidos y claves de API activas puede incurrir en múltiples consultas secuenciales.
  - **Acción:** Implementar consultas con agregación JSON (`json_agg`) o uniones eficientes (`JOIN`) para resolver el grafo relacional en un único viaje de ida y vuelta a Neon.

- [ ] **PERF-03: Dimensionamiento y Tuning del Pool de Conexiones por Tipo de Nodo**
  - **Ubicación:** `src/shared/infrastructure/database/rls-pool.ts`.
  - **Detalle:** Cada pool (`API_CONTROL_PLANE`, `VOICE_REALTIME_GATEWAY`, `VISUAL_TRAINER`) compite por conexiones en el servidor PostgreSQL Neon.
  - **Acción:** Configurar límites diferenciados de `max` conexiones según el perfil: más conexiones para el plano de control y un pool optimizado para el gateway de voz con timeouts reducidos.

- [ ] **PERF-04: Reutilización de Buffers y Optimización de Memoria en Streaming de Audio**
  - **Ubicación:** `src/modules/05-voice-realtime-gateway/infrastructure/audio-pcm16-ring-buffer.ts`.
  - **Detalle:** Las sesiones de voz procesan tramas de audio continuas cada 20 ms, pudiendo generar presión sobre el recolector de basura (GC) de Node.js.
  - **Acción:** Implementar un pool de buffers preasignados (`Buffer.allocUnsafe` controlado) para evitar asignaciones dinámicas repetitivas en la ruta caliente del audio.

---

## 4. FRONTEND (Los 3 Portales)

Construcción completa de las interfaces de usuario web (ninguno existe actualmente):

- [ ] **FE-01: Portal Landing Comercial (`/`)**
  - **Estética:** Auros Light Mode (`#F2FBF9`, radios `16px/6px`, cero sombras).
  - **Componentes:**
    - Hero interactivo con la Esfera Bioluminiscente de Voz.
    - Demostración de Voz en Vivo conectando a `/api/v1/public/demo-session` y WebSocket efímero.
    - Calculadora Interactiva de Planes consumiendo `/api/v1/public/pricing-matrix`.
    - Selector dinámico de volumen de minutos y cálculo de excedentes.

- [ ] **FE-02: Portal Dashboard del Desarrollador (`/dashboard`)**
  - **Estética:** Cursor Atelier Light (`#f7f7f4` Parchment, `#f2f1ed` Bone, `#26251e` Ink, `#f54e00` Ember, radios `4px`).
  - **Componentes:**
    - Gestión de Proyectos, Dominios Autorizados y Claves de API (`pk_live_`, `sk_live_`).
    - Consola de Visual Trainer: visualizador de sesiones Chromium y etiquetado de elementos DOM.
    - Editor y Visor de Mapa Funcional RAG inmutable (con árbol de pasos e historial de hashes SHA-256).
    - Métricas de consumo, saldo prepagado, excedentes y descarga del libro mayor contable en CSV.

- [ ] **FE-03: Portal SuperAdmin de Gobernanza (`/superadmin`)**
  - **Estética:** Cursor Atelier Light con variantes de advertencia/peligro.
  - **Componentes:**
    - Panel de Organizaciones: suspensión y reactivación inmediata con corte de sesiones de voz en vivo.
    - Forzado de Logout global (incremento atómico de `token_version`).
    - Editor de la Matriz Global de Precios Whop e inyección de Overrides por tenant.
    - Kill-Switch de Emergencia para motores de voz (Qwen Omni vs Gemini Live).
    - Visor de Auditoría Inmutable encadenada SOC2 con verificación criptográfica de SHA-256.

- [ ] **FE-04: Sandbox y Documentación Interactiva (`/docs/sandbox`)**
  - **Estética:** Cursor Atelier Light.
  - **Componentes:**
    - Simulador DOM en vivo para probar eventos de cursor asistido (`click_element`, `type_text`).
    - Visor de payload de tramas WebSocket binarias y mensajes de control.
    - Guías de integración paso a paso del SDK `@onboarding-assistant/sdk`.

---

## 5. SDK Y SDK-CLI

Publicación de paquetes y herramientas para desarrolladores:

- [ ] **SDK-01: Publicación del Paquete `@onboarding-assistant/sdk`**
  - **Ubicación:** `packages/sdk`.
  - **Acción:**
    - Configurar pipeline de empaquetado (tsup / Vite Library Mode) generando salidas ESM, CommonJS y bundle minificado UMD para `<script>`.
    - Generar archivos de declaración de tipos completos (`index.d.ts`).
    - Probar instalación limpia e integración con aplicaciones React 18/19, Vue 3 y vanilla JS.
    - Publicar en registro NPM oficial con control de versiones semántico.

- [ ] **SDK-02: Desarrollo del Paquete CLI `@onboarding-assistant/cli`**
  - **Ubicación:** `packages/cli` (a crear).
  - **Acción:**
    - Implementar flujo OAuth 2.0 Device Authorization Grant (RFC 8628) consumiendo `/api/v1/auth/cli-device/*`.
    - Comandos de sincronización: `oa map:pull`, `oa map:push`, `oa keys:list`.
    - Modo de depuración local de selectores DOM y validación de `allowed_domains`.

- [ ] **SDK-03: Adaptadores Oficiales para Frameworks Web**
  - **Acción:** Desarrollar wrappers ergonómicos:
    - `@onboarding-assistant/react`: Hook `useOnboardingAssistant({ publishableKey, projectId })` con tracking de rutas automático en React Router / Next.js.
    - `@onboarding-assistant/vue`: Composable para Vue Router / Nuxt.

---

## 6. OBSERVABILIDAD

Telemetría estructurada, métricas operativas y monitoreo de producción:

- [ ] **OBS-01: Implementación de Logger Estructurado Pino en Todo el Monolito**
  - **Ubicación:** `src/shared/infrastructure/logger/` y todos los bootstrap entrypoints.
  - **Problema:** Los entrypoints y controladores utilizan wrappers simples que escriben en `process.stdout`.
  - **Acción:** Configurar Pino con formato JSON estricto en producción, redactado obligatorio de secretos (`authorization`, `publishableKey`, contraseñas, PII) y correlación distribuida mediante `requestId` en cada traza.

- [ ] **OBS-02: Métricas de Rendimiento OpenTelemetry / Prometheus**
  - **Acción:** Exponer endpoint `/metrics` con métricas clave:
    - Latencia de interrupción Barge-in (objetivo `<50 ms`).
    - Duración y tiempo de procesamiento de tramas de voz.
    - Contador de sesiones activas concurrentes por organización.
    - Latencia de transacciones pesimistas de facturación (`SELECT FOR UPDATE`).

- [ ] **OBS-03: Trazabilidad Distribuida E2E**
  - **Acción:** Propagación de encabezados `traceparent` (W3C Trace Context) desde el cliente SDK, a través del WebSocket de voz, hasta la interacción con los motores de IA y PostgreSQL.

- [ ] **OBS-04: Alertas de Facturación y Resiliencia de Webhooks**
  - **Acción:** Sistema de alertas ante fallos de webhooks de Whop tras 5 reintentos con cola de descarte (Dead Letter Queue en Redis) y notificación automática a operadores SuperAdmin.

---

**FIN DEL BACKLOG AUDITADO.**  
*Detenido formalmente para que el usuario organice y asigne el plan de ejecución.*
