# PLAN MAESTRO DE CONSTRUCCIÓN DEL BACKEND POR PARTES (VOLUMEN 1: ESTRATEGIA DE TOKENS, AUTO-CONEXIÓN Y PARTES 1 A 8)

Este documento constituye la hoja de ruta de ingeniería exacta para construir el **100% del Backend Monolito Modular Hexagonal** sin que ningún agente de IA resuma código, omita validaciones ni supere el límite de tokens de salida ni el tope de **500 líneas por archivo**.

---

## 1. Calibración de Tareas Según los Límites de Salida de tus 2 Modelos de IA

De acuerdo con las capacidades reales de tus dos modelos de construcción:

| Modelo de IA | Límite Máximo de Salida | Salida Segura de Código (Sin Resumir) | Líneas Reales Estimadas por Turno | Rol Ideal en la Construcción del Backend |
| :--- | :---: | :---: | :---: | :--- |
| **Gemini 3.8 Flash** | `65,536 tokens` | `~30,000 tokens` | `~3,000 a 3,500 líneas` | Excelente para ejecutar **1 Parte por turno** (`1,100 a 1,800 líneas` repartidas en `4 a 6 archivos` de `<380 líneas`), operando siempre por debajo del 50% de su límite seguro para garantizar **cero resúmenes**. |
| **DeepSeek V4.1 Flash** | `384,000 tokens` | `~190,000 tokens` | `~18,000 a 19,000 líneas` | Ideal para módulos de alta densidad algorítmica (SQL DDL + RLS, motor matemático Whop con bloqueo pesimista, escudo Anti-SSRF DNS Pinning y protocolo binario WebSocket de voz PCM16), pudiendo ejecutar **1 Parte pesada o hasta 2-3 Partes consecutivas** sin degradación. |

### Regla de Dimensionamiento de Cada Parte (Por Qué la IA Jamás Resumirá)
El backend completo consta de **~21,500 líneas de código real** distribuidas en **72 archivos modulares** (ninguno supera las `400 líneas`, respetando estrictamente la regla de `<500 líneas` de la Skill 01).
Al dividir la construcción en **16 Partes Quirúrgicas**:
* Cada Parte exige crear únicamente entre **4 y 6 archivos específicos**.
* El volumen total de salida por cada Parte es de **`1,100 a 1,750 líneas de código`** (`~12,000 a 18,000 tokens`).
* Tanto si usas **Gemini 3.8 Flash** como **DeepSeek V4.1 Flash**, el modelo tendrá holgura de sobra en su ventana de salida para escribir **cada cabecera en español, cada JSDoc, cada consulta SQL parametrizada y cada validación de seguridad completa sin resumir absolutamente nada**.

---

## 2. Cómo Operar: Modo 1 Sola IA Secuencial vs. Modo 2 IAs en Paralelo

Puedes elegir cualquiera de estas dos modalidades operativas porque ambas están sincronizadas a través de `docs/LIVE_ARCHITECTURE_LEDGER.md` (Skill 02):

### Modalidad A: 1 Sola IA de la Parte 1 a la Parte 16 (Cero Conflictos, Contexto Puro por Turno)
* Le entregas una sola Parte por mensaje (`Parte 1` ➔ actualiza `LIVE_ARCHITECTURE_LEDGER.md` ➔ `Parte 2` ➔ actualiza `LIVE_ARCHITECTURE_LEDGER.md` ... hasta la `Parte 16`).
* Al iniciar cada nuevo chat o turno, la IA lee `docs/LIVE_ARCHITECTURE_LEDGER.md` (que tiene menos de 250 líneas), lee únicamente los 2 o 3 archivos de puertos de los que depende su Parte, genera sus 4-6 archivos completos y registra su avance. **Nunca pierde contexto ni contamina su memoria.**

### Modalidad B: 2 IAs Trabajando al Mismo Tiempo (Máxima Velocidad sin Pisarse)
Si pones a trabajar a **DeepSeek V4.1 Flash (IA #1)** y a **Gemini 3.8 Flash (IA #2)** simultáneamente, sigue esta regla de oro de dependencias:

1. **FASE CERO (Secuencial — Partes 1, 2 y 3 hechas por 1 sola IA, ej. DeepSeek V4.1 Flash):**
   * Antes de lanzar las 2 IAs en paralelo, una sola IA construye los **Cimientos y Todos los Contratos/Puertos (`Partes 1, 2 y 3`)**.
   * Una vez terminada la Parte 3, todas las tablas SQL, el pool RLS, Redis Lua y todas las interfaces TypeScript (`Ports`) existen en disco y quedan congeladas.
2. **FASE PARALELA (Partes 4 a 15 — 2 Carriles Físicamente Aislados en Carpetas Distintas):**
   * Como los Puertos ya existen desde la Parte 3, la **IA #1** y la **IA #2** trabajan en directorios de módulos completamente distintos (`src/modules/01...` vs `src/modules/02...`, etc.) implementando las interfaces sin tocar los mismos archivos:

| Orden | Carril 1: **DeepSeek V4.1 Flash (IA #1)** (Infraestructura Pesada, Finanzas Whop y Voz Binaria) | Carril 2: **Gemini 3.8 Flash (IA #2)** (Identidad Avanzada, API Keys, RAG y SuperAdmin) | ¿Pueden Correr al Mismo Tiempo? |
| :---: | :--- | :--- | :---: |
| **Paso 1** | **PARTE 1:** Monorepo, Config TS y Migraciones SQL DDL + Políticas RLS | *(Espera a que termine Fase Cero)* | Secuencial (Base) |
| **Paso 2** | **PARTE 2:** Kernel Compartido (`CryptoUtils`, `DecimalMath`, `RlsDatabasePool`) | *(Espera a que termine Fase Cero)* | Secuencial (Base) |
| **Paso 3** | **PARTE 3:** Redis Cluster, Script Lua Token Bucket, EventBus y **Todos los Puertos (`Ports`)** | *(Espera a que termine Fase Cero)* | Secuencial (Base) |
| **Paso 4** | **PARTE 4:** Módulo 01-A (Login Argon2id 350ms, JWT EdDSA 15m, Refresh Rotativo y `token_version`) | **PARTE 6:** Módulo 02 (Proyectos, `allowed_domains`, API Keys SHA-256 con rotación y Handshake SDK) | **SÍ (100% Paralelo)** |
| **Paso 5** | **PARTE 7:** Módulo 03-A (Escudo Anti-SSRF DNS Pinning + Contenedores Chromium Efímeros CDP) | **PARTE 5:** Módulo 01-B (MFA TOTP/WebAuthn FIDO2, SSO SAML 2.0, CLI Device Flow y Bloqueo Legal ToS/DPA) | **SÍ (100% Paralelo)** |
| **Paso 6** | **PARTE 9:** Módulo 04-A (Whop Checkout + Receptor Webhooks HMAC-SHA256 con Idempotencia) | **PARTE 8:** Módulo 03-B/C (Mapa Funcional RAG SHA-256, Embeddings `pgvector`, Estudio Prompt y *Context Slimming*) | **SÍ (100% Paralelo)** |
| **Paso 7** | **PARTE 10:** Módulo 04-B (Algoritmo de Tarificación $5-$50, Volumen $50+, Overrides y Deducción `FOR UPDATE`) | **PARTE 14:** Módulo 06 (Gobierno SuperAdmin: Suspensión Tenants, Matriz Whop, Overrides, Kill-Switch y Auditoría) | **SÍ (100% Paralelo)** |
| **Paso 8** | **PARTE 11:** Módulo 05-A (Adaptador Realtime `Qwen38OmniRealtimeAdapter` completo) | **PARTE 12:** Módulo 05-B (Adaptador Realtime `Gemini38LiveAdapter` completo + Failover Router) | **SÍ (100% Paralelo)** |
| **Paso 9** | **PARTE 13:** Módulo 05-C (Servidor WebSocket Binario PCM16, VAD, Barge-in `<50ms` y Despacho `click_element`/`type_text`) | **PARTE 15:** Endpoints Públicos Comerciales (`demo-session`, `pricing-matrix` y Simulador Sandbox) | **SÍ (100% Paralelo)** |
| **Paso 10** | **PARTE 16:** Contenedor DI de Auto-Conexión, Entrypoints de los 3 Node Pools y Tests E2E | *(Revisión cruzada del Ledger Live)* | Secuencial (Cierre) |

---

## 3. Arquitectura de Auto-Conexión (`Auto-Wiring`): Cómo se Conecta Todo Automáticamente

Para que ninguna IA tenga que editar un archivo gigante `app.ts` en cada Parte (lo que causaría conflictos de merge y superaría las 500 líneas), el backend utiliza el patrón **Module Manifest & Dependency Injection Token Registry** definido en la **Parte 3**:

1. **Tokens de Inyección Tipados (`src/shared/container/di-tokens.ts`):**
   * Define un diccionario inmutable de símbolos (`DI_TOKENS.IdentityAuthPort`, `DI_TOKENS.ApiKeyValidationPort`, `DI_TOKENS.RagMapQueryPort`, `DI_TOKENS.BillingDeductionPort`, `DI_TOKENS.VoiceRealtimeProvider`, `DI_TOKENS.SuperAdminGovernancePort`).
2. **Manifiesto Autónomo por Módulo (`<modulo>.manifest.ts`):**
   * Al final de cada Parte, la IA exporta una función estándar `register<Modulo>Module(container: DependencyContainer, router: HttpRouterRegistry, wsRegistry: WsRouteRegistry): void` dentro de su propia carpeta.
   * Ese manifiesto registra sus Casos de Uso, sus Repositorios PostgreSQL/Redis y sus Rutas HTTP/WebSocket sin tocar ningún archivo de otro módulo.
3. **Ensamblaje Automático en la Parte 16 (`src/bootstrap/module-autoloader.ts`):**
   * Importa todos los manifiestos (`registerIdentityModule`, `registerProjectsKeysModule`, `registerVisualTrainerRagModule`, `registerBillingWhopModule`, `registerVoiceGatewayModule`, `registerSuperAdminModule`) y los levanta según la variable de entorno `NODE_POOL_ROLE` (`API_CONTROL_PLANE` | `VOICE_REALTIME_GATEWAY` | `VISUAL_TRAINER_ORCHESTRATOR`).

---

## 4. Especificación Exhaustiva de Trabajo: PARTES 1 A 8

> **Instrucción para cada Parte:** Copia el bloque de la Parte correspondiente y entrégaselo a la IA asignada. Cada Parte exige aplicar obligatoriamente las Skills `reglas-globales-construccion-codigo` y `documentadora-live-contexto`.

---

### PARTE 1: Cimientos del Proyecto, Configuración TypeScript y Esquema SQL Completo (DDL + RLS)

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (o `Gemini 3.8 Flash`).
* **Presupuesto Total Estimado:** `~1,350 líneas` repartidas en `6 archivos` (ningún archivo supera las `320 líneas`).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md` y `03_MODULOS_4_Y_5_POSTGRESQL_RLS_REDIS_Y_DIAGRAMAS_MERMAID.md`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `package.json` y `tsconfig.json` (`~140 líneas`):
     * Configura TypeScript en modo estricto (`strict: true`, `noImplicitAny: true`, `exactOptionalPropertyTypes: true`, alias `@shared/*` y `@modules/*`).
     * Declara únicamente las dependencias autorizadas en el Ledger Live: `pg`, `ioredis`, `argon2`, `jose`, `zod`, `ws`, `fastify` (con `fastify-raw-body` para webhooks HMAC de Whop) y `pino`.
  2. `src/config/env.schema.ts` (`~190 líneas`):
     * Cabecera documental en español.
     * Validador Zod de todas las variables de entorno críticas: `DATABASE_URL`, `REDIS_CLUSTER_URLS`, `JWT_EDDSA_PRIVATE_KEY_PEM`, `JWT_EDDSA_PUBLIC_KEY_PEM`, `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`, `INTERNAL_CHECKOUT_HMAC_SECRET`, `QWEN_REALTIME_WS_URL`, `QWEN_API_KEY`, `GEMINI_LIVE_WS_URL`, `GEMINI_API_KEY`, `CHROMIUM_DMZ_ENDPOINT`, `EXTERNAL_DNS_RESOLVERS` (`1.1.1.1,8.8.8.8`), `NODE_POOL_ROLE`.
  3. `migrations/001_extensions_enums_and_rls_functions.sql` (`~180 líneas`):
     * Cabecera SQL en español.
     * Crea las extensiones (`pgcrypto`, `citext`, `vector`, `btree_gist`), los 12 tipos `ENUM` del sistema y las funciones de sesión RLS: `app_current_org_id()`, `app_current_user_id()`, `app_is_superadmin()` y `trigger_set_updated_at()`.
  4. `migrations/002_identity_legal_projects_and_keys_tables.sql` (`~290 líneas`):
     * Cabecera SQL en español.
     * Crea las tablas `organizations`, `users`, `auth_sessions`, `password_reset_tokens`, `legal_documents`, `user_legal_acceptances`, `memberships`, `projects`, `api_keys` y `allowed_domains` con todos sus índices y constraints.
  5. `migrations/003_rag_whop_voice_and_audit_tables.sql` (`~310 líneas`):
     * Cabecera SQL en español.
     * Crea las tablas `functional_maps`, `map_elements` (con índice `HNSW` sobre `semantic_embedding vector(1536)`), `pricing_plans_config`, `organization_pricing_overrides`, `whop_subscriptions`, `voice_sessions`, `usage_ledger`, `action_events` y `audit_logs`, más el seed inicial de `pricing_plans_config` (`PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50` con sus tramos de descuento por volumen).
  6. `migrations/004_enable_row_level_security_policies.sql` (`~240 líneas`):
     * Cabecera SQL en español.
     * Activa `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY` en todas las tablas multi-tenant y crea las 13 políticas `CREATE POLICY rls_*_isolation` verificando `organization_id = app_current_org_id() OR app_is_superadmin()`.
* **Conexión Automática:** Expone un ejecutor de migraciones `src/shared/infrastructure/database/migrator.ts` (`~120 líneas`) que aplica en orden `001` a `004` dentro de una transacción.
* **Criterio de Cierre:** Ejecutar `wc -l` sobre los archivos creados y registrar la Parte 1 en `docs/LIVE_ARCHITECTURE_LEDGER.md`.

---

### PARTE 2: Kernel Compartido (Criptografía, Matemática Decimal Fija, Errores de Dominio y Pool PostgreSQL RLS)

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (o `Gemini 3.8 Flash`).
* **Presupuesto Total Estimado:** `~1,280 líneas` repartidas en `5 archivos` (`220 a 310 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md` y `src/config/env.schema.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/shared/kernel/result-and-errors.ts` (`~230 líneas`):
     * Implementa la mónada `Result<T, E>` (`Result.ok()`, `Result.fail()`) y la jerarquía completa de errores de dominio y seguridad mapeables a códigos HTTP y códigos WebSocket (`AppError`, `UnauthorizedError`, `TenantSuspendedError`, `LegalConsentOutdatedError`, `DpaNotSignedError`, `OriginNotAllowedError`, `SsrfBlockedIpError`, `InsufficientFundsError`, `RateLimitExceededError`).
  2. `src/shared/kernel/crypto.util.ts` (`~310 líneas`):
     * Implementa `CryptoUtils` sin placeholders:
       * `sha256Hex(input: string | Buffer): string`
       * `hmacSha256Hex(secret: string, payload: string | Buffer): string`
       * `timingSafeEqualHex(aHex: string, bHex: string): boolean`
       * `hashPasswordArgon2id(plain: string): Promise<string>` y `verifyPasswordConstantTime(hashOrNull: string | null, plain: string, floorMs = 350): Promise<boolean>` (incluye `DUMMY_ARGON2ID_HASH` precalculado y relleno temporal exacto para mitigar enumeración de usuarios).
       * `generateApiKeyWithChecksum(type: 'pk' | 'sk', env: 'live' | 'test', projectShortId: string): { rawKey: string; prefix: string; lastFour: string; sha256Hash: string; crc32Hex: string }` y `verifyApiKeyChecksum(rawKey: string): boolean`.
       * `canonicalizeJsonRfc8785(obj: unknown): string` y `computeCanonicalMapSha256(obj: unknown): { canonicalJson: string; sha256Hash: string }`.
  3. `src/shared/kernel/decimal.util.ts` (`~220 líneas`):
     * Implementa `DecimalMath` operando sobre enteros escalados (`BigInt` a 6 decimales, `1 USD = 1_000_000 micros`) para prohibir errores de coma flotante en cobros por minuto:
       * `secondsToMinutesFixed6(seconds: number): string`
       * `subtractMinutesClamped(available: string, delta: string): { remaining: string; covered: string; uncoveredOverage: string }`
       * `calculateCompoundedRate(baseRate: string, volumeDiscountPct: string, manualDiscountPct: string): string`
       * `multiplyMinutesByRateUsd(minutes: string, ratePerMinUsd: string): string`
  4. `src/shared/infrastructure/database/rls-pool.ts` (`~290 líneas`):
     * Envuelve `pg.Pool` en la clase `RlsDatabasePool`:
       * `runInTenantTransaction<T>(ctx: { organizationId: string; userId?: string }, fn: (client: PoolClient) => Promise<T>): Promise<T>`: ejecuta `BEGIN`, luego `SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.is_superadmin', 'false', true)`, invoca `fn(client)` y ejecuta `COMMIT` o `ROLLBACK`.
       * `runInSuperAdminTransaction<T>(superAdminUserId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>`: configura `app.is_superadmin = 'true'` validando previamente que el usuario sea SuperAdmin.
       * `runWithPessimisticOrgLock<T>(organizationId: string, fn: (client: PoolClient, lockedSubRow: WhopSubscriptionRow) => Promise<T>): Promise<T>`: adquiere `SELECT * FROM whop_subscriptions WHERE organization_id = $1 FOR UPDATE` antes de ejecutar la lógica financiera.
  5. `src/shared/infrastructure/http/http-server.types.ts` (`~230 líneas`):
     * Define las interfaces tipadas de controladores HTTP, contexto de solicitud autenticada (`AuthenticatedRequestContext`), registro de rutas (`HttpRouterRegistry`) y registro de sockets (`WsRouteRegistry`).
* **Criterio de Cierre:** Verificar `wc -l` (`<500 líneas` en todos los archivos) y registrar estas utilidades en la Sección 2 de `docs/LIVE_ARCHITECTURE_LEDGER.md` para que ningún módulo posterior las duplique.

---

### PARTE 3: Infraestructura Redis Cluster, Rate Limiting Token Bucket en Lua, Bus de Eventos y Sellado de Todos los Puertos (`Ports`)

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (o `Gemini 3.8 Flash`).
* **Presupuesto Total Estimado:** `~1,420 líneas` repartidas en `6 archivos` (`190 a 280 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/result-and-errors.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/shared/infrastructure/redis/redis-cluster.client.ts` (`~240 líneas`):
     * Gestiona la conexión a Redis, reconexión exponencial, healthcheck y helpers tipados para todos los namespaces de la arquitectura (`auth:user_tv:<id>`, `apikey:sha256:<hash>`, `proj:<id>:allowed_domains`, `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`, `sdk_handshake:nonce:<jti>`, `voice_session:state:<id>`, `org:<id>:active_sessions`, `whop:webhook:evt:<id>`).
  2. `src/shared/infrastructure/redis/token-bucket.lua.ts` (`~230 líneas`):
     * Contiene el script Lua atómico de Token Bucket y la clase `TokenBucketRateLimiter` con las 8 políticas preconfiguradas (Auth por IP `10/min`, Fallos por Cuenta `5 cada 15m`, Dashboard JWT `120/min`, SDK Handshake por IP `15/min`, SDK Handshake Global por Proyecto `600/min`, Secret Key `300/min`, Navegador Entrenamiento `3/min`, Control WebSocket `60/10s`).
  3. `src/shared/infrastructure/event-bus/domain-event-bus.ts` (`~210 líneas`):
     * Implementa el bus de eventos híbrido (en memoria para comunicación síncrona entre módulos y sobre Redis Pub/Sub + Streams para eventos globales entre nodos, como cortar todas las sesiones WebSocket cuando el SuperAdmin suspende una organización o cambia el proveedor de IA activo).
  4. `src/shared/container/di-container.ts` (`~190 líneas`):
     * Implementa `DependencyContainer` y el catálogo completo de `DI_TOKENS` para la auto-conexión de todos los módulos.
  5. `src/shared/ports/core-modules.ports.ts` (`~280 líneas`):
     * Declara los contratos públicos inmutables de los módulos 01, 02 y 03:
       * `IIdentityAuthPort`: `verifyAccessTokenAndVersion()`, `assertOrganizationActiveAndDpaSigned()`.
       * `IApiKeyAndHandshakePort`: `validateSecretKey()`, `validateSdkHandshakeOriginAndKey()`, `consumeEphemeralWsNonce()`.
       * `IVisualRagAndPromptPort`: `getActiveProjectPromptAndMapMeta()`, `getSlimmedRouteContext()`, `validateElementActionGuardrail()`.
  6. `src/shared/ports/billing-voice-admin.ports.ts` (`~270 líneas`):
     * Declara los contratos públicos inmutables de los módulos 04, 05 y 06:
       * `IBillingWhopPort`: `checkOrganizationSolvencyForHandshake()`, `deductVoiceSessionSlicePessimistic()`, `grantPromotionalMinutes()`.
       * `IVoiceRealtimeProvider` e `IActiveProviderStream`: contrato exacto para `Qwen3.8-Omni-Flash-Realtime` y `Gemini 3.8 Live`.
       * `IVoiceGatewayControlPort`: `terminateAllOrgSessionsImmediately()`, `switchGlobalDefaultAiProvider()`.
       * `IAuditLoggerPort`: `appendImmutableAuditLog()` (con encadenamiento criptográfico `prev_record_sha256` ➔ `record_sha256`).
* **Hito Clave:** Al terminar esta Parte 3, **queda habilitado el trabajo paralelo al 100% entre las 2 IAs**.

---

### PARTE 4: Módulo 01-A — Identidad Core, Registro Multi-Tenant, Login Anti-Enumeración, JWT EdDSA (15m) y Refresh Tokens Rotativos

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,480 líneas` repartidas en `5 archivos` (`260 a 330 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/crypto.util.ts`, `src/shared/ports/core-modules.ports.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/01-identity-and-rbac/domain/identity.entities.ts` (`~270 líneas`):
     * Entidades de dominio y tipos de valor para `Organization`, `User`, `Membership`, `AuthSession`, y la Matriz RBAC completa en código (`ROLE_PERMISSIONS_MAP` para `SUPERADMIN`, `OWNER`, `DEVELOPER`, `BILLING`, `VIEWER` con los 29 permisos granulares de la arquitectura).
  2. `src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer.ts` (`~260 líneas`):
     * Implementa la emisión y verificación de JWT `EdDSA (Ed25519)` de 15 minutos (`900s`) para usuarios B2B/SuperAdmin y tokens efímeros de 60 segundos para el Handshake del SDK y retos MFA, además de la validación instantánea de `jwt.tv === redis("auth:user_tv:<user_id>")`.
  3. `src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository.ts` (`~340 líneas`):
     * Consultas parametrizadas sobre `organizations`, `users`, `memberships` y `auth_sessions`, incluyendo el incremento atómico de `users.token_version = token_version + 1` y sincronización en Redis.
  4. `src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts` (`~320 líneas`):
     * `RegisterOrganizationOwnerUseCase`: Crea organización, usuario `OWNER`, suscripción inicial en `whop_subscriptions`, proyecto por defecto, registra aceptación legal inicial y envía OTP de verificación de email.
     * `AuthenticateUserUseCase`: Ejecuta descubrimiento de dominio SSO (`discover-tenant`), verifica bloqueo temporal por intentos fallidos (`locked_until`), valida contraseña con `CryptoUtils.verifyPasswordConstantTime(..., 350ms)`, comprueba vigencia de aceptación legal (`403 LEGAL_CONSENT_OUTDATED` si falta), emite reto MFA (`202 Accepted`) si aplica o genera `Access Token` + cookie `__Host-oa_rt` (`HttpOnly; Secure; SameSite=Strict`).
  5. `src/modules/01-identity-and-rbac/application/refresh-and-revoke-session.use-case.ts` (`~290 líneas`):
     * `RotateRefreshTokenUseCase`: Implementa la rotación de Refresh Tokens por `token_family_id` y la **Detección de Robo/Reuso de Token** (si un token ya consumido vuelve a presentarse fuera de la ventana de 3s, revoca toda la familia, incrementa `users.token_version` y escribe alerta `CRITICAL_SECURITY` en `audit_logs`).
     * `RevokeAllUserSessionsUseCase`: Cierra todas las sesiones del usuario en PostgreSQL y Redis en `<5ms`.

---

### PARTE 5: Módulo 01-B — MFA (TOTP + WebAuthn FIDO2), Recuperación SHA-256, Break-Glass Owner Recovery, SSO SAML 2.0 y Cumplimiento Legal (ToS / Privacidad / DPA)

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,520 líneas` repartidas en `5 archivos` (`270 a 340 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/modules/01-identity-and-rbac/domain/identity.entities.ts`, `src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/01-identity-and-rbac/application/mfa-and-webauthn.use-case.ts` (`~330 líneas`):
     * Enrolamiento y verificación de TOTP (RFC 6238), registro/verificación de **Passkeys WebAuthn FIDO2** (obligatorio en cada login y acción crítica de `SuperAdmin`), generación de los 10 códigos de recuperación de un solo uso hasheados con SHA-256, reseteo delegado de MFA por un `Owner` y flujo de emergencia **Break-Glass** para `Owner` único (verificación TXT DNS o recibo de Whop + ventana de enfriamiento de 24h).
  2. `src/modules/01-identity-and-rbac/application/password-reset-and-invites.use-case.ts` (`~300 líneas`):
     * `RequestPasswordResetUseCase`: Genera token CSPRNG de 32 bytes, almacena solo `SHA-256(token)` en `password_reset_tokens` con expiración de 15 minutos y aplica piso constante de `350ms` (Anti-User Enumeration).
     * `ConfirmPasswordResetUseCase`: Verifica el hash, actualiza Argon2id, marca `used_at = NOW()` e incrementa `users.token_version + 1`.
     * `ManageOrganizationInvitationsUseCase`: Invitación de miembros con roles `DEVELOPER`, `BILLING` o `VIEWER` y aceptación segura.
  3. `src/modules/01-identity-and-rbac/application/sso-saml-and-cli-device.use-case.ts` (`~290 líneas`):
     * Autenticación federada SAML 2.0 / OIDC para tenants con `enforce_sso = true` y flujo de autorización de dispositivo para el CLI (`POST /api/v1/auth/cli-device/code` y `/confirm`).
  4. `src/modules/01-identity-and-rbac/application/legal-privacy-compliance.use-case.ts` (`~310 líneas`):
     * Gestión y bloqueo técnico de `TOS_B2B`, `PRIVACY_POLICY`, `DPA_ENTERPRISE`, `AI_VOICE_AUP` y `END_USER_VOICE_CONSENT` (`user_legal_acceptances` con sello `document_sha256_snapshot`), más los casos de uso de **Exportación Portable de Datos GDPR** y **Eliminación/Anonimización Criptográfica de Organización**.
  5. `src/modules/01-identity-and-rbac/identity.manifest.ts` (`~290 líneas`):
     * Controladores HTTP y middlewares de autenticación/autorización RBAC (`requireAuth()`, `requirePermission(permCode)`, `requireSuperAdminFido2()`) y función `registerIdentityModule()` que conecta automáticamente todos los endpoints `/api/v1/auth/*`, `/api/v1/legal/*` y `/api/v1/organizations/:orgId/members/*`.

---

### PARTE 6: Módulo 02 — Gestión de Proyectos, Dominios Permitidos (`allowed_domains`), API Keys (`pk_live_` / `sk_live_` SHA-256) y Handshake Seguro del SDK

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,320 líneas` repartidas en `4 archivos` (`290 a 360 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/crypto.util.ts`, `src/shared/ports/core-modules.ports.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository.ts` (`~340 líneas`):
     * Persistencia RLS para `projects`, `allowed_domains` y `api_keys` + sincronización en tiempo real con Redis (`apikey:sha256:<hash>` y conjunto `proj:<project_id>:allowed_domains`).
  2. `src/modules/02-projects-and-keys/application/manage-projects-and-domains.use-case.ts` (`~310 líneas`):
     * Creación, edición y cambio de entorno (`LIVE` / `TEST`) de proyectos; alta, verificación DNS y revocación de `allowed_domains` (impidiendo registrar `http://localhost` en proyectos `LIVE` salvo para claves `pk_test_`).
  3. `src/modules/02-projects-and-keys/application/api-key-lifecycle.use-case.ts` (`~330 líneas`):
     * `CreateApiKeyUseCase`: Genera claves públicas (`pk_live_...`) o secretas (`sk_live_...`), almacena únicamente `key_prefix`, `last_four` y `SHA-256` en `api_keys`, y devuelve la clave en texto plano por única vez.
     * `RotateApiKeyUseCase`: Genera la nueva clave y configura `grace_period_ends_at` (`0h`, `1h`, `24h`, `72h`) en la clave anterior para despliegues sin caída.
     * `RevokeApiKeyImmediatelyUseCase` y `ValidateSecretApiKeyUseCase` (comparación con `timingSafeEqualHex`).
  4. `src/modules/02-projects-and-keys/application/sdk-handshake-and-manifest.ts` (`~340 líneas`):
     * `ValidateSdkHandshakeUseCase` (`POST /api/v1/sdk/handshake`):
       1. Verifica Rate Limit por IP y por Proyecto en Redis Token Bucket.
       2. Valida la `Publishable Key` (`X-OA-Publishable-Key`).
       3. Extrae y valida el encabezado `Origin` contra `proj:<project_id>:allowed_domains`.
       4. Verifica que `end_user_consent_granted === true`, que la organización tenga el `DPA_ENTERPRISE` firmado y que `IBillingWhopPort.checkOrganizationSolvencyForHandshake()` confirme saldo/minutos disponibles.
       5. Emite el `ephemeral_ws_token` (TTL 60s) con su nonce de un solo uso en Redis (`sdk_handshake:nonce:<jti>`) y registra el manifiesto `registerProjectsKeysModule()`.

---

### PARTE 7: Módulo 03-A — Blindaje Anti-SSRF de 4 Capas (`PinnedDnsSsrfGuard`) y Orquestador del Navegador de Entrenamiento Remoto Efímero (Chromium + Overlay CDP)

* **Modelo Recomendado:** `DeepSeek V4.1 Flash` (Carril 1) o secuencial.
* **Presupuesto Total Estimado:** `~1,390 líneas` repartidas en `4 archivos` (`310 a 370 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `02_MODULOS_2_Y_3_CIBERSEGURIDAD_BACKEND_WHOP_Y_MOTOR_DE_VOZ.md`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard.ts` (`~360 líneas`):
     * Implementa el escudo **Anti-SSRF y Anti-DNS Rebinding** completo:
       * Validador estricto de esquemas (`http://`, `https://`) y puertos.
       * Pre-resolución DNS autoritativa contra resolvers externos (`1.1.1.1` / `8.8.8.8`) obteniendo todos los registros `A` y `AAAA`.
       * Evaluador matemático de subredes CIDR IPv4 e IPv6 que bloquea implacablemente: Link-Local y Cloud Metadata (`169.254.0.0/16`, `169.254.169.254`, `100.100.100.200/32`, `fd00:ec2::254/128`, `fe80::/10`), Loopback (`127.0.0.0/8`, `::1/128`, `0.0.0.0/8`), RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), Unique Local IPv6 (`fc00::/7`, `::ffff:0:0/96`) y Multicast/Reservadas.
       * Generador de reglas de pinning `--host-resolver-rules="MAP <host> <validated_ip>, EXCLUDE localhost"` y registro automático en `audit_logs` con severidad `CRITICAL_SECURITY` ante cualquier intento bloqueado.
  2. `src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-injected-agent.ts` (`~340 líneas`):
     * Script instrumentador inyectado en el Chromium remoto vía CDP (`Page.addScriptToEvaluateOnNewDocument`):
       * Renderiza la capa interactiva (Overlay) sin tomar screenshots ciegos.
       * Aplica el filtro de privacidad `SensitiveDomScrubber` (ignora y bloquea campos `password`, `autocomplete^="cc-"`, `[data-oa-sensitive="true"]`).
       * Calcula la cascada de selectores estables (`primary_selector` con `[data-oa-id]`, `accessibility_selector` con rol ARIA + nombre, `structural_css_selector` sin hashes dinámicos, `xpath_fallback`) y el `selector_stability_score` (`0-100`).
       * Calcula las cajas geométricas normalizadas (`desktop_bbox`, `tablet_bbox`, `mobile_bbox`) redimensionando el viewport a `1440x900`, `768x1024` y `390x844`.
  3. `src/modules/03-visual-trainer-and-rag/infrastructure/ephemeral-chromium-cdp.adapter.ts` (`~350 líneas`):
     * Gestiona el ciclo de vida del contenedor efímero sin disco (`tmpfs` en RAM, TTL máximo 30 min, destrucción total con `SIGKILL` al cerrar), intercepta cada petición de red secundaria con `Fetch.enable` de CDP pasándola por `PinnedDnsSsrfGuard`, y puentea las coordenadas del puntero y eventos del desarrollador entre el Visor Web / Túnel CLI y el navegador remoto.
  4. `src/modules/03-visual-trainer-and-rag/application/training-session.use-case.ts` (`~340 líneas`):
     * Casos de uso para iniciar sesión de entrenamiento desde la Web o CLI (`LaunchTrainingBrowserUseCase`), conmutar entre Modo Navegación y Modo Captura Overlay, probar resaltado de un selector en vivo y capturar los metadatos del modal (`Título`, `Descripción Funcional`, `¿Hacer acción? Sí/No` y `Click / Escritura / Ambos`).

---

### PARTE 8: Módulo 03-B y 03-C — Mapa Funcional RAG Inmutable (`SHA-256`), Edición Dual (Visual/JSON), Estudio del Prompt Paso a Paso y Motor de *Context Slimming*

* **Modelo Recomendado:** `Gemini 3.8 Flash` (Carril 2) o secuencial.
* **Presupuesto Total Estimado:** `~1,460 líneas` repartidas en `4 archivos` (`340 a 380 líneas` por archivo).
* **Archivos de Lectura Previa Obligatoria:** `docs/LIVE_ARCHITECTURE_LEDGER.md`, `src/shared/kernel/crypto.util.ts`, `src/modules/03-visual-trainer-and-rag/application/training-session.use-case.ts`.
* **Archivos Exactos a Crear en esta Parte:**
  1. `src/modules/03-visual-trainer-and-rag/infrastructure/postgres-rag-map.repository.ts` (`~360 líneas`):
     * Persistencia RLS de `functional_maps` y `map_elements` (incluyendo búsqueda vectorial híbrida con `pgvector` `<=>` y precalentamiento atómico en Redis de `rag_map:proj:<id>:meta` y `rag_map:proj:<id>:routes` agrupado por `url_route_pattern`).
  2. `src/modules/03-visual-trainer-and-rag/application/publish-and-edit-rag-map.use-case.ts` (`~370 líneas`):
     * `PublishImmutableMapUseCase`: Soporta tanto la publicación desde el **Editor Visual** como la **Edición Directa de Código JSON** o push desde el CLI. Valida el JSON Schema estricto (verificando coherencia entre `is_actionable` y `action_type`), aplica canonicalización **RFC 8785 (JCS)**, calcula el hash `content_sha256_hash`, genera embeddings para los elementos, crea la versión inmutable `N + 1` y precalienta Redis.
     * `RollbackFunctionalMapVersionUseCase`: Revierte en `<50ms` la versión activa del mapa funcional.
  3. `src/modules/03-visual-trainer-and-rag/application/prompt-studio-and-slimming.use-case.ts` (`~370 líneas`):
     * `UpdateAssistantPromptUseCase`: Permite configurar desde el Dashboard o vía API (`PUT /api/v1/projects/:id/prompt` autenticada con `sk_live_...` o JWT) el System Prompt maestro, la lista estructurada de pasos (`onboarding_steps_json`), los modelos primario/fallback (`Gemini 3.8 Live` / `Qwen3.8-Omni-Flash-Realtime`) y los guardrails (`strict_step_enforcement`, `ask_confirmation_before_submit`).
     * `SlimContextForRouteUseCase`: Ejecuta el algoritmo de **Context Slimming en `<2ms`** leyendo `HGET rag_map:proj:<id>:routes <current_route>` desde Redis, cruzándolo con los elementos visibles reportados por el SDK y el paso actual del flujo para devolver solo los elementos de la pantalla activa con las coordenadas del viewport del usuario (`desktop`, `tablet` o `mobile`).
  4. `src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest.ts` (`~360 líneas`):
     * Implementa `IVisualRagAndPromptPort` (incluyendo `validateElementActionGuardrail()` que rechaza en el servidor cualquier intento de la IA de hacer click o escribir en un elemento con `is_actionable = false` o con tipo de acción incompatible) y registra todos los endpoints REST y WebSocket de entrenamiento en `registerVisualTrainerRagModule()`.
