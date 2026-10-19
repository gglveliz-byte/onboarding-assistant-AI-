/**
 * @archivo apps/web/src/components/dashboard-dev/DashboardEntryRedirect.tsx
 * @modulo 08-frontend-dashboard-dev (Resolución de Destino Real del Dashboard)
 * @proposito
 *   Resuelve, en el cliente, la ruta de entrada real del dashboard del desarrollador: la
 *   organización vigente (de la URL o de la sesión) y su primer proyecto existente. Sustituye a
 *   los redireccionamientos con identificadores ficticios (`default-org`, `proj_default_live`,
 *   `general`), que dejaban al usuario en un 404 tras iniciar sesión en cualquier tenant que no
 *   se llamase «general».
 *
 * @resumen_contenido
 *   - `DashboardEntryRedirect`: resuelve sesión → organización → primer proyecto y navega allí.
 *   - Estados de presentación: resolución en curso, sin sesión y sin proyectos.
 *
 * @dependencias_internas
 *   - `backendFetch`, `getAccessToken`, `getSessionOrgSlug` (apps/web/src/lib/api-client/http-client.ts).
 *
 * @dependencias_externas
 *   - `react` (`useEffect`, `useState`).
 *   - `next/navigation` (`useRouter`).
 *
 * @notas
 *   - El primer render (servidor y cliente) es idéntico para no romper la hidratación: la
 *     navegación ocurre después, en un efecto.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST): `projects` (lectura del tenant de la sesión).
 */

'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { backendFetch, getAccessToken, getSessionOrgSlug } from '../../lib/api-client/http-client';

type EntryState = 'resolving' | 'noSession' | 'noProjects';

/** Determina si un valor desconocido es un registro JSON indexable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Panel de estado del resolutor con la estética Warm Parchment Atelier. */
function EntryPanel({ title, detail }: { readonly title: string; readonly detail: string }): ReactElement {
  return (
    <div className="min-h-screen bg-[#f7f7f4] text-[#26251e] font-sans flex items-center justify-center p-6">
      <div
        className="w-full max-w-md p-5 bg-[#f2f1ed] border border-[#cdcdc9] rounded space-y-2"
        style={{ borderRadius: '4px' }}
      >
        <p className="text-sm font-sans text-[#26251e]">{title}</p>
        <p className="text-xs font-sans text-[#84847e] leading-relaxed">{detail}</p>
      </div>
    </div>
  );
}

/**
 * Redirige a la consola real del tenant: organización vigente y primer proyecto existente.
 *
 * @param props.orgSlug - Slug de la organización de la ruta, si la ruta lo aporta.
 * @returns Panel de estado mientras se resuelve el destino.
 */
export function DashboardEntryRedirect({ orgSlug }: { readonly orgSlug?: string }): ReactElement {
  const router = useRouter();
  const [state, setState] = useState<EntryState>('resolving');

  useEffect((): (() => void) => {
    let cancelled = false;

    const resolve = async (): Promise<void> => {
      const token = getAccessToken();
      if (token === null || token.length === 0) {
        if (!cancelled) {
          setState('noSession');
        }
        return;
      }
      const effectiveSlug = (orgSlug ?? getSessionOrgSlug() ?? '').trim();
      if (effectiveSlug.length === 0) {
        if (!cancelled) {
          setState('noSession');
        }
        return;
      }
      try {
        const payload = await backendFetch<unknown>('/api/v1/projects');
        const rawList = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload['projects'])
            ? payload['projects']
            : [];
        const firstProject = rawList.find((item): item is Record<string, unknown> => isRecord(item));
        const projectSlug = firstProject !== undefined ? firstProject['slug'] : undefined;
        const projectId = firstProject !== undefined ? firstProject['id'] : undefined;
        const projectRef = typeof projectSlug === 'string' && projectSlug.length > 0
          ? projectSlug
          : typeof projectId === 'string'
            ? projectId
            : null;
        if (cancelled) {
          return;
        }
        if (projectRef === null) {
          setState('noProjects');
          return;
        }
        router.replace(`/dashboard/org/${encodeURIComponent(effectiveSlug)}/projects/${encodeURIComponent(projectRef)}/keys`);
      } catch {
        if (!cancelled) {
          setState('noProjects');
        }
      }
    };

    void resolve();
    return (): void => {
      cancelled = true;
    };
  }, [orgSlug, router]);

  if (state === 'noSession') {
    return (
      <EntryPanel
        title="Sesión requerida"
        detail="Inicia sesión para acceder a la consola de tu organización. Al entrar, se abrirá automáticamente el proyecto real de tu tenant."
      />
    );
  }
  if (state === 'noProjects') {
    return (
      <EntryPanel
        title="No hay proyectos disponibles"
        detail="Tu sesión es válida, pero la API no devolvió ningún proyecto para esta organización. Crea el primero desde la consola de claves o contacta con soporte."
      />
    );
  }
  return (
    <EntryPanel
      title="Resolviendo tu espacio de trabajo…"
      detail="Estamos consultando la sesión y los proyectos reales de tu organización."
    />
  );
}
