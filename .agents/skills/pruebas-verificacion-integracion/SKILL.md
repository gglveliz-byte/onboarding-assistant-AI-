---
name: pruebas-verificacion-integracion
description: >-
  Skill de aseguramiento de calidad (QA), pruebas de integración y verificación pre-entrega para el Onboarding Assistant AI. Úsala obligatoriamente al cerrar cualquier tarea (backend o frontend) para verificar auditoría de líneas (npm run check:lines), compilación TypeScript estricta (npm run typecheck / typecheck:web), migraciones en PostgreSQL (Neon), pruebas unitarias de criptografía/aritmética, webhooks de cobro, sockets de voz, aserciones de aislamiento RLS multi-tenant y smoke HTTP del frontend en el puerto 3001.
---

# 🧪 Skill Global: Pruebas de Integración, Calidad y Verificación Pre-Entrega

Esta skill define el protocolo inquebrantable de **Definición de Terminado (Definition of Done - DoD)**. Ningún agente de IA puede dar por concluida una tarea ni declarar una "Parte completada" sin haber ejecutado y superado las pruebas correspondientes a los archivos que acaba de crear o modificar.

---

## 🎯 Cuándo Activar esta Skill

Activa esta skill obligatoriamente:
- Al terminar de codificar cualquier tarea (las 16 Partes del backend ya están selladas; aplícala igual al modificarlas o extenderlas) y siempre **antes** de actualizar `docs/LIVE_ARCHITECTURE_LEDGER.md`.
- Al cerrar tareas de frontend (`apps/web`): auditoría de líneas, `npm run typecheck:web` y smoke HTTP en `http://localhost:3001`.
- Al modificar migraciones SQL o ejecutar scripts contra la base de datos PostgreSQL de Neon (`DATABASE_URL`).
- Antes de entregar cualquier funcionalidad crítica de seguridad (JWT, Argon2id, RLS, WebAuthn, HMAC de cobros, Anti-SSRF, VAD de audio).

---

## 📋 1. Los 4 Filtros de Verificación Obligatorios por Cada Entrega

Todo agente de IA debe pasar estos 4 filtros secuenciales antes de dar por buena su entrega:

### Filtro 1: Auditoría de Presupuesto de Código (`<500 líneas`)
* Ejecutar: `npm run check:lines` (auditor oficial `scripts/check-file-lines.mjs`).
* **Criterio de Aprobación:** **0 violaciones**; ningún archivo puede superar las **500 líneas de código**. Los archivos en estado `LÍMITE_CRÍTICO` (451–500) o `ALERTA_PREVENTIVA` (381–450) exigen partición modular antes de agregar líneas netas.

### Filtro 2: Compilación de Tipos Estricta (Zero Type Errors)
* Ejecutar: `npm run typecheck` (monorepo: backend, kernel, SDK y scripts) y `npm run typecheck:web` (workspace Next `apps/web`).
* **Criterio de Aprobación:** Cero errores de compilación (`Found 0 errors`). Prohibido el uso de `any` suelto o aserciones de tipo inseguras `as unknown as Type`.

### Filtro 3: Prueba Funcional / Smoke Test Específica de la Parte
Cada Parte del backend cuenta con su prueba de fuego específica (ver Sección 2). Debe ejecutarse el test unitario o de integración y validar que el resultado sea exitoso (`PASS`).

### Filtro 4: Prueba de No-Regresión y Live Ledger
* Verificar que la nueva funcionalidad no rompa los contratos públicos previamente congelados en `src/shared/ports/`.
* Registrar el resultado de las pruebas en la bitácora de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

### Filtro 5: Smoke del Frontend (`apps/web`)
* Aplica solo si la entrega toca el workspace Next: ejecutar `npm run typecheck:web`, `npm run check:lines` y levantar el frontend con `npm run dev` (puerto **3001**; la API vive en el 3000).
* **Criterio de Aprobación:** TypeScript 0 errores; auditoría 0 violaciones; la ruta tocada responde **HTTP 200** (p. ej. `Invoke-WebRequest http://localhost:3001/`) sin advertencias de hidratación en consola.

---

## 🔬 2. Batería de Pruebas de Fuego por Módulo

| Módulo / Partes | Prueba de Fuego Específica | Comando Oficial (`package.json`) | Criterio de Éxito |
| :--- | :--- | :--- | :--- |
| **Parte 1 (Cimientos & Migraciones SQL)** | Migraciones contra Neon + contrato de entorno | `npm run verify:part1` (= check:lines + typecheck + `test:unit` + `db:verify`) o `npm run db:migrate` | Migraciones aplicadas, `schema_migrations` con hashes SHA-256 intactos. |
| **Parte 2 (Kernel Cripto & Math)** | Unitarias de `CryptoUtils`/`DecimalMath` y aislamiento RLS | `npm run test:kernel`, `npm run test:unit`, `npm run test:rls` | Piso de ~350 ms en Argon2id, precisión de 6 decimales, RLS sin fugas. |
| **Parte 3 (Redis Cluster & Lua)** | Contratos de infraestructura + Token Bucket Lua | `npm run test:contracts`, `npm run test:redis` | Cuota respetada y rechazo inmediato `429 Too Many Requests` al excederla. |
| **Partes 4-5 (Auth, MFA & Legal)** | Login B2B, rotación de refresh, MFA y bloqueo legal | `npm run test:auth-flow`, `npm run test:mfa-legal`, `npm run test:auth-routes`, `npm run test:auth-projections` | Revocación con `token_version`; `403 LEGAL_CONSENT_OUTDATED`; sin fugas en proyecciones públicas. |
| **Parte 6 (API Keys & Handshake SDK)** | Ciclo de claves `pk_live_`/`sk_live_` y validación de `Origin` | `npx tsx tests/integration/projects-keys-handshake.test.ts` (+ `npm run test:public-sdk`) | Dominios en `allowed_domains` aceptados; orígenes no autorizados con `403 FORBIDDEN`. |
| **Parte 7 (Anti-SSRF & Trainer)** | Escudo DNS Pinning, CDP y navegador efímero | `npm run verify:part7` (+ `npm run test:cdp-protocol`, `npm run test:dns-pinning`, `npm run test:container-isolation`) | Bloqueo de `169.254.169.254`, `127.0.0.1` y rangos RFC 1918; contenedor aislado. |
| **Partes 9-10 (Cobros & Ledger)** | Webhooks HMAC, tarifas y deducción `FOR UPDATE` | `npm run verify:part9`, `npm run verify:part10` (+ `npm run test:metering-failure`) | Firmas válidas aceptadas y alteradas rechazadas; minutos descontados sin race conditions. |
| **Partes 11-13 (Voice Realtime)** | Adaptadores duales, tramas PCM16, Barge-in y cobro de voz | `npm run verify:part11`, `npm run verify:part12`, `npm run verify:part13` | Buffer en RAM volátil sin escrituras a disco; corte `<50 ms` ante interrupción; failover dual. |
| **Parte 14 (SuperAdmin)** | Gobierno de tenants, overrides y auditoría | `npm run verify:part14` (+ `npm run test:rls`) | Overrides aplicados; auditoría inmutable encadenada; tenant aislado (`0 rows`). |
| **Parte 15 (Públicos & SDK)** | Endpoints públicos, demo efímera y SDK Web | `npm run verify:part15` | Matriz pública con fallback; demo de 90 s con límite por IP. |
| **Parte 16 (Ensamblaje Total)** | E2E del monolito completo | `npm run verify:part16` (= check:lines + typecheck + `test:e2e`) | 74/74 aserciones en verde sobre el wiring completo. |

---

## 📊 3. Formato Estándar de Reporte de Pruebas al Usuario

Al terminar cualquier Parte, la IA debe emitir en el chat una tabla resumen como esta antes de declarar la tarea terminada:

```markdown
### ✅ Verificación de Calidad y Pruebas Superadas (Tarea / Parte X):
- [x] **Auditoría de Líneas:** `npm run check:lines` → 0 violaciones (máximo registrado: Y líneas).
- [x] **Tipado TypeScript:** `npm run typecheck` (+ `npm run typecheck:web` si aplica) completado con 0 errores.
- [x] **Prueba Funcional:** `[prueba de fuego o atajo verify:partX]` ejecutada con éxito (PASS).
- [x] **Seguridad & Contratos:** No se vulneraron políticas RLS, puertos congelados ni rutas/anclas reales.
- [x] **Live Ledger Actualizado:** Registrado en `docs/LIVE_ARCHITECTURE_LEDGER.md`.
```
