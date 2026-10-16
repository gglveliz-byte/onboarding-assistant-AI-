/**
 * @archivo src/shared/kernel/canonical-json.util.ts
 * @modulo 00-kernel (Canonicalizacion JSON Determinista RFC 8785 y Sello SHA-256 de Mapas)
 * @proposito
 *   Produce una serializacion JSON canonica y determinista de cualquier objeto del dominio.
 *   Dos representaciones funcionalmente identicas de un Mapa Funcional RAG (mismas claves en
 *   distinto orden, mismos valores) deben generar exactamente el mismo digest SHA-256; de lo
 *   contrario, republicar un mapa sin cambios alteraria su checksum y romperia la garantia de
 *   inmutabilidad sobre la que se apoya la auditoria del entrenamiento visual.
 *
 * @resumen_contenido
 *   - Constante `CANONICAL_JSON_ERROR_PREFIX`: Prefijo comun de los errores de canonicalizacion.
 *   - Funcion `canonicalizeValue()`: Serializacion recursiva con claves ordenadas por UTF-16.
 *   - Funcion `canonicalizeJsonRfc8785()`: Fachada publica de canonicalizacion.
 *   - Funcion `computeCanonicalMapSha256()`: Par canonico (JSON + digest) que sella un mapa.
 *
 * @dependencias_internas
 *   - Primitivas criptograficas (`./crypto-primitives.util.ts`) para el digest SHA-256.
 *
 * @dependencias_externas
 *   - Ninguna (Serializacion determinista implementada con tipos nativos de JavaScript).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps.canonical_sha256` y `prompt_versions.canonical_sha256`.
 *   - Redis: `rag_map:proj:<id>:meta` (Publica el checksum vigente para invalidacion de cache).
 */

import { sha256Hex, toBase64Url } from './crypto-primitives.util';

/** Prefijo comun de los mensajes de error de canonicalizacion. */
export const CANONICAL_JSON_ERROR_PREFIX = 'CANONICALIZACION_INVALIDA';

/**
 * Serializa un valor a JSON canonico determinista segun RFC 8785.
 * Reglas aplicadas:
 *   1. Las claves de objeto se ordenan por unidades de codigo UTF-16, no por orden de insercion.
 *   2. Se descartan las propiedades cuyo valor es `undefined`, tal como hace `JSON.stringify`.
 *   3. Se rechazan numeros no finitos, funciones, simbolos y referencias circulares.
 *   4. Las fechas se normalizan a su representacion ISO 8601 en UTC.
 *
 * @param value - Valor a serializar (objeto, arreglo, cadena, numero, booleano, fecha o nulo).
 * @param seenObjects - Conjunto interno de referencias usado para detectar ciclos.
 * @returns Cadena JSON canonica determinista.
 * @throws TypeError cuando el valor contiene tipos no representables o referencias circulares.
 */
export function canonicalizeValue(value: unknown, seenObjects: Set<object> = new Set()): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${CANONICAL_JSON_ERROR_PREFIX}: los numeros no finitos (NaN e Infinity) no son representables en JSON.`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return `"${value.toString()}"`;
    case 'undefined':
      throw new TypeError(`${CANONICAL_JSON_ERROR_PREFIX}: el valor \`undefined\` no es representable en JSON canonico.`);
    case 'function':
    case 'symbol':
      throw new TypeError(`${CANONICAL_JSON_ERROR_PREFIX}: el tipo "${typeof value}" no es representable en JSON canonico.`);
    default:
      break;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (value instanceof Uint8Array) {
    return JSON.stringify(toBase64Url(Buffer.from(value)));
  }

  if (Array.isArray(value)) {
    if (seenObjects.has(value)) {
      throw new TypeError(`${CANONICAL_JSON_ERROR_PREFIX}: se detecto una referencia circular en el arreglo.`);
    }
    seenObjects.add(value);
    const serializedItems = value.map((item) => canonicalizeValue(item, seenObjects));
    seenObjects.delete(value);
    return `[${serializedItems.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  if (seenObjects.has(record)) {
    throw new TypeError(`${CANONICAL_JSON_ERROR_PREFIX}: se detecto una referencia circular en el objeto.`);
  }

  seenObjects.add(record);
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    });

  const serializedEntries = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key], seenObjects)}`);
  seenObjects.delete(record);
  return `{${serializedEntries.join(',')}}`;
}

/**
 * Fachada publica de canonicalizacion JSON determinista.
 *
 * @param value - Valor a canonicalizar.
 * @returns Cadena JSON canonica con claves ordenadas y sin ambiguedades.
 */
export function canonicalizeJsonRfc8785(value: unknown): string {
  return canonicalizeValue(value);
}

/**
 * Calcula el par canonico (JSON + checksum SHA-256) que sella un Mapa Funcional inmutable.
 *
 * @param value - Objeto del Mapa Funcional (rutas, elementos y pasos de onboarding).
 * @returns Objeto con el JSON canonico y su digest SHA-256 hexadecimal.
 */
export function computeCanonicalMapSha256(value: unknown): { readonly canonicalJson: string; readonly sha256Hash: string } {
  const canonicalJson = canonicalizeValue(value);
  return { canonicalJson, sha256Hash: sha256Hex(canonicalJson) };
}
