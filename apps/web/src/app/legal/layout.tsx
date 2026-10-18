/**
 * @archivo apps/web/src/app/legal/layout.tsx
 * @modulo apps/web (Layout Público del Grupo Legal)
 * @proposito
 *   Layout raíz del grupo de rutas públicas `/legal/*`: importa la hoja de tokens y clases
 *   «Cursor Light — Warm Parchment Atelier» y activa el ámbito cromático mediante el atributo
 *   `data-portal="workspace-atelier"`. Es una superficie 100% pública: no monta ningún
 *   proveedor de sesión ni captura credenciales.
 *
 * @resumen_contenido
 *   - `LegalGroupLayout`: envuelve `{children}` en `.atelier-shell` con ámbito de portal.
 *
 * @dependencias_internas
 *   - `../../styles/dashboard-docs-cursor-atelier.css` (tokens y clases `.atelier-*`).
 *
 * @dependencias_externas
 *   - Solo `react` (tipos `ReactElement` y `ReactNode`). Prohibido importar `next/*`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascarón de presentación: no accede a datos).
 */

import type { ReactElement, ReactNode } from 'react';
import '../../styles/dashboard-docs-cursor-atelier.css';

/**
 * Envoltura del grupo legal: habilita el tema Atelier sobre pergamino cálido.
 *
 * @param props - Propiedades del layout con las páginas hijas.
 * @returns Contenedor `.atelier-shell` con el ámbito `workspace-atelier`.
 */
export default function LegalGroupLayout(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div data-portal="workspace-atelier" className="atelier-shell" style={{ minHeight: '100dvh' }}>
      {props.children}
    </div>
  );
}
