/**
 * @archivo tests/unit/trainer-contracts.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba Unitaria de Aritmetica CIDR y Scripts de Overlay)
 * @proposito
 *   Certifica sin dependencia de red las dos piezas que sostienen el entrenamiento visual: la
 *   aritmetica de direcciones IP que decide que destinos se bloquean y el contenido de los scripts
 *   que se inyectan en el navegador remoto. Se comprueba que el filtro de privacidad cubra los
 *   mismos marcadores que el SDK y que la cascada de selectores incluya las cuatro estrategias
 *   exigidas por el plano, ademas de los tres viewports oficiales de medicion.
 *
 * @resumen_contenido
 *   - Bloque `verifyIpAddressParsing()`: Analisis estricto de IPv4 e IPv6 y sus formas ambiguas.
 *   - Bloque `verifyCidrEvaluation()`: Pertenencia a bloques y limites de cada rango prohibido.
 *   - Bloque `verifyOverlayScripts()`: Filtro de privacidad, cascada de selectores y viewports.
 *   - Bloque `verifyOverlayAgentContract()`: Respuestas del navegador validadas y descartadas.
 *
 * @dependencias_internas
 *   - `ip-cidr.util.ts` y `dom-overlay-scripts.ts` del modulo de entrenamiento visual.
 *   - `CdpPayloadParser` (`src/modules/03-visual-trainer-and-rag/infrastructure/cdp-payload-parsers.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente estatica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import { CdpPayloadParser } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/cdp-payload-parsers';
import {
  SENSITIVE_FIELD_MARKERS,
  VIEWPORT_PRESETS,
  buildOverlayInstallScript,
} from '../../src/modules/03-visual-trainer-and-rag/infrastructure/dom-overlay-scripts';
import {
  BLOCKED_IPV4_CIDRS,
  BLOCKED_IPV6_CIDRS,
  classifyBlockedAddress,
  isIpInsideCidr,
  parseCidrBlock,
  parseIpAddress,
  parseIpv4,
  parseIpv6,
} from '../../src/modules/03-visual-trainer-and-rag/infrastructure/ip-cidr.util';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/**
 * Aserta una condicion y contabiliza la verificacion superada.
 *
 * @param condition - Condicion booleana que debe cumplirse.
 * @param description - Descripcion legible del comportamiento verificado.
 */
function check(condition: boolean, description: string): void {
  assert.ok(condition, `FALLO: ${description}`);
  passedAssertions += 1;
}

/** Verifica el analisis estricto de direcciones IPv4 e IPv6. */
function verifyIpAddressParsing(): void {
  const validIpv4 = parseIpv4('192.168.1.10');
  check(validIpv4 !== null && validIpv4.value === 0xc0a8010an, 'Una IPv4 valida debe convertirse a su entero de 32 bits');
  check(validIpv4?.canonical === '192.168.1.10', 'La IPv4 debe conservar su representacion canonica');

  check(parseIpv4('256.1.1.1') === null, 'Un octeto mayor a 255 debe rechazarse');
  check(parseIpv4('127.1') === null, 'La forma abreviada 127.1 debe rechazarse por ambigua');
  check(parseIpv4('0177.0.0.1') === null, 'La notacion octal implicita debe rechazarse');
  check(parseIpv4('1.2.3.4.5') === null, 'Una IPv4 con cinco octetos debe rechazarse');
  check(parseIpv4('1.2.3.-4') === null, 'Una IPv4 con octeto negativo debe rechazarse');

  const loopbackV6 = parseIpv6('::1');
  check(loopbackV6 !== null && loopbackV6.value === 1n, 'El bucle local IPv6 debe convertirse a 1');
  check(loopbackV6?.isIpv4Mapped === false, 'El bucle local IPv6 no es una IPv4 mapeada');

  const compressedV6 = parseIpv6('2606:4700:4700::1111');
  check(compressedV6 !== null, 'Una IPv6 con compresion doble debe analizarse');
  check(parseIpv6('::ffff:192.168.0.1')?.isIpv4Mapped === true, 'Una IPv4 mapeada debe detectarse como tal');
  check(parseIpv6('fe80::1') !== null, 'Una direccion de enlace local debe analizarse');
  check(parseIpv6('12345::1') === null, 'Un grupo hexadecimal de mas de cuatro digitos debe rechazarse');
  check(parseIpv6('1::2::3') === null, 'Una IPv6 con doble compresion debe rechazarse');

  const mappedAddress = parseIpAddress('::ffff:10.0.0.1');
  check(mappedAddress?.version === 4, 'Una IPv4 mapeada debe normalizarse a la version 4');
  check(mappedAddress?.canonical === '10.0.0.1', 'La IPv4 mapeada debe exponer la direccion IPv4 subyacente');
  check(parseIpAddress('no-es-ip') === null, 'Una cadena arbitraria no debe analizarse como direccion');
  check(parseIpAddress('  127.0.0.1  ')?.canonical === '127.0.0.1', 'Los espacios alrededor de la direccion deben ignorarse');
}

/** Verifica la aritmetica de pertenencia a bloques CIDR en ambos limites de cada rango. */
function verifyCidrEvaluation(): void {
  const privateBlock = parseCidrBlock('10.0.0.0/8', 'RED_PRIVADA_RFC1918');
  check(privateBlock !== null && privateBlock.prefixLength === 8, 'Un bloque CIDR valido debe conservar su prefijo');

  const insideAddress = parseIpAddress('10.255.255.254');
  const outsideAddress = parseIpAddress('11.0.0.1');
  check(
    privateBlock !== null && insideAddress !== null && isIpInsideCidr(insideAddress, privateBlock),
    'La ultima direccion de 10/8 debe pertenecer al bloque'
  );
  check(
    privateBlock !== null && outsideAddress !== null && !isIpInsideCidr(outsideAddress, privateBlock),
    'La primera direccion de 11/8 debe quedar fuera del bloque'
  );

  const boundaries: readonly { readonly address: string; readonly expectedLabel: string | null; readonly label: string }[] = [
    { address: '169.254.0.1', expectedLabel: 'LINK_LOCAL_AUTOCONFIGURADO', label: 'inicio del enlace local' },
    { address: '169.254.255.255', expectedLabel: 'LINK_LOCAL_AUTOCONFIGURADO', label: 'fin del enlace local' },
    { address: '169.255.0.0', expectedLabel: null, label: 'justo despues del enlace local' },
    { address: '172.15.255.255', expectedLabel: null, label: 'justo antes de 172.16/12' },
    { address: '172.16.0.0', expectedLabel: 'RED_PRIVADA_RFC1918', label: 'inicio de 172.16/12' },
    { address: '172.31.255.255', expectedLabel: 'RED_PRIVADA_RFC1918', label: 'fin de 172.16/12' },
    { address: '172.32.0.0', expectedLabel: null, label: 'justo despues de 172.16/12' },
    { address: '100.63.255.255', expectedLabel: null, label: 'justo antes de CGNAT' },
    { address: '100.64.0.0', expectedLabel: 'CGNAT_OPERADOR', label: 'inicio de CGNAT' },
    { address: '100.127.255.255', expectedLabel: 'CGNAT_OPERADOR', label: 'fin de CGNAT' },
    { address: '100.128.0.0', expectedLabel: null, label: 'justo despues de CGNAT' },
    { address: '8.8.8.8', expectedLabel: null, label: 'resolutor publico' },
    { address: '1.1.1.1', expectedLabel: null, label: 'resolutor publico alternativo' },
    { address: '224.0.0.1', expectedLabel: 'MULTICAST', label: 'multicast' },
    { address: '255.255.255.255', expectedLabel: 'DIFUSION_LIMITADA', label: 'difusion limitada' },
    { address: '192.0.2.5', expectedLabel: 'DOCUMENTACION_TEST', label: 'documentacion de pruebas' },
  ];

  for (const boundary of boundaries) {
    const address = parseIpAddress(boundary.address);
    check(address !== null, `La direccion de frontera ${boundary.address} debe analizarse`);
    const label = address === null ? 'sin analizar' : classifyBlockedAddress(address);
    check(
      label === boundary.expectedLabel,
      `La direccion ${boundary.address} (${boundary.label}) debe clasificarse como ${String(boundary.expectedLabel)} (obtenido: ${String(label)})`
    );
  }

  const ipv6Boundaries: readonly { readonly address: string; readonly expectedLabel: string | null }[] = [
    { address: 'fe7f::1', expectedLabel: null },
    { address: 'fe80::1', expectedLabel: 'ENLACE_LOCAL' },
    { address: 'febf::1', expectedLabel: 'ENLACE_LOCAL' },
    { address: 'fec0::1', expectedLabel: 'SITIO_LOCAL_OBSOLETO' },
    { address: 'fc00::1', expectedLabel: 'UNICO_LOCAL' },
    { address: 'fdff::1', expectedLabel: 'UNICO_LOCAL' },
    { address: 'fe00::1', expectedLabel: null },
    { address: '2606:4700::1', expectedLabel: null },
  ];

  for (const boundary of ipv6Boundaries) {
    const address = parseIpAddress(boundary.address);
    const label = address === null ? 'sin analizar' : classifyBlockedAddress(address);
    check(
      label === boundary.expectedLabel,
      `La direccion IPv6 ${boundary.address} debe clasificarse como ${String(boundary.expectedLabel)} (obtenido: ${String(label)})`
    );
  }

  check(BLOCKED_IPV4_CIDRS.length >= 15, 'El catalogo IPv4 debe declarar al menos 15 rangos prohibidos');
  check(BLOCKED_IPV6_CIDRS.length >= 10, 'El catalogo IPv6 debe declarar al menos 10 rangos prohibidos');
  check(parseCidrBlock('10.0.0.0/33', 'INVALIDO') === null, 'Un prefijo IPv4 mayor a 32 debe rechazarse');
  check(parseCidrBlock('::1/129', 'INVALIDO') === null, 'Un prefijo IPv6 mayor a 128 debe rechazarse');
  check(parseCidrBlock('no-es-cidr', 'INVALIDO') === null, 'Una notacion CIDR invalida debe rechazarse');
}

/** Verifica el contenido de los scripts inyectados en el navegador remoto. */
function verifyOverlayScripts(): void {
  const installScript = buildOverlayInstallScript();

  check(installScript.includes('__OA_TRAINER__'), 'El instalador debe exponer el agente en la ventana del navegador');
  check(installScript.includes('data-oa-sensitive'), 'El instalador debe respetar el marcador de campo sensible');
  // La lista de selectores se serializa con comillas escapadas dentro de la cadena del script.
  check(/input\[type=\\?"password\\?"\]/u.test(installScript), 'El filtro debe cubrir los campos de contrasena');
  check(/input\[autocomplete\^=\\?"cc-\\?"\]/u.test(installScript), 'El filtro debe cubrir los campos de tarjeta de credito');
  check(/input\[id\*=\\?"cvv\\?" i\]/u.test(installScript), 'El filtro debe cubrir el codigo de verificacion CVV');
  check(!installScript.includes('__SENSITIVE_SELECTORS__'), 'El marcador de sustitucion debe quedar resuelto en el script final');
  check(installScript.includes('computePrimarySelector'), 'El script debe calcular el selector principal');
  check(installScript.includes('computeAccessibilitySelector'), 'El script debe calcular el selector por accesibilidad');
  check(installScript.includes('computeStructuralSelector'), 'El script debe calcular el selector estructural');
  check(installScript.includes('computeXPathFallback'), 'El script debe calcular el XPath de respaldo');
  check(installScript.includes('computeStabilityScore'), 'El script debe puntuar la estabilidad del selector');
  check(installScript.includes('nth-of-type'), 'El selector estructural debe usar posicion entre hermanos');
  check(installScript.includes('css-') && installScript.includes('volatilePattern'), 'El puntaje debe penalizar clases volatiles');
  check(installScript.includes('renderOverlayMarkers'), 'El script debe dibujar los marcadores del overlay');
  check(installScript.includes('clearOverlayMarkers'), 'El script debe poder limpiar los marcadores');
  check(installScript.includes('highlightSelector'), 'El script debe permitir resaltar un selector en vivo');
  check(installScript.includes('2147483647'), 'El overlay debe apilarse por encima de cualquier contenido del sitio');
  check(installScript.includes('data-oa-marker'), 'Cada marcador debe declarar la clave del elemento que representa');

  check(SENSITIVE_FIELD_MARKERS.length >= 6, 'Deben declararse al menos 6 marcadores de campo sensible');
  check(
    SENSITIVE_FIELD_MARKERS.some((marker) => marker.includes('cvv')) && SENSITIVE_FIELD_MARKERS.some((marker) => marker.includes('cvc')),
    'El filtro debe cubrir tanto CVV como CVC'
  );

  check(VIEWPORT_PRESETS.length === 3, 'Deben declararse exactamente los tres viewports oficiales');
  check(
    VIEWPORT_PRESETS[0]?.name === 'desktop' && VIEWPORT_PRESETS[0]?.width === 1440 && VIEWPORT_PRESETS[0]?.height === 900,
    'El viewport de escritorio debe ser 1440x900'
  );
  check(
    VIEWPORT_PRESETS[1]?.name === 'tablet' && VIEWPORT_PRESETS[1]?.width === 768 && VIEWPORT_PRESETS[1]?.height === 1024,
    'El viewport de tableta debe ser 768x1024'
  );
  check(
    VIEWPORT_PRESETS[2]?.name === 'mobile' && VIEWPORT_PRESETS[2]?.width === 390 && VIEWPORT_PRESETS[2]?.height === 844,
    'El viewport de movil debe ser 390x844'
  );
  check(Object.isFrozen(VIEWPORT_PRESETS), 'Los viewports oficiales deben ser inmutables');
}

/** Verifica que los validadores descarten respuestas invalidas del navegador. */
function verifyOverlayAgentContract(): void {
  check(CdpPayloadParser.asRecord(null) === null, 'Un valor nulo no debe tratarse como registro');
  check(CdpPayloadParser.asRecord([1, 2]) === null, 'Un arreglo no debe tratarse como registro');
  check(CdpPayloadParser.asRecord({ a: 1 })?.['a'] === 1, 'Un objeto simple debe tratarse como registro');
  check(CdpPayloadParser.asNumber('42') === 42, 'Una cadena numerica debe convertirse a numero');
  check(CdpPayloadParser.asNumber('no-numero') === null, 'Una cadena no numerica debe descartarse');
  check(CdpPayloadParser.asNumber(Number.POSITIVE_INFINITY) === null, 'Un numero infinito debe descartarse');

  const parsedElements = CdpPayloadParser.parseElements([
    { elementKey: 'el_1_button', primarySelector: '#enviar', tagName: 'button', actionType: 'CLICK', selectorStabilityScore: 100 },
    { primarySelector: '#sin-clave' },
    { elementKey: 'el_2_input' },
    'no-es-un-elemento',
    null,
  ]);
  check(parsedElements.length === 1, 'Solo los elementos con clave y selector deben aceptarse');
  check(parsedElements[0]?.elementKey === 'el_1_button', 'El elemento valido debe conservar su clave');
  check(parsedElements[0]?.actionType === 'CLICK', 'La accion declarada debe conservarse');
  check(parsedElements[0]?.bbox.width === 0, 'Una caja ausente debe normalizarse a ceros');

  const invalidAction = CdpPayloadParser.parseElements([
    { elementKey: 'el_1', primarySelector: '#a', actionType: 'ACCION_DESCONOCIDA' },
  ]);
  check(invalidAction[0]?.actionType === 'NONE', 'Una accion desconocida debe normalizarse a NONE');

  const route = CdpPayloadParser.parseRoute({ path: '/checkout', title: 'Pago', readyState: 'complete' });
  check(route.path === '/checkout' && route.title === 'Pago', 'La ruta del documento debe interpretarse completa');
  const fallbackRoute = CdpPayloadParser.parseRoute({});
  check(fallbackRoute.path === '/' && fallbackRoute.readyState === 'unknown', 'Una ruta ausente debe caer a valores por omision');

  const box = CdpPayloadParser.parseBoundingBox({ x: '10', y: 20, width: 100.6, height: 40 });
  check(box.x === 10 && box.y === 20, 'Las coordenadas textuales deben convertirse a numero');
  check(box.width === 100.6, 'El ancho decimal debe conservarse');
}

/** Ejecuta los 4 grupos de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA UNITARIA DE ARITMETICA CIDR Y SCRIPTS DE OVERLAY (PARTE 7)');
  console.log('='.repeat(96));

  verifyIpAddressParsing();
  console.log('[1/4] Analisis estricto de direcciones IPv4 e IPv6: APROBADO.');

  verifyCidrEvaluation();
  console.log('[2/4] Evaluacion matematica de bloques CIDR y sus fronteras: APROBADO.');

  verifyOverlayScripts();
  console.log('[3/4] Filtro de privacidad, cascada de selectores y viewports: APROBADO.');

  verifyOverlayAgentContract();
  console.log('[4/4] Validacion defensiva de respuestas del navegador: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

main();
