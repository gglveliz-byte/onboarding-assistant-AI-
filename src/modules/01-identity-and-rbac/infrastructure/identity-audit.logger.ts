/**
 * @archivo src/modules/01-identity-and-rbac/infrastructure/identity-audit.logger.ts
 * @modulo 01-identity-and-rbac (Bitacora de Auditoria de Autenticacion en audit_logs)
 * @proposito
 *   Cierra el hallazgo C1-38 (cero auditoria de autenticacion): provee el puerto minimo
 *   `IdentityAuditLogger` y su adaptador PostgreSQL `IdentityAuditLoggerAdapter`, que anexa
 *   eventos firmados y encadenados (hash SHA-256 por trigger de base de datos) en la tabla
 *   existente `audit_logs` para login OK/fallido, bloqueo por fuerza bruta, revocacion/logout,
 *   verificacion MFA OK/fallo, solicitud/confirmacion de restablecimiento e invitaciones.
 *   Reutiliza la tabla existente: NO requiere migracion (GEM-1 conserva esa frontera).
 *
 * @resumen_contenido
 *   - Tipos `IdentityAuditSeverity`, `IdentityAuthAuditAction`, `IdentityAuthAuditEvent`.
 *   - Interfaz `IdentityAuditLogger`: contrato minimo de emision (`recordAuthEvent`).
 *   - Clase `IdentityAuditLoggerAdapter`:
 *       * Transaccion propia con contexto RLS explicito (org/usuario/superadmin=false),
 *         bloqueo de asesoramiento `pg_advisory_xact_lock` y calculo de hash previo.
 *       * Auto-atribucion de organizacion: cuando el evento no trae org pero si actor,
 *         resuelve su primera membresia activa (lectura `user_id = current_user`, permitida
 *         por RLS) para que el rastro quede en el tenant y no como fila global.
 *       * Inserta con identificador generado en aplicacion y SIN `RETURNING`: la clausula
 *         `RETURNING` reevalua la politica SELECT y las filas globales (`org IS NULL`) son
 *         invisibles para un rol sin gobierno, lo que aborta la insercion con 42501 aunque el
 *         `WITH CHECK` la permita (medido en prueba real).
 *       * Acepta un `PoolClient` externo para heredar el contexto de una transaccion
 *         existente (atomicidad futura mutacion+auditoria sin abrir una segunda conexion).
 *       * Interruptor `setEnabled()` SOLO para la prueba de reversion (desactivar la
 *         emision demuestra que las filas provienen de este emisor); prohibido en produccion.
 *
 * @decision_auditoria_fallida
 *   El adaptador de bajo nivel FALLA CERRADO (lanza el error de persistencia). Cada caso de
 *   uso decide segun la naturaleza del evento:
 *     * Eventos de observacion (login fallido, bloqueo detectado, MFA fallido, solicitud de
 *       restablecimiento, confirmacion fallida): la auditoria es best-effort; un fallo de
 *       auditoria JAMAS oculta ni sustituye el error principal (el `UnauthorizedError` o el
 *       `false` original se conserva y propaga).
 *     * Mutaciones de seguridad (login OK, revocacion/logout, MFA OK, confirmacion de
 *       restablecimiento, creacion/aceptacion de invitacion): la operacion NO se confirma
 *       como exitosa si la auditoria critica se pierde; el error de auditoria se propaga en
 *       lugar del resultado. Las mutaciones ya aplicadas son idempotentes y reintentables
 *       (incremento de `token_version`, revocacion de sesiones, consumo de token), de modo
 *       que abortar no deja estados intermedios peligrosos: solo obliga a reintentar.
 *
 * @limite_cadena_global
 *   El hash previo se calcula sobre la ultima fila VISIBLE en el alcance del evento (las
 *   politicas SELECT ocultan filas de otros tenants y las globales al rol de aplicacion).
 *   Los eventos atribuidos a organizacion encadenan perfecto dentro de su tenant; los
 *   eventos genuinamente globales (correo desconocido, token invalido) siempre parten del
 *   genesis y pueden bifurcar la verificacion de alcance superadmin. La cadena unica
 *   global exige una funcion `SECURITY DEFINER` (propuesta exacta reportada a GEM-1).
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts) para el hash de encadenamiento.
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts) como unico acceso a PG.
 *
 * @dependencias_externas
 *   - `pg` (`PoolClient`, solo como tipo para reutilizar transacciones existentes).
 *   - `node:crypto` (generacion del identificador del registro; precedente del modulo).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (append-only; hash encadenado por trigger `trg_audit_logs_chain_sha256`).
 *   - PostgreSQL: `memberships` (solo lectura de la primera membresia del actor).
 *   - Redis: ninguna.
 */

import type { PoolClient } from 'pg';
import * as crypto from 'node:crypto';
import { CryptoUtils } from '@shared/kernel/crypto.util';
import type { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';

/** Severidad del evento de autenticacion, alineada con el CHECK de `audit_logs`. */
export type IdentityAuditSeverity = 'INFO' | 'WARN' | 'CRITICAL_SECURITY';

/**
 * Acciones de autenticacion auditables. Vocabulario cerrado: cualquier evento de
 * identidad que deba dejar rastro forense usa exactamente una de estas acciones.
 */
export type IdentityAuthAuditAction =
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'SESSION_REVOKED'
  | 'MFA_VERIFY_SUCCEEDED'
  | 'MFA_VERIFY_FAILED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_CONFIRMED'
  | 'PASSWORD_RESET_CONFIRM_FAILED'
  | 'INVITATION_CREATED'
  | 'INVITATION_ACCEPTED'
  | 'INVITATION_ACCEPT_FAILED';

/** Categoria fija de los eventos de este emisor (forense de identidad). */
export type IdentityAuditCategory = 'AUTHENTICATION' | 'SESSION' | 'MFA' | 'RECOVERY' | 'INVITATION';

/**
 * Evento de autenticacion a registrar. Nunca incluye secretos: ni contrasenas, ni tokens
 * en claro, ni hashes, ni codigos MFA; solo identificadores, IP, resultado y metadatos.
 */
export interface IdentityAuthAuditEvent {
  /** Organizacion afectada, o `null` cuando aun no se conoce (fallos previos a la resolucion). */
  readonly organizationId: string | null;
  /** Usuario actor, o `null` cuando no se pudo resolver (correo inexistente o token invalido). */
  readonly actorUserId: string | null;
  /** Rol del actor cuando se conoce (para trazar escaladas); `null` en caso contrario. */
  readonly actorRole: string | null;
  /** Categoria forense del evento. */
  readonly eventCategory: IdentityAuditCategory;
  /** Accion concreta del vocabulario cerrado. */
  readonly eventAction: IdentityAuthAuditAction;
  /** Severidad del evento. */
  readonly severity: IdentityAuditSeverity;
  /** Tipo del recurso afectado (`USER`, `ORGANIZATION`, `AUTH_SESSION`, `MFA`, `PASSWORD_RESET`, `INVITATION`). */
  readonly targetResourceType: string | null;
  /** Identificador del recurso afectado. */
  readonly targetResourceId: string | null;
  /** IP de origen cuando se conoce. */
  readonly ipAddress?: string | null;
  /** Agente de usuario cuando se conoce. */
  readonly userAgent?: string | null;
  /** Detalles serializables sin secretos (resultado, motivo, intentos, metodo MFA). */
  readonly details?: unknown;
}

/** Resultado de una emision de auditoria exitosa. */
export interface IdentityAuditRecord {
  /** Identificador del registro insertado en `audit_logs` (generado en aplicacion). */
  readonly auditLogId: string;
  /**
   * Digesto previo al trigger de la cadena (`prev + alcance + actor + evento`).
   * El trigger `trg_audit_logs_chain_sha256` recalcula `record_sha256` de forma
   * autoritativa al insertar, de modo que este valor es el candidato de aplicacion y la
   * fuente de verdad del encadenamiento es `prev_record_sha256`, que el trigger preserva.
   */
  readonly recordSha256: string;
}

/**
 * Puerto minimo de auditoria de autenticacion. Los casos de uso dependen de esta
 * interfaz y nunca del adaptador concreto, para poder sustituirlo en pruebas.
 */
export interface IdentityAuditLogger {
  /**
   * Registra un evento de autenticacion en `audit_logs`.
   *
   * @param event - Evento forense sin secretos.
   * @param client - Cliente transaccional existente (hereda su contexto RLS); si se omite
   *   se abre una transaccion propia con contexto explicito.
   * @returns Registro creado, o `null` cuando la emision esta desactivada (solo pruebas).
   */
  recordAuthEvent(event: IdentityAuthAuditEvent, client?: PoolClient): Promise<IdentityAuditRecord | null>;
}

/** Candado de asesoramiento compartido con el repositorio de gobierno (evita bifurcaciones). */
const AUDIT_CHAIN_ADVISORY_LOCK = `SELECT pg_advisory_xact_lock(hashtext('audit_logs_hash_chain'))`;

/** Hash genesis cuando la bitacora esta vacia (mismo convenio que el repositorio de gobierno). */
const AUDIT_GENESIS_HASH = '0'.repeat(64);

/**
 * Comprueba que un texto sea una direccion IP valida antes de castearlo a `inet`.
 * Evita que una IP manipulada por el cliente rompa la insercion de auditoria.
 *
 * @param value - Texto candidato a direccion IP.
 * @returns La IP normalizada, o `null` cuando no es una IP valida.
 */
function sanitizeIpAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (ipv4.test(trimmed)) {
    const octets = trimmed.split('.').map(Number);
    if (octets.every((n) => n >= 0 && n <= 255)) {
      return trimmed;
    }
    return null;
  }
  if (trimmed.includes(':') && ipv6.test(trimmed) && trimmed.length <= 45) {
    return trimmed;
  }
  return null;
}

/**
 * Adaptador PostgreSQL del puerto de auditoria de autenticacion.
 * Escribe en la tabla existente `audit_logs` con contexto RLS explicito: NUNCA usa una
 * conexion cruda sin `set_config`, de modo que la politica `rls_audit_logs_insert`
 * (`org = contexto OR org IS NULL OR superadmin`) siempre se evalua correctamente.
 */
export class IdentityAuditLoggerAdapter implements IdentityAuditLogger {
  private enabled = true;

  /**
   * Construye el adaptador sobre el pool RLS compartido.
   *
   * @param rlsPool - Unico punto autorizado de acceso a PostgreSQL.
   */
  public constructor(private readonly rlsPool: RlsDatabasePool) {}

  /**
   * Activa o desactiva la emision de eventos. SOLO para la prueba de reversion
   * (demostrar que sin emisor no aparecen filas); prohibido desactivar en produccion.
   *
   * @param flag - `true` para emitir (valor inicial), `false` para silenciar.
   */
  public setEnabled(flag: boolean): void {
    this.enabled = flag;
  }

  /**
   * Indica si la emision esta activa.
   *
   * @returns `true` cuando los eventos se persisten en `audit_logs`.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Registra el evento en `audit_logs` con hash encadenado.
   *
   * @param event - Evento forense sin secretos.
   * @param client - Transaccion existente opcional (hereda su contexto RLS).
   * @returns Registro creado, o `null` si la emision esta desactivada.
   */
  public async recordAuthEvent(event: IdentityAuthAuditEvent, client?: PoolClient): Promise<IdentityAuditRecord | null> {
    if (!this.enabled) {
      return null;
    }
    if (client) {
      return this.insertOnClient(client, event, event.organizationId);
    }
    return this.rlsPool.withClient(async (c) => {
      await c.query('BEGIN');
      try {
        // Auto-atribucion: sin organizacion explicita pero con actor conocido, el rastro
        // pertenece a su primer tenant activo en lugar de quedar como fila global.
        let effectiveOrgId = event.organizationId;
        if (!effectiveOrgId && event.actorUserId) {
          effectiveOrgId = await this.findPrimaryOrgForActor(c, event.actorUserId);
        }
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [effectiveOrgId ?? '']);
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [event.actorUserId ?? '']);
        await c.query(`SELECT set_config('app.is_superadmin', 'false', true)`);
        const record = await this.insertOnClient(c, event, effectiveOrgId);
        await c.query('COMMIT');
        return record;
      } catch (error) {
        try {
          await c.query('ROLLBACK');
        } catch {
          // La reversion fallida deja la conexion marcada; el pool la descartara al liberarla.
        }
        throw error;
      }
    });
  }

  /**
   * Resuelve la primera organizacion activa del actor para atribuirle el rastro.
   * Usa el contexto del propio actor (`user_id = current_user`), permitido por RLS.
   *
   * @param client - Cliente transaccional de la emision en curso.
   * @param actorUserId - Usuario cuyo tenant se resuelve.
   * @returns Organizacion primaria, o `null` cuando no tiene membresias activas.
   */
  private async findPrimaryOrgForActor(client: PoolClient, actorUserId: string): Promise<string | null> {
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actorUserId]);
    const res = await client.query<{ organization_id: string }>(
      `SELECT organization_id FROM memberships WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at ASC LIMIT 1`,
      [actorUserId]
    );
    return res.rows[0]?.organization_id ?? null;
  }

  /**
   * Inserta el evento asumiendo que el llamador ya fijo el contexto RLS y el candado.
   * Calcula el hash previo bajo bloqueo de asesoramiento; el trigger de base de datos
   * recalcula `record_sha256` de forma autoritativa y preserva `prev_record_sha256`.
   * No usa `RETURNING`: reevaluaria la politica SELECT y abortaria las filas globales.
   *
   * @param client - Cliente con contexto RLS ya establecido.
   * @param event - Evento forense sin secretos.
   * @param effectiveOrgId - Organizacion efectiva (explicita o auto-atribuida).
   * @returns Identificador generado y digesto candidato de la cadena.
   */
  private async insertOnClient(
    client: PoolClient,
    event: IdentityAuthAuditEvent,
    effectiveOrgId: string | null
  ): Promise<IdentityAuditRecord> {
    await client.query(AUDIT_CHAIN_ADVISORY_LOCK);
    const lastRow = await client.query<{ record_sha256: string }>(
      `SELECT record_sha256 FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1`
    );
    const prevHash = lastRow.rows[0]?.record_sha256 ?? AUDIT_GENESIS_HASH;
    const now = new Date();
    const payloadToSign =
      `${prevHash}|${effectiveOrgId ?? 'GLOBAL'}|${event.actorUserId ?? 'SYSTEM'}` +
      `|${event.eventCategory}|${event.eventAction}|${event.severity}` +
      `|${event.targetResourceId ?? ''}|${now.toISOString()}`;
    const appComputedHash = CryptoUtils.sha256Hex(payloadToSign);
    const auditLogId = crypto.randomUUID();

    await client.query(
      `INSERT INTO audit_logs (
        id, organization_id, actor_user_id, actor_role, event_category, event_action, severity,
        target_resource_type, target_resource_id, ip_address, user_agent,
        before_state_json, after_state_json,
        prev_record_sha256, record_sha256, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12, $13, $14, $15, $16)`,
      [
        auditLogId,
        effectiveOrgId,
        event.actorUserId,
        event.actorRole,
        event.eventCategory,
        event.eventAction,
        event.severity,
        event.targetResourceType,
        event.targetResourceId,
        sanitizeIpAddress(event.ipAddress ?? null),
        event.userAgent ? event.userAgent.slice(0, 500) : null,
        null,
        event.details === undefined ? null : JSON.stringify(event.details),
        prevHash,
        appComputedHash,
        now,
      ]
    );
    return { auditLogId, recordSha256: appComputedHash };
  }
}
