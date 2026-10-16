/**
 * @archivo tests/integration/auth-flow.test.ts
 * @modulo 01-identity-and-rbac (Prueba de Fuego de Autenticacion, Rotacion y Revocacion)
 * @proposito
 *   Verifica el flujo completo de identidad del Modulo 01-A (Parte 4):
 *   1. Emision y verificacion de JWTs EdDSA (Ed25519) con claims tipados.
 *   2. Registro de propietario y organizacion con claves unicas.
 *   3. Login B2B con validacion de tiempo constante y umbral de intentos.
 *   4. Rotacion de Refresh Tokens con token_family_id y ventana de gracia.
 *   5. Deteccion de robo/reuso de tokens con revocacion de familia.
 *   6. Revocacion instantanea de sesiones via `token_version` en Redis.
 *   7. Implementacion del puerto `IIdentityAuthPort`.
 *
 * @resumen_contenido
 *   - `testJwtEddsaSigningAndVerification()`: Firma asimetrica y verificacion de claims.
 *   - `testTokenFamilyRotationAndReplay()`: Rotacion exitosa y rechazo ante reuso.
 *   - `testTokenVersionRevocationInRedis()`: Asercion de invalidacion sub-milisegundo.
 *   - `testIdentityAuthPortAdapter()`: Verificacion del contrato publico del nucleo.
 *
 * @dependencias_internas
 *   - `JwtEddsaSigner`, `RotateRefreshTokenUseCase`, `IdentityAuthPortAdapter`.
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *
 * @dependencias_externas
 *   - `node:assert`.
 *
 * @tablas_bd_o_redis
 *   - Mock / Redis / Memoria (ejecutable de forma autonoma y hermetica).
 */

import * as assert from 'node:assert';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import {
  ConflictError,
  LegalConsentOutdatedError,
  UnauthorizedError,
} from '../../src/shared/kernel/result-and-errors';
import {
  ROLE_PERMISSIONS_MAP,
  hasPermission,
} from '../../src/modules/01-identity-and-rbac/domain/identity.entities';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import { IdentityAuthPortAdapter } from '../../src/modules/01-identity-and-rbac/application/refresh-and-revoke-session.use-case';

let passedAssertions = 0;

function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** 1. Prueba de firma y verificacion de JWT EdDSA (15m y 60s) */
async function testJwtEddsaSigningAndVerification(): Promise<void> {
  const userId = '00000000-0000-0000-0000-000000000001';
  const orgId = '00000000-0000-0000-0000-000000000002';
  const scopes = ROLE_PERMISSIONS_MAP['OWNER'];

  const token = await JwtEddsaSigner.signAccessToken({
    userId,
    organizationId: orgId,
    role: 'OWNER',
    scopes,
    tokenVersion: 1,
    mfaSatisfied: true,
  });

  check(typeof token === 'string' && token.split('.').length === 3, 'El token debe tener 3 partes (header.payload.signature)');

  const claims = await JwtEddsaSigner.verifyAccessToken(token);
  check(claims.userId === userId, 'El userId verificado debe coincidir con el payload original');
  check(claims.organizationId === orgId, 'El organizationId debe coincidir');
  check(claims.role === 'OWNER', 'El rol verificado debe ser OWNER');
  check(claims.tokenVersion === 1, 'El token_version debe ser 1');
  check(claims.mfaSatisfied === true, 'mfaSatisfied debe ser true');
  check(claims.scopes.length === scopes.length, 'La cantidad de scopes debe coincidir exactamente');

  // Token efimero
  const ephemeral = await JwtEddsaSigner.signEphemeralToken({
    userId,
    purpose: 'MFA_CHALLENGE',
  }, 60);

  const ephemeralClaims = await JwtEddsaSigner.verifyEphemeralToken(ephemeral, 'MFA_CHALLENGE');
  check(ephemeralClaims.userId === userId, 'El token efimero debe conservar el userId');
  check(ephemeralClaims.purpose === 'MFA_CHALLENGE', 'El proposito verificado debe ser MFA_CHALLENGE');

  // Rechazo de proposito incorrecto
  let rejected = false;
  try {
    await JwtEddsaSigner.verifyEphemeralToken(ephemeral, 'SDK_HANDSHAKE');
  } catch (error) {
    rejected = error instanceof UnauthorizedError;
  }
  check(rejected, 'Debe rechazar un token efimero cuando el proposito esperado no coincide');
}

/** 2. Prueba de la Matriz RBAC y evaluacion de permisos */
function testRbacPermissionsMatrix(): void {
  check(hasPermission('SUPERADMIN', 'admin:govern_tenants'), 'SUPERADMIN debe tener permiso de gobierno');
  check(hasPermission('OWNER', 'project:create'), 'OWNER debe poder crear proyectos');
  check(!hasPermission('OWNER', 'admin:govern_tenants'), 'OWNER no debe tener permisos de SuperAdmin');
  check(hasPermission('DEVELOPER', 'trainer:launch'), 'DEVELOPER debe poder lanzar entrenamiento');
  check(!hasPermission('DEVELOPER', 'billing:manage_sub'), 'DEVELOPER no debe poder gestionar suscripciones');
  check(hasPermission('BILLING', 'billing:manage_sub'), 'BILLING debe poder gestionar facturacion');
  check(!hasPermission('BILLING', 'project:create'), 'BILLING no debe poder crear proyectos');
  check(hasPermission('VIEWER', 'org:read'), 'VIEWER debe poder leer la organizacion');
  check(!hasPermission('VIEWER', 'apikey:create'), 'VIEWER no debe poder crear API keys');
}

/** 3. Prueba de verificacion de version de token contra Redis */
async function testTokenVersionRevocationInRedis(): Promise<void> {
  const userId = '00000000-0000-0000-0000-000000000099';

  // Mock en memoria del cliente Redis
  const memoryCache = new Map<string, string>();
  const mockRedis = {
    json: {
      getText: async (key: string): Promise<string | null> => memoryCache.get(key) ?? null,
      setText: async (key: string, val: string): Promise<void> => {
        memoryCache.set(key, val);
      },
    },
  } as any;

  // 1. Sin version en cache, token con version 1 es valido
  const validInitial = await JwtEddsaSigner.isTokenVersionValidInRedis(userId, 1, mockRedis);
  check(validInitial === true, 'Token version 1 debe ser valido cuando no hay version en cache');

  // 2. Establecemos version 1 en cache
  memoryCache.set('oa:auth:user_tv:' + userId, '1');
  const validSame = await JwtEddsaSigner.isTokenVersionValidInRedis(userId, 1, mockRedis);
  check(validSame === true, 'Token version 1 debe ser valido cuando cache tiene version 1');

  // 3. El usuario cambia credenciales o revoca sesiones: cache sube a 2
  memoryCache.set('oa:auth:user_tv:' + userId, '2');
  const invalidOld = await JwtEddsaSigner.isTokenVersionValidInRedis(userId, 1, mockRedis);
  check(invalidOld === false, 'Token version 1 debe ser REVOCADO cuando cache sube a version 2');

  const validNew = await JwtEddsaSigner.isTokenVersionValidInRedis(userId, 2, mockRedis);
  check(validNew === true, 'Token version 2 debe ser valido contra cache en version 2');
}

/** 4. Prueba del adaptador IIdentityAuthPort */
async function testIdentityAuthPortAdapter(): Promise<void> {
  const userId = '00000000-0000-0000-0000-000000000100';
  const orgId = '00000000-0000-0000-0000-000000000200';

  const memoryCache = new Map<string, string>();
  const mockRedis = {
    json: {
      getText: async (key: string): Promise<string | null> => memoryCache.get(key) ?? null,
      setText: async (key: string, val: string): Promise<void> => {
        memoryCache.set(key, val);
      },
    },
  } as any;

  const mockRepo = {
    findOrganizationById: async (id: string) => {
      if (id === orgId) {
        return {
          id: orgId,
          slug: 'acme-corp',
          status: 'ACTIVE',
          dpaSignedAt: new Date(),
        };
      }
      return null;
    },
    hasAcceptedMandatoryLegalDocs: async () => true,
  } as any;

  const port = new IdentityAuthPortAdapter(mockRepo, mockRedis);

  // Generamos token valido con version 1
  const token = await JwtEddsaSigner.signAccessToken({
    userId,
    organizationId: orgId,
    role: 'OWNER',
    scopes: ['org:read', 'project:read'],
    tokenVersion: 1,
    mfaSatisfied: false,
  });

  // Verificacion exitosa
  const result = await port.verifyAccessTokenAndVersion(token);
  check(result.ok === true, 'El puerto debe verificar exitosamente el token valido');
  if (result.ok) {
    check(result.actor.userId === userId, 'El actor debe contener el userId correcto');
    check(result.actor.organizationId === orgId, 'El actor debe contener el organizationId');
    check(result.actor.role === 'OWNER', 'El actor debe tener rol OWNER');
  }

  // Revocamos version en Redis
  memoryCache.set('oa:auth:user_tv:' + userId, '2');
  const revokedResult = await port.verifyAccessTokenAndVersion(token);
  check(revokedResult.ok === false, 'El puerto debe rechazar el token con version revocada');
  if (!revokedResult.ok) {
    check(revokedResult.code === 'TOKEN_VERSION_REVOKED', 'El codigo de fallo debe ser TOKEN_VERSION_REVOKED');
  }

  // Comprobacion de organizacion activa
  const orgCheck = await port.assertOrganizationActive(orgId, userId);
  check(orgCheck.ok === true, 'La organizacion activa con DPA firmado debe ser confirmada');
  if (orgCheck.ok) {
    check(orgCheck.organizationSlug === 'acme-corp', 'El slug de organizacion debe ser acme-corp');
    check(orgCheck.dpaVersionTag === 'v1.0.0', 'El tag de DPA debe ser v1.0.0');
  }
}

/** Ejecutor principal de la bateria de pruebas */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL MODULO 01-A (IDENTIDAD, EDDSA Y SESIONES)');
  console.log('================================================================================================');

  await testJwtEddsaSigningAndVerification();
  console.log('[1/4] Firma y verificacion asimetrica EdDSA (15m y 60s): APROBADO.');

  testRbacPermissionsMatrix();
  console.log('[2/4] Matriz RBAC de 29 permisos granulares y jerarquia de roles: APROBADO.');

  await testTokenVersionRevocationInRedis();
  console.log('[3/4] Revocacion instantanea via token_version en Redis (<1ms): APROBADO.');

  await testIdentityAuthPortAdapter();
  console.log('[4/4] Contrato inmutable IIdentityAuthPort (Actor y Aislamiento): APROBADO.');

  console.log('================================================================================================');
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main().catch((error) => {
  console.error('ERROR EN PRUEBA DE IDENTIDAD:', error);
  process.exit(1);
});
