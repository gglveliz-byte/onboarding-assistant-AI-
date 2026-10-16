/**
 * @archivo tests/integration/saml-federated-rejection.test.ts
 * @modulo 01-identity-and-rbac (Prueba de Rechazo Federado SAML C1-34 en Fallo Cerrado)
 * @proposito
 *   Demuestra que la via federada SAML 2.0 rechaza de forma explicita toda asercion fabricada:
 *   1. Una respuesta construida a mano con identificador arbitrario y firma inventada, tal como
 *      describe la reproduccion del hallazgo C1-34, no produce ninguna identidad.
 *   2. Ni siquiera una respuesta estructuralmente completa (correlacion registrada en Redis,
 *      vigencia, audiencia y destinatario correctos, certificado configurado) se acepta mientras
 *      la firma XML no pueda verificarse criptograficamente.
 *   3. El identificador de peticion emitido por `initiateSamlLogin` queda persistido en Redis
 *      para permitir la correlacion `InResponseTo`, y un intento fallido no lo consume.
 *
 * @ejecucion
 *   npx tsx tests/integration/saml-federated-rejection.test.ts
 */

import assert from 'node:assert/strict';
import { SsoSamlUseCase } from '../../src/modules/01-identity-and-rbac/application/sso-saml-and-cli-device.use-case';
import type { PostgresAdvancedIdentityRepository } from '../../src/modules/01-identity-and-rbac/infrastructure/postgres-advanced-identity.repository';
import type { RedisClusterClient } from '../../src/shared/infrastructure/redis/redis-cluster.client';
import { UnauthorizedError } from '../../src/shared/kernel/result-and-errors';

/** Audiencia esperada del proveedor de servicio en las pruebas. */
const EXPECTED_AUDIENCE = 'https://onboardingassistant.com/saml';

/** Destinatario esperado del punto ACS en las pruebas. */
const EXPECTED_RECIPIENT = 'https://app.onboardingassistant.com/acs';

/** Redis en memoria de alta fidelidad para correlacion y anti-replay. */
function createMockRedis(): RedisClusterClient {
  const store = new Map<string, string>();
  return {
    json: {
      getText: async (key: string): Promise<string | null> => store.get(key) ?? null,
      setText: async (key: string, value: string): Promise<string> => {
        store.set(key, value);
        return 'OK';
      },
    },
    keys: {
      remove: async (...keys: readonly string[]): Promise<number> => {
        let removed = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            removed += 1;
          }
        }
        return removed;
      },
    },
  } as unknown as RedisClusterClient;
}

/**
 * Repositorio avanzado simulado con una organizacion federada para `corp.example`.
 *
 * @param withCertificate - Indica si la organizacion tiene certificado del proveedor configurado.
 */
function createMockAdvancedRepo(withCertificate: boolean): PostgresAdvancedIdentityRepository {
  return {
    findOrganizationBySsoDomain: async (domain: string) => {
      if (domain !== 'corp.example') {
        return null;
      }
      return {
        id: 'org_federada_01',
        name: 'Corporacion Ejemplo',
        slug: 'corp-example',
        status: 'ACTIVE',
        enforceMfa: false,
        enforceSso: true,
        ssoIdpMetadataXml: null,
        ssoIdpEntrypointUrl: 'https://idp-legitimo.example/sso',
        ssoIdpX509Cert: withCertificate ? 'CERTIFICADO_X509_DEL_PROVEEDOR' : null,
        ssoEmailDomain: 'corp.example',
        optInSessionTranscripts: false,
        dpaSignedAt: null,
        dpaClickwrapIp: null,
        suspendedReason: null,
        suspendedAt: null,
        suspendedByUserId: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    },
  } as unknown as PostgresAdvancedIdentityRepository;
}

/**
 * Construye una respuesta SAML fabricada a mano con firma inventada.
 *
 * @param overrides - Campos que sustituyen los valores coherentes por omision.
 * @returns Respuesta codificada en Base64 tal como llegaria al punto ACS.
 */
function buildForgedSamlResponse(overrides?: {
  inResponseTo?: string;
  assertionId?: string;
  audience?: string;
  destination?: string;
  nameId?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  withSignature?: boolean;
}): string {
  const now = Date.now();
  const inResponseTo = overrides?.inResponseTo ?? '_oa_peticion_inventada';
  const assertionId = overrides?.assertionId ?? '_asercion_fabricada_01';
  const audience = overrides?.audience ?? EXPECTED_AUDIENCE;
  const destination = overrides?.destination ?? EXPECTED_RECIPIENT;
  const nameId = overrides?.nameId ?? 'victima@corp.example';
  const notBefore = overrides?.notBefore ?? new Date(now - 60_000).toISOString();
  const notOnOrAfter = overrides?.notOnOrAfter ?? new Date(now + 300_000).toISOString();
  const withSignature = overrides?.withSignature ?? true;
  const signatureBlock = withSignature
    ? '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></SignedInfo><SignatureValue>FIRMA_TOTALMENTE_INVENTADA</SignatureValue></Signature>'
    : '';
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_respuesta_fabricada" InResponseTo="${inResponseTo}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${destination}"><saml:Issuer>https://idp-fabricado.example/metadata</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" IssueInstant="${new Date(now).toISOString()}" Version="2.0"><saml:Issuer>https://idp-fabricado.example/metadata</saml:Issuer>${signatureBlock}<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${destination}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion></samlp:Response>`;
  return Buffer.from(xml, 'utf8').toString('base64');
}

/**
 * Comprueba que una operacion rechaza la respuesta con `UnauthorizedError`.
 *
 * @param operation - Operacion de consumo SAML a evaluar.
 * @param description - Descripcion del caso para el reporte.
 * @returns Mensaje del error de rechazo para aserciones adicionales.
 */
async function expectSamlRejection(operation: () => Promise<unknown>, description: string): Promise<string> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof UnauthorizedError, `${description}: debe rechazarse con UnauthorizedError.`);
    return (error as UnauthorizedError).message;
  }
  assert.fail(`${description}: la aserción fabricada fue ACEPTADA, debe rechazarse.`);
}

/** Ejecuta la bateria de rechazo federado del hallazgo C1-34. */
async function runSamlRejectionSuite(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PRUEBA DE RECHAZO FEDERADO SAML C1-34 (FALLO CERRADO ANTE ASERCION FABRICADA)');
  console.log('='.repeat(80));

  // [1/5] Reproduccion literal del hallazgo: NameID arbitrario + firma inventada, sin contexto.
  console.log('[1/5] Aserción fabricada sin contexto de validación...');
  const casoBase = new SsoSamlUseCase(createMockAdvancedRepo(true), createMockRedis());
  const mensajeBase = await expectSamlRejection(
    () => casoBase.processSamlAcsResponse(buildForgedSamlResponse()),
    'Aserción fabricada sin contexto'
  );
  console.log(`  -> Rechazada: ${mensajeBase}`);

  // [2/5] `initiateSamlLogin` persiste el identificador para permitir la correlacion posterior.
  console.log('[2/5] Persistencia del identificador de petición en Redis...');
  const redisCorrelado = createMockRedis();
  const casoCorrelado = new SsoSamlUseCase(createMockAdvancedRepo(true), redisCorrelado);
  const inicio = await casoCorrelado.initiateSamlLogin('corp.example', EXPECTED_RECIPIENT);
  assert.ok(inicio.requestId.startsWith('_oa_'), 'El identificador debe tener el prefijo de la plataforma.');
  const registrado = await redisCorrelado.json.getText(`saml:request:${inicio.requestId}`);
  assert.strictEqual(registrado, 'org_federada_01', 'El identificador debe quedar registrado con la organización.');
  console.log('  -> Petición registrada para correlación InResponseTo: OK.');

  // [3/5] Respuesta completa y correlacionada pero con firma inventada: se rechaza por firma.
  console.log('[3/5] Aserción correlacionada con firma inventada...');
  const fabricadaCorrelacionada = buildForgedSamlResponse({ inResponseTo: inicio.requestId });
  const mensajeFirma = await expectSamlRejection(
    () =>
      casoCorrelado.processSamlAcsResponse(fabricadaCorrelacionada, {
        expectedRequestId: inicio.requestId,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedRecipient: EXPECTED_RECIPIENT,
      }),
    'Aserción correlacionada con firma inventada'
  );
  console.log(`  -> Rechazada: ${mensajeFirma}`);

  // [4/5] El intento fallido no consume la peticion legitima en curso.
  console.log('[4/5] La petición legítima sobrevive al intento fallido...');
  const peticionViva = await redisCorrelado.json.getText(`saml:request:${inicio.requestId}`);
  assert.ok(peticionViva !== null, 'Un intento fallido NO debe consumir la petición legítima en curso.');
  const mensajeReintento = await expectSamlRejection(
    () =>
      casoCorrelado.processSamlAcsResponse(fabricadaCorrelacionada, {
        expectedRequestId: inicio.requestId,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedRecipient: EXPECTED_RECIPIENT,
      }),
    'Reintento de la aserción fabricada'
  );
  console.log(`  -> Reintento rechazado: ${mensajeReintento}`);

  // [5/5] Sin certificado del proveedor configurado la vía se deshabilita de forma explícita.
  console.log('[5/5] Proveedor sin certificado configurado...');
  const redisSinCert = createMockRedis();
  const casoSinCert = new SsoSamlUseCase(createMockAdvancedRepo(false), redisSinCert);
  const inicioSinCert = await casoSinCert.initiateSamlLogin('corp.example', EXPECTED_RECIPIENT);
  const mensajeSinCert = await expectSamlRejection(
    () =>
      casoSinCert.processSamlAcsResponse(buildForgedSamlResponse({ inResponseTo: inicioSinCert.requestId }), {
        expectedRequestId: inicioSinCert.requestId,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedRecipient: EXPECTED_RECIPIENT,
      }),
    'Proveedor sin certificado'
  );
  assert.ok(
    mensajeSinCert.includes('certificado'),
    'El rechazo debe explicar que falta el certificado del proveedor.'
  );
  console.log(`  -> Rechazada: ${mensajeSinCert}`);

  console.log('='.repeat(80));
  console.log('RESULTADO: APROBADO. Toda aserción fabricada se rechaza en fallo cerrado (C1-34).');
  console.log('='.repeat(80));
}

runSamlRejectionSuite().catch((error) => {
  console.error('ERROR EN PRUEBA DE FUEGO:', error);
  process.exit(1);
});
