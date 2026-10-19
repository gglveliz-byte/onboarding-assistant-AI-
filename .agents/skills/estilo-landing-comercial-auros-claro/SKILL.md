---
name: estilo-landing-comercial-auros-claro
description: >-
  Sistema de diseño visual, tokens CSS/Tailwind v4, arquitectura de presentación e interacciones para la Landing Pública Comercial (/) en Tema Claro (Light Premium · Living Particle Intelligence · Advanced Motion Design). Lienzo vivo Auros (#F2FAF8 / canvas #F2FBF9) con Fondo de Constelación Dala anclado al scroll real (Cerebro 🧠 → Red de nodos 🕸️ → Planeta Tierra 🌐), esfera acústica bioluminiscente, demo de voz en vivo, explorador RAG molecular y calculadora de precios. Úsala siempre que construyas o edites la landing comercial.
---

# MASTER DESIGN SYSTEM — ONBOARDING ASSISTANT AI
## LIGHT PREMIUM · LIVING PARTICLE INTELLIGENCE · ADVANCED MOTION DESIGN

### 1. Rol y Objetivo
Este documento rige la identidad visual, tokens, comportamiento responsivo y sistema de animación para la **Landing Pública Comercial (`/`)** de Onboarding Assistant AI, implementada en `apps/web/src/app/(commercial)/` con componentes en `apps/web/src/components/landing/*` y estilos en `apps/web/src/styles/landing-auros-light.css`.

**Regla prioritaria:** Conserva el contenido, las funcionalidades, las rutas, los enlaces, las llamadas a API, los componentes funcionales y la lógica de negocio existentes. La intervención es visual y experiencial. No sustituyas contenido real por textos de demostración, no inventes funcionalidades y no elimines elementos funcionales.

Onboarding Assistant AI se presenta como un sistema de inteligencia artificial que comprende interfaces, interactúa con aplicaciones, ejecuta acciones y guía a los usuarios mediante voz y ejecución visual.

#### Inventario real de la página (anclas congeladas: `#plataforma`, `#demo-en-vivo`, `#precios`)

| Bloque | Componentes reales | Notas |
| :--- | :--- | :--- |
| Chrome público | `PublicCommercialChrome.tsx` | Header sticky `z-40` + footer; CTA real `/auth/register`. |
| Hero fonónico | `hero/HeroArchitectureShowcase.tsx`, `hero/BioluminescentVoiceDomSphere.tsx`, `hero/AmbientVoiceVisualizer.tsx`, `hero/useAcousticSpherePhysics.ts` | Esfera acústica Canvas 2D con física de RMS; **sin gradiente opaco** (deja ver el fondo vivo). |
| Entrenamiento Visual & Memoria RAG (`#plataforma`) | `explore/RagDomMolecularGraphSection.tsx` (+ `VisualTrainingMolecularGraph.tsx`, `CompactVisualTrainingExplorer.tsx`) | Escritorio 5/7 con grafo y núcleo SHA-256; explorador compacto interactivo en `< lg`; velo radial translúcido. |
| Banner de métricas | `explore/BioluminescentStatsBanner.tsx` | Cifras comerciales reales `<45ms`, `100%`, `2 Motores`; sin fondo propio. |
| Demo en vivo (`#demo-en-vivo`) | `live-demo/LiveInteractiveVoiceDemo.tsx` (+ `Vortex*`, `SimulatedCrmShadowCanvas.tsx`, `usePublicVoiceDemoSession.ts`) | CRM en Shadow DOM, overlay de cursor bioluminiscente y barra de voz. |
| Precios (`#precios`) | `pricing/InteractivePricingCalculator.tsx` (+ `WhopPlanComparisonCards.tsx`, `VolumeDiscountTierVisualizer.tsx`, `useWhopPricingCalculator.ts`) | CTA `/auth/register?plan=<code>&estimated_minutes=<n>`. |
| Fondo vivo | `particles/*` (8 módulos del Fondo Dala, optimizados para 60 fps) | Montado en `(commercial)/layout.tsx`; ver §5. |

---

### 2. Dirección Artística: Living Particle Intelligence

#### 2.1. Fondo Vivo de Constelación Dala (motor vigente)
Las partículas representan unidades de información, relaciones, percepción, razonamiento y acción. Una misma gramática visual construye, conforme al scroll real de la página, tres esculturas reconocibles de inteligencia (sin botones HUD ni runway artificial):
1. **Cerebro anatómico** (inicio): hemisferios, cisura de Silvio, surco de Rolando, lóbulo temporal, cerebelo con folia y tronco encefálico.
2. **Red de nodos y conectores** (tramo medio): cinco anillos de concentradores unidos por cadenas radiales, cuerdas y diagonales largas (el «mapa» enlazando información).
3. **Planeta Tierra cartográfico** (final): costas, masa continental, retícula oceánica y anillo orbital.

- Progreso dirigido por `scrollY / (scrollHeight − innerHeight)` con la curva `fluidMorphStep` (respuesta perceptible desde el primer píxel de scroll, llegada sedosa) y ventanas solapadas [0.00–0.52] y [0.44–0.96]; suavizado exponencial por tiempo (~85 ms) y deriva elástica por velocidad de scroll.
- **Anclaje del hero:** al inicio (scroll 0) el Cerebro deriva a la **zona derecha del viewport** (~0,82 W × 0,48 H, escala 0,7) para no tapar el titular editorial; en móvil se recentra (~0,62 W, escala 0,84). La deriva se disuelve junto con el peso del Cerebro durante el morphing.
- Densidad: ~3.000 microtriángulos wireframe + 96 glifos ambientales (escritorio); 1.500 + 56 en móvil (calibradas para 60 fps; parámetros en §5.2).
- **Elementos geométricos:** microtriángulos huecos de 1–1.45 px, glifos wireframe y segmentos finos; proyección en perspectiva (FOV 780), orden por profundidad con conteo por rodajas (sin `sort`) y trazo agrupado en lotes cromáticos cuantizados (centenas de `stroke()` por fotograma).
- Paleta del canvas de alto contraste sobre lienzo claro: ámbar, violeta `#8052FF`, turquesa, magenta e índigo.

> **Nota histórica:** existió un motor anterior (`LivingParticleIntelligenceCanvas.tsx` con formas esfera/herramienta/interfaz); fue **retirado del repositorio el 2026-10-18** por ser código muerto. El motor vigente y único es el Fondo Dala descrito arriba.

#### 2.2. Expresiones vivas auxiliares
- **Esfera acústica bioluminiscente** del hero (Canvas 2D): reacciona a la energía RMS de la voz con anillo de transmisión (`useAcousticSpherePhysics`).
- **Grafo molecular RAG**: SVG con doble polígono envolvente, radios radar, 14 nodos, núcleo SHA-256 con `radialGradient` + `feGaussianBlur` y anillo pulsante (`oa-graph-pulse`).

---

### 3. Sistema de Color — Light Mode Oficial

El tema claro es obligatorio.

#### Superficies
- **Fondo principal:** `#F2FAF8`
- **Lienzo del fondo vivo (canvas):** `#F2FBF9` (el layout conserva `bg-liquid-abyss` solo como respaldo pre-hidratación)
- **Fondo blanco:** `#FFFFFF`
- **Superficie secundaria:** `#EAF7F4`
- **Superficie de interacción:** `#DDF3EE`
- **Bordes sutiles:** `#C5E8E1`
- **Separadores:** `#D7EBE6`

#### Tipografía

- **Texto principal:** `#062D2A`
- **Texto secundario:** `#245954`
- **Texto terciario:** `#547B76`
- **Texto de bajo énfasis:** `#769792`

#### Acentos Cromáticos
- **Violeta:** `#8052FF`
- **Turquesa:** `#43E7DB`
- **Verde azulado:** `#15846E`
- **Azul eléctrico:** `#72B7FF`
- **Magenta:** `#E7A4F4`
- **Amarillo cálido:** `#FFD36E`
- **Gradiente Primario CTA:** `linear-gradient(135deg, #43E7DB 0%, #8052FF 100%)` con texto blanco/oscuro y bordes sutiles.

#### Contrato del lienzo vivo
- Las secciones **transparentan** su fondo para dejar ver la constelación (hero sin gradiente opaco, explorador con velo radial translúcido `rgba(…, 0.72 → 0)`, banner sin fondo propio); **las tarjetas y superficies blancas permanecen opacas** para legibilidad.
- **Cero sombras:** candado global `[data-portal="commercial-landing"] * { box-shadow: none !important }`; prohibido reintroducir elevaciones.
- Prohibido `z-index` negativo en el canvas y prohibido reponer fondos opacos de página completa en las secciones.

---

### 4. Tipografía y Sistema Editorial

Tipografía geométrica de alta precisión (Inter / PP Neue Montreal / sans-serif contemporáneo):
- **Microetiquetas:** 11–12 px (uppercase, tracking 0.12em).
- **Navegación:** 13–15 px (peso regular/medium, tracking -0.01em).
- **Texto secundario:** 14–16 px (leading 1.5).
- **Texto de lectura:** 16–18 px.
- **Subtítulos:** 20–28 px.
- **Encabezados de sección:** 36–56 px (peso regular o medium, tracking -0.03em).
- **Encabezado principal (H1):** `clamp(2.4rem, 5.5vw, 4.5rem)`.
- **Remates editoriales:** `font-display italic` para cierres de frase (p. ej. «sellada con SHA-256.»).

#### Motion Tipográfico
- Aparición progresiva escalonada con las utilidades reales del sistema: `.oa-reveal-up`, `.oa-mask-reveal` y `.oa-motion-stagger` (delays de 60–480 ms).
- Pulsos y tramas: `.oa-chip-pulse`, `.oa-graph-pulse` (+ `--svg`), `.oa-dot-grid`, `.oa-quick-fade`, `.oa-live-dot`.
- Todos los efectos respetan `prefers-reduced-motion` (se anulan o se congelan).
- Preservación íntegra del texto en el DOM para accesibilidad y SEO.

---

### 5. Arquitectura Técnica de la Visualización Generativa

#### 5.1. Fondo Vivo de Constelación Dala (8 módulos, carpeta `particles/`)
| Módulo | Rol |
| :--- | :--- |
| `DalaConstellationBackdrop.tsx` | Canvas `fixed inset-0 z-0`: ciclo de vida, DPR acotado por presupuesto de píxeles, gobernador de cadencia adaptativo (fotogramas alternos si el coste > ~11 ms), suavizado exponencial por tiempo del scroll (independiente del refresco), velocidad elástica, pausa con pestaña oculta y `prefers-reduced-motion`; delega la pintura en el compositor. |
| `dala-constellation-render.ts` | Compositor por fotograma: curva fluida de pesos, rotaciones con senos/cosenos por escultura y rotación propia incremental (cero trigonometría por nodo), pulsos por suma de ángulos, deriva elástica por velocidad, deriva lateral del Cerebro, orden por profundidad con conteo por rodajas y trazo por lotes cromáticos; `ConstellationScene` + `renderConstellationFrame()`. |
| `dala-constellation-render-state.ts` | Estado persistente del compositor: búfer de triángulos, tabla cromática por nodo, rejillas de conteo por profundidad, lotes con reciclado y constantes `DEPTH_SLICES`/`ALPHA_STEPS`; `createConstellationRenderState()`. |
| `dala-constellation-sculptures.ts` | Escultores analíticos de las 3 etapas (cerebro, red de nodos y Tierra) y `buildConstellation()`: tres posiciones precalculadas por nodo (la red delega en su mapa). |
| `dala-constellation-network-map.ts` | Mapa estático de la Red de nodos (etapa 2): 5 anillos de 41 concentradores, 65 conectores en cadenas proporcionales a su longitud (paso 10) y polvo de datos envolvente; `resolveNetworkSample()` en O(1). |
| `dala-constellation-geometry.ts` | Matemática (hash/ruido determinista, `smootherstep`, `fluidMorphStep`, `lerp`), tipos, paleta y constantes del lienzo (FOV, densidades 3.000/1.500, presupuesto de píxeles 2,6 M, rangos de scroll [0.00–0.52]/[0.44–0.96] y transformación de pantalla por etapa) — **punto único de calibración**. |
| `dala-constellation-ambient.ts` | Glifos ambientales de polvo estelar: deriva vertical envolvente, oscilación horizontal y rotación propia (`drawAmbientGlyphs()`). |
| `dala-constellation-earth-map.ts` | Malla cartográfica 96×48 con regiones continentales (costas con trazo nítido vs. masa continental). |

#### 5.2. Comportamiento del motor
- Canvas 2D con `alpha: false`; `devicePixelRatio` acotado por presupuesto de píxeles (`MAX_CANVAS_PIXELS` ≈ 2,6 M; techo 1,5 / suelo 0,75); `requestAnimationFrame` con delta time y estado 100 % reutilizado (cero asignaciones en el bucle caliente).
- **Gobernador de cadencia:** si el coste de pintura supera ~11 ms sostenidos, se pinta en fotogramas alternos (30 fps estables) y se libera al bajar de ~7 ms.
- Progreso del morphing = `scrollY / (scrollHeight − innerHeight)`; suavizado exponencial por tiempo con constante ~85 ms (idéntico en 60 y 120 Hz) y derivada de velocidad suavizada ~160 ms para la deriva elástica; rango re-medido con `ResizeObserver`.
- Pausa automática con pestaña oculta (`document.hidden`).
- `prefers-reduced-motion`: fotograma estático que solo se redibuja al hacer scroll o resize.
- Cursor: repulsión elástica sin romper la silueta principal; no aplica a punteros táctiles.

#### 5.3. Montaje, capas y transparencias
- `(commercial)/layout.tsx`: contexto aislado (`relative isolate`) con el canvas en `fixed inset-0 z-0` (`aria-hidden`, `pointer-events-none`), `main` y footer en `z-10` y header sticky en `z-40`.
- El fondo es **ambiente, no contenido**: nunca debe tapar texto ni capturar punteros.

---

### 6. Ergonomía Responsiva y Accesibilidad

- **Escritorio:** Composición asimétrica editorial (contenido a la izquierda, arte generativo a la derecha).
- **Móviles (< 768px):** Composición en una sola columna fluida, botones utilizables con el pulgar (área táctil >= 40px), menor densidad de partículas (1.500 nodos / 56 glifos, con el Cerebro recentrado y escala 0,84), cero desbordamiento horizontal (`overflow-x: hidden`).
- **Accesibilidad:** WCAG AAA en contrastes (`#062D2A` sobre `#F2FAF8`), nombres accesibles, foco visible (`:focus-visible` con anillo del sistema); el canvas decorativo siempre es `aria-hidden` con `pointer-events: none` y la información existe íntegra en el DOM.
