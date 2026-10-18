/**
 * @archivo apps/web/src/app/(auth)/layout.tsx
 * @modulo apps/web (Rutas de Autenticación — Grupo `(auth)`)
 * @proposito
 *   Layout de grupo del App Router que da marco a todas las vistas de acceso y alta de
 *   cuenta (`/auth/*`: registro, login, recuperación): carga la hoja de tokens "Cursor
 *   Light — Warm Parchment Atelier", monta el `AuthSessionProvider` (token de acceso SOLO
 *   en memoria RAM) y aplica el lienzo pergamino del portal de autenticación. Es un
 *   componente servidor de presentación puro: el único estado de sesión vive en el
 *   provider cliente, de modo que cada página interactiva declara su propio `'use client'`.
 *
 * @resumen_contenido
 *   - `AuthGroupLayout`: componente por omisión que importa la hoja
 *     `../../styles/dashboard-docs-cursor-atelier.css`, envuelve `children` en
 *     `<AuthSessionProvider>` y en el contenedor `<div data-portal="workspace-atelier"
 *     className="atelier-shell">` exigido por los tokens de color.
 *
 * @dependencias_internas
 *   - `AuthSessionProvider` (`../../components/auth-legal/useAuthSessionContext`).
 *   - `apps/web/src/styles/dashboard-docs-cursor-atelier.css` (tokens y clases `.atelier-*`).
 *
 * @dependencias_externas
 *   - `react` (tipos `ReactElement` y `ReactNode`). Sin `next/*` y sin directivas de cliente
 *     innecesarias.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascaron de presentación: no accede a datos).
 *
 * @notas
 *   - El layout raíz (`app/layout.tsx`) ya aporta `html`/`body`; este layout solo añade el
 *     marco visual y el contexto de sesión compartido por login, registro y recuperación.
 *   - La navegación entre estas vistas se hace con `<a href>` (cero imports de navegación).
 */

import type { ReactElement, ReactNode } from 'react';
import { AuthSessionProvider } from '../../components/auth-legal/useAuthSessionContext';
import '../../styles/dashboard-docs-cursor-atelier.css';

/** Props del layout de grupo de autenticación. */
interface AuthGroupLayoutProps {
  readonly children: ReactNode;
}

/**
 * Layout compartido por las vistas de autenticación: cargado sobre el lienzo pergamino,
 * con el contexto de sesión en memoria disponible para todos sus descendientes.
 *
 * @param props - Contenido de la página activa del grupo `(auth)`.
 * @returns Marco de atelier con el provider de sesión envolviendo a los hijos.
 */
export default function AuthGroupLayout(props: AuthGroupLayoutProps): ReactElement {
  return (
    <AuthSessionProvider>
      <div
        data-portal="workspace-atelier"
        className="atelier-shell"
        style={{
          minHeight: '100dvh',
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
          color: 'var(--color-ink, #26251e)',
        }}
      >
        {props.children}
      </div>
    </AuthSessionProvider>
  );
}

