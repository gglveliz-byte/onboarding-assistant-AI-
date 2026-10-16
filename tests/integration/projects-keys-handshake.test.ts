/**
 * @archivo tests/integration/projects-keys-handshake.test.ts
 * @modulo 02-projects-and-keys (Prueba de Fuego Integral de Proyectos, Claves y Handshake)
 * @proposito
 *   Verifica los 5 pilares criticos de seguridad y funcionalidad del Modulo 02:
 *   1. Creacion de proyectos con slug normalizado y aprovisionamiento automatico de claves iniciales.
 *   2. Lista blanca de `allowed_domains` con soporte para comodines y bloqueo de localhost en LIVE.
 *   3. Ciclo de vida de API Keys (generacion, rotacion con ventana de gracia y revocacion).
 *   4. Validacion de claves secretas con descarte previo por checksum CRC32 (<1ms).
 *   5. Handshake del SDK Web (validacion de origen, consentimiento, token EdDSA 60s y consumo de nonce).
 */

import assert from 'node:assert/strict';
import { ApiKeyUtils } from '../../src/shared/kernel/api-key.util';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import {
  isOriginMatchingPattern,
  ProjectEntity,
  ApiKeyEntity,
  AllowedDomainEntity,
} from '../../src/modules/02-projects-and-keys/domain/projects-keys.entities';
import { PostgresProjectsKeysRepository } from '../../src/modules/02-projects-and-keys/infrastructure/postgres-projects-keys.repository';
import {
  CreateAllowedDomainUseCase,
  CreateProjectUseCase,
} from '../../src/modules/02-projects-and-keys/application/manage-projects-and-domains.use-case';
import {
  CreateApiKeyUseCase,
  RevokeApiKeyImmediatelyUseCase,
  RotateApiKeyUseCase,
  ValidateSecretApiKeyUseCase,
} from '../../src/modules/02-projects-and-keys/application/api-key-lifecycle.use-case';
import {
  ApiKeyAndHandshakePortAdapter,
  ValidateSdkHandshakeUseCase,
} from '../../src/modules/02-projects-and-keys/application/sdk-handshake.use-case';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { RlsDatabasePool } from '../../src/shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { IBillingWhopPort } from '../../src/shared/ports/billing-voice-admin.ports';
import { PoolClient } from 'pg';

console.log('================================================================================');
console.log('PRUEBA DE FUEGO INTEGRAL: MODULO 02 (PROYECTOS, CLAVES Y HANDSHAKE DEL SDK)');
console.log('================================================================================');

async function runProjectsKeysTestSuite() {
  // ---------------------------------------------------------------------------
  // Dobles en memoria para aislamiento determinista de la prueba
  // ---------------------------------------------------------------------------
  const redisMemory = new Map<string, string>();
  const redisSets = new Map<string, Set<string>>();

  const mockRedis = {
    json: {
      getJson: async <T>(k: string): Promise<T | null> => {
        const val = redisMemory.get(k);
        return val ? (JSON.parse(val) as T) : null;
      },
      setJson: async (k: string, v: unknown): Promise<void> => {
        redisMemory.set(k, JSON.stringify(v));
      },
      getText: async (k: string): Promise<string | null> => redisMemory.get(k) ?? null,
      setText: async (k: string, v: string): Promise<void> => {
        redisMemory.set(k, v);
      },
    },
    keys: {
      exists: async (k: string): Promise<boolean> => redisMemory.has(k) || redisSets.has(k),
      remove: async (...keys: string[]): Promise<number> => {
        let count = 0;
        for (const k of keys) {
          if (redisMemory.delete(k) || redisSets.delete(k)) count++;
        }
        return count;
      },
      setIfAbsent: async (k: string, v: string): Promise<boolean> => {
        if (redisMemory.has(k)) return false;
        redisMemory.set(k, v);
        return true;
      },
      expire: async (): Promise<boolean> => true,
    },
    counters: {
      addToSet: async (k: string, m: string): Promise<number> => {
        let set = redisSets.get(k);
        if (!set) {
          set = new Set<string>();
          redisSets.set(k, set);
        }
        const sizeBefore = set.size;
        set.add(m);
        return set.size - sizeBefore;
      },
      removeFromSet: async (k: string, m: string): Promise<number> => {
        const set = redisSets.get(k);
        return set && set.delete(m) ? 1 : 0;
      },
      listSet: async (k: string): Promise<readonly string[]> => {
        const set = redisSets.get(k);
        return set ? Array.from(set) : [];
      },
      countSet: async (k: string): Promise<number> => redisSets.get(k)?.size ?? 0,
    },
  } as unknown as RedisClusterClient;

  // Base de datos en memoria para Proyectos, Dominios y Claves
  const projectsDb = new Map<string, ProjectEntity>();
  const apiKeysDb = new Map<string, ApiKeyEntity>();
  const domainsDb = new Map<string, AllowedDomainEntity>();

  const repository = new PostgresProjectsKeysRepository(mockRedis);

  // Sobrescribir metodos de persistencia en el repositorio para la prueba en memoria
  (repository as any).createProject = async (_c: PoolClient, input: any): Promise<ProjectEntity> => {
    const proj: ProjectEntity = {
      id: '018f0000-0000-7000-8000-000000000001',
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      environment: input.environment ?? 'LIVE',
      primaryVoiceModel: input.primaryVoiceModel ?? 'GEMINI_3_8_LIVE',
      fallbackVoiceModel: input.fallbackVoiceModel ?? 'QWEN_3_8_OMNI_FLASH_REALTIME',
      voicePersonaCode: input.voicePersonaCode ?? 'aura-es-neutral',
      speechSpeed: input.speechSpeed ?? 1.0,
      vadBargeInSensitivity: input.vadBargeInSensitivity ?? 'BALANCED',
      modelTemperature: input.modelTemperature ?? 0.2,
      systemPrompt: input.systemPrompt ?? 'Prompt',
      onboardingStepsJson: input.onboardingStepsJson ?? [],
      strictStepEnforcement: true,
      askConfirmationBeforeSubmit: true,
      activeFunctionalMapId: null,
      activePromptVersionNumber: 1,
      isActive: true,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    projectsDb.set(proj.id, proj);
    return proj;
  };

  (repository as any).getProjectById = async (_c: PoolClient, id: string) => projectsDb.get(id) ?? null;
  (repository as any).getProjectBySlug = async (_c: PoolClient, orgId: string, slug: string) => {
    for (const p of projectsDb.values()) {
      if (p.organizationId === orgId && p.slug === slug) return p;
    }
    return null;
  };
  (repository as any).listProjectsByOrg = async (_c: PoolClient, orgId: string) => {
    return Array.from(projectsDb.values()).filter((p) => p.organizationId === orgId);
  };

  (repository as any).createApiKey = async (
    _c: PoolClient,
    input: any,
    keyHash: string,
    keyPrefix: string,
    lastFour: string
  ): Promise<ApiKeyEntity> => {
    const apiKey: ApiKeyEntity = {
      id: `018f0000-0000-7000-8000-${String(apiKeysDb.size + 1).padStart(12, '0')}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      name: input.name,
      keyType: input.keyType,
      environment: input.environment,
      keyPrefix,
      lastFour,
      keyHash,
      scopes: input.scopes ?? [],
      rotatedFromKeyId: null,
      gracePeriodEndsAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      revokedByUserId: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: new Date(),
    };
    apiKeysDb.set(apiKey.id, apiKey);
    await repository.cacheApiKey(apiKey);
    return apiKey;
  };

  (repository as any).getApiKeyByHash = async (_c: PoolClient, hash: string) => {
    for (const k of apiKeysDb.values()) {
      if (k.keyHash === hash) return k;
    }
    return null;
  };

  (repository as any).listApiKeysByProject = async (_c: PoolClient, projectId: string) => {
    return Array.from(apiKeysDb.values()).filter((k) => k.projectId === projectId);
  };

  (repository as any).rotateApiKey = async (
    _c: PoolClient,
    oldKeyId: string,
    newInput: any,
    newHash: string,
    newPrefix: string,
    newLastFour: string,
    gracePeriod: Date
  ) => {
    const old = apiKeysDb.get(oldKeyId)!;
    const updatedOld: ApiKeyEntity = { ...old, gracePeriodEndsAt: gracePeriod };
    apiKeysDb.set(old.id, updatedOld);

    const newKey: ApiKeyEntity = {
      id: `018f0000-0000-7000-8000-${String(apiKeysDb.size + 1).padStart(12, '0')}`,
      organizationId: newInput.organizationId,
      projectId: newInput.projectId,
      name: newInput.name,
      keyType: newInput.keyType,
      environment: newInput.environment,
      keyPrefix: newPrefix,
      lastFour: newLastFour,
      keyHash: newHash,
      scopes: newInput.scopes ?? [],
      rotatedFromKeyId: oldKeyId,
      gracePeriodEndsAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
      createdByUserId: newInput.createdByUserId ?? null,
      createdAt: new Date(),
    };
    apiKeysDb.set(newKey.id, newKey);
    await repository.cacheApiKey(updatedOld);
    await repository.cacheApiKey(newKey);
    return { oldKey: updatedOld, newKey };
  };

  (repository as any).revokeApiKey = async (_c: PoolClient, keyId: string) => {
    const key = apiKeysDb.get(keyId);
    if (!key) return false;
    const revoked = { ...key, revokedAt: new Date() };
    apiKeysDb.set(keyId, revoked);
    await mockRedis.keys.remove(`oa:apikey:sha256:${key.keyHash}`);
    return true;
  };

  (repository as any).createAllowedDomain = async (_c: PoolClient, input: any) => {
    const dom: AllowedDomainEntity = {
      id: `dom-${domainsDb.size + 1}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      originPattern: input.originPattern,
      allowLocalhostDev: input.allowLocalhostDev ?? false,
      dnsVerificationToken: null,
      dnsVerifiedAt: null,
      isActive: true,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: new Date(),
    };
    domainsDb.set(dom.id, dom);
    return dom;
  };

  (repository as any).listAllowedDomainsByProject = async (_c: PoolClient, projId: string) => {
    return Array.from(domainsDb.values()).filter((d) => d.projectId === projId);
  };

  const mockRlsPool = {
    runInTenantTransaction: async (_ctx: any, fn: any) => fn({} as PoolClient),
    withClient: async (fn: any) => fn({} as PoolClient),
  } as unknown as RlsDatabasePool;

  const jwtSigner = new JwtEddsaSigner(mockRedis);

  const mockBillingPort: IBillingWhopPort = {
    checkOrganizationSolvency: async () => ({
      ok: true,
      snapshot: {
        availableMinutes: '600.000000',
        creditBalanceUsd: '50.000000',
        effectiveRatePerMinuteUsd: '0.100000',
        planCode: 'PAYG',
        canStartSession: true,
        blockedReason: null,
      },
    }),
    deductVoiceSessionSlice: async () => ({} as any),
    grantPromotionalMinutes: async () => ({} as any),
  };



  const orgId = '018f0000-0000-7000-8000-0000000000aa';

  // ===========================================================================
  // FASE 1: Creacion de proyecto y claves iniciales
  // ===========================================================================
  console.log('[1/5] Creacion de proyectos, validacion de slug y aprovisionamiento...');
  const createProjectUseCase = new CreateProjectUseCase(mockRlsPool, repository);

  // 1.1 Slug invalido debe fallar
  const invalidSlugRes = await createProjectUseCase.execute({
    organizationId: orgId,
    name: 'Proyecto Invalido',
    slug: 'Slug_Invalido!@#',
  });
  assert.equal(invalidSlugRes.ok, false, 'Debe rechazar slugs con mayúsculas o caracteres especiales');

  // 1.2 Slug valido debe aprovisionar el proyecto y sus 2 claves
  const projectRes = await createProjectUseCase.execute({
    organizationId: orgId,
    name: 'SaaS Onboarding Demo',
    slug: 'saas-onboarding-demo',
    environment: 'LIVE',
  });
  assert.equal(projectRes.ok, true, 'La creacion de proyecto valido debe triunfar');
  if (!projectRes.ok) throw new Error('Fallo inesperado al crear proyecto');
  const projectData = projectRes.value;

  assert.equal(projectData.project.slug, 'saas-onboarding-demo');
  assert.ok(projectData.initialPublishableKey.rawKey.startsWith('pk_live_'), 'Publishable key debe ser pk_live_');
  assert.ok(projectData.initialSecretKey.rawKey.startsWith('sk_live_'), 'Secret key debe ser sk_live_');
  assert.equal(ApiKeyUtils.verifyApiKeyChecksum(projectData.initialPublishableKey.rawKey), true, 'Checksum CRC32 pk');
  assert.equal(ApiKeyUtils.verifyApiKeyChecksum(projectData.initialSecretKey.rawKey), true, 'Checksum CRC32 sk');
  console.log('  -> Proyecto creado con pk_live y sk_live aprovisionadas y checksum CRC32 verificado: OK.');

  // ===========================================================================
  // FASE 2: Dominios permitidos y reglas de origen
  // ===========================================================================
  console.log('[2/5] Gestion de allowed_domains y reglas de seguridad de origen...');
  const createDomainUseCase = new CreateAllowedDomainUseCase(mockRlsPool, repository);

  // 2.1 Bloqueo de localhost en proyecto LIVE sin allowLocalhostDev
  const blockedLocalhostRes = await createDomainUseCase.execute({
    organizationId: orgId,
    projectId: projectData.project.id,
    originPattern: 'http://localhost:3000',
    allowLocalhostDev: false,
  });
  assert.equal(blockedLocalhostRes.ok, false, 'Debe prohibir localhost en LIVE sin flag explicito');

  // 2.2 Aprobacion de dominio corporativo con wildcard
  const domainRes = await createDomainUseCase.execute({
    organizationId: orgId,
    projectId: projectData.project.id,
    originPattern: 'https://*.empresa.com',
  });
  assert.equal(domainRes.ok, true, 'Debe registrar dominio corporativo wildcard');

  // 2.3 Evaluacion de matching de origen
  assert.equal(isOriginMatchingPattern('https://app.empresa.com', 'https://*.empresa.com', false), true);
  assert.equal(isOriginMatchingPattern('https://otraempresa.com', 'https://*.empresa.com', false), false);
  console.log('  -> Reglas de origen con comodines y bloqueo de localhost en produccion: OK.');

  // ===========================================================================
  // FASE 3: Ciclo de vida de API Keys (Rotacion y revocacion)
  // ===========================================================================
  console.log('[3/5] Ciclo de vida de API Keys (rotacion con gracia y revocacion)...');
  const rotateApiKeyUseCase = new RotateApiKeyUseCase(mockRlsPool, repository);
  const revokeApiKeyUseCase = new RevokeApiKeyImmediatelyUseCase(mockRlsPool, repository);

  // 3.1 Obtener la secret key inicial creada
  const keys = await repository.listApiKeysByProject({} as PoolClient, projectData.project.id);
  const secretKeyEntity = keys.find((k) => k.keyType === 'sk')!;

  // 3.2 Rotar clave secreta con 24 horas de gracia
  const rotateRes = await rotateApiKeyUseCase.execute({
    organizationId: orgId,
    projectId: projectData.project.id,
    apiKeyId: secretKeyEntity.id,
    gracePeriodHours: 24,
  });
  assert.equal(rotateRes.ok, true, 'Rotacion de clave secreta exitosa');
  if (!rotateRes.ok) throw new Error('Fallo inesperado al rotar clave');
  assert.ok(rotateRes.value.oldKey.gracePeriodEndsAt !== null, 'Clave vieja debe tener fecha de gracia');
  assert.ok(rotateRes.value.newRawKey.startsWith('sk_live_'), 'Nueva clave generada');
  assert.equal(ApiKeyUtils.verifyApiKeyChecksum(rotateRes.value.newRawKey), true, 'Checksum de nueva clave');

  // 3.3 Revocar clave inmediatamente
  const revokeRes = await revokeApiKeyUseCase.execute(orgId, projectData.project.id, secretKeyEntity.id);
  assert.equal(revokeRes.ok, true);
  if (!revokeRes.ok) throw new Error('Fallo inesperado al revocar clave');
  assert.equal(revokeRes.value.revoked, true);
  console.log('  -> Rotacion atomica con ventana de 24h y revocacion forzosa: OK.');

  // ===========================================================================
  // FASE 4: Validacion de clave secreta y descarte por CRC32
  // ===========================================================================
  console.log('[4/5] Validacion de claves secretas con descarte previo por checksum CRC32...');
  const validateSecretKeyUseCase = new ValidateSecretApiKeyUseCase(mockRlsPool, repository);

  // 4.1 Clave con CRC32 corrompido debe descartarse de inmediato
  const corruptedKey = rotateRes.value.newRawKey.slice(0, -6) + '000000';
  const corruptedRes = await validateSecretKeyUseCase.execute(corruptedKey);
  assert.equal(corruptedRes.ok, false, 'Debe fallar sin tocar BD por CRC32 corrupto');
  if (corruptedRes.ok) throw new Error('Se esperaba fallo por CRC32');
  assert.equal(corruptedRes.error.name, 'UnauthorizedError');

  // 4.2 Clave valida rotada debe autenticar correctamente
  const validRes = await validateSecretKeyUseCase.execute(rotateRes.value.newRawKey);
  assert.equal(validRes.ok, true, 'Clave nueva debe validar');
  if (!validRes.ok) throw new Error('Fallo inesperado al validar clave');
  assert.equal(validRes.value.organizationId, orgId);
  console.log('  -> Descarte ultrarrapido ante CRC32 alterado y autenticacion con clave nueva: OK.');

  // ===========================================================================
  // FASE 5: Handshake del SDK Web y consumo de nonce de un solo uso
  // ===========================================================================
  console.log('[5/5] Handshake del SDK Web y consumo de nonce de un solo uso...');
  const validateSdkHandshakeUseCase = new ValidateSdkHandshakeUseCase(
    mockRlsPool,
    repository,
    jwtSigner,
    mockBillingPort
  );

  // 5.1 Handshake con origen no permitido debe ser rechazado
  const rejectedHandshake = await validateSdkHandshakeUseCase.execute({
    publishableKey: projectData.initialPublishableKey.rawKey,
    origin: 'https://hacker.com',
    projectId: projectData.project.id,
    clientIp: '190.25.1.1',
    endUserConsentGranted: true,
  });
  assert.equal(rejectedHandshake.ok, false, 'Origen no registrado debe fallar');
  if (rejectedHandshake.ok) throw new Error('Se esperaba rechazo de origen');
  assert.equal(rejectedHandshake.error.name, 'OriginNotAllowedError');

  // 5.2 Handshake exitoso con origen valido
  const validHandshake = await validateSdkHandshakeUseCase.execute({
    publishableKey: projectData.initialPublishableKey.rawKey,
    origin: 'https://portal.empresa.com',
    projectId: projectData.project.id,
    clientIp: '190.25.1.1',
    endUserConsentGranted: true,
    externalEndUserId: 'usr_client_999',
  });
  assert.equal(validHandshake.ok, true, 'Handshake con origen corporativo debe ser exitoso');
  if (!validHandshake.ok) throw new Error('Fallo inesperado en handshake');
  assert.ok(validHandshake.value.ephemeralWsToken.length > 50, 'Debe emitir JWT EdDSA efimero');
  assert.equal(validHandshake.value.expiresInSeconds, 60);

  // 5.3 Consumo estricto de nonce de un solo uso via IApiKeyAndHandshakePort
  const portAdapter = new ApiKeyAndHandshakePortAdapter(validateSecretKeyUseCase, mockRlsPool, repository);
  const nonceId = validHandshake.value.nonceId;

  // Primer consumo: debe tener exito
  const consume1 = await portAdapter.consumeEphemeralWsNonce(nonceId, projectData.project.id);
  assert.equal(consume1.ok, true, 'Primer consumo de nonce debe ser valido');
  if (consume1.ok) {
    assert.equal(consume1.externalEndUserId, 'usr_client_999');
  }

  // Segundo consumo (replay attack): debe ser rechazado
  const consume2 = await portAdapter.consumeEphemeralWsNonce(nonceId, projectData.project.id);
  assert.equal(consume2.ok, false, 'Segundo consumo (replay) debe ser rechazado');
  assert.equal((consume2 as any).code, 'HANDSHAKE_NONCE_REPLAYED');
  console.log('  -> Handshake, token EdDSA 60s y prevencion estricta de repeticion de nonce: OK.');

  console.log('================================================================================');
  console.log('RESULTADO: APROBADO. Todos los contratos y flujos de la PARTE 6 superados exitosamente.');
  console.log('================================================================================');
}

runProjectsKeysTestSuite().catch((err) => {
  console.error('ERROR EN PRUEBA DE FUEGO PARTE 6:', err);
  process.exit(1);
});
