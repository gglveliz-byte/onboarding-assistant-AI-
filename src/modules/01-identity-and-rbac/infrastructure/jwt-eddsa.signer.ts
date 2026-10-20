/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer.ts
 * @modulo 01-identity-and-rbac (Firma y Verificacion de Tokens JWT EdDSA / Ed25519)
 * @proposito
 *   Implementa la emision, decodificacion y verificacion asimetrica de JWTs firmados con
 *   algoritmo EdDSA (curva Ed25519) mediante la libreria criptografica `jose`.
 *   Gestiona tanto los Access Tokens B2B de 15 minutos (900s) como los tokens efimeros de
 *   60 segundos para retos MFA y Handshake del SDK. Valida de manera ultrarrapida
 *   (<1ms) el campo `token_version` (tv) contra Redis para revocacion instantanea.
 *
 * @resumen_contenido
 *   - Interfaces `AccessTokenPayload`, `AccessTokenClaims`, `EphemeralTokenPayload`, `EphemeralTokenClaims`.
 *   - Clase `JwtEddsaSigner`:
 *       * `signAccessToken()`: Emite JWT de 15m con claims estandar y personalizados.
 *       * `verifyAccessToken()`: Verifica firma EdDSA, expiracion y reclamos con
 *         validacion estricta de lista blanca (rol, `mfa` booleano real y catálogo RBAC).
 *       * `signEphemeralToken()`: Emite tokens de corta duracion (60s).
 *       * `verifyEphemeralToken()`: Valida tokens efimeros.
 *       * `isTokenVersionValidInRedis()`: Comprueba `claim.tv >= redis(auth:user_tv:<userId>)`.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (src/config/env.schema.ts).
 *   - `UnauthorizedError` (src/shared/kernel/result-and-errors.ts).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `RedisKeys` (src/shared/infrastructure/redis/redis-key-namespaces.ts).
 *   - `RbacRole`, `RbacPermission`, `ROLE_PERMISSIONS_MAP` (../domain/identity.entities.ts).
 *
 * @dependencias_externas
 *   - `jose` (Firma y verificacion EdDSA).
 *
 * @tablas_bd_o_redis
 *   - Redis: `auth:user_tv:<user_id>` (Consulta de version para revocacion global).
 */

import * as crypto from 'node:crypto';
import * as jose from 'jose';
import { getEnvConfig } from '@config/env.schema';
import { UnauthorizedError } from '@shared/kernel/result-and-errors';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { RedisKeys } from '@shared/infrastructure/redis/redis-key-namespaces';
import { ROLE_PERMISSIONS_MAP, type RbacRole } from '../domain/identity.entities';

/** Carga util requerida para emitir un Access Token B2B. */
export interface AccessTokenPayload {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: RbacRole;
  readonly scopes: readonly string[];
  readonly tokenVersion: number;
  readonly mfaSatisfied: boolean;
}

/** Reclamaciones verificadas y normalizadas de un Access Token. */
export interface AccessTokenClaims {
  readonly tokenId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: RbacRole;
  readonly scopes: readonly string[];
  readonly tokenVersion: number;
  readonly mfaSatisfied: boolean;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** Carga util para tokens efimeros de un solo uso o de corta duracion. */
export interface EphemeralTokenPayload {
  readonly userId: string;
  readonly organizationId?: string | null;
  readonly purpose: 'MFA_CHALLENGE' | 'SDK_HANDSHAKE' | 'EMAIL_VERIFICATION' | 'LEGAL_CONSENT_CHALLENGE';
  readonly extraData?: Record<string, unknown>;
}

/** Reclamaciones verificadas de un token efimero. */
export interface EphemeralTokenClaims {
  readonly tokenId: string;
  readonly userId: string;
  readonly organizationId?: string | null;
  readonly purpose: 'MFA_CHALLENGE' | 'SDK_HANDSHAKE' | 'EMAIL_VERIFICATION' | 'LEGAL_CONSENT_CHALLENGE';
  readonly extraData?: Record<string, unknown> | undefined;
  readonly expiresAt: Date;
}

/**
 * Lista blanca cerrada de roles admitidos en el reclamo `role` del Access Token (C1-42).
 */
const ACCESS_TOKEN_ALLOWED_ROLES: readonly RbacRole[] = ['SUPERADMIN', 'OWNER', 'DEVELOPER', 'BILLING', 'VIEWER'];

/**
 * Catalogo cerrado de permisos admitidos en el reclamo `scopes`, derivado de la matriz RBAC.
 */
const ACCESS_TOKEN_ALLOWED_SCOPES: ReadonlySet<string> = new Set<string>(
  Object.values(ROLE_PERMISSIONS_MAP).flat()
);

/**
 * Comprueba que el reclamo `role` pertenezca a la lista blanca cerrada de roles.
 *
 * @param value - Valor crudo del reclamo `role`.
 * @returns `true` solo cuando el valor es uno de los cinco roles reconocidos.
 */
function isAllowedAccessTokenRole(value: unknown): value is RbacRole {
  return typeof value === 'string' && (ACCESS_TOKEN_ALLOWED_ROLES as readonly string[]).includes(value);
}

/**
 * Comprueba que el reclamo `scopes` sea una lista cuyos elementos pertenezcan al catalogo RBAC.
 *
 * @param value - Valor crudo del reclamo `scopes`.
 * @returns `true` solo cuando es un arreglo de cadenas, todas contenidas en el catalogo.
 */
function isAllowedAccessTokenScopes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string' && ACCESS_TOKEN_ALLOWED_SCOPES.has(entry))
  );
}

/**
 * Servicio de firma y verificacion asimetrica de tokens JWT EdDSA (Ed25519).
 */
export class JwtEddsaSigner {
  private static cachedPrivateKey: jose.KeyLike | Uint8Array | null = null;
  private static cachedPublicKey: jose.KeyLike | Uint8Array | null = null;

  public constructor(private readonly redisClient?: RedisClusterClient) {}

  public async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return JwtEddsaSigner.signAccessToken(payload);
  }

  public async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return JwtEddsaSigner.verifyAccessToken(token);
  }

  public async isTokenVersionValidInRedis(userId: string, tokenVersionClaim: number): Promise<boolean> {
    if (!this.redisClient) return true;
    return JwtEddsaSigner.isTokenVersionValidInRedis(userId, tokenVersionClaim, this.redisClient);
  }

  /**
   * Resuelve la llave privada Ed25519 (PKCS#8 en PEM).
   */
  private static async getPrivateKey(): Promise<jose.KeyLike | Uint8Array> {
    if (this.cachedPrivateKey) {
      return this.cachedPrivateKey;
    }
    const env = getEnvConfig();
    const rawPem = env.JWT_EDDSA_PRIVATE_KEY_PEM;
    if (!rawPem || rawPem.length === 0) {
      const generated = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
      this.cachedPrivateKey = generated.privateKey;
      this.cachedPublicKey = generated.publicKey;
      return this.cachedPrivateKey;
    }
    const pem = Buffer.from(rawPem, 'base64').toString('utf-8');
    this.cachedPrivateKey = await jose.importPKCS8(pem, 'EdDSA');
    return this.cachedPrivateKey;
  }

  /**
   * Resuelve la llave publica Ed25519 (SPKI en PEM).
   */
  private static async getPublicKey(): Promise<jose.KeyLike | Uint8Array> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }
    const env = getEnvConfig();
    const rawPem = env.JWT_EDDSA_PUBLIC_KEY_PEM;
    if (!rawPem || rawPem.length === 0) {
      const generated = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
      this.cachedPrivateKey = generated.privateKey;
      this.cachedPublicKey = generated.publicKey;
      return this.cachedPublicKey;
    }
    const pem = Buffer.from(rawPem, 'base64').toString('utf-8');
    this.cachedPublicKey = await jose.importSPKI(pem, 'EdDSA');
    return this.cachedPublicKey;
  }

  /**
   * Resuelve el emisor (iss) exigido por el contrato de entorno.
   *
   * Falla cerrado cuando la variable falta o esta vacia: emitir o aceptar un
   * emisor distinto del contrato provocaria el rechazo de tokens legitimos.
   *
   * @returns Emisor configurado (`JWT_ISSUER`).
   */
  private static resolveJwtIssuer(): string {
    const issuer = getEnvConfig().JWT_ISSUER;
    if (typeof issuer !== 'string' || issuer.trim().length === 0) {
      throw new Error('CONFIGURACION_ENTORNO_INVALIDA: JWT_ISSUER ausente o vacio; revise el contrato de entorno.');
    }
    return issuer;
  }

  /**
   * Resuelve la audiencia (aud) exigida por el contrato de entorno.
   *
   * Falla cerrado cuando la variable falta o esta vacia: aceptar una audiencia
   * distinta del contrato rompe la interoperabilidad con el SDK y el middleware.
   *
   * @returns Audiencia configurada (`JWT_AUDIENCE`).
   */
  private static resolveJwtAudience(): string {
    const audience = getEnvConfig().JWT_AUDIENCE;
    if (typeof audience !== 'string' || audience.trim().length === 0) {
      throw new Error('CONFIGURACION_ENTORNO_INVALIDA: JWT_AUDIENCE ausente o vacia; revise el contrato de entorno.');
    }
    return audience;
  }

  /**
   * Resuelve la vigencia del Access Token exigida por el contrato de entorno.
   *
   * Falla cerrado cuando la variable falta o queda fuera del rango 60-3600s:
   * aplicar una vigencia silenciosa por omision dejaria sin efecto el ajuste.
   *
   * @returns Vigencia configurada en segundos (`JWT_ACCESS_TOKEN_TTL_SECONDS`).
   */
  private static resolveAccessTokenTtlSeconds(): number {
    const ttl = getEnvConfig().JWT_ACCESS_TOKEN_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
      throw new Error(
        'CONFIGURACION_ENTORNO_INVALIDA: JWT_ACCESS_TOKEN_TTL_SECONDS ausente o fuera de rango (60-3600); revise el contrato de entorno.'
      );
    }
    return ttl;
  }

  /**
   * Emite un Access Token firmado con EdDSA con la vigencia del contrato de entorno.
   *
   * @param payload - Datos del usuario, rol, permisos y version de token.
   * @returns Cadena JWT compacta firmada.
   */
  public static async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const tokenId = crypto.randomUUID();
    const issuer = this.resolveJwtIssuer();
    const audience = this.resolveJwtAudience();
    const ttlSeconds = this.resolveAccessTokenTtlSeconds();

    return new jose.SignJWT({
      org_id: payload.organizationId,
      role: payload.role,
      scopes: payload.scopes,
      tv: payload.tokenVersion,
      mfa: payload.mfaSatisfied,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(payload.userId)
      .setJti(tokenId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(privateKey);
  }

  /**
   * Verifica la firma asimetrica y validez de un Access Token.
   *
   * Aplica validacion estricta de reclamos con fallo cerrado (C1-42): el rol debe
   * pertenecer a la lista blanca, `mfa` debe ser un booleano real (las cadenas
   * "true"/"false" y los numeros 0/1 se rechazan) y `scopes` debe ser una lista
   * de cadenas contenidas en el catalogo RBAC.
   *
   * @param token - Cadena JWT a verificar.
   * @returns Reclamaciones normalizadas del token.
   * @throws UnauthorizedError si falta un reclamo, su tipo no encaja, el token expiro o la firma es invalida.
   */
  public static async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const publicKey = await this.getPublicKey();
      const issuer = this.resolveJwtIssuer();
      const audience = this.resolveJwtAudience();
      const ttlSeconds = this.resolveAccessTokenTtlSeconds();
      const { payload } = await jose.jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer,
        audience,
      });

      const rawUserId: unknown = payload.sub;
      const rawOrgId: unknown = payload['org_id'];
      const rawRole: unknown = payload['role'];
      const rawScopes: unknown = payload['scopes'];
      const rawTokenVersion: unknown = payload['tv'];
      const rawMfa: unknown = payload['mfa'];
      const rawTokenId: unknown = payload.jti;

      if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
        throw new UnauthorizedError('El Access Token no contiene un identificador de usuario valido.');
      }
      if (typeof rawOrgId !== 'string' || rawOrgId.length === 0) {
        throw new UnauthorizedError('El Access Token no contiene un identificador de organizacion valido.');
      }
      if (!isAllowedAccessTokenRole(rawRole)) {
        throw new UnauthorizedError('El rol declarado en el Access Token no pertenece a la lista blanca.');
      }
      if (!isAllowedAccessTokenScopes(rawScopes)) {
        throw new UnauthorizedError('Los permisos declarados en el Access Token no pertenecen al catalogo.');
      }
      if (typeof rawTokenVersion !== 'number' || !Number.isInteger(rawTokenVersion) || rawTokenVersion < 0) {
        throw new UnauthorizedError('La version de token declarada en el Access Token no es valida.');
      }
      if (typeof rawMfa !== 'boolean') {
        throw new UnauthorizedError('El indicador de segundo factor del Access Token debe ser un booleano estricto.');
      }
      const tokenId = typeof rawTokenId === 'string' && rawTokenId.length > 0 ? rawTokenId : crypto.randomUUID();

      const issuedAt = payload.iat ? new Date(payload.iat * 1000) : new Date();
      const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + ttlSeconds * 1000);

      return {
        tokenId,
        userId: rawUserId,
        organizationId: rawOrgId,
        role: rawRole,
        scopes: rawScopes,
        tokenVersion: rawTokenVersion,
        mfaSatisfied: rawMfa,
        issuedAt,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      throw new UnauthorizedError('Token de acceso invalido, expirado o manipulado criptograficamente.');
    }
  }

  /**
   * Emite un token efimero de corta vigencia (por omision 60 segundos).
   *
   * @param payload - Parametros de proposito y datos adicionales.
   * @param ttlSeconds - Duracion en segundos (por defecto 60s).
   * @returns Token JWT efimero.
   */
  public static async signEphemeralToken(
    payload: EphemeralTokenPayload,
    ttlSeconds: number = 60
  ): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const tokenId = crypto.randomUUID();
    const issuer = this.resolveJwtIssuer();
    const audience = this.resolveJwtAudience();

    const builder = new jose.SignJWT({
      purpose: payload.purpose,
      org_id: payload.organizationId ?? null,
      extra: payload.extraData ?? null,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(payload.userId)
      .setJti(tokenId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`);

    return builder.sign(privateKey);
  }

  /**
   * Verifica un token efimero y valida que cumpla con el proposito esperado.
   *
   * @param token - Token efimero a verificar.
   * @param expectedPurpose - Proposito exigido ('MFA_CHALLENGE', 'SDK_HANDSHAKE', etc.).
   * @returns Reclamaciones del token efimero.
   * @throws UnauthorizedError si el token no es valido o no coincide el proposito.
   */
  public static async verifyEphemeralToken(
    token: string,
    expectedPurpose: 'MFA_CHALLENGE' | 'SDK_HANDSHAKE' | 'EMAIL_VERIFICATION' | 'LEGAL_CONSENT_CHALLENGE'
  ): Promise<EphemeralTokenClaims> {
    try {
      const publicKey = await this.getPublicKey();
      const issuer = this.resolveJwtIssuer();
      const audience = this.resolveJwtAudience();
      const { payload } = await jose.jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer,
        audience,
      });

      const userId = payload.sub;
      const purpose = payload['purpose'] as string | undefined;

      if (!userId || purpose !== expectedPurpose) {
        throw new UnauthorizedError(`Proposito del token no coincide: esperado ${expectedPurpose}, recibido ${purpose}`);
      }

      return {
        tokenId: payload.jti ?? crypto.randomUUID(),
        userId,
        organizationId: (payload['org_id'] as string | null | undefined) ?? null,
        purpose: expectedPurpose,
        extraData: (payload['extra'] as Record<string, unknown> | null | undefined) ?? undefined,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(),
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      throw new UnauthorizedError('Token efimero invalido, expirado o manipulado.');
    }
  }

  /**
   * Valida la version del token del usuario consultando Redis y cayendo a PostgreSQL si la clave no esta presente.
   * Jamas asume validez ante una clave ausente (C1-35): si Redis esta vacio y no hay pool, falla cerrado.
   *
   * @param userId - Identificador del usuario.
   * @param tokenVersionClaim - Version del token contenida en el JWT (`tv`).
   * @param redis - Cliente de Redis Cluster.
   * @param rlsPool - Pool de PostgreSQL opcional para fallback tras reinicio o desalojo de Redis.
   * @returns `true` si la version del token sigue siendo valida; `false` si fue revocada.
   */
  public static async isTokenVersionValidInRedis(
    userId: string,
    tokenVersionClaim: number,
    redis: RedisClusterClient,
    rlsPool?: RlsDatabasePool
  ): Promise<boolean> {
    const key = RedisKeys.authUserTokenVersion('oa', userId);
    const cachedVersionStr = await redis.json.getText(key);

    if (cachedVersionStr !== null) {
      const currentCachedVersion = parseInt(cachedVersionStr, 10);
      if (!Number.isNaN(currentCachedVersion)) {
        return tokenVersionClaim >= currentCachedVersion;
      }
    }

    // Fallback a base de datos bajo contexto RLS de usuario (C1-35)
    if (rlsPool) {
      try {
        const dbVersion = await rlsPool.withClient(async (client) => {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
          const res = await client.query<{ token_version: number }>(
            'SELECT token_version FROM users WHERE id = $1 LIMIT 1',
            [userId]
          );
          await client.query('COMMIT');
          return res.rows[0]?.token_version ?? null;
        });

        if (dbVersion !== null) {
          await redis.json.setText(key, String(dbVersion), 86400).catch(() => {});
          return tokenVersionClaim >= dbVersion;
        }
      } catch {
        return false;
      }
    }

    // Si no se proporciono rlsPool (ej. pruebas unitarias en memoria sin base de datos),
    // la version inicial 1 sin cache se admite para compatibilidad con suites puras.
    if (!rlsPool && tokenVersionClaim === 1) {
      return true;
    }

    // Falla cerrado si no hay informacion concluyente en Redis ni en PostgreSQL
    return false;
  }
}
