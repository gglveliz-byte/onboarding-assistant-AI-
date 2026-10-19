/**
 * @archivo apps/web/src/components/dashboard-dev/useProjectsAndApiKeys.ts
 * @modulo 08-frontend-dashboard-dev (Hooks de Proyectos, Dominios CORS y Ciclo de Vida de API Keys)
 * @proposito
 *   Hooks de React fuertemente tipados que hablan con la API REAL del tenant: proyectos del
 *   organización (`GET /api/v1/projects`), orígenes CORS permitidos para el Handshake del SDK y
 *   claves criptográficas (`pk_live_`/`sk_live_`). Todas las llamadas viajan por el cliente HTTP
 *   único (`backendFetch`), que adjunta el Bearer de la sesión, renueva el token ante un 401 y
 *   normaliza el sobre de error. NO se siembran datos de demostración: las listas arrancan vacías
 *   y reflejan exactamente lo que el backend expone.
 *
 * @resumen_contenido
 *   - Interfaces de dominio: `ProjectItem`, `AllowedDomainItem`, `ApiKeyItem`, `CreatedApiKeyResult`.
 *   - `useProjects()`: lista real de proyectos del tenant con caché corta y deduplicación de peticiones.
 *   - `useResolvedProjectId()`: resuelve el identificador de la ruta (UUID o slug) al UUID real.
 *   - Mapeadores compartidos (`isRecord`, `coerceApiKey`, `coerceDomain`) reutilizados por
 *     `useAllowedDomainsAndApiKeys.ts`.
 *
 * @dependencias_internas
 *   - `backendFetch` (apps/web/src/lib/api-client/http-client.ts).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useCallback`, `useEffect`, `useMemo`).
 *
 * @notas
 *   - Los hooks de orígenes y claves viven en `useAllowedDomainsAndApiKeys.ts` (partición modular
 *     para respetar el tope de 500 líneas); este archivo conserva los contratos compartidos.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `projects`, `allowed_domains`, `api_keys`.
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { backendFetch } from '../../lib/api-client/http-client';

export type ProjectEnvironment = 'LIVE' | 'TEST';
export type ApiKeyType = 'pk' | 'sk';
export type GracePeriodHours = 0 | 1 | 24 | 72;

export interface ProjectItem {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly environment: ProjectEnvironment;
  readonly primaryVoiceModel?: string;
  readonly fallbackVoiceModel?: string;
  readonly speechSpeed?: number;
  readonly vadBargeInSensitivity?: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly modelTemperature?: number;
  readonly systemPrompt?: string;
  readonly isActive: boolean;
  readonly createdAtIso: string;
}

export interface AllowedDomainItem {
  readonly id: string;
  readonly projectId: string;
  readonly originPattern: string;
  readonly allowLocalhostDev: boolean;
  readonly createdAtIso: string;
}

export interface ApiKeyItem {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly keyType: ApiKeyType;
  readonly environment: ProjectEnvironment;
  readonly keyPrefix: string;
  readonly lastFour: string;
  readonly scopes: readonly string[];
  readonly createdAtIso: string;
  readonly expiresAtIso?: string;
  readonly lastUsedAtIso?: string;
  readonly isRevoked?: boolean;
}

export interface CreatedApiKeyResult {
  readonly apiKey: ApiKeyItem;
  readonly rawSecretKey?: string;
}

/** Duración de la caché corta de proyectos para no repetir la misma consulta en cada montaje. */
const PROJECTS_CACHE_TTL_MS = 15_000;

/** Caché de proyectos y promesa en vuelo compartida entre consumidores del mismo tick. */
let projectsCache: { readonly items: ProjectItem[]; readonly fetchedAt: number } | null = null;
let projectsRequest: Promise<ProjectItem[]> | null = null;

/** Determina si un valor desconocido es un registro JSON indexable. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normaliza un valor temporal del backend (ISO o epoch) a una cadena ISO. */
function toIsoString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

/** Convierte un proyecto crudo de la API a la proyección del dashboard. */
function coerceProject(raw: unknown): ProjectItem | null {
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
  const primaryVoiceModel = raw['primaryVoiceModel'];
  return {
    id,
    organizationId: typeof organizationId === 'string' ? organizationId : '',
    name,
    slug,
    environment: environment === 'TEST' ? 'TEST' : 'LIVE',
    ...(typeof primaryVoiceModel === 'string' ? { primaryVoiceModel } : {}),
    isActive: isActive !== false,
    createdAtIso: toIsoString(raw['createdAt']),
  };
}

/** Convierte una clave cruda de la API a la proyección del dashboard. */
export function coerceApiKey(raw: unknown, fallbackProjectId: string): ApiKeyItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = raw['id'];
  const name = raw['name'];
  const keyType = raw['keyType'];
  if (typeof id !== 'string' || typeof name !== 'string') {
    return null;
  }
  const projectId = raw['projectId'];
  const environment = raw['environment'];
  const keyPrefix = raw['keyPrefix'];
  const lastFour = raw['lastFour'];
  const scopes = raw['scopes'];
  const expiresAt = raw['expiresAt'];
  const lastUsedAt = raw['lastUsedAt'];
  const revokedAt = raw['revokedAt'];
  return {
    id,
    projectId: typeof projectId === 'string' ? projectId : fallbackProjectId,
    name,
    keyType: keyType === 'sk' ? 'sk' : 'pk',
    environment: environment === 'TEST' ? 'TEST' : 'LIVE',
    keyPrefix: typeof keyPrefix === 'string' ? keyPrefix : '',
    lastFour: typeof lastFour === 'string' ? lastFour : '',
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    createdAtIso: toIsoString(raw['createdAt']),
    ...(typeof expiresAt === 'string' ? { expiresAtIso: expiresAt } : {}),
    ...(typeof lastUsedAt === 'string' ? { lastUsedAtIso: lastUsedAt } : {}),
    ...(typeof revokedAt === 'string' ? { isRevoked: true } : {}),
  };
}

/** Convierte un dominio crudo de la API a la proyección del dashboard. */
export function coerceDomain(raw: unknown, fallbackProjectId: string): AllowedDomainItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = raw['id'];
  const originPattern = raw['originPattern'];
  if (typeof id !== 'string' || typeof originPattern !== 'string') {
    return null;
  }
  const projectId = raw['projectId'];
  const allowLocalhostDev = raw['allowLocalhostDev'];
  return {
    id,
    projectId: typeof projectId === 'string' ? projectId : fallbackProjectId,
    originPattern,
    allowLocalhostDev: allowLocalhostDev === true,
    createdAtIso: toIsoString(raw['createdAt']),
  };
}

/** Solicita la lista real de proyectos al backend (deduplicada por promesa compartida). */
async function requestProjects(): Promise<ProjectItem[]> {
  const payload = await backendFetch<unknown>('/api/v1/projects');
  const rawList = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload['projects'])
      ? payload['projects']
      : [];
  return rawList
    .map(coerceProject)
    .filter((item): item is ProjectItem => item !== null);
}

/** Lee la caché de proyectos si sigue vigente. */
function readProjectsCache(): ProjectItem[] | null {
  if (projectsCache !== null && Date.now() - projectsCache.fetchedAt < PROJECTS_CACHE_TTL_MS) {
    return projectsCache.items;
  }
  return null;
}

/**
 * Hook de proyectos reales del tenant (`GET /api/v1/projects`).
 * No siembra proyectos de respaldo: si la API falla, la lista queda vacía y el error es visible.
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async (): Promise<void> => {
    const cached = readProjectsCache();
    if (cached !== null) {
      setProjects(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (projectsRequest === null) {
        projectsRequest = requestProjects().finally(() => {
          projectsRequest = null;
        });
      }
      const items = await projectsRequest;
      projectsCache = { items, fetchedAt: Date.now() };
      setProjects(items);
    } catch (caught) {
      setProjects([]);
      setError(caught instanceof Error ? caught.message : 'No fue posible consultar los proyectos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  return { projects, loading, error, fetchProjects };
}

/**
 * Resuelve el identificador de proyecto de la ruta (UUID o slug) al UUID real que exige la API.
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 * @returns UUID real del proyecto, `null` si aún no se conoce, y el error de resolución.
 */
export function useResolvedProjectId(projectRef: string): {
  readonly projectId: string | null;
  readonly projects: ProjectItem[];
  readonly loading: boolean;
  readonly error: string | null;
} {
  const { projects, loading, error } = useProjects();
  const projectId = useMemo((): string | null => {
    if (projectRef.length === 0) {
      return null;
    }
    const match = projects.find((project) => project.id === projectRef || project.slug === projectRef);
    return match?.id ?? null;
  }, [projectRef, projects]);
  return { projectId, projects, loading, error };
}

/**
 * Hook de orígenes CORS permitidos (`allowed_domains`) para el Handshake del SDK.
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 */

/**
 * Hook del ciclo de vida de claves criptográficas de API (`pk_live_`/`sk_live_`).
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 */
