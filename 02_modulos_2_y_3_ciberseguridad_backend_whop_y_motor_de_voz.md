# MÓDULOS 2 Y 3: ARQUITECTURA DE CIBERSEGURIDAD, BACKEND HEXAGONAL, MOTOR DE VOZ REALTIME Y COBRANZAS CON WHOP

Este documento define la arquitectura de seguridad defensiva, resiliencia criptográfica, el diseño interno del Backend bajo el patrón de Monolito Modular Hexagonal, la integración transaccional y de webhooks con **Whop**, el motor matemático de tarificación y deducción de minutos sin condiciones de carrera, y el **Gateway de Voz en Tiempo Real** compatible con **Qwen3.8-Omni-Flash-Realtime** y **Gemini 3.8 Live**.

---

# MÓDULO 2: ARQUITECTURA DE CIBERSEGURIDAD Y RESILIENCIA

## 1. Flujo de Autenticación, Sesiones y Revocación Inmediata

### 1.1. Arquitectura Dual de Tokens (JWT de Vida Corta + Refresh Tokens Rotativos)
1. **Access Token (JWT de Vida Corta — 15 Minutos Exactos):**
   * **Algoritmo de Firma:** Asimétrico `EdDSA (Ed25519)` o `RS256` con rotación automática de claves públicas/privadas (`JWKS`) cada 30 días identificadas por cabecera `kid`.
   * **Tiempo de Vida (`exp`):** `900 segundos` (15 minutos).
   * **Almacenamiento en Cliente:** Exclusivamente en memoria volátil de JavaScript (estado interno del cliente HTTP en RAM). **Prohibido almacenar en `localStorage` o `sessionStorage`** para neutralizar la exfiltración por XSS.
   * **Estructura Exacta del Payload JWT:**
     ```json
     {
       "iss": "https://auth.plataforma.com",
       "sub": "usr_018f4a7c-8d12-7e90-b123-456789abcdef",
       "org_id": "org_018f4a7d-1111-7a22-c333-987654321000",
       "role": "DEVELOPER",
       "tv": 4,
       "mfa": true,
       "scp": ["projects:read", "projects:write", "rag_map:write", "prompt_studio:write"],
       "jti": "at_018f4a80-9999-7b88-d777-112233445566",
       "iat": 1791920000,
       "exp": 1791920900
     }
     ```
2. **Refresh Token Rotativo con Detección de Robo de Familia (`Refresh Token Rotation & Reuse Detection`):**
   * **Formato:** Token opaco criptográficamente aleatorio de 64 bytes (`512 bits` generados vía CSPRNG) codificado en `base64url`.
   * **Transporte:** Cookie con atributos estrictos:
     `Set-Cookie: __Host-oa_rt=<raw_refresh_token>; Max-Age=604800; Path=/api/v1/auth/refresh; HttpOnly; Secure; SameSite=Strict`
   * **Almacenamiento en Base de Datos (`auth_sessions`):** Solo se almacena `SHA-256(raw_refresh_token)`, agrupado por `token_family_id`, junto con `user_id`, `token_version_snapshot`, `ip_address`, `user_agent_hash`, `parent_token_hash`, `consumed_at` y `expires_at` (7 días).
   * **Protocolo de Rotación y Detección de Intrusión:**
     * Cada vez que el frontend llama a `POST /api/v1/auth/refresh`, el backend busca el registro por `SHA-256(cookie_token)`.
     * **Caso Normal (`consumed_at IS NULL`):** Marca el token actual con `consumed_at = NOW()`, verifica que `users.token_version == session.token_version_snapshot`, emite un nuevo `Access Token` (15 min) y un **nuevo `Refresh Token`** perteneciente a la misma `token_family_id`.
     * **Caso de Compromiso / Robo de Token (`consumed_at IS NOT NULL`):** Si un atacante o cliente presenta un Refresh Token que ya fue rotado previamente (fuera de una ventana de tolerancia de concurrencia de red de 3 segundos para pestañas múltiples de la misma IP), el sistema detecta una **Violación de Familia de Tokens**:
       1. Revoca inmediatamente **todos los tokens** de ese `token_family_id`.
       2. Incrementa `users.token_version = token_version + 1`.
       3. Publica en Redis la versión actualizada para invalidar los Access Tokens vivos.
       4. Registra alerta crítica `SECURITY_REFRESH_TOKEN_REUSE_DETECTED` en `audit_logs`.

### 1.2. Revocación Global Instantánea con `token_version`
* Cada fila en la tabla `users` posee la columna entera `token_version NOT NULL DEFAULT 1`.
* Cuando ocurre cualquiera de los siguientes eventos de seguridad:
  1. Cambio o recuperación de contraseña (`password/reset`).
  2. Reseteo o modificación de factores MFA.
  3. Degradación de rol RBAC o expulsión de una organización.
  4. Botón "Cerrar todas las sesiones activas" pulsado por el usuario, el `Owner` o el `SuperAdmin`.
* El sistema ejecuta dentro de una transacción atómica:
  1. `UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING token_version;`
  2. `UPDATE auth_sessions SET revoked_at = NOW(), revocation_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL;`
  3. `SET redis_key "auth:user_tv:<user_id>" = <new_token_version> EX 86400`
* **Validación en el Middleware de Autenticación (Zero-Latency Check):**
  * En cada petición HTTP o apertura de WebSocket, tras verificar la firma criptográfica del JWT, el middleware compara el claim `jwt.tv` contra el valor en Redis `auth:user_tv:<user_id>` (con lectura en `<0.4ms`). Si `jwt.tv < redis_tv`, el token es rechazado instantáneamente con `HTTP 401 Unauthorized (TOKEN_VERSION_REVOKED)` sin esperar a que transcurran los 15 minutos de vida del JWT.

### 1.3. Recuperación de Contraseña Segura (SHA-256 + Anti-User Enumeration de Tiempo Constante)
1. **Generación y Hashing Efímero:**
   * `raw_token = crypto.randomBytes(32).toString('hex')` (256 bits de entropía).
   * `token_hash = crypto.createHash('sha256').update(raw_token).digest('hex')`.
   * Se almacena únicamente `token_hash` en la tabla `password_reset_tokens` con `expires_at = NOW() + INTERVAL '15 minutes'`, `used_at = NULL`, `request_ip` y `user_agent`.
   * El correo electrónico enviado contiene el enlace `https://app.plataforma.com/auth/reset-password?token=<raw_token>`. Si la base de datos fuera comprometida en modo lectura, ningún atacante podría reconstruir el `raw_token` para secuestrar cuentas.
2. **Defensa contra Enumeración de Usuarios (Timing-Safe Execution):**
   * En los endpoints `/api/v1/auth/login` y `/api/v1/auth/password/forgot`, un atacante podría medir diferencias de milisegundos entre una cuenta existente y una inexistente.
   * **En `/auth/login`:** Si el correo no existe en la tabla `users`, el backend ejecuta igualmente `argon2.verify(DUMMY_ARGON2ID_HASH, providedPassword)` con los mismos parámetros de memoria y CPU (`memoryCost: 65536 KB, timeCost: 3, parallelism: 4`) que una cuenta real.
   * **En `/auth/password/forgot`:** El despacho del correo se encola de forma asíncrona en un worker (`BullMQ / Redis Streams`) y el controlador HTTP envuelve toda la operación en un temporizador determinista que aguarda hasta completar exactamente `350ms` (más un jitter criptográfico uniforme de `0-15ms`) antes de devolver siempre el mismo código `HTTP 200 OK` y el mismo cuerpo JSON:
     `{"status": "accepted", "message": "Si la dirección está asociada a una cuenta activa, recibirás instrucciones en breve."}`.

---

## 2. Gestión Criptográfica de API Keys y Handshake Seguro del SDK

### 2.1. Estructura Criptográfica y Almacenamiento SHA-256
* **Formato Estándar con Checksum de Detección de Secretos (Secret Scanning Friendly):**
  * **Clave Pública del SDK:** `pk_live_<project_short_id>_<32_chars_base62>_<6_chars_crc32>` (ej. `pk_live_9f8a7b_4kL9mN2pQ7rS1tV6wX8yZ3aB5cD0eF2g_a1b2c3`).
  * **Clave Secreta de Backend:** `sk_live_<project_short_id>_<48_chars_base62>_<6_chars_crc32>` (285+ bits de entropía).
* **Regla de Almacenamiento en PostgreSQL (`api_keys`):**
  * La base de datos **jamás almacena la clave completa**. Guarda únicamente:
    * `key_prefix`: Primeros 16 caracteres visibles para identificación en el Dashboard (ej. `sk_live_9f8a7b_4k`).
    * `last_four`: Últimos 4 caracteres para referencia visual.
    * `key_hash`: `SHA-256(full_raw_key)` indexado con `UNIQUE INDEX` para búsqueda en tiempo constante `O(1)`.
* **Validación en Caliente:**
  * Cuando llega una petición con `Authorization: Bearer sk_live_...`, el backend verifica primero el checksum CRC32 local (descartando claves malformadas sin tocar Redis ni BD), calcula `SHA-256(key)` y consulta Redis (`HGETALL apikey:sha256:<hash>`). Si hay cache miss, consulta PostgreSQL, verifica `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())` y compara el hash con `crypto.timingSafeEqual()`.

### 2.2. Protocolo de Handshake Seguro del SDK (`@onboarding-assistant/sdk`)
El SDK nunca se conecta directamente a los modelos de IA ni expone claves secretas en el navegador del usuario final. Sigue un protocolo de intercambio de token efímero de sesión en 5 pasos:

1. **Solicitud de Inicialización desde el Navegador del Usuario Final:**
   * El SDK ejecuta `POST https://api.plataforma.com/api/v1/sdk/handshake` con cabeceras:
     * `Origin: https://app.cliente-b2b.com` (cabecera inmutable controlada por el navegador).
     * `X-OA-Publishable-Key: pk_live_...`
     * Cuerpo JSON: `{ "project_id": "uuid", "current_url": "https://app.cliente-b2b.com/facturacion/nueva", "viewport": { "width": 1440, "height": 900, "device_type": "desktop" }, "sdk_version": "1.4.0", "end_user_consent_granted": true }`.
2. **Validación Multicapa en el Backend (`SdkHandshakeUseCase`):**
   * **Paso A (API Key):** Calcula `SHA-256(X-OA-Publishable-Key)` y verifica que sea de tipo `PUBLISHABLE`, esté activa y pertenezca al `project_id`.
   * **Paso B (Validación Estricta de `Origin` contra `allowed_domains`):**
     * Extrae el esquema, host y puerto de la cabecera HTTP `Origin` (y verifica consistencia con `Sec-Fetch-Site: cross-site` y `Sec-Fetch-Mode: cors`).
     * Compara el host contra la lista de `allowed_domains` activos del proyecto en Redis (`SMEMBERS proj:<project_id>:allowed_domains`).
     * Si el origen no está explícitamente autorizado (o si intenta usar `http://` no-localhost con una clave `pk_live_`), aborta con `HTTP 403 Forbidden (ORIGIN_NOT_ALLOWED)` y registra el intento en `audit_logs`.
   * **Paso C (Verificación Financiera y de Estado del Tenant):**
     * Comprueba que `organizations.status === 'ACTIVE'`, que el DPA esté firmado y que la organización tenga saldo disponible o una suscripción válida en Whop con capacidad de consumo (`available_minutes > 0` o modalidad `PAYG` / `Overage` habilitada sin haber superado el `hard_spend_cap_usd`).
3. **Emisión del Token Efímero de Sesión de Voz (`sdk_session_token`):**
   * Si todas las validaciones pasan, el backend crea una pre-sesión en Redis (`sdk_session:<session_id>`) y firma un JWT efímero de **un solo uso para apertura de WebSocket** (`ttl = 60 segundos`) vinculado criptográficamente a:
     * `session_id`, `organization_id`, `project_id`, `allowed_origin`, `client_ip_hash` y `active_map_id`.
   * Devuelve al SDK:
     ```json
     {
       "session_id": "vses_018f4a90-1234-7c56-a789-001122334455",
       "ws_gateway_url": "wss://voice.plataforma.com/ws/v1/realtime",
       "ephemeral_ws_token": "eyJhbGciOiJFZERTQSI...",
       "expires_in_seconds": 60,
       "initial_route_elements_count": 14
     }
     ```

---

## 3. Blindaje Anti-SSRF del Navegador de Entrenamiento Remoto

Cuando el desarrollador solicita abrir una URL en el Navegador de Entrenamiento Remoto (`POST /api/v1/projects/:projectId/training-sessions`), ese navegador Chromium corre en la infraestructura del SaaS. Sin un blindaje estricto, un atacante podría introducir `http://169.254.169.254/latest/meta-data/` (robo de credenciales IAM de AWS/GCP), `http://127.0.0.1:6379` (ataque a Redis interno) o utilizar **DNS Rebinding** para saltar validaciones ingenuas de URL.

### 3.1. Defensa en Profundidad de 4 Capas contra SSRF y DNS Rebinding

1. **Capa 1 — Validación Sintáctica y de Esquema:**
   * Solo se permiten esquemas `https://` y `http://` (prohibidos `file://`, `ftp://`, `ws://`, `javascript:`, `data:`, `chrome://`, `view-source:`).
   * Puertos destino permitidos únicamente: `80`, `443`, `3000`, `5173`, `8000`, `8080`, `8443` (estos puertos altos de desarrollo solo se permiten cuando la sesión se enlaza mediante el túnel explícito del CLI del desarrollador; contra internet público solo se permiten `80` y `443`).
2. **Capa 2 — Pre-Resolución DNS Autoritativa y Pinning de IP (Mitigación Total de DNS Rebinding):**
   * En un ataque de DNS Rebinding, el dominio `evil.attacker.com` resuelve primero a una IP pública válida (`93.184.216.34`) con `TTL = 0` durante la validación del backend, pero cuando Chromium realiza la petición milisegundos después, resuelve a `169.254.169.254` o `10.0.0.1`.
   * **Solución Arquitectónica (`PinnedDnsInterceptor`):**
     * El microservicio orquestador de entrenamiento resuelve los registros `A` y `AAAA` del hostname utilizando un resolver DNS externo aislado (ej. `1.1.1.1` / `8.8.8.8`, nunca el DNS interno de la VPC).
     * Evalúa **todas** las direcciones IPv4 e IPv6 devueltas contra la **Lista Negra Estricta de Rangos Prohibidos**.
     * Si todas las IPs son públicas y legítimas, lanza el proceso Chromium inyectando la bandera de fijación de resolución a nivel de socket de red (`--host-resolver-rules="MAP <hostname> <validated_public_ip>, EXCLUDE localhost"`) y además intercepta cada sub-recurso (`script`, `xhr`, `fetch`, `iframe`, `image`, `websocket`) mediante el dominio `Fetch.enable` de Chrome DevTools Protocol (`CDP`), aplicando la misma pre-resolución y bloqueo antes de que cualquier paquete salga a la red.
3. **Capa 3 — Lista Negra Estricta de Rangos IPv4 e IPv6 (Bloqueo en Código + Firewall de Kernel `nftables` / `eBPF`):**
   * Queda prohibida cualquier conexión saliente hacia los siguientes bloques CIDR:
     * **Cloud Metadata & Link-Local (AWS, GCP, Azure, DigitalOcean, Alibaba):** `169.254.0.0/16` (específicamente `169.254.169.254` y `169.254.170.2`), `100.100.100.200/32`, `fd00:ec2::254/128`, `fe80::/10`.
     * **Loopback / Localhost:** `127.0.0.0/8`, `::1/128`, `0.0.0.0/8`.
     * **Redes Privadas RFC 1918:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
     * **Carrier-Grade NAT (RFC 6598, usado por tailscale/redes internas cloud):** `100.64.0.0/10`.
     * **Unique Local Addresses IPv6 (RFC 4193) y IPv4-Mapped IPv6:** `fc00::/7`, `::ffff:0:0/96`.
     * **Multicast, Broadcast y Redes de Documentación/Pruebas:** `224.0.0.0/4`, `240.0.0.0/4`, `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `255.255.255.255/32`.
4. **Capa 4 — Contenedores Efímeros Sin Persistencia (Firecracker MicroVMs / gVisor Sandbox):**
   * Cada sesión de entrenamiento visual se ejecuta en un contenedor aislado con runtime `runsc` (gVisor) o microVM `Firecracker` en una **VPC DMZ completamente separada** de la VPC donde residen PostgreSQL, Redis y el Backend principal.
   * **Características del Contenedor:**
     * Sistema de archivos raíz de solo lectura (`read_only: true`), con `/tmp` montado en memoria RAM (`tmpfs`, máximo 256 MB, `noexec,nosuid,nodev`).
     * Tiempo de vida máximo (`Hard TTL`): 30 minutos por sesión.
     * Al cerrar el visor o expirar el TTL, el contenedor se destruye por completo (`SIGKILL` + borrado de `tmpfs`), garantizando cero persistencia de cookies, caché o credenciales del desarrollador.

---

## 4. Rate Limiting Multicapa con Redis Token Bucket

El sistema protege todos los puntos de entrada mediante el algoritmo **Token Bucket Atómico** ejecutado directamente en Redis mediante un script Lua precompilado (`EVALSHA`), evitando condiciones de carrera entre instancias del backend.

### 4.1. Script Lua Atómico de Token Bucket en Redis
```lua
-- KEYS[1]: Clave del bucket en Redis (ej. "rl:tb:ip:203.0.113.5:auth_login")
-- ARGV[1]: Capacidad máxima del bucket (burst_capacity)
-- ARGV[2]: Tasa de recarga de tokens por segundo (refill_rate_per_sec)
-- ARGV[3]: Timestamp actual en milisegundos (now_ms)
-- ARGV[4]: Tokens solicitados en esta petición (requested_tokens, usualmente 1)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "last_refill_ms")
local tokens = tonumber(data[1])
local last_refill_ms = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill_ms = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - last_refill_ms) / 1000.0)
  local refilled = elapsed_sec * refill_rate
  tokens = math.min(capacity, tokens + refilled)
  last_refill_ms = now_ms
end

local allowed = 0
local retry_after_ms = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  retry_after_ms = math.ceil((deficit / refill_rate) * 1000.0)
end

local ttl_sec = math.ceil((capacity / refill_rate) * 2) + 60
redis.call("HMSET", key, "tokens", tokens, "last_refill_ms", last_refill_ms)
redis.call("EXPIRE", key, ttl_sec)

return { allowed, math.floor(tokens), retry_after_ms }
```

### 4.2. Matriz de Reglas de Rate Limiting por Dimensión

| Superficie / Endpoint | Identificador del Bucket (Redis Key) | Capacidad (`Burst`) | Recarga (`Refill Rate`) | Acción al Exceder Límite |
| :--- | :--- | :---: | :---: | :--- |
| **Autenticación (`/auth/login`, `/auth/register`, `/auth/password/*`)** | `rl:tb:ip:<ip_addr>:auth` | `10 tokens` | `0.166 tokens/seg` (10/min) | `HTTP 429 Too Many Requests` + Cabecera `Retry-After` + Activación de reto Turnstile estricto. |
| **Intentos Fallidos por Cuenta (`Anti-Brute Force`)** | `rl:tb:acct:<email_sha256>:fail` | `5 tokens` | `0.0055 tokens/seg` (1 cada 3 min) | Bloqueo temporal de cuenta por 15 min (`HTTP 423 Locked`) + Alerta por email al propietario. |
| **API del Dashboard (`JWT User Token`)** | `rl:tb:jwt:<user_id>:api` | `120 tokens` | `2.0 tokens/seg` (120/min) | `HTTP 429` con cabeceras estándar `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |
| **Handshake del SDK (`Publishable Key + IP`)** | `rl:tb:pk:<key_id>:ip:<ip_addr>` | `15 tokens` | `0.25 tokens/seg` (15/min por IP) | `HTTP 429` en el widget del SDK sin afectar a otros usuarios finales del mismo cliente B2B. |
| **Handshake Global por Proyecto (`Publishable Key Global`)** | `rl:tb:pk_global:<project_id>` | `600 tokens` | `10.0 tokens/seg` (600/min, escalable en Plan Masivo) | `HTTP 429` + Notificación al Dashboard de la organización. |
| **API Backend-to-Backend (`Secret Key`)** | `rl:tb:sk:<key_id>` | `300 tokens` | `5.0 tokens/seg` (300/min) | `HTTP 429 Too Many Requests`. |
| **Lanzamiento de Navegador de Entrenamiento** | `rl:tb:org:<org_id>:trainer` | `5 tokens` | `0.05 tokens/seg` (3/min) | Impide agotamiento del pool de contenedores Chromium por una sola organización. |
| **Tramas de Control WebSocket de Voz** | `rl:tb:ws:<session_id>:ctrl` | `60 tokens` | `10.0 tokens/seg` | Si un cliente inunda el WebSocket con tramas malformadas, cierra el socket con `1008 Policy Violation`. |

---

# MÓDULO 3: BACKEND, MOTOR DE VOZ EN TIEMPO REAL Y COBRANZAS CON WHOP

## 1. Estilo Arquitectónico: Monolito Modular Hexagonal (Ports & Adapters)

### 1.1. Justificación Técnica para Escala Masiva
Para una plataforma de misión crítica que combina transacciones financieras por minuto (Whop), control de acceso multi-tenant (RLS) y streaming de voz de ultra-baja latencia (`<250ms` round-trip), una arquitectura de microservicios distribuidos prematura introduciría latencia de serialización gRPC/HTTP entre servicios internos, fallos en cascada y complejidad de transacciones distribuidas (Sagas) al deducir saldo mientras corre el WebSocket de voz.

El **Monolito Modular Hexagonal** proporciona:
1. **Latencia Cero en Comunicación Inter-Módulo:** El módulo `VoiceGatewayModule` invoca al puerto `IBillingDeductionPort` del módulo `BillingWhopModule` y al puerto `IRagMapQueryPort` del módulo `VisualRagModule` mediante llamadas en memoria dentro del mismo proceso (o contra la misma instancia local de Redis/PostgreSQL), ahorrando entre `15ms` y `45ms` por turno de voz.
2. **Aislamiento Estricto de Dominio (Hexagonal / Clean Architecture):** Cada módulo tiene su propio núcleo de dominio puro (sin dependencias de frameworks, SQL ni SDKs externos), comunicándose exclusivamente a través de **Puertos de Entrada (Use Cases)** y **Puertos de Salida (Interfaces de Repositorios y Proveedores)**.
3. **Escalado Horizontal Independiente por Perfil de Carga (Deployment Topologies):** Como el código es un único artefacto compilado pero completamente modular, en producción se despliega en **3 grupos de autoescalado (Node Pools) independientes** a partir del mismo binario:
   * `api-control-plane` (CPU/IO estándar): Sirve las APIs REST del Dashboard, Auth, Webhooks de Whop y gestión de Mapas RAG.
   * `voice-realtime-gateway` (Red de baja latencia, afinidad WebSocket): Ejecuta exclusivamente el servidor WebSocket de voz y el adaptador dual `Qwen3.8-Omni` / `Gemini 3.8 Live`.
   * `visual-trainer-orchestrator` (Aislado en red DMZ): Gestiona los contenedores efímeros Chromium con el escudo Anti-SSRF.

### 1.2. Estructura Completa de Módulos y Mapa Maestro de Conexiones End-to-End

```text
src/
├── shared/
│   ├── kernel/                 # Result<T, E>, DomainEvent, UUIDv7, Clock, CryptoUtils (SHA-256, Argon2id, HMAC)
│   ├── infrastructure/
│   │   ├── database/           # Pool PostgreSQL + Interceptor de Transacciones RLS (SET LOCAL app.current_org_id)
│   │   ├── redis/              # Cliente Redis Cluster + Cargador de Scripts Lua (Token Bucket, Locks)
│   │   └── event-bus/          # InMemory + Redis Streams EventBus para eventos de dominio
├── modules/
│   ├── 01-identity-and-rbac/
│   │   ├── domain/             # Entities: User, Organization, Membership, AuthSession, LegalAcceptance
│   │   ├── application/        # UseCases: LoginUseCase, RefreshSessionUseCase, VerifyMfaUseCase, ResetPasswordUseCase
│   │   └── infrastructure/     # Adapters: PostgresIdentityRepo, JwtEdDsaSigner, Saml2OidcAdapter, MailerAdapter
│   ├── 02-projects-and-keys/
│   │   ├── domain/             # Entities: Project, ApiKey, AllowedDomain
│   │   ├── application/        # UseCases: CreateApiKeyUseCase, RotateApiKeyUseCase, ValidateSdkHandshakeUseCase
│   │   └── infrastructure/     # Adapters: PostgresApiKeyRepo, RedisApiKeyCacheAdapter
│   ├── 03-visual-trainer-and-rag/
│   │   ├── domain/             # Entities: FunctionalMap, MapElement, ResponsiveBoundingBox, PromptConfiguration
│   │   ├── application/        # UseCases: LaunchTrainingBrowserUseCase, CaptureElementUseCase, PublishImmutableMapUseCase, SlimContextForRouteUseCase
│   │   └── infrastructure/     # Adapters: EphemeralChromiumCdpAdapter, PinnedDnsSsrfGuard, CanonicalJsonHasher
│   ├── 04-billing-and-whop/
│   │   ├── domain/             # Entities: WhopSubscription, UsageLedgerEntry, PricingPlanMatrix, TenantPricingOverride
│   │   ├── application/        # UseCases: CreateWhopCheckoutUseCase, ProcessWhopWebhookUseCase, DeductSessionMinutesUseCase, CalculateEffectiveRateUseCase
│   │   └── infrastructure/     # Adapters: WhopRestApiAdapter, WhopHmacVerifier, PostgresPessimisticBillingRepo
│   ├── 05-voice-realtime-gateway/
│   │   ├── domain/             # Entities: VoiceSession, ActionEvent, OnboardingStepState, AudioFrameBuffer
│   │   ├── application/        # UseCases: HandleVoiceWebSocketUseCase, ProcessBargeInUseCase, DispatchDomToolUseCase
│   │   ├── ports/              # IVoiceRealtimeProvider (Contrato unificado para Qwen y Gemini)
│   │   └── infrastructure/     # Adapters: Qwen38OmniRealtimeAdapter, Gemini38LiveAdapter, WebRtcVadEngine
│   └── 06-superadmin-governance/
│       ├── domain/             # Entities: GlobalAuditLog, SystemTelemetrySnapshot
│       ├── application/        # UseCases: SuspendTenantUseCase, UpdateGlobalPricingUseCase, SetTenantOverrideUseCase, SwitchActiveAiProviderUseCase
│       └── infrastructure/     # Adapters: PostgresAuditRepo, PrometheusMetricsAdapter
```

---

## 2. Integración Completa con WHOP, Prevención de Race Conditions y Algoritmo de Tarificación

### 2.1. Flujo de Checkout y Procesamiento Seguro de Webhooks de Whop
1. **Generación de Sesión de Checkout (`CreateWhopCheckoutUseCase`):**
   * Cuando un `Owner` o `Billing` selecciona un plan ($5, $10, $30, $50 o activación de método de pago para Pago por Uso / Overage) en el Dashboard, el frontend invoca `POST /api/v1/billing/whop/checkout-session`.
   * El backend consulta la tabla `pricing_plans_config` para obtener el `whop_plan_id` oficial y llama a la API de Whop (`POST https://api.whop.com/api/v2/checkout_sessions`) inyectando metadatos inmutables:
     ```json
     {
       "plan_id": "plan_whop_50usd_monthly",
       "redirect_url": "https://app.plataforma.com/dashboard/org/acme/billing?checkout=success",
       "metadata": {
         "organization_id": "org_018f4a7d-1111-7a22-c333-987654321000",
         "actor_user_id": "usr_018f4a7c-8d12-7e90-b123-456789abcdef",
         "internal_plan_code": "PLAN_50",
         "signature": "<HMAC_SHA256(org_id:plan_code, INTERNAL_CHECKOUT_SECRET)>"
       }
     }
     ```
2. **Validación Criptográfica HMAC-SHA256 de Webhooks (`POST /api/v1/webhooks/whop`):**
   * El endpoint recibe el cuerpo crudo en bytes (`rawBodyBuffer`) sin parsear previamente por middlewares JSON genéricos.
   * Extrae las cabeceras enviadas por Whop: `whop-signature` (o `x-whop-signature`) y `whop-timestamp`.
   * **Mitigación de Replay Attacks:** Verifica que `Math.abs(Date.now() / 1000 - Number(whopTimestamp)) <= 300` (ventana máxima de 5 minutos).
   * **Verificación de Firma en Tiempo Constante:**
     * Calcula `expectedSignature = crypto.createHmac('sha256', env.WHOP_WEBHOOK_SECRET).update(whopTimestamp + '.' + rawBodyBuffer.toString('utf8')).digest('hex')`.
     * Compara mediante `crypto.timingSafeEqual(Buffer.from(receivedSignature, 'hex'), Buffer.from(expectedSignature, 'hex'))`. Si no coincide, rechaza con `HTTP 401 Invalid Signature` y alerta en `audit_logs`.
   * **Idempotencia Estricta:** Verifica el identificador único del evento `event.id` en Redis (`SET whop:webhook:evt:<event_id> "PROCESSING" NX EX 86400`) y en la columna `external_event_id UNIQUE` de la base de datos para garantizar que reintentos de red de Whop jamás dupliquen acreditaciones de saldo o minutos.
3. **Máquina de Estados para los Eventos Obligatorios de Whop:**
   * **Evento 1 — `membership.went_valid`:**
     * Se dispara cuando una membresía/suscripción se activa o reactiva en Whop.
     * Abre transacción PostgreSQL con `SELECT * FROM whop_subscriptions WHERE organization_id = $1 FOR UPDATE`.
     * Actualiza `status = 'ACTIVE'`, registra `whop_membership_id`, `whop_user_id`, `plan_code` (`PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50`), `current_period_start`, `current_period_end`, y acredita los `included_minutes` correspondientes al plan en el saldo del ciclo actual (`period_included_minutes_remaining`), insertando un asiento `PLAN_ACTIVATION_GRANT` en `usage_ledger`.
   * **Evento 2 — `membership.went_invalid`:**
     * Se dispara cuando expira la membresía, se cancela al final del ciclo o falla definitivamente el método de pago en Whop.
     * En transacción atómica con `FOR UPDATE`, cambia `whop_subscriptions.status = 'PAST_DUE_OR_INVALID'`, congela la asignación de minutos del plan (`period_included_minutes_remaining = 0`), actualiza el estado en Redis (`HSET org:<org_id>:billing status "INVALID"`) y, si no tiene saldo prepagado a favor, bloquea nuevos handshakes del SDK.
   * **Evento 3 — `payment.succeeded`:**
     * Se dispara en cada renovación mensual exitosa, compra de paquete de recarga (`Top-Up`) o liquidación de consumo por minuto/exceso (`Overage Invoice`).
     * En transacción atómica con `FOR UPDATE`:
       1. Verifica que `whop_payment_id` no exista en `usage_ledger`.
       2. Si corresponde a renovación de plan mensual ($5, $10, $30 o $50), reinicia el contador de minutos incluidos del nuevo período (`period_included_minutes_remaining = plan.included_minutes`), reinicia el acumulador de minutos de exceso del mes (`period_overage_minutes_used = 0`) e inserta el asiento contable `PAYMENT_SUCCEEDED_RENEWAL` en `usage_ledger`.
       3. Si corresponde a una recarga de saldo en dólares para Pago por Uso / Overage (`credit_topup`), suma el monto exacto en micro-dólares (`credit_balance_micros = credit_balance_micros + amount_micros`) e inserta el asiento `PAYMENT_SUCCEEDED_TOPUP`.

### 2.2. Deducción de Minutos en Tiempo Real y Prevención de Condiciones de Carrera (`Pessimistic Locking`)
Cuando una organización tiene 50 usuarios finales recibiendo onboarding por voz simultáneamente, 50 conexiones WebSocket emiten pulsos de consumo (`Metering Ticks` cada 15 segundos y liquidación final al cerrar el socket). Si se usara lectura y escritura estándar (`read-modify-write` en aplicación), se produciría el clásico fallo de *Lost Update* (dos procesos leen 10 minutos restantes, ambos restan 1 minuto y ambos escriben 9 en lugar de 8).

#### Protocolo Transaccional con Bloqueo Pesimista (`SELECT ... FOR UPDATE`)
Cada pulso de tarificación ejecuta la función transaccional `DeductVoiceSessionUsage` en PostgreSQL con aislamiento `READ COMMITTED` + bloqueo de fila exclusivo `FOR UPDATE`:

```sql
BEGIN;

-- 1. Bloqueo pesimista exclusivo sobre la suscripción/billetera de la organización.
-- Cualquier otra sesión concurrente de la misma organización espera en cola de milisegundos
-- hasta que esta transacción haga COMMIT, eliminando al 100% las Race Conditions.
SELECT
    ws.id AS subscription_id,
    ws.plan_code,
    ws.status,
    ws.period_included_minutes_remaining,
    ws.period_overage_minutes_used,
    ws.credit_balance_usd,
    ws.hard_spend_cap_usd,
    ws.current_period_overage_billed_usd
FROM whop_subscriptions ws
WHERE ws.organization_id = $1
FOR UPDATE;

-- 2. Lectura de la matriz global de precios y posibles overrides del SuperAdmin
-- (Se ejecuta el Algoritmo de Tarificación detallado en la sección 2.3)

-- 3. Actualización atómica de los contadores de minutos y saldo de la organización
UPDATE whop_subscriptions
SET
    period_included_minutes_remaining = $2,
    period_overage_minutes_used = $3,
    credit_balance_usd = $4,
    current_period_overage_billed_usd = $5,
    updated_at = NOW()
WHERE id = $6;

-- 4. Inserción inmutable en el libro mayor auditable (Append-Only Ledger)
INSERT INTO usage_ledger (
    id, organization_id, project_id, voice_session_id, entry_type,
    minutes_delta, unit_rate_usd, discount_applied_pct, amount_usd_delta,
    included_minutes_balance_after, credit_balance_usd_after, metadata_json, created_at
) VALUES (
    $7, $1, $8, $9, 'VOICE_MINUTE_DEDUCTION',
    $10, $11, $12, $13,
    $2, $4, $14, NOW()
);

COMMIT;
```

### 2.3. Algoritmo Matemático Exacto de Tarificación (Planes, Overage desde $50, Descuento por Volumen y Overrides SuperAdmin)

#### Tabla de Referencia de la Matriz Base (Editable desde el Dashboard de SuperAdmin)
| Código de Plan | Cuota Fija Mensual (Whop) | Minutos Incluidos Base (`M_inc`) | Tarifa Base por Minuto (`R_base`) | Régimen al Agotar Minutos Incluidos | Elegible a Descuento por Volumen Automático |
| :--- | :---: | :---: | :---: | :--- | :---: |
| `PAYG` (Pago por Uso Puro) | `$0.00 / mes` | `0 min` | `$0.2000 / min` | Cobro directo por cada minuto (fraccionado por segundo) contra saldo/Whop | NO (salvo Override de SuperAdmin) |
| `PLAN_5` | `$5.00 / mes` | `25 min` | `$0.2000 / min` | Consume `M_inc`; al llegar a 0 pasa a cobro por minuto a `R_base` | NO |
| `PLAN_10` | `$10.00 / mes` | `55 min` | `$0.1818 / min` | Consume `M_inc`; al llegar a 0 pasa a cobro por minuto a `R_base` | NO |
| `PLAN_30` | `$30.00 / mes` | `180 min` | `$0.1667 / min` | Consume `M_inc`; al llegar a 0 pasa a cobro por minuto a `R_base` | NO |
| `PLAN_50` (Plan Escala / Masivo) | `$50.00 / mes` | `350 min` | `$0.1428 / min` | Consume `M_inc`; al superar los 350 min sigue consumiendo por minuto con **Descuento por Volumen Escalonado Automático** | **SÍ (Automático por tramos)** |

#### Escalafón de Descuento por Volumen para Plan de $50 USD y Excesos Masivos (`VolumeDiscountTiers`)
Cuando una organización está en `PLAN_50` (o cuando su gasto acumulado en el ciclo alcanza o supera los `$50.00 USD`) y consume minutos por encima de los minutos incluidos (`M_overage`):
* **Tramo 1 (`0 < M_overage <= 1,000 min`):** Descuento automático `D_vol = 10%` ➔ Tarifa efectiva = `R_base * (1 - 0.10)`.
* **Tramo 2 (`1,000 < M_overage <= 5,000 min`):** Descuento automático `D_vol = 20%` ➔ Tarifa efectiva = `R_base * (1 - 0.20)`.
* **Tramo 3 (`5,000 < M_overage <= 25,000 min`):** Descuento automático `D_vol = 35%` ➔ Tarifa efectiva = `R_base * (1 - 0.35)`.
* **Tramo 4 (`M_overage > 25,000 min`):** Descuento automático `D_vol = 50%` ➔ Tarifa efectiva = `R_base * (1 - 0.50)`.

#### Orden de Precedencia y Algoritmo Determinista (`CalculateAndDeductSlice(orgId, deltaSeconds)`)
1. **Paso 1 — Conversión de Precisión Decimal:**
   * `deltaMinutes = Round(deltaSeconds / 60.0, 6)` (aritmética de punto fijo con `NUMERIC(18,6)` para evitar errores de coma flotante IEEE 754).
2. **Paso 2 — Deducción contra Minutos Incluidos en el Plan (`period_included_minutes_remaining`):**
   * Si `period_included_minutes_remaining >= deltaMinutes`:
     * `period_included_minutes_remaining -= deltaMinutes`.
     * `billedOverageMinutes = 0`, `costUsd = 0.000000`.
     * Termina el cálculo y registra el asiento en `usage_ledger`.
   * Si `0 < period_included_minutes_remaining < deltaMinutes` (cruce exacto del límite del plan en mitad de una sesión):
     * `coveredByPlan = period_included_minutes_remaining`.
     * `period_included_minutes_remaining = 0`.
     * `billedOverageMinutes = deltaMinutes - coveredByPlan`.
   * Si `period_included_minutes_remaining == 0`:
     * `billedOverageMinutes = deltaMinutes`.
3. **Paso 3 — Determinación de la Tarifa Base y Overrides del SuperAdmin (`organization_pricing_overrides`):**
   * Se consulta si existe un registro vigente (`NOW() BETWEEN effective_from AND COALESCE(effective_until, 'infinity')`) en `organization_pricing_overrides` para `organization_id`:
     * Si `override.custom_rate_per_minute_usd IS NOT NULL`, entonces `baseRate = override.custom_rate_per_minute_usd`.
     * En caso contrario, `baseRate = pricing_plans_config.base_overage_rate_per_minute_usd`.
4. **Paso 4 — Aplicación de Descuento por Volumen Escalonado (A partir del Plan de $50 USD) y Descuento Manual del SuperAdmin:**
   * Se actualiza el acumulador mensual de exceso: `newOverageTotal = period_overage_minutes_used + billedOverageMinutes`.
   * Si `subscription.plan_code == 'PLAN_50'` (o si `override.force_volume_discount_tiers == true` o el gasto mensual acumulado `>= $50.00 USD`):
     * Se evalúa `newOverageTotal` contra la tabla de tramos (`custom_volume_tiers_json` si el SuperAdmin definió uno para el cliente, o `global_volume_tiers_json` de la matriz general) obteniendo `volumeDiscountPct`.
   * En caso contrario (`PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30` por debajo de $50): `volumeDiscountPct = 0`.
   * Si el SuperAdmin asignó además un `override.manual_discount_percentage` (ej. `15%`), se calcula el descuento compuesto o el mayor beneficio según la regla configurada por el SuperAdmin (`compounded_rate = baseRate * (1 - volumeDiscountPct/100) * (1 - manualDiscountPct/100)`).
5. **Paso 5 — Cálculo del Cargo Monetario y Verificación de Solvencia / Límite de Gasto:**
   * `costUsd = Round(billedOverageMinutes * effectiveRatePerMinute, 6)`.
   * Si `current_period_overage_billed_usd + costUsd > hard_spend_cap_usd` o si el saldo prepagado / método de cobro en Whop es insuficiente:
     * Levanta bandera `INSUFFICIENT_FUNDS_OR_CAP_REACHED`, instruye al Gateway de Voz para que el asistente se despida cortésmente del usuario final y cierre la sesión WebSocket con código `4002_PAYMENT_REQUIRED`.

---

## 3. Motor de Voz en Tiempo Real (Adaptador Dual, Audio WebSocket, VAD/Barge-in y Despacho RAG/DOM)

### 3.1. Adaptador Dual Unificado (`IVoiceRealtimeProvider`) para Qwen3.8-Omni-Flash-Realtime y Gemini 3.8 Live

Para desacoplar la lógica de negocio de las particularidades del protocolo de cada proveedor de IA, el Gateway implementa el puerto común `IVoiceRealtimeProvider`:

```typescript
export interface IVoiceRealtimeProvider {
  readonly providerName: 'QWEN_3_8_OMNI_FLASH_REALTIME' | 'GEMINI_3_8_LIVE';
  connectSession(config: RealtimeSessionInitConfig): Promise<IActiveProviderStream>;
}

export interface IActiveProviderStream {
  sendSystemInstructionAndTools(systemPrompt: string, tools: ToolDeclaration[]): Promise<void>;
  updateDynamicRouteContext(slimmedRagContextMessage: string): Promise<void>;
  sendPcm16AudioChunk(pcm16LeBuffer: Buffer): void;
  commitUserAudioBuffer(): void;
  triggerImmediateBargeInCancel(): Promise<void>;
  sendToolExecutionResult(callId: string, resultPayload: Record<string, unknown>): Promise<void>;
  onAudioOutputChunk(callback: (pcm16LeBuffer: Buffer, sampleRate: number) => void): void;
  onTranscriptDelta(callback: (role: 'user' | 'assistant', textDelta: string, isFinal: boolean) => void): void;
  onToolCallRequest(callback: (toolCall: { callId: string; name: 'click_element' | 'type_text' | 'advance_step'; args: Record<string, unknown> }) => void): void;
  onProviderError(callback: (err: ProviderStreamError) => void): void;
  close(): Promise<void>;
}
```

#### Diferencias de Protocolo Resueltas Internamente por cada Adaptador:
1. **`Qwen38OmniRealtimeAdapter`:**
   * Mantiene conexión WebSocket persistente con el endpoint Realtime de Qwen3.8-Omni-Flash.
   * Traduce las actualizaciones del System Prompt y herramientas al evento `session.update`, empaqueta los frames de audio entrantes (`16kHz, mono, PCM16 Little-Endian`) en eventos `input_audio_buffer.append`, y ante una señal de **Barge-in** envía instantáneamente la trama `response.cancel` + `output_audio_buffer.clear`.
2. **`Gemini38LiveAdapter`:**
   * Mantiene sesión bidireccional `BidiGenerateContent` con la API de **Gemini 3.8 Live**.
   * Envía el bloque inicial `setup` con `model: "models/gemini-3.8-live"`, `generationConfig: { responseModalities: ["AUDIO"], speechConfig: ... }`, `systemInstruction` y `tools: [{ functionDeclarations: [...] }]`.
   * Transmite el audio entrante mediante mensajes `realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Pcm }] }`, recibe el audio de salida en `serverContent.modelTurn.parts[].inlineData` (`24kHz PCM16`), detecta el flag nativo `serverContent.interrupted === true` para sincronizar el corte de audio en el cliente y envía las respuestas de las herramientas DOM mediante `toolResponse: { functionResponses: [{ id, name, response }] }`.

### 3.2. Flujo Bidireccional de Audio WebSocket, VAD y Barge-in (`<50ms`)

1. **Pipeline de Audio en el Cliente (`@onboarding-assistant/sdk`):**
   * Utiliza un **`AudioWorkletProcessor`** dedicado corriendo en el hilo de renderizado de audio del navegador (nunca `ScriptProcessorNode` obsoleto) que captura muestras del micrófono, aplica reducción de eco y supresión de ruido nativos, realiza downsampling a `16,000 Hz Mono PCM de 16 bits (Little-Endian)` y empaqueta frames binarios de `20ms` (`640 bytes` por frame).
   * Los frames se envían por el WebSocket hacia el Gateway precedidos por un byte de cabecera de tipo de trama (`0x01` = Audio Uplink PCM16, `0x02` = Mensaje de Control JSON) para evitar la sobrecarga del `33%` de codificación Base64 entre el navegador y nuestro Gateway.
2. **Detección de Actividad de Voz (VAD) e Interrupción Inmediata (`Barge-in`):**
   * El sistema opera con **Doble VAD Coordinado (Client-Side Edge VAD + Server-Side Provider VAD)**:
     * Mientras el asistente está hablando (`state === 'AI_SPEAKING'`), el `AudioWorklet` del SDK monitorea la energía RMS y la probabilidad de voz humana (`Silero/WebRTC VAD` ligero en WebAssembly) sobre el micrófono del usuario (con cancelación acústica de eco `AEC` activa para no confundir la voz del propio asistente).
     * Si el usuario pronuncia voz continua durante más de `140ms` por encima del umbral configurado:
       1. **En `<5ms` localmente en el navegador:** El SDK vacía inmediatamente el buffer de reproducción `AudioContext` (`audioPlaybackQueue.clear()`), deteniendo el sonido de la IA al instante sin esperar el viaje de red al servidor.
       2. **En el mismo milisegundo:** Envía la trama prioritaria `0x02 {"type": "voice.barge_in", "timestamp_ms": ...}` al Gateway de Voz.
       3. **En el Gateway de Voz:** Invoca `providerStream.triggerImmediateBargeInCancel()`, descarta cualquier paquete de audio en tránsito de la respuesta anterior de `Qwen3.8-Omni` o `Gemini 3.8 Live`, y comienza a alimentar el nuevo turno de audio del usuario al modelo.

### 3.3. Inyección Dinámica de Contexto RAG (*Context Slimming*) y Cumplimiento del Flujo Paso a Paso

Enviar el Mapa Funcional completo de una aplicación SaaS de 200 pantallas en cada turno saturaría la ventana de contexto del modelo de voz, aumentaría la latencia del primer token de audio (`TTFA`) y provocaría alucinaciones de selectores que pertenecen a otras pantallas.

#### Algoritmo de *Context Slimming* en Tiempo Real (`SlimContextForRouteUseCase`)
1. **Detección de Ruta Activa:**
   * En el handshake inicial y cada vez que la aplicación del cliente cambia de URL (`popstate`, `pushState`, cambio de hash o query clave), el `@onboarding-assistant/sdk` envía por el WebSocket el evento:
     ```json
     {
       "type": "route.changed",
       "current_path": "/clientes/8492/facturas/nueva",
       "viewport": "desktop",
       "visible_element_ids": ["el_btn_emitir", "el_input_rfc", "el_input_monto", "el_nav_volver"]
     }
     ```
2. **Filtrado y Podado de Contexto en `<2ms` desde Redis:**
   * El Gateway consulta en Redis el índice por ruta del mapa activo (`HGET rag_map:proj:<project_id>:routes "/clientes/:id/facturas/nueva"` más los elementos globales como el menú de navegación principal `route_pattern = "*"`).
   * Cruza esa lista con los `visible_element_ids` reportados en vivo por el DOM del cliente y con el **Paso Actual (`current_step_index`)** de la máquina de estados del System Prompt.
   * Construye un bloque compacto de contexto (típicamente `<800 tokens`) que contiene **únicamente** los elementos presentes en la ruta actual con sus coordenadas para el `viewport` activo:
     ```json
     {
       "current_route": "/clientes/8492/facturas/nueva",
       "active_onboarding_step": {
         "step_number": 2,
         "instruction": "Pide al usuario el RFC del cliente y escríbelo en el campo RFC Receptor, luego haz click en Validar RFC.",
         "required_target_elements": ["el_input_rfc", "el_btn_validar_rfc"]
       },
       "available_dom_elements_on_screen": [
         {
           "element_id": "el_input_rfc",
           "title": "Campo RFC Receptor",
           "description": "Input de texto para ingresar la clave fiscal del cliente receptor de la factura",
           "is_actionable": true,
           "allowed_actions": ["TYPE", "BOTH"],
           "selector": "[data-oa-id='input-receptor-rfc']",
           "bbox_norm": { "x": 0.34, "y": 0.28, "w": 0.25, "h": 0.04 }
         },
         {
           "element_id": "el_btn_validar_rfc",
           "title": "Botón Validar RFC",
           "description": "Verifica en el padrón fiscal que el RFC escrito sea válido",
           "is_actionable": true,
           "allowed_actions": ["CLICK"],
           "selector": "[data-oa-id='btn-validate-rfc']",
           "bbox_norm": { "x": 0.61, "y": 0.28, "w": 0.10, "h": 0.04 }
         },
         {
           "element_id": "el_badge_estado_timbrado",
           "title": "Indicador de Estado de Timbrado",
           "description": "Muestra si el certificado digital CSD está activo",
           "is_actionable": false,
           "allowed_actions": []
         }
       ]
     }
     ```
3. **Inyección al Modelo de Voz:**
   * El Gateway invoca `providerStream.updateDynamicRouteContext(...)` actualizando el estado contextual de `Qwen3.8-Omni-Flash-Realtime` o `Gemini 3.8 Live` sin cortar la conversación en curso.

### 3.4. Declaración y Despacho Determinista de Herramientas Físicas (`click_element` y `type_text`)

Los modelos `Qwen3.8-Omni-Flash-Realtime` y `Gemini 3.8 Live` tienen registradas tres herramientas estrictas:

#### 1. Especificación de Herramientas Registradas en el Modelo IA
* **Herramienta 1: `click_element`**
  * **Parámetros JSON Schema:**
    * `element_id` (`string`, obligatorio): El identificador único del elemento dentro de `available_dom_elements_on_screen`.
    * `narration_intent` (`string`, obligatorio): Breve nota de por qué se ejecuta el click en relación con el paso actual.
* **Herramienta 2: `type_text`**
  * **Parámetros JSON Schema:**
    * `element_id` (`string`, obligatorio): El identificador único del campo de entrada en `available_dom_elements_on_screen`.
    * `text_value` (`string`, obligatorio): El texto exacto que debe escribirse en el elemento.
    * `clear_existing` (`boolean`, por defecto `true`): Si debe limpiarse el valor previo del campo antes de escribir.
    * `press_enter_after` (`boolean`, por defecto `false`): Si debe disparar la tecla `Enter` al finalizar la escritura.
* **Herramienta 3: `advance_onboarding_step`**
  * **Parámetros JSON Schema:**
    * `completed_step_number` (`integer`, obligatorio): El paso del System Prompt que acaba de completarse.
    * `verification_summary` (`string`, obligatorio): Confirmación del resultado observado.

#### 2. Ciclo de Validación de Seguridad y Ejecución en el SDK (`DispatchDomToolUseCase`)
Cuando el modelo de IA emite una llamada a `click_element` o `type_text`:
1. **Validación en el Gateway antes de enviar al navegador (Guardrail Server-Side):**
   * El Gateway busca `element_id` en el mapa funcional activo de la sesión.
   * Si el elemento no existe en la ruta actual, o si `is_actionable === false`, o si la IA invocó `type_text` sobre un elemento cuya configuración es únicamente `CLICK` (o viceversa), **el Gateway bloquea el despacho** y devuelve inmediatamente al modelo de IA un `toolResponse` con `{ status: "REJECTED_BY_GUARDRAIL", reason: "Element is not actionable or does not support action type." }`.
2. **Despacho por WebSocket hacia el `@onboarding-assistant/sdk`:**
   * Si la validación es exitosa, el Gateway resuelve los selectores ordenados (`primary_selector`, `accessibility_selector`, `structural_css_selector`, `xpath_fallback`) y las coordenadas responsive (`bbox_norm` para el viewport actual) y envía al SDK la trama:
     ```json
     {
       "type": "tool.execute",
       "call_id": "call_987654321",
       "tool_name": "type_text",
       "target": {
         "element_id": "el_input_rfc",
         "selectors": [
           "[data-oa-id='input-receptor-rfc']",
           "role=textbox[name='RFC Receptor']",
           "form.invoice-form > div:nth-child(2) > input"
         ],
         "bbox_norm": { "x": 0.34, "y": 0.28, "w": 0.25, "h": 0.04 }
       },
       "params": {
         "text_value": "XAXX010101000",
         "clear_existing": true,
         "press_enter_after": false
       }
     }
     ```
3. **Ejecución Física en el DOM del Cliente y Confirmación (`tool.execution.ack`):**
   * El `@onboarding-assistant/sdk` localiza el nodo probando la cascada de selectores; si la app usa clases dinámicas y todos los selectores fallan, utiliza la resolución geométrica responsive (`document.elementFromPoint(bbox_norm.x * window.innerWidth, bbox_norm.y * window.innerHeight)` validando que coincida el tag/rol esperado).
   * Verifica que el nodo no sea un campo prohibido (`type="password"`, tarjeta bancaria o `[data-oa-sensitive="true"]`).
   * Anima el puntero visual del asistente hasta el centro del elemento, ejecuta el click o la escritura compatible con el virtual DOM de React/Vue/Angular, registra el evento en la tabla `action_events` y responde al Gateway en `<30ms`:
     ```json
     {
       "type": "tool.execution.ack",
       "call_id": "call_987654321",
       "status": "SUCCESS",
       "execution_duration_ms": 18,
       "dom_mutation_observed": true,
       "resulting_url_path": "/clientes/8492/facturas/nueva"
     }
     ```
   * El Gateway reenvía este ACK a `Qwen3.8-Omni-Flash-Realtime` o `Gemini 3.8 Live` mediante `sendToolExecutionResult(callId, ackPayload)`, permitiendo que el asistente continúe hablando con certeza absoluta de que la acción ya ocurrió en la pantalla del usuario.
