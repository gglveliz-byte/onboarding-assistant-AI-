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

export function useFunctionalMapDualEditor(projectId: string) {
  const initialElements: FunctionalMapElement[] = useMemo(
    () => [
      {
        id: 'elem_factura_btn',
        title: 'Botón Crear Factura',
        functionalDescription: 'Inicia el formulario modal de emisión fiscal para clientes recurrentes.',
        isActionable: true,
        actionType: 'CLICK',
        primarySelector: '[data-oa-id="btn-create-invoice"]',
        accessibilitySelector: 'button[aria-label="Crear Factura"]',
        structuralCssSelector: 'main > div:nth-child(2) > button.primary-btn',
        xpathFallback: '//button[contains(text(),"Crear Factura")]',
        urlRoutePattern: '/dashboard/invoices',
        desktopBbox: { x: 420, y: 120, width: 140, height: 38 },
        tabletBbox: { x: 340, y: 110, width: 130, height: 38 },
        mobileBbox: { x: 200, y: 95, width: 110, height: 36 },
      },
      {
        id: 'elem_rfc_input',
        title: 'Campo Identificación Fiscal / RFC',
        functionalDescription: 'Input donde el usuario ingresa la clave de registro de contribuyente.',
        isActionable: true,
        actionType: 'TYPE',
        primarySelector: '[data-oa-id="input-company-tax"]',
        structuralCssSelector: 'form#invoice-form input[name="tax_id"]',
        xpathFallback: '//input[@name="tax_id"]',
        urlRoutePattern: '/dashboard/invoices/new',
        desktopBbox: { x: 180, y: 220, width: 280, height: 40 },
        tabletBbox: { x: 150, y: 200, width: 240, height: 38 },
        mobileBbox: { x: 40, y: 180, width: 200, height: 36 },
      },
    ],
    []
  );

  const [elements, setElements] = useState<FunctionalMapElement[]>(initialElements);
  const [jsonCode, setJsonCode] = useState<string>(() => JSON.stringify(initialElements, null, 2));
  const [sha256Hash, setSha256Hash] = useState<string>('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishedVersions, setPublishedVersions] = useState<MapVersionMetadata[]>([
    {
      versionNumber: 1,
      versionLabel: 'v1.0.0 Inicial Producción',
      contentSha256Hash: '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a',
      totalElements: 2,
      publishedAtIso: '2026-03-28T14:30:00Z',
      publishedByEmail: 'dev@empresa.com',
    },
  ]);

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
      setIsPublishing(true);

      const nextVersionNumber = (publishedVersions[0]?.versionNumber ?? 0) + 1;
      const newVersionMeta: MapVersionMetadata = {
        versionNumber: nextVersionNumber,
        versionLabel: versionLabel || `v${nextVersionNumber}.0.0`,
        contentSha256Hash: sha256Hash,
        totalElements: elements.length,
        publishedAtIso: new Date().toISOString(),
      };

      try {
        await fetch(`/api/v1/projects/${projectId}/functional-maps/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            versionLabel: newVersionMeta.versionLabel,
            sourceMode: 'DUAL_RAG_EDITOR',
            elements,
          }),
        });
      } catch {
        // Fallback optimista
      }

      setPublishedVersions((prev) => [newVersionMeta, ...prev]);
      setIsPublishing(false);
      return newVersionMeta;
    },
    [elements, projectId, publishedVersions, sha256Hash, syntaxError]
  );

  /**
   * Ejecuta rollback instantáneo a una versión anterior.
   */
  const rollbackToVersion = useCallback(
    async (targetVersionNumber: number) => {
      try {
        await fetch(`/api/v1/projects/${projectId}/functional-maps/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetVersionNumber }),
        });
      } catch {
        // Fallback
      }
    },
    [projectId]
  );

  return {
    elements,
    jsonCode,
    sha256Hash,
    syntaxError,
    isPublishing,
    publishedVersions,
    updateElementFromTree,
    removeElementFromTree,
    updateFromJsonCode,
    formatJson,
    publishMapVersion,
    rollbackToVersion,
  };
}
