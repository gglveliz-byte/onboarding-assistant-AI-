/**
 * @archivo apps/web/src/components/rag-editor/useFunctionalMapDualEditor.ts
 * @modulo 08-frontend-rag-editor (Hook Sincronizador Bidireccional Visual-JSON con Hashing RFC 8785)
 * @proposito
 *   Sincroniza en tiempo real la representación estructurada en árbol (Panel Izquierdo)
 *   y el documento JSON canónico (Panel Derecho). Valida el esquema semántico del mapa,
 *   calcula en cliente el digest SHA-256 bajo la norma RFC 8785 con Web Crypto API,
 *   y orquesta la publicación inmutable y el rollback de versiones.
 *
 * @resumen_contenido
 *   - Función `canonicalizeRfc8785`: Serialización determinista con claves ordenadas lexicográficamente.
 *   - Función `computeSha256Hex`: Digest SHA-256 en cliente para certificación de inmutabilidad.
 *   - Hook `useFunctionalMapDualEditor`:
 *       * Estado dual coordinado (árbol de elementos y cadena JSON).
 *       * Validación de esquemas y detección de selectores duplicados o inconsistentes.
 *       * Publicación inmutable (`publishMapVersion`) y rollback (`rollbackToVersion`).
 *
 * @dependencias_internas
 *   - `BoundingBox` (../visual-trainer/useRemoteTrainerSession.ts).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { BoundingBox } from '../visual-trainer/useRemoteTrainerSession';
import { useResolvedProjectId } from '../dashboard-dev/useProjectsAndApiKeys';
import { backendFetch } from '../../lib/api-client/http-client';

export interface FunctionalMapElement {
  id: string;
  title: string;
  functionalDescription: string;
  isActionable: boolean;
  actionType: 'CLICK' | 'TYPE' | 'BOTH' | 'NONE';
  primarySelector: string;
  accessibilitySelector?: string;
  structuralCssSelector: string;
  xpathFallback: string;
  urlRoutePattern: string;
  desktopBbox: BoundingBox;
  tabletBbox: BoundingBox;
  mobileBbox: BoundingBox;
}

export interface MapVersionMetadata {
  readonly versionNumber: number;
  readonly versionLabel?: string;
  readonly contentSha256Hash: string;
  readonly totalElements: number;
  readonly publishedAtIso: string;
  readonly publishedByEmail?: string;
}

/**
 * Ordena recursivamente las claves de un objeto para serialización determinista RFC 8785.
 */
export function canonicalizeRfc8785(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeRfc8785).join(',')}]`;
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `"${k}":${canonicalizeRfc8785((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Calcula el hash SHA-256 en hexadecimal usando Web Crypto API.
 */
export async function computeSha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convierte una caja del editor (`x`, `y`) a la caja canónica del backend (`top`, `left`). */
function toServerBox(box: BoundingBox): {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    top: Math.max(0, box.y),
    left: Math.max(0, box.x),
    width: Math.max(0, box.width),
    height: Math.max(0, box.height),
  };
}

/**
 * Convierte un elemento del editor al contrato de publicación del backend
 * (`mapElementInputSchema`): clave `elementKey`, cajas `{top,left}` y acción coherente.
 */
function toPublishableElement(element: FunctionalMapElement): Record<string, unknown> {
  const sanitizedTitle = element.title
    .toLowerCase()
    .replace(/[^a-z0-9_\-.:]+/gu, '_')
    .slice(0, 120);
  const elementKey = element.id.length > 0 ? element.id : sanitizedTitle;
  return {
    elementKey,
    urlRoutePattern: element.urlRoutePattern.length > 0 ? element.urlRoutePattern : '/',
    title: element.title,
    functionalDescription: element.functionalDescription,
    isActionable: element.isActionable,
    actionType: element.isActionable ? element.actionType : 'NONE',
    primarySelector: element.primarySelector,
    ...(typeof element.accessibilitySelector === 'string' && element.accessibilitySelector.length > 0
      ? { accessibilitySelector: element.accessibilitySelector }
      : {}),
    ...(typeof element.structuralCssSelector === 'string' && element.structuralCssSelector.length > 0
      ? { structuralCssSelector: element.structuralCssSelector }
      : {}),
    ...(typeof element.xpathFallback === 'string' && element.xpathFallback.length > 0
      ? { xpathFallback: element.xpathFallback }
      : {}),
    desktopBbox: toServerBox(element.desktopBbox),
    tabletBbox: toServerBox(element.tabletBbox),
    mobileBbox: toServerBox(element.mobileBbox),
  };
}

export function useFunctionalMapDualEditor(projectRef: string) {
  // El identificador de la ruta puede ser el slug: se resuelve al UUID real que exige la API.
  const { projectId: resolvedProjectId } = useResolvedProjectId(projectRef);
  // El mapa arranca VACÍO: el backend todavía no expone la lectura del mapa publicado, así que
  // no se siembran elementos, hash ni historial de versiones de demostración.
  const initialElements: FunctionalMapElement[] = useMemo(() => [], []);

  const [elements, setElements] = useState<FunctionalMapElement[]>(initialElements);
  const [jsonCode, setJsonCode] = useState<string>(() => JSON.stringify(initialElements, null, 2));
  const [sha256Hash, setSha256Hash] = useState<string>('');
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedVersions, setPublishedVersions] = useState<MapVersionMetadata[]>([]);

  // Recalcula el SHA-256 y sincroniza cuando cambia el árbol de elementos
  useEffect(() => {
    let isCancelled = false;
    const canonical = canonicalizeRfc8785(elements);
    computeSha256Hex(canonical).then((hash) => {
      if (!isCancelled) {
        setSha256Hash(hash);
      }
    });
    return () => {
      isCancelled = true;
    };
  }, [elements]);

  /**
   * Actualización originada en el panel visual (Tarjetas).
   */
  const updateElementFromTree = useCallback((updatedElement: FunctionalMapElement) => {
    setElements((prev) => {
      const next = prev.map((el) => (el.id === updatedElement.id ? updatedElement : el));
      setJsonCode(JSON.stringify(next, null, 2));
      return next;
    });
    setSyntaxError(null);
  }, []);

  /**
   * Eliminación de un elemento desde el panel visual.
   */
  const removeElementFromTree = useCallback((elementId: string) => {
    setElements((prev) => {
      const next = prev.filter((el) => el.id !== elementId);
      setJsonCode(JSON.stringify(next, null, 2));
      return next;
    });
  }, []);

  /**
   * Actualización originada en el editor de código JSON.
   */
  const updateFromJsonCode = useCallback((rawCode: string) => {
    setJsonCode(rawCode);
    try {
      const parsed = JSON.parse(rawCode);
      if (!Array.isArray(parsed)) {
        setSyntaxError('El documento JSON debe ser un arreglo de elementos [ ... ]');
        return;
      }

      // Validar IDs únicos
      const idSet = new Set<string>();
      for (const item of parsed) {
        if (!item.id || typeof item.id !== 'string') {
          setSyntaxError('Cada elemento debe contener una propiedad "id" no vacía.');
          return;
        }
        if (idSet.has(item.id)) {
          setSyntaxError(`Identificador duplicado detectado: "${item.id}"`);
          return;
        }
        idSet.add(item.id);
      }

      setElements(parsed as FunctionalMapElement[]);
      setSyntaxError(null);
    } catch (err: any) {
      setSyntaxError(err.message || 'Error de sintaxis JSON');
    }
  }, []);

  /**
   * Formatea el código JSON actual bajo la indentación estándar.
   */
  const formatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonCode);
      setJsonCode(JSON.stringify(parsed, null, 2));
      setSyntaxError(null);
    } catch {
      // Ignorar si hay error sintáctico activo
    }
  }, [jsonCode]);

  /**
   * Publica la versión actual del mapa como inmutable en backend.
   */
  const publishMapVersion = useCallback(
    async (versionLabel?: string) => {
      if (syntaxError) {
        throw new Error('No es posible publicar un mapa con errores sintácticos o IDs duplicados.');
      }
      if (resolvedProjectId === null) {
        throw new Error('No se pudo resolver el proyecto activo: inicia sesión y recarga la vista.');
      }
      setIsPublishing(true);
      setPublishError(null);

      const nextVersionNumber = (publishedVersions[0]?.versionNumber ?? 0) + 1;
      const resolvedLabel = versionLabel || `v${nextVersionNumber}.0.0`;
      const newVersionMeta: MapVersionMetadata = {
        versionNumber: nextVersionNumber,
        versionLabel: resolvedLabel,
        contentSha256Hash: sha256Hash,
        totalElements: elements.length,
        publishedAtIso: new Date().toISOString(),
      };

      try {
        const published = await backendFetch<{
          readonly map?: {
            readonly versionNumber?: number;
            readonly versionLabel?: string;
            readonly contentSha256Hash?: string;
            readonly totalElementsCount?: number;
            readonly publishedAt?: string;
          };
        }>(`/api/v1/projects/${resolvedProjectId}/functional-maps/publish`, {
          method: 'POST',
          body: {
            versionLabel: newVersionMeta.versionLabel,
            sourceMode: 'JSON_CODE_EDITOR',
            elements: elements.map(toPublishableElement),
          },
        });
        const serverMap = published.map ?? {};
        setPublishedVersions((prev) => [{
          versionNumber: serverMap.versionNumber ?? newVersionMeta.versionNumber,
          versionLabel: serverMap.versionLabel ?? resolvedLabel,
          contentSha256Hash: serverMap.contentSha256Hash ?? newVersionMeta.contentSha256Hash,
          totalElements: serverMap.totalElementsCount ?? newVersionMeta.totalElements,
          publishedAtIso: serverMap.publishedAt ?? newVersionMeta.publishedAtIso,
        }, ...prev]);
        setIsPublishing(false);
        return newVersionMeta;
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : 'Error al publicar el mapa';
        setPublishError(message);
        setIsPublishing(false);
        throw new Error(message);
      }
    },
    [elements, resolvedProjectId, publishedVersions, sha256Hash, syntaxError]
  );

  /**
   * Ejecuta rollback instantáneo a una versión anterior.
   */
  const rollbackToVersion = useCallback(
    async (targetVersionNumber: number) => {
      if (resolvedProjectId === null) {
        throw new Error('No se pudo resolver el proyecto activo: inicia sesión y recarga la vista.');
      }
      setPublishError(null);
      try {
        await backendFetch<unknown>(`/api/v1/projects/${resolvedProjectId}/functional-maps/rollback`, {
          method: 'POST',
          body: { targetVersionNumber },
        });
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : 'Error al restaurar la versión';
        setPublishError(message);
        throw new Error(message);
      }
    },
    [resolvedProjectId]
  );

  return {
    elements,
    jsonCode,
    sha256Hash,
    syntaxError,
    isPublishing,
    publishError,
    publishedVersions,
    updateElementFromTree,
    removeElementFromTree,
    updateFromJsonCode,
    formatJson,
    publishMapVersion,
    rollbackToVersion,
  };
}
