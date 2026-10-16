/**
 * @archivo src/shared/kernel/crypto.util.ts
 * @modulo 00-kernel (Fachada Criptografica Unica: Digest, HMAC, Contrasenas y Canonicalizacion)
 * @proposito
 *   Expone la clase `CryptoUtils` como UNICA fachada autorizada de criptografia de la
 *   plataforma. Prohibido crear funciones sueltas de hashing, hashing de contrasenas o
 *   canonicalizacion JSON en cualquier modulo: todo debe pasar por esta clase. Incorpora el
 *   piso temporal anti-enumeracion de usuarios en la verificacion de contrasenas y el hasher
 *   Argon2id con parametros OWASP, ademas de la canonicalizacion JSON RFC 8785 que garantiza
 *   que un mismo objeto produzca siempre el mismo checksum SHA-256 del Mapa Funcional RAG.
 *
 * @resumen_contenido
 *   - Interfaz `Argon2idTimingResult`: Resultado de una verificacion con su duracion real.
 *   - Funcion `canonicalizeValue()`: Serializacion determinista interna (claves ordenadas).
 *   - Clase `CryptoUtils` (estatica): `sha256Hex`, `sha256Bytes`, `hmacSha256Hex`,
 *     `hmacSha256Base64`, `timingSafeEqualHex`, `timingSafeEqualUtf8`, `generateCsprngToken`,
 *     `generateCsprngTokenBase64Url`, `randomBase62String`, `computeCrc32Hex`,
 *     `crc32Matches`, `hashPasswordArgon2id`, `verifyPasswordConstantTime`,
 *     `canonicalizeJsonRfc8785` y `computeCanonicalMapSha256`.
 *
 * @dependencias_internas
 *   - Primitivas criptograficas y codificadores (`./crypto-primitives.util.ts`).
 *
 * @dependencias_externas
 *   - `argon2` (Hashing Argon2id con binario nativo verificado en win32-x64).
 *   - `node:crypto` (Utilizado indirectamente a traves de las primitivas del kernel).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `users.password_hash` (Almacena el digest Argon2id producido aqui).
 *   - PostgreSQL: `functional_maps.canonical_sha256` (Consume `computeCanonicalMapSha256()`).
 */

import * as crypto from 'node:crypto';
import argon2 from 'argon2';
import { canonicalizeJsonRfc8785, computeCanonicalMapSha256 } from './canonical-json.util';
import {
  computeCrc32,
  computeCrc32Hex,
  crc32Matches,
  encodeBase62,
  generateCsprngToken,
  generateCsprngTokenBase64Url,
  hmacSha256Base64,
  hmacSha256Hex,
  randomBase62String,
  sha256Hex as sha256HexPrimitive,
  timingSafeEqualHex as timingSafeEqualHexPrimitive,
  timingSafeEqualUtf8 as timingSafeEqualUtf8Primitive,
} from './crypto-primitives.util';

/** Parametros oficiales de Argon2id alineados con la recomendacion OWASP (19 MiB, 2 pasadas, 1 hilo). */
export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

/** Piso temporal por omision de la verificacion de contrasenas, en milisegundos. */
export const DEFAULT_TIMING_FLOOR_MS = 350;

/** Contrasena centinela usada unicamente para precalcular el digest falso anti-enumeracion. */
const DUMMY_PASSWORD_SENTINEL = 'centinela-interna-de-temporizado-constante';

/** Resultado detallado de una verificacion de contrasena con su duracion real medida. */
export interface Argon2idTimingResult {
  /** Indica si la contrasena coincide con el digest almacenado. */
  readonly matches: boolean;
  /** Duracion total de la operacion, incluyendo el relleno hasta el piso temporal. */
  readonly durationMs: number;
  /** Indica si se aplico relleno temporal para alcanzar el piso configurado. */
  readonly paddedToFloor: boolean;
}

/**
 * Fachada criptografica unica de la plataforma.
 * Todos los metodos son estaticos y puros: no mantienen estado mutable compartido.
 */
export class CryptoUtils {
  /**
   * Calcula el digest SHA-256 en hexadecimal minusculas.
   *
   * @param input - Cadena UTF-8 o Buffer binario a resumir.
   * @returns Digest hexadecimal de 64 caracteres.
   */
  public static sha256Hex(input: string | Buffer): string {
    return sha256HexPrimitive(input);
  }

  /**
   * Calcula el digest SHA-256 como Buffer binario de 32 bytes.
   *
   * @param input - Cadena UTF-8 o Buffer binario a resumir.
   * @returns Buffer con el digest binario.
   */
  public static sha256Bytes(input: string | Buffer): Buffer {
    return crypto.createHash('sha256').update(input).digest();
  }

  /**
   * Calcula la firma HMAC-SHA256 en hexadecimal minusculas.
   *
   * @param secret - Secreto compartido con el emisor.
   * @param payload - Carga exacta recibida, sin reserializar.
   * @returns Firma hexadecimal de 64 caracteres.
   */
  public static hmacSha256Hex(secret: string, payload: string | Buffer): string {
    return hmacSha256Hex(secret, payload);
  }

  /**
   * Calcula la firma HMAC-SHA256 en Base64.
   *
   * @param secret - Secreto compartido con el emisor.
   * @param payload - Carga exacta recibida, sin reserializar.
   * @returns Firma codificada en Base64.
   */
  public static hmacSha256Base64(secret: string, payload: string | Buffer): string {
    return hmacSha256Base64(secret, payload);
  }

  /**
   * Compara dos cadenas hexadecimales en tiempo constante.
   *
   * @param leftHex - Primera firma o digest en hexadecimal.
   * @param rightHex - Segunda firma o digest en hexadecimal.
   * @returns `true` unicamente cuando ambas cadenas son identicas.
   */
  public static timingSafeEqualHex(leftHex: string, rightHex: string): boolean {
    return timingSafeEqualHexPrimitive(leftHex, rightHex);
  }

  /**
   * Compara dos cadenas de texto en tiempo constante.
   *
   * @param leftText - Primera cadena a comparar.
   * @param rightText - Segunda cadena a comparar.
   * @returns `true` unicamente cuando ambas cadenas son identicas.
   */
  public static timingSafeEqualUtf8(leftText: string, rightText: string): boolean {
    return timingSafeEqualUtf8Primitive(leftText, rightText);
  }

  /**
   * Genera un token opaco en hexadecimal con entropia CSPRNG.
   *
   * @param byteLength - Cantidad de bytes de entropia (64 equivale a 512 bits).
   * @returns Token en hexadecimal minusculas.
   */
  public static generateCsprngToken(byteLength: number = 64): string {
    return generateCsprngToken(byteLength);
  }

  /**
   * Genera un token opaco en Base64url sin relleno, apto para cookies `HttpOnly`.
   *
   * @param byteLength - Cantidad de bytes de entropia.
   * @returns Token en Base64url.
   */
  public static generateCsprngTokenBase64Url(byteLength: number = 64): string {
    return generateCsprngTokenBase64Url(byteLength);
  }

  /**
   * Genera una cadena aleatoria Base62 de longitud exacta.
   *
   * @param length - Cantidad exacta de caracteres.
   * @returns Cadena Base62 con entropia CSPRNG.
   */
  public static randomBase62String(length: number): string {
    return randomBase62String(length);
  }

  /**
   * Codifica un Buffer binario a Base62 determinista.
   *
   * @param input - Buffer binario a codificar.
   * @returns Cadena Base62.
   */
  public static encodeBase62(input: Buffer): string {
    return encodeBase62(input);
  }

  /**
   * Calcula el checksum CRC32 de una entrada como entero sin signo.
   *
   * @param input - Cadena UTF-8 o Buffer a resumir.
   * @returns Entero sin signo de 32 bits.
   */
  public static computeCrc32(input: string | Buffer): number {
    return computeCrc32(input);
  }

  /**
   * Calcula el checksum CRC32 como 8 caracteres hexadecimales.
   *
   * @param input - Cadena UTF-8 o Buffer a resumir.
   * @returns Checksum hexadecimal de 8 caracteres.
   */
  public static computeCrc32Hex(input: string | Buffer): string {
    return computeCrc32Hex(input);
  }

  /**
   * Verifica un checksum CRC32 hexadecimal contra su carga original.
   *
   * @param input - Carga sobre la que se calculo el checksum.
   * @param expectedHex - Checksum hexadecimal declarado.
   * @returns `true` cuando el checksum coincide.
   */
  public static crc32Matches(input: string | Buffer, expectedHex: string): boolean {
    return crc32Matches(input, expectedHex);
  }

  /**
   * Calcula el digest Argon2id de una contrasena con los parametros OWASP del proyecto.
   *
   * @param plainPassword - Contrasena en texto claro (jamas debe registrarse en logs).
   * @returns Digest Argon2id codificado en formato PHC.
   */
  public static async hashPasswordArgon2id(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, ARGON2ID_OPTIONS);
  }

  /**
   * Verifica una contrasena en tiempo constante garantizando un piso temporal minimo.
   * Cuando el digest almacenado es nulo (usuario inexistente o sin contrasena local), se
   * verifica contra un digest falso precalculado y se aplica el mismo relleno temporal, de
   * modo que el tiempo de respuesta no revele la existencia del usuario.
   *
   * @param storedHashOrNull - Digest Argon2id almacenado, o `null` si no existe.
   * @param plainPassword - Contrasena recibida en texto claro.
   * @param floorMs - Piso temporal minimo de la respuesta, en milisegundos.
   * @returns Resultado con la coincidencia, la duracion real y si se aplico relleno.
   */
  public static async verifyPasswordConstantTime(
    storedHashOrNull: string | null,
    plainPassword: string,
    floorMs: number = DEFAULT_TIMING_FLOOR_MS
  ): Promise<Argon2idTimingResult> {
    const startedAt = Date.now();
    let matches = false;

    if (storedHashOrNull === null || storedHashOrNull.length === 0) {
      try {
        await argon2.verify(await DummyArgon2idHashProvider.get(), plainPassword);
      } catch {
        matches = false;
      }
    } else {
      try {
        matches = await argon2.verify(storedHashOrNull, plainPassword);
      } catch {
        matches = false;
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, floorMs - elapsedMs);
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }

    return {
      matches,
      durationMs: Date.now() - startedAt,
      paddedToFloor: remainingMs > 0,
    };
  }

  /**
   * Determina si un digest almacenado corresponde a una contrasena dada, aplicando el
   * piso temporal por omision. Es la variante de conveniencia para casos de uso de login.
   *
   * @param storedHashOrNull - Digest Argon2id almacenado, o `null` si no existe.
   * @param plainPassword - Contrasena recibida en texto claro.
   * @param floorMs - Piso temporal minimo de la respuesta, en milisegundos.
   * @returns `true` unicamente cuando la contrasena coincide.
   */
  public static async verifyPasswordMatches(
    storedHashOrNull: string | null,
    plainPassword: string,
    floorMs: number = DEFAULT_TIMING_FLOOR_MS
  ): Promise<boolean> {
    const outcome = await CryptoUtils.verifyPasswordConstantTime(storedHashOrNull, plainPassword, floorMs);
    return outcome.matches;
  }

  /**
   * Serializa un objeto a JSON canonico determinista segun RFC 8785.
   *
   * @param value - Valor a canonicalizar.
   * @returns Cadena JSON canonica con claves ordenadas y sin ambiguedades.
   */
  public static canonicalizeJsonRfc8785(value: unknown): string {
    return canonicalizeJsonRfc8785(value);
  }

  /**
   * Calcula el par canonico (JSON + checksum SHA-256) que sella un Mapa Funcional inmutable.
   * Dos mapas funcionalmente identicos produciran siempre el mismo checksum, incluso si sus
   * claves fueron declaradas en orden distinto.
   *
   * @param value - Objeto del Mapa Funcional (rutas, elementos y pasos de onboarding).
   * @returns Objeto con el JSON canonico y su digest SHA-256 hexadecimal.
   */
  public static computeCanonicalMapSha256(value: unknown): { readonly canonicalJson: string; readonly sha256Hash: string } {
    return computeCanonicalMapSha256(value);
  }
}

/**
 * Proveedor perezoso del digest Argon2id falso usado para igualar el tiempo de respuesta
 * cuando el usuario no existe. Se calcula una sola vez por proceso y nunca se expone.
 * La sal se deriva de forma determinista con `scryptSync` para que el digest sea estable
 * durante toda la vida del proceso, sin consumir entropia en cada arranque.
 */
class DummyArgon2idHashProvider {
  private static cachedHash: string | undefined;

  /**
   * Devuelve el digest falso, calculandolo la primera vez que se solicita.
   *
   * @returns Digest Argon2id de la contrasena centinela, en formato PHC.
   */
  public static async get(): Promise<string> {
    if (DummyArgon2idHashProvider.cachedHash === undefined) {
      const salt = crypto.scryptSync(DUMMY_PASSWORD_SENTINEL, 'oa-timing-floor', 16, { N: 16384, r: 8, p: 1 });
      DummyArgon2idHashProvider.cachedHash = await argon2.hash(DUMMY_PASSWORD_SENTINEL, {
        ...ARGON2ID_OPTIONS,
        salt,
      });
    }
    return DummyArgon2idHashProvider.cachedHash;
  }
}

/**
 * Precalcula en segundo plano el digest Argon2id falso anti-enumeracion.
 * Cualquier fallo se ignora de forma deliberada: el peor caso es un encarecimiento del primer
 * intento de acceso, nunca un fallo de arranque del proceso.
 */
export function warmUpTimingFloorHash(): void {
  void DummyArgon2idHashProvider.get().catch(() => {
    // El calculo perezoso reintentara la construccion en la primera verificacion real.
  });
}

warmUpTimingFloorHash();
