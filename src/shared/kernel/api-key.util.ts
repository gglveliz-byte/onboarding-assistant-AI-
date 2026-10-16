/**
 * @archivo src/shared/kernel/api-key.util.ts
 * @modulo 00-kernel (Generacion, Parseo y Verificacion de Claves de API con Checksum CRC32)
 * @proposito
 *   Implementa el formato oficial de claves de API de la plataforma:
 *   `pk_live_<project_short_id>_<32 base62>_<6 crc32>` para la clave publica del SDK y
 *   `sk_live_<project_short_id>_<48 base62>_<6 crc32>` para la clave secreta de backend.
 *   El checksum CRC32 permite descartar claves malformadas de forma local, antes de calcular
 *   el SHA-256 o de consultar Redis y PostgreSQL, y su presencia facilita que los escaneres de
 *   secretos (secret scanning) detecten claves filtradas en repositorios publicos.
 *
 * @resumen_contenido
 *   - Constantes `API_KEY_TYPE_SEGMENTS`, `API_KEY_CHECKSUM_LENGTH` y `API_KEY_PATTERN`.
 *   - Tipo `ApiKeyType` (`pk` o `sk`) y `ApiKeyEnvironment` (`live` o `test`).
 *   - Interfaz `ParsedApiKey`: Descomposicion estructural de una clave recibida.
 *   - Interfaz `GeneratedApiKey`: Clave cruda mas derivados persistibles (hash, prefijo, cola).
 *   - Funcion `generateApiKeyWithChecksum()`: Fabrica de claves con entropia CSPRNG.
 *   - Funciones `computeApiKeyChecksum()`, `parseApiKey()` y `verifyApiKeyChecksum()`.
 *   - Funciones `buildApiKeyPrefix()` y `maskApiKey()`: Identificacion visual segura.
 *
 * @dependencias_internas
 *   - Primitivas criptograficas (`./crypto-primitives.util.ts`): CSPRNG, CRC32 y SHA-256.
 *
 * @dependencias_externas
 *   - Ninguna (Toda la criptografia proviene del runtime de Node.js via el kernel).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `api_keys` (`key_type`, `key_environment`, `sha256_hash`, `key_prefix`, `last_four`).
 *   - Redis: `apikey:sha256:<hash>` (Indice de cache de validacion del handshake del SDK).
 */

import { computeCrc32Hex, randomBase62String, sha256Hex, timingSafeEqualUtf8 } from './crypto-primitives.util';

/** Cantidad exacta de caracteres del checksum CRC32 embebido en cada clave. */
export const API_KEY_CHECKSUM_LENGTH = 6;

/** Longitud del identificador corto del proyecto embebido en la clave. */
export const API_KEY_PROJECT_SHORT_ID_LENGTH = 6;

/** Longitud de los primeros caracteres que se conservan visibles para identificacion. */
export const API_KEY_VISIBLE_PREFIX_LENGTH = 16;

/** Segmentos aleatorios Base62 autorizados por tipo de clave. */
export const API_KEY_TYPE_SEGMENTS: Readonly<Record<ApiKeyType, number>> = {
  pk: 32,
  sk: 48,
};

/** Tipo de clave de API: publica para el SDK (`pk`) o secreta para backend (`sk`). */
export type ApiKeyType = 'pk' | 'sk';

/** Entorno de ejecucion de la clave de API. */
export type ApiKeyEnvironment = 'live' | 'test';

/**
 * Patron estructural oficial del formato de clave:
 * `<tipo>_<entorno>_<proyecto>_<secreto base62>_<checksum crc32>`.
 * El grupo del secreto acepta el rango de longitudes validas para admitir claves historicas.
 */
export const API_KEY_PATTERN = /^(pk|sk)_(live|test)_([0-9a-z]{6})_([0-9A-Za-z]{32,48})_([0-9a-f]{6})$/u;

/** Descomposicion estructural de una clave de API recibida del cliente. */
export interface ParsedApiKey {
  /** Tipo de clave detectado: publica o secreta. */
  readonly type: ApiKeyType;
  /** Entorno declarado por la clave. */
  readonly environment: ApiKeyEnvironment;
  /** Identificador corto del proyecto embebido en la clave. */
  readonly projectShortId: string;
  /** Porcion secreta aleatoria (nunca debe registrarse en logs). */
  readonly secretSegment: string;
  /** Checksum CRC32 declarado por la propia clave. */
  readonly checksumHex: string;
  /** Carga exacta sobre la que se calcula el checksum (todo menos el checksum). */
  readonly checksumPayload: string;
  /** Prefijo visible de 16 caracteres para identificacion en paneles. */
  readonly keyPrefix: string;
  /** Ultimos cuatro caracteres de la clave, mostrados junto al prefijo. */
  readonly lastFour: string;
}

/** Resultado completo de la generacion de una clave de API. */
export interface GeneratedApiKey {
  /** Clave cruda que se entrega una unica vez al cliente (nunca se persiste). */
  readonly rawKey: string;
  /** Digest SHA-256 de la clave cruda, valor que si se persiste en base de datos. */
  readonly sha256Hash: string;
  /** Tipo de clave generada. */
  readonly type: ApiKeyType;
  /** Entorno de la clave generada. */
  readonly environment: ApiKeyEnvironment;
  /** Identificador corto del proyecto embebido. */
  readonly projectShortId: string;
  /** Prefijo visible de 16 caracteres. */
  readonly prefix: string;
  /** Ultimos cuatro caracteres de la clave. */
  readonly lastFour: string;
  /** Checksum CRC32 hexadecimal de 6 caracteres. */
  readonly crc32Hex: string;
  /** Marca temporal de generacion en formato ISO 8601. */
  readonly generatedAtIso: string;
}

/**
 * Calcula el checksum CRC32 de 6 caracteres hexadecimales correspondiente a una carga.
 *
 * @param checksumPayload - Carga exacta de la clave, excluyendo el propio checksum.
 * @returns Checksum de 6 caracteres hexadecimales en minusculas.
 */
export function computeApiKeyChecksum(checksumPayload: string): string {
  return computeCrc32Hex(checksumPayload).slice(-API_KEY_CHECKSUM_LENGTH);
}

/**
 * Construye el prefijo visible de 16 caracteres usado para identificar la clave en paneles.
 *
 * @param rawKey - Clave cruda completa.
 * @returns Prefijo visible recortado a `API_KEY_VISIBLE_PREFIX_LENGTH` caracteres.
 */
export function buildApiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_VISIBLE_PREFIX_LENGTH);
}

/**
 * Enmascara una clave para poder referenciarla en mensajes de error y bitacoras sin
 * comprometer su secreto: conserva el prefijo visible y los ultimos cuatro caracteres.
 *
 * @param rawKey - Clave cruda a enmascarar.
 * @returns Representacion enmascarada, por ejemplo `sk_live_9f8a7b_4k...a1b2c3`.
 */
export function maskApiKey(rawKey: string): string {
  if (rawKey.length <= API_KEY_VISIBLE_PREFIX_LENGTH + 4) {
    return `${rawKey.slice(0, 4)}...`;
  }
  return `${buildApiKeyPrefix(rawKey)}...${rawKey.slice(-4)}`;
}

/**
 * Genera una clave de API con checksum CRC32 y todos sus derivados persistibles.
 *
 * @param type - Tipo de clave: `pk` para el SDK publico o `sk` para backend secreto.
 * @param environment - Entorno de la clave: `live` o `test`.
 * @param projectShortId - Identificador corto del proyecto (6 caracteres alfanumericos en minusculas).
 * @returns Clave cruda mas hash SHA-256, prefijo, cola y checksum.
 * @throws Error cuando el identificador de proyecto no cumple el formato de 6 caracteres.
 */
export function generateApiKeyWithChecksum(
  type: ApiKeyType,
  environment: ApiKeyEnvironment,
  projectShortId: string
): GeneratedApiKey {
  if (!/^[0-9a-z]{6}$/u.test(projectShortId)) {
    throw new Error('FORMATO_PROYECTO_INVALIDO: el identificador corto del proyecto debe tener exactamente 6 caracteres [0-9a-z].');
  }

  const secretSegment = randomBase62String(API_KEY_TYPE_SEGMENTS[type]);
  const checksumPayload = `${type}_${environment}_${projectShortId}_${secretSegment}`;
  const crc32Hex = computeApiKeyChecksum(checksumPayload);
  const rawKey = `${checksumPayload}_${crc32Hex}`;

  return {
    rawKey,
    sha256Hash: sha256Hex(rawKey),
    type,
    environment,
    projectShortId,
    prefix: buildApiKeyPrefix(rawKey),
    lastFour: rawKey.slice(-4),
    crc32Hex,
    generatedAtIso: new Date().toISOString(),
  };
}

/**
 * Descompone estructuralmente una clave de API recibida del cliente.
 * No realiza ninguna operacion criptografica costosa: solo analiza el formato.
 *
 * @param rawKey - Clave cruda recibida en la cabecera de autorizacion.
 * @returns Descomposicion estructural de la clave, o `null` si el formato es invalido.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(rawKey);
  if (match === null) {
    return null;
  }

  const type = match[1] as ApiKeyType | undefined;
  const environment = match[2] as ApiKeyEnvironment | undefined;
  const projectShortId = match[3];
  const secretSegment = match[4];
  const checksumHex = match[5];

  if (type === undefined || environment === undefined || projectShortId === undefined || secretSegment === undefined || checksumHex === undefined) {
    return null;
  }

  if (secretSegment.length !== API_KEY_TYPE_SEGMENTS[type]) {
    return null;
  }

  return {
    type,
    environment,
    projectShortId,
    secretSegment,
    checksumHex,
    checksumPayload: `${type}_${environment}_${projectShortId}_${secretSegment}`,
    keyPrefix: buildApiKeyPrefix(rawKey),
    lastFour: rawKey.slice(-4),
  };
}

/**
 * Verifica el checksum CRC32 de una clave de API antes de cualquier consulta a Redis o
 * PostgreSQL. Es la primera linea de defensa contra claves malformadas o inventadas.
 *
 * @param rawKey - Clave cruda recibida del cliente.
 * @returns `true` unicamente cuando el formato es valido y el checksum coincide.
 */
export function verifyApiKeyChecksum(rawKey: string): boolean {
  const parsed = parseApiKey(rawKey);
  if (parsed === null) {
    return false;
  }
  return timingSafeEqualUtf8(computeApiKeyChecksum(parsed.checksumPayload), parsed.checksumHex);
}

/**
 * Fachada utilitaria agrupada de operaciones con claves de API.
 */
export const ApiKeyUtils = Object.freeze({
  generateApiKeyWithChecksum,
  parseApiKey,
  verifyApiKeyChecksum,
  computeApiKeyChecksum,
  buildApiKeyPrefix,
  maskApiKey,
  API_KEY_PATTERN,
});

