/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/dns-authoritative-resolver.ts
 * @modulo 03-visual-trainer-and-rag (Resolutor DNS Autoritativo con Memoria y Clasificacion)
 * @proposito
 *   Ejecuta la pre-resolucion DNS del escudo Anti-SSRF contra resolutores externos de confianza,
 *   obteniendo TODOS los registros `A` y `AAAA` del nombre y clasificando cada direccion contra los
 *   rangos prohibidos. Se separa del escudo para que la politica de bloqueo y el transporte de
 *   resolucion evolucionen por separado, y para que la memoria de resolucion tenga un unico dueño
 *   con una vigencia explicita. Un nombre se considera peligroso si CUALQUIERA de sus direcciones
 *   lo es: aceptar la primera direccion segura permitiria a un atacante ganar la carrera con un
 *   registro DNS cambiante (DNS Rebinding).
 *
 * @resumen_contenido
 *   - Interface `DnsResolverOptions`: Resolutores, timeout y politica de redes privadas.
 *   - Interface `ResolvedAddress`: Direccion resuelta con su etiqueta de riesgo.
 *   - Interface `AuthoritativeResolution`: Resultado completo de la pre-resolucion.
 *   - Clase `AuthoritativeDnsResolver`:
 *       * `resolve()`: Pre-resolucion con memoria, timeout y clasificacion.
 *       * `resolveLiteral()`: Validacion directa de un literal de IP, sin consultar DNS.
 *       * `clearCache()` y `cachedHostnameCount`: Control y diagnostico de la memoria.
 *
 * @dependencias_internas
 *   - `ip-cidr.util.ts`: Analisis de direcciones y clasificacion de rangos prohibidos.
 *
 * @dependencias_externas
 *   - `node:dns`, `node:net` (Consultas autoritativas y deteccion de literales de IP).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (La etiqueta de riesgo alimenta el motivo del bloqueo).
 */

import * as dns from 'node:dns';
import * as net from 'node:net';
import { classifyBlockedAddress, parseIpAddress, type ParsedIpAddress } from './ip-cidr.util';

/** Parametros de construccion del resolutor autoritativo. */
export interface DnsResolverOptions {
  /** Resolutores DNS externos de confianza (por ejemplo `1.1.1.1` y `8.8.8.8`). */
  readonly externalResolvers: readonly string[];
  /** Tiempo maximo de espera de cada consulta, en milisegundos. */
  readonly lookupTimeoutMs?: number;
  /** Permite direcciones de red privada: solo para desarrollo local. */
  readonly allowPrivateNetworks?: boolean;
}

/** Direccion resuelta junto con su etiqueta de riesgo. */
export interface ResolvedAddress {
  /** Direccion normalizada. */
  readonly address: ParsedIpAddress;
  /** Etiqueta del rango prohibido al que pertenece, o `null` si es publica. */
  readonly riskLabel: string | null;
}

/** Resultado completo de una pre-resolucion DNS autoritativa. */
export interface AuthoritativeResolution {
  /** Nombre de host normalizado. */
  readonly hostname: string;
  /** Direcciones resueltas con su clasificacion individual. */
  readonly resolvedAddresses: readonly ResolvedAddress[];
  /** Etiqueta del primer rango prohibido encontrado, o `null` si todas las direcciones son publicas. */
  readonly blockedRiskLabel: string | null;
  /** Direccion concreta que debe fijarse para la conexion, o `null` cuando no hay ninguna admisible. */
  readonly pinnedAddress: ParsedIpAddress | null;
  /** Direccion concreta que provoco el bloqueo, usada en el registro de auditoria. */
  readonly offendingAddress: ParsedIpAddress | null;
  /** Duracion real de la resolucion, en milisegundos. */
  readonly elapsedMs: number;
  /** Indica si el resultado provino de la memoria de la clase. */
  readonly servedFromCache: boolean;
}

/** Entrada de memoria de resolucion con su marca de expiracion. */
interface CachedResolution {
  readonly resolvedAddresses: readonly ResolvedAddress[];
  readonly expiresAtMs: number;
}

/** Vigencia de la memoria de resolucion, en milisegundos (5 minutos). */
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

/** Codigos de error de DNS que significan "el nombre no tiene registros", no un fallo real. */
const NO_RECORDS_ERROR_CODES: readonly string[] = Object.freeze(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'EAI_AGAIN']);

/**
 * Resolutor DNS autoritativo con memoria de corta vigencia y clasificacion de riesgo.
 */
export class AuthoritativeDnsResolver {
  private readonly externalResolvers: readonly string[];
  private readonly lookupTimeoutMs: number;
  private readonly allowPrivateNetworks: boolean;
  private readonly resolutionCache = new Map<string, CachedResolution>();

  /**
   * Construye el resolutor con los servidores externos indicados.
   *
   * @param options - Resolutores, timeout y politica de redes privadas.
   * @throws Error cuando no se declara ningun resolutor externo de confianza.
   */
  public constructor(options: DnsResolverOptions) {
    const resolvers = options.externalResolvers.filter((resolver) => resolver.trim().length > 0);
    if (resolvers.length === 0) {
      throw new Error('RESOLUTOR_SIN_SERVIDORES: se exige al menos un resolutor DNS externo de confianza.');
    }
    this.externalResolvers = Object.freeze([...resolvers]);
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? 3000;
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
  }

  /**
   * Pre-resuelve un nombre de host y clasifica todas sus direcciones.
   *
   * @param hostname - Nombre de host ya normalizado.
   * @returns Resultado con las direcciones, la clasificacion y la direccion a fijar.
   */
  public async resolve(hostname: string): Promise<AuthoritativeResolution> {
    const startedAt = Date.now();
    const literal = this.resolveLiteral(hostname, startedAt);
    if (literal !== null) {
      return literal;
    }

    const cached = this.resolutionCache.get(hostname);
    if (cached !== undefined && cached.expiresAtMs > Date.now()) {
      return this.classify(hostname, cached.resolvedAddresses, startedAt, true);
    }

    const resolvedAddresses = await this.queryExternalResolvers(hostname);
    if (resolvedAddresses.length === 0) {
      return {
        hostname,
        resolvedAddresses: [],
        blockedRiskLabel: 'SIN_REGISTROS_DNS',
        pinnedAddress: null,
        offendingAddress: null,
        elapsedMs: Date.now() - startedAt,
        servedFromCache: false,
      };
    }

    this.resolutionCache.set(hostname, { resolvedAddresses, expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS });
    return this.classify(hostname, resolvedAddresses, startedAt, false);
  }

  /**
   * Valida un literal de direccion IP sin consultar DNS.
   *
   * @param hostname - Cadena que podria ser una direccion IP literal.
   * @param startedAt - Marca de inicio para medir la duracion.
   * @returns Resultado de la validacion, o `null` cuando la cadena no es un literal de IP.
   */
  public resolveLiteral(hostname: string, startedAt: number = Date.now()): AuthoritativeResolution | null {
    if (net.isIP(hostname) === 0) {
      return null;
    }

    const address = parseIpAddress(hostname);
    if (address === null) {
      return null;
    }

    const riskLabel = this.allowPrivateNetworks ? null : classifyBlockedAddress(address);
    return {
      hostname,
      resolvedAddresses: [{ address, riskLabel }],
      blockedRiskLabel: riskLabel,
      pinnedAddress: riskLabel === null ? address : null,
      offendingAddress: riskLabel === null ? null : address,
      elapsedMs: Date.now() - startedAt,
      servedFromCache: false,
    };
  }

  /** Numero de nombres de host conservados en la memoria de resolucion. */
  public get cachedHostnameCount(): number {
    return this.resolutionCache.size;
  }

  /**
   * Limpia la memoria de resolucion para que el siguiente acceso vuelva a consultar el DNS.
   * Debe invocarse al abrir y cerrar cada sesion de entrenamiento.
   */
  public clearCache(): void {
    this.resolutionCache.clear();
  }

  /**
   * Consulta los resolutores externos en busca de registros `A` y `AAAA`, clasificando cada uno.
   *
   * @param hostname - Nombre de host ya normalizado.
   * @returns Direcciones resueltas con su etiqueta de riesgo (puede ser una lista vacia).
   */
  private async queryExternalResolvers(hostname: string): Promise<readonly ResolvedAddress[]> {
    const resolver = new dns.promises.Resolver();
    resolver.setServers([...this.externalResolvers]);

    const [ipv4Addresses, ipv6Addresses] = await Promise.all([
      this.resolveWithTimeout(() => resolver.resolve4(hostname), 'A'),
      this.resolveWithTimeout(() => resolver.resolve6(hostname), 'AAAA'),
    ]);

    const collected: ResolvedAddress[] = [];
    for (const candidate of [...(ipv4Addresses ?? []), ...(ipv6Addresses ?? [])]) {
      const parsed = parseIpAddress(candidate);
      if (parsed === null) {
        continue;
      }
      if (collected.some((existing) => existing.address.value === parsed.value && existing.address.version === parsed.version)) {
        continue;
      }
      collected.push({ address: parsed, riskLabel: this.allowPrivateNetworks ? null : classifyBlockedAddress(parsed) });
    }

    return Object.freeze(collected);
  }

  /**
   * Ejecuta una consulta DNS aplicando el limite de tiempo configurado.
   * Un resolutor que no responde debe producir un fallo rapido y controlado, nunca dejar la sesion
   * de entrenamiento colgada.
   *
   * @param query - Funcion que lanza la consulta DNS.
   * @param label - Etiqueta del tipo de registro para el diagnostico.
   * @returns Direcciones textuales devueltas, o `null` si no hay registros o la consulta expira.
   */
  private async resolveWithTimeout(query: () => Promise<string[]>, label: string): Promise<string[] | null> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(null);
      }, this.lookupTimeoutMs);
    });

    try {
      const queryPromise = query()
        .then((addresses) => addresses)
        .catch((error: unknown) => {
          const errorCode = (error as NodeJS.ErrnoException | null)?.code;
          if (typeof errorCode === 'string' && NO_RECORDS_ERROR_CODES.includes(errorCode)) {
            return null;
          }
          throw new Error(`RESOLUCION_DNS_FALLIDA_${label}: ${error instanceof Error ? error.message : 'consulta fallida'}`);
        });

      return await Promise.race([queryPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Clasifica un conjunto de direcciones ya resueltas y decide la direccion a fijar.
   *
   * @param hostname - Nombre de host resuelto.
   * @param resolvedAddresses - Direcciones con su etiqueta individual.
   * @param startedAt - Marca de inicio para medir la duracion.
   * @param servedFromCache - Indica si las direcciones provienen de la memoria.
   * @returns Resultado consolidado de la resolucion.
   */
  private classify(
    hostname: string,
    resolvedAddresses: readonly ResolvedAddress[],
    startedAt: number,
    servedFromCache: boolean
  ): AuthoritativeResolution {
    const offending = resolvedAddresses.find((entry) => entry.riskLabel !== null);
    const blockedRiskLabel = offending?.riskLabel ?? null;

    return {
      hostname,
      resolvedAddresses,
      blockedRiskLabel,
      pinnedAddress: blockedRiskLabel === null ? (resolvedAddresses[0]?.address ?? null) : null,
      offendingAddress: offending?.address ?? null,
      elapsedMs: Date.now() - startedAt,
      servedFromCache,
    };
  }
}
