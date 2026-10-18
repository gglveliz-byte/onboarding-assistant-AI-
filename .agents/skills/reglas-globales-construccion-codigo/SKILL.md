---
name: reglas-globales-construccion-codigo
description: >-
  Reglas globales obligatorias de ingeniería de software para agentes de IA que construyen o modifican código en la plataforma SaaS Onboarding Assistant & Realtime Voice Gateway. Aplica límite estricto de 500 líneas por archivo, partición modular automática, cabeceras de documentación en español, lectura previa de documentación viva y parada obligatoria ante conflictos entre múltiples IAs concurrentes.
---

# Skill Global 01: Reglas Estrictas de Construcción de Código, Modularidad (<500 Líneas) y Concurrencia Multi-Agente

Esta skill establece las leyes inquebrantables de ingeniería que todo agente de IA debe obedecer antes, durante y después de escribir o modificar cualquier archivo del repositorio (`Backend Hexagonal`, `Frontend Multi-Portal`, `@onboarding-assistant/sdk`, `@onboarding-assistant/cli` y `Scripts SQL/Lua`).

## Cuándo Activar esta Skill

Activa y aplica estas reglas en el 100% de las tareas que involucren:

- Crear nuevos archivos de código fuente, esquemas de base de datos, estilos o configuraciones.
- Modificar, refactorizar, optimizar o corregir errores en archivos existentes.
- Integrar nuevos endpoints, casos de uso, componentes de UI, adaptadores de voz (`Qwen3.8-Omni` / `Gemini 3.8 Live`) o flujos de facturación (`Whop`).
- Trabajar en paralelo cuando otra instancia o agente de IA está operando sobre el mismo repositorio.

## Regla 1: Protocolo Obligatorio "Investigar Primero, Codificar Después" (Cero Ejecución a Ciegas)

Ningún agente de IA tiene permitido crear o editar un archivo sin haber ejecutado previamente esta secuencia de reconocimiento de 4 pasos:

1. **Lectura del Registro Vivo (`docs/LIVE_ARCHITECTURE_LEDGER.md`):**
   - Lee siempre primero el archivo gestionado por la Skill Documentadora Live para conocer el estado actual del proyecto, los módulos ya construidos, las dependencias existentes y los bloqueos activos de otros agentes.
2. **Localización Quirúrgica de Archivos por Dominio:**
   - Usa la tabla de enrutamiento del documento vivo para identificar exactamente qué archivos pertenecen al flujo que vas a intervenir. Lee únicamente los archivos de ese módulo (Puertos, Casos de Uso, Entidades y Adaptadores implicados) para comprender sus contratos exactos.
3. **Verificación Anti-Duplicación de Dependencias y Utilidades:**
   - Revisa la sección `Inventario de Dependencias y Kernel Compartido` en `docs/LIVE_ARCHITECTURE_LEDGER.md` y el archivo `package.json` correspondiente antes de crear funciones auxiliares o instalar librerías.
   - Si ya existe una utilidad en `src/shared/kernel/` (por ejemplo, `CryptoUtils.sha256()`, `CanonicalJsonHasher`, `Result<T, E>`, `PostgresRlsTransaction` o `RedisTokenBucket`), impórtala y reutilízala. Queda prohibido duplicar helpers criptográficos, clientes HTTP, validadores de esquemas o componentes base de UI.
4. **Protección de Integraciones Existentes (No Regresión):**
   - Está estrictamente prohibido eliminar funciones exportadas, alterar firmas de interfaces públicas (`Ports`), borrar políticas RLS o simplificar validaciones de seguridad (como el escudo Anti-SSRF o el bloqueo pesimista `SELECT ... FOR UPDATE`) para "hacer que algo compile rápido".
   - Nunca uses placeholders como `// TODO`, `// implementar aquí` o `// lógica restante`. Todo código escrito debe ser completo y funcional de principio a fin.

## Regla 2: Límite Inquebrantable de 500 Líneas por Archivo y Particionamiento Modular

Ningún archivo del proyecto puede superar jamás las **500 líneas físicas de código** (incluyendo comentarios de cabecera, imports y espacios en blanco).

### Umbrales de Acción Automática

| Conteo de Líneas del Archivo | Estado | Acción Obligatoria del Agente de IA |
| :--- | :--- | :--- |
| **1 a 380 líneas** | Saludable | Puedes añadir o modificar código dentro del archivo manteniendo cohesión de responsabilidad única (SRP). |
| **381 a 450 líneas** | Alerta Preventiva | Antes de agregar una nueva función, subcomponente o método, evalúa si excederá las 450 líneas. Si la respuesta es sí, extrae la nueva lógica en un archivo nuevo independiente. |
| **451 a 500 líneas** | Límite Crítico | Prohibido agregar nuevas líneas netas a este archivo. Debes dividir el archivo inmediatamente en 2 o más sub-módulos cohesivos antes de integrar tu cambio. |
| **Más de 500 líneas** | Violación Bloqueante | El trabajo se considera inválido. Refactoriza y divide el archivo de inmediato hasta que todos los archivos resultantes tengan menos de 400 líneas. |

### Estrategia Estándar para Dividir Archivos sin Romper Importaciones

Cuando necesites dividir un archivo para respetar el límite de 500 líneas, aplica el patrón de **Descomposición por Responsabilidad con Barril Explícito**:

- **En Backend Hexagonal (`src/modules/<modulo>/`):**
  - Separa cada Caso de Uso en su propio archivo: `create-api-key.use-case.ts`, `rotate-api-key.use-case.ts`, `revoke-api-key.use-case.ts`.
  - Separa las consultas SQL complejas o mapeadores de filas (`RowMappers`) en archivos dedicados: `whop-subscription.queries.ts` y `whop-subscription.mapper.ts`.
  - Separa los validadores de entrada DTO/Zod en `*.schema.ts` y los tipos/interfaces de dominio en `*.types.ts`.
- **En Frontend (workspace único `apps/web/`; landing, auth, docs, legal, dashboard y superadmin viven como grupos de rutas dentro de `apps/web/src/app/`: `(commercial)/`, `(auth)/`, `docs/`, `legal/`, `dashboard/org/[orgSlug]/`, `superadmin/`):**
  - Un archivo de vista o página (`page.tsx`) nunca debe contener la lógica de negocio ni subcomponentes extensos; solo orquesta el layout.
  - Extrae cada bloque visual en subcomponentes propios (`<ElementTaggingModal />`, `<ResponsiveViewportSwitcher />`, `<SelectorCascadePreview />`).
  - Extrae la máquina de estados, llamadas a API y hooks de WebSocket en hooks dedicados (`useRemoteTrainerSession.ts`, `useVoiceRealtimeSocket.ts`).

### Verificación Ejecutable de Líneas

Después de cada creación o edición de archivos, ejecuta siempre el auditor oficial del repositorio:

```bash
npm run check:lines
```

Equivale a `node scripts/check-file-lines.mjs`: recorre todo el código fuente, imprime el conteo por archivo y clasifica su estado (Saludable, Alerta preventiva 381–450, Límite crítico 451–500, Violación >500). **Criterio de aprobación: 0 violaciones.** Si un archivo supera las 500 líneas, divídelo antes de actualizar la documentación o responder al usuario.

## Regla 3: Estándar Obligatorio de Documentación en Español Dentro de Cada Archivo

Todo el código del sistema debe estar documentado **100% en español** de forma técnica, clara y precisa.

### 3.1. Cabecera Obligatoria de Archivo (En la Línea 1 de Todo Archivo)

Cada archivo creado o modificado debe incluir al inicio un bloque documental estructurado que resuma qué es el archivo, todo lo que contiene y cómo se conecta con el resto del sistema:

```typescript
/**
 * @archivo src/modules/04-billing-and-whop/application/deduct-session-minutes.use-case.ts
 * @modulo 04-billing-and-whop (Facturación, Suscripciones Whop y Libro Mayor)
 * @proposito
 *   Ejecuta la deducción transaccional de minutos de voz en tiempo real aplicando bloqueo
 *   pesimista (SELECT ... FOR UPDATE) en PostgreSQL para prevenir condiciones de carrera
 *   cuando múltiples sesiones WebSocket consumen saldo simultáneamente.
 *
 * @resumen_contenido
 *   - Interfaz `DeductSessionMinutesInput`: Parámetros del pulso de consumo (orgId, sessionId, segundos).
 *   - Interfaz `DeductSessionMinutesOutput`: Estado resultante del saldo, costo aplicado y banderas de corte.
 *   - Clase `DeductSessionMinutesUseCase`:
 *       * `execute()`: Orquesta la transacción atómica, invoca el cálculo de tarifas/descuentos
 *         y registra el asiento contable inmutable en `usage_ledger`.
 *       * `shouldTerminateSession()`: Determina si la sesión de voz debe cerrarse con código 4002.
 *
 * @dependencias_internas
 *   - `CalculateEffectiveRateUseCase` (./calculate-effective-rate.use-case.ts)
 *   - `IPostgresBillingRepository` (../ports/postgres-billing.repository.port.ts)
 *   - `DecimalMath` (src/shared/kernel/decimal-math.util.ts)
 *
 * @dependencias_externas
 *   - Ninguna (Núcleo de aplicación puro sin acoplamiento a librerías externas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` (Lectura/Escritura con FOR UPDATE, RLS activo).
 *   - PostgreSQL: `usage_ledger` (Inserción append-only, RLS activo).
 *   - Redis: `org:<org_id>:billing` (Actualización de estado en caché).
 */
```

### 3.2. Documentación de Funciones, Clases, Componentes y TiposInternos

Toda función, método público/privado, componente React o interfaz exportada dentro del archivo debe tener su comentario JSDoc en español inmediatamente encima de su declaración:

```typescript
/**
 * Calcula la tarifa efectiva por minuto aplicando en orden de precedencia:
 * 1) Override manual del SuperAdmin por organización,
 * 2) Tramos de descuento por volumen escalonado (a partir del Plan de $50 USD),
 * 3) Tarifa base del plan activo en Whop.
 *
 * @param overageMinutesUsed - Minutos acumulados en exceso durante el ciclo de facturación actual.
 * @param subscription - Estado bloqueado de la suscripción Whop de la organización.
 * @param override - Configuración especial del SuperAdmin si existe y está vigente.
 * @returns Objeto con la tarifa unitaria final en USD y el porcentaje de descuento aplicado.
 */
```

## Regla 4: Protocolo de Concurrencia para Múltiples IAs Trabajando al Mismo Tiempo

Cuando dos o más agentes de IA trabajan de forma simultánea sobre este proyecto, la preservación de la integridad del código tiene prioridad absoluta sobre la velocidad de escritura.

### 4.1. Detección de Colisiones y Recursos Compartidos Críticos

Se considera **Situación de Conflicto Potencial** cualquiera de los siguientes escenarios:

1. **Bloqueo Activo en el Ledger Live:** El archivo o módulo que necesitas editar aparece marcado como `EN_EDICION` por otro agente en `docs/LIVE_ARCHITECTURE_LEDGER.md`.
2. **Modificación de Contratos Globales o Compartidos:** Tu tarea requiere alterar:
   - Tablas, columnas o políticas RLS en `migrations/` o el DDL de PostgreSQL.
   - Claves o scripts Lua de Redis en `src/shared/infrastructure/redis/`.
   - Interfaces de puertos compartidos (`IVoiceRealtimeProvider`, `IBillingDeductionPort`, `IRagMapQueryPort`).
   - Tipos de tramas WebSocket entre el `@onboarding-assistant/sdk` y el Gateway de Voz.
   - Variables de entorno (`.env.example`), `package.json` raíz o tokens globales de diseño CSS (`@theme`).
3. **Cambio Inesperado Detectado en Disco:** Al leer un archivo antes de editarlo, notas que su contenido o firma difiere de lo registrado en el último corte de `docs/LIVE_ARCHITECTURE_LEDGER.md`.

### 4.2. Regla Estricta de Parada y Consulta al Usuario ("Stop & Ask Protocol")

Ante cualquier Situación de Conflicto Potencial, **DETÉN INMEDIATAMENTE toda escritura sobre los archivos en disputa** y formula una pregunta directa al usuario siguiendo esta estructura exacta:

1. **Alerta de Conflicto Multi-Agente:** Indica qué archivo, tabla o interfaz compartida está involucrada.
2. **Causa del Riesgo:** Explica en una oración por qué modificarlo unilateralmente podría sobrescribir o romper el trabajo del otro agente de IA.
3. **Opciones de Decisión Claras:** Ofrece opciones concretas (por ejemplo: crear un adaptador/extensión en un archivo separado sin tocar el contrato compartido, esperar a que el otro agente libere el módulo, o aplicar la modificación coordinada con la firma exacta propuesta) y espera la confirmación del usuario antes de proceder.

### 4.3. Protocolo de Alertas Cruzadas y Limpieza Obligatoria de Avisos Resueltos (Cross-Agent Notice & Purge)

Para garantizar un relevo armonioso y sin fricciones entre agentes concurrentes:

1. **Emisión de Alerta Cruzada (Detección sin Invasión):**
   - Si un agente (ej. Carril 1) detecta durante su verificación general que existen errores de compilación (`tsc`), tipado estricto o incompatibilidades en archivos que pertenecen al módulo asignado al otro agente (ej. Carril 2), **no debe modificar esos archivos ajenos**.
   - En su lugar, debe documentar una alerta técnica precisa en el encabezado de `docs/LIVE_ARCHITECTURE_LEDGER.md` (especificando los archivos exactos, el número de errores detectados y la causa probable, ej. `exactOptionalPropertyTypes`).
2. **Recepción y Subsanación Quirúrgica:**
   - El agente responsable de ese carril, al iniciar su turno, debe leer obligatoriamente la alerta, priorizar la resolución de raíz de dichos errores sin degradar banderas estrictas de TypeScript (`strict`, `exactOptionalPropertyTypes`, `noImplicitAny`), y verificar `npm run typecheck` (monorepo) más `npm run typecheck:web` (workspace `apps/web`).
3. **Limpieza Obligatoria del Aviso ("Notice Purge"):**
   - Una vez que los errores hayan sido corregidos y la verificación arroje **0 errores**, el agente que subsanó el problema **TIENE LA OBLIGACIÓN ESTRICTA de eliminar o purgar la alerta del encabezado y de las notas operativas activas del Ledger**.
   - El encabezado del Ledger debe reflejar siempre el estado limpio y actual del repositorio (ej. `0 ERRORES EN TODO EL MONOREPO`), trasladando el registro de la corrección a la bitácora histórica de la Parte en la Sección 5.
   - **Propósito:** Prevenir que futuros agentes o desarrolladores humanos lean alarmas obsoletas de fallos que ya fueron resueltos, evitando parálisis o falsas asunciones de regresión.

## Regla 5: Cero Fuga de Infraestructura en Interfaces de Usuario (Zero Backend Leakage)

Al generar código o textos para cualquier interfaz visible de usuario (Landing Comercial, Documentación, Sandbox, Modales de Checkout, Dashboard o Widget del SDK):

1. **Prohibición Absoluta de Nombres de Modelos LLM y Proveedores de IA:** Queda terminantemente vetado exponer en cualquier pantalla, landing, modal, badge o texto visible al usuario final nombres de modelos fundacionales o proveedores (`Qwen`, `Qwen3.8-Omni-Flash-Realtime`, `Gemini`, `Gemini 3.8 Live`, `OpenAI`, `ChatGPT`, `Claude`, `Anthropic`, `DeepSeek`). Para el cliente, la tecnología es siempre la IA propietaria de la plataforma: *"Motor de Voz Inteligente en Tiempo Real"*, *"Asistente Autónomo en Vivo"* o *"Inteligencia Conversacional de Onboarding Assistant"*.
2. **Prohibición de Proveedores de Infraestructura y Pagos:** Queda igualmente prohibido mencionar `Whop`, `Docker`, `Playwright`, `Chromium`, `PostgreSQL`, `WebSockets` o `PCM16`.
3. **Tono de Marca y Enfoque en Valor:** El copy debe ser 100% comercial, profesional y centrado en la solución:
   - En lugar de "Powered by Gemini / Qwen" ➔ Escribir **"Impulsado por el Motor de Voz Inteligente de [Tu Marca]"**.
   - En lugar de "Pagar con Whop" ➔ Escribir **"Pago seguro con tarjeta"** o **"Activar suscripción"**.
   - En lugar de "Conectando WebSocket PCM16" ➔ Escribir **"Iniciando asistente en tiempo real"**.
   - En lugar de "Chromium en Docker con Anti-SSRF" ➔ Escribir **"Entorno de entrenamiento visual seguro"**.

## Errores Comunes que Debes Evitar (Gotchas)

- **Comprimir código en una sola línea para burlar el límite de 500 líneas:** Prohibido minificar o apilar múltiples sentencias por línea. El código debe estar formateado con sangría estándar legible y mantener menos de 500 líneas reales.
- **Escribir comentarios en inglés por inercia del modelo:** Aunque los identificadores de código (`function calculateEffectiveRate`) estén en inglés técnico estándar, **todos los bloques `@proposito`, `@resumen_contenido` y comentarios explicativos deben estar íntegramente en español**.
- **Omitir la lectura inicial de `docs/LIVE_ARCHITECTURE_LEDGER.md`:** Nunca asumas qué archivos existen basándote solo en el nombre de una carpeta; lee siempre el registro vivo primero.
- **Dejar escapar tecnicismos en la UI:** Nunca uses nombres de librerías o infraestructura en botones o textos de usuario; habla siempre desde la marca y el valor comercial.
