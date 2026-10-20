/**
 * @archivo src/bootstrap/api-control-plane.server.ts
 * @modulo Bootstrap (Servidor HTTP del Plano de Control)
 * @proposito
 *   Implementa el servidor HTTP que despacha las peticiones del plano de control contra las rutas
 *   declaradas por los siete manifiestos de modulo. Se aisla del entrypoint porque son dos
 *   responsabilidades distintas: este archivo sabe hablar HTTP y traducir errores de dominio a
 *   estados correctos, mientras el entrypoint solo ensambla, escucha y cierra. El detalle que mas
 *   importa aqui es que el cuerpo crudo se conserva sin tocar: la firma HMAC de los webhooks solo es
 *   verificable sobre los bytes exactos recibidos, y reserializar el JSON invalidaria todos los
 *   eventos legitimamente firmados.
 *
 * @resumen_contenido
 *   - Constantes `MAX_REQUEST_BYTES` y `HTTP_STATUS`.
 *   - Clase `ApiControlPlaneServer`: Escucha, despacho por ruta declarada y cierre de sockets.
 *   - Funciones `matchesParameterizedPath()`, `rejectByAccessLevel()` y utilidades de transporte.
 *
 * @dependencias_internas
 *   - Contratos de transporte (`src/shared/infrastructure/http/http-server.types.ts`).
 *   - `toAppError()` (`src/shared/kernel/result-and-errors.ts`) para la traduccion de errores.
 *   - `BootstrappedSystem` (`./module-autoloader.ts`).
 *
 * @dependencias_externas
 *   - `node:http` (Servidor nativo: sin dependencia de framework en el borde de red).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `RlsDatabasePool` (Una conexion por peticion, con contexto RLS del tenant).
 *   - Redis: `RedisClusterClient` (Cuotas, sesiones y publicacion de eventos de dominio).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { toAppError } from '../shared/kernel/result-and-errors';
import type { BootstrappedSystem } from './module-autoloader';
import type {
  AuthenticatedRequestContext,
  HttpRouteRegistration,
  HttpRequestLike,
} from '../shared/infrastructure/http/http-server.types';
import { evaluateRouteAccess, type RouteAccessSuccess } from './session-auth.middleware';

/** Tamano maximo del cuerpo de una peticion, en bytes. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Codigos de estado usados por el borde antes de llegar a un manejador. */
export const HTTP_STATUS = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
});
export class ApiControlPlaneServer {
  private readonly system: BootstrappedSystem;
  private readonly server: Server;
  private readonly log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  private readonly openSockets = new Set<Socket>();
  private isAcceptingConnections = true;

  /**
   * @param system - Sistema ensamblado con las rutas declaradas.
   * @param log - Escritor de bitacora del proceso.
   */
  public constructor(system: BootstrappedSystem, log: (message: string, metadata?: Readonly<Record<string, unknown>>) => void) {
    this.system = system;
    this.log = log;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    // El servidor mantiene un registro de los sockets vivos para poder cerrarlos durante el drenado:
    // `server.close()` deja de aceptar conexiones nuevas pero NO cierra las keep-alive existentes, y
    // el proceso no terminaria nunca.
    this.server.on('connection', (socket: Socket) => {
      this.openSockets.add(socket);
      socket.on('close', () => this.openSockets.delete(socket));
    });
  }

  /**
   * Pone el servidor a escuchar en el puerto indicado.
   *
   * @param port - Puerto de escucha.
   * @returns Promesa que se resuelve cuando el puerto esta abierto.
   */
  public async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.log(`Plano de control escuchando en el puerto ${port}.`, { routeCount: this.system.httpRouter.count() });
  }

  /**
   * Deja de aceptar conexiones nuevas y cierra las existentes tras el drenado.
   *
   * @param graceMs - Tiempo maximo que se espera antes de cerrar los sockets a la fuerza.
   */
  public async stopAcceptingConnections(graceMs: number): Promise<void> {
    this.isAcceptingConnections = false;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Los sockets en espera de una peticion keep-alive se cierran ordenadamente al vencer el
      // presupuesto, porque de lo contrario el cierre no se completaria jamas.
      setTimeout(() => {
        // En Node 18.2+ `closeAllConnections()` cierra tambien los sockets keep-alive, que
        // `server.close()` deja vivos. Sin esto, el proceso no termina nunca y el orquestador lo
        // mata por la fuerza, abortando el bucle de eventos con una asercion de libuv.
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
          return;
        }
        for (const socket of this.openSockets) {
          socket.destroy();
        }
      }, Math.max(0, graceMs));
    });
  }

  /**
   * Devuelve el puerto real en el que escucha el servidor.
   *
   * @returns Puerto de escucha, o `null` cuando aun no ha abierto.
   */
  public getListeningPort(): number | null {
    const address = this.server.address();
    return address !== null && typeof address === 'object' ? address.port : null;
  }

  /**
   * Devuelve el numero de conexiones abiertas en este instante.
   *
   * @returns Cantidad de sockets vivos.
   */
  public getOpenConnectionCount(): number {
    return this.openSockets.size;
  }

  /**
   * Atiende una peticion HTTP completa: lee el cuerpo crudo, resuelve la ruta y ejecuta el manejador.
   *
   * @param request - Peticion entrante del modulo nativo.
   * @param response - Respuesta a completar.
   */
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.isAcceptingConnections) {
      respondJson(response, HTTP_STATUS.SERVICE_UNAVAILABLE, { error: 'El servicio esta cerrandose.' });
      return;
    }

    try {
      const rawBody = await readRequestBody(request).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'CUERPO_EXCESIVO') {
          respondJson(response, HTTP_STATUS.PAYLOAD_TOO_LARGE, {
            error: { code: 'VALIDATION_FAILED', message: `El cuerpo excede el maximo de ${MAX_REQUEST_BYTES} bytes.` },
          });
          return null;
        }
        throw error;
      });
      if (rawBody === null) {
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const normalizedRequest = buildRequestLike(request, requestUrl, rawBody);
      const route = this.resolveRoute(normalizedRequest.method, normalizedRequest.path);

      if (route === null) {
        respondJson(response, HTTP_STATUS.NOT_FOUND, {
          error: { code: 'NOT_FOUND', message: `No existe la ruta ${normalizedRequest.method} ${normalizedRequest.path}.` },
        });
        return;
      }

      const accessEvaluation = await evaluateRouteAccess(route, normalizedRequest, this.system.authVerifier);
      if (!accessEvaluation.allowed) {
        respondJson(response, accessEvaluation.status, {
          error: { code: accessEvaluation.code, message: accessEvaluation.message },
        });
        return;
      }

      await this.executeRouteHandler(route, normalizedRequest, response, accessEvaluation);
    } catch (error) {
      // Los errores de dominio llevan su propio estado HTTP en la jerarquia del kernel. Sin esta
      // traduccion, un webhook sin firma —que es una peticion mal formada— respondia 500 en lugar de
      // 400, y el emisor lo habria interpretado como una caida del servicio en vez de como un
      // rechazo que debe corregir. Se conserva el codigo del error para que el cliente sepa QUE
      // fallo, y solo se genericiza el mensaje de los fallos no clasificados.
      const appError = toAppError(error);
      const isUnclassified = appError.code === 'INTERNAL_ERROR';

      if (!isUnclassified) {
        this.log('Peticion rechazada por un error de dominio.', { code: appError.code, httpStatus: appError.httpStatus });
        respondJson(response, appError.httpStatus, {
          error: { code: appError.code, message: appError.message, httpStatus: appError.httpStatus },
        });
        return;
      }

      this.log('Fallo al atender una peticion HTTP.', { error: appError.message });
      respondJson(response, HTTP_STATUS.INTERNAL_ERROR, {
        error: { code: 'INTERNAL_ERROR', message: 'No fue posible completar la solicitud.' },
      });
    }
  }

  /**
   * Ejecuta el manejador de una ruta declarada y traduce su resultado a una respuesta HTTP.
   *
   * @param route - Ruta declarada por el manifiesto propietario.
   * @param request - Peticion normalizada.
   * @param response - Respuesta a completar.
   * @param accessEvaluation - Contexto de identidad resuelto por el middleware de sesion.
   */
  private async executeRouteHandler(
    route: HttpRouteRegistration,
    request: HttpRequestLike,
    response: ServerResponse,
    accessEvaluation: RouteAccessSuccess
  ): Promise<void> {
    const context: AuthenticatedRequestContext = {
      principal: accessEvaluation.principal,
      organizationId: accessEvaluation.organizationId,
      projectId: null,
      functionalMapId: null,
      validatedOrigin: readHeaderValue(request.headers['origin']),
      requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      clientIp: request.clientIp,
      userAgent: readHeaderValue(request.headers['user-agent']) ?? '',
      receivedAt: new Date(),
    };

    const result = await route.handler(request, context);
    respondJson(response, result.status, result.body, result.headers);
  }

  /**
   * Localiza la ruta declarada que corresponde a un metodo y un camino.
   *
   * @param method - Metodo HTTP de la peticion.
   * @param path - Camino normalizado de la peticion.
   * @returns Ruta registrada, o `null` cuando ninguna coincide.
   */
  private resolveRoute(method: string, path: string): HttpRouteRegistration | null {
    for (const route of this.system.httpRouter.list()) {
      if (route.method !== method) {
        continue;
      }
      if (route.path === path || matchesParameterizedPath(route.path, path)) {
        return route;
      }
    }
    return null;
  }
}

/**
 * Compara un camino declarado con parametros contra un camino real.
 *
 * @param declaredPath - Camino declarado, por ejemplo `/api/v1/projects/:projectId`.
 * @param actualPath - Camino real de la peticion.
 * @returns `true` cuando el camino real satisface la plantilla.
 */
function matchesParameterizedPath(declaredPath: string, actualPath: string): boolean {
  const declaredSegments = declaredPath.split('/').filter((segment) => segment.length > 0);
  const actualSegments = actualPath.split('/').filter((segment) => segment.length > 0);
  if (declaredSegments.length !== actualSegments.length) {
    return false;
  }
  return declaredSegments.every((declaredSegment, index) => {
    if (declaredSegment.startsWith(':')) {
      return (actualSegments[index] ?? '').length > 0;
    }
    return declaredSegment === actualSegments[index];
  });
}



/**
 * Lee un encabezado HTTP como texto plano.
 *
 * @param headerValue - Valor crudo del encabezado, posiblemente repetido.
 * @returns Primer valor textual, o `null` cuando el encabezado no esta presente.
 */
function readHeaderValue(headerValue: string | readonly string[] | undefined): string | null {
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return (headerValue[0] as string | undefined) ?? null;
  }
  return null;
}

/**
 * Lee el cuerpo crudo de una peticion, imponiendo un limite de tamano.
 *
 * @param request - Peticion entrante.
 * @returns Cuerpo crudo en bytes.
 * @throws Error con el mensaje `CUERPO_EXCESIVO` cuando supera el limite.
 */
async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += chunkBuffer.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new Error('CUERPO_EXCESIVO');
    }
    chunks.push(chunkBuffer);
  }

  return Buffer.concat(chunks);
}

/**
 * Construye la abstraccion de peticion que consumen los manejadores de los manifiestos.
 *
 * @param request - Peticion entrante del modulo nativo.
 * @param requestUrl - URL ya interpretada.
 * @param rawBody - Cuerpo crudo en bytes, base de la verificacion de firmas.
 * @returns Peticion normalizada.
 */
function buildRequestLike(request: IncomingMessage, requestUrl: URL, rawBody: Buffer): HttpRequestLike {
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of requestUrl.searchParams) {
    query[key] = value;
  }

  const headers: Record<string, string | readonly string[] | undefined> = {};
  for (const [headerName, headerValue] of Object.entries(request.headers)) {
    if (headerValue !== undefined) {
      headers[headerName] = headerValue;
    }
  }

  const forwardedFor = request.headers['x-forwarded-for'];
  const clientIp =
    typeof forwardedFor === 'string' && forwardedFor.length > 0
      ? (forwardedFor.split(',')[0] ?? '').trim()
      : (request.socket.remoteAddress ?? '0.0.0.0');

  return {
    method: (request.method ?? 'GET') as HttpRequestLike['method'],
    path: requestUrl.pathname,
    query: Object.freeze(query),
    headers: Object.freeze(headers),
    rawBody,
    body: parseJsonBody(rawBody),
    clientIp,
  };
}

/**
 * Interpreta el cuerpo como JSON sin lanzar cuando no lo es.
 *
 * @param rawBody - Cuerpo crudo en bytes.
 * @returns Objeto interpretado, o `undefined` cuando el contenido no es JSON valido.
 */
function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Escribe una respuesta JSON y la completa.
 *
 * @param response - Respuesta a completar.
 * @param status - Estado HTTP.
 * @param body - Cuerpo de la respuesta.
 * @param extraHeaders - Cabeceras adicionales.
 */
function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>
): void {
  if (response.writableEnded) {
    return;
  }
  const isBuffer = Buffer.isBuffer(body);
  const serialized: Buffer | string = isBuffer
    ? (body as Buffer)
    : typeof body === 'string'
      ? body
      : JSON.stringify(body ?? {});
  const byteLength = isBuffer ? (serialized as Buffer).length : Buffer.byteLength(serialized as string);
  const defaultContentType = typeof body === 'string'
    ? 'text/plain; charset=utf-8'
    : isBuffer
      ? 'application/octet-stream'
      : 'application/json; charset=utf-8';

  response.writeHead(status, {
    'content-type': defaultContentType,
    'content-length': byteLength,
    ...(extraHeaders ?? {}),
  });
  response.end(serialized);
}

