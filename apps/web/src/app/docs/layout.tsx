/**
 * @archivo apps/web/src/app/docs/layout.tsx
 * @modulo 08. Landing de Documentación & Sandbox — Layout del Grupo `/docs`
 * @proposito
 *   Cascarón del grupo de rutas `/docs`: carga la hoja de tokens "Cursor Light — Warm
 *   Parchment Atelier" y envuelve cada subruta (guía de instalación y sandbox interactivo)
 *   en el portal visual `workspace-atelier` sobre lienzo pergamino.
 * @resumen_contenido
 *   - `DeveloperDocsLayout`: layout de presentación que delega la estructura completa
 *     (barra de 52px, árbol lateral, buscador `Cmd+K` y selector de framework) al shell
 *     montado por cada página.
 * @dependencias_internas
 *   - `../../styles/dashboard-docs-cursor-atelier.css` (tokens y clases `.atelier-*`).
 * @dependencias_externas
 *   - `react` (tipo `ReactNode`).
 * @notas
 *   - Sin acceso a datos ni lógica de negocio: garantiza que toda subruta de `/docs`
 *     herede los tokens aunque no llegue a montar el shell completo.
 */

import type { ReactElement, ReactNode } from 'react';
import '../../styles/dashboard-docs-cursor-atelier.css';

/**
 * Envuelve el árbol de rutas de `/docs` en el ámbito visual del portal Atelier.
 * @param props - Propiedades del layout con el contenido de la ruta activa.
 * @returns Contenedor `data-portal="workspace-atelier"` con lienzo de página completa.
 */
export default function DeveloperDocsLayout(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div data-portal="workspace-atelier" className="atelier-shell" style={{ minHeight: '100vh' }}>
      {props.children}
    </div>
  );
}
