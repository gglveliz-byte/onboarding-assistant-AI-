/**
 * @archivo src/types/whop-sdk-helpers.d.ts
 * @modulo 00-foundations (Declaracion de Tipos del Helper Oficial de Webhooks de la Pasarela)
 * @proposito
 *   Declara los tipos del subpath `@whop/sdk/helpers`, que el paquete publica en su mapa `exports`
 *   pero que el compilador NO puede resolver bajo el ajuste `moduleResolution: "Node"` de este
 *   monorepo (exigiria migrar a `Node16`/`Bundler`, un cambio global de contrato que afecta a los
 *   71 archivos del backend y queda fuera del alcance de esta tarea).
 *
 *   En tiempo de ejecucion la carga SI funciona: `require('@whop/sdk/helpers')` resuelve a traves del
 *   mapa `exports` y entrega `MISSING_KEY_MESSAGE`, `unwrapWebhook` y `WebhookVerificationError`,
 *   verificado contra la version fijada 2.6.0. Esta declaracion aporta unicamente la capa de tipos,
 *   copiada fielmente de `node_modules/@whop/sdk/dist/cjs/helpers/verifyWebhook.d.ts`.
 *
 *   IMPORTANTE: este archivo NO reimplementa la verificacion criptografica. La implementacion real es
 *   la de la pasarela; aqui solo se describe su firma para poder llamarla desde TypeScript estricto.
 *
 * @resumen_contenido
 *   - Modulo ambiental `@whop/sdk/helpers`: `UnwrapWebhookOptions`, `unwrapWebhook()`,
 *     `WebhookVerificationError` y `MISSING_KEY_MESSAGE`.
 *
 * @dependencias_internas
 *   - Ninguna.
 *
 * @dependencias_externas
 *   - `@whop/sdk` 2.6.0 (y su dependencia `standardwebhooks`, que implementa la verificacion).
 *
 * @tablas_bd_o_redis
 *   - Ninguna.
 */

declare module '@whop/sdk/helpers' {
  /** Opciones de verificacion del webhook entrante. */
  export interface UnwrapWebhookOptions {
    /**
     * Cabeceras de la peticion. Solo se leen `webhook-id`, `webhook-timestamp` y `webhook-signature`,
     * y la busqueda no distingue mayusculas.
     */
    headers: Record<string, string>;
    /**
     * Secreto de firma del endpoint, exactamente como lo muestra la pasarela (prefijo `ws_`).
     * Pasar integro: no quitar el prefijo ni pre-codificar en base64.
     */
    key: string | undefined;
  }

  /**
   * Verifica la firma Standard Webhooks que la pasarela envia en cada entrega y devuelve el cuerpo
   * ya parseado.
   *
   * @param payload - Cuerpo crudo sin modificar. Verificar un cuerpo re-serializado siempre falla.
   * @throws Error cuando falta `key`.
   * @throws WebhookVerificationError cuando falta o es malformada una cabecera, la marca temporal
   *   esta fuera de tolerancia, o ninguna firma coincide.
   */
  export function unwrapWebhook<TEvent = Record<string, unknown>>(payload: string, options: UnwrapWebhookOptions): TEvent;

  /** Error que lanza el helper cuando la verificacion de firma falla. */
  export class WebhookVerificationError extends Error {}

  /** Mensaje que produce el helper cuando se llama sin secreto de firma. */
  export const MISSING_KEY_MESSAGE: string;
}
