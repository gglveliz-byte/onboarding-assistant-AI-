/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/checkout-link.signer.ts
 * @modulo 04-billing-and-whop (Firma HMAC de los Enlaces de Pago Internos)
 * @proposito
 *   Firma y verifica los metadatos que viajan en cada enlace de pago. La firma impide que un cliente
 *   altere el plan, la organizacion o el importe reutilizando un enlace legitimo: sin ella, bastaria
 *   con cambiar el identificador de organizacion en la URL para cargar el consumo a otro tenant. Se
 *   separa del cliente HTTP de la pasarela porque la firma es criptografia del borde interno y debe
 *   poder probarse y reutilizarse sin levantar ninguna llamada de red.
 *
 * @resumen_contenido
 *   - Interface `CheckoutLinkSignerOptions`: Secreto interno y vigencia maxima del enlace.
 *   - Clase `CheckoutLinkSigner`:
 *       * `buildSigningPayload()`: Cadena canonica con orden de campos fijo.
 *       * `sign()`: Firma los metadatos y devuelve el sobre completo.
 *       * `verify()`: Verifica firma y vigencia en tiempo constante.
 *       * `buildSignedUrl()`: Compone la URL de pago con los metadatos firmados.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (`src/shared/kernel/crypto.util.ts`) para HMAC y comparacion en tiempo constante.
 *   - `CheckoutSignedMetadata` (`../domain/billing-whop.types.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Criptografia provista por el kernel de la plataforma).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `organizations` (La organizacion firmada viaja como metadato del enlace).
 */

import { CryptoUtils } from '../../../shared/kernel/crypto.util';
import type { CheckoutSignedMetadata } from '../domain/billing-whop.types';

/** Parametros de construccion del firmador de enlaces de pago. */
export interface CheckoutLinkSignerOptions {
  /** Secreto interno con el que se firman los metadatos del enlace. */
  readonly checkoutHmacSecret: string;
  /** URL base de la pagina de pago de la pasarela. */
  readonly checkoutBaseUrl: string;
  /** Vigencia maxima del enlace, en segundos. */
  readonly maxLinkAgeSeconds?: number;
}

/** Metadatos del enlace de pago antes de ser firmados. */
export type UnsignedCheckoutMetadata = Omit<CheckoutSignedMetadata, 'signedPayload' | 'signatureHex'>;

/** Vigencia por omision del enlace de pago, en segundos (15 minutos). */
const DEFAULT_MAX_LINK_AGE_SECONDS = 900;

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Firmador y verificador de enlaces de pago internos.
 * La cadena firmada tiene un orden de campos fijo y explicito: dos llamadas con los mismos datos
 * deben producir exactamente la misma cadena para que la firma sea verificable de forma aislada.
 */
export class CheckoutLinkSigner {
  private readonly checkoutHmacSecret: string;
  private readonly checkoutBaseUrl: string;
  private readonly maxLinkAgeSeconds: number;

  /**
   * @param options - Secreto interno, URL base de pago y vigencia maxima.
   * @throws Error cuando el secreto esta vacio.
   */
  public constructor(options: CheckoutLinkSignerOptions) {
    if (options.checkoutHmacSecret.trim().length === 0) {
      throw new Error('FIRMADOR_SIN_SECRETO: se exige el secreto interno de checkout para firmar los enlaces de pago.');
    }
    this.checkoutHmacSecret = options.checkoutHmacSecret;
    this.checkoutBaseUrl = options.checkoutBaseUrl;
    this.maxLinkAgeSeconds = options.maxLinkAgeSeconds ?? DEFAULT_MAX_LINK_AGE_SECONDS;
  }

  /**
   * Construye la cadena canonica que se firma en un enlace de pago.
   *
   * @param metadata - Metadatos del enlace, sin firma.
   * @returns Cadena canonica separada por puntos.
   */
  public buildSigningPayload(metadata: UnsignedCheckoutMetadata): string {
    return [
      metadata.organizationId,
      metadata.actorUserId,
      metadata.internalPlanCode,
      metadata.checkoutMode,
      metadata.topUpAmountUsd ?? '0.000000',
      String(metadata.issuedAtMs),
    ].join('.');
  }

  /**
   * Firma los metadatos de un enlace de pago con el secreto interno.
   *
   * @param metadata - Metadatos del enlace, sin firma.
   * @returns Metadatos completos con la cadena firmada y su firma hexadecimal.
   */
  public sign(metadata: UnsignedCheckoutMetadata): CheckoutSignedMetadata {
    const signedPayload = this.buildSigningPayload(metadata);
    return {
      ...metadata,
      signedPayload,
      signatureHex: CryptoUtils.hmacSha256Hex(this.checkoutHmacSecret, signedPayload),
    };
  }

  /**
   * Verifica la firma de los metadatos de un enlace de pago y su vigencia.
   *
   * @param metadata - Metadatos recibidos con su firma declarada.
   * @param nowMs - Instante de referencia usado para medir la antiguedad.
   * @returns `true` unicamente cuando la firma es valida y el enlace no ha expirado.
   */
  public verify(metadata: CheckoutSignedMetadata, nowMs: number = Date.now()): boolean {
    const expectedSignature = CryptoUtils.hmacSha256Hex(this.checkoutHmacSecret, metadata.signedPayload);
    if (!CryptoUtils.timingSafeEqualHex(expectedSignature, metadata.signatureHex)) {
      return false;
    }
    const ageSeconds = (nowMs - metadata.issuedAtMs) / MILLISECONDS_PER_SECOND;
    return ageSeconds >= 0 && ageSeconds <= this.maxLinkAgeSeconds;
  }

  /**
   * Compone la URL de pago con los metadatos firmados como parametros de consulta.
   * El secreto jamas se incluye en el enlace: solo viaja la firma.
   *
   * @param metadata - Metadatos ya firmados.
   * @param externalPlanId - Identificador del plan en la pasarela.
   * @returns URL de pago lista para redirigir al cliente.
   */
  public buildSignedUrl(metadata: CheckoutSignedMetadata, externalPlanId: string): string {
    const url = new URL(`${this.checkoutBaseUrl.replace(/\/$/u, '')}/${encodeURIComponent(externalPlanId)}`);
    url.searchParams.set('org', metadata.organizationId);
    url.searchParams.set('actor', metadata.actorUserId);
    url.searchParams.set('plan', metadata.internalPlanCode);
    url.searchParams.set('mode', metadata.checkoutMode);
    url.searchParams.set('issued_at', String(metadata.issuedAtMs));
    url.searchParams.set('sig', metadata.signatureHex);
    if (metadata.topUpAmountUsd !== null) {
      url.searchParams.set('amount', metadata.topUpAmountUsd);
    }
    return url.toString();
  }
}
