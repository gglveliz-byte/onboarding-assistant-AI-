/**
 * @archivo src/modules/01-identity-and-rbac/application/sso-saml-and-cli-device.use-case.ts
 * @modulo 01-identity-and-rbac (Casos de Uso de SSO SAML 2.0 y Flujo de Dispositivo CLI RFC 8628)
 * @proposito
 *   Implementa la autenticacion corporativa federada SAML 2.0 para organizaciones con SSO forzado
 *   y el flujo estandar RFC 8628 (OAuth 2.0 Device Authorization Grant) para el CLI de desarrollo,
 *   permitiendo autenticar terminales sin navegador mediante un codigo de 8 caracteres legibles.
 *
 * @resumen_contenido
 *   - Clase `SsoSamlUseCase`: Generacion de AuthnRequest y consumo de respuestas ACS en fallo
 *     cerrado (firma XML, correlacion, vigencia, audiencia, destinatario y anti-replay).
 *   - Clase `CliDeviceFlowUseCase`: Emision de codigos de dispositivo, sondeo y confirmacion web.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (src/shared/kernel/crypto.util.ts).
 *   - `ValidationError`, `UnauthorizedError`, `NotFoundError` (src/shared/kernel/result-and-errors.ts).
 *   - `PostgresIdentityRepository` (../infrastructure/postgres-identity.repository.ts).
 *   - `JwtEddsaSigner` (../infrastructure/jwt-eddsa.signer.ts).
 *   - `RedisClusterClient` (src/shared/infrastructure/redis/redis-cluster.client.ts).
 *   - `ROLE_PERMISSIONS_MAP`, `RbacRole` (../domain/identity.entities.ts).
 */

import { CryptoUtils } from '@shared/kernel/crypto.util';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@shared/kernel/result-and-errors';
import type { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { ROLE_PERMISSIONS_MAP, type RbacRole } from '../domain/identity.entities';
import type { JwtEddsaSigner } from '../infrastructure/jwt-eddsa.signer';
import type { PostgresAdvancedIdentityRepository } from '../infrastructure/postgres-advanced-identity.repository';

/**
 * Tolerancia de reloj aceptada al comprobar la vigencia de la asercion, en milisegundos.
 */
const SAML_CLOCK_SKEW_MS = 300_000;

/**
 * Tamano maximo aceptado para una respuesta SAML decodificada, en caracteres (cota anti-DoS).
 */
const SAML_MAX_RESPONSE_CHARS = 262_144;

/**
 * Vigencia con la que se registra un identificador de peticion SAML en Redis, en segundos.
 */
const SAML_REQUEST_TTL_SECONDS = 300;

/**
 * Vigencia del sello anti-repeticion de cada asercion consumida en Redis, en segundos.
 */
const SAML_ASSERTION_TTL_SECONDS = 3600;

/**
 * Contexto de validacion exigido para consumir una respuesta SAML.
 *
 * Sin peticion no hay correlacion, sin audiencia ni destinatario seria aceptable una asercion
 * emitida para otro servicio, y sin `nowMs` las pruebas no podrian fijar el reloj.
 */
export interface SamlAcsValidationOptions {
  /** Identificador `ID` del `AuthnRequest` emitido por `initiateSamlLogin`. */
  readonly expectedRequestId: string;
  /** Audiencia esperada (`Audience`): identificador del proveedor de servicio de la plataforma. */
  readonly expectedAudience: string;
  /** Destinatario esperado (`Destination`/`Recipient`): URL del punto ACS de la plataforma. */
  readonly expectedRecipient: string;
  /** Reloj de referencia en milisegundos; por omision se usa el reloj del sistema. */
  readonly nowMs?: number;
}

/**
 * Caso de uso para Federacion de Identidad Corporativa SSO SAML 2.0 en fallo cerrado.
 *
 * Mientras la firma XML no pueda verificarse contra el certificado del proveedor, toda respuesta
 * se rechaza de forma explicita en lugar de aceptar la identidad declarada en el XML.
 */
export class SsoSamlUseCase {
  public constructor(
    private readonly advancedRepo: PostgresAdvancedIdentityRepository,
    private readonly redis: RedisClusterClient | null = null
  ) {}

  /**
   * Genera una solicitud SAML AuthnRequest para redirigir al IdP corporativo.
   */
  public async initiateSamlLogin(emailDomain: string, acsUrl: string): Promise<{ redirectUrl: string; requestId: string }> {
    const org = await this.advancedRepo.findOrganizationBySsoDomain(emailDomain);
    if (!org) {
      throw new NotFoundError('No existe una organización configurada para este dominio de correo corporativo.');
    }

    if (!org.ssoIdpEntrypointUrl) {
      throw new ValidationError('La organización no tiene configurada la URL de entrada del proveedor SAML.');
    }

    const requestId = `_oa_${CryptoUtils.generateCsprngToken(16)}`;
    const issueInstant = new Date().toISOString();

    const authnRequestXml = `
      <samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
        ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}"
        Destination="${org.ssoIdpEntrypointUrl}" AssertionConsumerServiceURL="${acsUrl}">
        <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://onboardingassistant.com/saml</saml:Issuer>
      </samlp:AuthnRequest>
    `.trim();

    const samlRequestBase64 = Buffer.from(authnRequestXml, 'utf8').toString('base64');
    const redirectUrl = `${org.ssoIdpEntrypointUrl}?SAMLRequest=${encodeURIComponent(samlRequestBase64)}&RelayState=${encodeURIComponent(org.id)}`;

    // El identificador se registra en Redis para correlacionar la respuesta (`InResponseTo`) con
    // una peticion realmente emitida. Sin registro no hay correlacion posible y el consumo debe
    // rechazar la respuesta en lugar de aceptar.
    if (this.redis !== null) {
      await this.redis.json.setText(`saml:request:${requestId}`, org.id, SAML_REQUEST_TTL_SECONDS);
    }

    return { redirectUrl, requestId };
  }

  /**
   * Consume la respuesta SAML del punto ACS y extrae la identidad federada.
   *
   * Comprueba en orden: decodificacion, correlacion `InResponseTo` en Redis, anti-repeticion,
   * vigencia, audiencia, destinatario, `NameID`, certificado del proveedor y firma XML. Solo
   * devuelve una identidad cuando todas se superan; una asercion fabricada nunca produce sesion.
   *
   * @param samlResponseBase64 - Respuesta SAML codificada en Base64 tal como la entrega el IdP.
   * @param options - Contexto de validacion con peticion, audiencia y destinatario esperados.
   * @returns Identidad federada con el correo verificado y su organizacion.
   * @throws UnauthorizedError cuando cualquier comprobacion falla o no puede realizarse.
   */
  public async processSamlAcsResponse(
    samlResponseBase64: string,
    options?: SamlAcsValidationOptions
  ): Promise<{ email: string; organizationId?: string }> {
    let xml: string;
    try {
      if (typeof samlResponseBase64 !== 'string' || samlResponseBase64.length === 0 || samlResponseBase64.length > 1_048_576) {
        throw new Error('carga SAML vacia o desmesurada');
      }
      xml = Buffer.from(samlResponseBase64, 'base64').toString('utf8');
    } catch {
      throw new UnauthorizedError('Error al decodificar la aserción de identidad SAML 2.0.');
    }

    if (xml.length === 0 || xml.length > SAML_MAX_RESPONSE_CHARS) {
      throw new UnauthorizedError('Respuesta SAML rechazada: tamaño fuera del límite permitido.');
    }
    if (/<!ENTITY/i.test(xml) || /<!DOCTYPE/i.test(xml)) {
      throw new UnauthorizedError('Respuesta SAML rechazada: declaración XML prohibida.');
    }

    const nowMs = options?.nowMs ?? Date.now();

    // 1. Correlacion: la respuesta debe responder a una peticion emitida por la plataforma.
    const inResponseTo = SsoSamlUseCase.extractFirstGroup(
      xml,
      /<samlp:Response[^>]*\bInResponseTo="([^"]+)"/i
    ) ?? SsoSamlUseCase.extractFirstGroup(xml, /<Response[^>]*\bInResponseTo="([^"]+)"/i);
    if (inResponseTo === null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: sin correlación con la petición emitida.');
    }
    if (options?.expectedRequestId === undefined || options.expectedRequestId.length === 0) {
      throw new UnauthorizedError('Respuesta SAML rechazada: falta el identificador de petición esperado.');
    }
    if (!CryptoUtils.timingSafeEqualUtf8(inResponseTo, options.expectedRequestId)) {
      throw new UnauthorizedError('Respuesta SAML rechazada: no corresponde a la petición emitida.');
    }
    if (this.redis === null) {
      throw new UnauthorizedError('Vía federada deshabilitada: sin registro de peticiones SAML.');
    }
    const requestKey = `saml:request:${options.expectedRequestId}`;
    const registeredOrgId = await this.redis.json.getText(requestKey);
    if (registeredOrgId === null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: petición desconocida o expirada.');
    }

    // 2. Repeticion: cada asercion se acepta una sola vez como maximo.
    const assertionId =
      SsoSamlUseCase.extractFirstGroup(xml, /<saml:Assertion[^>]*\bID="([^"]+)"/i) ??
      SsoSamlUseCase.extractFirstGroup(xml, /<Assertion[^>]*\bID="([^"]+)"/i);
    if (assertionId === null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: aserción sin identificador.');
    }
    const assertionKey = `saml:assertion:${assertionId}`;
    const alreadySeen = await this.redis.json.getText(assertionKey);
    if (alreadySeen !== null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: aserción ya utilizada.');
    }

    // 3. Vigencia: la asercion debe estar vigente en el reloj de referencia con tolerancia.
    const notBeforeMs = SsoSamlUseCase.parseSamlInstant(SsoSamlUseCase.extractFirstGroup(xml, /NotBefore="([^"]+)"/i));
    const notOnOrAfterMs = SsoSamlUseCase.parseSamlInstant(SsoSamlUseCase.extractFirstGroup(xml, /NotOnOrAfter="([^"]+)"/i));
    if (notBeforeMs === null || notOnOrAfterMs === null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: aserción sin ventana de vigencia.');
    }
    if (nowMs < notBeforeMs - SAML_CLOCK_SKEW_MS || nowMs >= notOnOrAfterMs + SAML_CLOCK_SKEW_MS) {
      throw new UnauthorizedError('Respuesta SAML rechazada: aserción fuera de vigencia.');
    }

    // 4. Audiencia: la asercion debe estar emitida para esta plataforma y no para otro servicio.
    const audience =
      SsoSamlUseCase.extractFirstGroup(xml, /<saml:Audience[^>]*>([^<]+)<\/saml:Audience>/i) ??
      SsoSamlUseCase.extractFirstGroup(xml, /<Audience[^>]*>([^<]+)<\/Audience>/i);
    if (options?.expectedAudience === undefined || options.expectedAudience.length === 0) {
      throw new UnauthorizedError('Respuesta SAML rechazada: falta la audiencia esperada.');
    }
    if (audience === null || !CryptoUtils.timingSafeEqualUtf8(audience, options.expectedAudience)) {
      throw new UnauthorizedError('Respuesta SAML rechazada: audiencia inválida.');
    }

    // 5. Destinatario: la respuesta debe estar dirigida al punto ACS de la plataforma.
    const destination =
      SsoSamlUseCase.extractFirstGroup(xml, /<samlp:Response[^>]*\bDestination="([^"]+)"/i) ??
      SsoSamlUseCase.extractFirstGroup(xml, /<Response[^>]*\bDestination="([^"]+)"/i) ??
      SsoSamlUseCase.extractFirstGroup(xml, /Recipient="([^"]+)"/i);
    if (options?.expectedRecipient === undefined || options.expectedRecipient.length === 0) {
      throw new UnauthorizedError('Respuesta SAML rechazada: falta el destinatario esperado.');
    }
    if (destination === null || !CryptoUtils.timingSafeEqualUtf8(destination, options.expectedRecipient)) {
      throw new UnauthorizedError('Respuesta SAML rechazada: destinatario inválido.');
    }

    // 6. Identificador nominal con formato de correo valido.
    const nameId =
      SsoSamlUseCase.extractFirstGroup(xml, /<saml:NameID[^>]*>([^<]+)<\/saml:NameID>/i) ??
      SsoSamlUseCase.extractFirstGroup(xml, /<NameID[^>]*>([^<]+)<\/NameID>/i);
    if (nameId === null) {
      throw new UnauthorizedError('La respuesta SAML no contiene un NameID o email válido.');
    }
    const email = nameId.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new UnauthorizedError('La respuesta SAML no contiene un NameID o email válido.');
    }

    // 7. Certificado del proveedor: se lee de la organizacion propietaria del dominio federado y
    // su ausencia deshabilita la via en lugar de omitir la verificacion de firma.
    const emailDomain = email.split('@')[1] ?? '';
    const org = await this.advancedRepo.findOrganizationBySsoDomain(emailDomain);
    if (!org || !org.ssoIdpX509Cert || org.ssoIdpX509Cert.trim().length === 0) {
      throw new UnauthorizedError('Vía federada deshabilitada: proveedor sin certificado configurado.');
    }

    // 8. Firma XML: debe existir y debe poder verificarse contra el certificado del proveedor.
    const signatureValue = SsoSamlUseCase.extractFirstGroup(xml, /<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i);
    if (!/<Signature[\s>]/i.test(xml) || signatureValue === null) {
      throw new UnauthorizedError('Respuesta SAML rechazada: aserción sin firma XML.');
    }
    if (!this.canVerifyXmlSignature(xml, org.ssoIdpX509Cert)) {
      throw new UnauthorizedError('Vía federada deshabilitada: firma SAML no verificable.');
    }

    // Solo se alcanza cuando la firma se ha verificado: se consume la peticion de un solo uso y
    // se sella el identificador de asercion para impedir su repeticion.
    await this.redis.keys.remove(requestKey);
    await this.redis.json.setText(assertionKey, 'consumed', SAML_ASSERTION_TTL_SECONDS);
    return { email, organizationId: org.id };
  }

  /**
   * Extrae el primer grupo de captura de un patron sobre el XML de la respuesta.
   *
   * @param xml - Respuesta SAML decodificada.
   * @param pattern - Expresion regular con un grupo de captura.
   * @returns Valor recortado, o `null` cuando el patron no aparece.
   */
  private static extractFirstGroup(xml: string, pattern: RegExp): string | null {
    const match = pattern.exec(xml);
    const raw = match?.[1];
    if (raw === undefined || raw.trim().length === 0) {
      return null;
    }
    return raw.trim();
  }

  /**
   * Interpreta una marca temporal SAML en formato ISO 8601 como milisegundos de epoca.
   *
   * @param raw - Marca temporal extraida del XML, o `null` cuando no existe.
   * @returns Milisegundos de epoca, o `null` cuando la marca falta o es invalida.
   */
  private static parseSamlInstant(raw: string | null): number | null {
    if (raw === null) {
      return null;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * Indica si la firma XML de la respuesta puede comprobarse contra el certificado del proveedor.
   *
   * Devuelve `false` mientras no exista un verificador de firmas XML-DSig con canonizacion (C14N)
   * registrado en la plataforma, de modo que el consumo **falla cerrado**. Aceptar una respuesta
   * sin comprobar su firma equivale a aceptar cualquier asercion fabricada, que es el defecto que
   * esta funcion tenia. Pendiente: verificador enveloped contra `ssoIdpX509Cert` (requiere nueva
   * dependencia criptografica y registro de certificados, fuera de la frontera de este carril).
   *
   * @param responseXml - Respuesta SAML decodificada.
   * @param idpCertificatePem - Certificado X.509 del proveedor guardado en la organizacion.
   * @returns `true` unicamente cuando la firma se ha verificado criptograficamente.
   */
  private canVerifyXmlSignature(responseXml: string, idpCertificatePem: string): boolean {
    void responseXml;
    void idpCertificatePem;
    return false;
  }
}

/** Estado de una sesion de autorizacion para dispositivo CLI. */
interface CliDeviceSessionData {
  deviceCode: string;
  userCode: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  userId?: string;
  organizationId?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAtMs: number;
  lastPollMs: number;
}

/**
 * Comprueba que el rol del flujo CLI pertenezca a la lista blanca cerrada (C1-42).
 *
 * @param value - Rol en texto plano proveniente de la confirmacion web.
 * @returns `true` solo cuando el valor es uno de los cinco roles reconocidos.
 */
function isCliDeviceRole(value: string): value is RbacRole {
  return value === 'SUPERADMIN' || value === 'OWNER' || value === 'DEVELOPER' || value === 'BILLING' || value === 'VIEWER';
}

/**
 * Caso de uso para autorizacion de CLI mediante Device Flow (RFC 8628).
 */
export class CliDeviceFlowUseCase {
  public constructor(
    private readonly redis: RedisClusterClient,
    private readonly jwtSigner: JwtEddsaSigner
  ) {}

  /**
   * Emite un par `device_code` y `user_code` legible (formato XXXX-XXXX) con TTL de 10 minutos.
   */
  public async initiateDeviceFlow(verificationUri = 'https://app.onboardingassistant.com/auth/cli-device'): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresInSeconds: number;
    intervalSeconds: number;
  }> {
    const deviceCode = CryptoUtils.generateCsprngToken(32);
    // 8 caracteres legibles Base32 (excluyendo caracteres ambiguos)
    const rawCode = CryptoUtils.randomBase62String(8).toUpperCase().replace(/[0O1I]/g, '9');
    const userCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`;

    const session: CliDeviceSessionData = {
      deviceCode,
      userCode,
      status: 'PENDING',
      expiresAtMs: Date.now() + 600 * 1000,
      lastPollMs: 0,
    };

    const ttlSeconds = 600;
    await this.redis.json.setText(`cli:device:${deviceCode}`, JSON.stringify(session), ttlSeconds);
    await this.redis.json.setText(`cli:user:${userCode}`, deviceCode, ttlSeconds);

    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresInSeconds: ttlSeconds,
      intervalSeconds: 5,
    };
  }

  /**
   * Sondeo de estado desde la terminal CLI con control de frecuencia (Rate Limit / Slow Down).
   */
  public async pollDeviceStatus(deviceCode: string): Promise<
    | { status: 'authorization_pending' }
    | { status: 'slow_down' }
    | { status: 'expired_token' }
    | { status: 'access_denied' }
    | { status: 'completed'; accessToken: string; refreshToken?: string }
  > {
    const raw = await this.redis.json.getText(`cli:device:${deviceCode}`);
    if (!raw) return { status: 'expired_token' };

    const session = JSON.parse(raw) as CliDeviceSessionData;
    if (Date.now() > session.expiresAtMs) {
      await this.redis.keys.remove(`cli:device:${deviceCode}`);
      return { status: 'expired_token' };
    }

    const now = Date.now();
    if (session.lastPollMs > 0 && now - session.lastPollMs < 4500) {
      return { status: 'slow_down' };
    }

    session.lastPollMs = now;
    await this.redis.json.setText(`cli:device:${deviceCode}`, JSON.stringify(session), Math.ceil((session.expiresAtMs - now) / 1000));

    if (session.status === 'PENDING') {
      return { status: 'authorization_pending' };
    }

    if (session.status === 'DENIED') {
      await this.redis.keys.remove(`cli:device:${deviceCode}`);
      return { status: 'access_denied' };
    }

    if (session.status === 'APPROVED' && session.accessToken) {
      await this.redis.keys.remove(`cli:device:${deviceCode}`);
      await this.redis.keys.remove(`cli:user:${session.userCode}`);
      return {
        status: 'completed',
        accessToken: session.accessToken,
        ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      };
    }

    return { status: 'authorization_pending' };
  }

  /**
   * Confirma la autorizacion del dispositivo desde la sesion autenticada en el navegador web.
   */
  public async confirmDeviceAuthorization(
    userCode: string,
    authorizedUserId: string,
    organizationId: string,
    role: string,
    tokenVersion: number
  ): Promise<boolean> {
    const normalizedUserCode = userCode.trim().toUpperCase();
    const deviceCode = await this.redis.json.getText(`cli:user:${normalizedUserCode}`);
    if (!deviceCode) return false;

    const raw = await this.redis.json.getText(`cli:device:${deviceCode}`);
    if (!raw) return false;

    const session = JSON.parse(raw) as CliDeviceSessionData;
    if (session.status !== 'PENDING') return false;

    // Emite Access Token EdDSA para el CLI con permisos del catalogo RBAC (C1-42); falla cerrado con rol invalido.
    if (!isCliDeviceRole(role)) {
      throw new ValidationError(`Rol no reconocido para la autorizacion del dispositivo CLI: [${role}].`);
    }
    const accessToken = await this.jwtSigner.signAccessToken({
      userId: authorizedUserId,
      organizationId,
      role,
      tokenVersion,
      mfaSatisfied: true,
      scopes: ROLE_PERMISSIONS_MAP[role],
    });

    session.status = 'APPROVED';
    session.userId = authorizedUserId;
    session.organizationId = organizationId;
    session.accessToken = accessToken;

    const remainingSecs = Math.max(10, Math.ceil((session.expiresAtMs - Date.now()) / 1000));
    await this.redis.json.setText(`cli:device:${deviceCode}`, JSON.stringify(session), remainingSecs);

    return true;
  }
}
