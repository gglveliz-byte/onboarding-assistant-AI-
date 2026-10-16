/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/ip-cidr.util.ts
 * @modulo 03-visual-trainer-and-rag (Evaluador Matematico de Subredes y Clasificacion de Riesgo)
 * @proposito
 *   Implementa la aritmetica de direcciones IP que sostiene el escudo Anti-SSRF. Convierte
 *   direcciones IPv4 e IPv6 a enteros sin signo y evalua pertenencia a bloques CIDR, de modo que
 *   el bloqueo de rangos peligrosos sea una comparacion matematica exacta y no una lista de
 *   coincidencias de texto (una lista de cadenas jamas detectaria `127.0.0.2` ni `0x7f000001`).
 *   Clasifica cada direccion con una etiqueta legible en espanol para que el registro de auditoria
 *   explique exactamente por que se bloqueo un destino.
 *
 * @resumen_contenido
 *   - Interface `ParsedIpAddress`: Direccion normalizada con version y valor entero.
 *   - Interface `CidrBlock`: Bloque CIDR ya validado con su etiqueta de riesgo.
 *   - Constante `BLOCKED_IPV4_CIDRS` y `BLOCKED_IPV6_CIDRS`: Rangos prohibidos de la plataforma.
 *   - Funciones `parseIpAddress()`, `parseIpv4()`, `parseIpv6()`: Analisis estricto de direcciones.
 *   - Funciones `isIpInsideCidr()` y `classifyBlockedAddress()`: Evaluacion y clasificacion.
 *   - Funcion `isPrivateNetworkRange()`: Deteccion de rangos RFC 1918 y equivalentes.
 *
 * @dependencias_internas
 *   - Ninguna (Utilidad matematica pura, sin dependencias de dominio ni de infraestructura).
 *
 * @dependencias_externas
 *   - Ninguna (Aritmetica entera nativa: prohibido instalar librerias de analisis de IP).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (La etiqueta devuelta se registra como motivo del bloqueo).
 *   - PostgreSQL: `training_browser_sessions.ssrf_blocked_attempts_count` (Contador de intentos).
 */

/** Direccion IP normalizada y lista para comparacion matematica. */
export interface ParsedIpAddress {
  /** Version del protocolo: 4 o 6. */
  readonly version: 4 | 6;
  /** Valor entero sin signo de la direccion (los IPv4 se representan como enteros de 32 bits). */
  readonly value: bigint;
  /** Representacion canonica de la direccion. */
  readonly canonical: string;
  /** Indica si la direccion es un IPv4 mapeado dentro de IPv6 (`::ffff:0:0/96`). */
  readonly isIpv4Mapped: boolean;
}

/** Bloque CIDR ya validado con su etiqueta de riesgo en espanol. */
export interface CidrBlock {
  /** Bloque en notacion CIDR (por ejemplo `169.254.0.0/16`). */
  readonly cidr: string;
  /** Prefijo binario del bloque. */
  readonly prefixLength: number;
  /** Valor entero de la base del bloque. */
  readonly networkValue: bigint;
  /** Version del protocolo del bloque. */
  readonly version: 4 | 6;
  /** Etiqueta legible con el motivo del bloqueo. */
  readonly riskLabel: string;
}

/** Mascara de 32 bits y 128 bits usadas por la aritmetica de prefijos. */
const IPV4_MAX_VALUE = (1n << 32n) - 1n;
const IPV6_MAX_VALUE = (1n << 128n) - 1n;

/** Patron estricto de una direccion IPv4 en notacion decimal punteada. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Patron de un bloque CIDR IPv4 o IPv6. */
const CIDR_PATTERN = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/u;

/**
 * Analiza una direccion IPv4 en notacion decimal punteada.
 * Rechaza formas ambiguas como `127.1`, `0x7f.0.0.1` o cualquier octeto fuera de rango: una
 * direccion que no sea estrictamente canonica se considera no confiable y no se analiza.
 *
 * @param candidate - Cadena candidata a analizar.
 * @returns Direccion normalizada, o `null` si el formato no es una IPv4 canonica valida.
 */
export function parseIpv4(candidate: string): ParsedIpAddress | null {
  const match = IPV4_PATTERN.exec(candidate);
  if (match === null) {
    return null;
  }

  const octets: number[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const rawOctet = match[index];
    if (rawOctet === undefined) {
      return null;
    }
    if (rawOctet.length > 1 && rawOctet.startsWith('0')) {
      // Notacion octal implicita: se rechaza por ambiguedad.
      return null;
    }
    const octetValue = Number.parseInt(rawOctet, 10);
    if (!Number.isInteger(octetValue) || octetValue < 0 || octetValue > 255) {
      return null;
    }
    octets.push(octetValue);
  }

  const [first = 0, second = 0, third = 0, fourth = 0] = octets;
  const value = (BigInt(first) << 24n) | (BigInt(second) << 16n) | (BigInt(third) << 8n) | BigInt(fourth);

  return { version: 4, value, canonical: `${first}.${second}.${third}.${fourth}`, isIpv4Mapped: false };
}

/**
 * Expande una direccion IPv6 a sus ocho grupos hexadecimales, admitiendo la notacion comprimida
 * con `::` y el sufijo IPv4 incrustado (`::ffff:192.168.0.1`).
 *
 * @param candidate - Cadena candidata a expandir.
 * @returns Lista de ocho grupos de 16 bits, o `null` si la forma es invalida.
 */
function expandIpv6Groups(candidate: string): number[] | null {
  let working = candidate;

  // Un sufijo IPv4 incrustado se convierte a sus dos grupos hexadecimales equivalentes.
  const embeddedIpv4Match = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/u.exec(working);
  if (embeddedIpv4Match !== null) {
    const prefix = embeddedIpv4Match[1] ?? '';
    const embedded = parseIpv4(embeddedIpv4Match[2] ?? '');
    if (embedded === null) {
      return null;
    }
    const highGroup = Number((embedded.value >> 16n) & 0xffffn).toString(16);
    const lowGroup = Number(embedded.value & 0xffffn).toString(16);
    working = `${prefix}${highGroup}:${lowGroup}`;
  }

  if ((working.match(/::/gu) ?? []).length > 1) {
    return null;
  }

  const hasCompression = working.includes('::');
  const [headPart = '', tailPart = ''] = hasCompression ? working.split('::') : [working, ''];
  const headGroups = headPart.length > 0 ? headPart.split(':') : [];
  const tailGroups = hasCompression && tailPart.length > 0 ? tailPart.split(':') : [];
  const allGroups = [...headGroups, ...tailGroups];

  if (!hasCompression && allGroups.length !== 8) {
    return null;
  }
  if (hasCompression && allGroups.length > 7) {
    return null;
  }

  const groups: number[] = [];
  for (const group of allGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) {
      return null;
    }
    groups.push(Number.parseInt(group, 16));
  }

  if (hasCompression) {
    const missingGroups = 8 - groups.length;
    const headCount = headGroups.length;
    return [...groups.slice(0, headCount), ...new Array<number>(missingGroups).fill(0), ...groups.slice(headCount)];
  }

  return groups;
}

/**
 * Analiza una direccion IPv6 (incluida la forma IPv4 mapeada) y la normaliza.
 *
 * @param candidate - Cadena candidata a analizar.
 * @returns Direccion normalizada, o `null` si el formato no es una IPv6 valida.
 */
export function parseIpv6(candidate: string): ParsedIpAddress | null {
  const groups = expandIpv6Groups(candidate);
  if (groups === null || groups.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }

  const isIpv4Mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  const canonical = groups.map((group) => group.toString(16).padStart(4, '0')).join(':').replace(/(^|:)0{1,4}(?=:)/gu, '$1').replace(/:{3,}/u, '::');

  return { version: 6, value, canonical, isIpv4Mapped };
}

/**
 * Analiza una direccion IP de cualquier version, detectando tambien los IPv4 mapeados en IPv6.
 *
 * @param candidate - Cadena candidata a analizar.
 * @returns Direccion normalizada con su version, o `null` si la forma es invalida.
 */
export function parseIpAddress(candidate: string): ParsedIpAddress | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== null) {
    return ipv4;
  }

  const ipv6 = parseIpv6(trimmed);
  if (ipv6 === null) {
    return null;
  }

  // Un IPv4 mapeado se trata como IPv4 para que las reglas de bloqueo de IPv4 lo alcancen.
  if (ipv6.isIpv4Mapped) {
    return { version: 4, value: ipv6.value & IPV4_MAX_VALUE, canonical: ipv4FromValue(ipv6.value & IPV4_MAX_VALUE), isIpv4Mapped: true };
  }

  return ipv6;
}

/**
 * Convierte un entero de 32 bits a su representacion decimal punteada.
 *
 * @param value - Valor entero de la direccion IPv4.
 * @returns Direccion IPv4 en notacion decimal punteada.
 */
export function ipv4FromValue(value: bigint): string {
  const first = Number((value >> 24n) & 0xffn);
  const second = Number((value >> 16n) & 0xffn);
  const third = Number((value >> 8n) & 0xffn);
  const fourth = Number(value & 0xffn);
  return `${first}.${second}.${third}.${fourth}`;
}

/**
 * Construye un bloque CIDR validado a partir de su notacion textual.
 *
 * @param cidr - Bloque en notacion CIDR (por ejemplo `10.0.0.0/8`).
 * @param riskLabel - Etiqueta en espanol que explica por que el bloque esta prohibido.
 * @returns Bloque validado, o `null` si la notacion o el prefijo son invalidos.
 */
export function parseCidrBlock(cidr: string, riskLabel: string): CidrBlock | null {
  const match = CIDR_PATTERN.exec(cidr);
  if (match === null) {
    return null;
  }

  const address = parseIpAddress(match[1] ?? '');
  const prefixLength = Number.parseInt(match[2] ?? '', 10);
  if (address === null || !Number.isInteger(prefixLength)) {
    return null;
  }

  const maxPrefix = address.version === 4 ? 32 : 128;
  if (prefixLength < 0 || prefixLength > maxPrefix) {
    return null;
  }

  const hostBits = BigInt(maxPrefix - prefixLength);
  const networkValue = (address.value >> hostBits) << hostBits;

  return { cidr, prefixLength, networkValue, version: address.version, riskLabel };
}

/**
 * Determina si una direccion pertenece a un bloque CIDR.
 *
 * @param address - Direccion ya analizada.
 * @param block - Bloque CIDR ya validado.
 * @returns `true` cuando la direccion cae dentro del bloque.
 */
export function isIpInsideCidr(address: ParsedIpAddress, block: CidrBlock): boolean {
  if (address.version !== block.version) {
    return false;
  }
  const maxPrefix = address.version === 4 ? 32 : 128;
  const hostBits = BigInt(maxPrefix - block.prefixLength);
  return (address.value >> hostBits) << hostBits === block.networkValue;
}

/**
 * Rangos IPv4 prohibidos: metadatos de nube, bucle local, redes privadas, CGNAT y reservadas.
 * El orden importa: `classifyBlockedAddress()` devuelve la PRIMERA coincidencia, por lo que los
 * bloques mas especificos (prefijo mas largo) deben declararse antes que los genericos. De este
 * modo `169.254.169.254` se reporta como `METADATOS_DE_NUBE` en lugar de como enlace local
 * generico, y el registro de auditoria explica el motivo exacto del bloqueo.
 */
export const BLOCKED_IPV4_CIDRS: readonly CidrBlock[] = Object.freeze(
  [
    parseCidrBlock('169.254.169.254/32', 'METADATOS_DE_NUBE'),
    parseCidrBlock('100.100.100.200/32', 'METADATOS_DE_NUBE_ALIYUN'),
    parseCidrBlock('255.255.255.255/32', 'DIFUSION_LIMITADA'),
    parseCidrBlock('169.254.0.0/16', 'LINK_LOCAL_AUTOCONFIGURADO'),
    parseCidrBlock('127.0.0.0/8', 'BUCLE_LOCAL'),
    parseCidrBlock('0.0.0.0/8', 'DIRECCION_NO_ESPECIFICADA'),
    parseCidrBlock('10.0.0.0/8', 'RED_PRIVADA_RFC1918'),
    parseCidrBlock('172.16.0.0/12', 'RED_PRIVADA_RFC1918'),
    parseCidrBlock('192.168.0.0/16', 'RED_PRIVADA_RFC1918'),
    parseCidrBlock('100.64.0.0/10', 'CGNAT_OPERADOR'),
    parseCidrBlock('192.0.0.0/24', 'RESERVADA_IETF'),
    parseCidrBlock('192.0.2.0/24', 'DOCUMENTACION_TEST'),
    parseCidrBlock('198.18.0.0/15', 'BENCHMARKING'),
    parseCidrBlock('198.51.100.0/24', 'DOCUMENTACION_TEST'),
    parseCidrBlock('203.0.113.0/24', 'DOCUMENTACION_TEST'),
    parseCidrBlock('224.0.0.0/4', 'MULTICAST'),
    parseCidrBlock('240.0.0.0/4', 'RESERVADA_FUTURA'),
  ].filter((block): block is CidrBlock => block !== null)
);

/**
 * Rangos IPv6 prohibidos: bucle local, enlace local, unico local, metadatos y mapeos.
 * Igual que en IPv4, los prefijos mas especificos se declaran primero.
 */
export const BLOCKED_IPV6_CIDRS: readonly CidrBlock[] = Object.freeze(
  [
    parseCidrBlock('fd00:ec2::254/128', 'METADATOS_DE_NUBE'),
    parseCidrBlock('::1/128', 'BUCLE_LOCAL'),
    parseCidrBlock('::/128', 'DIRECCION_NO_ESPECIFICADA'),
    parseCidrBlock('fe80::/10', 'ENLACE_LOCAL'),
    parseCidrBlock('fec0::/10', 'SITIO_LOCAL_OBSOLETO'),
    parseCidrBlock('fc00::/7', 'UNICO_LOCAL'),
    parseCidrBlock('::ffff:0:0/96', 'IPV4_MAPEADO'),
    parseCidrBlock('64:ff9b::/96', 'TRADUCCION_NAT64'),
    parseCidrBlock('2001:db8::/32', 'DOCUMENTACION_TEST'),
    parseCidrBlock('2002::/16', 'TUNEL_6TO4'),
    parseCidrBlock('ff00::/8', 'MULTICAST'),
  ].filter((block): block is CidrBlock => block !== null)
);

/**
 * Clasifica una direccion contra todos los rangos prohibidos de la plataforma.
 *
 * @param address - Direccion ya analizada.
 * @returns Etiqueta del bloque coincidente, o `null` cuando la direccion es publica y admisible.
 */
export function classifyBlockedAddress(address: ParsedIpAddress): string | null {
  const candidateBlocks = address.version === 4 ? BLOCKED_IPV4_CIDRS : BLOCKED_IPV6_CIDRS;
  for (const block of candidateBlocks) {
    if (isIpInsideCidr(address, block)) {
      return block.riskLabel;
    }
  }
  return null;
}

/**
 * Determina si una direccion pertenece a un rango de red privada o no enrutable.
 * Se usa para la bandera de desarrollo `SSRF_ALLOW_PRIVATE_NETWORKS`, que jamas debe estar
 * activa en produccion.
 *
 * @param address - Direccion ya analizada.
 * @returns `true` cuando la direccion esta en un rango privado o reservado.
 */
export function isPrivateNetworkRange(address: ParsedIpAddress): boolean {
  return classifyBlockedAddress(address) !== null;
}

/**
 * Comprueba si una cadena es una direccion IP valida de cualquier version.
 *
 * @param candidate - Cadena candidata.
 * @returns `true` cuando la cadena es una direccion IP analizable.
 */
export function isIpAddressLiteral(candidate: string): boolean {
  return parseIpAddress(candidate) !== null;
}

/** Limites numericos exportados para las comprobaciones de las pruebas automatizadas. */
export const IP_ADDRESS_LIMITS = Object.freeze({ IPV4_MAX_VALUE, IPV6_MAX_VALUE });
