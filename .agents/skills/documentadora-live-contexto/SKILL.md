---
name: documentadora-live-contexto
description: >-
  Skill documentadora en tiempo real (Live Documentation & Dependency Ledger) para mantener sincronizado el contexto arquitectónico del proyecto tras cada tarea. Úsala obligatoriamente antes de iniciar cualquier desarrollo (para saber qué archivos leer y qué dependencias reutilizar) y al finalizar cada trabajo (para registrar archivos creados/editados, líneas de código, dependencias y conexiones).
---

# Skill Global 02: Documentadora Live, Mapa de Lectura Dirigida y Registro Anti-Duplicación

Esta skill gobierna el mantenimiento obligatorio y en tiempo real del archivo maestro de contexto del repositorio: `docs/LIVE_ARCHITECTURE_LEDGER.md`. Su objetivo es que cualquier agente de IA (o desarrollador humano) que entre a trabajar al proyecto comprenda en menos de 30 segundos qué existe, qué dependencias están instaladas, qué utilidades internas ya fueron creadas, qué archivos exactos debe leer para no desenfocarse y qué se acaba de integrar.

## Cuándo Activar esta Skill

Esta skill es de ejecución **doble y obligatoria** en cada turno de programación:

1. **En Fase de Pre-Vuelo (Antes de tocar código):** Para consultar el mapa de enrutamiento de archivos, revisar las dependencias existentes y declarar qué módulo se va a intervenir.
2. **En Fase de Cierre (Inmediatamente después de crear o modificar cualquier archivo):** Ningún trabajo de código está completo si no se actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` en el mismo turno.

## Flujo de Trabajo Paso a Paso

### Paso 1: Inspección Previa y Enrutamiento Preciso de Lectura

Antes de explorar carpetas al azar, abre `docs/LIVE_ARCHITECTURE_LEDGER.md` y ejecuta estas verificaciones:

1. **Consulta la Sección 1 (`Mapa de Enrutamiento para Lectura Dirigida`):** Identifica el módulo exacto de tu tarea (`01-identity-and-rbac`, `02-projects-and-keys`, `03-visual-trainer-and-rag`, `04-billing-and-whop`, `05-voice-realtime-gateway`, `06-superadmin-governance`, `sdk`, `frontend-landing`, `frontend-dashboard`). Lee únicamente los archivos listados en la columna `Archivos Clave de Entrada` de ese módulo.
2. **Consulta la Sección 2 (`Catálogo de Dependencias y Utilidades Compartidas`):** Verifica si la librería externa o la función auxiliar que necesitas ya está registrada. Si existe, reutilízala desde su ruta oficial; está prohibido crear una segunda implementación.
3. **Consulta la Sección 3 (`Semáforo de Concurrencia Multi-Agente`):** Verifica que ningún otro agente de IA tenga bloqueados los archivos que planeas modificar. Si hay solapamiento, aplica el protocolo *Stop & Ask* de la Skill 01.

### Paso 2: Actualización Obligatoria Post-Trabajo en `docs/LIVE_ARCHITECTURE_LEDGER.md`

Cada vez que crees, edites, dividas o conectes archivos, actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` manteniendo sus 5 secciones canónicas al día. Si el archivo `docs/LIVE_ARCHITECTURE_LEDGER.md` aún no existe en el repositorio, créalo inmediatamente con la plantilla completa especificada a continuación.

## Plantilla Canónica Obligatoria de `docs/LIVE_ARCHITECTURE_LEDGER.md`

Mantén el documento estructurado exactamente con estas 5 secciones técnicas, claras y concisas:

```markdown
# REGISTRO VIVO DE ARQUITECTURA, DEPENDENCIAS E INTEGRACIONES (LIVE LEDGER)

**Última Actualización:** YYYY-MM-DD HH:mm:ss UTC  
**Agente / Autor de Última Modificación:** <Identificador del Agente IA>  
**Estado de Integridad (<500 líneas por archivo):** VERIFICADO

## 1. Mapa de Enrutamiento para Lectura Dirigida (Qué Archivos Leer Según la Tarea)

> Instrucción para la IA: NO recorras todo el repositorio. Busca el dominio de tu tarea en esta tabla y lee únicamente los archivos indicados en "Archivos Clave de Lectura Obligatoria" antes de integrar tus cambios.

| Dominio / Módulo | Propósito Técnico | Archivos Clave de Lectura Obligatoria | Contratos / Puertos que Expone |
| :--- | :--- | :--- | :--- |
| **Kernel Compartido** | Criptografía, aritmética decimal, errores, RLS y Redis Lua | `src/shared/kernel/crypto.util.ts`, `src/shared/kernel/decimal.util.ts`, `src/shared/infrastructure/database/rls-context.ts`, `src/shared/infrastructure/redis/token-bucket.lua.ts` | `CryptoUtils`, `DecimalMath`, `withRlsTransaction()`, `checkRateLimit()` |
| **01. Identidad, Logins & Legal** | Logins B2B, SSO SAML, SuperAdmin FIDO2, JWT 15m, Refresh Rotativo, ToS/DPA | `src/modules/01-identity-and-rbac/domain/user.entity.ts`, `src/modules/01-identity-and-rbac/application/login.use-case.ts`, `src/modules/01-identity-and-rbac/application/reset-password.use-case.ts` | `IIdentityAuthPort`, `ILegalConsentGuardPort` |
| **02. Proyectos, Dominios & API Keys** | Claves `pk_live_`/`sk_live_` SHA-256, rotación con gracia y Handshake SDK | `src/modules/02-projects-and-keys/application/manage-api-keys.use-case.ts`, `src/modules/02-projects-and-keys/application/validate-sdk-handshake.use-case.ts` | `IApiKeyValidationPort`, `ISdkHandshakePort` |
| **03. Entrenamiento Visual & RAG** | Escudo Anti-SSRF DNS Pinning, Chromium efímero, Overlay DOM, Mapa SHA-256 y Context Slimming | `src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard.ts`, `src/modules/03-visual-trainer-and-rag/application/publish-immutable-map.use-case.ts`, `src/modules/03-visual-trainer-and-rag/application/slim-context-for-route.use-case.ts` | `IRagMapQueryPort`, `IVisualTrainerPort` |
| **04. Facturación & Whop** | Checkout Whop, Webhooks HMAC, bloqueo pesimista `FOR UPDATE`, planes $5-$50 y descuentos por volumen | `src/modules/04-billing-and-whop/application/process-whop-webhook.use-case.ts`, `src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case.ts`, `src/modules/04-billing-and-whop/application/calculate-effective-rate.use-case.ts` | `IBillingDeductionPort`, `IWhopSubscriptionPort` |
| **05. Gateway de Voz Realtime** | Adaptador dual Qwen3.8-Omni / Gemini 3.8 Live, WebSocket PCM16, VAD/Barge-in y despacho DOM | `src/modules/05-voice-realtime-gateway/ports/voice-realtime-provider.port.ts`, `src/modules/05-voice-realtime-gateway/infrastructure/gemini-38-live.adapter.ts`, `src/modules/05-voice-realtime-gateway/infrastructure/qwen-38-omni.adapter.ts`, `src/modules/05-voice-realtime-gateway/application/dispatch-dom-tool.use-case.ts` | `IVoiceRealtimeProvider`, `IVoiceSessionManagerPort` |
| **06. Gobierno SuperAdmin** | Suspensión de tenants, matriz global de precios, overrides por cliente y kill-switch IA | `src/modules/06-superadmin-governance/application/suspend-tenant.use-case.ts`, `src/modules/06-superadmin-governance/application/set-tenant-override.use-case.ts` | `ISuperAdminGovernancePort` |
| **SDK Web (`@onboarding-assistant/sdk`)** | Widget de voz, AudioWorklet PCM16, VAD local, cursor asistido y ejecución `click_element` / `type_text` | `packages/sdk/src/core/sdk-client.ts`, `packages/sdk/src/audio/pcm16-worklet.ts`, `packages/sdk/src/dom/action-executor.ts`, `packages/sdk/src/security/sensitive-field-scrubber.ts` | `OnboardingAssistant.init()`, `<OnboardingAssistantProvider />` |

## 2. Catálogo Único de Dependencias y Utilidades Internas (Prohibido Duplicar)

### 2.1. Dependencias Externas Oficiales (`package.json`)

| Paquete | Versión | Uso Único Autorizado en el Proyecto | Prohibiciones (No Instalar Equivalentes) |
| :--- | :---: | :--- | :--- |
| `pg` | `^8.13.0` | Pool nativo PostgreSQL con soporte de transacciones explícitas `SET LOCAL` para RLS | Prohibido instalar Prisma, TypeORM o Sequelize que oculten el bloqueo `FOR UPDATE` o las variables de sesión RLS |
| `ioredis` | `^5.4.1` | Cliente Redis Cluster y ejecución de scripts Lua (`EVALSHA`) | Prohibido instalar otros clientes Redis paralelos |
| `argon2` | `^0.41.1` | Hashing de contraseñas (`Argon2id`) y verificación en tiempo constante | Prohibido usar `bcrypt` o `md5`/`sha1` para contraseñas |
| `jose` | `^5.9.0` | Firma y verificación de JWT asimétricos (`EdDSA` / `Ed25519`) y rotación `JWKS` | Prohibido usar `jsonwebtoken` síncrono legado |
| `zod` | `^3.23.8` | Validación estricta de esquemas DTO, tramas WebSocket y JSON Schema del Mapa Funcional | Prohibido instalar `joi`, `yup` o `ajv` por separado |
| `ws` | `^8.18.0` | Servidor WebSocket binario de baja latencia para el Gateway de Voz | Prohibido usar `socket.io` (añade sobrecarga de protocolo incompatible con tramas crudas PCM16) |

### 2.2. Utilidades Internas Compartidas Ya Construidas

| Nombre de Utilidad / Componente | Ruta Exacta | Funciones Principales que Provee |
| :--- | :--- | :--- |
| `CryptoUtils` | `src/shared/kernel/crypto.util.ts` | `sha256Hex()`, `hmacSha256Hex()`, `timingSafeEqualHex()`, `generateCsprngToken()`, `canonicalizeJsonRfc8785()` |
| `DecimalMath` | `src/shared/kernel/decimal.util.ts` | `secondsToMinutesFixed6()`, `multiplyUsdFixed6()`, `applyCompoundDiscount()` |
| `RlsDatabasePool` | `src/shared/infrastructure/database/rls-pool.ts` | `runInTenantTransaction(orgId, userId, fn)`, `runInSuperAdminTransaction(adminId, fn)` |
| `SensitiveDomScrubber` | `packages/sdk/src/security/sensitive-field-scrubber.ts` | `isSensitiveDomElement(node)` (bloquea inputs de password, tarjetas `cc-*` y `[data-oa-sensitive="true"]`) |

## 3. Semáforo de Concurrencia Multi-Agente (Archivos en Edición Activa)

| Agente IA | Módulo / Tarea Activa | Archivos Bloqueados Temporalmente | Estado | Timestamp Inicio |
| :--- | :--- | :--- | :---: | :--- |
| `Ninguno` | Sin bloqueos activos | `-` | `LIBRE` | `-` |

## 4. Inventario de Archivos del Proyecto y Auditoría de Líneas (<500 Líneas)

| Ruta del Archivo | Módulo | Líneas Actuales (`/ 500 máx`) | Resumen de Responsabilidad y Exportaciones | Dependencias que Consume |
| :--- | :--- | :---: | :--- | :--- |
| *(Actualizar en cada entrega)* | *(Módulo)* | `0 / 500` | *(Qué contiene y qué hace)* | *(Imports internos/externos)* |

## 5. Bitácora Cronológica de Integraciones (Changelog Técnico Live)

### [YYYY-MM-DD HH:mm] - <Título Corto de la Integración>
- **Resumen Técnico:** Explicación concisa de qué se construyó o modificó y por qué.
- **Archivos Creados / Modificados (con conteo de líneas):**
  - `ruta/archivo-1.ts` (`210 líneas` - Creado): Contiene `ClaseX` y `funcionY`.
  - `ruta/archivo-2.ts` (`340 líneas` - Modificado): Se conectó el puerto `IPuertoZ`.
- **Dependencias Integradas:** Reutiliza `CryptoUtils.sha256Hex` y `RlsDatabasePool`.
- **Impacto en Contratos / Base de Datos / Redis:** Indica si toca tablas SQL, claves Redis o endpoints HTTP/WS.
- **Guía para el Siguiente Agente:** Qué archivo debe leer el próximo agente si necesita extender esta funcionalidad.
```

## Reglas de Oro de la Documentadora Live

1. **Concisión Técnica Sin Paja:** No pegues bloques enteros de código fuente dentro de `docs/LIVE_ARCHITECTURE_LEDGER.md`. Registra rutas exactas, nombres de clases/funciones, firmas de entrada/salida, tablas afectadas y conteo de líneas.
2. **Sincronización Inmediata del Conteo de Líneas:** Cada vez que agregues o dividas un archivo en la Sección 4 (`Inventario de Archivos`), escribe el número real de líneas obtenido con `wc -l`.
3. **Eliminación de Archivos Obsoletos del Índice:** Si durante una refactorización divides un archivo de 490 líneas en dos archivos de 250 líneas, actualiza inmediatamente la tabla de la Sección 1 y Sección 4 para que ningún agente futuro intente buscar el archivo antiguo.
4. **Higiene de Avisos y Purgado de Alertas Resueltas ("Notice Purge"):** Las alertas de errores o advertencias entre carriles (ej. discrepancias de `tsc` o pruebas temporales) son **estrictamente transitorias**. Cuando el agente responsable de ese carril corrija los errores, **debe purgar inmediatamente la alerta del encabezado y de las notas operativas del Ledger**, confirmando el estado actual limpio (`0 errores`). El registro de la subsanación se preserva únicamente en la bitácora histórica de esa Parte en la Sección 5. De esta manera, el Live Ledger refleja la verdad en tiempo real sin falsas alarmas para el siguiente agente.
