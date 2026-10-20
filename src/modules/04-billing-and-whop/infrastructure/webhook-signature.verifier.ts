/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/webhook-signature.verifier.ts
 * @modulo 04-billing-and-whop (Verificador Criptografico de Firmas de Webhook)
 * @proposito
 *   Comprueba la autenticidad de cada webhook entrante delegando en el helper OFICIAL de la pasarela
 *   (`unwrapWebhook`), que aplica el esquema Standard Webhooks: HMAC-SHA256 sobre
 *   `{webhook-id}.{webhook-timestamp}.{cuerpo crudo}`, codificado en Base64 y presentado con prefijo
 *   `v1,`, con ventana de 5 minutos sobre `webhook-timestamp`.
 *
 *   La version anterior calculaba el HMAC a mano sobre `{timestamp}.{cuerpo}` y lo comparaba en
 *   hexadecimal, y ademas exigia las cabeceras `x-whop-timestamp` / `x-whop-signature`, que la
 *   pasarela no envia. Las dos cosas son incompatibles con el contrato real: ninguna firma legitima
 *   cuadraba y toda entrega se rechazaba con 401. Mantener un HMAC manual esta prohibido cuando el
 *   SDK expone el helper, porque el esquema puede cambiar sin avisar y el calculo propio queda
 *   obsoleto en silencio.
 *
 *   El cuerpo se recibe como `Buffer` intacto: la firma cubre los bytes exactos, y re-serializar el
 *   JSON (reordenar claves o normalizar espacios) invalida firmas legitimas.
 *
 * @resumen_contenido
 *   - Interface `WebhookVerifierOptions`: Secreto de firma y tolerancia anti-repeticion.
 *   - Interface `WhopWebhookHeaders`: Cabeceras normalizadas exigidas por Standard Webhooks.
 *   - Interface `WhopSignatureVerification`: Resultado detallado con el motivo del rechazo y el evento
 *     ya deserializado, para que el llamador no vuelva a parsear el cuerpo.
 *   - Clase `WebhookSignatureVerifier`: `verify()` y `assertValid()`.
 *
 * @dependencias_internas
 *   - `UnauthorizedError` (`src/shared/kernel/result-and-errors.ts`) para el rechazo estricto.
 *
 * @dependencias_externas
 *   - `@whop/sdk/helpers` (`unwrapWebhook`, `WebhookVerificationError`): verificacion oficial.
 *
 * @tablas_bd_o_redis
 *   - Redis: `whop:webhook:evt:<id>` (La verificacion siempre precede a la marca de idempotencia).
 */

import { unwrapWebhook, WebhookVerificationError } from '@whop/sdk/helpers';
import { UnauthorizedError } from '../../../shared/kernel/result-and-errors';

/** Parametros de construccion del verificador de firmas. */
export interface WebhookVerifierOptions {
  /** Secreto con el que la pasarela firma sus webhooks, tal como lo muestra el panel. */
  readonly webhookSecret: string;
  /** Tolerancia anti-repeticion de la marca temporal, en segundos. */
  readonly toleranceSeconds: number;
}

/**
 * Cabeceras de firma normalizadas de un webhook entrante.
 *
 * Solo se declaran las tres cabeceras que el estandar fija y que la pasarela envia: `webhook-id`,
 * `webhook-timestamp` y `webhook-signature`. NO existe cabecera de tipo de evento: el nombre del
 * evento viaja en el campo `type` del cuerpo JSON.
 */
export interface WhopWebhookHeaders {
  /** Identificador unico del evento (`msg_...`), base de la idempotencia. */
  readonly eventId: string;
  /** Marca temporal de emision declarada por el emisor, en segundos desde el epoch. */
  readonly timestampHeader: string;
  /** Firma declarada en Base64 con su prefijo de version (`v1,<base64>`). */
  readonly signatureHeader: string;
}

/** Resultado detallado de la verificacion de firma de un webhook. */
export interface WhopSignatureVerification {
  /** Indica si la firma es valida y la marca temporal esta dentro de la ventana permitida. */
  readonly valid: boolean;
  /** Motivo del rechazo cuando la verificacion falla. */
  readonly rejectionReason: string | null;
  /** Momento declarado por el emisor, ya normalizado a milisegundos. */
  readonly declaredTimestampMs: number;
  /** Antiguedad del evento en segundos, usada para decidir si es una repeticion. */
  readonly ageSeconds: number;
  /** Identificador normalizado del evento, tomado de la cabecera `webhook-id`. */
  readonly eventId: string;
  /**
   * Cuerpo ya deserializado por el helper oficial, solo presente cuando la firma es valida.
   * Es la unica copia parseada del payload: el resto del sistema la consume y nadie mas vuelve a
   * hacer `JSON.parse` sobre el cuerpo crudo.
   */
  readonly payload: Record<string, unknown> | null;
}

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/** Umbral por debajo del cual una marca temporal se interpreta como segundos. */
const SECONDS_TIMESTAMP_THRESHOLD = 100_000_000_000;

/**
 * Verificador criptografico de firmas de webhook.
 * Delega el calculo en el helper oficial y conserva la interfaz que consume el resto del modulo.
 */
export class WebhookSignatureVerifier {
  private readonly webhookSecret: string;
  private readonly toleranceSeconds: number;

  /**
   * @param options - Secreto de firma y tolerancia anti-repeticion.
   * @throws Error cuando el secreto esta vacio.
   */
  public constructor(options: WebhookVerifierOptions) {
    if (options.webhookSecret.trim().length === 0) {
      throw new Error('VERIFICADOR_SIN_SECRETO: se exige el secreto de webhooks para verificar las firmas entrantes.');
    }
    this.webhookSecret = options.webhookSecret;
    this.toleranceSeconds = options.toleranceSeconds;
  }

  /**
   * Normaliza la marca temporal del emisor, que el estandar entrega en segundos.
   *
   * @param rawTimestamp - Valor textual de la cabecera `webhook-timestamp`.
   * @returns Marca temporal en milisegundos, o `null` cuando no es legible.
   */
  public normalizeTimestamp(rawTimestamp: string): number | null {
    const numericValue = Number(rawTimestamp.trim());
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return null;
    }
    return numericValue < SECONDS_TIMESTAMP_THRESHOLD ? numericValue * MILLISECONDS_PER_SECOND : numericValue;
  }

  /**
   * Verifica criptograficamente un webhook entrante con el helper oficial.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido en la peticion.
   * @param headers - Cabeceras de firma normalizadas del webhook.
   * @param nowMs - Instante de referencia para la ventana anti-repeticion.
   * @returns Resultado detallado de la verificacion, con el payload parseado cuando es valida.
   */
  public verify(rawBodyBuffer: Buffer, headers: WhopWebhookHeaders, nowMs: number = Date.now()): WhopSignatureVerification {
    const declaredTimestampMs = this.normalizeTimestamp(headers.timestampHeader);
    const base = {
      eventId: headers.eventId,
      declaredTimestampMs: declaredTimestampMs ?? 0,
      ageSeconds: declaredTimestampMs === null ? Number.POSITIVE_INFINITY : Math.abs(nowMs - declaredTimestampMs) / MILLISECONDS_PER_SECOND,
      payload: null as Record<string, unknown> | null,
    };

    if (declaredTimestampMs === null) {
      return { ...base, valid: false, rejectionReason: 'MARCA_TEMPORAL_ILEGIBLE' };
    }

    try {
      // El helper exige las cabeceras crudas con sus nombres estandar; se reconstruyen desde la
      // forma normalizada para que el verificador no dependa de como el transporte las indexo.
      const payload = unwrapWebhook<Record<string, unknown>>(rawBodyBuffer.toString('utf8'), {
        headers: {
          'webhook-id': headers.eventId,
          'webhook-timestamp': headers.timestampHeader,
          'webhook-signature': headers.signatureHeader,
        },
        key: this.webhookSecret,
      });

      // La ventana anti-repeticion la aplica el propio helper, pero se comprueba tambien aqui para
      // poder reportar el motivo exacto al operador cuando el evento llega tarde.
      if (base.ageSeconds > this.toleranceSeconds) {
        return {
          ...base,
          payload: null,
          valid: false,
          rejectionReason: `VENTANA_ANTI_REPETICION_EXCEDIDA (${Math.round(base.ageSeconds)}s > ${this.toleranceSeconds}s)`,
        };
      }

      return { ...base, payload, valid: true, rejectionReason: null };
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return { ...base, valid: false, rejectionReason: `FIRMA_HMAC_INVALIDA: ${error.message}` };
      }
      return { ...base, valid: false, rejectionReason: `VERIFICACION_FALLIDA: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Verifica la firma y lanza un error controlado cuando es invalida.
   * Es la variante que consumen los controladores HTTP: el rechazo se traduce a HTTP 401.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido en la peticion.
   * @param headers - Cabeceras de firma normalizadas del webhook.
   * @param nowMs - Instante de referencia para la ventana anti-repeticion.
   * @returns Resultado de la verificacion cuando es valida.
   * @throws UnauthorizedError cuando la firma es invalida o la marca temporal esta fuera de ventana.
   */
  public assertValid(rawBodyBuffer: Buffer, headers: WhopWebhookHeaders, nowMs: number = Date.now()): WhopSignatureVerification {
    const verification = this.verify(rawBodyBuffer, headers, nowMs);
    if (!verification.valid) {
      throw new UnauthorizedError(
        `Webhook rechazado por firma invalida: ${verification.rejectionReason ?? 'motivo desconocido'}. ` +
          `Evento ${verification.eventId}, instante declarado ${verification.declaredTimestampMs}.`
      );
    }
    return verification;
  }
}
