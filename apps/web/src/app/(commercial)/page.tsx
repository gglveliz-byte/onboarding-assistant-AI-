/**
 * @archivo apps/web/src/app/(commercial)/page.tsx
 * @modulo apps/web/src/app (página raíz `/` de la Landing Pública Comercial)
 * @proposito
 *   Ensambla la página `/` del grupo `(commercial)`: componente servidor puro (sin
 *   `'use client'`) que compone, en estricto orden narrativo de conversión, las cinco
 *   secciones ya construidas por los Subagentes 1.5–1.8 — hero de arquitectura,
 *   demostración de voz en vivo, exploración del producto (grafo molecular RAG +
 *   banner de métricas de producción) y calculadora interactiva de precios — de forma
 *   transparente sobre el lienzo Auros Light que sirve el fondo vivo de constelación
 *   montado en el layout del grupo. Esta página es el punto de montaje
 *   final del carril División 1: aquí no vive lógica de negocio, estado ni estilos
 *   propios; toda la interactividad permanece encapsulada en las secciones cliente.
 *
 * @resumen_contenido
 *   - `metadata`: título y descripción comerciales de la landing para buscadores y
 *     tarjetas sociales (una sola frase de valor, cero fuga de infraestructura).
 *   - `CommercialLandingPage()`: página por defecto de `/` que devuelve el contenedor
 *     `flex flex-col` (sin fondo propio: el lienzo lo gobierna el fondo de constelación
 *     del layout) con las cinco secciones en secuencia; cada
 *     sección aporta su propio ritmo vertical y horizontal.
 *
 * @orden_de_composicion
 *   1. `HeroArchitectureShowcase` → sección `#plataforma` (`px-6 py-20`): titular H1,
 *      CTA aurora hacia `#demo-en-vivo`, comando de entrenamiento copiable, selector
 *      de escenarios y tarjeta "Nexo CRM" resuelta por la Esfera Acústica.
 *   2. `LiveInteractiveVoiceDemo` → sección `#demo-en-vivo` (`SECTION_STYLE` propio):
 *      demostración pública de voz gobernable (150 segundos por omisión) que opera físicamente un CRM
 *      simulado en Shadow DOM con puntero bioluminiscente y acuse de latencia.
 *   3. `RagDomMolecularGraphSection`: encabezado editorial del entrenamiento visual,
 *      tres tarjetas frente al grafo molecular RAG en SVG (escritorio) y explorador
 *      compacto interactivo con panel de detalle en móvil y tablet.
 *   4. `BioluminescentStatsBanner`: panel blanco con las tres métricas de producción
 *      (barge-in, aislamiento por organización y motor dual de voz).
 *   5. `InteractivePricingCalculator` → sección `#precios` (`SECTION_STYLE` propio):
 *      controles de usuarios y minutos, proyección mensual, tramos de descuento por
 *      volumen y comparativa de planes con enlace de alta.
 *
 *   El orden respeta los tres anclajes del header público (`#plataforma`,
 *   `#demo-en-vivo` y `#precios`), garantizando que la navegación del chrome de marca
 *   desplace a la sección correcta sin reordenamientos intermedios.
 *
 * @dependencias_internas
 *   - `../../components/landing/hero/HeroArchitectureShowcase` (sección `#plataforma`).
 *   - `../../components/landing/live-demo/LiveInteractiveVoiceDemo` (sección `#demo-en-vivo`).
 *   - `../../components/landing/explore/RagDomMolecularGraphSection` (exploración visual/RAG).
 *   - `../../components/landing/explore/BioluminescentStatsBanner` (métricas de producción).
 *   - `../../components/landing/pricing/InteractivePricingCalculator` (sección `#precios`).
 *
 * @dependencias_externas
 *   - `next` (solo el tipo `Metadata` para la exportación SEO de la página).
 *   - `react` (solo el tipo `ReactElement`; cero hooks y cero estado en este archivo).
 *
 * @reglas_de_ensamblaje
 *   - Cero paddings o contenedores extra: cada sección ya trae su propio ritmo
 *     vertical y horizontal; duplicarlos rompería la cadencia del lienzo Auros.
 *   - Cero sombras y cero dependencias nuevas; el ensamblaje solo reordena imports.
 *   - Componente servidor: la interactividad (voz, cursor, precios) vive en las
 *     secciones cliente, que hidratan de forma aislada.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (ensamblaje estático de presentación: no accede a datos directamente).
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { BioluminescentStatsBanner } from '../../components/landing/explore/BioluminescentStatsBanner';
import { RagDomMolecularGraphSection } from '../../components/landing/explore/RagDomMolecularGraphSection';
import { HeroArchitectureShowcase } from '../../components/landing/hero/HeroArchitectureShowcase';
import { LiveInteractiveVoiceDemo } from '../../components/landing/live-demo/LiveInteractiveVoiceDemo';
import { InteractivePricingCalculator } from '../../components/landing/pricing/InteractivePricingCalculator';

/**
 * Metadatos de la landing comercial `/`: título y descripción de valor para buscadores
 * y tarjetas sociales. La descripción es una sola frase 100% comercial, sin nombres de
 * modelos, proveedores ni piezas de infraestructura (regla de cero fuga de backend).
 */
export const metadata: Metadata = {
  title: 'Asistente de voz que guía y opera tu producto',
  description:
    'El asistente de voz que entiende cada pantalla de tu producto, guía a tus usuarios paso a paso y ejecuta las acciones por ellos con una demostración en vivo y precios por minuto.',
};

/**
 * Página raíz `/` de la Landing Pública Comercial: compone las cinco secciones fijas
 * del carril División 1 en su orden narrativo de conversión (plataforma → demo en
 * vivo → exploración → métricas → precios) dentro del lienzo `bg-liquid-abyss`.
 *
 * @returns Contenedor vertical con las cinco secciones de la landing en secuencia.
 */
export default function CommercialLandingPage(): ReactElement {
  return (
    <div className="flex flex-col">
      <HeroArchitectureShowcase />
      <LiveInteractiveVoiceDemo />
      <RagDomMolecularGraphSection />
      <BioluminescentStatsBanner />
      <InteractivePricingCalculator />
    </div>
  );
}
