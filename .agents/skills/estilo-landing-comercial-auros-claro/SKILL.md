---
name: estilo-landing-comercial-auros-claro
description: >-
  Sistema de diseño visual, tokens CSS/Tailwind v4, arquitectura de presentación e interacciones para la Landing Pública Comercial (/) basado en la estética Auros adaptada a Tema Claro (Light Mode Bioluminiscente). Úsalo siempre que construyas o edites la Landing Comercial, sus fondos interactivos de voz/DOM, la demostración en vivo o la calculadora de planes Whop.
---

# Skill Global 03: Sistema de Diseño y Presentación de la Landing Pública Comercial (Auros Light - Terminal Bioluminiscente en Tema Claro)

Esta skill define el lenguaje visual obligatorio, los tokens de color convertidos a **Tema Claro (Light Mode)**, la tipografía mecánica (`Matter` pesos 400 y 500), las formas interactivas propias del producto y la estructura exacta de información para la **Landing Pública Comercial (`/`)**.

## Cuándo Activar esta Skill

Activa esta skill siempre que trabajes en:

- La página principal comercial (`/`), sus secciones explicativas, barra de navegación pública o footer.
- Los elementos gráficos e interactivos del producto en la landing: Esfera Acústica Bioluminiscente de Voz, Grafo Molecular de Mapeo DOM/RAG, Demostración en Vivo (`<LiveInteractiveVoiceDemo />`) y Calculadora Interactiva de Planes Whop (`<InteractivePricingCalculator />`).
- Hojas de estilo globales o configuración de `@theme` (Tailwind v4) correspondientes al portal público comercial.

---

## 1. Filosofía Visual: De "Abyssal Dark" a "Luminous Shallow Lagoon" (Tema Claro)

La estética conserva el ADN de ingeniería instrumental de **Auros** (tipografía `Matter` exclusivamente en pesos `400` y `500` con tracking negativo agresivo en titulares, etiquetas técnicas uppercase con tracking amplio, radios estrictos de `16px` en tarjetas y `6px` en botones, **cero sombras (`box-shadow: none`)** y gradientes bioluminiscentes), pero invierte la pila de superficies hacia un **Tema Claro Mineral (Light Mode)**:

- **Jerarquía por Capas de Agua Clara (Sin Sombras):** La profundidad nunca se expresa con `box-shadow` ni grises neutros. Se expresa mediante 4 niveles de superficie con subtono verde-agua/teal cristalino (`#F2FBF9` ➔ `#E4F5F2` ➔ `#FFFFFF` con borde `#C5E8E3` ➔ `#D5EFEA`).
- **Tinta Abisal para Máxima Autoridad:** El antiguo color abisal `#012624` pasa a ser el color de texto primario para todos los titulares (`H1-H3`), logrando un contraste nítido (`>14:1` WCAG AAA) sobre el lienzo claro sin usar negro puro (`#000000`).
- **Acento Lavanda-Fósforo y Gradientes Bioluminiscentes:** Se reservan exclusivamente para el botón CTA principal, el indicador de onda acústica en vivo y las grandes cifras estadísticas de latencia y ahorro.

---

## 2. Tokens de Color - Auros Light Mode (`CSS Custom Properties` & `Tailwind v4`)

| Nombre del Token | Valor Hex / RGB | Variable CSS | Rol Exacto en Tema Claro |
| :--- | :--- | :--- | :--- |
| **Lagoon Mist Canvas** | `#F2FBF9` | `--color-liquid-abyss` (Light) | Lienzo primario de toda la página, Hero y secciones base. Blanco mineral con susurro cyan-teal. |
| **Lagoon Deep Well** | `#E4F5F2` | `--color-liquid-deep` (Light) | Superficie hundida (medio paso más intensa en teal claro). Usada en el pozo del Footer y paneles inmersivos. |
| **Crystal Kelp Surface** | `#FFFFFF` | `--color-liquid-kelp` (Light) | Superficie elevada para tarjetas de funcionalidades (`16px` radius, sin sombra, con borde `1px solid #C5E8E3`). |
| **Tidal Surface Lift** | `#DDF3EF` | `--color-liquid-mist` (Light) | Superficie secundaria de tarjetas interactivas, pastillas de estado y contenedores de métricas. |
| **Abyssal Ink (Primary Text)** | `#012624` | `--color-platinum` (Light) | Tinta principal para todos los titulares H1-H3, navegación activa, trazos de iconos y cifras clave. |
| **Kelp Slate (Body Text)** | `#23534F` | `--color-silver-mist` (Light) | Texto secundario de párrafos, descripciones técnicas y enlaces en reposo. Armoniza con el lienzo agua. |
| **Muted Mineral** | `#567A77` | `--color-ash` (Light) | Texto terciario, etiquetas `eyebrow` uppercase, leyendas de la calculadora y metadatos. |
| **Lagoon Hairline** | `#B8E0DA` | `--color-slate-deep` (Light) | Líneas conectoras del grafo DOM, bordes sutiles de inputs y divisores instrumentales. |
| **Phosphor Orchid Accent** | `#6B1D9E` sobre `#F9E8FF` | `--color-lavender-phosphor` | Color de énfasis para grandes contadores estadísticos (`<45ms`, `99.98%`) sobre superficie lavanda luminosa. |
| **Bioluminescent Gradient** | `linear-gradient(90deg, #00827C 0%, #00B8B0 50%, #7A28CB 100%)` | `--gradient-bioluminescent` | Gradiente activo para la onda de voz IA, el puntero DOM interactivo y estados activos. |
| **Aurora CTA Gradient** | `linear-gradient(90deg, #99FFF9 0%, #D8FFFD 30%, #FFF8EE 60%, #F5C6FF 100%)` | `--gradient-aurora` | Relleno exclusivo del botón CTA primario (`Gradient Pill Button`) con texto oscuro `#012624` y borde `#7CE8E2`. |

### Bloque CSS Listo para Producción (`landing-auros-light.css`)

```css
:root[data-portal="commercial-landing"] {
  /* Superficies en Tema Claro (Pila de Agua Cristalina - Cero Sombras) */
  --surface-liquid-abyss: #F2FBF9;
  --surface-liquid-deep: #E4F5F2;
  --surface-liquid-kelp: #FFFFFF;
  --surface-liquid-lift: #DDF3EF;
  --surface-slate-deep: #B8E0DA;

  /* Tipografía y Tintas */
  --color-text-primary: #012624;
  --color-text-secondary: #23534F;
  --color-text-muted: #567A77;
  --color-stat-ink: #581585;
  --color-stat-surface: #F9E8FF;

  /* Gradientes Firma */
  --gradient-bioluminescent: linear-gradient(90deg, rgb(0, 130, 124) 0%, rgb(0, 184, 176) 52%, rgb(122, 40, 203) 100%);
  --gradient-aurora: linear-gradient(90deg, rgb(153, 255, 249) 0%, rgb(216, 255, 253) 30%, rgb(255, 248, 238) 60%, rgb(245, 198, 255) 100%);

  /* Familias Tipográficas */
  --font-matter: 'Matter', 'Inter', 'DM Sans', ui-sans-serif, system-ui, sans-serif;
  --font-arial: 'Arial', system-ui, -apple-system, sans-serif;

  /* Escala Tipográfica y Tracking Mecánico */
  --text-caption: 10px;
  --leading-caption: 1.4;
  --tracking-caption: 0.15em;

  --text-eyebrow: 12px;
  --leading-eyebrow: 1.4;
  --tracking-eyebrow: 0.12em;

  --text-body: 16px;
  --leading-body: 1.4;
  --tracking-body: 0px;

  --text-subheading: 24px;
  --leading-subheading: 1.3;
  --tracking-subheading: -0.02em;

  --text-heading: 36px;
  --leading-heading: 1.0;
  --tracking-heading: -0.03em;

  --text-heading-lg: 61px;
  --leading-heading-lg: 1.0;
  --tracking-heading-lg: -0.04em;

  --text-display: 96px;
  --leading-display: 1.0;
  --tracking-display: -0.046em;

  /* Radios y Layout */
  --radius-cards: 16px;
  --radius-buttons: 6px;
  --radius-small: 6px;
  --page-max-width: 1440px;
  --section-gap: 68px;
}
```

---

## 3. Reglas Tipográficas y de Geometría Estricta

1. **Estrategia de Peso Único en Titulares (`Matter Weight 500`):**
   - Todos los encabezados (`H1`, `H2`, `H3`), números estadísticos (`86px`) y textos cinéticos de fondo (`96px-220px`) se renderizan **exclusivamente en peso `500` (Medium)** con `line-height: 1.0` y letter-spacing negativo (`-0.04em` a `-0.046em`).
   - Queda prohibido usar `font-weight: 600`, `700` o `300` en titulares.
2. **Etiquetas de Instrumentación (`Uppercase Tracked Kickers`):**
   - Toda sección se introduce con un kicker en mayúsculas (`10px` o `12px`, `Matter 500`, `letter-spacing: 0.12em-0.15em`, color `#23534F`), por ejemplo: `SISTEMA DE ENTRENAMIENTO VISUAL DOM · SHA-256` o `MOTOR DUAL REALTIME · QWEN 3.8 & GEMINI 3.8 LIVE`.
3. **Vocabulario Cerrado de Radios (`16px` y `6px`):**
   - Contenedores de sección, tarjetas de funcionalidades, el lienzo de la demo en vivo y el panel de la calculadora usan siempre `border-radius: 16px` y `box-shadow: none`.
   - Botones (`Gradient Pill Button`, botones de flecha diagonal `32x32px`), selectores e inputs usan siempre `border-radius: 6px`.

---

## 4. Directriz de Fondos, Formas Visuales y Presentación de la Información de la Plataforma

En esta plataforma no se usan fotografías de personas ni ilustraciones genéricas. Todas las formas gráficas del fondo y las tarjetas representan **la física real de nuestro sistema (Voz Bidireccional + Mapeo DOM en Capas + RAG Inmutable)**.

### Sección 1: Hero Principal (`<HeroArchitectureShowcase />`)

- **Fondo e Ilustración Interactiva Correspondiente al Sistema (`<BioluminescentVoiceDomSphere />`):**
  - En el centro del Hero (detrás de la pila tipográfica) se renderiza en Canvas 2D / WebGL una **Esfera Bioluminiscente de Partículas Acústicas y Nodos DOM** sobre el lienzo claro `#F2FBF9`.
  - Las partículas (`#00827C`, `#00B8B0` y destellos `#9B30FF`) orbitan formando una esfera que **pulsa en tiempo real con la onda de voz del asistente** y proyecta líneas vectoriales finas (`1px #B8E0DA`) hacia 4 etiquetas flotantes de coordenadas DOM (`[data-oa-id="btn-new-deal"] · (x: 0.64, y: 0.28)`).
- **Información Precisa a Presentar en el Hero:**
  - **Eyebrow (`12px uppercase, tracking 0.12em`):** `ONBOARDING AUTÓNOMO END-TO-END · VOZ + EJECUCIÓN FÍSICA EN EL DOM`
  - **Titular H1 (`clamp(2.75rem, 5vw, 5.5rem)`, `Matter 500`, `#012624`, `tracking -0.04em`):**
    `"Tu software habla con tu usuario y opera la interfaz por él en vivo."`
  - **Subtítulo Comercial (`16px Matter 400`, `#23534F`, máx `620px` de ancho):**
    Explica con claridad que el desarrollador entrena su aplicación sin capturas de pantalla ciegas mediante un puntero interactivo, indexa la memoria de su interfaz y despliega un asistente de voz en tiempo real capaz de conversar, aceptar interrupciones inmediatas y ejecutar acciones paso a paso en pantalla.
  - **Grupo de Acciones (CTAs):**
    - Botón Primario (`Gradient Pill Button`, relleno `--gradient-aurora`, radio `6px`, padding `18px 28px`, texto `#012624` `14px uppercase`): `"PROBAR ASISTENTE EN VIVO ↓"`.
    - Comando CLI Interactivo (`Surface #FFFFFF`, borde `1px solid #B8E0DA`, radio `6px`): `npx @onboarding-assistant/cli train` con botón cuadrado `32x32px` (`↗` / copiar).

### Sección 2: Demostración Interactiva en Vivo (`<LiveInteractiveVoiceDemo />`)

- **Presentación Estructural:**
  - Contenedor de ancho completo (`max-width: 1440px`) sobre superficie elevada `#FFFFFF` (`border-radius: 16px`, borde `1px solid #C5E8E3`, padding `48px`, cero sombras).
  - **Cabecera de Instrumentación del Demo:** Selector de perfil de voz en tiempo real (`Voz Ultra-Rápida` vs `Voz Ultra-Precisa`), indicador de latencia en vivo (`<50ms`) y barra de progreso del flujo guiado (`Paso 1: Abrir Nuevo Trato` ➔ `Paso 2: Escribir Empresa` ➔ `Paso 3: Confirmar y Guardar`).
  - **Lienzo Simulado con Forma Propia del Sistema (`<SimulatedCrmCanvas />`):**
    - Muestra una interfaz SaaS B2B limpia dentro de un Shadow DOM donde se ve en acción el **Puntero Interactivo en Capas (Overlay Bioluminiscente)**: cuando el asistente habla, un cursor vectorial con halo `--gradient-bioluminescent` se desplaza hasta el elemento objetivo, dibuja su recuadro de inspección (`role=button[name="Crear Trato"]`), ejecuta el click físico o escribe texto letra por letra y emite la confirmación de acción en pantalla.

### Sección 3: Arquitectura de Entrenamiento Visual y Memoria Inteligente (`Asymmetric 2-Column Explore Layout`)

- **Columna Izquierda (Tarjetas Apiladas `Surface Card #FFFFFF` y `#DDF3EF`, `16px` radius, `36px` padding):**
  1. **Card 01 - Captura con Puntero Overlay (Cero Screenshots Ciegos):** Explica el navegador de entrenamiento seguro donde al marcar cualquier nodo se despliega el modal (`Título`, `Descripción Funcional`, `¿Hacer acción? Sí/No` y `Click / Escritura / Ambos`) calculando coordenadas responsive para Desktop, Tablet y Mobile. Incluye botón de esquina `32x32px` (`6px` radius, `rgba(0, 130, 124, 0.12)` con flecha `↗` en `#012624`).
  2. **Card 02 - Memoria Inteligente Inmutable y Edición Dual:** Explica la edición posterior tanto visual como por código y el motor de contexto que reconoce la pantalla activa en milisegundos.
  3. **Card 03 - Estudio del Prompt Paso a Paso (UI & API):** Explica cómo una única instrucción en lenguaje natural gobierna la atención guiada de tus usuarios respetando el orden estricto de pasos.
- **Columna Derecha (`Geometric Molecule Illustration` adaptada al Sistema):**
  - Un diagrama geométrico plano construido en SVG sobre el lienzo `#F2FBF9` con círculos de precisión (`#012624` y `#00827C`) y líneas conectoras finas (`1px #23534F`) que representan visualmente la memoria interactiva de la aplicación junto con el texto cinético gigante de fondo en `Matter 500` (`140px`, tracking `-0.046em`, color `#E0F2EF`) que dice `"VOICE · UI"`.

### Sección 4: Bloque de Estadísticas Luminiscentes (`Statistic Counters`)

- Tres columnas sobre superficie `#E4F5F2` (`16px` radius, padding `48px`):
  - **Columna 1:** Número `<45ms` en `86px Matter 500` color `#581585` sobre pastilla `#F9E8FF` (`6px` radius). Etiqueta inferior en `13px uppercase tracking 0.08em #012624`: `INTERRUPCIÓN INSTANTÁNEA AL HABLAR (BARGE-IN)`.
  - **Columna 2:** Número `100%` en `86px Matter 500`. Etiqueta: `AISLAMIENTO Y PRIVACIDAD DE DATOS DE GRADO ENTERPRISE`.
  - **Columna 3:** Número `Dual AI` en `86px Matter 500`. Etiqueta: `MOTOR MULTIMODAL DE VOZ DE ULTRA BAJA LATENCIA`.

### Sección 5: Calculadora Interactiva de Planes y Descuentos por Volumen (`<InteractivePricingCalculator />`)

- Renderizada sobre un panel `Recessed Card` (`#E4F5F2`, `16px` radius, padding vertical `80px`, horizontal `48px`).
- Presenta los controles deslizantes para calcular minutos mensuales y muestra en paralelo las tarjetas de **Pago por Uso Flexible** y las **Suscripciones Fijas de `$5`, `$10`, `$30` y `$50 USD/mes`**, destacando visualmente con el borde bioluminiscente cómo a partir del **Plan de `$50 USD`** cualquier minuto adicional activa automáticamente el **Descuento por Volumen Escalonado**.

---

## 5. Prohibiciones Estrictas en la Landing Comercial (Don'ts)

- **Prohibido usar modo oscuro en la Landing Comercial:** El lienzo debe ser siempre `#F2FBF9` (`Lagoon Mist Canvas`) y las superficies `#E4F5F2`, `#FFFFFF` y `#DDF3EF`.
- **Prohibido usar `box-shadow` o `drop-shadow`:** Ninguna tarjeta ni botón lleva sombra; la separación entre planos se logra únicamente con el cambio de tono en la escala verde-agua clara y bordes técnicos de `1px solid #C5E8E3`.
- **Prohibido usar radios mayores a `16px` en tarjetas o `6px` en botones:** No uses `rounded-full` (`9999px`) en botones ni tarjetas.
- **Prohibido mostrar decoraciones genéricas desconectadas del producto:** Todo gráfico vectorial o animación en Canvas debe representar ondas de voz, coordenadas de selectores o nodos del mapa de la app.
- **Prohibido exponer infraestructura interna o modelos LLM (Zero Third-Party Leakage):** Está terminantemente prohibido que la interfaz comercial mencione nombres de modelos de IA (`Qwen`, `Gemini`, `OpenAI`, `ChatGPT`, `Claude`), bases de datos (`PostgreSQL`), contenedores (`Docker`, `Playwright`, `Chromium`) o pasarelas (`Whop`). El usuario final y comprador solo deben ver la marca del producto y su valor.

---

## 6. Reglas de Oro de Copywriting Comercial y Voz de Marca (Cero Tecnicismos)

Todo texto, botón, titular, badge y modal de cara al cliente debe hablar en **lenguaje comercial de valor, resultados y confianza**, jamás de cómo está construido el backend ni de qué LLM corre por debajo.

| ❌ Prohibido en el Front (Tecnicismo / Nombre de Proveedor) | ✅ Copy Obligatorio Comercial (Orientado a Marca y Valor) |
| :--- | :--- |
| "Qwen3.8-Omni-Flash-Realtime" / "Gemini 3.8 Live" | **"Voz Ultra-Rápida"** / **"Voz Ultra-Precisa"** / **"Motor de Voz en Vivo"** |
| "Powered by Gemini / Qwen / OpenAI" | **"Impulsado por el Motor de Inteligencia Conversacional de [Tu Marca]"** |
| "Paga con Whop" / "Redirección a Whop Checkout" | **"Pago seguro con tarjeta"** / **"Activar suscripción"** / **"Comenzar ahora"** |
| "Procesado por Whop" / "Whop Membership" | **"Facturación segura y cancelable en cualquier momento"** |
| "Navegador Chromium remoto en Docker" / "Playwright" | **"Entrenador visual inteligente"** / **"Navegador de entrenamiento en vivo"** |
| "Playwright con Anti-SSRF" | **"Entorno de entrenamiento aislado y de alta seguridad"** |
| "WebSocket PCM16 conectado a LLM" | **"Voz en tiempo real de ultra baja latencia"** |
| "Despacho de herramientas click_element y type_text" | **"Navegación y acciones guiadas en pantalla"** |
| "Memoria RAG y embeddings vector(1536)" | **"Memoria inteligente que comprende la interfaz de tu producto"** |
| "Overage y cobro por ledger en PostgreSQL" | **"Tarifa flexible por minuto con descuento automático por volumen"** |
| "Tokens de API hasheados en SHA-256" | **"Claves de acceso de grado bancario"** |
reSQL" | **"Tarifa flexible por minuto con descuento automático por volumen"** |
| "Tokens de API hasheados en SHA-256" | **"Claves de acceso de grado bancario"** |

