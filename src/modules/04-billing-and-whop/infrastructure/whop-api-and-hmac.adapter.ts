/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/whop-api-and-hmac.adapter.ts
 * @modulo 04-billing-and-whop (Pasarela de Cobros: Cliente Oficial, Firma de Enlaces y Webhooks)
 * @proposito
 *   Concentra las dos fronteras con la pasarela de cobros. Hacia afuera crea las sesiones de pago y
 *   consulta estados remotos a traves del cliente OFICIAL `@whop/sdk`; hacia adentro delega la firma de
 *   los enlaces en `CheckoutLinkSigner` y la verificacion criptografica de los webhooks en
 *   `WebhookSignatureVerifier`. Ningun modulo debe calcular una firma de cobro por su cuenta.
 *
 *   Esta clase reemplaza la version que construia URLs a mano contra `POST /v2/checkouts`. Ese endpoint
 *   NO EXISTE en la pasarela (la ruta real de la API v1 es `POST /api/v1/checkout_configurations`, y su
 *   equivalente v2, `POST /api/v2/checkout_sessions`, esta deprecada con vencimiento el 13-nov-2026),
 *   usaba la clave publica del app en lugar de la clave de la empresa, omitia `account_id` —parametro
 *   obligatorio— y enviaba `amount_usd`, un campo que la pasarela no reconoce. Ninguna suscripcion pudo
 *   activarse jamas por esa combinacion de errores.
 *
 *   Las recargas de saldo (`TOP_UP`) no tienen plan de precio fijo: se resuelven con el VARIANT inline
 *   que acepta `checkout_configurations`, que la pasarela busca-o-crea por atributos, de modo que dos
 *   recargas del mismo importe reutilizan el mismo variant en lugar de multiplicar el catalogo.
 *
 * @resumen_contenido
 *   - Interface `WhopApiAdapterOptions`: Credenciales, cuenta de empresa, tolerancia y cliente inyectable.
 *   - Interfaces `WhopCheckoutSession` y `RemoteMembershipStatus`.
 *   - Clase `WhopApiAndHmacAdapter`:
 *       * `signCheckoutMetadata()`, `verifyCheckoutSignature()` y `buildSignedCheckoutUrl()`.
 *       * `createCheckoutSession()`: creacion remota del enlace de pago.
 *       * `fetchMembershipStatus()`: consulta autoritativa del estado de una membresia.
 *       * `getCustomerPortalUrl()`: portal de autogestion leido del campo `manage_url`.
 *       * `verifyWebhookSignature()` y `assertValidWebhookSignature()`: verificacion de firmas.
 *   - Fabrica `createWhopApiAdapterFromEnv()`.
 *
 * @dependencias_internas
 *   - `CheckoutLinkSigner` (`./checkout-link.signer.ts`) para la firma de enlaces internos.
 *   - `WebhookSignatureVerifier` (`./webhook-signature.verifier.ts`) para las firmas entrantes.
 *   - `getWhopClient()` (`./whop-sdk-client.ts`) para el transporte autenticado.
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para credenciales y tolerancia.
 *
 * @dependencias_externas
 *   - `@whop/sdk` (`WhopClient`): cliente oficial versionado de la pasarela.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `whop_subscriptions` (El estado remoto se refleja en esta tabla).
 */

import type { WhopClient } from '@whop/sdk';
import { getEnvConfig } from '../../../config/env.schema';
import { ProviderUnavailableError } from '../../../shared/kernel/result-and-errors';
import type { CheckoutSignedMetadata } from '../domain/billing-whop.types';
import { getWhopClient } from './whop-sdk-client';
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
  /** Clave de API de la EMPRESA: la unica con permisos sobre checkout_configurations y memberships. */
  readonly companyApiKey: string;
  /** Identificador de la cuenta de empresa en la pasarela, con prefijo `biz_`. */
  readonly companyId: string;
  /** Secreto que firma los webhooks entrantes. */
  readonly webhookSecret: string;
  /** Secreto interno que firma los metadatos de los enlaces de pago. */
  readonly checkoutHmacSecret: string;
  /** URL base de la pagina de pago, usada para el enlace firmado local. */
  readonly checkoutBaseUrl: string;
  /** Tolerancia anti-repeticion de la marca temporal de firma, en segundos. */
  readonly webhookToleranceSeconds: number;
  /**
   * Cliente inyectado para pruebas. Cuando se omite, se obtiene el compartido del proceso,
   * ya autenticado con la clave de empresa y apuntando al entorno declarado.
   */
  readonly client?: WhopClient;
}

/** Enlace de pago emitido por la pasarela. */
export interface WhopCheckoutSession {
  /** Identificador de la configuracion de pago creada (`ch_...`). */
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
  /** Indica si la membresia esta vigente segun su `status`. */
  readonly isValid: boolean;
  /** Estado textual declarado por el servicio. */
  readonly status: string;
  /** Fin del periodo de renovacion, en formato ISO 8601. */
  readonly periodEndIso: string | null;
  /** Portal de autogestion del comprador; `null` cuando la pasarela no lo expone. */
  readonly manageUrl: string | null;
}

/** Vigencia por omision de una configuracion de pago, en minutos. */
const DEFAULT_SESSION_TTL_MINUTES = 30;

/** Milisegundos que componen un minuto. */
const MILLISECONDS_PER_MINUTE = 60000;

/** Estados de membresia que conceden acceso vigente. */
const CURRENT_STATUSES: readonly string[] = ['active', 'trialing'];

/** Dias del ciclo mensual usado como fallback cuando la pasarela no declara el fin de periodo. */
const MONTHLY_BILLING_PERIOD_DAYS = 30;

/**
 * Adaptador de la pasarela de cobros.
 * Delega la criptografia en los dos colaboradores especializados y el transporte en el SDK oficial.
 */
export class WhopApiAndHmacAdapter {
  private readonly options: WhopApiAdapterOptions;
  private readonly checkoutSigner: CheckoutLinkSigner;
  private readonly webhookVerifier: WebhookSignatureVerifier;

  /**
   * @param options - Credenciales, cuenta de empresa, tolerancia y cliente opcional.
   * @throws Error cuando falta la clave de empresa, el secreto o el identificador de la cuenta.
   */
  public constructor(options: WhopApiAdapterOptions) {
    if (options.companyApiKey.trim().length === 0) {
      throw new Error(
        'CREDENCIALES_DE_COBRO_INCOMPLETAS: se exige WHOP_COMPANY_API_KEY; la clave publica del app no tiene permisos de cobro.'
      );
    }
    if (options.webhookSecret.trim().length === 0 || options.checkoutHmacSecret.trim().length === 0) {
      throw new Error('CREDENCIALES_DE_COBRO_INCOMPLETAS: se exigen el secreto de webhooks y el secreto de checkout.');
    }
    if (!/^biz_[A-Za-z0-9_]+$/u.test(options.companyId)) {
      throw new Error(`CUENTA_DE_EMPRESA_INVALIDA: WHOP_COMPANY_ID debe tener el formato biz_... (recibido "${options.companyId}").`);
    }

    this.options = options;
    this.checkoutSigner = new CheckoutLinkSigner({
      checkoutHmacSecret: options.checkoutHmacSecret,
      checkoutBaseUrl: options.checkoutBaseUrl,
    });
    this.webhookVerifier = new WebhookSignatureVerifier({
      webhookSecret: options.webhookSecret,
      toleranceSeconds: options.webhookToleranceSeconds,
    });
  }

  /** Cliente de la pasarela usado por este adaptador. */
  private get client(): WhopClient {
    return this.options.client ?? getWhopClient();
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
   * Compone la URL local de pago con los metadatos firmados como parametros de consulta.
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
   * @returns Resultado detallado de la verificacion, con el payload ya parseado.
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
   * Crea una configuracion de pago remota en la pasarela.
   *
   * La metadata firmada viaja en el campo `metadata`, que la pasarela COPIA a la membresia y al pago
   * resultantes: es el unico canal legitimo para que un webhook posterior declare a que organizacion y
   * con que plan interno debe acreditarse el cobro.
   *
   * @param externalPlanId - Identificador del plan contratado (`plan_...`); vacio en las recargas.
   * @param metadata - Metadatos firmados que acompanan la sesion.
   * @param redirectUrl - URL a la que la pasarela devuelve al cliente tras el pago.
   * @returns Configuracion de pago creada con su enlace y su expiracion.
   * @throws ProviderUnavailableError cuando la pasarela no responde o no devuelve el enlace.
   */
  public async createCheckoutSession(
    externalPlanId: string,
    metadata: CheckoutSignedMetadata,
    redirectUrl: string
  ): Promise<WhopCheckoutSession> {
    const sharedRequest = {
      account_id: this.options.companyId,
      redirect_url: redirectUrl,
      mode: 'payment' as const,
      metadata: {
        organization_id: metadata.organizationId,
        actor_user_id: metadata.actorUserId,
        internal_plan_code: metadata.internalPlanCode,
        checkout_mode: metadata.checkoutMode,
        checkout_signature: metadata.signatureHex,
      },
    };

    // Una recarga no tiene plan de catalogo: se expresa como variant inline de pago unico. La pasarela
    // reutiliza el variant coincidente salvo que se force lo contrario, asi que el catalogo no crece.
    const request =
      metadata.checkoutMode === 'TOP_UP'
        ? {
            ...sharedRequest,
            plan: {
              account_id: this.options.companyId,
              plan_type: 'one_time' as const,
              currency: 'usd',
              initial_price: Number(metadata.topUpAmountUsd ?? '0'),
              unlimited_stock: true,
              visibility: 'hidden' as const,
              title: `Recarga de saldo ${metadata.topUpAmountUsd ?? '0'} USD`,
              force_create_new_plan: false,
            },
          }
        : { ...sharedRequest, plan_id: externalPlanId };

    const response = await this.runGatewayCall('crear la configuracion de pago', () =>
      this.client.checkoutConfigurations.create(request)
    );

    const sessionId = typeof response['id'] === 'string' ? response['id'] : null;
    const checkoutUrl = typeof response['purchase_url'] === 'string' ? response['purchase_url'] : null;
    if (sessionId === null || checkoutUrl === null) {
      throw new ProviderUnavailableError('PRIMARY', 'la pasarela no devolvio el identificador ni el enlace de la sesion de pago');
    }

    return {
      sessionId,
      checkoutUrl,
      expiresAtIso: new Date(Date.now() + DEFAULT_SESSION_TTL_MINUTES * MILLISECONDS_PER_MINUTE).toISOString(),
    };
  }

  /**
   * Consulta el estado autoritativo de una membresia en la pasarela.
   * Se usa como fuente de verdad cuando un webhook no llega o cuando hay que reconciliar saldos.
   *
   * @param externalMembershipId - Identificador de la membresia en la pasarela.
   * @returns Estado remoto con su plan, su vigencia y su portal de autogestion.
   * @throws ProviderUnavailableError cuando la pasarela no responde.
   */
  public async fetchMembershipStatus(externalMembershipId: string): Promise<RemoteMembershipStatus> {
    const response = await this.runGatewayCall('consultar la membresia', () =>
      this.client.memberships.retrieve({ id: externalMembershipId })
    );

    const status = typeof response['status'] === 'string' ? response['status'] : 'desconocido';
    return {
      membershipId: typeof response['id'] === 'string' ? response['id'] : externalMembershipId,
      externalPlanId: typeof response['plan_id'] === 'string' ? response['plan_id'] : '',
      // La pasarela no expone un booleano `valid`: la vigencia se deduce del ciclo de vida declarado.
      isValid: CURRENT_STATUSES.includes(status.toLowerCase()),
      status,
      periodEndIso: typeof response['current_period_end'] === 'string' ? response['current_period_end'] : null,
      manageUrl: typeof response['manage_url'] === 'string' ? response['manage_url'] : null,
    };
  }

  /**
   * Obtiene la URL del portal de autogestion del comprador para una membresia dada.
   *
   * La pasarela no publica un endpoint propio de portal: el enlace es el campo `manage_url` de la
   * membresia, unico por comprador y protegido por inicio de sesion.
   *
   * @param externalMembershipId - Identificador de la membresia en la pasarela.
   * @returns URL del portal de gestion.
   * @throws ProviderUnavailableError cuando la membresia no expone portal.
   */
  public async getCustomerPortalUrl(externalMembershipId: string): Promise<string> {
    const remoteStatus = await this.fetchMembershipStatus(externalMembershipId);
    if (remoteStatus.manageUrl === null || remoteStatus.manageUrl.length === 0) {
      throw new ProviderUnavailableError(
        'PRIMARY',
        `la pasarela no devolvio la direccion del portal de gestion para la membresia ${externalMembershipId}`
      );
    }
    return remoteStatus.manageUrl;
  }

  /**
   * Ejecuta una llamada del SDK traduciendo cualquier fallo a `ProviderUnavailableError`.
   *
   * @param operacion - Descripcion legible de la operacion, para el mensaje de error.
   * @param invocation - Llamada al cliente que resuelve en la respuesta de la pasarela.
   * @returns Cuerpo de la respuesta ya deserializado.
   * @throws ProviderUnavailableError cuando la pasarela no responde o responde con error.
   */
  private async runGatewayCall(
    operacion: string,
    invocation: () => Promise<{ toJSON?: unknown } | Record<string, unknown>> | { then: PromiseLike<unknown> }
  ): Promise<Record<string, unknown>> {
    try {
      const resolved = (await (invocation() as Promise<unknown>)) as unknown;
      return typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)
        ? (resolved as Record<string, unknown>)
        : {};
    } catch (error) {
      throw new ProviderUnavailableError(
        'PRIMARY',
        `no se pudo ${operacion}: ${error instanceof Error ? error.message : 'error de red de la pasarela'}`
      );
    }
  }
}

/**
 * Construye el adaptador de la pasarela a partir del contrato de entorno ya validado.
 *
 * @returns Adaptador configurado con la credencial de empresa, su identificador y la tolerancia.
 */
export function createWhopApiAdapterFromEnv(): WhopApiAndHmacAdapter {
  const environment = getEnvConfig();
  return new WhopApiAndHmacAdapter({
    companyApiKey: environment.WHOP_COMPANY_API_KEY,
    companyId: environment.WHOP_COMPANY_ID,
    webhookSecret: environment.WHOP_WEBHOOK_SECRET,
    checkoutHmacSecret: environment.INTERNAL_CHECKOUT_HMAC_SECRET,
    checkoutBaseUrl: environment.WHOP_CHECKOUT_BASE_URL,
    webhookToleranceSeconds: environment.WHOP_WEBHOOK_TOLERANCE_SECONDS,
  });
}
