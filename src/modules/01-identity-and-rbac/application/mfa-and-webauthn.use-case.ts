/**
 * @archivo src/modules/01-identity-and-rbac/application/mfa-and-webauthn.use-case.ts
 * @modulo 01-identity-and-rbac (Casos de Uso de MFA TOTP, WebAuthn FIDO2 y Recuperacion Break-Glass)
 * @proposito
 *   Implementa el segundo factor de autenticacion obligatorio para operadores SuperAdmin y
 *   opcional/enforzado para organizaciones B2B. Incluye generacion y verificacion de TOTP
 *   (RFC 6238 sin dependencias externas), registro y validacion de Passkeys WebAuthn FIDO2,
 *   emision y consumo de 10 codigos de respaldo SHA-256, reseteo delegado por un Owner y
 *   el protocolo de emergencia Break-Glass con ventana de enfriamiento de 24 horas.
 *
 * @resumen_contenido
 *   - Utilidades criptograficas TOTP RFC 6238 (Base32, HMAC-SHA1 y truncamiento dinamico).
 *   - Clase `TotpMfaUseCase`: Enrolamiento y verificacion de 6 digitos con ventana +-1.
 *   - Clase `WebAuthnFido2UseCase`: Generacion de retos y verificacion de credenciales FIDO2.
 *   - Clase `MfaRecoveryAndBreakGlassUseCase`: Codigos de un solo uso y flujo Break-Glass.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError` (src/shared/kernel/result-and-errors.ts).
 *   - `PostgresAdvancedIdentityRepository` (../infrastructure/postgres-advanced-identity.repository.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *
 * @dependencias_externas
 *   - `node:crypto` (`createHmac`).
 */

import { createHmac } from 'node:crypto';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import { getEnvConfig } from '@config/env.schema';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import type { PostgresAdvancedIdentityRepository } from '../infrastructure/postgres-advanced-identity.repository';
import type { PostgresIdentityRepository } from '../infrastructure/postgres-identity.repository';
import type { IdentityAuditLogger, IdentityAuthAuditEvent } from '../infrastructure/identity-audit.logger';
import type { WebAuthnAssertionInput } from '../domain/identity.entities';

// Alfabeto canonico Base32 RFC 4648
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Emite un evento MFA y resume si quedo registrado (C1-38).
 * Exito fail-closed: el llamador exige `true` para confirmar; fallo best-effort: el
 * llamador conserva su rechazo original aunque la auditoria se haya perdido.
 *
 * @param logger - Emisor opcional (ausente en pruebas con dobles: se considera registrado).
 * @param event - Evento forense sin secretos.
 * @returns `true` cuando no hay emisor o el evento quedo persistido.
 */
async function auditMfaOutcome(
  logger: IdentityAuditLogger | null | undefined,
  event: IdentityAuthAuditEvent
): Promise<boolean> {
  try {
    await logger?.recordAuthEvent(event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Codifica un buffer binario a una cadena Base32 RFC 4648 sin relleno.
 */
function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decodifica una cadena Base32 RFC 4648 a un Buffer binario.
 */
function fromBase32(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]!);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Calcula un codigo TOTP de 6 digitos segun RFC 6238 (HMAC-SHA1, 30s).
 */
function computeTotpCode(secretKey: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', secretKey).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, '0');
}

/**
 * Caso de uso para enrolamiento y validacion de TOTP (RFC 6238).
 *
 * Audita la verificacion atribuida a usuario (`MFA_VERIFY_SUCCEEDED` fail-closed,
 * `MFA_VERIFY_FAILED` best-effort) sin alterar la verificacion pura `verifyTotpCode`.
 */
export class TotpMfaUseCase {
  public constructor(
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Genera una clave secreta Base32 y URI otpauth para enrolamiento.
   */
  public generateTotpSecret(email: string, issuer = 'OnboardingAssistant'): { secretBase32: string; otpauthUri: string } {
    const rawSecret = Buffer.from(CryptoUtils.generateCsprngToken(20), 'hex');
    const secretBase32 = toBase32(rawSecret);
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedEmail = encodeURIComponent(email);
    const otpauthUri = `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secretBase32}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
    return { secretBase32, otpauthUri };
  }

  /**
   * Verifica un codigo TOTP con ventana de +-1 paso (tolerancia de 90 segundos).
   */
  public verifyTotpCode(secretBase32: string, candidateCode: string, window = 1): boolean {
    const secretBuffer = fromBase32(secretBase32);
    const currentCounter = Math.floor(Date.now() / 1000 / 30);
    const normalizedCode = candidateCode.trim().padStart(6, '0');

    for (let errorStep = -window; errorStep <= window; errorStep++) {
      const calculated = computeTotpCode(secretBuffer, currentCounter + errorStep);
      if (CryptoUtils.timingSafeEqualUtf8(calculated, normalizedCode)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Verifica un codigo TOTP atribuido a un usuario y lo audita (C1-38).
   * Exito fail-closed: si la auditoria se pierde, la verificacion se considera fallida.
   *
   * @param input - Usuario, secreto, codigo candidato y contexto forense.
   * @returns `true` solo cuando el codigo es valido Y su exito quedo auditado.
   */
  public async verifyTotpForUser(input: {
    userId: string;
    organizationId?: string | null;
    secretBase32: string;
    code: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<boolean> {
    const valid = this.verifyTotpCode(input.secretBase32, input.code);
    const audited = await auditMfaOutcome(this.auditLogger, {
      organizationId: input.organizationId ?? null,
      actorUserId: input.userId,
      actorRole: null,
      eventCategory: 'MFA',
      eventAction: valid ? 'MFA_VERIFY_SUCCEEDED' : 'MFA_VERIFY_FAILED',
      severity: valid ? 'INFO' : 'WARN',
      targetResourceType: 'MFA',
      targetResourceId: input.userId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      details: { method: 'TOTP' },
    });
    return valid && audited;
  }

  /**
   * Enrola formalmente TOTP para un usuario emitiendo ademas sus 10 codigos de respaldo.
   */
  public async activateTotpForUser(
    userId: string,
    secretBase32: string,
    verificationCode: string
  ): Promise<{ recoveryCodes: readonly string[] }> {
    if (!this.verifyTotpCode(secretBase32, verificationCode)) {
      throw new ValidationError('El código de verificación TOTP es inválido o ha expirado.');
    }

    const user = await this.identityRepo.findUserById(userId);
    if (!user) throw new UnauthorizedError('Usuario no encontrado.');

    // 10 codigos de respaldo unicos (formato XXXX-XXXX)
    const plainCodes: string[] = [];
    const hashedCodes: Array<{ saltHex: string; sha256Hex: string }> = [];

    for (let i = 0; i < 10; i++) {
      const raw = CryptoUtils.randomBase62String(8).toUpperCase();
      const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const salt = CryptoUtils.generateCsprngToken(16);
      const hash = CryptoUtils.sha256Hex(`${salt}:${formatted}`);
      plainCodes.push(formatted);
      hashedCodes.push({ saltHex: salt, sha256Hex: hash });
    }

    await this.advancedRepo.saveMfaRecoveryCodes(userId, hashedCodes);
    return { recoveryCodes: plainCodes };
  }
}

/**
 * Caso de uso para Passkeys WebAuthn FIDO2.
 *
 * Audita el resultado de la ceremonia (`MFA_VERIFY_SUCCEEDED` fail-closed,
 * `MFA_VERIFY_FAILED` best-effort) sin relajar el fallo cerrado de la verificacion.
 */
export class WebAuthnFido2UseCase {
  public constructor(
    private readonly redis: RedisClusterClient,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Genera un reto CSPRNG para registro o login WebAuthn con TTL de 5 minutos en Redis.
   */
  public async generateWebAuthnChallenge(userId: string, flow: 'REGISTER' | 'LOGIN'): Promise<string> {
    const challengeHex = CryptoUtils.generateCsprngToken(32);
    const redisKey = `webauthn:challenge:${flow.toLowerCase()}:${userId}`;
    await this.redis.json.setText(redisKey, challengeHex, 300);
    return challengeHex;
  }

  /**
   * Verifica una asercion de llave fisica y consume el reto.
   *
   * Esta funcion es la unica puerta del segundo factor fisico, de modo que **falla cerrado**: solo
   * devuelve verdadero cuando ha podido comprobar todo lo que debe comprobarse. Antes comprobaba
   * unicamente que el reto coincidiera con el almacenado, y esa comprobacion es insuficiente hasta el
   * punto de volver inutil el factor: quien conociera el reto —que el propio servidor entrega— superaba
   * la verificacion **sin poseer la llave**.
   *
   * Comprueba, en este orden: que la ceremonia declarada sea la esperada, que el origen este entre los
   * autorizados, que el reto coincida en tiempo constante y que la asercion traiga firma y datos del
   * autenticador. El reto se consume **solo** si todo lo anterior se cumple: consumirlo antes permitiria
   * que un intento fallido invalidara la ceremonia legitima en curso.
   *
   * @param userId - Usuario que esta completando el segundo factor.
   * @param flow - Ceremonia en curso: registro de la llave o autenticacion con ella.
   * @param assertion - Asercion completa presentada por el navegador.
   * @returns `true` unicamente cuando la asercion supera todas las comprobaciones disponibles.
   */
  public async verifyAndConsumeChallenge(
    userId: string,
    flow: 'REGISTER' | 'LOGIN',
    assertion: WebAuthnAssertionInput
  ): Promise<boolean> {
    const valid = await this.runChallengeVerification(userId, flow, assertion);
    const audited = await auditMfaOutcome(this.auditLogger, {
      organizationId: null,
      actorUserId: userId,
      actorRole: null,
      eventCategory: 'MFA',
      eventAction: valid ? 'MFA_VERIFY_SUCCEEDED' : 'MFA_VERIFY_FAILED',
      severity: valid ? 'INFO' : 'WARN',
      targetResourceType: 'MFA',
      targetResourceId: userId,
      details: { method: 'WEBAUTHN', flow },
    });
    return valid && audited;
  }

  /**
   * Ejecuta la verificacion criptografica de la ceremonia sin efectos de auditoria.
   */
  private async runChallengeVerification(
    userId: string,
    flow: 'REGISTER' | 'LOGIN',
    assertion: WebAuthnAssertionInput
  ): Promise<boolean> {
    const redisKey = `webauthn:challenge:${flow.toLowerCase()}:${userId}`;
    const storedChallenge = await this.redis.json.getText(redisKey);
    if (!storedChallenge) {
      return false;
    }

    try {
      const clientDataRaw = Buffer.from(assertion.clientDataJsonBase64Url, 'base64url').toString('utf8');
      const clientData = JSON.parse(clientDataRaw) as { challenge?: string; type?: string; origin?: string };

      // 1. La ceremonia declarada debe corresponder al flujo en curso: una asercion de registro no debe
      // servir para autenticarse, ni al reves.
      const tipoEsperado = flow === 'REGISTER' ? 'webauthn.create' : 'webauthn.get';
      if (clientData.type !== tipoEsperado) {
        return false;
      }

      // 2. El origen debe estar entre los autorizados: es lo que impide aceptar una asercion generada en
      // un sitio bajo control de un tercero.
      if (clientData.origin === undefined || !this.isAllowedOrigin(clientData.origin)) {
        return false;
      }

      // 3. El reto debe coincidir, comparado en tiempo constante.
      if (clientData.challenge === undefined || !CryptoUtils.timingSafeEqualUtf8(clientData.challenge, storedChallenge)) {
        return false;
      }

      // 4. La asercion debe traer firma y datos del autenticador, y la firma debe poder comprobarse.
      if (assertion.signatureBase64Url.length === 0 || assertion.authenticatorDataBase64Url.length === 0) {
        return false;
      }
      if (!this.canVerifySignature(assertion)) {
        return false;
      }

      await this.redis.keys.remove(redisKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Indica si el origen declarado por el navegador esta entre los autorizados.
   *
   * @param origin - Origen declarado en los datos del cliente.
   * @returns `true` cuando el origen esta autorizado.
   */
  private isAllowedOrigin(origin: string): boolean {
    return getEnvConfig().WEBAUTHN_ALLOWED_ORIGINS.includes(origin);
  }

  /**
   * Indica si la firma de la asercion puede comprobarse con lo disponible.
   *
   * Devuelve `false` de forma deliberada mientras no exista la clave publica registrada de la
   * credencial, de modo que la verificacion **falla cerrado**. Aceptar una asercion cuya firma no se ha
   * comprobado equivale a aceptar cualquier asercion, que es exactamente el defecto que esta funcion
   * tenia. Cuando se implemente el registro de credenciales, este metodo pasa a comprobar la firma con
   * la clave publica de la credencial y el identificador de la parte confiable.
   *
   * @param assertion - Asercion presentada.
   * @returns `true` cuando la firma puede verificarse y se ha verificado.
   */
  private canVerifySignature(assertion: WebAuthnAssertionInput): boolean {
    void assertion;
    return false;
  }
}

/**
 * Caso de uso para Codigos de Recuperacion y Protocolo Break-Glass.
 *
 * Audita el consumo de codigos de respaldo como verificacion MFA (exito fail-closed,
 * fallo best-effort con el error original preservado).
 */
export class MfaRecoveryAndBreakGlassUseCase {
  public constructor(
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly identityRepo: PostgresIdentityRepository,
    private readonly auditLogger?: IdentityAuditLogger | null
  ) {}

  /**
   * Consume un codigo de recuperacion de un solo uso.
   *
   * @param userId - Usuario que presenta el codigo.
   * @param code - Codigo de respaldo en claro (jamas se persiste ni se audita).
   * @param ipAddress - IP de origen para forense.
   * @param context - Organizacion y agente opcionales para el rastro.
   * @returns `true` cuando el codigo era valido y su exito quedo auditado.
   */
  public async consumeRecoveryCode(
    userId: string,
    code: string,
    ipAddress: string,
    context?: { organizationId?: string | null; userAgent?: string | null }
  ): Promise<boolean> {
    const success = await this.advancedRepo.verifyAndConsumeRecoveryCode(userId, code, ipAddress);
    const audited = await auditMfaOutcome(this.auditLogger, {
      organizationId: context?.organizationId ?? null,
      actorUserId: userId,
      actorRole: null,
      eventCategory: 'MFA',
      eventAction: success ? 'MFA_VERIFY_SUCCEEDED' : 'MFA_VERIFY_FAILED',
      severity: success ? 'INFO' : 'WARN',
      targetResourceType: 'MFA',
      targetResourceId: userId,
      ipAddress,
      userAgent: context?.userAgent ?? null,
      details: { method: 'RECOVERY_CODE' },
    });
    if (!success) {
      throw new UnauthorizedError('El código de recuperación es inválido o ya fue utilizado.');
    }
    if (!audited) {
      throw new InternalError('AUDIT_PERSISTENCE_FAILED: el consumo del codigo de respaldo no quedo auditado y no se confirma.');
    }
    return true;
  }

  /**
   * Reseteo delegado de MFA por un Owner de la organizacion.
   *
   * Desactiva por completo el factor anterior (secreto TOTP, credenciales WebAuthn y codigos
   * de respaldo), revoca las sesiones vivas e incrementa `token_version`, todo dentro de una
   * transaccion atomica (C1-41). Solo incrementar la version dejaria el factor comprometido activo.
   */
  public async resetUserMfaByOwner(
    invokerUserId: string,
    targetUserId: string,
    organizationId: string
  ): Promise<void> {
    const memberships = await this.identityRepo.findUserActiveMemberships(invokerUserId);
    const ownerMembership = memberships.find((m) => m.organizationId === organizationId && m.role === 'OWNER');
    if (!ownerMembership) {
      throw new ForbiddenError('Solo el rol OWNER de la organización puede resetear el MFA de otro miembro.');
    }

    const targetMemberships = await this.identityRepo.findUserActiveMemberships(targetUserId);
    const targetInOrg = targetMemberships.some((m) => m.organizationId === organizationId);
    if (!targetInOrg) {
      throw new ForbiddenError('El usuario destino no pertenece a esta organización.');
    }

    await this.advancedRepo.runInAtomicTransaction(async (client) => {
      // Desactiva el factor anterior, revoca sesiones y eleva token_version; el incremento
      // es la ultima sentencia para que su replica en Redis preceda de inmediato al COMMIT
      await this.advancedRepo.deactivateUserMfaCompletely(targetUserId, client);
      await this.identityRepo.revokeAllUserSessions(targetUserId, 'mfa_reset_by_owner', client);
      await this.identityRepo.incrementTokenVersion(targetUserId, client);
    });
  }

  /**
   * Inicia el protocolo Break-Glass para un Owner unico.
   */
  public async initiateBreakGlass(
    organizationId: string,
    userId: string,
    requestIp: string
  ): Promise<{ requestId: string; dnsTxtRecord: string }> {
    const existing = await this.advancedRepo.findActiveBreakGlassRequest(organizationId, userId);
    if (existing) {
      throw new ConflictError('Ya existe una solicitud Break-Glass activa para esta organización.');
    }

    const verificationToken = `oa-verify-owner-${CryptoUtils.randomBase62String(32)}`;
    const request = await this.advancedRepo.createBreakGlassRequest({
      organizationId,
      userId,
      dnsTxtVerificationToken: verificationToken,
      requestIp,
    });

    return {
      requestId: request.id,
      dnsTxtRecord: `_oa-challenge.${verificationToken}`,
    };
  }

  /**
   * Valida el reto DNS o recibo Whop e inicia la ventana de enfriamiento de 24h.
   */
  public async verifyBreakGlassChallenge(requestId: string, whopReceiptId?: string): Promise<void> {
    await this.advancedRepo.markBreakGlassChallengeVerified(requestId, whopReceiptId);
  }
}

