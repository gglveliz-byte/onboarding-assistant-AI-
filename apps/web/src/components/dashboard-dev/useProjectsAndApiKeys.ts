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
import { backendFetch, getAccessToken } from '../../lib/api-client/http-client';

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
  readonly voicePersonaCode?: string;
  readonly speechSpeed?: number;
  readonly vadBargeInSensitivity?: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly modelTemperature?: number;
  readonly systemPrompt?: string;
  readonly onboardingStepsJson?: readonly Record<string, unknown>[];
  readonly strictStepEnforcement?: boolean;
  readonly askConfirmationBeforeSubmit?: boolean;
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

/**
 * Caché de proyectos PARTICIONADA por token de sesión: la lista de un inquilino nunca puede
 * servirse a otro (al cambiar de sesión, la clave cambia y la caché anterior no se reutiliza).
 */
const projectsCache = new Map<string, { readonly items: ProjectItem[]; readonly fetchedAt: number }>();

/** Promesas en vuelo, una por token, para deduplicar consultas concurrentes del mismo inquilino. */
const projectsRequests = new Map<string, Promise<ProjectItem[]>>();

/**
 * Vacía la caché de proyectos (al cerrar sesión o cambiar de inquilino).
 */
export function clearProjectsCache(): void {
  projectsCache.clear();
  projectsRequests.clear();
}

/** Clave de partición de la caché: el token vigente o un discriminante «sin sesión». */
function projectsCacheKey(): string {
  const token = getAccessToken();
  return token === null || token.length === 0 ? 'sin-sesion' : token;
}

/** Determina si un valor desconocido es un registro JSON indexable. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normaliza un valor temporal del backend (ISO o epoch) a una cadena ISO; `''` si no existe. */
function toIsoString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  // Sin dato del servidor: se deja vacío en lugar de inventar la fecha de ahora.
  return '';
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
  const fallbackVoiceModel = raw['fallbackVoiceModel'];
  const voicePersonaCode = raw['voicePersonaCode'];
  const speechSpeed = raw['speechSpeed'];
  const vadBargeInSensitivity = raw['vadBargeInSensitivity'];
  const modelTemperature = raw['modelTemperature'];
  const systemPrompt = raw['systemPrompt'];
  const onboardingStepsJson = raw['onboardingStepsJson'];
  const strictStepEnforcement = raw['strictStepEnforcement'];
  const askConfirmationBeforeSubmit = raw['askConfirmationBeforeSubmit'];
  return {
    id,
    organizationId: typeof organizationId === 'string' ? organizationId : '',
    name,
    slug,
    environment: environment === 'TEST' ? 'TEST' : 'LIVE',
    ...(typeof primaryVoiceModel === 'string' ? { primaryVoiceModel } : {}),
    ...(typeof fallbackVoiceModel === 'string' ? { fallbackVoiceModel } : {}),
    ...(typeof voicePersonaCode === 'string' ? { voicePersonaCode } : {}),
    ...(typeof speechSpeed === 'number' ? { speechSpeed } : {}),
    ...(vadBargeInSensitivity === 'LOW' || vadBargeInSensitivity === 'MEDIUM' || vadBargeInSensitivity === 'HIGH'
      ? { vadBargeInSensitivity }
      : {}),
    ...(typeof modelTemperature === 'number' ? { modelTemperature } : {}),
    ...(typeof systemPrompt === 'string' ? { systemPrompt } : {}),
    ...(Array.isArray(onboardingStepsJson)
      ? { onboardingStepsJson: onboardingStepsJson as readonly Record<string, unknown>[] }
      : {}),
    ...(typeof strictStepEnforcement === 'boolean' ? { strictStepEnforcement } : {}),
    ...(typeof askConfirmationBeforeSubmit === 'boolean' ? { askConfirmationBeforeSubmit } : {}),
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

/** Lee la caché de proyectos si sigue vigente para la sesión actual. */
function readProjectsCache(cacheKey: string): ProjectItem[] | null {
  const entry = projectsCache.get(cacheKey);
  if (entry !== undefined && Date.now() - entry.fetchedAt < PROJECTS_CACHE_TTL_MS) {
    return entry.items;
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
    const cacheKey = projectsCacheKey();
    const cached = readProjectsCache(cacheKey);
    if (cached !== null) {
      setProjects(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let pending = projectsRequests.get(cacheKey);
      if (pending === undefined) {
        pending = requestProjects().finally(() => {
          projectsRequests.delete(cacheKey);
        });
        projectsRequests.set(cacheKey, pending);
      }
      const items = await pending;
      projectsCache.set(cacheKey, { items, fetchedAt: Date.now() });
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
