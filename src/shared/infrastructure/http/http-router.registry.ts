/**
 * @archivo src/shared/infrastructure/http/http-router.registry.ts
 * @modulo Kernel Compartido (Registro Concreto de Rutas HTTP y Canales WebSocket)
 * @proposito
 *   Proporciona la implementacion concreta de `HttpRouterRegistry` y `WsRouteRegistry` que los siete
 *   manifiestos de modulo necesitan para auto-conectarse. Los manifiestos declaran sus rutas contra
 *   estos contratos, de modo que el registro es agnostico al servidor: en produccion lo consume el
 *   adaptador del framework y en las pruebas se inspecciona directamente. El registro RECHAZA rutas
 *   duplicadas y canales con el mismo camino: dos modulos que declaren el mismo endpoint producirian
 *   un comportamiento dependiente del orden de arranque, que es precisamente el fallo que un
 *   ensamblaje automatico debe impedir.
 *
 * @resumen_contenido
 *   - Interface `RegisteredRouteSummary`: Resumen de ruta para el diagnostico de arranque.
 *   - Clase `HttpRouterRegistryImpl`: Registro de rutas HTTP con deteccion de duplicados.
 *   - Clase `WsRouteRegistryImpl`: Registro de canales WebSocket con deteccion de duplicados.
 *   - Funcion `createRouterRegistries()`: Fabrica de ambos registros.
 *
 * @dependencias_internas
 *   - `HttpRouterRegistry`, `WsRouteRegistry` y sus tipos (`./http-server.types.ts`).
 *   - `ConflictError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Estructuras en memoria: no abren puertos ni conocen el framework de transporte).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (El registro de rutas vive en memoria del proceso).
 */

import { ConflictError } from '../../kernel/result-and-errors';
import type {
  HttpRouteRegistration,
  HttpRouterRegistry,
  WsRouteRegistration,
  WsRouteRegistry,
} from './http-server.types';

/** Resumen de una ruta registrada, usado por el diagnostico de arranque. */
export interface RegisteredRouteSummary {
  /** Metodo HTTP de la ruta. */
  readonly method: string;
  /** Camino absoluto de la ruta. */
  readonly path: string;
  /** Nivel de acceso exigido. */
  readonly access: string;
  /** Modulo propietario de la ruta. */
  readonly ownerModule: string;
  /** Indica si la ruta exige cuerpo crudo para verificar firmas. */
  readonly requiresRawBody: boolean;
}

/**
 * Registro de rutas HTTP de la plataforma.
 * Un duplicado se rechaza en el arranque, no en tiempo de peticion: es preferible que el proceso no
 * levante antes que servir un endpoint cuyo propietario depende del orden de carga.
 */
export class HttpRouterRegistryImpl implements HttpRouterRegistry {
  private readonly routes: HttpRouteRegistration[] = [];
  private readonly routeKeys = new Set<string>();

  /**
   * Registra una ruta HTTP en el enrutador de la aplicacion.
   *
   * @param registration - Declaracion completa de la ruta.
   * @throws ConflictError cuando ya existe una ruta con el mismo metodo y camino.
   */
  public register(registration: HttpRouteRegistration): void {
    const routeKey = `${registration.method} ${registration.path}`;
    if (this.routeKeys.has(routeKey)) {
      throw new ConflictError(
        `La ruta ${routeKey} ya fue registrada por otro modulo. Dos propietarios para el mismo ` +
          `endpoint producen un comportamiento dependiente del orden de arranque.`
      );
    }
    this.routeKeys.add(routeKey);
    this.routes.push(registration);
  }

  /**
   * Devuelve una copia inmutable de todas las rutas registradas hasta el momento.
   *
   * @returns Listado de rutas registradas.
   */
  public list(): readonly HttpRouteRegistration[] {
    return Object.freeze([...this.routes]);
  }

  /**
   * Devuelve el numero de rutas registradas.
   *
   * @returns Cantidad de rutas HTTP.
   */
  public count(): number {
    return this.routes.length;
  }

  /**
   * Resume las rutas registradas para el diagnostico de arranque.
   *
   * @returns Resumen legible de cada ruta, ordenado por camino.
   */
  public summarize(): readonly RegisteredRouteSummary[] {
    return Object.freeze(
      this.routes
        .map((route) => ({
          method: route.method,
          path: route.path,
          access: route.access,
          ownerModule: route.ownerModule,
          requiresRawBody: route.requiresRawBody,
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    );
  }

  /**
   * Agrupa las rutas por modulo propietario.
   *
   * @returns Numero de rutas declaradas por cada modulo.
   */
  public countByOwnerModule(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const route of this.routes) {
      counts[route.ownerModule] = (counts[route.ownerModule] ?? 0) + 1;
    }
    return Object.freeze(counts);
  }
}

/**
 * Registro de canales WebSocket de la plataforma.
 * Igual que el registro HTTP, rechaza que dos modulos declaren el mismo camino.
 */
export class WsRouteRegistryImpl implements WsRouteRegistry {
  private readonly channels: WsRouteRegistration[] = [];
  private readonly channelPaths = new Set<string>();

  /**
   * Registra un canal WebSocket en el servidor de aplicacion.
   *
   * @param registration - Declaracion completa del canal.
   * @throws ConflictError cuando ya existe un canal en el mismo camino.
   */
  public register(registration: WsRouteRegistration): void {
    if (this.channelPaths.has(registration.path)) {
      throw new ConflictError(
        `El canal WebSocket ${registration.path} ya fue registrado por otro modulo. ` +
          `Solo un modulo puede poseer un camino de socket.`
      );
    }
    this.channelPaths.add(registration.path);
    this.channels.push(registration);
  }

  /**
   * Devuelve una copia inmutable de todos los canales registrados hasta el momento.
   *
   * @returns Listado de canales registrados.
   */
  public list(): readonly WsRouteRegistration[] {
    return Object.freeze([...this.channels]);
  }

  /**
   * Devuelve el numero de canales registrados.
   *
   * @returns Cantidad de canales WebSocket.
   */
  public count(): number {
    return this.channels.length;
  }

  /**
   * Localiza un canal registrado por su camino exacto.
   *
   * @param path - Camino del canal solicitado.
   * @returns Canal registrado, o `null` cuando no existe.
   */
  public findByPath(path: string): WsRouteRegistration | null {
    return this.channels.find((channel) => channel.path === path) ?? null;
  }
}

/**
 * Construye ambos registros de rutas.
 *
 * @returns Registros de rutas HTTP y de canales WebSocket.
 */
export function createRouterRegistries(): {
  readonly httpRouter: HttpRouterRegistryImpl;
  readonly wsRegistry: WsRouteRegistryImpl;
} {
  return { httpRouter: new HttpRouterRegistryImpl(), wsRegistry: new WsRouteRegistryImpl() };
}
