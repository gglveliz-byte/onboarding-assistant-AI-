/**
 * @archivo tests/integration/handshake-solvency-enforcement.test.ts
 * @modulo 02-projects-and-keys (Pruebas de Verificacion de Solvencia en Handshake del SDK)
 * @proposito
 *   Verifica de forma exhaustiva que el handshake del SDK no pueda ser emitido para organizaciones
 *   insolventes o cuando el modulo de facturacion falle o no este cableado (C1-02).
 *   Demuestra que el puerto falla cerrado y que un bypass de cobro es imposible.
 *
 * @dependencias_internas
 *   - `ApiKeyAndHandshakePortAdapter` (src/modules/02-projects-and-keys/application/sdk-handshake.use-case.ts)
 *   - `IBillingWhopPort` (src/shared/ports/billing-voice-admin.ports.ts)
 *   - `RlsDatabasePool` (src/shared/infrastructure/database/rls-pool.ts)
 *   - `PostgresProjectsKeysRepository` (src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository.ts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyAndHandshakePortAdapter } from '../../src/modules/02-projects-and-keys/application/sdk-handshake.use-case';
import type { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';
import { generateApiKeyWithChecksum } from '../../src/shared/kernel/api-key.util';
import type { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import type { PostgresProjectsKeysRepository } from '../../src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository';

describe('C1-02: Verificacion Estricta de Solvencia en Handshake SDK', () => {
  const fakeOrgId = '00000000-0000-0000-0000-000000000001';
  const fakeProjectId = '00000000-0000-0000-0000-000000000002';
  const validPublishableKey = generateApiKeyWithChecksum('pk', 'live', 'proj01').rawKey;

  // Mock de RLS pool y Repositorio que simula una clave y origen autorizados
  const mockPool = {
    withClient: async (fn: any) => fn({} as any),
    runInTenantTransaction: async (_opts: any, fn: any) => fn({} as any),
  } as unknown as RlsDatabasePool;

  const mockRepo = {
    resolveApiKeyOwnerByHash: async () => ({ organizationId: fakeOrgId, userId: 'u1' }),
    getApiKeyByHash: async () => ({
      id: 'k1',
      organizationId: fakeOrgId,
      projectId: fakeProjectId,
      revokedAt: null,
      keyHash: 'hash',
    }),
    listAllowedDomainsByProject: async () => [
      {
        id: 'd1',
        originPattern: 'https://example.com',
        allowLocalhostDev: false,
      },
    ],
    storeHandshakeNonce: async () => true,
  } as unknown as PostgresProjectsKeysRepository;

  it('Fase 1: Organizacion insolvente debe ser rechazada con TENANT_SUSPENDED', async () => {
    const insolventBillingPort: IBillingWhopPort = {
      checkOrganizationSolvency: async () => ({
        ok: true,
        snapshot: {
          availableMinutes: '0.000000',
          creditBalanceUsd: '0.000000',
          effectiveRatePerMinuteUsd: '0.100000',
          planCode: 'PAYG',
          canStartSession: false,
          blockedReason: 'Saldo agotado en plan por consumo',
        },
      }),
      deductVoiceSessionSlice: async () => ({} as any),
      grantPromotionalMinutes: async () => ({} as any),
    };

    const adapter = new ApiKeyAndHandshakePortAdapter(
      {} as any,
      mockPool,
      mockRepo,
      insolventBillingPort
    );

    const result = await adapter.validateSdkHandshake(
      validPublishableKey,
      'https://example.com',
      fakeProjectId
    );

    assert.equal(result.ok, false, 'El handshake debe ser rechazado para una organizacion insolvente');
    if (!result.ok) {
      assert.equal(result.code, 'TENANT_SUSPENDED', 'El codigo de error debe ser TENANT_SUSPENDED');
      assert.match(result.reason, /sin minutos|Saldo agotado/, 'El motivo debe senalar la falta de saldo');
    }
  });

  it('Fase 2: Falla cerrado cuando el puerto de facturacion esta ausente o falla', async () => {
    // Sin pasar billingPort (debe usar fallback cerrado)
    const adapterSinFacturacion = new ApiKeyAndHandshakePortAdapter(
      {} as any,
      mockPool,
      mockRepo
    );

    const result = await adapterSinFacturacion.validateSdkHandshake(
      validPublishableKey,
      'https://example.com',
      fakeProjectId
    );

    assert.equal(result.ok, false, 'Debe fallar cerrado si el puerto no fue provisto');
    if (!result.ok) {
      assert.equal(result.code, 'PERSISTENCE_UNAVAILABLE', 'Debe fallar con PERSISTENCE_UNAVAILABLE');
    }
  });

  it('Fase 3: Organizacion solvente recibe nonce efimero de un solo uso', async () => {
    const solventBillingPort: IBillingWhopPort = {
      checkOrganizationSolvency: async () => ({
        ok: true,
        snapshot: {
          availableMinutes: '500.000000',
          creditBalanceUsd: '25.000000',
          effectiveRatePerMinuteUsd: '0.100000',
          planCode: 'PRO',
          canStartSession: true,
          blockedReason: null,
        },
      }),
      deductVoiceSessionSlice: async () => ({} as any),
      grantPromotionalMinutes: async () => ({} as any),
    };

    const adapter = new ApiKeyAndHandshakePortAdapter(
      {} as any,
      mockPool,
      mockRepo,
      solventBillingPort
    );

    const result = await adapter.validateSdkHandshake(
      validPublishableKey,
      'https://example.com',
      fakeProjectId
    );

    assert.equal(result.ok, true, 'El handshake debe ser exitoso para organizacion solvente');
    if (result.ok) {
      assert.equal(result.organizationId, fakeOrgId);
      assert.equal(result.projectId, fakeProjectId);
      assert.ok(result.issuedNonceId.length > 20, 'Debe haber emitido un nonce seguro');
      assert.equal(result.nonceTtlSeconds, 60);
    }
  });
});
