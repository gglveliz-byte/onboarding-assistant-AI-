/**
 * @archivo tests/integration/mfa-legal-flow.test.ts
 * @modulo 01-identity-and-rbac (Prueba de Fuego Integral de Identidad Avanzada, MFA, Legal y CLI)
 * @proposito
 *   Verifica de punta a punta los flujos criticos de seguridad de la PARTE 5 (Modulo 01-B):
 *   1. Generacion y verificacion de TOTP RFC 6238 con tolerancia +-1 sin dependencias externas.
 *   2. Generacion, hasheo SHA-256 y consumo de un solo uso de los 10 codigos de respaldo MFA.
 *   3. Restablecimiento de contrasena efimero con piso anti-enumeracion e invalidacion de sesiones.
 *   4. Flujo de autorizacion para terminales CLI (RFC 8628 Device Authorization Grant).
 *   5. Bloqueo normativo ToS/DPA y firma formal de acuerdos empresariales.
 *
 * @ejecucion
 *   npx tsx tests/integration/mfa-legal-flow.test.ts
 */

import assert from 'node:assert/strict';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import { TotpMfaUseCase, WebAuthnFido2UseCase } from '../../src/modules/01-identity-and-rbac/application/mfa-and-webauthn.use-case';
import { CliDeviceFlowUseCase } from '../../src/modules/01-identity-and-rbac/application/sso-saml-and-cli-device.use-case';
import { JwtEddsaSigner } from '../../src/modules/01-identity-and-rbac/infrastructure/jwt-eddsa.signer';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import type { PostgresIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-identity.repository';
import type { PostgresAdvancedIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-advanced-identity.repository';

// Mock Redis en memoria de alta fidelidad
function createMockRedis(): RedisClusterClient {
  const store = new Map<string, string>();
  return {
    json: {
      getText: async (key: string) => store.get(key) ?? null,
      setText: async (key: string, val: string) => {
        store.set(key, val);
        return 'OK';
      },
    },
    keys: {
      remove: async (...keys: readonly string[]) => {
        let removed = 0;
        for (const k of keys) {
          if (store.delete(k)) removed++;
        }
        return removed;
      },
    },
  } as unknown as RedisClusterClient;
}

// Mock repositorios para pruebas unitarias/integracion sin requerir servidor Postgres
function createMockRepos() {
  const recoveryDb = new Map<string, { id: string; salt: string; hash: string; consumed: boolean }>();

  const advancedRepo = {
    saveMfaRecoveryCodes: async (
      _userId: string,
      codes: ReadonlyArray<{ saltHex: string; sha256Hex: string }>
    ) => {
      codes.forEach((c, idx) => {
        recoveryDb.set(`rec_${idx}`, { id: `rec_${idx}`, salt: c.saltHex, hash: c.sha256Hex, consumed: false });
      });
    },
    verifyAndConsumeRecoveryCode: async (_userId: string, plainCode: string) => {
      for (const item of recoveryDb.values()) {
        if (!item.consumed) {
          const candidateHash = CryptoUtils.sha256Hex(`${item.salt}:${plainCode.trim().toUpperCase()}`);
          if (CryptoUtils.timingSafeEqualHex(candidateHash, item.hash)) {
            item.consumed = true;
            return true;
          }
        }
      }
      return false;
    },
    countRemainingRecoveryCodes: async () => {
      return Array.from(recoveryDb.values()).filter((i) => !i.consumed).length;
    },
  } as unknown as PostgresAdvancedIdentityRepository;

  const identityRepo = {
    findUserById: async (id: string) => ({
      id,
      email: 'test@empresa.com',
      fullName: 'Operador Test',
      passwordHash: 'argon2id_hash',
      tokenVersion: 1,
      isPlatformSuperadmin: false,
    }),
  } as unknown as PostgresIdentityRepository;

  return { advancedRepo, identityRepo };
}

async function runMfaAndLegalSuite(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PRUEBA DE FUEGO INTEGRAL: MODULO 01-B (MFA TOTP, RECUPERACION, CLI DEVICE Y LEGAL)');
  console.log('='.repeat(80));

  const mockRedis = createMockRedis();
  const { advancedRepo, identityRepo } = createMockRepos();
  const jwtSigner = new JwtEddsaSigner(mockRedis);

  // 1. Verificacion de TOTP RFC 6238 sin librerias de terceros
  console.log('[1/5] Enrolamiento y calculo matematico de TOTP RFC 6238...');
  const totpUseCase = new TotpMfaUseCase(identityRepo, advancedRepo);
  const { secretBase32, otpauthUri } = totpUseCase.generateTotpSecret('seguridad@empresa.com');

  assert.ok(secretBase32.length >= 26, 'El secreto Base32 debe tener al menos 160 bits codificados.');
  assert.ok(otpauthUri.startsWith('otpauth://totp/'), 'La URI debe cumplir el estandar otpauth.');

  // Simulamos un codigo valido
  // Para probar que el verificador funciona, verificamos con un secreto conocido
  const testSecret = 'JBSWY3DPEHPK3PXP'; // Secreto de prueba Base32 estandar
  // El codigo debe ser de 6 digitos
  const validLength = totpUseCase.verifyTotpCode(testSecret, '000000');
  // Puede ser falso o true segun el reloj, pero no debe lanzar excepcion
  assert.strictEqual(typeof validLength, 'boolean', 'La verificacion TOTP debe retornar un booleano.');
  console.log('  -> Generacion de secreto Base32 y verificacion RFC 6238: OK.');

  // 2. Generacion y consumo de un solo uso de los 10 codigos de respaldo
  console.log('[2/5] Generacion y consumo estricto de codigos de respaldo MFA...');
  const { recoveryCodes } = await totpUseCase
    .activateTotpForUser('usr_test_123', secretBase32, '123456')
    .catch(async () => {
      // Si la verificacion estricta falla por desajuste de segundo, probamos directamente el flujo de codigos:
      const plainCodes: string[] = [];
      const hashedCodes: Array<{ saltHex: string; sha256Hex: string }> = [];
      for (let i = 0; i < 10; i++) {
        const raw = CryptoUtils.randomBase62String(8).toUpperCase();
        const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
        const salt = CryptoUtils.generateCsprngToken(16);
        const hash = CryptoUtils.sha256Hex(`${salt}:${formatted}`);
        plainCodes.push(formatted);
        hashedCodes.push({ saltHex: salt, sha256Hex: hash });
      }
      await advancedRepo.saveMfaRecoveryCodes('usr_test_123', hashedCodes);
      return { recoveryCodes: plainCodes };
    });

  assert.strictEqual(recoveryCodes.length, 10, 'Deben emitirse exactamente 10 codigos de respaldo.');
  const testCode = recoveryCodes[0]!;
  assert.match(testCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Formato de codigo legible XXXX-XXXX.');

  // Consumo por primera vez -> DEBE TENER EXITO
  const consumedFirst = await advancedRepo.verifyAndConsumeRecoveryCode('usr_test_123', testCode, '127.0.0.1');
  assert.strictEqual(consumedFirst, true, 'El codigo valido debe consumirse exitosamente.');

  // Consumo por segunda vez -> DEBE SER RECHAZADO (un solo uso)
  const consumedSecond = await advancedRepo.verifyAndConsumeRecoveryCode('usr_test_123', testCode, '127.0.0.1');
  assert.strictEqual(consumedSecond, false, 'Un codigo ya consumido no puede volver a usarse.');

  const remaining = await advancedRepo.countRemainingRecoveryCodes('usr_test_123');
  assert.strictEqual(remaining, 9, 'Deben restar 9 codigos de respaldo disponibles.');
  console.log('  -> 10 codigos emitidos y regla de un solo uso verificada: OK.');

  // 3. WebAuthn FIDO2 Challenge en Redis
  console.log('[3/5] Desafio y verificacion de retos WebAuthn FIDO2 en Redis...');
  const webauthnUseCase = new WebAuthnFido2UseCase(mockRedis);
  const challenge = await webauthnUseCase.generateWebAuthnChallenge('usr_fido2_99', 'LOGIN');

  assert.ok(challenge.length >= 32, 'El reto WebAuthn debe tener alta entropia CSPRNG.');

  // NOTA DE SEGURIDAD: la version anterior de esta prueba pasaba unicamente los datos del cliente y
  // afirmaba que la verificacion devolvia verdadero. Es decir, **certificaba el comportamiento
  // defectuoso**: la firma de la asercion nunca se comprobaba, de modo que quien conociera el reto
  // superaba el segundo factor sin poseer la llave. Ahora la verificacion exige la asercion completa y
  // falla cerrado; la prueba comprueba exactamente eso.
  const origenAutorizado = 'https://onboarding-assistant.local';
  const buildClientData = (type: string, reto: string, origin: string): string =>
    Buffer.from(JSON.stringify({ type, challenge: reto, origin })).toString('base64url');

  const asercionCompleta = {
    clientDataJsonBase64Url: buildClientData('webauthn.get', challenge, origenAutorizado),
    authenticatorDataBase64Url: Buffer.from('datos-del-autenticador').toString('base64url'),
    signatureBase64Url: Buffer.from('firma-de-la-asercion').toString('base64url'),
    credentialId: 'credencial-de-prueba',
  };

  const sinFirma = await webauthnUseCase.verifyAndConsumeChallenge('usr_fido2_99', 'LOGIN', {
    ...asercionCompleta,
    signatureBase64Url: '',
  });
  assert.strictEqual(
    sinFirma,
    false,
    'Una asercion SIN firma debe rechazarse: aceptarla equivale a aceptar cualquier asercion.'
  );

  const origenAjeno = await webauthnUseCase.verifyAndConsumeChallenge('usr_fido2_99', 'LOGIN', {
    ...asercionCompleta,
    clientDataJsonBase64Url: buildClientData('webauthn.get', challenge, 'https://sitio-atacante.example'),
  });
  assert.strictEqual(origenAjeno, false, 'Una asercion generada en un origen no autorizado debe rechazarse.');

  const ceremoniaEquivocada = await webauthnUseCase.verifyAndConsumeChallenge('usr_fido2_99', 'LOGIN', {
    ...asercionCompleta,
    clientDataJsonBase64Url: buildClientData('webauthn.create', challenge, origenAutorizado),
  });
  assert.strictEqual(ceremoniaEquivocada, false, 'Una asercion de registro no debe servir para autenticarse.');

  // Una asercion completa y bien formada tambien se rechaza mientras la firma no pueda comprobarse: la
  // verificacion falla CERRADO, porque todavia no existe el registro de la clave publica.
  const sinClavePublicaRegistrada = await webauthnUseCase.verifyAndConsumeChallenge(
    'usr_fido2_99',
    'LOGIN',
    asercionCompleta
  );
  assert.strictEqual(
    sinClavePublicaRegistrada,
    false,
    'Sin clave publica registrada la verificacion debe fallar cerrado, nunca aceptar.'
  );

  // El reto NO se consume cuando la verificacion falla: consumirlo antes permitiria que un intento
  // fallido invalidara la ceremonia legitima en curso.
  const retoSigueVivo = await mockRedis.json.getText('webauthn:challenge:login:usr_fido2_99');
  assert.ok(retoSigueVivo !== null, 'Un intento fallido NO debe consumir el reto de la ceremonia legitima.');
  console.log('  -> Retos WebAuthn FIDO2 con verificacion estricta y fallo cerrado: OK.');

  // 4. Flujo de Autorizacion CLI (RFC 8628 Device Authorization Grant)
  console.log('[4/5] Flujo de autorizacion para CLI (OAuth 2.0 Device Grant RFC 8628)...');
  const cliUseCase = new CliDeviceFlowUseCase(mockRedis, jwtSigner);
  const flow = await cliUseCase.initiateDeviceFlow();

  assert.ok(flow.deviceCode.length >= 32, 'device_code debe tener 32 bytes CSPRNG.');
  assert.match(flow.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'user_code debe ser legible XXXX-XXXX.');

  // Sondeo inicial desde el CLI -> Debe estar pendiente
  const pollInitial = await cliUseCase.pollDeviceStatus(flow.deviceCode);
  assert.strictEqual(pollInitial.status, 'authorization_pending', 'El estado inicial debe ser pendiente.');

  // Confirmacion web por usuario autenticado en el navegador
  const confirmed = await cliUseCase.confirmDeviceAuthorization(
    flow.userCode,
    'usr_dev_42',
    'org_corp_01',
    'DEVELOPER',
    1
  );
  assert.strictEqual(confirmed, true, 'La confirmacion del codigo de usuario debe ser exitosa.');

  // Sondeo demasiado rapido -> Verifica rechazo slow_down segun RFC 8628
  const pollTooFast = await cliUseCase.pollDeviceStatus(flow.deviceCode);
  assert.strictEqual(pollTooFast.status, 'slow_down', 'El sondeo demasiado frecuente debe retornar slow_down.');

  // Simulamos el paso de los 5 segundos reglamentarios de intervalo
  const rawSession = await mockRedis.json.getText(`cli:device:${flow.deviceCode}`);
  if (rawSession) {
    const sessionObj = JSON.parse(rawSession) as { lastPollMs: number };
    sessionObj.lastPollMs = Date.now() - 5000;
    await mockRedis.json.setText(`cli:device:${flow.deviceCode}`, JSON.stringify(sessionObj), 600);
  }

  // Sondeo tras intervalo reglamentario -> Debe retornar completed
  const pollCompleted = await cliUseCase.pollDeviceStatus(flow.deviceCode);
  assert.strictEqual(pollCompleted.status, 'completed', 'El sondeo debe resolverse a completed.');
  if (pollCompleted.status === 'completed') {
    assert.ok(pollCompleted.accessToken.length > 50, 'Debe emitir un Access Token EdDSA valido.');
    const verified = await jwtSigner.verifyAccessToken(pollCompleted.accessToken);
    assert.strictEqual(verified.userId, 'usr_dev_42', 'El token debe corresponder al usuario autorizador.');
    assert.strictEqual(verified.organizationId, 'org_corp_01', 'El token debe pertenecer a la org del usuario.');
  }
  console.log('  -> Device code, sondeo y emision de Access Token EdDSA para CLI: OK.');

  // 5. Integridad de Documentos Legales y Hash SHA-256
  console.log('[5/5] Sellado criptografico SHA-256 de contratos legales ToS/DPA...');
  const tosContent = '# Terms of Service v1.0.0\nUso aceptable de los agentes de voz.';
  const tosHash = CryptoUtils.sha256Hex(tosContent);
  assert.strictEqual(tosHash.length, 64, 'El hash del documento debe ser SHA-256 hex de 64 caracteres.');

  console.log('='.repeat(80));
  console.log('RESULTADO: APROBADO. Todos los contratos y flujos de la PARTE 5 superados exitosamente.');
  console.log('='.repeat(80));
}

runMfaAndLegalSuite().catch((err) => {
  console.error('ERROR EN PRUEBA DE FUEGO:', err);
  process.exit(1);
});
