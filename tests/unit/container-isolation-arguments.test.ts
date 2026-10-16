/**
 * @archivo tests/unit/container-isolation-arguments.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba del Aislamiento del Contenedor)
 * @proposito
 *   Verifica que los argumentos con los que se crea el contenedor del navegador de entrenamiento
 *   incluyan **de verdad** el aislamiento de red, la retirada de capacidades y el bloqueo de las vias
 *   de salida que la intercepcion de peticiones no alcanza.
 *
 *   Esta prueba existe por un hueco medido en la auditoria: la defensa del modulo se apoyaba por
 *   completo en la intercepcion de peticiones del protocolo de depuracion, y **ese dominio no cubre el
 *   handshake de los sockets**. Una pagina hostil podia abrir un canal persistente hacia los metadatos
 *   del proveedor de nube o hacia el propio motor de base de datos sin que el escudo viera jamas la
 *   direccion. El contenedor, ademas, **compartia la red del host** y no retiraba ninguna capacidad.
 *
 *   Se prueba la **construccion de argumentos** y no el arranque real: lanzar un contenedor en una
 *   prueba la volveria dependiente del motor y del entorno, y lo que hay que garantizar es que la
 *   defensa **se declare**, que es justo lo que faltaba.
 *
 * @resumen_contenido
 *   - Funcion `buildSpec()`: Especificacion de contenedor reutilizada por los bloques.
 *   - Funcion `verifyNetworkIsolation()`: La red dedicada llega al motor cuando se declara.
 *   - Funcion `verifyCapabilitiesAreDropped()`: Retirada de capacidades y prohibicion de escalada.
 *   - Funcion `verifyIndirectEgressIsBlocked()`: Tiempo real y resolucion anticipada desactivados.
 *   - Funcion `verifyDebuggerStaysLocal()`: El punto de depuracion no se expone fuera del bucle local.
 *   - Funcion `verifyPinningRuleIsForwarded()`: La regla de fijacion de direcciones se propaga.
 *
 * @dependencias_internas
 *   - `buildContainerArguments()` (`src/modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas). No se lanza ningun proceso.
 *
 * @tablas_bd_o_redis
 *   - Ninguna. La prueba es puramente funcional y no toca servicios.
 */

import * as assert from 'node:assert';
import {
  buildContainerArguments,
  DEFAULT_CPU_LIMIT,
  DEFAULT_DEBUGGER_PORT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_TMPFS_SIZE,
  type BrowserContainerSpec,
} from '../../src/modules/03-visual-trainer-and-rag/infrastructure/docker-browser-runtime';

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

/**
 * Construye una especificacion de contenedor valida para la prueba.
 *
 * @param overrides - Campos que se desean sobrescribir.
 * @returns Especificacion completa del contenedor.
 */
function buildSpec(overrides: Partial<BrowserContainerSpec> = {}): BrowserContainerSpec {
  return {
    image: 'entrenador-aislado:1.0.0',
    containerName: 'oa-trainer-prueba-aislamiento',
    tmpfsSize: DEFAULT_TMPFS_SIZE,
    memoryLimit: DEFAULT_MEMORY_LIMIT,
    cpuLimit: DEFAULT_CPU_LIMIT,
    maxTtlSeconds: 300,
    debuggerPort: DEFAULT_DEBUGGER_PORT,
    hostResolverRules: 'MAP ejemplo.com 93.184.216.34, EXCLUDE localhost',
    ...overrides,
  };
}

/**
 * Devuelve el valor que sigue a una bandera en el arreglo de argumentos.
 *
 * @param args - Arreglo de argumentos del motor.
 * @param flag - Bandera cuyo valor se busca.
 * @returns Valor siguiente a la bandera, o `undefined` cuando la bandera no aparece.
 */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Verifica que la red dedicada llegue al motor cuando se declara, y que no se invente cuando no. */
function verifyNetworkIsolation(): void {
  const conRed = buildContainerArguments(buildSpec({ networkName: 'oa-trainer-net' }));
  check(valueAfter(conRed, '--network') === 'oa-trainer-net', 'La red dedicada declarada debe llegar al motor');

  // Cuando no se declara red, NO debe aparecer la bandera: un valor por omision implicito conectaria el
  // contenedor a una red que nadie eligio, que es exactamente el defecto que se corrige.
  const sinRed = buildContainerArguments(buildSpec());
  check(sinRed.includes('--network') === false, 'Sin red declarada no debe añadirse la bandera de red');
}

/** Verifica la retirada de capacidades y la prohibicion de escalada de privilegios. */
function verifyCapabilitiesAreDropped(): void {
  const args = buildContainerArguments(buildSpec());

  // Sin esta bandera, un fallo del motor de renderizado puede escalar a la ejecucion de codigo en el
  // anfitrion, que es una via mucho mas directa que el propio SSRF.
  check(
    args.some((arg, index) => arg === '--cap-drop' && args[index + 1] === 'ALL'),
    'El contenedor debe retirar TODAS las capacidades del nucleo'
  );
  check(
    args.some((arg, index) => arg === '--security-opt' && args[index + 1] === 'no-new-privileges'),
    'El contenedor no debe poder adquirir privilegios nuevos'
  );
  check(valueAfter(args, '--memory') === DEFAULT_MEMORY_LIMIT, 'El contenedor debe conservar su limite de memoria');
  check(valueAfter(args, '--cpus') === DEFAULT_CPU_LIMIT, 'El contenedor debe conservar su limite de CPU');
}

/** Verifica que se bloqueen las vias de salida que la intercepcion de peticiones no alcanza. */
function verifyIndirectEgressIsBlocked(): void {
  const args = buildContainerArguments(buildSpec());

  // El tiempo real abre un canal de datos que la intercepcion de peticiones no inspecciona: se restringe
  // el manejo de direcciones para que no exponga la topologia interna ni establezca el canal.
  check(
    args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'),
    'El tiempo real debe restringirse al no usar rutas directas'
  );

  // La resolucion anticipada genera salidas de red antes de que exista una peticion que interceptar.
  // Se comprueba como **un solo argumento con signo igual**: esta bandera del navegador agrupa sus
  // valores separados por comas, a diferencia de las del motor de contenedores, que usan dos.
  const desactivadas = args.find((arg) => arg.startsWith('--disable-features='));
  check(
    desactivadas !== undefined && desactivadas.includes('PreconnectToSearch'),
    'La resolucion anticipada debe quedar desactivada'
  );
  check(
    desactivadas !== undefined && desactivadas.includes('NetworkPrediction'),
    'La prediccion de red debe quedar desactivada'
  );
  check(args.includes('--disable-background-networking'), 'El trafico de fondo del navegador debe quedar desactivado');
}

/** Verifica que el punto de depuracion no se exponga fuera del bucle local. */
function verifyDebuggerStaysLocal(): void {
  const args = buildContainerArguments(buildSpec());
  const publicacion = valueAfter(args, '--publish');

  // El punto de depuracion permite EJECUTAR codigo en el navegador: publicarlo en todas las interfaces
  // dejaria el control de la sesion de entrenamiento al alcance de cualquiera que alcanzara el anfitrion.
  check(
    typeof publicacion === 'string' && publicacion.startsWith('127.0.0.1:'),
    `El punto de depuracion debe publicarse solo en el bucle local (obtenido: ${String(publicacion)})`
  );
}

/** Verifica que la regla de fijacion de direcciones se propague al navegador. */
function verifyPinningRuleIsForwarded(): void {
  const regla = 'MAP ejemplo.com 93.184.216.34, EXCLUDE localhost';
  const args = buildContainerArguments(buildSpec({ hostResolverRules: regla }));

  check(
    args.includes(`--host-resolver-rules=${regla}`),
    'La regla de fijacion de direcciones debe llegar al navegador con su correspondencia'
  );
  check(
    args.includes('about:blank'),
    'El contenedor debe arrancar en una pagina en blanco, no en el destino validado'
  );
}

/** Ejecuta los cinco bloques de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DEL AISLAMIENTO DEL CONTENEDOR DE ENTRENAMIENTO');
  console.log('='.repeat(96));

  verifyNetworkIsolation();
  console.log('[1/5] La red dedicada llega al motor y no se inventa cuando no se declara: APROBADO.');

  verifyCapabilitiesAreDropped();
  console.log('[2/5] Retirada de capacidades y prohibicion de escalada de privilegios: APROBADO.');

  verifyIndirectEgressIsBlocked();
  console.log('[3/5] Tiempo real, resolucion anticipada y trafico de fondo bloqueados: APROBADO.');

  verifyDebuggerStaysLocal();
  console.log('[4/5] El punto de depuracion no se expone fuera del bucle local: APROBADO.');

  verifyPinningRuleIsForwarded();
  console.log('[5/5] La regla de fijacion de direcciones se propaga al navegador: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

try {
  main();
} catch (error) {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
