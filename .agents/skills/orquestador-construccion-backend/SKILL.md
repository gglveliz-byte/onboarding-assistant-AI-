---
name: orquestador-construccion-backend
description: >-
  Skill maestra y orquestadora padre para la construcción modular del backend en 16 partes del Onboarding Assistant AI (estado actual: las 16 partes están COMPLETADAS y selladas). Úsala cuando el usuario mencione cualquiera de las 16 partes del backend (ej: "la parte 3", "revisa la parte 9", "siguiente parte") para leer su bitácora, re-ejecutar sus verificaciones y reportar el estado real. Conecta la orden del usuario con los planos de ingeniería (09 y 10), el Ledger Live (docs/LIVE_ARCHITECTURE_LEDGER.md), el archivo orden.md y las reglas de construcción de código.
---

# 🧠 Skill Padre Orquestadora: Construcción Modular del Backend en 16 Partes

Esta skill gobierna la ejecución secuencial o paralela del Backend Monolito Modular Hexagonal para la plataforma SaaS **Onboarding Assistant AI & Realtime Voice Gateway**.

Su propósito es que cuando el usuario escriba en el chat una orden corta como:
> *"Comienza con la parte 1 de la construcción del backend usa las skills"*  
> *"Ejecuta la parte 4"* o *"Siguiente parte"*

Cualquier agente de IA (**DeepSeek V4.1 Flash** o **Gemini 3.8 Flash**) sepa exactamente qué archivos leer, qué archivos crear, qué modelo le corresponde y cómo registrar su avance sin pedir instrucciones adicionales.

---

## ⚠️ Estado de la Obra (2026-10-18): 16/16 PARTES COMPLETADAS Y SELLADAS

Las 16 partes del backend **ya están construidas, auto-ensambladas y verificadas** de extremo a extremo: `npm run test:e2e` superado con **74/74 aserciones**, suites troncales en verde (`test:auth-routes`, `test:auth-flow`, `test:billing`, `test:rates`, `test:deduction`, `test:governance`, `test:public-sdk`, `test:trainer`) y `npm run typecheck` con 0 errores. Esta skill ya no dispara construcción desde cero; cuando el usuario mencione una «Parte X», el agente debe:

1. Leer la bitácora de esa parte en `docs/LIVE_ARCHITECTURE_LEDGER.md` (Sección 5) y sus filas de inventario (Sección 4).
2. Re-ejecutar su verificación oficial con los atajos reales de `package.json`: `npm run verify:part1/2/3/7/9/10/11/12/13/14/15/16` (líneas + tipos + pruebas de la parte).
3. Reportar el estado real; solo extender o refactorizar bajo órdenes explícitas del usuario.

La matriz de asignación por modelo que sigue se conserva como registro histórico de la construcción original.

---

## 🗺️ 1. Mapa de Rutas de Ingeniería (Dónde está la Especificación de Cada Parte)

El detalle exhaustivo de código de cada Parte vive en estos dos documentos maestros:

* **Partes 1 a 8:** [`09_plan_maestro_construccion_backend_parte_1_cimientos_y_nucleo.md`](file:///c:/Users/HP/OneDrive/Documentos/GitHub/Onboarding%20assistant/09_plan_maestro_construccion_backend_parte_1_cimientos_y_nucleo.md)
* **Partes 9 a 16:** [`10_plan_maestro_construccion_backend_parte_2_whop_voz_y_conexion_total.md`](file:///c:/Users/HP/OneDrive/Documentos/GitHub/Onboarding%20assistant/10_plan_maestro_construccion_backend_parte_2_whop_voz_y_conexion_total.md)
* **Asignación de Modelos:** [`orden.md`](file:///c:/Users/HP/OneDrive/Documentos/GitHub/Onboarding%20assistant/orden.md)

### Matriz Rápida de Asignación por Parte:

| Parte | Nombre Técnico del Módulo | Modelo Asignado | Documento Origen |
| :---: | :--- | :---: | :---: |
| **1** | Cimientos, TypeScript estricto y 4 Migraciones SQL (DDL + RLS) | **DeepSeek V4.1** | `09_plan_maestro...` |
| **2** | Kernel Compartido (`CryptoUtils`, `DecimalMath`, Pool RLS) | **DeepSeek V4.1** | `09_plan_maestro...` |
| **3** | Redis Cluster, Lua Token Bucket y **Sellado de Todos los Puertos** | **DeepSeek V4.1** | `09_plan_maestro...` |
| **4** | Módulo 01-A: Login Argon2id 350ms, JWT EdDSA, Refresh rotativo | **DeepSeek V4.1** | `09_plan_maestro...` |
| **5** | Módulo 01-B: MFA WebAuthn/TOTP, SAML 2.0, CLI Device Flow y Legal ToS/DPA | **Gemini 3.8** | `09_plan_maestro...` |
| **6** | Módulo 02: Proyectos, `allowed_domains`, API Keys SHA-256 y Handshake SDK | **Gemini 3.8** | `09_plan_maestro...` |
| **7** | Módulo 03-A: Escudo Anti-SSRF DNS Pinning + Chromium efímero en Docker | **DeepSeek V4.1** | `09_plan_maestro...` |
| **8** | Módulo 03-B/C: Mapa RAG SHA-256, pgvector, Context Slimming y Prompt Studio | **Gemini 3.8** | `09_plan_maestro...` |
| **9** | Módulo 04-A: Whop Checkout firmado y Webhooks HMAC-SHA256 con idempotencia | **DeepSeek V4.1** | `10_plan_maestro...` |
| **10** | Módulo 04-B: Tarificación Whop $5-$50, Overage y Deducción `FOR UPDATE` | **DeepSeek V4.1** | `10_plan_maestro...` |
| **11** | Módulo 05-A: Adaptador Realtime `Qwen3.8-Omni` y Ring Buffer PCM16 en RAM | **DeepSeek V4.1** | `10_plan_maestro...` |
| **12** | Módulo 05-B: Adaptador Realtime `Gemini 3.8 Live` y Conmutador Failover | **Gemini 3.8** | `10_plan_maestro...` |
| **13** | Módulo 05-C: Servidor WebSocket PCM16, VAD, Barge-in y Despacho click/type | **DeepSeek V4.1** | `10_plan_maestro...` |
| **14** | Módulo 06: Gobierno SuperAdmin (Tenants, Matriz Whop, Overrides y Auditoría) | **Gemini 3.8** | `10_plan_maestro...` |
| **15** | Endpoints Públicos de Demostración (`demo-session`, `pricing-matrix`, Sandbox) | **Gemini 3.8** | `10_plan_maestro...` |
| **16** | Contenedor DI Auto-Wiring, Entrypoints de los 3 Node Pools y Tests E2E | **DeepSeek V4.1** | `10_plan_maestro...` |

---

## 🔄 2. Protocolo de Ejecución Obligatorio en 4 Pasos (Para Cualquier "Parte X")

Cuando el usuario pida ejecutar una Parte, el agente de IA debe cumplir estrictamente estos 4 pasos sin saltarse ninguno:

### Paso 1: Localización del Bloque de Trabajo
1. Abre el documento correspondiente (`09` para Partes 1-8 o `10` para Partes 9-16).
2. Localiza la sección `### PARTE X:` y extrae:
   - La lista exacta de los **4 a 6 archivos a crear**.
   - Los **Archivos de Lectura Previa Obligatoria**.
   - Los requisitos técnicos y validaciones específicas.

### Paso 2: Fase de Pre-Vuelo (Contexto y Dependencias)
1. Lee `docs/LIVE_ARCHITECTURE_LEDGER.md` para verificar qué módulos ya están construidos y qué utilidades existen en la Sección 2 (Catálogo de Dependencias).
2. Si la Parte interactúa con la base de datos, lee las credenciales en `.env` (`DATABASE_URL`).
3. Revisa los archivos de puertos o entidades previas de las que depende tu Parte.

### Paso 3: Generación Quirúrgica del Código
Aplica obligatoriamente las reglas de la skill `reglas-globales-construccion-codigo`:
1. **Tope Estricto:** Ningún archivo puede superar las **500 líneas de código**.
2. **Cero Placeholders:** Prohibido emitir `// TODO: implementar aquí`, `/* restante */` o elipsis. Todo debe estar programado al 100%.
3. **Comentarios y JSDoc en Español:** Identificadores en inglés técnico (`function calculateEffectiveRate`), pero `@proposito`, `@param`, `@returns` y comentarios explicativos **100% en español**.
4. **Cero Fuga de Terceros en Interfaces (Regla 5):** Si creas o tocas vistas de usuario, jamás menciones `Whop`, nombres de LLMs (`Qwen`, `Gemini`) ni librerías internas; usa siempre lenguaje comercial de marca.

### Paso 4: Verificación y Pruebas de Calidad (Obligatorio)
Aplica obligatoriamente la skill `pruebas-verificacion-integracion`:
1. Ejecuta la auditoría de líneas oficial: `npm run check:lines` (`scripts/check-file-lines.mjs`) certificando **0 violaciones** del tope de 500 líneas.
2. Ejecuta el tipado estricto: `npm run typecheck` (monorepo) y `npm run typecheck:web` si tocaste `apps/web`.
3. Ejecuta la **Prueba de Fuego** con los atajos reales de `package.json`: `npm run verify:partX` (combina líneas + tipos + pruebas de la parte), o el test específico (`npm run test:webhook`, `npm run test:e2e`, `npm run db:migrate`, etc.).
4. Si alguna prueba falla, corrige el código inmediatamente antes de reportar al usuario.

### Paso 5: Cierre y Actualización del Live Ledger
Aplica obligatoriamente la skill `documentadora-live-contexto`:
1. Actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md`:
   - Agrega los archivos creados a la tabla de enrutamiento.
   - Si creaste una utilidad reutilizable, anótala en la Sección 2 (Catálogo de Dependencias).
   - Libera cualquier bloqueo en el semáforo multi-agente (Sección 3).
2. Reporta al usuario la tabla estándar de calidad con los archivos creados, líneas de código y estado de las pruebas.

