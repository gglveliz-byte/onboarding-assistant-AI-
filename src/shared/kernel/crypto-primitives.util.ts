/**
 * @archivo src/shared/kernel/crypto-primitives.util.ts
 * @modulo 00-kernel (Primitivas Criptograficas y Codificadores Base62/CRC32)
 * @proposito
 *   Concentra las operaciones criptograficas de bajo nivel que consumen todos los modulos:
 *   digests SHA-256, firmas HMAC-SHA256, comparacion en tiempo constante resistente a
 *   analisis de temporizado, generacion de tokens con CSPRNG, codificacion Base62/Base64url y
 *   el checksum CRC32 que permite descartar claves de API malformadas sin tocar Redis ni la
 *   base de datos. Ninguna capa superior debe invocar `node:crypto` directamente.
 *
 * @resumen_contenido
 *   - Constantes `BASE62_ALPHABET`, `CRC32_TABLE`, `SHA256_HEX_LENGTH`.
 *   - Funcion `sha256Hex()`: Digest hexadecimal en minusculas de una cadena o Buffer.
 *   - Funciones `hmacSha256Hex()` y `hmacSha256Base64()`: Firma simetrica de webhooks y checkouts.
 *   - Funciones `timingSafeEqualHex()` y `timingSafeEqualUtf8()`: Comparacion en tiempo constante.
 *   - Funciones `generateCsprngToken()` y `generateCsprngTokenBase64Url()`: Tokens opacos.
 *   - Funciones `encodeBase62()`, `randomBase62String()` y `toBase64Url()`: Codificadores.
 *   - Funciones `computeCrc32()`, `computeCrc32Hex()` y `crc32Matches()`: Checksum de claves.
 *
 * @dependencias_internas
 *   - Ninguna (Primer eslabon del kernel; lo consumen `crypto.util.ts` y `api-key.util.ts`).
 *
 * @dependencias_externas
 *   - `node:crypto` (Unica dependencia: funciones nativas del runtime de Node.js).
 *
 * @tablas_bd_o_redis
 *   - Redis: `apikey:sha256:<hash>` (El digest de `sha256Hex()` es la clave de indice).
 *   - Redis: `whop:webhook:evt:<id>` (La firma de `hmacSha256Hex()` autentica el evento).
 */

import * as crypto from 'node:crypto';

/** Alfabeto Base62 oficial (digitos, mayusculas y minusculas) usado por las claves de API. */
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Longitud exacta de un digest SHA-256 expresado en hexadecimal (32 bytes -> 64 caracteres). */
export const SHA256_HEX_LENGTH = 64;

/** Longitud del checksum CRC32 expresado en hexadecimal (4 bytes -> 8 caracteres). */
const CRC32_HEX_LENGTH = 8;

/** Polinomio estandar IEEE 802.3 usado por el algoritmo CRC32. */
const CRC32_POLYNOMIAL = 0xedb88320;

/** Tabla de busqueda precalculada del CRC32 (256 entradas). */
const CRC32_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ CRC32_POLYNOMIAL : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * Calcula el digest SHA-256 de una entrada y lo devuelve en hexadecimal minusculas.
 *
 * @param input - Cadena UTF-8 o Buffer binario a resumir.
 * @returns Cadena hexadecimal de 64 caracteres.
 */
export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Calcula la firma HMAC-SHA256 de una carga y la devuelve en hexadecimal minusculas.
 *
 * @param secret - Secreto compartido con el emisor (webhook o checkout interno).
 * @param payload - Carga exacta recibida, sin reserializar, en cadena o Buffer.
 * @returns Firma hexadecimal de 64 caracteres.
 */
export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Calcula la firma HMAC-SHA256 de una carga y la devuelve en Base64.
 * Se usa cuando el emisor externo publica la firma en Base64 o cuando la firma viaja en
 * una cabecera que no admite caracteres no ASCII.
 *
 * @param secret - Secreto compartido con el emisor.
 * @param payload - Carga exacta recibida, sin reserializar.
 * @returns Firma codificada en Base64.
 */
export function hmacSha256Base64(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

/**
 * Compara dos cadenas hexadecimales en tiempo constante para impedir ataques de temporizado.
 * Si alguna entrada esta vacia o las longitudes difieren, devuelve `false` sin comparar.
 *
 * @param leftHex - Primera firma o digest en hexadecimal.
 * @param rightHex - Segunda firma o digest en hexadecimal.
 * @returns `true` unicamente cuando ambas cadenas son identicas.
 */
export function timingSafeEqualHex(leftHex: string, rightHex: string): boolean {
  if (leftHex.length === 0 || rightHex.length === 0 || leftHex.length !== rightHex.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Compara dos cadenas de texto en tiempo constante tras normalizarlas a UTF-8.
 * Si las longitudes difieren, compara contra si mismo para no filtrar el tamano.
 *
 * @param leftText - Primera cadena a comparar.
 * @param rightText - Segunda cadena a comparar.
 * @returns `true` unicamente cuando ambas cadenas son identicas.
 */
export function timingSafeEqualUtf8(leftText: string, rightText: string): boolean {
  const leftBuffer = Buffer.from(leftText, 'utf8');
  const rightBuffer = Buffer.from(rightText, 'utf8');
  const reference = leftBuffer.length === rightBuffer.length ? rightBuffer : leftBuffer;
  return crypto.timingSafeEqual(leftBuffer, reference) && leftBuffer.length === rightBuffer.length;
}

/**
 * Genera un token opaco con el generador de numeros aleatorios criptograficamente seguro.
 *
 * @param byteLength - Cantidad de bytes de entropia (64 bytes equivalen a 512 bits).
 * @returns Token en hexadecimal minusculas.
 */
export function generateCsprngToken(byteLength: number = 64): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Genera un token opaco codificado en Base64url, apto para cookies y encabezados.
 *
 * @param byteLength - Cantidad de bytes de entropia.
 * @returns Token en Base64url sin relleno.
 */
export function generateCsprngTokenBase64Url(byteLength: number = 64): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Devuelve un entero sin signo uniformemente distribuido en el rango [0, maxExclusive).
 * Descarta los valores del ultimo tramo incompleto para eliminar el sesgo modular.
 *
 * @param maxExclusive - Limite superior exclusivo del rango.
 * @returns Entero aleatorio en el rango solicitado.
 */
function randomIntUnbiased(maxExclusive: number): number {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  let candidate = limit;
  while (candidate >= limit) {
    candidate = crypto.randomBytes(4).readUInt32BE(0);
  }
  return candidate % maxExclusive;
}

/**
 * Convierte un Buffer binario a texto Base62 usando el alfabeto oficial.
 * La conversion es determinista y sin perdida de entropia: cada byte aporta su valor completo.
 *
 * @param input - Buffer binario a codificar.
 * @returns Cadena Base62 de longitud variable.
 */
export function encodeBase62(input: Buffer): string {
  if (input.length === 0) {
    return '';
  }

  let digits: number[] = [0];
  for (const byte of input) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const current = (digits[index] ?? 0) * 256 + carry;
      digits[index] = current % 62;
      carry = Math.floor(current / 62);
    }
    while (carry > 0) {
      digits.push(carry % 62);
      carry = Math.floor(carry / 62);
    }
  }

  let encoded = '';
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += BASE62_ALPHABET.charAt(digits[index] ?? 0);
  }
  return encoded;
}

/**
 * Genera una cadena aleatoria Base62 de longitud exacta con entropia CSPRNG.
 * Se usa para los segmentos aleatorios de las claves de API.
 *
 * @param length - Cantidad exacta de caracteres a generar.
 * @returns Cadena Base62 de la longitud solicitada.
 */
export function randomBase62String(length: number): string {
  let output = '';
  while (output.length < length) {
    output += BASE62_ALPHABET.charAt(randomIntUnbiased(BASE62_ALPHABET.length));
  }
  return output.slice(0, length);
}

/**
 * Convierte un Buffer a texto Base64url sin relleno.
 *
 * @param input - Buffer binario a codificar.
 * @returns Cadena Base64url sin caracteres `+`, `/` ni `=`.
 */
export function toBase64Url(input: Buffer): string {
  return input.toString('base64url');
}

/**
 * Calcula el checksum CRC32 de una entrada segun el polinomio IEEE 802.3.
 *
 * @param input - Cadena UTF-8 o Buffer a resumir.
 * @returns Entero sin signo de 32 bits con el checksum.
 */
export function computeCrc32(input: string | Buffer): number {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = ((crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Calcula el checksum CRC32 y lo devuelve como 8 caracteres hexadecimales en minusculas.
 *
 * @param input - Cadena UTF-8 o Buffer a resumir.
 * @returns Checksum hexadecimal de 8 caracteres.
 */
export function computeCrc32Hex(input: string | Buffer): string {
  return computeCrc32(input).toString(16).padStart(CRC32_HEX_LENGTH, '0');
}

/**
 * Verifica si un checksum hexadecimal corresponde al CRC32 de una carga dada.
 * Permite descartar claves de API malformadas antes de consultar Redis o PostgreSQL.
 *
 * @param input - Carga sobre la que se calculo el checksum.
 * @param expectedHex - Checksum hexadecimal declarado por el cliente.
 * @returns `true` cuando el checksum coincide con el calculo local.
 */
export function crc32Matches(input: string | Buffer, expectedHex: string): boolean {
  if (expectedHex.length !== CRC32_HEX_LENGTH) {
    return false;
  }
  return timingSafeEqualUtf8(computeCrc32Hex(input), expectedHex.toLowerCase());
}
