/**
 * @archivo apps/web/src/app/(commercial)/layout.tsx
 * @modulo apps/web/src/app (layout raíz del grupo comercial de la landing)
 * @proposito
 *   Envuelve todas las rutas públicas comerciales del grupo `(commercial)` con el chrome de
 *   marca (encabezado y pie de la Landing Comercial), activa el ámbito cromático Auros Light
 *   del portal mediante el atributo `data-portal="commercial-landing"` y monta el fondo vivo
 *   de constelación Dala (`DalaConstellationBackdrop`) tras el contenido: las páginas hijas
 *   (la landing `/` y sus secciones) montan el contenido interactivo, ya transparentes para
 *   que el canvas fijo gobierne el lienzo.
 *
 * @resumen_contenido
 *   - `CommercialGroupLayout`: contexto de apilamiento aislado (`relative isolate`) a pantalla
 *     completa sobre `bg-liquid-abyss` (lienzo claro Auros, color de respaldo del canvas), con
 *     el fondo de constelación `fixed z-0`, encabezado sticky `z-40`, contenido central
 *     `relative z-10 flex-1` y pie `relative z-10`.
 *
 * @dependencias_internas
 *   - `../../components/landing/PublicCommercialChrome` (`PublicCommercialHeader`,
 *     `PublicCommercialFooter`).
 *   - `../../components/landing/particles/DalaConstellationBackdrop` (fondo vivo de constelación).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `ReactElement` y `ReactNode`). Prohibido importar `next/*`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascarón de presentación: no accede a datos).
 */

import type { ReactElement, ReactNode } from 'react';
import {
  PublicCommercialFooter,
  PublicCommercialHeader,
} from '../../components/landing/PublicCommercialChrome';
import { DalaConstellationBackdrop } from '../../components/landing/particles/DalaConstellationBackdrop';

/**
 * Envoltura del grupo comercial: habilita el ámbito Auros Light, monta el fondo vivo de
 * constelación tras el contenido y compone el chrome de marca alrededor de la landing.
 * El atributo `data-portal` delimita el CSS del portal y `isolate` encierra el apilado
 * (canvas `z-0` bajo contenido `z-10`) sin fugas hacia el resto de la aplicación.
 *
 * @param props - Propiedades del layout con las páginas comerciales hijas.
 * @returns Contenedor a pantalla completa con fondo de constelación, encabezado, contenido y pie.
 */
export default function CommercialGroupLayout(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div data-portal="commercial-landing" className="relative isolate flex min-h-screen flex-col bg-liquid-abyss">
      <DalaConstellationBackdrop />
      <PublicCommercialHeader />
      <main className="relative z-10 flex-1">{props.children}</main>
      <PublicCommercialFooter />
    </div>
  );
}
