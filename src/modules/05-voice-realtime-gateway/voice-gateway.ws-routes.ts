/**
 * @archivo src/modules/05-voice-realtime-gateway/voice-gateway.ws-routes.ts
 * @modulo 05-voice-realtime-gateway (Declaracion del Canal WebSocket de Voz)
 * @proposito
 *   Declara el canal `wss://.../ws/v1/realtime` en el registro de canales del servidor. El hallazgo
 *   que motiva este archivo es concreto: los manifiestos de identidad y de proyectos reciben un
 *   `WsRouteRegistry` y **lo ignoran** —uno lo nombra con guion bajo, marcandolo como no usado— y
 *   ningun modulo del repositorio declaraba el canal de voz. El resultado era que el SDK podia
 *   completar el handshake y obtener su nonce efimero, pero **no tenia a donde conectarse**: el
 *   producto quedaba inutilizable con todas las suites en verde. Se aisla en su propio archivo, en
 *   lugar de engordar el manifiesto, porque la declaracion del transporte no es responsabilidad del
 *   ensamblaje de dependencias.
 *
 * @resumen_contenido
 *   - Constante `VOICE_REALTIME_CHANNEL_PATH`.
 *   - Funcion `registerVoiceGatewayWsRoute()`: Declara el canal binario de voz.
 *
 * @dependencias_internas
 *   - `WsRouteRegistry`, `WsAuthenticatedContext` (`src/shared/infrastructure/http/http-server.types.ts`).
 *   - `VOICE_REALTIME_CHANNEL_PATH` consumido por el entrypoint del pool de voz.
 *
 * @dependencias_externas
 *   - Ninguna (Declaracion de transporte: el manejador real lo aporta el entrypoint del pool).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `voice_sessions` (El canal abierto corresponde a una sesion persistida).
 */

import type { WsAuthenticatedContext, WsRouteRegistry } from '../../shared/infrastructure/http/http-server.types';

/**
 * Camino canonico del canal de voz en tiempo real.
 * El SDK lo consume tal cual: cambiarlo aqui sin cambiarlo en el SDK deja el producto sin voz.
 */
export const VOICE_REALTIME_CHANNEL_PATH = '/ws/v1/realtime';

/** Aviso emitido por el canal cuando el servidor aun no tiene el manejador del pool de voz. */
const CHANNEL_UNAVAILABLE_REASON =
  'El canal de voz no tiene manejador activo en este proceso: el pool de API no atiende sockets de voz.';

/**
 * Declara el canal WebSocket de voz en el registro de canales.
 *
 * El manejador se inyecta desde el entrypoint del pool de voz, que es el unico que dispone de los
 * adaptadores de motor, del despachador de herramientas y del servicio de facturacion. Cuando el
 * canal se declara en un proceso que no atiende voz —el plano de control, por ejemplo—, el manejador
 * por omision **rechaza** la conexion explicando el motivo, en lugar de aceptarla y dejarla muda.
 *
 * @param wsRegistry - Registro de canales del servidor.
 * @param handler - Manejador real del canal, aportado por el entrypoint del pool de voz.
 */
export function registerVoiceGatewayWsRoute(
  wsRegistry: WsRouteRegistry,
  handler?: (context: WsAuthenticatedContext) => Promise<{ readonly terminationReason: string }>
): void {
  wsRegistry.register({
    path: VOICE_REALTIME_CHANNEL_PATH,
    dataFormat: 'BINARY',
    access: 'TENANT_SESSION',
    ownerModule: '05-voice-realtime-gateway',
    handler: handler ?? (async () => ({ terminationReason: CHANNEL_UNAVAILABLE_REASON })),
  });
}
