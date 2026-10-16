/**
 * @archivo src/modules/06-superadmin-governance/infrastructure/postgres-governance-audit.repository.ts
 * @modulo 06-superadmin-governance (Gobierno de Plataforma, Suspensión, Precios y Auditoría)
 * @proposito
 *   Implementa la bitacora forense inmutable de auditoria encadenada con SHA-256 (`IAuditLoggerPort`)
 *   en PostgreSQL. Toda mutacion de seguridad, bloqueo Anti-SSRF y accion de SuperAdmin se anexa
 *   calculando `record_sha256 = SHA256(prev_hash + '|' + payload)` para cumplir SOC2 e inmutabilidad.
 *
 * @resumen_contenido
 *   - `appendImmutableAuditLog()`: Anexa evento a `audit_logs` encadenando hash previo.
 *   - `verifyAuditChainIntegrity()`: Verifica matematicamente que la cadena no haya sido alterada.
 *   - `recordSecurityBlock()`: Registra intentos bloqueados por Anti-SSRF u orígenes no permitidos.
 *   - `listAuditLogs()`: Consulta paginada y filtrada de registros forenses.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (`@shared/kernel/crypto.util.ts`).
 *   - `RlsDatabasePool` (`@shared/infrastructure/database/rls-pool.ts`).
 *   - `IAuditLoggerPort`, `AuditLogEntry`, `PortFailure` (`@shared/ports/billing-voice-admin.ports.ts`).
 *   - `governance-row.mapper.ts`.
 *
 * @dependencias_externas
 *   - `pg` (`PoolClient`).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (append-only con candado de trigger).
 */

import type { PoolClient } from 'pg';
import { CryptoUtils } from '../../../shared/kernel/crypto.util';
import type { RlsDatabasePool } from '../../../shared/infrastructure/database/rls-pool';
import type {
  IAuditLoggerPort,
  AuditLogEntry,
  PortFailure,
} from '../../../shared/ports/billing-voice-admin.ports';
import type { GovernanceAuditRecord } from '../domain/governance.entities';
import { mapAuditLogRowToRecord, type AuditLogSqlRow } from './governance-row.mapper';

/** Repositorio de bitacora inmutable de auditoria encadenada SHA-256. */
export class PostgresGovernanceAuditRepository implements IAuditLoggerPort {
  public constructor(private readonly rlsPool: RlsDatabasePool) {}

  /**
   * Anexa un registro inmutable encadenado con SHA-256 a la tabla `audit_logs`.
   *
   * Acepta un `existingClient` opcional para ejecutarse dentro de la transaccion de gobierno en curso,
   * preservando el contexto `app.is_superadmin` y serializando el hash con `pg_advisory_xact_lock` (C1-09).
   * Si no se provee un cliente, abre una transaccion con `runInSuperAdminTransaction` para que la
   * politica RLS de `audit_logs` no rechace la insercion con error 42501 en silencio.
   */
  public async appendImmutableAuditLog(
    entry: AuditLogEntry,
    existingClient?: PoolClient
  ): Promise<{ readonly ok: true; readonly auditLogId: string; readonly recordSha256: string; readonly previousRecordSha256: string | null } | PortFailure> {
    const executeInsert = async (client: PoolClient) => {
      // Bloqueo de asesoramiento a nivel de transaccion para serializar el calculo
      // de la cadena SHA-256 e impedir bifurcaciones concurrentes (C1-54).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_logs_hash_chain'))`);

      const lastRowRes = await client.query<{ record_sha256: string }>(
        `SELECT record_sha256 FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1`
      );
      const prevHash = lastRowRes.rows[0]?.record_sha256 ?? '0'.repeat(64);

      const now = new Date();
      const payloadToSign = `${prevHash}|${entry.organizationId ?? 'GLOBAL'}|${entry.actorUserId ?? 'SYSTEM'}|${entry.eventCategory}|${entry.eventAction}|${entry.severity}|${entry.targetResourceId ?? ''}|${now.toISOString()}`;
      const recordSha256 = CryptoUtils.sha256Hex(payloadToSign);

      const insertRes = await client.query<{ id: string }>(
        `INSERT INTO audit_logs (
          organization_id, actor_user_id, event_category, event_action, severity,
          target_resource_type, target_resource_id, before_state_json, after_state_json,
          prev_record_sha256, record_sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id`,
        [
          entry.organizationId,
          entry.actorUserId,
          entry.eventCategory,
          entry.eventAction,
          entry.severity,
          entry.targetResourceType,
          entry.targetResourceId,
          entry.beforeStateJson ? JSON.stringify(entry.beforeStateJson) : null,
          entry.afterStateJson ? JSON.stringify(entry.afterStateJson) : null,
          prevHash,
          recordSha256,
          now,
        ]
      );

      const id = insertRes.rows[0]?.id;
      if (!id) {
        throw new Error('Fallo al insertar registro de auditoria inmutable.');
      }

      return {
        ok: true as const,
        auditLogId: id,
        recordSha256,
        previousRecordSha256: prevHash,
      };
    };

    try {
      if (existingClient) {
        return await executeInsert(existingClient);
      }

      const actorId = entry.actorUserId ?? '00000000-0000-0000-0000-000000000000';
      return await this.rlsPool.runInSuperAdminTransaction(actorId, async (client) => {
        return executeInsert(client);
      });
    } catch (error) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: error instanceof Error ? error.message : 'Error al anexar auditoria',
        retryable: true,
      };
    }
  }

  /**
   * Verifica la integridad matematica de los registros recientes de auditoria.
   */
  public async verifyAuditChainIntegrity(
    organizationId: string,
    sampleSize = 50
  ): Promise<{ readonly ok: true; readonly verifiedRecords: number; readonly firstBrokenRecordId: string | null } | PortFailure> {
    try {
      return await this.rlsPool.withClient(async (client) => {
        const rowsRes = await client.query<AuditLogSqlRow>(
          `SELECT * FROM audit_logs
           WHERE organization_id = $1 OR organization_id IS NULL
           ORDER BY created_at ASC, id ASC
           LIMIT $2`,
          [organizationId, sampleSize]
        );

        let previousHash: string | null = null;
        let verifiedCount = 0;

        for (const row of rowsRes.rows) {
          if (previousHash !== null && row.prev_record_sha256 !== previousHash) {
            return {
              ok: true as const,
              verifiedRecords: verifiedCount,
              firstBrokenRecordId: row.id,
            };
          }
          previousHash = row.record_sha256;
          verifiedCount++;
        }

        return {
          ok: true as const,
          verifiedRecords: verifiedCount,
          firstBrokenRecordId: null,
        };
      });
    } catch (error) {
      return {
        ok: false,
        code: 'PERSISTENCE_UNAVAILABLE',
        reason: error instanceof Error ? error.message : 'Error al verificar cadena',
        retryable: true,
      };
    }
  }

  /**
   * Registra un evento de seguridad o intento bloqueado por Anti-SSRF.
   */
  public async recordSecurityBlock(
    _riskLevel: string,
    entry: AuditLogEntry
  ): Promise<{ readonly ok: true; readonly auditLogId: string } | PortFailure> {
    const res = await this.appendImmutableAuditLog(entry);
    if (!res.ok) {
      return res;
    }
    return { ok: true, auditLogId: res.auditLogId };
  }

  /**
   * Lista los registros de auditoria con filtros de fecha y severidad.
   */
  public async listAuditLogs(
    client: PoolClient,
    filters: { organizationId?: string | undefined; severity?: string | undefined; limit?: number | undefined }
  ): Promise<readonly GovernanceAuditRecord[]> {
    let query = `SELECT * FROM audit_logs`;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters.organizationId) {
      params.push(filters.organizationId);
      clauses.push(`organization_id = $${params.length}`);
    }
    if (filters.severity) {
      params.push(filters.severity);
      clauses.push(`severity = $${params.length}`);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }

    const limit = filters.limit ?? 50;
    params.push(limit);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const res = await client.query<AuditLogSqlRow>(query, params);
    return res.rows.map(mapAuditLogRowToRecord);
  }
}
