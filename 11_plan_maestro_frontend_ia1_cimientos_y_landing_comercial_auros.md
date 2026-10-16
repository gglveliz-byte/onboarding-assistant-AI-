# PLAN MAESTRO DE CONSTRUCCIÓN DEL FRONTEND — DIVISIÓN 1 DE 4: IA #1 (CIMIENTOS COMPARTIDOS Y LANDING PÚBLICA COMERCIAL AUROS LIGHT — PARTES 1 A 4)

Este documento define la hoja de ruta exacta para la **IA #1 (Cerebro Orquestador: Cimientos & Landing Comercial Auros Light)** dentro de la arquitectura de construcción concurrente con **4 IAs Cabezas (`T = 0`)**, donde cada cabeza actúa como cerebro coordinador que registra el estado en el Ledger y despliega **9 Subagentes Especializados** (para un total de **36 Subagentes en el sistema global**), invocando las Skills oficiales y conectándose contra el **Backend Hexagonal ya construido**.

---

## 1. Arquitectura de Ejecución Simultánea para las 4 IAs Cabezas (Fronteras Físicas de Directorio)

Dado que el **Backend está 100% construido y sellado** en `src/modules/*` con contratos REST (`/api/v1/*`), SSE y WebSocket (`WSS /ws/v1/realtime`), las 4 IAs Cabezas arrancan en simultáneo sin bloquearse gracias al particionamiento físico estricto de directorios:

| IA Cabeza (Cerebro) | Dominio Asignado | Partes | Subagentes | Directorios Exclusivos de Escritura (Prohibido a otras IAs) | Skills Obligatorias del Escuadrón |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **IA #1** *(Este Doc)* | Cimientos HTTP/WS + Landing Pública Comercial (`/`) | **1 a 4** | **1.1 al 1.9** (9 Subagentes) | `apps/web/src/lib/api-client/`, `apps/web/src/styles/landing-auros-light.css`, `apps/web/src/app/(commercial)/`, `apps/web/src/components/landing/` | `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #2** *(Doc 2)* | Auth B2B/SSO/FIDO2, Legal DPA, Docs (`/docs`), Sandbox y SDK | **5 a 8** | **2.1 al 2.9** (9 Subagentes) | `apps/web/src/styles/dashboard-docs-cursor-atelier.css`, `apps/web/src/components/atelier-primitives/`, `apps/web/src/app/(auth)/`, `apps/web/src/app/legal/`, `apps/web/src/app/docs/`, `packages/sdk/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `import-guardian` |
| **IA #3** *(Doc 3)* | Dashboard Dev: Proyectos, API Keys, Visor Trainer Overlay, RAG SHA-256 y Prompt Studio | **9 a 12** | **3.1 al 3.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/` (excepto `billing`), `apps/web/src/components/dashboard-dev/`, `visual-trainer/`, `rag-editor/`, `prompt-studio/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto` |
| **IA #4** *(Doc 4)* | Facturación Whop (`/billing`), Consola SuperAdmin, Telemetría SSE y Ensamblaje E2E | **13 a 16** | **4.1 al 4.9** (9 Subagentes) | `apps/web/src/app/dashboard/org/[orgSlug]/billing/`, `apps/web/src/app/superadmin/`, `apps/web/src/components/billing-whop/`, `apps/web/src/components/superadmin/`, `tests/e2e-frontend/` | `estilo-paneles-y-docs-cursor-atelier`, `reglas-globales-construccion-codigo`, `documentadora-live-contexto`, `pruebas-verificacion-integracion` |

---

## 2. Protocolo del Cerebro Orquestador IA #1 y sus 9 Subagentes Especializados

### 2.1. El Rol del Cerebro Orquestador (IA #1)
La **IA Cabeza #1** actúa como el cerebro coordinador de su carril:
1. **Registro Previo en el Ledger:** Antes de iniciar cualquier trabajo, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` los directorios reservados bajo el estado `EN_CONSTRUCCION_IA1`.
2. **Despliegue Coordinado de los 9 Subagentes:** Asigna a cada uno de sus 9 subagentes una misión quirúrgica de 2 a 3 archivos (máximo 300 líneas por archivo, nunca superando las 500 líneas físicas).
3. **Fase 0 de Cimientos Monorepo:** El **Subagente 1.1** inicializa de inmediato `apps/web/package.json` y `apps/web/tsconfig.json` para que todo el monorepo tenga resolución de módulos `@/*` y dependencias Next.js 15.
4. **Supervisión de Auditoría y Entrega:** Recibe el reporte del **Subagente 1.9** (auditoría `wc -l < 500` y `tsc --noEmit`), actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` a `COMPLETADO` y notifica a las IAs #2, #3 y #4 en el buzón inter-IA que los clientes HTTP y DTOs están listos.

### 2.2. Regla de Convivencia y No Intromisión Físico-Lógica
* **Cero Modificaciones Ajenas:** Si la IA #1 o sus subagentes observan archivos en `(auth)/`, `dashboard/`, `superadmin/` o `packages/sdk/`, **no los tocan bajo ninguna circunstancia**.
* **Buzón Inter-IA:** Si una funcionalidad requiere algo de otra IA (ejemplo: pasar parámetros query a `/auth/register` de la IA #2), se escribe la entrada en el `Buzón de Notificaciones y Dependencias Inter-IA` de `docs/LIVE_ARCHITECTURE_LEDGER.md`:
  `[DE: IA #1] ➔ [PARA: IA #2] | Req: Manejo de ?plan=PLAN_50&estimated_minutes=... | Estado: PENDIENTE_DE_IA2`.

---

## 3. Asignación Exhaustiva de los 9 Subagentes de la IA #1

```
IA #1 (CEREBRO)
├── Subagente 1.1: Bootstrap Monorepo Next.js 15 & Contratos Tipados DTO
├── Subagente 1.2: Cliente HTTP en Memoria RAM & Layout Raíz Comercial
├── Subagente 1.3: Tokens CSS Auros Light & Primitivas Visuales Base
├── Subagente 1.4: Hook de Física Acústica & Esfera Bioluminiscente WebGL
├── Subagente 1.5: Hero Comercial, Grafo Molecular RAG & Banner Estadístico
├── Subagente 1.6: Hook WebSocket Demo Voz PCM16 (Barge-in <50ms)
├── Subagente 1.7: CRM Simulado en Shadow DOM, Puntero Overlay & Demo Contenedor
├── Subagente 1.8: Calculadora Dinámica Whop ($5-$50 + Descuento por Volumen)
└── Subagente 1.9: Ensamblaje de '/', Auditoría Estricta <500 Líneas & Cierre Ledger
```

---

### SUBAGENTE 1.1 — Bootstrap Monorepo Next.js 15 & Contratos Tipados Backend-Frontend
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`.
* **Archivos a Investigar (Solo Lectura):** `src/shared/infrastructure/http/http-server.types.ts`, `src/modules/01-identity-and-rbac/identity.manifest.ts`, `src/modules/07-public-commercial-and-sandbox/public-commercial.manifest.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/package.json` (`~160 líneas`): Next.js 15 App Router + React 19 + Tailwind CSS v4 + lucide-react. Alias `@/*` apuntando a `apps/web/src/*`.
  2. `apps/web/tsconfig.json` (`~140 líneas`): Configuración estricta extendiendo la raíz con soporte JSX `preserve`, alias `@/*` y exclusión de `.next`.
  3. `apps/web/src/lib/api-client/backend-contracts.types.ts` (`~260 líneas`): Tipos espejo exactos de los DTOs del Backend: Respuestas de Auth, Matriz Whop (`PricingMatrixDto`), Sesiones Demo Efímeras, Eventos WebSocket de Voz, códigos de error `LEGAL_CONSENT_OUTDATED`, `DPA_NOT_SIGNED`, `INSUFFICIENT_FUNDS`.

---

### SUBAGENTE 1.2 — Cliente HTTP Resiliente en Memoria RAM & Layout Comercial
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `estilo-landing-comercial-auros-claro`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/01-identity-and-rbac/application/register-and-login.use-case.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/lib/api-client/http-client.ts` (`~250 líneas`):
     - Mantiene el JWT `access_token` **exclusivamente en memoria RAM volátil** (prohibido `localStorage`).
     - Adjunta `credentials: 'include'` en cada llamada para transportar la cookie segura `__Host-oa_rt`.
     - Interceptor con cola de reintentos ante `HTTP 401`: pausa peticiones concurrentes, ejecuta refresh silencioso contra `POST /api/v1/auth/refresh` y reanuda la cola.
     - Emite evento global ante `403 LEGAL_CONSENT_OUTDATED` para activar el modal de bloqueo legal.
  2. `apps/web/src/app/(commercial)/layout.tsx` (`~190 líneas`): Layout con `data-portal="commercial-landing"`, fuentes `Matter`, `<PublicCommercialHeader />` y `<PublicCommercialFooter />` sobre fondo base `#E4F5F2`.

---

### SUBAGENTE 1.3 — Tokens CSS Auros Light Mode & Primitivas Visuales
* **Skills Obligatorias:** `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/styles/landing-auros-light.css` (`~240 líneas`):
     - Pila de superficies líquidas Auros: `--surface-liquid-abyss: #F2FBF9`, `--surface-liquid-deep: #E4F5F2`, `--surface-liquid-kelp: #FFFFFF`, `--surface-liquid-lift: #DDF3EF`, `--surface-slate-deep: #B8E0DA`.
     - Tintas de contraste: `--color-text-primary: #012624`, `--color-text-secondary: #23534F`, `--color-text-muted: #567A77`, `--color-stat-ink: #581585` sobre pastilla `#F9E8FF`.
     - Gradientes: `--gradient-aurora` y `--gradient-bioluminescent`.
     - Regla inquebrantable: **Cero sombras (`box-shadow: none`)**, radios cerrados `16px` en tarjetas y `6px` en botones, tipografía `Matter` (pesos 400 y 500).
  2. `apps/web/src/components/landing/primitives/AurosPrimitives.tsx` (`~220 líneas`): Componentes reutilizables: `<AuroraGradientButton />` (`6px` radius), `<DiagonalArrowSquareButton />` (`32x32px`), `<UppercaseTrackedKicker />` (`12px`, tracking `0.12em`), `<LagoonSurfaceCard />` (`16px` radius, borde `1px solid #C5E8E3`).

---

### SUBAGENTE 1.4 — Física Acústica & Esfera Bioluminiscente en Canvas 2D/WebGL
* **Skills Obligatorias:** `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/landing/hero/useAcousticSpherePhysics.ts` (`~260 líneas`):
     - Simula la proyección 3D ortográfica de 420 partículas bioluminiscentes (`#00827C`, `#00B8B0`, `#7A28CB`).
     - Modula el radio y oscilación en función del espectro de frecuencia acústica (`PCM16 16kHz`).
     - Proyecta vectores cinéticos hacia 4 coordenadas DOM reales: `[data-oa-id="btn-new-deal"]`, `[data-oa-id="input-company-tax"]`, `[data-oa-id="btn-validate-cfdi"]`, `[data-oa-id="nav-billing"]`.
  2. `apps/web/src/components/landing/hero/BioluminescentVoiceDomSphere.tsx` (`~290 líneas`):
     - Lienzo Canvas 2D/WebGL de alto rendimiento (estable a 60 FPS sobre `#F2FBF9`).
     - Dibuja la esfera acústica interactiva con rotación al mover el cursor y etiquetas técnicas flotantes con coordenadas normalizadas `(x: 0.64, y: 0.28)` en `Matter 500`.

---

### SUBAGENTE 1.5 — Hero Comercial, Grafo Molecular RAG & Banners Estadísticos
* **Skills Obligatorias:** `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):** `src/modules/03-visual-trainer-and-rag/visual-trainer-rag.manifest.ts`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/landing/hero/HeroArchitectureShowcase.tsx` (`~280 líneas`):
     - Eyebrow: `ONBOARDING AUTÓNOMO END-TO-END · VOZ + EJECUCIÓN FÍSICA EN EL DOM`.
     - Titular H1 en `Matter 500` (`clamp(2.75rem, 5vw, 5.5rem)`, color `#012624`, tracking `-0.04em`).
     - Selector de escenario interactivo, botón `<AuroraGradientButton />` (`"PROBAR ASISTENTE EN VIVO ↓"`) y widget copiador de CLI `npx @onboarding-assistant/cli train`.
  2. `apps/web/src/components/landing/explore/RagDomMolecularGraphSection.tsx` (`~300 líneas`):
     - Columna izquierda: 3 tarjetas apiladas en `#FFFFFF` y `#DDF3EF` (Puntero Overlay sin screenshots, Memoria RAG SHA-256 dual visual/JSON, Estudio del Prompt paso a paso).
     - Columna derecha: Árbol molecular RAG en SVG vectorial plano sobre fondo cinético `"DOM · RAG"` en `140px Matter 500` (`#E0F2EF`).
  3. `apps/web/src/components/landing/explore/BioluminescentStatsBanner.tsx` (`~250 líneas`):
     - Panel `#E4F5F2` (`16px` radius) con métricas gigantes en `86px Matter 500` (`#581585` sobre pastilla `#F9E8FF` de `6px` radius): `<45ms` (Barge-in), `100%` (Aislamiento RLS + SHA-256), `2 Motores` (`Qwen3.8-Omni` & `Gemini 3.8 Live`).

---

### SUBAGENTE 1.6 — Hook WebSocket Demo Voz PCM16 con Barge-in (<50ms)
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`.
* **Archivos a Investigar (Solo Lectura):**
  - `src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case.ts` (`POST /api/v1/public/demo-session`)
  - `src/modules/05-voice-realtime-gateway/application/handle-voice-websocket.use-case.ts` (`WSS /ws/v1/realtime`)
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/landing/live-demo/usePublicVoiceDemoSession.ts` (`~310 líneas`):
     - Invoca `POST /api/v1/public/demo-session` con `{ scenario_id, turnstile_token, preferred_model }`.
     - Máquina de estados: `IDLE` ➔ `REQUESTING_MIC_PERMISSION` ➔ `FETCHING_DEMO_EPHEMERAL_TOKEN` ➔ `CONNECTED_LISTENING` ➔ `AI_SPEAKING` ➔ `EXECUTING_DOM_ACTION` ➔ `DEMO_COMPLETED` | `RATE_LIMITED`.
     - Captura audio a `16kHz PCM16`, abre WebSocket efímero (90 seg), gestiona **Barge-in** (vacía el buffer de audio en `<50ms` y emite `voice.barge_in`) y recibe órdenes `tool.execute` (`click_element`, `type_text`).

---

### SUBAGENTE 1.7 — CRM Simulado en Shadow DOM, Puntero Overlay & Demo Contenedor
* **Skills Obligatorias:** `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`.
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/landing/live-demo/SimulatedCrmShadowCanvas.tsx` (`~300 líneas`):
     - Mini SaaS encapsulado con botones `[data-oa-id="demo-btn-new-deal"]`, inputs `[data-oa-id="demo-input-deal-name"]`, selector de etapa y botón de guardado que responden físicamente a los eventos del asistente.
  2. `apps/web/src/components/landing/live-demo/DemoBioluminescentCursorOverlay.tsx` (`~260 líneas`):
     - Cursor vectorial animado con halo bioluminiscente que viaja a `(x_norm, y_norm)`, dibuja caja de inspección ARIA y muestra el badge `tool.execution.ack (16ms)`.
  3. `apps/web/src/components/landing/live-demo/DemoStepProgressHeader.tsx` (`~260 líneas`):
     - Selector en vivo entre `Qwen3.8-Omni` y `Gemini 3.8 Live`, vúmetro de onda de voz y avance de pasos (`Paso 1` ➔ `Paso 2` ➔ `Paso 3`).
  4. `apps/web/src/components/landing/live-demo/LiveInteractiveVoiceDemo.tsx` (`~310 líneas`):
     - Ensamblador del módulo demo sobre superficie `#FFFFFF` (`16px` radius, borde `1px solid #C5E8E3`, cero sombras), manejando límite de 2 demos por IP cada 24h.

---

### SUBAGENTE 1.8 — Calculadora Dinámica Whop ($5-$50 + Descuento por Volumen)
* **Skills Obligatorias:** `estilo-landing-comercial-auros-claro`, `reglas-globales-construccion-codigo`.
* **Archivos a Investigar (Solo Lectura):**
  - `src/modules/07-public-commercial-and-sandbox/application/public-demo-and-pricing.use-case.ts` (`GET /api/v1/public/pricing-matrix`)
  - `src/modules/04-billing-and-whop/application/calculate-effective-rate.use-case.ts`
* **Archivos Asignados a Crear:**
  1. `apps/web/src/components/landing/pricing/useWhopPricingCalculator.ts` (`~280 líneas`):
     - Consume `GET /api/v1/public/pricing-matrix`.
     - Calcula minutos proyectados y compara: `PAYG`, `$5`, `$10`, `$30` y `$50 USD/mes`. A partir de `$50`, aplica el **Descuento por Volumen Escalonado** (`10%`, `20%`, `35%`, `50%`) sobre minutos extra.
  2. `apps/web/src/components/landing/pricing/VolumeDiscountTierVisualizer.tsx` (`~250 líneas`): Visualizador gráfico de los 4 tramos de descuento por volumen con resaltado bioluminiscente.
  3. `apps/web/src/components/landing/pricing/WhopPlanComparisonCards.tsx` (`~270 líneas`): Tarjetas comparativas de planes con botón hacia `/auth/register?plan=<planCode>&estimated_minutes=<minutes>`.
  4. `apps/web/src/components/landing/pricing/InteractivePricingCalculator.tsx` (`~260 líneas`): Contenedor sobre `#E4F5F2` (`16px` radius, padding `80px 48px`, cero sombras) con los sliders de usuarios guiados y duración.

---

### SUBAGENTE 1.9 — Ensamblaje de '/', Auditoría Estricta <500 Líneas & Cierre Ledger
* **Skills Obligatorias:** `reglas-globales-construccion-codigo`, `documentadora-live-contexto`.
* **Archivos Asignados a Crear / Modificar:**
  1. `apps/web/src/app/(commercial)/page.tsx` (`~230 líneas`): Ensambla `<HeroArchitectureShowcase />`, `<LiveInteractiveVoiceDemo />`, `<RagDomMolecularGraphSection />`, `<BioluminescentStatsBanner />` e `<InteractivePricingCalculator />`.
  2. **Auditoría Técnica Automática:** Ejecuta `node scripts/check-file-lines.mjs` certificando que los 22 archivos de la IA #1 tengan `< 500 líneas` y corre `npx tsc --noEmit`.
  3. **Cierre y Notificación en Ledger:** Actualiza `docs/LIVE_ARCHITECTURE_LEDGER.md` registrando la División 1 como `LISTO_PARA_CONSUMO` y notifica a las IAs #2, #3 y #4 en el buzón inter-IA.

---

## 4. Prompt Maestro de Activación para la IA #1 (`Copy & Paste`)

```markdown
Actúa como la **IA #1 (Cerebro Orquestador: Cimientos & Landing Comercial Auros Light)** ejecutando las **Partes 1, 2, 3 y 4** del documento `11_PLAN_MAESTRO_FRONTEND_IA1_CIMIENTOS_Y_LANDING_COMERCIAL_AUROS.md`.

REGLAS DE ORQUESTACIÓN CON 9 SUBAGENTES:
1. Actúas como el Cerebro Orquestador: Antes de escribir código, carga la skill `documentadora-live-contexto` y registra en `docs/LIVE_ARCHITECTURE_LEDGER.md` que la División 1 entra en construcción.
2. Despliega y coordina de forma organizada a tus **9 Subagentes Especializados (1.1 al 1.9)** siguiendo la división exacta de archivos y misiones de este plan:
   - Subagente 1.1: Bootstrap de Monorepo Next.js 15 (`package.json`, `tsconfig.json`) y Contratos DTO.
   - Subagente 1.2: Cliente HTTP en memoria RAM (`http-client.ts`) y Layout raíz comercial.
   - Subagente 1.3: Tokens CSS Auros Light Mode y Primitivas Visuales (`AurosPrimitives.tsx`).
   - Subagente 1.4: Hook de Física Acústica y Esfera Bioluminiscente WebGL.
   - Subagente 1.5: Hero Comercial, Grafo Molecular RAG y Banner Estadístico.
   - Subagente 1.6: Hook WebSocket Demo de Voz PCM16 (Barge-in <50ms).
   - Subagente 1.7: CRM Simulado en Shadow DOM, Puntero Overlay y Demo en Vivo.
   - Subagente 1.8: Hook Calculadora Whop ($5-$50 + Descuentos por Volumen) y Componentes Visuales.
   - Subagente 1.9: Ensamblaje de '/', Auditoría estricta `wc -l < 500`, validación `tsc` y reporte de cierre en Ledger.
3. Aplica obligatoriamente las skills `estilo-landing-comercial-auros-claro` y `reglas-globales-construccion-codigo`: Cero sombras (`box-shadow: none`), paleta líquida `#F2FBF9` a `#DDF3EF`, fuentes Matter 500 y cabecera en español en la línea 1 de cada archivo.
4. Escribe únicamente dentro de tus directorios asignados (`apps/web/src/lib/api-client/`, `apps/web/src/styles/landing-auros-light.css`, `apps/web/src/app/(commercial)/`, `apps/web/src/components/landing/`). Si detectas dependencias con las IAs #2, #3 o #4, anótalas en el "Buzón de Notificaciones y Dependencias Inter-IA" de `docs/LIVE_ARCHITECTURE_LEDGER.md`.
```
