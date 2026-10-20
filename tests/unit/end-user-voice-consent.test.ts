/**
 * @archivo tests/unit/end-user-voice-consent.test.ts
 * @modulo 02-projects-and-keys (Certificacion de Consentimiento de Voz de Usuarios Finales)
 * @proposito
 *   Verifica el caso de uso `RecordEndUserVoiceConsentUseCase`: autenticacion de la clave secreta,
 *   aislamiento por organizacion, hash de la IP, snapshot documental, upsert idempotente y
 *   validaciones de proyecto, fecha y tamano de evidencia.
 *
 * @resumen_contenido
 *   - Arnes minimo de pruebas con `node:assert/strict`.
 *   - Mocks del validador de claves y del pool RLS (sin base de datos real).
 *   - Casos: alta, revocacion, proyecto ajeno, documento ausente, fecha invalida y clave invalida.
 */

import * as assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../src/shared/kernel/result-and-errors';
import { RecordEndUserVoiceConsentUseCase } from '../../src/modules/02-projects-and-keys/application/end-user-voice-consent.use-case';

let passed = 0;

async function asyncTest(desc: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL] ${desc}:`, err);
    throw err;
  }
}

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const DOC_SHA = 'a'.repeat(64);
const API_KEY = {
  ok: true as const,
  organizationId: 'org-1',
  projectId: 'project-1',
  apiKeyId: 'key-1',
  scopes: ['voice:consent:write'],
  environment: 'LIVE' as const,
};

interface HarnessOptions {
  readonly documentMissing?: boolean;
  readonly keyFailure?: Error;
}

function createHarness(options: HarnessOptions = {}): {
  readonly useCase: RecordEndUserVoiceConsentUseCase;
  readonly queries: { readonly sql: string; readonly params: readonly unknown[] }[];
  readonly contexts: { readonly organizationId: string }[];
} {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const contexts: { organizationId: string }[] = [];

  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM legal_documents')) {
        return {
          rows: options.documentMissing
            ? []
            : [{ id: DOC_ID, version_tag: 'v1.0.0', content_sha256: DOC_SHA }],
        };
      }
      return {
        rows: [{
          id: 'consent-1',
          granted_at: new Date('2026-10-19T14:52:00.000Z'),
          updated_at: new Date('2026-10-19T14:53:00.000Z'),
        }],
      };
    },
  };

  const rlsPool = {
    runInTenantTransaction: async (
      context: { organizationId: string },
      work: (c: PoolClient) => Promise<unknown>
    ) => {
      contexts.push(context);
      return work(client as unknown as PoolClient);
    },
  };

  const validator = {
    execute: async () => {
      if (options.keyFailure) return { ok: false as const, error: options.keyFailure };
      return { ok: true as const, value: API_KEY };
    },
  };

  return {
    useCase: new RecordEndUserVoiceConsentUseCase(rlsPool as never, validator as never),
    queries,
    contexts,
  };
}

async function runSuite(): Promise<void> {
  console.log('PRUEBA DE CERTIFICACION DE CONSENTIMIENTO DE VOZ DE USUARIOS FINALES');
  console.log('='.repeat(80));

  await asyncTest('registra la evidencia con hash de IP y snapshot documental', async () => {
    const harness = createHarness();
    const result = await harness.useCase.execute({
      secretKey: 'sk_live_test',
      externalEndUserId: '  user-42  ',
      consentGranted: true,
      grantedAt: '2026-10-19T14:52:00.000Z',
      evidence: { source: 'checkout-web' },
      clientIp: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Test',
    });

    assert.equal(result.consentId, 'consent-1');
    assert.equal(result.externalEndUserId, 'user-42');
    assert.equal(result.consentGranted, true);
    assert.equal(result.documentVersion, 'v1.0.0');
    assert.equal(result.grantedAt, '2026-10-19T14:52:00.000Z');
    assert.equal(harness.contexts.length, 1);
    assert.equal(harness.contexts[0]?.organizationId, 'org-1');

    const insert = harness.queries.find((query) => query.sql.includes('INSERT INTO end_user_voice_consents'));
    assert.ok(insert);
    assert.equal(insert.params[0], 'org-1');
    assert.equal(insert.params[1], 'project-1');
    assert.equal(insert.params[2], 'key-1');
    assert.equal(insert.params[3], 'user-42');
    assert.equal(insert.params[4], DOC_ID);
    assert.equal(insert.params[5], 'v1.0.0');
    assert.equal(insert.params[6], DOC_SHA);
    assert.equal(insert.params[7], true);
    assert.equal(insert.params[9], CryptoUtils.sha256Hex('203.0.113.7'));
    assert.notEqual(insert.params[9], '203.0.113.7');
    assert.equal(insert.params[11], JSON.stringify({ source: 'checkout-web' }));
  });

  await asyncTest('permite revocar el consentimiento con consentGranted=false', async () => {
    const harness = createHarness();
    const result = await harness.useCase.execute({
      secretKey: 'sk_live_test',
      externalEndUserId: 'user-42',
      consentGranted: false,
      clientIp: '203.0.113.7',
      userAgent: 'Test',
    });

    assert.equal(result.consentGranted, false);
    const insert = harness.queries.find((query) => query.sql.includes('INSERT INTO end_user_voice_consents'));
    assert.ok(insert);
    assert.equal(insert.params[7], false);
  });

  await asyncTest('rechaza un projectId que no pertenece a la clave', async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.useCase.execute({
        secretKey: 'sk_live_test',
        externalEndUserId: 'user-42',
        consentGranted: true,
        projectId: 'project-2',
        clientIp: '203.0.113.7',
        userAgent: 'Test',
      }),
      (error: unknown) => error instanceof ForbiddenError
    );
  });

  await asyncTest('falla cerrado cuando no existe aviso de consentimiento activo', async () => {
    const harness = createHarness({ documentMissing: true });
    await assert.rejects(
      harness.useCase.execute({
        secretKey: 'sk_live_test',
        externalEndUserId: 'user-42',
        consentGranted: true,
        clientIp: '203.0.113.7',
        userAgent: 'Test',
      }),
      (error: unknown) => error instanceof NotFoundError
    );
  });

  await asyncTest('rechaza fechas invalidas y evidencia sobredimensionada', async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.useCase.execute({
        secretKey: 'sk_live_test',
        externalEndUserId: 'user-42',
        consentGranted: true,
        grantedAt: 'no-es-fecha',
        clientIp: '203.0.113.7',
        userAgent: 'Test',
      }),
      (error: unknown) => error instanceof ValidationError
    );
    await assert.rejects(
      harness.useCase.execute({
        secretKey: 'sk_live_test',
        externalEndUserId: 'user-42',
        consentGranted: true,
        evidence: { blob: 'x'.repeat(9000) },
        clientIp: '203.0.113.7',
        userAgent: 'Test',
      }),
      (error: unknown) => error instanceof ValidationError
    );
  });

  await asyncTest('propaga el fallo de una clave secreta invalida', async () => {
    const harness = createHarness({ keyFailure: new UnauthorizedError('clave invalida') });
    await assert.rejects(
      harness.useCase.execute({
        secretKey: 'sk_live_invalid',
        externalEndUserId: 'user-42',
        consentGranted: true,
        clientIp: '203.0.113.7',
        userAgent: 'Test',
      }),
      (error: unknown) => error instanceof UnauthorizedError
    );
  });

  console.log('='.repeat(80));
  console.log(`RESULTADO: APROBADO. ${passed}/6 pruebas superadas.`);
}

void runSuite();
