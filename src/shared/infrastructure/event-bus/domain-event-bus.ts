/**
 * @archivo src/shared/infrastructure/event-bus/domain-event-bus.ts
 * @modulo 00-kernel (Bus de Eventos Hibrido: Memoria Local, Pub/Sub Global y Stream Duradero)
 * @proposito
 *   Implementa el unico bus de eventos de la plataforma con tres vias complementarias:
 *     1. Memoria local (`EventEmitter`) para la comunicacion sincrona entre modulos del mismo
 *        proceso, con latencia de microsegundos y sin serializacion.
 *     2. Pub/Sub de Redis para propagar ordenes entre los 3 Node Pools (por ejemplo, cerrar todas
 *        las sesiones de voz de una organizacion suspendida o cambiar el motor de voz activo).
 *     3. Stream duradero de Redis para conservar el historial de eventos y permitir que un nodo
 *        que se reinicia reconstruya el estado que perdio.
 *   Los eventos se declaran con tipado estricto en `application-event.catalog.ts`: publicar un
 *   nombre inexistente o una carga con campos faltantes es un error de compilacion.
 *
 * @resumen_contenido
 *   - Interface `DomainEventBusOptions`: Prefijo, Node Pool emisor y limites del stream.
 *   - Interface `LocalSubscription`: Funcion de cancelacion de una suscripcion local.
 *   - Clase `DomainEventBus`:
 *       * `publishLocal()` y `subscribeLocal()`: Via en memoria para el mismo proceso.
 *       * `publishGlobal()`: Publica en Pub/Sub y anexa al stream duradero.
 *       * `subscribeGlobal()`: Escucha las ordenes emitidas por los demas Node Pools.
 *       * `readStreamHistory()`: Recupera eventos historicos para reconstruir estado.
 *       * `countLocalSubscribers()` y `close()`: Diagnostico y cierre ordenado.
 *
 * @dependencias_internas
 *   - Catalogo de eventos (`../../kernel/application-event.catalog.ts`).
 *   - `RedisClusterClient` (`../redis/redis-cluster.client.ts`) para las vias globales.
 *
 * @dependencias_externas
 *   - `node:events` (Emisor de eventos nativo para la via en memoria).
 *
 * @tablas_bd_o_redis
 *   - Redis: `oa:events:global` (Pub/Sub entre Node Pools) y `oa:events:stream` (Historial).
 */

import { EventEmitter } from 'node:events';
import {
  buildEventEnvelope,
  type ApplicationEventEnvelope,
  type ApplicationEventMap,
  type ApplicationEventName,
} from '../../kernel/application-event.catalog';
import type { RedisClusterClient } from '../redis/redis-cluster.client';

/** Parametros de construccion del bus de eventos. */
export interface DomainEventBusOptions {
  /** Cliente Redis unico de la plataforma para las vias globales. */
  readonly redisClient: RedisClusterClient;
  /** Node Pool que ejecuta este proceso, incluido en cada sobre emitido. */
  readonly emittedByPool?: string;
  /** Longitud maxima aproximada del stream duradero. */
  readonly maxStreamLength?: number;
  /** Indica si las vias globales (Pub/Sub y Stream) estan habilitadas. */
  readonly globalTransportEnabled?: boolean;
}

/** Funcion que cancela una suscripcion local o global. */
export type EventUnsubscription = () => void;

/** Entrada historica recuperada del stream duradero. */
export interface StreamHistoryEntry {
  /** Identificador asignado por Redis a la entrada del stream. */
  readonly entryId: string;
  /** Nombre canonico del evento. */
  readonly eventName: string;
  /** Carga util tal como fue publicada (sin tipado, procedente de otro proceso). */
  readonly payload: unknown;
  /** Marca temporal de publicacion declarada por el emisor. */
  readonly publishedAtIso: string;
}

/**
 * Bus de eventos hibrido del sistema.
 * La via local es sincrona y sin serializacion; las vias globales atraviesan Redis para alcanzar
 * a los otros Node Pools. Un fallo de Redis jamas debe tumbar la via local: la publicacion global
 * degrada de forma controlada y reporta el fallo por su valor de retorno.
 */
export class DomainEventBus {
  private readonly emitter = new EventEmitter();
  private readonly redisClient: RedisClusterClient;
  private readonly emittedByPool: string;
  private readonly maxStreamLength: number;
  private readonly globalTransportEnabled: boolean;

  /**
   * Construye el bus y configura el emisor local para no truncar suscriptores.
   *
   * @param options - Cliente Redis, Node Pool emisor y limites del stream.
   */
  public constructor(options: DomainEventBusOptions) {
    this.redisClient = options.redisClient;
    this.emittedByPool = options.emittedByPool ?? 'API_CONTROL_PLANE';
    this.maxStreamLength = options.maxStreamLength ?? 10000;
    this.globalTransportEnabled = options.globalTransportEnabled ?? true;
    this.emitter.setMaxListeners(200);
  }

  /**
   * Publica un evento en la via local (mismo proceso).
   * El sobre se entrega a todos los suscriptores registrados para ese nombre de evento.
   *
   * @param eventName - Nombre canonico del evento.
   * @param payload - Carga util tipada del evento.
   * @param context - Organizacion y correlacion del evento.
   * @returns Sobre emitido, reutilizable para su publicacion global.
   */
  public publishLocal<TName extends ApplicationEventName>(
    eventName: TName,
    payload: ApplicationEventMap[TName],
    context: { readonly organizationId?: string; readonly correlationId?: string } = {}
  ): ApplicationEventEnvelope<TName> {
    const envelope = buildEventEnvelope(eventName, payload, { ...context, emittedByPool: this.emittedByPool });
    this.emitter.emit(eventName, envelope);
    return envelope;
  }

  /**
   * Registra un suscriptor local para un nombre de evento.
   *
   * @param eventName - Nombre canonico del evento a escuchar.
   * @param handler - Funcion invocada por cada evento recibido.
   * @returns Funcion que cancela la suscripcion.
   */
  public subscribeLocal<TName extends ApplicationEventName>(
    eventName: TName,
    handler: (envelope: ApplicationEventEnvelope<TName>) => void
  ): EventUnsubscription {
    const listener = (envelope: ApplicationEventEnvelope<TName>): void => {
      handler(envelope);
    };
    this.emitter.on(eventName, listener);
    return (): void => {
      this.emitter.off(eventName, listener);
    };
  }

  /**
   * Publica un evento hacia los demas Node Pools mediante Pub/Sub y lo anexa al stream duradero.
   * Si el transporte global esta deshabilitado o Redis no responde, la operacion no lanza:
   * devuelve `false` para que el llamador decida si el fallo es tolerable.
   *
   * @param eventName - Nombre canonico del evento.
   * @param payload - Carga util tipada del evento.
   * @param context - Organizacion y correlacion del evento.
   * @returns `true` cuando el evento se propago por Pub/Sub y quedo registrado en el stream.
   */
  public async publishGlobal<TName extends ApplicationEventName>(
    eventName: TName,
    payload: ApplicationEventMap[TName],
    context: { readonly organizationId?: string; readonly correlationId?: string } = {}
  ): Promise<boolean> {
    if (!this.globalTransportEnabled) {
      return false;
    }

    const envelope = buildEventEnvelope(eventName, payload, { ...context, emittedByPool: this.emittedByPool });

    try {
      await this.redisClient.publish(this.redisClient.channels.globalEvents, envelope);
      await this.redisClient.appendToStream(eventName, envelope, this.maxStreamLength);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Se suscribe a las ordenes globales emitidas por cualquier Node Pool.
   * Ademas de la via Pub/Sub, se declara el nombre del evento como filtro: el manejador solo se
   * invoca cuando el sobre recibido corresponde a ese nombre.
   *
   * @param eventName - Nombre canonico del evento a escuchar.
   * @param handler - Funcion invocada por cada evento global recibido.
   * @returns Promesa con la funcion que cancela la suscripcion.
   */
  public async subscribeGlobal<TName extends ApplicationEventName>(
    eventName: TName,
    handler: (envelope: ApplicationEventEnvelope<TName>) => void
  ): Promise<EventUnsubscription> {
    const unsubscribeFromRedis = await this.redisClient.subscribe(this.redisClient.channels.globalEvents, (rawPayload) => {
      const envelope = rawPayload as Partial<ApplicationEventEnvelope>;
      if (envelope.eventName !== eventName || envelope.payload === undefined) {
        return;
      }
      handler(envelope as ApplicationEventEnvelope<TName>);
    });

    return (): void => {
      void unsubscribeFromRedis();
    };
  }

  /**
   * Recupera el historial de eventos del stream duradero para reconstruir estado tras un reinicio.
   *
   * @param limit - Numero maximo de entradas a recuperar (las mas recientes).
   * @returns Entradas historicas en orden cronologico descendente.
   */
  public async readStreamHistory(limit: number = 50): Promise<readonly StreamHistoryEntry[]> {
    const entries = await this.redisClient.readStreamEntries(limit);
    return entries.map((entry) => ({
      entryId: entry.entryId,
      eventName: entry.eventName,
      payload: entry.payload,
      publishedAtIso: entry.publishedAtIso,
    }));
  }

  /**
   * Cuenta los suscriptores locales registrados para un nombre de evento.
   *
   * @param eventName - Nombre canonico del evento.
   * @returns Numero de suscriptores locales activos.
   */
  public countLocalSubscribers(eventName: ApplicationEventName): number {
    return this.emitter.listenerCount(eventName);
  }

  /**
   * Deserializa una carga util sin propagar la excepcion ante contenido invalido.
   *
   * @param rawValue - Cadena JSON cruda.
   * @returns Valor deserializado, o la propia cadena cuando no es JSON valido.
   */
  private safeParseJson(rawValue: string): unknown {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return rawValue;
    }
  }

  /**
   * Libera todos los suscriptores locales del bus.
   * Las suscripciones globales se cancelan a traves de la funcion que devuelve `subscribeGlobal()`.
   */
  public close(): void {
    this.emitter.removeAllListeners();
  }
}
