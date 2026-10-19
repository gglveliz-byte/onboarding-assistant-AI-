/**
 * @archivo apps/web/src/components/dashboard-dev/useDashboardWorkspace.ts
 * @modulo 08-frontend-dashboard-dev (Hechos de Sesión y Workspace Real del Dashboard)
 * @proposito
 *   Reúne en una sola fuente los hechos REALES que el shell del Dashboard necesita para dejar de
 *   mostrar datos de demostración: la sesión vigente (token de acceso rehidratado desde la
 *   pestaña), la organización y el rol del usuario, la lista de proyectos del tenant y el saldo
 *   de minutos del ciclo de facturación. Todas las lecturas viajan por el cliente HTTP único
 *   (`backendFetch`), que adjunta el Bearer, renueva la sesión ante un 401 y normaliza errores.
 *
 * @resumen_contenido
 *   - `readSessionFacts()`: decodifica el token de la pestaña y extrae rol, organización y expiración.
 *   - `useDashboardSessionFacts()`: hechos de sesión con relectura al recuperar el foco de la ventana.
 *   - `useDashboardProjects()`: `GET /api/v1/projects` con estados de carga y error reales.
 *   - `useDashboardBalance()`: `GET /api/v1/billing/consumption` mapeado a minutos restantes y cuota.
 *   - `useDashboardWorkspace()`: composición de todo lo anterior + resolución del proyecto de la URL.
 *
 * @dependencias_internas
 *   - `backendFetch`, `getAccessToken` (apps/web/src/lib/api-client/http-client.ts).
 *   - `decodeJwtPayloadUnsafe` (apps/web/src/components/auth-legal/auth-api-client.ts).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useEffect`, `useCallback`, `useMemo`).
 *   - `next/navigation` (`usePathname`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL (vía API REST): `projects`, `whop_subscriptions` (lectura de consumo).
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { backendFetch, getAccessToken } from '../../lib/api-client/http-client';
import { decodeJwtPayloadUnsafe } from '../auth-legal/auth-api-client';

/** Roles RBAC reconocidos por el backend y reflejados en la interfaz del dashboard. */
export type DashboardRole = 'OWNER' | 'DEVELOPER' | 'BILLING' | 'VIEWER';

/** Hechos verificables de la sesión vigente, derivados del token de acceso de la pestaña. */
export interface DashboardSessionFacts {
  readonly isAuthenticated: boolean;
  /** `false` mientras el primer render (servidor) todavía no ha resuelto el token de la pestaña. */
  readonly isResolved: boolean;
  readonly role: DashboardRole | null;
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly expiresAtEpochMs: number | null;
}

/** Proyección de proyecto tal y como la devuelve `GET /api/v1/projects`. */
export interface DashboardProject {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly environment: 'LIVE' | 'TEST';
  readonly isActive: boolean;
}

/** Saldo de voz del ciclo vigente, listo para la pastilla de la cabecera. */
export interface DashboardBalance {
  readonly remainingMinutes: number;
  readonly totalPurchasedMinutes: number;
  readonly planCode: string;
  readonly status: string;
}

/** Estado genérico de una lectura asíncrona del dashboard. */
export interface DashboardAsyncState<T> {
  readonly data: T;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

const EMPTY_PROJECTS: readonly DashboardProject[] = [];
const EMPTY_BALANCE: DashboardBalance = {
  remainingMinutes: 0,
  totalPurchasedMinutes: 0,
  planCode: '',
  status: '',
};

/** Roles admitidos; cualquier otro valor del reclamo se descarta. */
const KNOWN_ROLES: readonly string[] = ['OWNER', 'DEVELOPER', 'BILLING', 'VIEWER'];

/** Determina si un valor desconocido es un registro JSON indexable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convierte un decimal de cadena (Fixed6) en número finito; `0` si no es interpretable. */
function toFiniteNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Extrae el rol del reclamo `role` si pertenece a la lista cerrada de roles. */
function coerceRole(value: unknown): DashboardRole | null {
  return typeof value === 'string' && KNOWN_ROLES.includes(value) ? (value as DashboardRole) : null;
}

/** Hechos neutros: primer render (servidor y cliente) sin leer el almacenamiento de la pestaña. */
const UNRESOLVED_SESSION_FACTS: DashboardSessionFacts = {
  isAuthenticated: false,
  isResolved: false,
  role: null,
  organizationId: null,
  userId: null,
  expiresAtEpochMs: null,
};

/**
 * Lee los hechos de sesión del token de acceso vigente de la pestaña.
 *
 * @returns Hechos de sesión; `isAuthenticated` es `false` si no hay token o si expiró.
 */
export function readSessionFacts(): DashboardSessionFacts {
  const token = getAccessToken();
  if (token === null || token.length === 0) {
    return {
      isAuthenticated: false, isResolved: true, role: null, organizationId: null, userId: null, expiresAtEpochMs: null,
    };
  }
  const payload = decodeJwtPayloadUnsafe(token);
  if (payload === null) {
    return {
      isAuthenticated: false, isResolved: true, role: null, organizationId: null, userId: null, expiresAtEpochMs: null,
    };
  }
  const expiresAtSeconds = payload['exp'];
  const expiresAtEpochMs = typeof expiresAtSeconds === 'number' ? expiresAtSeconds * 1000 : null;
  const isExpired = expiresAtEpochMs !== null && expiresAtEpochMs <= Date.now();
  const organizationId = payload['org_id'];
  const userId = payload['sub'];
  return {
    isAuthenticated: !isExpired,
    isResolved: true,
    role: coerceRole(payload['role']),
    organizationId: typeof organizationId === 'string' ? organizationId : null,
    userId: typeof userId === 'string' ? userId : null,
    expiresAtEpochMs,
  };
}

/**
 * Hook de hechos de sesión: parte de un estado neutro (idéntico en servidor y cliente, para no
 * romper la hidratación) y resuelve el token de la pestaña al montar y al recuperar el foco.
 */
export function useDashboardSessionFacts(): DashboardSessionFacts {
  const [facts, setFacts] = useState<DashboardSessionFacts>(UNRESOLVED_SESSION_FACTS);

  useEffect((): (() => void) => {
    const refresh = (): void => {
      setFacts(readSessionFacts());
    };
    refresh();
    window.addEventListener('focus', refresh);
    return (): void => {
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return facts;
}

/** Normaliza un proyecto crudo de la API a la proyección del dashboard. */
function coerceProject(raw: unknown): DashboardProject | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = raw['id'];
  const name = raw['name'];
  const slug = raw['slug'];
  if (typeof id !== 'string' || typeof name !== 'string' || typeof slug !== 'string') {
    return null;
  }
  const organizationId = raw['organizationId'];
  const environment = raw['environment'];
  const isActive = raw['isActive'];
  return {
    id,
    organizationId: typeof organizationId === 'string' ? organizationId : '',
    name,
    slug,
    environment: environment === 'TEST' ? 'TEST' : 'LIVE',
    isActive: isActive !== false,
  };
}

/**
 * Hook de proyectos reales del tenant: `GET /api/v1/projects` con el Bearer de la sesión.
 * No inventa proyectos de respaldo: si la API falla, la lista queda vacía y el error visible.
 */
export function useDashboardProjects(): DashboardAsyncState<readonly DashboardProject[]> {
  const [projects, setProjects] = useState<readonly DashboardProject[]>(EMPTY_PROJECTS);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const payload = await backendFetch<unknown>('/api/v1/projects');
      const rawList = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload['projects'])
          ? payload['projects']
          : [];
      setProjects(rawList.map(coerceProject).filter((item): item is DashboardProject => item !== null));
    } catch (caught) {
      setProjects(EMPTY_PROJECTS);
      setError(caught instanceof Error ? caught.message : 'No fue posible consultar los proyectos.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect((): void => {
    void loadProjects();
  }, [loadProjects]);

  return { data: projects, isLoading, error, reload: loadProjects };
}

/**
 * Hook de saldo real de voz: `GET /api/v1/billing/consumption` mapeado a minutos restantes
 * y cuota del ciclo. Devuelve ceros cuando la API todavía no responde (sesión ausente).
 */
export function useDashboardBalance(): DashboardAsyncState<DashboardBalance> {
  const [balance, setBalance] = useState<DashboardBalance>(EMPTY_BALANCE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadBalance = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const payload = await backendFetch<unknown>('/api/v1/billing/consumption');
      if (!isRecord(payload)) {
        setBalance(EMPTY_BALANCE);
        return;
      }
      setBalance({
        remainingMinutes: toFiniteNumber(payload['includedMinutesRemaining']),
        totalPurchasedMinutes: toFiniteNumber(payload['includedMinutesQuota']),
        planCode: typeof payload['planCode'] === 'string' ? payload['planCode'] : '',
        status: typeof payload['status'] === 'string' ? payload['status'] : '',
      });
    } catch (caught) {
      setBalance(EMPTY_BALANCE);
      setError(caught instanceof Error ? caught.message : 'No fue posible consultar el consumo.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect((): void => {
    void loadBalance();
  }, [loadBalance]);

  return { data: balance, isLoading, error, reload: loadBalance };
}

/** Contexto de trabajo consolidado que consume el shell del dashboard. */
export interface DashboardWorkspace {
  readonly session: DashboardSessionFacts;
  readonly projects: readonly DashboardProject[];
  readonly activeProject: DashboardProject | null;
  readonly balance: DashboardBalance;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly reloadProjects: () => Promise<void>;
  readonly reloadBalance: () => Promise<void>;
}

/**
 * Compone sesión, proyectos, saldo y el proyecto activo de la URL.
 *
 * @param projectHint - Segmento de proyecto de la ruta (UUID o slug) tal y como llega al shell.
 * @returns Hechos consolidados del workspace para pintar el dashboard con datos reales.
 */
export function useDashboardWorkspace(projectHint: string): DashboardWorkspace {
  const pathname = usePathname();
  const session = useDashboardSessionFacts();
  const projectsState = useDashboardProjects();
  const balanceState = useDashboardBalance();

  const activeProject = useMemo((): DashboardProject | null => {
    const routeSegment = pathname?.match(/\/projects\/([^/]+)/)?.[1] ?? projectHint;
    if (routeSegment === undefined || routeSegment.length === 0) {
      return projectsState.data[0] ?? null;
    }
    return projectsState.data.find(
      (project) => project.id === routeSegment || project.slug === routeSegment,
    ) ?? null;
  }, [pathname, projectHint, projectsState.data]);

  const error = projectsState.error ?? balanceState.error;

  return {
    session,
    projects: projectsState.data,
    activeProject,
    balance: balanceState.data,
    isLoading: projectsState.isLoading || balanceState.isLoading,
    error,
    reloadProjects: projectsState.reload,
    reloadBalance: balanceState.reload,
  };
}
