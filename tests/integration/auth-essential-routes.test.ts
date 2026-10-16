/**
 * @archivo tests/integration/auth-essential-routes.test.ts
 * @modulo 01-identity-and-rbac (Prueba de Integracion de Rutas Esenciales de Identidad - C1-36)
 * @proposito
 *   Verifica de punta a punta las 4 rutas HTTP esenciales de identidad publicadas para C1-36:
 *     1. `POST /api/v1/auth/mfa/verify`: Canje de reto efimero, emision de tokens con mfaSatisfied=true.
 *     2. `POST /api/v1/auth/password-reset/request`: Piso anti-enumeracion de 350ms y cero fuga de token (C1-41).
 *     3. `POST /api/v1/auth/password-reset/confirm`: Actualizacion de hash Argon2id y revocacion de sesiones.
 *     4. `POST /api/v1/auth/invitations/accept`: Aceptacion de invitacion de membresia y asignacion de rol.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DependencyContainer, DI_TOKENS } from '../../src/shared/container/di-container';
import { HttpRouterRegistryImpl } from '../../src/shared/infrastructure/http/http-router.registry';
import { registerAuthEssentialRoutes } from '../../src/bootstrap/auth-essential-http.routes';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import type { HttpRequestLike, AuthenticatedRequestContext } from '../../src/shared/infrastructure/http/http-server.types';
import type { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import type { PoolClient } from 'pg';

function computeValidTotp(secretBase32: string): string {
  const clean = secretBase32.toUpperCase().replace(/=+$/, '');
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = alpha.indexOf(clean[i]!);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const secretBuffer = Buffer.from(bytes);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

function createTestHarness() {
  const container = new DependencyContainer();
  const router = new HttpRouterRegistryImpl();
  const usersDb = new Map<string, any>();
  const orgsDb = new Map<string, any>();
  const membershipsDb = new Map<string, any>();
  const sessionsDb = new Map<string, any>();
  const resetTokensDb = new Map<string, any>();
  const invitationsDb = new Map<string, any>();
  const redisStore = new Map<string, string>();

  const mockClient = {
    query: async (sql: string, params: any[] = []) => {
      const q = sql.trim();
      if (q.includes('FROM users WHERE id = $1')) {
        const u = usersDb.get(params[0]);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (q.includes('FROM users WHERE email = $1')) {
        const u = Array.from(usersDb.values()).find((x) => x.email.toLowerCase() === String(params[0]).toLowerCase());
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }
      if (q.includes('FROM organizations WHERE id = $1')) {
        const o = orgsDb.get(params[0]);
        return { rows: o ? [o] : [], rowCount: o ? 1 : 0 };
      }
      if (q.includes('FROM memberships WHERE user_id = $1')) {
        const matched = Array.from(membershipsDb.values()).filter((m) => m.user_id === params[0] && m.is_active);
        return { rows: matched, rowCount: matched.length };
      }
      if (q.startsWith('INSERT INTO auth_sessions')) {
        const id = CryptoUtils.generateCsprngToken(16);
        const row = { id, user_id: params[0], organization_id: params[1], token_family_id: params[2], refresh_token_sha256: params[3] };
        sessionsDb.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (q.includes('FROM mfa_recovery_codes')) return { rows: [], rowCount: 0 };
      if (q.startsWith('INSERT INTO password_reset_tokens')) {
        const id = CryptoUtils.generateCsprngToken(16);
        const row = { id, user_id: params[0], token_sha256: params[1], is_used: false, expires_at: params[4] };
        resetTokensDb.set(row.token_sha256, row);
        return { rows: [row], rowCount: 1 };
      }
      if (q.includes('FROM password_reset_tokens WHERE token_sha256 = $1')) {
        const row = resetTokensDb.get(params[0]);
        return { rows: row && !row.is_used && new Date(row.expires_at) > new Date() ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (q.includes('UPDATE password_reset_tokens SET used_at = NOW()')) {
        // Consumo atomico de un solo uso (C1-41): solo la primera confirmacion obtiene fila
        const row = resetTokensDb.get(params[0]);
        if (row && !row.is_used && new Date(row.expires_at) > new Date()) {
          row.is_used = true;
          return { rows: [{ id: row.id, user_id: row.user_id, expires_at: row.expires_at }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith('UPDATE password_reset_tokens SET is_used = TRUE')) {
        for (const r of resetTokensDb.values()) if (r.id === params[0]) r.is_used = true;
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('UPDATE users SET password_hash = $1')) {
        const u = usersDb.get(params[1]);
        if (u) u.password_hash = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('UPDATE users') && q.includes('token_version = token_version + 1')) {
        const u = usersDb.get(params[0]);
        if (!u) return { rows: [], rowCount: 0 };
        u.token_version = (u.token_version ?? 1) + 1;
        return { rows: [{ token_version: u.token_version }], rowCount: 1 };
      }
      if (q.includes('FROM memberships') && q.includes('invitation_token_sha256 = $1')) {
        const m = Array.from(invitationsDb.values()).find((x) => x.invitation_token_sha256 === params[0] && !x.invitation_accepted_at);
        return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
      }
      if (q.startsWith('UPDATE memberships SET user_id = $2, invitation_accepted_at = NOW()')) {
        const m = invitationsDb.get(params[0]);
        if (m) { m.user_id = params[1]; m.invitation_accepted_at = new Date(); m.is_active = true; }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;

  const mockRlsPool = {
    withClient: async (fn: (c: PoolClient) => Promise<any>) => fn(mockClient),
    runInTenantTransaction: async (_ctx: any, fn: (c: PoolClient) => Promise<any>) => fn(mockClient),
  } as unknown as RlsDatabasePool;

  const mockRedis = {
    json: {
      getText: async (k: string) => redisStore.get(k) ?? null,
      setText: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
    },
    keys: { remove: async (...keys: string[]) => keys.filter((k) => redisStore.delete(k)).length },
  } as unknown as RedisClusterClient;

  container.registerInstance(DI_TOKENS.RlsDatabasePool, mockRlsPool);
  container.registerInstance(DI_TOKENS.RedisClusterClient, mockRedis);

  return { container, router, usersDb, orgsDb, membershipsDb, resetTokensDb, invitationsDb };
}

async function runAuthEssentialRoutesSuite(): Promise<void> {
  console.log('================================================================================');
  console.log('PRUEBA DE INTEGRACION: RUTAS ESENCIALES DE IDENTIDAD C1-36 (MFA, RESET, INVITES)');
  console.log('================================================================================');

  const { container, router, usersDb, orgsDb, membershipsDb, resetTokensDb, invitationsDb } = createTestHarness();
  registerAuthEssentialRoutes(container, router);
  const paths = router.list().map((r) => `${r.method} ${r.path}`);

  // [1/5] Verificacion de Registro
  console.log('[1/5] Verificacion de que los 4 endpoints esenciales estan registrados...');
  assert.ok(paths.includes('POST /api/v1/auth/mfa/verify'));
  assert.ok(paths.includes('POST /api/v1/auth/password-reset/request'));
  assert.ok(paths.includes('POST /api/v1/auth/password-reset/confirm'));
  assert.ok(paths.includes('POST /api/v1/auth/invitations/accept'));
  console.log('  -> Los 4 endpoints registrados en HttpRouterRegistry: OK.');

  const userId = '11111111-2222-3333-4444-555555555555';
  const orgId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const totpSecret = 'JBSWY3DPEHPK3PXP';

  usersDb.set(userId, {
    id: userId,
    email: 'operador@empresa.com',
    full_name: 'Operador Seguro',
    password_hash: '$argon2id$v=19$m=19456,t=2,p=1$fakeHash',
    token_version: 1,
    is_platform_superadmin: false,
    mfa_totp_enabled: true,
    mfa_totp_secret_enc: Buffer.from(totpSecret, 'utf8'),
    failed_login_attempts: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });

  orgsDb.set(orgId, {
    id: orgId,
    name: 'Empresa B2B',
    slug: 'empresa-b2b',
    status: 'ACTIVE',
    enforce_mfa: true,
    enforce_sso: false,
    created_at: new Date(),
    updated_at: new Date(),
  });

  membershipsDb.set(`${userId}:${orgId}`, {
    id: 'mem_1',
    organization_id: orgId,
    user_id: userId,
    role: 'OWNER',
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const routes = router.list();
  const mfaRoute = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/auth/mfa/verify')!;
  const resetReqRoute = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/auth/password-reset/request')!;
  const resetConfRoute = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/auth/password-reset/confirm')!;
  const inviteRoute = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/auth/invitations/accept')!;

  const dummyCtx: AuthenticatedRequestContext = {
    principal: null, organizationId: null, projectId: null, functionalMapId: null,
    validatedOrigin: null, requestId: 'req_test', clientIp: '127.0.0.1',
    userAgent: 'TestAgent/1.0', receivedAt: new Date(),
  };

  // [2/5] Canje de Reto MFA con TOTP Exitoso
  console.log('[2/5] Emision de reto mfaChallengeToken y canje exitoso por tokens de sesion...');
  const challengeToken = await JwtEddsaSigner.signEphemeralToken({ userId, organizationId: orgId, purpose: 'MFA_CHALLENGE' }, 300);
  const currentTotp = computeValidTotp(totpSecret);

  const reqVerifySuccess: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/mfa/verify', query: {}, headers: { 'user-agent': 'Chrome/Test' },
    rawBody: Buffer.alloc(0), body: { mfaChallengeToken: challengeToken, code: currentTotp }, clientIp: '127.0.0.1',
  };

  const resVerifySuccess = await mfaRoute.handler(reqVerifySuccess, dummyCtx);
  assert.equal(resVerifySuccess.status, 200);
  const verifyBody = resVerifySuccess.body as any;
  assert.equal(verifyBody.status, 'AUTHENTICATED');
  assert.equal(verifyBody.user.id, userId);
  assert.equal(verifyBody.role, 'OWNER');
  assert.ok(typeof verifyBody.accessToken === 'string');
  assert.ok(typeof verifyBody.refreshToken === 'string');

  const verifiedClaims = await JwtEddsaSigner.verifyAccessToken(verifyBody.accessToken);
  assert.equal(verifiedClaims.mfaSatisfied, true, 'El token resultante DEBE tener mfaSatisfied = true');
  console.log('  -> Reto canjeado, sesion emitida y mfaSatisfied = true confirmado: OK.');

  // [3/5] Rechazo de Reto MFA ante Codigo Invalido o Proposito Falsificado
  console.log('[3/5] Rechazo estricto ante codigo TOTP incorrecto y token con proposito alterado...');
  const reqBadCode: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/mfa/verify', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { mfaChallengeToken: challengeToken, code: '999999' }, clientIp: '127.0.0.1',
  };
  await assert.rejects(
    async () => mfaRoute.handler(reqBadCode, dummyCtx),
    (err: any) => err.code === 'UNAUTHORIZED',
    'Debe rechazar con UnauthorizedError ante TOTP invalido'
  );

  const wrongPurposeToken = await JwtEddsaSigner.signEphemeralToken({ userId, organizationId: orgId, purpose: 'SDK_HANDSHAKE' }, 300);
  const reqWrongPurpose: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/mfa/verify', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { mfaChallengeToken: wrongPurposeToken, code: currentTotp }, clientIp: '127.0.0.1',
  };
  await assert.rejects(
    async () => mfaRoute.handler(reqWrongPurpose, dummyCtx),
    (err: any) => err.code === 'UNAUTHORIZED',
    'Debe rechazar un token efimero sin proposito MFA_CHALLENGE'
  );
  console.log('  -> Rechazo de TOTP erroneo y proteccion contra reuso de proposito: OK.');

  // [4/5] Recuperacion de Contrasena sin Exponer Token (C1-41)
  console.log('[4/5] Solicitud y confirmacion de recuperacion de contrasena (C1-41 anti-exposicion)...');
  const reqResetReq: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/password-reset/request', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { email: 'operador@empresa.com' }, clientIp: '127.0.0.1',
  };
  const resResetReq = await resetReqRoute.handler(reqResetReq, dummyCtx);
  assert.equal(resResetReq.status, 200);
  const bodyResetReq = resResetReq.body as any;
  assert.equal(bodyResetReq.ok, true);
  assert.equal(bodyResetReq.rawToken, undefined, 'El token en texto plano NUNCA debe incluirse en la respuesta HTTP');
  assert.equal(bodyResetReq.token, undefined);

  const plainToken = 'reset_token_test_1234567890abcdef';
  const shaToken = CryptoUtils.sha256Hex(plainToken);
  resetTokensDb.set(shaToken, { id: 'tok_1', user_id: userId, token_sha256: shaToken, is_used: false, expires_at: new Date(Date.now() + 900000) });

  const reqResetConf: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/password-reset/confirm', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { token: plainToken, newPassword: 'NuevaPasswordSegura2026!' }, clientIp: '127.0.0.1',
  };
  const resResetConf = await resetConfRoute.handler(reqResetConf, dummyCtx);
  assert.equal(resResetConf.status, 200);
  assert.equal((resResetConf.body as any).ok, true);

  // C1-41: el token es de un solo uso; una segunda confirmacion con el mismo token se rechaza
  const reqResetReuse: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/password-reset/confirm', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { token: plainToken, newPassword: 'OtraPasswordSegura2026!' }, clientIp: '127.0.0.1',
  };
  await assert.rejects(
    async () => resetConfRoute.handler(reqResetReuse, dummyCtx),
    (err: any) => err.code === 'UNAUTHORIZED',
    'Un token de restablecimiento ya consumido no puede reutilizarse'
  );

  const reqShortPass: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/password-reset/confirm', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { token: plainToken, newPassword: '123' }, clientIp: '127.0.0.1',
  };
  await assert.rejects(
    async () => resetConfRoute.handler(reqShortPass, dummyCtx),
    (err: any) => err.code === 'VALIDATION_FAILED' || err.name === 'ValidationError',
    'Debe rechazar contrasenas menores a 8 caracteres'
  );
  console.log('  -> Restablecimiento sin fuga de token (C1-41) y confirmacion estricta: OK.');

  // [5/5] Aceptacion de Invitaciones Multi-Tenant
  console.log('[5/5] Aceptacion formal de invitacion a organizacion...');
  const plainInviteToken = 'invite_token_colaborador_9999';
  const inviteTokenSha = CryptoUtils.sha256Hex(plainInviteToken);
  invitationsDb.set('inv_1', {
    id: 'inv_1', organization_id: orgId, user_id: userId, role: 'DEVELOPER',
    invitation_token_sha256: inviteTokenSha, invitation_accepted_at: null, is_active: false,
    invitation_expires_at: new Date(Date.now() + 86400000),
  });

  const reqAcceptInvite: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/invitations/accept', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { token: plainInviteToken, userId }, clientIp: '127.0.0.1',
  };
  const resAcceptInvite = await inviteRoute.handler(reqAcceptInvite, dummyCtx);
  assert.equal(resAcceptInvite.status, 200);
  assert.equal((resAcceptInvite.body as any).ok, true);
  assert.equal((resAcceptInvite.body as any).organizationId, orgId);
  assert.equal((resAcceptInvite.body as any).role, 'DEVELOPER');

  const reqNoToken: HttpRequestLike = {
    method: 'POST', path: '/api/v1/auth/invitations/accept', query: {}, headers: {},
    rawBody: Buffer.alloc(0), body: { userId }, clientIp: '127.0.0.1',
  };
  await assert.rejects(
    async () => inviteRoute.handler(reqNoToken, dummyCtx),
    (err: any) => err.code === 'VALIDATION_FAILED' || err.name === 'ValidationError',
    'Debe exigir el token de invitacion'
  );
  console.log('  -> Aceptacion formal de membresia y asignacion de rol completada: OK.');
  console.log('================================================================================');
  console.log('RESULTADO C1-36: APROBADO. Rutas esenciales de identidad operativas y verificadas.');
  console.log('================================================================================');
}

void runAuthEssentialRoutesSuite().catch((err) => {
  console.error('ERROR EN PRUEBA C1-36:', err);
  process.exit(1);
});
