/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard.ts
 * @modulo 03-visual-trainer-and-rag (Escudo Anti-SSRF y Anti-DNS-Rebinding de 4 Capas)
 * @proposito
 *   Impide que el Navegador de Entrenamiento Remoto sea usado como pivote para alcanzar la red
 *   interna, los servicios de metadatos de la nube o el propio host de la plataforma. El escudo
 *   aplica cuatro capas independientes: (1) validacion estricta de esquema y puerto, (2)
 *   pre-resolucion DNS autoritativa contra resolutores externos que devuelve TODOS los registros
 *   `A` y `AAAA`, (3) evaluacion matematica de cada direccion contra los rangos CIDR prohibidos y
 *   (4) fijacion de la IP validada para que la conexion no vuelva a resolver el nombre. La cuarta
 *   capa es la que neutraliza el ataque de DNS Rebinding: aunque el atacante cambie el registro DNS
 *   entre la validacion y la conexion, el socket se abre contra la direccion ya aprobada.
 *
 * @resumen_contenido
 *   - Interface `SsrfGuardOptions`: Resolutores, timeouts, puertos permitidos y modo desarrollo.
 *   - Interface `DnsResolutionResult`: Vista publica de la pre-resolucion con su clasificacion.
 *   - Interface `PinnedTarget`: Destino aprobado con la IP fijada para la conexion.
 *   - Interface `SsrfAuditSink`: Destino de auditoria para los intentos bloqueados.
 *   - Clase `PinnedDnsSsrfGuard`:
 *       * `assertSafeUrl()`: Puerta de entrada de toda navegacion.
 *       * `validateSecondaryRequest()`: Filtro de cada peticion secundaria del navegador.
 *       * `resolveHostname()`: Pre-resolucion DNS delegada en el resolutor autoritativo.
 *       * `buildChromiumPinningRule()`: Regla `--host-resolver-rules` con `EXCLUDE localhost`.
 *   - Fabrica `createPinnedDnsSsrfGuardFromEnv()`: Construccion desde el contrato de entorno.
 *
 * @dependencias_internas
 *   - `dns-authoritative-resolver.ts`: Pre-resolucion con memoria y clasificacion de riesgo.
 *   - `ip-cidr.util.ts`: Analisis de direcciones y clasificacion de rangos prohibidos.
 *   - `SsrfBlockedIpError` (`src/shared/kernel/result-and-errors.ts`) para el bloqueo auditable.
 *   - `getEnvConfig()` (`src/config/env.schema.ts`) para resolutores y timeouts.
 *
 * @dependencias_externas
 *   - `node:net`, `node:url` (Deteccion de literales de IP y normalizacion de nombres).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (Cada bloqueo se registra con severidad `CRITICAL_SECURITY`).
 *   - PostgreSQL: `training_browser_sessions.ssrf_blocked_attempts_count` (Contador por sesion).
 */

import * as net from 'node:net';
import { domainToASCII } from 'node:url';
import { getEnvConfig } from '../../../config/env.schema';
import { SsrfBlockedIpError } from '../../../shared/kernel/result-and-errors';
import { AuthoritativeDnsResolver } from './dns-authoritative-resolver';
import { parseIpAddress, type ParsedIpAddress } from './ip-cidr.util';

/** Parametros de construccion del escudo Anti-SSRF. */
export interface SsrfGuardOptions {
  /** Resolutores DNS externos de confianza (por ejemplo `1.1.1.1` y `8.8.8.8`). */
  readonly externalResolvers: readonly string[];
  /** Tiempo maximo de espera de la resolucion DNS, en milisegundos. */
  readonly lookupTimeoutMs?: number;
  /** Puertos de red autorizados para la navegacion. */
  readonly allowedPorts?: readonly number[];
  /** Permite redes privadas. Solo para desarrollo local; prohibido en produccion. */
  readonly allowPrivateNetworks?: boolean;
  /** Destino de auditoria de los intentos bloqueados. */
  readonly auditSink?: SsrfAuditSink;
}

/** Vista publica de la pre-resolucion DNS con su clasificacion de riesgo. */
export interface DnsResolutionResult {
  /** Nombre de host normalizado (ya convertido a ASCII si contenia caracteres internacionales). */
  readonly hostname: string;
  /** Direcciones resueltas, en el orden en que fueron descubiertas. */
  readonly addresses: readonly ParsedIpAddress[];
  /** Etiqueta del primer rango prohibido encontrado, o `null` si todas son publicas. */
  readonly blockedRiskLabel: string | null;
  /** Direccion concreta que debe usarse para abrir la conexion. */
  readonly pinnedAddress: ParsedIpAddress | null;
  /** Duracion real de la resolucion, en milisegundos. */
  readonly elapsedMs: number;
  /** Indica si la resolucion se sirvio desde la memoria del resolutor. */
  readonly servedFromCache: boolean;
}

/** Destino aprobado con la direccion IP fijada para la conexion. */
export interface PinnedTarget {
  /** URL original ya normalizada. */
  readonly url: string;
  /** Esquema de la URL (`http` o `https`). */
  readonly protocol: 'http:' | 'https:';
  /** Nombre de host original, que debe conservarse en la cabecera `Host` y en el SNI de TLS. */
  readonly hostname: string;
  /** Puerto de conexion. */
  readonly port: number;
  /** Direccion IP pre-validada contra la que se abrira el socket. */
  readonly pinnedIp: ParsedIpAddress;
  /** Indica si el destino usa TLS. */
  readonly usesTls: boolean;
  /** Regla de fijacion equivalente para Chromium. */
  readonly chromiumPinningRule: string;
}

/** Destino de auditoria de los intentos bloqueados por el escudo. */
export interface SsrfAuditSink {
  /**
   * Registra un intento de acceso bloqueado.
   *
   * @param event - Datos del intento bloqueado.
   */
  recordBlockedAttempt(event: {
    readonly hostname: string;
    readonly resolvedIp: string;
    readonly reason: string;
    readonly attemptedUrl: string;
    readonly organizationId?: string;
    readonly projectId?: string;
  }): Promise<void>;
}

/** Puertos autorizados por omision: los de la web publica. */
const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([80, 443, 8080, 8443]);

/** Esquemas autorizados para la navegacion del entrenador. */
const ALLOWED_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:']);

/**
 * Escudo Anti-SSRF y Anti-DNS-Rebinding.
 * Toda navegacion del Navegador de Entrenamiento Remoto debe pasar por `assertSafeUrl()` antes de
 * abrir un socket, y toda peticion secundaria del navegador por `validateSecondaryRequest()`.
 */
export class PinnedDnsSsrfGuard {
  private readonly dnsResolver: AuthoritativeDnsResolver;
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly allowPrivateNetworks: boolean;
  private readonly auditSink: SsrfAuditSink | undefined;

  /**
   * Construye el escudo con los resolutores y limites indicados.
   *
   * @param options - Resolutores externos, timeouts, puertos y modo desarrollo.
   * @throws Error cuando no se declara ningun resolutor externo de confianza.
   */
  public constructor(options: SsrfGuardOptions) {
    this.dnsResolver = new AuthoritativeDnsResolver({
      externalResolvers: options.externalResolvers,
      ...(options.lookupTimeoutMs === undefined ? {} : { lookupTimeoutMs: options.lookupTimeoutMs }),
      ...(options.allowPrivateNetworks === undefined ? {} : { allowPrivateNetworks: options.allowPrivateNetworks }),
    });
    this.allowedPorts = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.auditSink = options.auditSink;
  }

  /**
   * Valida una URL de navegacion y devuelve el destino con su direccion IP ya fijada.
   *
   * @param rawUrl - URL solicitada por el desarrollador o por el agente.
   * @param context - Organizacion y proyecto para el registro de auditoria.
   * @returns Destino aprobado con la IP pre-validada contra la que abrir el socket.
   * @throws Error cuando la URL es invalida o el esquema o puerto no esta autorizado.
   * @throws SsrfBlockedIpError cuando alguna direccion resuelta cae en un rango prohibido.
   */
  public async assertSafeUrl(
    rawUrl: string,
    context: { readonly organizationId?: string; readonly projectId?: string } = {}
  ): Promise<PinnedTarget> {
    const evaluated = this.evaluateUrl(rawUrl);
    const resolution = await this.resolveHostname(evaluated.hostname, context, rawUrl);

    if (resolution.blockedRiskLabel !== null) {
      throw new SsrfBlockedIpError(
        evaluated.hostname,
        resolution.addresses[0]?.canonical ?? 'desconocida',
        resolution.blockedRiskLabel,
        {
          ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
          ...(context.projectId === undefined ? {} : { resource: `project:${context.projectId}` }),
        }
      );
    }

    const pinnedAddress = resolution.pinnedAddress;
    if (pinnedAddress === null) {
      throw new SsrfBlockedIpError(evaluated.hostname, 'sin registros', 'SIN_DIRECCION_RESOLUBLE', {
        ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
      });
    }

    return {
      url: evaluated.normalizedUrl,
      protocol: evaluated.protocol,
      hostname: evaluated.hostname,
      port: evaluated.port,
      pinnedIp: pinnedAddress,
      usesTls: evaluated.protocol === 'https:',
      chromiumPinningRule: this.buildChromiumPinningRule(evaluated.hostname, pinnedAddress),
    };
  }

  /**
   * Valida una peticion secundaria emitida por el navegador (imagenes, estilos, `XHR`, `fetch`).
   * A diferencia de la navegacion principal, una peticion secundaria bloqueada no lanza excepcion:
   * devuelve `null` para que el adaptador la aborte y el sitio siga funcionando.
   *
   * @param rawUrl - URL de la peticion secundaria.
   * @param context - Organizacion y proyecto para el registro de auditoria.
   * @returns Destino aprobado, o `null` cuando la peticion debe abortarse.
   */
  public async validateSecondaryRequest(
    rawUrl: string,
    context: { readonly organizationId?: string; readonly projectId?: string } = {}
  ): Promise<PinnedTarget | null> {
    try {
      return await this.assertSafeUrl(rawUrl, context);
    } catch (error) {
      if (!(error instanceof SsrfBlockedIpError)) {
        await this.auditSink?.recordBlockedAttempt({
          hostname: this.safeHostname(rawUrl),
          resolvedIp: 'no resuelta',
          reason: 'URL_INVALIDA_O_ESQUEMA_NO_AUTORIZADO',
          attemptedUrl: rawUrl,
          ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
          ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
        });
      }
      return null;
    }
  }

  /**
   * Pre-resuelve un nombre de host y clasifica todas sus direcciones.
   * Se rechaza el nombre completo si CUALQUIER direccion resulta peligrosa: aceptar una direccion
   * segura mientras otra apunta a la red interna permitiria al atacante ganar la carrera.
   *
   * @param rawHostname - Nombre de host a resolver.
   * @param context - Organizacion y proyecto para el registro de auditoria.
   * @param attemptedUrl - URL completa que origino la resolucion, usada en auditoria.
   * @returns Resultado con las direcciones, la clasificacion y la direccion fijada.
   */
  public async resolveHostname(
    rawHostname: string,
    context: { readonly organizationId?: string; readonly projectId?: string } = {},
    attemptedUrl: string = `https://${rawHostname}/`
  ): Promise<DnsResolutionResult> {
    const hostname = this.normalizeHostname(rawHostname);
    const resolution = await this.dnsResolver.resolve(hostname);

    if (resolution.blockedRiskLabel !== null) {
      await this.reportBlockedAttempt({
        hostname,
        resolvedIp: resolution.offendingAddress?.canonical ?? 'desconocida',
        reason: resolution.blockedRiskLabel,
        attemptedUrl,
        context,
      });
    }

    return {
      hostname: resolution.hostname,
      addresses: resolution.resolvedAddresses.map((entry) => entry.address),
      blockedRiskLabel: resolution.blockedRiskLabel,
      pinnedAddress: resolution.pinnedAddress,
      elapsedMs: resolution.elapsedMs,
      servedFromCache: resolution.servedFromCache,
    };
  }

  /**
   * Construye la regla de fijacion de resolucion para Chromium.
   * `MAP <host> <ip>` obliga al navegador a usar la direccion ya validada y `EXCLUDE localhost`
   * impide que la propia regla abra una excepcion hacia el bucle local.
   *
   * @param hostname - Nombre de host original.
   * @param pinnedAddress - Direccion pre-validada.
   * @returns Regla completa lista para `--host-resolver-rules`.
   */
  public buildChromiumPinningRule(hostname: string, pinnedAddress: ParsedIpAddress): string {
    const literal = pinnedAddress.version === 6 ? `[${pinnedAddress.canonical}]` : pinnedAddress.canonical;
    return `MAP ${hostname} ${literal}, EXCLUDE localhost`;
  }

  /** Numero de nombres de host conservados en la memoria de resolucion. */
  public get cachedHostnameCount(): number {
    return this.dnsResolver.cachedHostnameCount;
  }

  /**
   * Limpia la memoria de resolucion DNS.
   * Debe invocarse al abrir y cerrar una sesion de entrenamiento, para que un cambio de DNS se
   * refleje de inmediato en la siguiente sesion.
   */
  public clearResolutionCache(): void {
    this.dnsResolver.clearCache();
  }

  /**
   * Valida esquema, puerto y forma de la URL antes de resolver nada.
   *
   * @param rawUrl - URL solicitada.
   * @returns Componentes ya normalizados de la URL.
   * @throws Error cuando la URL es invalida o su esquema o puerto no estan autorizados.
   */
  private evaluateUrl(rawUrl: string): { normalizedUrl: string; protocol: 'http:' | 'https:'; hostname: string; port: number } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error(`ESCUDO_SSRF_URL_INVALIDA: la direccion "${rawUrl}" no es una URL absoluta valida.`);
    }

    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(`ESCUDO_SSRF_ESQUEMA_NO_AUTORIZADO: el esquema "${parsed.protocol}" esta prohibido; solo se admite HTTP y HTTPS.`);
    }

    const hostname = this.normalizeHostname(parsed.hostname.replace(/^\[|\]$/gu, ''));
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;

    if (!this.allowedPorts.has(port) && !(this.allowPrivateNetworks && port === 9222)) {
      throw new Error(`ESCUDO_SSRF_PUERTO_NO_AUTORIZADO: el puerto ${port} no esta en la lista de puertos permitidos.`);
    }

    if (hostname.length === 0) {
      throw new Error('ESCUDO_SSRF_HOST_VACIO: la URL no declara un nombre de host utilizable.');
    }

    return { normalizedUrl: parsed.toString(), protocol: parsed.protocol as 'http:' | 'https:', hostname, port };
  }

  /**
   * Normaliza un nombre de host: minusculas, sin punto final y convertido a ASCII si contiene
   * caracteres internacionales (evita que un nombre punycode malicioso eluda las comprobaciones).
   *
   * @param rawHostname - Nombre de host original.
   * @returns Nombre de host normalizado en ASCII y minusculas.
   */
  private normalizeHostname(rawHostname: string): string {
    const trimmed = rawHostname.trim().toLowerCase().replace(/\.$/u, '');
    if (trimmed.length === 0) {
      return '';
    }
    if (net.isIP(trimmed) !== 0 || parseIpAddress(trimmed) !== null) {
      return trimmed;
    }
    const asciiHostname = domainToASCII(trimmed);
    return asciiHostname.length > 0 ? asciiHostname.toLowerCase() : trimmed;
  }

  /**
   * Notifica un intento bloqueado al destino de auditoria, si fue configurado.
   *
   * @param event - Datos del intento bloqueado.
   */
  private async reportBlockedAttempt(event: {
    readonly hostname: string;
    readonly resolvedIp: string;
    readonly reason: string;
    readonly attemptedUrl: string;
    readonly context: { readonly organizationId?: string; readonly projectId?: string };
  }): Promise<void> {
    if (this.auditSink === undefined) {
      return;
    }
    await this.auditSink.recordBlockedAttempt({
      hostname: event.hostname,
      resolvedIp: event.resolvedIp,
      reason: event.reason,
      attemptedUrl: event.attemptedUrl,
      ...(event.context.organizationId === undefined ? {} : { organizationId: event.context.organizationId }),
      ...(event.context.projectId === undefined ? {} : { projectId: event.context.projectId }),
    });
  }

  /**
   * Extrae el nombre de host de una URL sin propagar errores de analisis.
   *
   * @param rawUrl - URL de la que extraer el host.
   * @returns Nombre de host, o la propia cadena cuando no es analizable.
   */
  private safeHostname(rawUrl: string): string {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return rawUrl.slice(0, 120);
    }
  }
}

/**
 * Construye el escudo Anti-SSRF a partir del contrato de entorno ya validado.
 *
 * @param auditSink - Destino de auditoria de los intentos bloqueados.
 * @returns Escudo configurado con los resolutores, timeouts y modo de desarrollo del entorno.
 */
export function createPinnedDnsSsrfGuardFromEnv(auditSink?: SsrfAuditSink): PinnedDnsSsrfGuard {
  const environment = getEnvConfig();
  return new PinnedDnsSsrfGuard({
    externalResolvers: environment.EXTERNAL_DNS_RESOLVERS,
    lookupTimeoutMs: environment.SSRF_DNS_LOOKUP_TIMEOUT_MS,
    allowPrivateNetworks: environment.SSRF_ALLOW_PRIVATE_NETWORKS,
    ...(auditSink === undefined ? {} : { auditSink }),
  });
}
