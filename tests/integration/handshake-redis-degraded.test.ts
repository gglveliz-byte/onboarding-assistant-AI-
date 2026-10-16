/**
 * @archivo tests/integration/handshake-redis-degraded.test.ts
 * @modulo 02-projects-and-keys (Prueba de Degradacion del Handshake con Redis Caido - C1-60)
 * @proposito
 *   Demuestra de forma determinista y reproducible que el handshake del SDK Web y la resolucion
 *   de claves y dominios no se caen cuando Redis no esta disponible.
 *   - Valida que la consulta de dominios se degrada de forma transparente a PostgreSQL.
 *   - Valida que los nonces efimeros del handshake se almacenan y consumen mediante el almacen
 *     de degradacion en memoria.
 *   - Valida que no se emiten excepciones no capturadas ni se bloquea el proceso.
 */

import assert from 'node:assert/strict';
import { ApiKeyUtils } from '../../src/shared/kernel/api-key.util';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import {
  ApiKeyEntity,
  AllowedDomainEntity,
  ProjectEntity,
} from '../../src/modules/02-projects-and-keys/domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../../src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository';
import {
  ApiKeyAndHandshakePortAdapter,
  ValidateSdkHandshakeUseCase,
} from '../../src/modules/02-projects-and-keys/application/sdk-handshake.use-case';
import { ValidateSecretApiKeyUseCase } from '../../src/modules/02-projects-and-keys/application/api-key-lifecycle.use-case';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';

/** Mock de cliente Redis simulando desconexion total o caida (ECONNREFUSED). */
function createFailingRedisClient(): RedisClusterClient {
  const errorThrower = async (): Promise<never> => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379 (Redis caido simulado C1-60)');
  };

  return {
    json: {
      setJson: errorThrower,
      getJson: errorThrower,
      getText: errorThrower,
    },
    keys: {
      remove: errorThrower,
      setIfAbsent: errorThrower,
    },
    counters: {
      addToSet: errorThrower,
      listSet: errorThrower,
    },
  } as unknown as RedisClusterClient;
}

/** Mock de puerto de facturacion solvente */
const mockBillingPort = {
  checkOrganizationSolvency: async (orgId: string) => ({
    ok: true as const,
    snapshot: {
      organizationId: orgId,
      canStartSession: true,
      availableMinutes: '120.000000',
      creditBalanceUsd: '50.000000',
      effectiveRatePerMinuteUsd: '0.100000',
      planCode: 'PAYG',
      blockedReason: null,
      isHardBlocked: false,
    },
  }),
  deductVoiceSessionSlice: async () => ({} as any),
  grantPromotionalMinutes: async () => ({} as any),
} as unknown as IBillingWhopPort;

async function runTest(): Promise<void> {
  console.log('================================================================================');
  console.log('PRUEBA DE DEGRADACION: HANDSHAKE SDK CON REDIS CAIDO (C1-60)');
  console.log('================================================================================');

  const failingRedis = createFailingRedisClient();
  const repo = new PostgresProjectsKeysRepository(failingRedis);

  const orgId = 'org_' + CryptoUtils.generateCsprngToken(8);
  const projectId = 'proj_' + CryptoUtils.generateCsprngToken(8);
  const generated = ApiKeyUtils.generateApiKeyWithChecksum('pk', 'live', 'proj01');
  const publishableKey = generated.rawKey;
  const keyHash = generated.sha256Hash;

  const mockProject: ProjectEntity = {
    id: projectId,
    organizationId: orgId,
    name: 'Proyecto Degradado Redis',
    slug: 'proyecto-degradado',
    primaryVoiceModel: 'GEMINI_3_8_LIVE',
    fallbackVoiceModel: 'QWEN_3_8_OMNI_FLASH_REALTIME',
    voicePersonaCode: 'sofia_es_neutral',
    speechSpeed: 1.0,
    vadBargeInSensitivity: 'BALANCED',
    modelTemperature: 0.2,
    systemPrompt: 'Prompt',
    onboardingStepsJson: [],
    strictStepEnforcement: true,
    askConfirmationBeforeSubmit: true,
    activeFunctionalMapId: null,
    activePromptVersionNumber: 1,
    createdByUserId: null,
    environment: 'LIVE',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockApiKey: ApiKeyEntity = {
    id: 'key_1',
    organizationId: orgId,
    projectId,
    name: 'Default PK',
    keyType: 'pk',
    environment: 'LIVE',
    keyPrefix: generated.prefix,
    lastFour: generated.lastFour,
    keyHash,
    scopes: ['sdk:connect'],
    rotatedFromKeyId: null,
    expiresAt: null,
    gracePeriodEndsAt: null,
    revokedAt: null,
    revokedByUserId: null,
    createdByUserId: null,
    createdAt: new Date(),
    lastUsedAt: null,
    lastUsedIp: null,
  };

  const mockDomains: AllowedDomainEntity[] = [
    {
      id: 'dom_1',
      organizationId: orgId,
      projectId,
      originPattern: 'https://app.ejemplo.com',
      allowLocalhostDev: false,
      dnsVerificationToken: null,
      dnsVerifiedAt: null,
      isActive: true,
      createdByUserId: null,
      createdAt: new Date(),
    },
  ];

  // Doble del RLS pool que devuelve los registros de prueba
  const mockPool = {
    withClient: async <T>(callback: (client: any) => Promise<T>): Promise<T> => {
      const mockClient = {};
      return callback(mockClient);
    },
  } as unknown as RlsDatabasePool;

  // Interceptar consultas de BD en el repositorio
  repo.getApiKeyByHash = async (_client, hash) => (hash === keyHash ? mockApiKey : null);
  repo.getProjectById = async (_client, id) => (id === projectId ? mockProject : null);
  repo.listAllowedDomainsByProject = async (_client, id) => (id === projectId ? mockDomains : []);

  console.log('[1/3] Ejecucion de ValidateSdkHandshakeUseCase con Redis caido...');
  const handshakeUseCase = new ValidateSdkHandshakeUseCase(
    mockPool,
    repo,
    new JwtEddsaSigner(),
    mockBillingPort
  );

  const handshakeStartTime = performance.now();
  const handshakeResult = await handshakeUseCase.execute({
    publishableKey,
    projectId,
    origin: 'https://app.ejemplo.com',
    clientIp: '127.0.0.1',
    endUserConsentGranted: true,
    externalEndUserId: 'usr_externo_42',
  });
  const handshakeDuration = performance.now() - handshakeStartTime;

  assert.equal(handshakeResult.ok, true, 'El handshake debio tener exito degradando a base de datos');
  const hsValue = handshakeResult.value;
  assert.ok(hsValue.ephemeralWsToken.length > 20, 'Debio emitir el token efimero EdDSA');
  assert.equal(hsValue.projectId, projectId);
  assert.equal(hsValue.organizationId, orgId);
  console.log(
    `  -> Handshake completado en ${handshakeDuration.toFixed(2)} ms con Redis caido (degradacion exitosa)`
  );

  console.log('[2/3] Consumo del nonce efimero mediante ApiKeyAndHandshakePortAdapter...');
  const validateSecretKeyUseCase = new ValidateSecretApiKeyUseCase(mockPool, repo);
  const portAdapter = new ApiKeyAndHandshakePortAdapter(validateSecretKeyUseCase, mockPool, repo);

  const consumeResult = await portAdapter.consumeEphemeralWsNonce(hsValue.nonceId, projectId);
  assert.equal(consumeResult.ok, true, 'El nonce debio consumirse exitosamente desde la memoria degradada');
  if (consumeResult.ok) {
    assert.equal(consumeResult.organizationId, orgId);
    assert.equal(consumeResult.externalEndUserId, 'usr_externo_42');
  }
  console.log('  -> Nonce consumido correctamente desde el fallback en memoria');

  console.log('[3/3] Verificacion de prevencion de repeticion de nonce (Replay Attack)...');
  const replayResult = await portAdapter.consumeEphemeralWsNonce(hsValue.nonceId, projectId);
  assert.equal(replayResult.ok, false, 'El nonce ya consumido no puede volver a consumirse');
  if (!replayResult.ok) {
    assert.equal(replayResult.code, 'HANDSHAKE_NONCE_REPLAYED');
  }
  console.log('  -> Ataque de repeticion prevenido: el nonce es de un solo uso incluso bajo degradacion');

  console.log('================================================================================');
  console.log('RESULTADO: APROBADO. C1-60 resuelto: handshake funciona con Redis caido sin fallar.');
  console.log('================================================================================');
}

runTest().catch((err) => {
  console.error('Fallo en la prueba de degradacion C1-60:', err);
  process.exit(1);
});
