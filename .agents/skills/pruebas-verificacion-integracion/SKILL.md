---
name: pruebas-verificacion-integracion
description: >-
  Skill de aseguramiento de calidad (QA), pruebas de integración y verificación pre-entrega para el Onboarding Assistant AI. Úsala obligatoriamente al finalizar cada una de las 16 partes del backend para verificar compilación TypeScript estricta (tsc --noEmit), ejecución de migraciones en PostgreSQL (Neon), pruebas unitarias de criptografía/aritmética, pruebas de webhooks Whop, sockets de voz y aserciones de aislamiento RLS multi-tenant.
---

# 🧪 Skill Global: Pruebas de Integración, Calidad y Verificación Pre-Entrega

Esta skill define el protocolo inquebrantable de **Definición de Terminado (Definition of Done - DoD)**. Ningún agente de IA puede dar por concluida una tarea ni declarar una "Parte completada" sin haber ejecutado y superado las pruebas correspondientes a los archivos que acaba de crear o modificar.

---

## 🎯 Cuándo Activar esta Skill

Activa esta skill obligatoriamente:
- Al terminar de codificar cualquiera de las 16 Partes del backend (antes de actualizar `docs/LIVE_ARCHITECTURE_LEDGER.md`).
- Al modificar migraciones SQL o ejecutar scripts contra la base de datos PostgreSQL de Neon (`DATABASE_URL`).
- Antes de entregar cualquier funcionalidad crítica de seguridad (JWT, Argon2id, RLS, WebAuthn, Whop HMAC, Anti-SSRF, VAD de audio).

---

## 📋 1. Los 4 Filtros de Verificación Obligatorios por Cada Entrega

Todo agente de IA debe pasar estos 4 filtros secuenciales antes de dar por buena su entrega:

### Filtro 1: Verificación de Presupuesto de Código (`<500 líneas`)
* Ejecutar: `wc -l <archivos_creados>`
* **Criterio de Aprobación:** Ningún archivo puede superar las **500 líneas de código**. Si un archivo tiene más de 450 líneas, debe ser particionado modularmente antes de continuar.

### Filtro 2: Compilación de Tipos Estricta (Zero Type Errors)
* Ejecutar: `npx tsc --noEmit`
* **Criterio de Aprobación:** Cero errores de compilación (`Found 0 errors`). Prohibido el uso de `any` suelto o aserciones de tipo inseguras `as unknown as Type`.

### Filtro 3: Prueba Funcional / Smoke Test Específica de la Parte
Cada Parte del backend cuenta con su prueba de fuego específica (ver Sección 2). Debe ejecutarse el test unitario o de integración y validar que el resultado sea exitoso (`PASS`).

### Filtro 4: Prueba de No-Regresión y Live Ledger
* Verificar que la nueva funcionalidad no rompa los contratos públicos previamente congelados en `src/shared/ports/`.
* Registrar el resultado de las pruebas en la bitácora de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

---

## 🔬 2. Batería de Pruebas de Fuego por Módulo

| Módulo / Partes | Prueba de Fuego Específica | Comando o Método de Verificación | Criterio de Éxito |
| :--- | :--- | :--- | :--- |
| **Parte 1 (Migraciones SQL)** | Ejecución de `migrator.ts` contra Neon PostgreSQL | `npx tsx migrations/migrator.ts` | 6 migraciones aplicadas, tabla `schema_migrations` con 6 hashes SHA-256 intactos. |
| **Parte 2 (Kernel Cripto & Math)** | Test unitario de `CryptoUtils` y `DecimalMath` | `npx tsx tests/unit/kernel.test.ts` | Piso de 350ms en Argon2id, precisión a 6 decimales sin desbordamiento de coma flotante. |
| **Parte 3 (Redis Cluster & Lua)** | Test de script Lua Token Bucket | `npx tsx tests/integration/rate-limiter.test.ts` | Permite peticiones dentro de la cuota y rechaza inmediatamente con `429 Too Many Requests`. |
| **Partes 4-5 (Auth, MFA & Legal)** | Test de Login B2B, rotación de Refresh Tokens y bloqueo ToS/DPA | `npx tsx tests/integration/auth-flow.test.ts` | Revocación con `token_version`, bloqueo con `403 LEGAL_CONSENT_OUTDATED` si falta firma. |
| **Parte 6 (API Keys & SDK)** | Test de Handshake SDK y validación de `Origin` | `npx tsx tests/integration/sdk-handshake.test.ts` | Permite dominios en `allowed_domains` y rechaza orígenes no autorizados con `403 FORBIDDEN`. |
| **Parte 7 (Anti-SSRF)** | Test de `PinnedDnsSsrfGuard` | `npx tsx tests/unit/anti-ssrf.test.ts` | Bloquea implacablemente `169.254.169.254`, `127.0.0.1` y rangos RFC 1918. |
| **Partes 9-10 (Whop & Ledger)** | Test de verificación HMAC de Webhooks y deducción `FOR UPDATE` | `npx tsx tests/integration/whop-billing.test.ts` | Valida firmas válidas, rechaza firmas alteradas y descuenta minutos sin race conditions. |
| **Partes 11-13 (Voice Realtime)** | Test de Ring Buffer PCM16 y cancelación por Barge-in | `npx tsx tests/unit/voice-gateway.test.ts` | Buffer en RAM volátil sin escrituras a disco, corte de audio en `<50ms` ante interrupción. |
| **Parte 14 (SuperAdmin)** | Test de aislamiento RLS y permisos RBAC | `npx tsx tests/integration/rls-isolation.test.ts` | Tenant A no puede leer registros de Tenant B (`0 rows returned`). |
| **Parte 16 (Ensamblaje Total)** | Test E2E de arranque de Node Pools | `npx tsx tests/e2e/bootstrap.test.ts` | Los 3 Node Pools (`API`, `VOICE`, `TRAINER`) inicializan sus puertos sin errores. |

---

## 📊 3. Formato Estándar de Reporte de Pruebas al Usuario

Al terminar cualquier Parte, la IA debe emitir en el chat una tabla resumen como esta antes de declarar la tarea terminada:

```markdown
### ✅ Verificación de Calidad y Pruebas Superadas (Parte X):
- [x] **Límite de Líneas:** Todos los archivos creados tienen <500 líneas (Máximo registrado: Y líneas).
- [x] **Tipado TypeScript:** `npx tsc --noEmit` completado con 0 errores.
- [x] **Prueba Funcional:** `[Nombre de la prueba de fuego]` ejecutada con éxito (PASS).
- [x] **Seguridad & Contratos:** No se vulneraron políticas RLS ni puertos congelados.
- [x] **Live Ledger Actualizado:** Registrado en `docs/LIVE_ARCHITECTURE_LEDGER.md`.
```
