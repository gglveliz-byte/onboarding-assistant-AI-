/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/database-enum-source.ts
 * @modulo 03-visual-trainer-and-rag (Cimientos Compartidos de Tipado Derivado del Esquema SQL)
 * @proposito
 *   Deriva los tipos enumerados y las proyecciones de columnas DIRECTAMENTE del texto de las
 *   migraciones SQL, en lugar de volver a enumerarlos a mano. Reenumerar a mano es exactamente lo
 *   que produjo el defecto C1-27: el repositorio de sesiones de voz aceptaba cuatro estados de
 *   resultado de accion mientras el tipo de la base tiene seis, de modo que escribir uno de los dos
 *   ausentes fallaba en ejecucion pese a compilar. Aqui el codigo de aplicacion y su prueba leen la
 *   misma fuente de verdad -el archivo `migrations/*.sql` que se aplica a PostgreSQL-, de modo que
 *   una divergencia entre ambos deja de ser silenciosa: rompe la compilacion estricta o la prueba.
 *
 * @resumen_contenido
 *   - Funcion `findMigrationsDirectory()`: localiza la carpeta `migrations/` del repositorio.
 *   - Funcion `readSqlEnumValues()`: extrae los valores de un `CREATE TYPE ... AS ENUM`.
 *   - Funcion `readSqlTableColumns()`: extrae las columnas de un `CREATE TABLE`.
 *   - Funcion `readSqlText()`: lectura cacheada de un archivo de migracion.
 *
 * @dependencias_internas
 *   - Ninguna. No se crea ningun ayudante duplicado del kernel compartido (`src/shared/kernel/`):
 *     este modulo solo lee texto de archivos `.sql`, capacidades que el kernel no ofrece.
 *
 * @dependencias_externas
 *   - `node:fs` y `node:path` (Lectura de las migraciones y resolucion de rutas).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions`, `action_events` (Solo lectura del DDL que las define).
 *   - Redis: Ninguna.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Nombre del directorio que contiene las migraciones aplicadas a PostgreSQL. */
export const MIGRATIONS_DIRECTORY_NAME = 'migrations';

/** Cache de archivos de migracion ya leidos, para no tocar el disco mas de una vez por archivo. */
const SQL_FILE_CACHE = new Map<string, string>();

/** Cache de valores enumerados ya extraidos, indexada por `archivo#tipo`. */
const ENUM_VALUES_CACHE = new Map<string, readonly string[]>();

/** Cache de columnas ya extraidas, indexada por `archivo#tabla`. */
const TABLE_COLUMNS_CACHE = new Map<string, readonly string[]>();

/**
 * Localiza la carpeta `migrations/` del repositorio subiendo por los directorios padre.
 * Se resuelve en tiempo de ejecucion porque las pruebas se ejecutan con `tsx` sobre el arbol de
 * fuentes y los scripts desde la raiz del repositorio; fijar una unica ruta relativa haria que el
 * tipado derivado funcionara en un contexto y fallara en el otro.
 *
 * @returns Ruta absoluta de la carpeta `migrations/`.
 * @throws Error cuando la carpeta no existe en ningun directorio padre, porque sin el DDL no hay
 *   fuente de verdad y todo tipado derivado seria una suposicion.
 */
export function findMigrationsDirectory(): string {
  let currentDirectory = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(currentDirectory, MIGRATIONS_DIRECTORY_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  const fromWorkingDirectory = resolve(process.cwd(), MIGRATIONS_DIRECTORY_NAME);
  if (existsSync(fromWorkingDirectory)) {
    return fromWorkingDirectory;
  }

  throw new Error(
    `No se encontro la carpeta \`${MIGRATIONS_DIRECTORY_NAME}/\`: sin el DDL de PostgreSQL no puede derivarse ningun tipo enumerado.`
  );
}

/**
 * Lee el texto de un archivo de migracion, con cache por ruta absoluta.
 *
 * @param fileName - Nombre del archivo dentro de `migrations/` (por ejemplo `001_enums.sql`).
 * @returns Contenido textual completo del archivo.
 * @throws Error cuando el archivo no existe o no es legible.
 */
export function readSqlText(fileName: string): string {
  const absolutePath = join(findMigrationsDirectory(), fileName);
  const cached = SQL_FILE_CACHE.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }

  let contents: string;
  try {
    contents = readFileSync(absolutePath, 'utf8');
  } catch {
    throw new Error(`No se pudo leer la migracion \`${fileName}\` en \`${absolutePath}\`.`);
  }

  SQL_FILE_CACHE.set(absolutePath, contents);
  return contents;
}

/**
 * Extrae los valores de un tipo enumerado declarado con `CREATE TYPE ... AS ENUM (...)`.
 *
 * @param fileName - Archivo de migracion que declara el tipo.
 * @param typeName - Nombre exacto del tipo (por ejemplo `action_execution_status_enum`).
 * @returns Valores del enum en su orden de declaracion, sin comillas.
 * @throws Error cuando el tipo no aparece en el archivo o declara menos de dos valores: ambas cosas
 *   significan que el esquema cambio y que el codigo debe mirarse antes de seguir.
 */
export function readSqlEnumValues(fileName: string, typeName: string): readonly string[] {
  const cacheKey = `${fileName}#${typeName}`;
  const cached = ENUM_VALUES_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const sqlText = readSqlText(fileName);
  const declarationPattern = new RegExp(
    `CREATE\\s+TYPE\\s+${typeName}\\s+AS\\s+ENUM\\s*\\(([^)]*)\\)`,
    'i'
  );
  const declaration = declarationPattern.exec(sqlText);
  const rawValues = declaration?.[1];
  if (rawValues === undefined) {
    throw new Error(`El tipo \`${typeName}\` no esta declarado en \`${fileName}\`.`);
  }

  const values = [...rawValues.matchAll(/'([^']+)'/gu)].map((match) => match[1] as string);
  if (values.length < 2) {
    throw new Error(
      `El tipo \`${typeName}\` de \`${fileName}\` declaro ${values.length} valores; se esperaban al menos 2.`
    );
  }

  const frozenValues = Object.freeze(values);
  ENUM_VALUES_CACHE.set(cacheKey, frozenValues);
  return frozenValues;
}

/**
 * Extrae los nombres de columna de una tabla declarada con `CREATE TABLE`.
 *
 * @param fileName - Archivo de migracion que declara la tabla.
 * @param tableName - Nombre exacto de la tabla (por ejemplo `voice_sessions`).
 * @returns Nombres de columna en su orden de declaracion.
 * @throws Error cuando la tabla no aparece en el archivo o no declara columnas.
 */
export function readSqlTableColumns(fileName: string, tableName: string): readonly string[] {
  const cacheKey = `${fileName}#${tableName}`;
  const cached = TABLE_COLUMNS_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const sqlText = readSqlText(fileName);
  const tablePattern = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\(`,
    'i'
  );
  const tableStart = tablePattern.exec(sqlText)?.index;
  if (tableStart === undefined) {
    throw new Error(`La tabla \`${tableName}\` no esta declarada en \`${fileName}\`.`);
  }

  const openingParenthesis = sqlText.indexOf('(', tableStart);
  const columns: string[] = [];
  let depth = 0;

  for (let index = openingParenthesis; index < sqlText.length; index += 1) {
    const character = sqlText[index] as string;
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (depth !== 1 || character !== '\n') {
      continue;
    }

    const line = sqlText.slice(index + 1, sqlText.indexOf('\n', index + 1)).trim();
    const columnMatch = /^([a-z_][a-z0-9_]*)\s+[a-z]/iu.exec(line);
    if (columnMatch?.[1] !== undefined) {
      columns.push(columnMatch[1]);
    }
  }

  if (columns.length === 0) {
    throw new Error(`La tabla \`${tableName}\` de \`${fileName}\` no declaro ninguna columna.`);
  }

  const frozenColumns = Object.freeze(columns);
  TABLE_COLUMNS_CACHE.set(cacheKey, frozenColumns);
  return frozenColumns;
}
