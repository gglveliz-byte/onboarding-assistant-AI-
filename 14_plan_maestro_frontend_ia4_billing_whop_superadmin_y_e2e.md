# PLAN MAESTRO DE CONSTRUCCIÓN DEL FRONTEND — DIVISIÓN 4 DE 4: IA #4 (PANEL DE FACTURACIÓN WHOP, CONSOLA SUPERADMIN, TELEMETRÍA SSE Y CONEXIÓN TOTAL E2E — PARTES 13 A 16)

Este documento define la hoja de ruta exacta para la **IA #4 (Cerebro Orquestador: Facturación Whop, Consola SuperAdmin, Matriz de Precios, Telemetría SSE y Ensamblaje E2E)** dentro de la arquitectura de construcción simultánea con **4 IAs Cabezas (`T = 0`)**, donde cada cabeza actúa como cerebro coordinador que registra el estado en el Ledger y despliega **9 Subagentes Especializados** (para un total de **36 Subagentes en el sistema global**), invocando el sistema de diseño **Cursor Light (Warm Parchment Atelier)** y conectándose contra el **Backend Hexagonal ya construido**.

---

## 1. Arquitectura de Ejecución Simultánea para las 4 IAs Cabezas (Fronteras Físicas de Directorio)

Dado que el **Backend está 100% construido y sellado** en `src/modules/*` con contratos de facturación Whop, gobierno SuperAdmin, telemetría SSE y logs de auditoría inmutables, las 4 IAs Cabezas arrancan en simultáneo sin bloquearse gracias al particionamiento físico estricto de directorios:

| IA Cabeza (Cerebro) | Dominio Asignado | Partes | Subagentes | Directorios Exclusivos de Escritura (Prohibido a otras IAs) | Skills Obligatorias del Escuadrón |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **IA #1** *(Doc 1)* | Cimientos HTTP/WS + Landing Pública Comercial (`/`) | **1 a 4** | **1.1 al 1.9** (9 Subagentes) | `apps/web/src/lib/api-client/`, `apps/web/src/styles/landing-auros-light.css`, `apps/web/src/app/(commercial)/`, `apps/web/src/components/landing/` | `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #2** *(Doc 2)* | Auth B2B/SSO/FIDO2, Legal DPA, Docs (`/docs`), Sandbox y SDK | **5 a 8** | **2.1 al 2.9** (9 Subagentes) | `apps/web/src/styles/dashboard-docs-cursor-atelier.css`, `apps/web/src/components/atelier-primitives/`, `apps/web/src/app/(auth)/`, `apps/web/src/app/legal/`, `apps/web/src/app/docs/`, `packages/sdk/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `import-guardian` |
| **IA #3** *(Doc 3)* | Dashboard Dev: Proyectos, API Keys, Visor Trainer Overlay, RAG SHA-256 y Prompt Studio | **9 a 12** | **3.1 al 3.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/` (excepto `billing`), `apps/web/src/components/dashboard-dev/`, `visual-trainer/`, `rag-editor/`, `prompt-studio/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #4** *(Este Doc)* | Facturación Whop (`/billing`), Consola SuperAdmin, Telemetría SSE y Ensamblaje E2E | **13 a 16** | **4.1 al 4.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/billing/`, `apps/web/src/app/superadmin/`, `apps/web/src/components/billing-whop/`, `apps/web/src/components/superadmin/`, `tests/e2e-frontend/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `pruebas-verificacion-integracion` |

---

## 2. Protocolo del Cerebro Orquestador IA #4 y sus 9 Subagentes Especializados

### 2.1. El Rol del Cerebro Orquestador (IA #4)
La **IA Cabeza #4** actúa como el cerebro coordinador de su carril:
1. **Registro Previo en el Ledger:** Antes de iniciar cualquier trabajo, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` sus directorios reservados bajo el estado `EN_CONSTRUCCION_IA4`.
2. **Despliegue Coordinado de los 9 Subagentes:** Asigna a cada uno de sus 9 subagentes una misión quirúrgica de 2 a 3 archivos (máximo 300 líneas por archivo, nunca superando las 500 líneas físicas).
3. **Construcción Inmediata de Facturación y SuperAdmin (Subagentes 4.1 a 4.8):** Trabajan en paralelo a máxima velocidad desde `T = 0`, pues consumen los endpoints de los Módulos 04 y 06 del Backend que ya están operativos y sellados.
4. **Semáforo del Ensamblaje E2E Final (Subagente 4.9):** Para ejecutar la suite final `tests/e2e-frontend/frontend-backend-full-journey.spec.ts`, el cerebro consulta el Ledger. Si las IAs #1, #2 o #3 están en progreso, el Subagente 4.9 aguarda pacientemente a que marquen `COMPLETADO` para certificar el 100% del Frontend conectado al Backend.

### 2.2. Regla de Convivencia y No Intromisión Físico-Lógica
* **Cero Modificaciones Ajenas:** Si la IA #4 o sus subagentes observan archivos en `(commercial)/`, `(auth)/` o `projects/`, **no los tocan bajo ninguna circunstancia**.
* **Buzón Inter-IA:** Cualquier caso dependiente de otra IA se documenta en el `Buzón de Notificaciones y Dependencias Inter-IA` de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

---

## 3. Asignación Exhaustiva de los 9 Subagentes de la IA #4

```
IA #4 (CEREBRO)
├── Subagente 4.1: Hooks Facturación Whop, Checkout Firmado & Tarjeta de Plan
├── Subagente 4.2: Controles Whop, Protección Spend Cap & Libro Mayor Minuto a Minuto
├── Subagente 4.3: Shell SuperAdmin FIDO2 & Hook de Gobierno de Tenants
├── Subagente 4.4: Grilla Global de Organizaciones, Suspensión & Cola Break-Glass
├── Subagente 4.5: Hook de Matriz de Precios Whop ($5-$50 + PAYG) & Editor de Tramos
├── Subagente 4.6: Gestor de Overrides Manuales por Cliente & Minutos Promocionales
├── Subagente 4.7: Cliente SSE Telemetría en Tiempo Real & Kill-Switch Proveedor IA
├── Subagente 4.8: Explorador de Bitácora de Auditoría SHA-256 SOC2 & Monitor Infra
└── Subagente 4.9: Suite E2E Full-Journey, Auditoría Estricta <500 Líneas & Cierre Total
```

---

### SUBAGENTE 4.1 — Hooks Facturación Whop, Checkout Firmado & Tarjeta de Plan
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/04-billing-and-whop/billing-whop.manifest.ts`, `src/modules/04-billing-and-whop/application/whop-checkout-and-webhooks.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/billing-whop/useOrganizationBillingWhop.ts` (`~270 líneas`):
     - Consume `GET /api/v1/billing/subscription`, `GET /api/v1/billing/usage-ledger` y `GET /api/v1/billing/usage-ledger/export-csv`.
     - Inicia Checkout en Whop (`POST /api/v1/billing/whop/checkout-session`) para `PAYG`, `$5`, `$10`, `$30` y `$50 USD/mes` (manejando `403 DPA_NOT_SIGNED` si el Owner no ha firmado el DPA), abre el Portal de Cliente en Whop (`POST /api/v1/billing/whop/customer-portal`) y actualiza topes de gasto (`PUT /api/v1/billing/spend-cap`).
  2. `apps/web/src/components/billing-whop/CurrentPlanAndBalanceCard.tsx` (`~280 líneas`):
     - Tarjeta en `#f2f1ed` Bone (`4px` radius) con la modalidad activa, barra de progreso de minutos incluidos vs sobreconsumo, tarifa vigente en `berkeleyMono 12px` (`tnum`) y tramo de descuento por volumen alcanzado.

---

### SUBAGENTE 4.2 — Controles Whop, Protección Spend Cap & Libro Mayor Minuto a Minuto
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/04-billing-and-whop/application/billing-dashboard-queries.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/billing-whop/WhopCheckoutAndSpendCapControls.tsx` (`~280 líneas`):
     - Botones de contratación rápida (`btn_subscribe_plan_5` a `plan_50`, `btn_switch_to_payg`), botón `btn_open_whop_customer_portal` y formulario `<SpendProtectionControls />` para límite duro mensual (`hard_spend_cap_usd`) y alertas al 50%, 80% y 100%.
  2. `apps/web/src/components/billing-whop/MinuteByMinuteUsageLedgerTable.tsx` (`~290 líneas`):
     - Tabla auditable con números tabulares (`tnum`), filtros por proyecto, rango de fechas, tipo de asiento (`VOICE_MINUTE_DEDUCTION`, `PLAN_ACTIVATION_GRANT`, `PAYMENT_SUCCEEDED_RENEWAL`, `CREDIT_SUPERADMIN_GRANT`) y motor de voz (`Qwen3.8-Omni` vs `Gemini 3.8 Live`), más botón `btn_export_usage_csv`.
  3. `apps/web/src/app/dashboard/org/[orgSlug]/billing/page.tsx` (`~260 líneas`):
     - Ensambla el `<OrganizationBillingAndUsageDashboard />` completo verificando permisos RBAC (`billing:whop:manage_subscription` exclusivo para `OWNER`, `BILLING` y `SUPERADMIN`).

---

### SUBAGENTE 4.3 — Shell SuperAdmin FIDO2 & Hook de Gobierno de Tenants
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/06-superadmin-governance/superadmin.manifest.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/SuperAdminControlShell.tsx` (`~260 líneas`):
     - Layout de alta densidad en `#f7f7f4` Parchment y sidebar `#f2f1ed` Bone que verifica sesión `is_platform_superadmin === true` con hardware Passkey FIDO2, reloj de expiración de 4 horas y estado de los 3 Node Pools.
  2. `apps/web/src/components/superadmin/useSuperAdminTenantGovernance.ts` (`~270 líneas`):
     - Hooks conectados a `/api/v1/superadmin/organizations/*` y `/users/*` con soporte de confirmación criptográfica WebAuthn (`requireSuperAdminFido2`) para acciones destructivas.

---

### SUBAGENTE 4.4 — Grilla Global de Organizaciones, Suspensión & Cola Break-Glass
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/06-superadmin-governance/application/tenant-governance.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/GlobalTenantGovernanceGrid.tsx` (`~290 líneas`):
     - Buscador instantáneo por ID, slug, Whop ID, dominio o email; tabla con estado del tenant, consumo acumulado, sesiones de voz activas en vivo y botones de suspensión/reactivación.
  2. `apps/web/src/components/superadmin/SuspendTenantAndBreakGlassModals.tsx` (`~270 líneas`):
     - Modal de suspensión (`8px` radius, borde `#cf2d56` Crimson) con motivo obligatorio de auditoría, revoca API keys en Redis y cierra WebSockets activos con código `4003_TENANT_SUSPENDED`.
     - Panel de aprobación de solicitudes de emergencia **Break-Glass** de Owners (`btn_approve_emergency_mfa_reset`).
  3. `apps/web/src/app/superadmin/organizations/page.tsx` (`~270 líneas`):
     - Ensambla la vista principal de gobierno de organizaciones y usuarios del SuperAdmin.

---

### SUBAGENTE 4.5 — Hook de Matriz de Precios Whop ($5-$50 + PAYG) & Editor de Tramos
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/06-superadmin-governance/application/pricing-matrix-and-overrides.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/useSuperAdminPricingAndOverrides.ts` (`~270 líneas`):
     - Conecta con `PUT /api/v1/superadmin/pricing-matrix`, `POST /api/v1/superadmin/organizations/:orgId/pricing-override` y `POST /api/v1/superadmin/organizations/:orgId/promotional-minutes`, con simulador de impacto financiero en cliente.
  2. `apps/web/src/components/superadmin/GlobalWhopPricingMatrixEditor.tsx` (`~300 líneas`):
     - Editor tabular para modificar en caliente `whop_plan_id`, precio mensual, minutos incluidos y tarifa de sobreconsumo de `PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30` y `PLAN_50`, más el editor `<VolumeDiscountTiersEditor />` (`10%`, `20%`, `35%`, `50%`).
  3. `apps/web/src/app/superadmin/pricing-matrix/page.tsx` (`~260 líneas`):
     - Vista de la matriz global Whop y tramos de volumen con confirmación biométrica FIDO2.

---

### SUBAGENTE 4.6 — Gestor de Overrides Manuales por Cliente & Minutos Promocionales
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/TenantPricingOverrideManager.tsx` (`~310 líneas`):
     - Consola para asignar tarifas especiales a un tenant (con **prioridad absoluta** sobre la matriz general en `CalculateEffectiveRateUseCase`):
       * `custom_rate_per_minute_usd` (ej. `$0.065000/min`).
       * `manual_discount_percentage` (`0%` a `100%`).
       * Tramos de volumen personalizados y vigencia temporal (`effective_from` / `effective_until`).
       * Botón `btn_grant_promotional_minutes` (acredita minutos con asiento `CREDIT_SUPERADMIN_GRANT`).
  2. `apps/web/src/app/superadmin/custom-pricing-overrides/page.tsx` (`~270 líneas`):
     - Vista de overrides manuales y asignación de minutos de cortesía por organización.

---

### SUBAGENTE 4.7 — Cliente SSE Telemetría en Tiempo Real & Kill-Switch Proveedor IA
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/06-superadmin-governance/superadmin.manifest.ts` (`GET /api/v1/superadmin/telemetry/stream`, `POST /api/v1/superadmin/infrastructure/voice-provider-switch`).
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/useRealtimeInfraTelemetrySse.ts` (`~270 líneas`):
     - Suscripción a `GET /api/v1/superadmin/telemetry/stream` que recibe métricas segundo a segundo: sesiones WebSocket activas, minutos consumidos, latencia TTFA (`p50`, `p95`, `p99`), tasa de Barge-in, éxito de `click_element`/`type_text` y alertas Anti-SSRF.
     - Ejecuta el **Kill-Switch** (`POST /api/v1/superadmin/infrastructure/voice-provider-switch`).
  2. `apps/web/src/components/superadmin/RealtimeInfraTelemetryPanel.tsx` (`~300 líneas`):
     - Panel de control con comparador en vivo `Qwen3.8-Omni` vs `Gemini 3.8 Live`, tabla de intentos SSRF bloqueados (`169.254.169.254`, `127.0.0.1`) en `#cf2d56` Crimson y botón `<AtelierCrimsonDangerButton />` para conmutar tráfico en caliente.

---

### SUBAGENTE 4.8 — Explorador de Bitácora de Auditoría SHA-256 SOC2 & Monitor Infra
* **Skills Obligatorias:** `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/06-superadmin-governance/infrastructure/postgres-superadmin-audit.repository.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/superadmin/ImmutableAuditLogExplorer.tsx` (`~290 líneas`):
     - Explorador de la tabla append-only `audit_logs` con filtros por organización, usuario, categoría (`AUTH`, `API_KEY`, `RAG_MAP`, `BILLING_WHOP`, `SSRF_DEFENSE`), visor de `before/after state` y verificador del encadenamiento criptográfico `prev_record_sha256 ➔ record_sha256`.
  2. `apps/web/src/app/superadmin/infrastructure/page.tsx` (`~270 líneas`):
     - Ensambla el Monitor de Infraestructura en Tiempo Real, el Kill-Switch de Voz y el Explorador de Auditoría SOC2.

---

### SUBAGENTE 4.9 — Suite E2E Full-Journey, Auditoría Estricta <500 Líneas & Cierre Total
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `pruebas-verificacion-integracion`.
* **Archivos Asignados a Crear / Modificar:**
  1. `tests/e2e-frontend/frontend-backend-full-journey.spec.ts` (`~310 líneas`):
     - Suite End-to-End que valida la integración completa de los 4 portales contra el Backend real:
       `Landing Auros Light + Demo + Calculadora Whop` ➔ `Registro / Login B2B / DPA` ➔ `API Keys + Entrenamiento Visual + Mapa RAG SHA-256 + Prompt Studio` ➔ `Handshake y Ejecución DOM en @onboarding-assistant/sdk` ➔ `Deducción en /billing y Gobierno SuperAdmin`.
  2. **Auditoría Técnica Automática:** Ejecuta `node scripts/check-file-lines.mjs` certificando `< 500 líneas` en todos los archivos del Frontend y corre `npx tsc --noEmit`.
  3. **Cierre Total del Monorepo en Ledger:** Actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` certificando el cierre de las 16 Partes de Frontend y Backend.

---

## 4. Prompt Maestro de Activación para la IA #4 (`Copy & Paste`)

```markdown
Actúa como la **IA #4 (Cerebro Orquestador: Facturación Whop, Consola SuperAdmin, Telemetría SSE y Ensamblaje E2E)** ejecutando las **Partes 13, 14, 15 y 16** del documento `14_PLAN_MAESTRO_FRONTEND_IA4_BILLING_WHOP_SUPERADMIN_Y_E2E.md`.

REGLAS DE ORQUESTACIÓN CON 9 SUBAGENTES:
1. Actúas como el Cerebro Orquestador: Antes de escribir código, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` que la División 4 entra en construcción.
2. Despliega y coordina de forma organizada a tus **9 Subagentes Especializados (4.1 al 4.9)** siguiendo la división exacta de archivos y misiones de este plan:
   - Subagente 4.1: Hooks de Facturación Whop, Checkout Firmado y Tarjeta de Plan y Descuentos por Volumen.
   - Subagente 4.2: Controles Whop, Protección Spend Cap y Tabla del Libro Mayor Minuto a Minuto con exportación CSV.
   - Subagente 4.3: Shell SuperAdmin FIDO2 con expiración de 4 horas y Hooks de Gobierno de Tenants.
   - Subagente 4.4: Grilla Global de Organizaciones, Modales de Suspensión Inmediata con corte de WebSocket y Break-Glass.
   - Subagente 4.5: Hook de Matriz de Precios Whop ($5-$50 + PAYG) y Editor Global de Precios con Descuentos Escalonados.
   - Subagente 4.6: Gestor de Overrides Comerciales por Organización y Acreditación de Minutos Promocionales.
   - Subagente 4.7: Cliente SSE de Telemetría de Infraestructura en Tiempo Real y Panel con Kill-Switch IA.
   - Subagente 4.8: Explorador de Bitácora de Auditoría Inmutable SHA-256 y Ensamblaje `/superadmin/infrastructure`.
   - Subagente 4.9: Suite E2E Full-Journey (`frontend-backend-full-journey.spec.ts`), Auditoría estricta `wc -l < 500`, validación `tsc` y certificación final en Ledger.
3. Aplica obligatoriamente las skills `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo` y `pruebas-verificacion-integracion`: Superficies `#f7f7f4`, tarjetas `#f2f1ed`, números tabulares (`tnum`) en tablas financieras y de telemetría, y cabecera en español en la línea 1.
4. Escribe únicamente dentro de tus directorios asignados (`apps/web/src/app/dashboard/org/[orgSlug]/billing/`, `apps/web/src/components/billing-whop/`, `apps/web/src/app/superadmin/`, `apps/web/src/components/superadmin/`, `tests/e2e-frontend/`).
5. Semáforo para Subagente 4.9: Los subagentes 4.1 a 4.8 avanzan de inmediato; únicamente para el test E2E final, verifica en `docs/LIVE_ARCHITECTURE_LEDGER.md` que las IAs #1, #2 y #3 hayan completado sus entregas antes de correr la suite global.
```
