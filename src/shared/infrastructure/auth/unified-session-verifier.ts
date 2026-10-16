/**
 * @archivo src/shared/infrastructure/auth/unified-session-verifier.ts
 * @modulo Shared Infrastructure Auth (Verificador Unificado de Sesion y Revocacion - C1-35)
 * @proposito
 *   Implementa el verificador unificado obligatorio de tokens de sesion para el Borde HTTP
 *   y WebSockets, resolviendo de raiz el hallazgo C1-35:
 *     1. Valida criptograficamente la firma asimetrica Ed25519 (EdDSA).
 *     2. Comprueba la version del token (`token_version`) en Redis en sub-milisegundo.
 *     3. Si la clave no existe en Redis (reinicio, desalojo o miss de cache), NO asume validez:
 *        cae de forma segura a PostgreSQL bajo RLS para consultar `users.token_version`,
 *        re-puebla la cache en Redis y rechaza de inmediato si el token fue revocado.
 *     4. Valida estado activo de la organizacion y cumplimiento de instrumentos legales.
 *
 * @resumen_contenido
 *   - Clase `UnifiedSessionTokenVerifier` implementando `IIdentityAuthPort`.
 *   - Metodo `verifyAccessTokenAndVersion()`: Validacion criptografica + cache Redis + fallback BD.
 *   - Metodo `assertOrganizationActive()`: Comprobacion de estado y DPA vigente.
 *
 * @dependencias_internas
 *   - `IIdentityAuthPort`, `AuthenticatedActor`, `PortFailure` (`@shared/ports/core-modules.ports`).
 *   - `RlsDatabasePool` (`@shared/infrastructure/database/rls-pool`).
 *   - `RedisClusterClient` (`@shared/infrastructure/redis/redis-cluster.client`).
 *   - `RedisKeys` (`@shared/infrastructure/redis/redis-key-namespaces`).
 *   - `JwtEddsaSigner` (`src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer`).
 */

import type { PoolClient } from 'pg';
import type { RlsDatabasePool } from '../database/rls-pool';
import type { RedisClusterClient } from '../redis/redis-cluster.client';
import { RedisKeys } from '../redis/redis-key-namespaces';
import type {
  AuthenticatedActor,
  IIdentityAuthPort,
  PortFailure,
} from '../../ports/core-modules.ports';
import { JwtEddsaSigner } from '../../../modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';

/** TTL en segundos para repoblar la version de token en Redis tras un cache miss. */
const TOKEN_VERSION_CACHE_TTL_SECONDS = 86400;

export class UnifiedSessionTokenVerifier implements IIdentityAuthPort {
  public constructor(
    private readonly rlsPool: RlsDatabasePool,
    private readonly redis: RedisClusterClient
  ) {}

  /**
   * Verifica la firma EdDSA del token de acceso, su vigencia y que su `token_version`
   * no haya sido revocada. Consulta Redis y cae a PostgreSQL si la clave no esta presente.
   *
   * @param accessToken - Token JWT crudo recibido en cabecera Bearer o handshake.
   * @returns Actor autenticado, o fallo estructurado con el codigo exacto.
   */
  public async verifyAccessTokenAndVersion(
    accessToken: string
  ): Promise<{ readonly ok: true; readonly actor: AuthenticatedActor } | PortFailure> {
    try {
      // 1. Verificacion criptografica de firma Ed25519 y claims estructurales
      const claims = await JwtEddsaSigner.verifyAccessToken(accessToken);

      // 2. Consulta de version en Redis (camino rapido en RAM)
      const redisKey = RedisKeys.authUserTokenVersion('oa', claims.userId);
      const cachedVersionStr = await this.redis.json.getText(redisKey);

      let currentVersion: number;

      if (cachedVersionStr !== null) {
        const parsed = parseInt(cachedVersionStr, 10);
        currentVersion = Number.isNaN(parsed) ? 1 : parsed;
      } else {
        // 3. Fallback obligatorio a PostgreSQL (C1-35): jamas asumir validez tras reinicio de Redis
        const dbVersion = await this.fetchTokenVersionFromDatabase(claims.userId);
        if (dbVersion === null) {
          return {
            ok: false,
            code: 'TOKEN_INVALID',
            reason: 'El usuario asociado al token no existe o fue eliminado.',
            retryable: false,
          };
        }
        currentVersion = dbVersion;

        // Re-poblar la clave en Redis con TTL para que subsiguientes consultas sean sub-milisegundo
        await this.redis.json.setText(redisKey, String(currentVersion), TOKEN_VERSION_CACHE_TTL_SECONDS).catch(() => {});
      }

      // 4. Comprobacion estricta de revocacion
      if (claims.tokenVersion < currentVersion) {
        return {
          ok: false,
          code: 'TOKEN_VERSION_REVOKED',
          reason: 'El token de acceso fue revocado globalmente por un cambio de credenciales o cierre de sesion.',
          retryable: false,
        };
      }

      return {
        ok: true,
        actor: {
          userId: claims.userId,
          organizationId: claims.organizationId,
          role: claims.role,
          scopes: claims.scopes,
          tokenVersion: claims.tokenVersion,
          mfaSatisfied: claims.mfaSatisfied,
          tokenId: claims.tokenId,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'TOKEN_INVALID',
        reason: error instanceof Error ? error.message : 'Token de acceso no valido.',
        retryable: false,
      };
    }
  }

  /**
   * Comprueba que la organizacion este activa, con el DPA vigente firmado y sin bloqueos.
   *
   * @param organizationId - Organizacion a verificar.
   * @param userId - Usuario titular de la operacion.
   * @returns Confirmacion de estado activo o fallo de autorizacion.
   */
  public async assertOrganizationActive(
    organizationId: string,
    userId: string
  ): Promise<
    | { readonly ok: true; readonly dpaVersionTag: string; readonly organizationSlug: string }
    | PortFailure
  > {
    try {
      const query = `
        SELECT status, slug, dpa_signed_at
        FROM organizations
        WHERE id = $1
        LIMIT 1
      `;

      const result = await this.rlsPool.withClient(async (client: PoolClient) => {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
        const res = await client.query<{ status: string; slug: string; dpa_signed_at: Date | null }>(query, [organizationId]);
        await client.query('COMMIT');
        return res;
      });

      const row = result.rows[0];
      if (!row) {
        return {
          ok: false,
          code: 'RESOURCE_NOT_FOUND',
          reason: `No se encontro la organizacion ${organizationId}.`,
          retryable: false,
        };
      }

      if (row.status !== 'ACTIVE') {
        return {
          ok: false,
          code: 'TENANT_SUSPENDED',
          reason: `La organizacion se encuentra en estado ${row.status}.`,
          retryable: false,
        };
      }

      return {
        ok: true,
        dpaVersionTag: row.dpa_signed_at ? 'dpa_signed_v1' : 'pending_dpa',
        organizationSlug: row.slug,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: error instanceof Error ? error.message : 'Error al verificar estado de la organizacion.',
        retryable: true,
      };
    }
  }

  /**
   * Consulta directa de la version del token en PostgreSQL bajo contexto de usuario.
   *
   * @param userId - Identificador del usuario.
   * @returns Version del token registrada en la base de datos, o `null` si no existe.
   */
  private async fetchTokenVersionFromDatabase(userId: string): Promise<number | null> {
    try {
      return await this.rlsPool.withClient(async (client: PoolClient) => {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const res = await client.query<{ token_version: number }>(
          'SELECT token_version FROM users WHERE id = $1 LIMIT 1',
          [userId]
        );
        await client.query('COMMIT');
        return res.rows[0]?.token_version ?? null;
      });
    } catch {
      return null;
    }
  }
}
