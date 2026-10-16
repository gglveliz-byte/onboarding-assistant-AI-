/**
 * @archivo src/modules/04-billing-and-whop/infrastructure/webhook-signature.verifier.ts
 * @modulo 04-billing-and-whop (Verificador Criptografico de Firmas de Webhook)
 * @proposito
 *   Comprueba la autenticidad de cada webhook entrante. La firma se calcula sobre
 *   `timestamp + "." + cuerpo crudo` y NUNCA sobre el JSON reserializado: el orden de las claves o
 *   el espaciado cambiarian la firma y rechazaria eventos legitimamente firmados. Ademas aplica una
 *   ventana anti-repeticion, de modo que un atacante que capture un evento valido no pueda reenviarlo
 *   indefinidamente. Se aisla del cliente HTTP para que la verificacion pueda probarse sin red.
 *
 * @resumen_contenido
 *   - Interface `WebhookVerifierOptions`: Secreto de firma y tolerancia anti-repeticion.
 *   - Interface `WhopWebhookHeaders`: Cabeceras de firma normalizadas del webhook entrante.
 *   - Interface `WhopSignatureVerification`: Resultado detallado con el motivo del rechazo.
 *   - Clase `WebhookSignatureVerifier`:
 *       * `verify()`: Verificacion completa con diagnostico.
 *       * `assertValid()`: Variante estricta que lanza `UnauthorizedError`.
 *       * `normalizeTimestamp()`, `extractCandidateSignatures()` y `buildSecretCandidates()`.
 *
 * @dependencias_internas
 *   - `CryptoUtils` (`src/shared/kernel/crypto.util.ts`) para HMAC y comparacion en tiempo constante.
 *   - `UnauthorizedError` (`src/shared/kernel/result-and-errors.ts`) para el rechazo estricto.
 *
 * @dependencias_externas
 *   - Ninguna (Criptografia provista por el kernel de la plataforma).
 *
 * @tablas_bd_o_redis
 *   - Redis: `whop:webhook:evt:<id>` (La verificacion siempre precede a la marca de idempotencia).
 */

import { CryptoUtils } from '../../../shared/kernel/crypto.util';
import { UnauthorizedError } from '../../../shared/kernel/result-and-errors';

/** Parametros de construccion del verificador de firmas. */
export interface WebhookVerifierOptions {
  /** Secreto con el que la pasarela firma sus webhooks. */
  readonly webhookSecret: string;
  /** Tolerancia anti-repeticion de la marca temporal, en segundos. */
  readonly toleranceSeconds: number;
}

/** Cabeceras de firma normalizadas de un webhook entrante. */
export interface WhopWebhookHeaders {
  /** Identificador unico del evento, base de la idempotencia. */
  readonly eventId: string;
  /** Marca temporal de emision declarada por el emisor (segundos o milisegundos). */
  readonly timestampHeader: string;
  /** Firma declarada, posiblemente con varios candidatos separados por espacio. */
  readonly signatureHeader: string;
  /** Nombre del evento, tal como lo declara el emisor. */
  readonly eventNameHeader: string;
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
  /** Numero de esquema de firma aceptado (1 = textual, 2 = decodificado de `whsec_`). */
  readonly acceptedScheme: number | null;
}

/** Prefijo de los secretos de firma emitidos por la pasarela en formato Base64. */
const SIGNATURE_SECRET_PREFIX = 'whsec_';

/** Milisegundos que componen un segundo. */
const MILLISECONDS_PER_SECOND = 1000;

/** Umbral por debajo del cual una marca temporal se interpreta como segundos. */
const SECONDS_TIMESTAMP_THRESHOLD = 100_000_000_000;

/**
 * Verificador criptografico de firmas de webhook.
 * Admite los dos esquemas de secreto que emite la pasarela y varios candidatos de firma por cabecera.
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
   * Verifica criptograficamente la firma de un webhook entrante.
   *
   * @param rawBodyBuffer - Cuerpo crudo exacto recibido en la peticion.
   * @param headers - Cabeceras de firma normalizadas del webhook.
   * @param nowMs - Instante de referencia para la ventana anti-repeticion.
   * @returns Resultado detallado de la verificacion, con el motivo del rechazo cuando falla.
   */
  public verify(rawBodyBuffer: Buffer, headers: WhopWebhookHeaders, nowMs: number = Date.now()): WhopSignatureVerification {
    const declaredTimestampMs = this.normalizeTimestamp(headers.timestampHeader);
    if (declaredTimestampMs === null) {
      return {
        valid: false,
        rejectionReason: 'MARCA_TEMPORAL_ILEGIBLE',
        declaredTimestampMs: 0,
        ageSeconds: Number.POSITIVE_INFINITY,
        acceptedScheme: null,
      };
    }

    const ageSeconds = Math.abs(nowMs - declaredTimestampMs) / MILLISECONDS_PER_SECOND;
    if (ageSeconds > this.toleranceSeconds) {
      return {
        valid: false,
        rejectionReason: `VENTANA_ANTI_REPETICION_EXCEDIDA (${Math.round(ageSeconds)}s > ${this.toleranceSeconds}s)`,
        declaredTimestampMs,
        ageSeconds,
        acceptedScheme: null,
      };
    }

    const signingInput = `${headers.timestampHeader}.${rawBodyBuffer.toString('utf8')}`;
    const candidateSignatures = this.extractCandidateSignatures(headers.signatureHeader);
    const secretCandidates = this.buildSecretCandidates();

    for (const candidateSignature of candidateSignatures) {
      for (let schemeIndex = 0; schemeIndex < secretCandidates.length; schemeIndex += 1) {
        const expectedSignature = CryptoUtils.hmacSha256Hex(secretCandidates[schemeIndex] as string, signingInput);
        if (CryptoUtils.timingSafeEqualHex(expectedSignature, candidateSignature)) {
          return { valid: true, rejectionReason: null, declaredTimestampMs, ageSeconds, acceptedScheme: schemeIndex + 1 };
        }
      }
    }

    return { valid: false, rejectionReason: 'FIRMA_HMAC_INVALIDA', declaredTimestampMs, ageSeconds, acceptedScheme: null };
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
          `Instante declarado: ${verification.declaredTimestampMs}.`
      );
    }
    return verification;
  }

  /**
   * Normaliza la marca temporal del emisor, que puede venir en segundos o en milisegundos.
   *
   * @param rawTimestamp - Valor textual de la cabecera de marca temporal.
   * @returns Marca temporal en milisegundos, o `null` cuando no es legible.
   */
  public normalizeTimestamp(rawTimestamp: string): number | null {
    const numericValue = Number(rawTimestamp.trim());
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return null;
    }
    // Un valor menor al umbral es una marca en segundos, por lo que se convierte a milisegundos.
    return numericValue < SECONDS_TIMESTAMP_THRESHOLD ? numericValue * MILLISECONDS_PER_SECOND : numericValue;
  }

  /**
   * Extrae los candidatos de firma del encabezado, admitiendo varios separados por espacio y el
   * prefijo de version (`v1=<firma>`).
   *
   * @param rawSignatureHeader - Valor textual del encabezado de firma.
   * @returns Firmas hexadecimales candidatas, sin prefijo de version ni duplicados.
   */
  public extractCandidateSignatures(rawSignatureHeader: string): readonly string[] {
    const candidates = new Set<string>();
    for (const rawToken of rawSignatureHeader.trim().split(/\s+/u)) {
      const withoutVersion = rawToken.includes('=') ? (rawToken.split('=').pop() ?? '') : rawToken;
      const normalized = withoutVersion.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/u.test(normalized)) {
        candidates.add(normalized);
      }
    }
    return [...candidates];
  }

  /**
   * Construye los secretos candidatos con los que puede haberse firmado un webhook.
   * Un secreto declarado como `whsec_<base64>` se usa tanto en su forma textual completa como en su
   * parte decodificada: distintas versiones de la pasarela firman con una u otra representacion.
   *
   * @returns Lista de secretos candidatos, sin duplicados.
   */
  public buildSecretCandidates(): readonly string[] {
    const candidates = new Set<string>([this.webhookSecret]);

    if (this.webhookSecret.startsWith(SIGNATURE_SECRET_PREFIX)) {
      const base64Part = this.webhookSecret.slice(SIGNATURE_SECRET_PREFIX.length);
      try {
        const decoded = Buffer.from(base64Part, 'base64').toString('utf8');
        if (decoded.length > 0) {
          candidates.add(decoded);
        }
      } catch {
        // Un secreto que no es Base64 valido se usa unicamente en su forma textual.
      }
    }

    return [...candidates];
  }
}
