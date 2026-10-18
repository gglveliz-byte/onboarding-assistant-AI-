/**
 * @archivo tests/unit/registration-with-phone.test.ts
 * @modulo 01-identity-and-rbac (Prueba de Registro con Teléfono Internacional y Persistencia)
 * @proposito
 *   Verifica de punta a punta que los números telefónicos con formato internacional
 *   sean procesados, persistidos y proyectados fielmente por el caso de uso de registro
 *   (RegisterOrganizationOwnerUseCase) y los mapeadores de entidad/proyección pública.
 */

import * as assert from 'node:assert/strict';
import { RegisterOrganizationOwnerUseCase } from '../../src/modules/01-identity-and-rbac/application/register-and-login.use-case';
import { toPublicUser, toPublicOrganization } from '../../src/modules/01-identity-and-rbac/application/identity-public-projections';
import { IdentityRowMapper } from '../../src/modules/01-identity-and-rbac/infrastructure/identity-row.mapper';
import type { UserEntity, OrganizationEntity } from '../../src/modules/01-identity-and-rbac/domain/identity.entities';

let passed = 0;
function test(desc: string, fn: () => void | Promise<void>): void {
  try {
    const res = fn();
    if (res instanceof Promise) {
      throw new Error('Async test called synchronously');
    }
    passed += 1;
    console.log(`  [OK] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL] ${desc}:`, err);
    throw err;
  }
}

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

async function runSuite(): Promise<void> {
  console.log('PRUEBA DE REGISTRO CON NÚMERO TELEFÓNICO INTERNACIONAL Y BD');
  console.log('='.repeat(80));

  // 1. Mapeo de fila SQL users con phone_number
  test('IdentityRowMapper.mapUserRow mapea correctamente phone_number', () => {
    const row = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'ada@example.com',
      full_name: 'Ada Lovelace',
      password_hash: '$argon2id$...',
      token_version: 1,
      is_platform_superadmin: false,
      mfa_totp_enabled: false,
      mfa_webauthn_enabled: false,
      failed_login_attempts: 0,
      phone_number: '+57 300 123 4567',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const entity = IdentityRowMapper.mapUserRow(row);
    assert.equal(entity.phoneNumber, '+57 300 123 4567');
    assert.equal(entity.email, 'ada@example.com');
  });

  // 2. Mapeo de fila SQL organizations con phone_number
  test('IdentityRowMapper.mapOrgRow mapea correctamente phone_number', () => {
    const row = {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Ada Corp',
      slug: 'ada-corp',
      status: 'ACTIVE',
      enforce_mfa: false,
      enforce_sso: false,
      opt_in_session_transcripts: false,
      phone_number: '+34 600 123 456',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const entity = IdentityRowMapper.mapOrgRow(row);
    assert.equal(entity.phoneNumber, '+34 600 123 456');
    assert.equal(entity.name, 'Ada Corp');
  });

  // 3. Proyección pública toPublicUser conserva phoneNumber
  test('toPublicUser incluye phoneNumber sin exponer datos sensibles', () => {
    const user: UserEntity = {
      id: 'user-1',
      email: 'test@example.com',
      fullName: 'Test User',
      passwordHash: 'hash-secreto-que-no-debe-salir',
      tokenVersion: 1,
      isPlatformSuperadmin: false,
      mfaTotpEnabled: false,
      mfaWebauthnEnabled: false,
      failedLoginAttempts: 0,
      phoneNumber: '+81 90 1234 5678',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const pub = toPublicUser(user);
    assert.equal(pub.phoneNumber, '+81 90 1234 5678');
    assert.equal((pub as unknown as Record<string, unknown>)['passwordHash'], undefined);
  });

  // 4. Proyección pública toPublicOrganization conserva phoneNumber
  test('toPublicOrganization incluye phoneNumber', () => {
    const org: OrganizationEntity = {
      id: 'org-1',
      name: 'Tokyo Labs',
      slug: 'tokyo-labs',
      status: 'ACTIVE',
      enforceMfa: false,
      enforceSso: false,
      optInSessionTranscripts: false,
      phoneNumber: '+81 90 1234 5678',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const pub = toPublicOrganization(org);
    assert.ok(pub !== null);
    assert.equal(pub?.phoneNumber, '+81 90 1234 5678');
  });

  // 5. Caso de uso RegisterOrganizationOwnerUseCase con teléfono internacional
  await asyncTest('RegisterOrganizationOwnerUseCase propaga y almacena el número de teléfono', async () => {
    let insertedUserData: any = null;
    let insertedOrgData: any = null;

    const mockRepo: any = {
      findUserByEmail: async () => null,
      findOrganizationBySlug: async () => null,
      createUser: async (data: any) => {
        insertedUserData = data;
        return {
          id: 'mock-user-id',
          email: data.email,
          fullName: data.fullName,
          passwordHash: data.passwordHash,
          tokenVersion: 1,
          isPlatformSuperadmin: false,
          mfaTotpEnabled: false,
          mfaWebauthnEnabled: false,
          failedLoginAttempts: 0,
          phoneNumber: data.phoneNumber,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      createOrganization: async (data: any) => {
        insertedOrgData = data;
        return {
          id: 'mock-org-id',
          name: data.name,
          slug: data.slug,
          status: 'ACTIVE',
          enforceMfa: false,
          enforceSso: false,
          optInSessionTranscripts: false,
          phoneNumber: data.phoneNumber,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      createMembership: async () => ({ id: 'mem-1' }),
      createAuthSession: async () => ({ id: 'sess-1' }),
    };

    const mockPool: any = {
      withClient: async (fn: any) => {
        const client = {
          query: async () => ({ rows: [] }),
        };
        return await fn(client);
      },
    };

    const useCase = new RegisterOrganizationOwnerUseCase(mockPool, mockRepo);
    const result = await useCase.execute({
      email: 'founder@worldwide.com',
      fullName: 'Global Founder',
      password: 'StrongPassword123!@#',
      organizationName: 'Global Worldwide Co',
      organizationSlug: 'global-worldwide-co',
      phone: '+57 300 987 6543',
      ipAddress: '127.0.0.1',
      userAgent: 'Mozilla/5.0 Test',
    });

    assert.equal(insertedUserData?.phoneNumber, '+57 300 987 6543');
    assert.equal(insertedOrgData?.phoneNumber, '+57 300 987 6543');
    assert.equal(result.user.phoneNumber, '+57 300 987 6543');
    assert.equal(result.organization.phoneNumber, '+57 300 987 6543');
  });

  console.log('='.repeat(80));
  console.log(`RESULTADO: APROBADO. ${passed}/5 pruebas de integración superadas.`);
}

void runSuite();
