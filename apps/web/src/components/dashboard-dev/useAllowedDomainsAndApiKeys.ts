/**
 * @archivo apps/web/src/components/dashboard-dev/useAllowedDomainsAndApiKeys.ts
 * @modulo 08-frontend-dashboard-dev (Hooks de Orígenes CORS y Ciclo de Vida de API Keys)
 * @proposito
 *   Hooks de React que mutan los recursos reales del tenant: orígenes CORS permitidos para el
 *   Handshake del SDK (`allowed_domains`) y claves criptográficas (`pk_live_`/`sk_live_`). Todas
 *   las llamadas viajan por el cliente HTTP único (`backendFetch`), que adjunta el Bearer de la
 *   sesión y renueva el token ante un 401. El identificador de proyecto se resuelve desde el
 *   slug o UUID de la URL al UUID real que exige la API.
 *
 * @resumen_contenido
 *   - `useAllowedDomains()`: alta con validación anti-localhost en LIVE y baja de orígenes.
 *   - `useApiKeys()`: creación, rotación con ventana de gracia y revocación inmediata.
 *
 * @dependencias_internas
 *   - `useResolvedProjectId` y los contratos de dominio (./useProjectsAndApiKeys.ts).
 *   - `backendFetch` (apps/web/src/lib/api-client/http-client.ts).
 *
 * @dependencias_externas
 *   - `react` (`useState`, `useCallback`).
 *
 * @notas
 *   - El backend expone alta, rotación y revocación, pero NO el listado de `api_keys` ni de
 *     `allowed_domains`; por eso las listas arrancan vacías y las altas se reflejan de forma
 *     optimista en la sesión. `listEndpointMissing` lo declara la interfaz para poder explicarlo.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `allowed_domains`, `api_keys`.
 */

'use client';

import { useState, useCallback } from 'react';
import { backendFetch } from '../../lib/api-client/http-client';
import {
  coerceApiKey,
  coerceDomain,
  isRecord,
  useResolvedProjectId,
  type AllowedDomainItem,
  type ApiKeyItem,
  type ApiKeyType,
  type CreatedApiKeyResult,
  type GracePeriodHours,
  type ProjectEnvironment,
} from './useProjectsAndApiKeys';

/**
 * Hook de orígenes CORS permitidos (`allowed_domains`) para el Handshake del SDK.
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 */
export function useAllowedDomains(projectRef: string) {
  const { projectId, loading, error: projectError } = useResolvedProjectId(projectRef);
  const [domains, setDomains] = useState<AllowedDomainItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState<boolean>(false);

  const addDomain = useCallback(
    async (originPattern: string, allowLocalhostDev: boolean, isProjectLive: boolean) => {
      if (isProjectLive && (originPattern.includes('localhost') || originPattern.includes('127.0.0.1'))) {
        throw new Error('SSRF_OR_LOCAL_RESTRICTION: localhost no está permitido en entornos LIVE');
      }
      if (projectId === null) {
        throw new Error('No se pudo resolver el proyecto activo: inicia sesión y recarga la vista.');
      }
      setIsMutating(true);
      setError(null);
      try {
        const created = await backendFetch<unknown>(`/api/v1/projects/${projectId}/domains`, {
          method: 'POST',
          body: { originPattern, allowLocalhostDev },
        });
        const item = coerceDomain(created, projectId);
        if (item !== null) {
          setDomains((prev) => [...prev, item]);
        }
        return item;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Error al registrar el origen';
        setError(message);
        throw new Error(message);
      } finally {
        setIsMutating(false);
      }
    },
    [projectId]
  );

  const removeDomain = useCallback(
    async (domainId: string) => {
      if (projectId === null) {
        return;
      }
      setIsMutating(true);
      setError(null);
      try {
        await backendFetch<unknown>(`/api/v1/projects/${projectId}/domains/${domainId}`, {
          method: 'DELETE',
        });
        setDomains((prev) => prev.filter((domain) => domain.id !== domainId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Error al revocar el origen');
      } finally {
        setIsMutating(false);
      }
    },
    [projectId]
  );

  return {
    domains,
    loading,
    error: error ?? projectError,
    isMutating,
    listEndpointMissing: true,
    addDomain,
    removeDomain,
  };
}

/**
 * Hook del ciclo de vida de claves criptográficas de API (`pk_live_`/`sk_live_`).
 *
 * @param projectRef - Segmento de la URL del proyecto (UUID o slug).
 */
export function useApiKeys(projectRef: string) {
  const { projectId, loading, error: projectError } = useResolvedProjectId(projectRef);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState<boolean>(false);

  const createApiKey = useCallback(
    async (input: {
      name: string;
      keyType: ApiKeyType;
      environment: ProjectEnvironment;
      scopes?: string[];
    }): Promise<CreatedApiKeyResult> => {
      if (projectId === null) {
        throw new Error('No se pudo resolver el proyecto activo: inicia sesión y recarga la vista.');
      }
      setIsMutating(true);
      setError(null);
      try {
        const payload = await backendFetch<unknown>(`/api/v1/projects/${projectId}/keys`, {
          method: 'POST',
          body: {
            name: input.name,
            keyType: input.keyType,
            environment: input.environment,
            scopes: input.scopes ?? [],
          },
        });
        const rawKey = isRecord(payload) ? payload['rawKey'] : null;
        const rawApiKey = isRecord(payload) ? payload['apiKey'] : null;
        const item = coerceApiKey(rawApiKey, projectId);
        if (item === null) {
          throw new Error('La API devolvió una clave con un formato inesperado.');
        }
        setApiKeys((prev) => [...prev, item]);
        return {
          apiKey: item,
          ...(typeof rawKey === 'string' ? { rawSecretKey: rawKey } : {}),
        };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Error al crear la clave';
        setError(message);
        throw new Error(message);
      } finally {
        setIsMutating(false);
      }
    },
    [projectId]
  );

  const rotateApiKey = useCallback(
    async (apiKeyId: string, gracePeriodHours: GracePeriodHours = 24): Promise<CreatedApiKeyResult> => {
      if (projectId === null) {
        throw new Error('No se pudo resolver el proyecto activo: inicia sesión y recarga la vista.');
      }
      setIsMutating(true);
      setError(null);
      try {
        const payload = await backendFetch<unknown>(`/api/v1/projects/${projectId}/keys/rotate`, {
          method: 'POST',
          body: { apiKeyId, gracePeriodHours },
        });
        const newRawKey = isRecord(payload) ? payload['newRawKey'] : null;
        const newKey = isRecord(payload) ? payload['newKey'] : null;
        const item = coerceApiKey(newKey, projectId);
        if (item === null) {
          throw new Error('La API devolvió una clave rotada con un formato inesperado.');
        }
        setApiKeys((prev) => [...prev, item]);
        return {
          apiKey: item,
          ...(typeof newRawKey === 'string' ? { rawSecretKey: newRawKey } : {}),
        };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Error al rotar la clave';
        setError(message);
        throw new Error(message);
      } finally {
        setIsMutating(false);
      }
    },
    [projectId]
  );

  const revokeApiKey = useCallback(
    async (apiKeyId: string) => {
      if (projectId === null) {
        return;
      }
      setIsMutating(true);
      setError(null);
      try {
        await backendFetch<unknown>(`/api/v1/projects/${projectId}/keys/${apiKeyId}`, {
          method: 'DELETE',
        });
        setApiKeys((prev) => prev.filter((key) => key.id !== apiKeyId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Error al revocar la clave');
      } finally {
        setIsMutating(false);
      }
    },
    [projectId]
  );

  return {
    apiKeys,
    loading,
    error: error ?? projectError,
    isMutating,
    listEndpointMissing: true,
    createApiKey,
    rotateApiKey,
    revokeApiKey,
  };
}
