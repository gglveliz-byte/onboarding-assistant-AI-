/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter.ts
 * @modulo 04-billing-and-whop (Pasarela de Cobros: Cliente HTTP Firmado y Verificador de Webhooks)
 * @proposito
 *   Concentra las dos fronteras con la pasarela de cobros. Hacia afuera crea las sesiones de pago y
 *   consulta estados remotos; hacia adentro delega la firma de los enlaces en `CheckoutLinkSigner` y
 *   la verificacion criptografica de los webhooks en `WebhookSignatureVerifier`. El adaptador solo
 *   conserva lo que exige hablar HTTP: endpoints, credenciales, timeouts y traduccion de errores.
 *   Ningun modulo debe calcular una firma de cobro por su cuenta: todo pasa por esta clase.
 *
 * @resumen_contenido
 *   - Interface `WhopApiAdapterOptions`: Credenciales, endpoints, tolerancia y timeouts.
 *   - Interfaces `WhopCheckoutSession` y `RemoteMembershipStatus`.
 *   - Clase `WhopApiAndHmacAdapter`:
 *       * `signCheckoutMetadata()`, `verifyCheckoutSignature()` y `buildSignedCheckoutUrl()`.
 *       * `createCheckoutSession()`: Creacion remota del enlace de pago.
 *       * `getCustomerPortalUrl()`: Acceso al portal de gestion del cliente.
 *       * `fetchMembershipStatus()`: Consulta autoritativa del estado de una membresia.
 *       * `verifyWebhookSignature()` y `assertValidWebhookSignature()`: Verificacion de firmas.
 *   - Fabrica `createWhopApiAdapterFromEnv()`: Construccion desde el contrato de entorno.
 *
 * @dependencias_internas
 *   - `CheckoutLinkSigner` (`./checkout-link.signer.ts`) para la firma de enlaces internos.
 *   - `WebhookSignatureVerifier` (`./webhook-signature.verifier.ts`) para las firmas entrantes.
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para credenciales, endpoints y tolerancia.
 *   - `ProviderUnavailableError` (`src/shared/kernel/result-and-errors.ts`) para fallos de red.
 *
 * @dependencias_externas
 *   - `fetch` nativo del runtime (Sin dependencias HTTP adicionales).
 *
 * @tablas_bd_o_redis
 *   - Redis: `whop:webhook:evt:<id>` (La verificacion precede a la marca de idempotencia).
 *   - PostgreSQL: `whop_subscriptions` (El estado remoto se refleja en esta tabla).
 */

import { getEnvConfig } from '../../../config/env.schema';
import { ProviderUnavailableError } from '../../../shared/kernel/result-and-errors';
import type { CheckoutSignedMetadata } from '../domain/billing-whop.types';
import { CheckoutLinkSigner } from './checkout-link.signer';
import {
  WebhookSignatureVerifier,
  type WhopSignatureVerification,
  type WhopWebhookHeaders,
} from './webhook-signature.verifier';

export type { BillingPlanCode, CheckoutMode, CheckoutSignedMetadata } from '../domain/billing-whop.types';
export type { WhopSignatureVerification, WhopWebhookHeaders } from './webhook-signature.verifier';

/** Parametros de construccion del adaptador de la pasarela. */
export interface WhopApiAdapterOptions {
  /** Clave de API del backend para llamar a la pasarela. */
  readonly apiKey: string;
  /** Secreto que firma los webhooks entrantes. */
  readonly webhookSecret: string;
  /** Secreto interno que firma los metadatos de los enlaces de pago. */
  readonly checkoutHmacSecret: string;
  /** URL base de la API de la pasarela. */
  readonly apiBaseUrl: string;
  /** URL base de la pagina de pago. */
  readonly checkoutBaseUrl: string;
  /** Tolerancia anti-repeticion de la marca temporal de firma, en segundos. */
  readonly webhookToleranceSeconds: number;
  /** Tiempo maximo de espera de cada llamada HTTP, en milisegundos. */
  readonly requestTimeoutMs?: number;
}

/** Enlace de pago emitido por la pasarela. */
export interface WhopCheckoutSession {
  /** Identificador de la sesion de pago creada. */
  readonly sessionId: string;
  /** URL a la que se redirige al cliente para completar el pago. */
  readonly checkoutUrl: string;
  /** Momento de expiracion de la sesion, en formato ISO 8601. */
  readonly expiresAtIso: string;
}

/** Estado remoto de una membresia consultado directamente a la pasarela. */
export interface RemoteMembershipStatus {
  /** Identificador de la membresia. */
  readonly membershipId: string;
  /** Identificador del plan contratado. */
  readonly externalPlanId: string;
  /** Indica si la membresia esta vigente. */
  readonly isValid: boolean;
  /** Estado textual declarado por el servicio. */
  readonly status: string;
  /** Fin del periodo de renovacion, en formato ISO 8601. */
  readonly periodEndIso: string | null;
}

/** Cuerpo enviado a la pasarela al crear una sesion de pago. */
interface CheckoutSessionRequestBody {
  readonly plan_id: string;
  readonly redirect_url: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly mode: string;
  readonly amount_usd?: string;
}

/** Tiempo maximo de espera por omision de cada llamada HTTP. */
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;

/** Minutos de vigencia por omision de una sesion de pago. */
const DEFAULT_SESSION_TTL_MINUTES = 30;

/** Milisegundos que componen un minuto. */
const MILLISECONDS_PER_MINUTE = 60000;

/**
 * Adaptador de la pasarela de cobros.
 * Delega la criptografia en los dos colaboradores especializados y conserva el transporte HTTP.
 */
export class WhopApiAndHmacAdapter {
  private readonly options: Required<WhopApiAdapterOptions>;
  private readonly checkoutSigner: CheckoutLinkSigner;
  private readonly webhookVerifier: WebhookSignatureVerifier;

  /**
   * @param options - Credenciales, endpoints, tolerancia y timeouts.
   * @throws Error cuando falta alguna credencial obligatoria.
   */
  public constructor(options: WhopApiAdapterOptions) {
    if (options.apiKey.trim().length === 0 || options.webhookSecret.trim().length === 0 || options.checkoutHmacSecret.trim().length === 0) {
      throw new Error('CREDENCIALES_DE_COBRO_INCOMPLETAS: se exigen la clave de API, el secreto de webhooks y el secreto de checkout.');
    }

    this.options = { ...options, requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS };
    this.checkoutSigner = new CheckoutLinkSigner({
      checkoutHmacSecret: options.checkoutHmacSecret,
      checkoutBaseUrl: options.checkoutBaseUrl,
    });
    this.webhookVerifier = new WebhookSignatureVerifier({
      webhookSecret: options.webhookSecret,
      toleranceSeconds: options.webhookToleranceSeconds,
    });
  }

  /**
   * Firma los metadatos de un enlace de pago.
   *
   * @param metadata - Metadatos del enlace, sin firma.
   * @returns Metadatos completos con la cadena firmada y su firma hexadecimal.
   */
  public signCheckoutMetadata(metadata: Omit<CheckoutSignedMetadata, 'signedPayload' | 'signatureHex'>): CheckoutSignedMetadata {
    return this.checkoutSigner.sign(metadata);
  }

  /**
   * Verifica la firma de los metadatos de un enlace de pago y su vigencia.
   *
   * @param metadata - Metadatos recibidos con su firma declarada.
   * @param nowMs - Instante de referencia usado para medir la antiguedad.
   * @returns `true` unicamente cuando la firma es valida y el enlace no ha expirado.
   */
  public verifyCheckoutSignature(metadata: CheckoutSignedMetadata, nowMs: number = Date.now()): boolean {
    return this.checkoutSigner.verify(metadata, nowMs);
  }

  /**
   * Compone la URL de pago con los metadatos firmados como parametros de consulta.
   *
   * @param metadata - Metadatos ya firmados.
   * @param externalPlanId - Identificador del plan en la pasarela.
   * @returns URL de pago lista para redirigir al cliente.
   */
  public buildSignedCheckoutUrl(metadata: CheckoutSignedMetadata, externalPlanId: string): string {
    return this.checkoutSigner.buildSignedUrl(metadata, externalPlanId);
  }

  /**
   * Verifica criptograficamente la firma de un webhook entrante.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido en la peticion.
   * @param headers - Cabeceras de firma normalizadas del webhook.
   * @param nowMs - Instante de referencia para la ventana anti-repeticion.
   * @returns Resultado detallado de la verificacion.
   */
  public verifyWebhookSignature(
    rawBodyBuffer: Buffer,
    headers: WhopWebhookHeaders,
    nowMs: number = Date.now()
  ): WhopSignatureVerification {
    return this.webhookVerifier.verify(rawBodyBuffer, headers, nowMs);
  }

  /**
   * Verifica la firma de un webhook y lanza un error controlado cuando es invalida.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido en la peticion.
   * @param headers - Cabeceras de firma normalizadas del webhook.
   * @param nowMs - Instante de referencia para la ventana anti-repeticion.
   * @returns Resultado de la verificacion cuando es valida.
   * @throws UnauthorizedError cuando la firma es invalida o la marca temporal esta fuera de ventana.
   */
  public assertValidWebhookSignature(
    rawBodyBuffer: Buffer,
    headers: WhopWebhookHeaders,
    nowMs: number = Date.now()
  ): WhopSignatureVerification {
    return this.webhookVerifier.assertValid(rawBodyBuffer, headers, nowMs);
  }

  /**
   * Crea una sesion de pago remota en la pasarela.
   *
   * @param externalPlanId - Identificador del plan contratado.
   * @param metadata - Metadatos firmados que acompanan la sesion.
   * @param redirectUrl - URL a la que la pasarela devuelve al cliente tras el pago.
   * @returns Sesion de pago creada con su enlace y su expiracion.
   * @throws ProviderUnavailableError cuando la pasarela no responde o rechaza la peticion.
   */
  public async createCheckoutSession(
    externalPlanId: string,
    metadata: CheckoutSignedMetadata,
    redirectUrl: string
  ): Promise<WhopCheckoutSession> {
    const requestBody: CheckoutSessionRequestBody = {
      plan_id: externalPlanId,
      redirect_url: redirectUrl,
      mode: metadata.checkoutMode === 'TOP_UP' ? 'payment' : 'subscription',
      metadata: {
        organization_id: metadata.organizationId,
        actor_user_id: metadata.actorUserId,
        internal_plan_code: metadata.internalPlanCode,
        checkout_signature: metadata.signatureHex,
      },
      ...(metadata.topUpAmountUsd === null ? {} : { amount_usd: metadata.topUpAmountUsd }),
    };

    const response = await this.performApiCall('POST', '/v2/checkouts', requestBody);
    const sessionId = this.readStringField(response, 'id');
    const checkoutUrl = this.readStringField(response, 'purchase_url') ?? this.readStringField(response, 'checkout_url');
    if (sessionId === null || checkoutUrl === null) {
      throw new ProviderUnavailableError('PRIMARY', 'la pasarela no devolvio el identificador ni el enlace de la sesion de pago');
    }

    return {
      sessionId,
      checkoutUrl,
      expiresAtIso:
        this.readStringField(response, 'expires_at') ??
        new Date(Date.now() + DEFAULT_SESSION_TTL_MINUTES * MILLISECONDS_PER_MINUTE).toISOString(),
    };
  }

  /**
   * Obtiene la URL del portal de gestion del cliente para una membresia dada.
   *
   * @param externalMembershipId - Identificador de la membresia en la pasarela.
   * @returns URL del portal de gestion.
   * @throws ProviderUnavailableError cuando la pasarela no devuelve el enlace.
   */
  public async getCustomerPortalUrl(externalMembershipId: string): Promise<string> {
    const response = await this.performApiCall('GET', `/v2/memberships/${encodeURIComponent(externalMembershipId)}/portal`, null);
    const portalUrl = this.readStringField(response, 'portal_url') ?? this.readStringField(response, 'url');
    if (portalUrl === null) {
      throw new ProviderUnavailableError('PRIMARY', 'la pasarela no devolvio la direccion del portal de gestion');
    }
    return portalUrl;
  }

  /**
   * Consulta el estado autoritativo de una membresia en la pasarela.
   * Se usa como fuente de verdad cuando un webhook no llega o cuando hay que reconciliar saldos.
   *
   * @param externalMembershipId - Identificador de la membresia en la pasarela.
   * @returns Estado remoto con su plan, su vigencia y su validez.
   * @throws ProviderUnavailableError cuando la pasarela no responde.
   */
  public async fetchMembershipStatus(externalMembershipId: string): Promise<RemoteMembershipStatus> {
    const response = await this.performApiCall('GET', `/v2/memberships/${encodeURIComponent(externalMembershipId)}`, null);
    return {
      membershipId: this.readStringField(response, 'id') ?? externalMembershipId,
      externalPlanId: this.readStringField(response, 'plan_id') ?? '',
      isValid: response['valid'] === true,
      status: this.readStringField(response, 'status') ?? 'desconocido',
      periodEndIso: this.readStringField(response, 'renewal_period_end'),
    };
  }

  /**
   * Ejecuta una llamada HTTP firmada contra la API de la pasarela.
   *
   * @param method - Metodo HTTP de la llamada.
   * @param path - Ruta relativa del recurso.
   * @param body - Cuerpo de la peticion, o `null` para llamadas sin cuerpo.
   * @returns Respuesta deserializada del servicio.
   * @throws ProviderUnavailableError cuando el servicio no responde, responde con error o devuelve
   *   un cuerpo que no es JSON valido.
   */
  private async performApiCall(
    method: 'GET' | 'POST',
    path: string,
    body: CheckoutSessionRequestBody | null
  ): Promise<Record<string, unknown>> {
    const requestUrl = `${this.options.apiBaseUrl.replace(/\/$/u, '')}${path}`;
    let response: Response;

    try {
      response = await fetch(requestUrl, {
        method,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        'PRIMARY',
        `la pasarela de cobros no respondio: ${error instanceof Error ? error.message : 'error de red'}`
      );
    }

    if (!response.ok) {
      throw new ProviderUnavailableError('PRIMARY', `la pasarela de cobros respondio con el estado ${response.status}`);
    }

    try {
      const parsed = (await response.json()) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new ProviderUnavailableError('PRIMARY', 'la pasarela de cobros devolvio un cuerpo que no es JSON valido');
    }
  }

  /**
   * Extrae un campo de texto no vacio de una respuesta del servicio.
   *
   * @param source - Respuesta deserializada.
   * @param fieldName - Nombre del campo buscado.
   * @returns Texto encontrado, o `null` cuando el campo no existe o no es una cadena util.
   */
  private readStringField(source: Record<string, unknown>, fieldName: string): string | null {
    const value = source[fieldName];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

/**
 * Construye el adaptador de la pasarela a partir del contrato de entorno ya validado.
 *
 * @returns Adaptador configurado con las credenciales, los endpoints y la tolerancia del entorno.
 */
export function createWhopApiAdapterFromEnv(): WhopApiAndHmacAdapter {
  const environment = getEnvConfig();
  return new WhopApiAndHmacAdapter({
    apiKey: environment.WHOP_API_KEY,
    webhookSecret: environment.WHOP_WEBHOOK_SECRET,
    checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
    apiBaseUrl: environment.WHOP_API_BASE_URL,
    checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
    webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
  });
}
