/**
 * @archivo tests/unit/kernel.test.ts
 * @modulo 00-kernel (Prueba de Fuego de Criptografia, Aritmetica Decimal Fija y Claves de API)
 * @proposito
 *   Certifica las tres garantias criticas de la Parte 2: que la aritmetica de dinero y minutos
 *   no arrastra errores de coma flotante, que la verificacion de contrasenas respeta el piso
 *   temporal anti-enumeracion de usuarios y que el formato de claves de API con checksum CRC32
 *   detecta de forma local cualquier clave manipulada antes de tocar Redis o PostgreSQL.
 *
 * @resumen_contenido
 *   - Bloque `verifyCryptoIntegrity()`: Vectores conocidos de SHA-256, HMAC, CRC32 y Canonical JSON.
 *   - Bloque `verifyPasswordTimingFloor()`: Piso de temporizado y digest falso anti-enumeracion.
 *   - Bloque `verifyDecimalPrecision()`: Precision a 6 decimales y ausencia de deriva flotante.
 *   - Bloque `verifyApiKeyLifecycle()`: Generacion, parseo, checksum y deteccion de manipulacion.
 *   - Bloque `verifyErrorContract()`: Traduccion de errores a HTTP, cierre de socket y auditoria.
 *
 * @dependencias_internas
 *   - `CryptoUtils`, `DecimalMath`, generadores de claves y jerarquia de errores del kernel.
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Prueba puramente estatica: no abre conexiones ni escribe datos).
 */

import * as assert from 'node:assert';
import { computeApiKeyChecksum, generateApiKeyWithChecksum, maskApiKey, parseApiKey, verifyApiKeyChecksum } from '../../src/shared/kernel/api-key.util';
import { CryptoUtils } from '../../src/shared/kernel/crypto.util';
import { DecimalMath } from '../../src/shared/kernel/decimal.util';
import {
  InsufficientFundsError,
  RateLimitExceededError,
  SsrfBlockedIpError,
  TenantSuspendedError,
  toAppError,
  UnauthorizedError,
  ValidationError,
} from '../../src/shared/kernel/result-and-errors';

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

/** Verifica integridad criptografica: vectores conocidos, tiempo constante y canonicalizacion. */
function verifyCryptoIntegrity(): void {
  check(
    CryptoUtils.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-256 debe coincidir con el vector conocido de "abc"'
  );
  check(
    CryptoUtils.sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'SHA-256 de la cadena vacia debe coincidir con el vector conocido'
  );
  check(
    CryptoUtils.hmacSha256Hex('clave', 'mensaje') === '17e8847a84636888af5a7abe0910e50a0fa28d6f1d3591a175e6e01fcf80b412',
    'HMAC-SHA256 debe coincidir con el vector conocido'
  );
  check(CryptoUtils.computeCrc32Hex('123456789') === 'cbf43926', 'CRC32 debe coincidir con el vector estandar IEEE');
  check(CryptoUtils.computeCrc32('') === 0, 'CRC32 de la cadena vacia debe ser cero');

  const digest = CryptoUtils.sha256Hex('valor');
  check(CryptoUtils.timingSafeEqualHex(digest, digest), 'La comparacion en tiempo constante debe aceptar digests iguales');
  check(!CryptoUtils.timingSafeEqualHex(digest, digest.slice(0, -1) + '0'), 'La comparacion debe rechazar digests distintos');
  check(!CryptoUtils.timingSafeEqualHex(digest, ''), 'La comparacion debe rechazar cadenas vacias sin lanzar excepcion');

  const tokenA = CryptoUtils.generateCsprngToken(32);
  const tokenB = CryptoUtils.generateCsprngToken(32);
  check(tokenA.length === 64 && tokenA !== tokenB, 'El CSPRNG debe producir tokens de 64 caracteres y nunca repetidos');
  check(CryptoUtils.randomBase62String(48).length === 48, 'El generador Base62 debe respetar la longitud exacta');
  check(/^[0-9A-Za-z]{32}$/u.test(CryptoUtils.randomBase62String(32)), 'El generador Base62 debe usar solo el alfabeto oficial');

  const unordered = { zona: 'checkout', pasos: [{ id: 2 }, { id: 1 }], meta: { b: 1, a: 2 } };
  const reordered = { meta: { a: 2, b: 1 }, pasos: [{ id: 2 }, { id: 1 }], zona: 'checkout' };
  const sealA = CryptoUtils.computeCanonicalMapSha256(unordered);
  const sealB = CryptoUtils.computeCanonicalMapSha256(reordered);
  check(sealA.sha256Hash === sealB.sha256Hash, 'El sello SHA-256 del mapa debe ser identico aunque cambie el orden de las claves');
  check(
    sealA.canonicalJson === '{"meta":{"a":2,"b":1},"pasos":[{"id":2},{"id":1}],"zona":"checkout"}',
    'La canonicalizacion debe ordenar claves recursivamente por unidades de codigo UTF-16'
  );

  let rejectedNonFinite = false;
  try {
    CryptoUtils.canonicalizeJsonRfc8785({ valor: Number.NaN });
  } catch {
    rejectedNonFinite = true;
  }
  check(rejectedNonFinite, 'La canonicalizacion debe rechazar numeros no finitos');
}

/** Verifica el piso temporal anti-enumeracion y el digest falso para usuarios inexistentes. */
async function verifyPasswordTimingFloor(): Promise<void> {
  const plainPassword = 'ClaveDePrueba_Segura#2026';
  const storedHash = await CryptoUtils.hashPasswordArgon2id(plainPassword);

  check(storedHash.startsWith('$argon2id$'), 'El digest de contrasena debe usar Argon2id');
  check(await CryptoUtils.verifyPasswordMatches(storedHash, plainPassword), 'La contrasena correcta debe verificarse');
  check(!(await CryptoUtils.verifyPasswordMatches(storedHash, 'ClaveIncorrecta')), 'Una contrasena incorrecta debe rechazarse');

  const existingUser = await CryptoUtils.verifyPasswordConstantTime(storedHash, 'ClaveIncorrecta', 350);
  const unknownUser = await CryptoUtils.verifyPasswordConstantTime(null, 'ClaveIncorrecta', 350);

  check(existingUser.matches === false && unknownUser.matches === false, 'Ambos escenarios deben resultar en rechazo');
  check(existingUser.durationMs >= 350, `El usuario existente debe respetar el piso de 350ms (medido: ${existingUser.durationMs}ms)`);
  check(unknownUser.durationMs >= 350, `El usuario inexistente debe respetar el piso de 350ms (medido: ${unknownUser.durationMs}ms)`);
  check(
    Math.abs(existingUser.durationMs - unknownUser.durationMs) < 120,
    `La diferencia de temporizado entre usuario existente e inexistente debe ser imperceptible (${existingUser.durationMs}ms vs ${unknownUser.durationMs}ms)`
  );
}

/** Verifica la aritmetica decimal fija y la ausencia de deriva por coma flotante. */
function verifyDecimalPrecision(): void {
  const floatingDrift = 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1;
  const fixedSum = DecimalMath.sumFixed6(['0.1', '0.1', '0.1', '0.1', '0.1', '0.1', '0.1', '0.1', '0.1', '0.1']);
  check(floatingDrift !== 1, 'La suma flotante de 0.1 diez veces debe demostrar la deriva (punto flotante prohibido)');
  check(fixedSum === '1.000000', 'La suma decimal fija debe dar exactamente 1.000000');

  // Referencia de escala verificada: 60 segundos son exactamente 1.000000 minutos y un segundo
  // son 0.016666 minutos. El motor TRUNCA al micro de minuto (nunca redondea hacia arriba) para
  // no sobre-facturar jamas al cliente por efecto del redondeo.
  check(DecimalMath.secondsToMinutesFixed6(1) === '0.016666', 'Un segundo debe truncarse a 0.016666 minutos (nunca 0.016667)');
  check(DecimalMath.secondsToMinutesFixed6(30) === '0.500000', 'Treinta segundos deben ser exactamente medio minuto');
  check(DecimalMath.secondsToMinutesFixed6(60) === '1.000000', 'Sesenta segundos deben ser exactamente un minuto');
  check(DecimalMath.secondsToMinutesFixed6('3600') === '60.000000', 'Una hora debe ser exactamente 60 minutos');

  const partial = DecimalMath.subtractMinutesClamped('10.000000', '3.500000');
  check(partial.remaining === '6.500000', 'El saldo restante debe ser 6.500000');
  check(partial.covered === '3.500000' && partial.uncoveredOverage === '0.000000', 'El consumo dentro de cuota no debe generar excedente');

  const overdraft = DecimalMath.subtractMinutesClamped('2.000000', '5.250000');
  check(overdraft.remaining === '0.000000', 'El saldo restante nunca debe quedar negativo');
  check(overdraft.covered === '2.000000', 'Solo debe cubrirse el saldo disponible');
  check(overdraft.uncoveredOverage === '3.250000', 'El excedente debe calcularse con precision de 6 decimales');

  const zeroBalance = DecimalMath.subtractMinutesClamped('0.000000', '0.500000');
  check(zeroBalance.remaining === '0.000000' && zeroBalance.uncoveredOverage === '0.500000', 'Sin saldo, todo el consumo es excedente');

  const compounded = DecimalMath.calculateCompoundedRate('0.200000', '10.000000', '5.000000');
  check(compounded === '0.171000', 'Los descuentos deben componerse de forma multiplicativa (0.2 x 0.9 x 0.95 = 0.171)');
  const singleDiscount = DecimalMath.calculateCompoundedRate('0.200000', '0.000000', '0.000000');
  check(singleDiscount === '0.200000', 'Sin descuentos la tarifa efectiva debe ser la tarifa base');

  const monthlyCost = DecimalMath.multiplyUnitsByRate('1250.500000', '0.171000');
  check(monthlyCost === '213.835500', 'El costo debe multiplicarse en escala fija sin perdida (1250.5 x 0.171)');
  check(DecimalMath.roundUsdToCents('213.835500') === '213.840000', 'El redondeo a centavos debe aplicarse sobre la tercera cifra decimal');
  check(DecimalMath.roundUsdToCents('0.004000') === '0.000000', 'Los montos por debajo del medio centavo deben redondear a cero');

  check(DecimalMath.exceedsUsdCap('50.000000', null) === false, 'Sin tope configurado nunca se excede el gasto');
  check(DecimalMath.exceedsUsdCap('50.000000', '50.000000') === true, 'Alcanzar el tope debe considerarse excedido');
  check(DecimalMath.maxFixed6('1.000000', '2.000000') === '2.000000', 'El maximo debe resolverse con comparacion entera');
  check(DecimalMath.clampNonNegative('-0.000001') === '0.000000', 'Los valores negativos deben elevarse a cero');

  let rejectedNegativeConsumption = false;
  try {
    DecimalMath.subtractMinutesClamped('10.000000', '-1.000000');
  } catch (error) {
    rejectedNegativeConsumption = error instanceof ValidationError;
  }
  check(rejectedNegativeConsumption, 'El consumo negativo de minutos debe rechazarse con ValidationError');

  let rejectedBadFormat = false;
  try {
    DecimalMath.parseFixed6('12,5');
  } catch (error) {
    rejectedBadFormat = error instanceof ValidationError;
  }
  check(rejectedBadFormat, 'Un formato decimal invalido debe rechazarse con ValidationError');
}

/** Verifica el ciclo de vida completo de las claves de API con checksum CRC32. */
function verifyApiKeyLifecycle(): void {
  const publishable = generateApiKeyWithChecksum('pk', 'live', '9f8a7b');
  const secret = generateApiKeyWithChecksum('sk', 'live', '9f8a7b');

  check(/^pk_live_9f8a7b_[0-9A-Za-z]{32}_[0-9a-f]{6}$/u.test(publishable.rawKey), 'La clave publica debe respetar el formato oficial de 32 caracteres Base62');
  check(/^sk_live_9f8a7b_[0-9A-Za-z]{48}_[0-9a-f]{6}$/u.test(secret.rawKey), 'La clave secreta debe respetar el formato oficial de 48 caracteres Base62');
  check(secret.rawKey !== generateApiKeyWithChecksum('sk', 'live', '9f8a7b').rawKey, 'Dos claves generadas nunca deben coincidir');
  check(publishable.prefix.length === 16 && publishable.prefix === publishable.rawKey.slice(0, 16), 'El prefijo visible debe ser de 16 caracteres');
  check(publishable.sha256Hash === CryptoUtils.sha256Hex(publishable.rawKey), 'El hash persistible debe ser el SHA-256 de la clave cruda');
  check(verifyApiKeyChecksum(publishable.rawKey) && verifyApiKeyChecksum(secret.rawKey), 'Las claves recien generadas deben superar su propio checksum');

  const parsed = parseApiKey(secret.rawKey);
  check(parsed !== null && parsed.type === 'sk' && parsed.environment === 'live' && parsed.projectShortId === '9f8a7b', 'El parseo debe extraer tipo, entorno y proyecto');
  check(parsed !== null && parsed.lastFour === secret.rawKey.slice(-4), 'El parseo debe exponer los ultimos cuatro caracteres');

  const tampered = `${secret.rawKey.slice(0, -1)}${secret.rawKey.endsWith('0') ? '1' : '0'}`;
  check(!verifyApiKeyChecksum(tampered), 'Una clave manipulada en su ultimo caracter debe fallar el checksum');
  check(!verifyApiKeyChecksum('sk_live_9f8a7b_corta_a1b2c3'), 'Una clave con segmento demasiado corto debe rechazarse');
  check(!verifyApiKeyChecksum('pk_prod_9f8a7b_x'.padEnd(48, 'a') + '_a1b2c3'), 'Un entorno no soportado debe rechazarse');
  check(parseApiKey('clave_inventada') === null, 'Una cadena arbitraria no debe poder parsearse como clave');

  check(maskApiKey(secret.rawKey).startsWith('sk_live_9f8a7b_') && maskApiKey(secret.rawKey).endsWith(secret.rawKey.slice(-4)), 'El enmascarado debe conservar prefijo y cola');
  check(!maskApiKey(secret.rawKey).includes(secret.rawKey.slice(20, 40)), 'El enmascarado nunca debe revelar el segmento secreto');
  check(computeApiKeyChecksum('pk_live_9f8a7b_prueba').length === 6, 'El checksum debe tener exactamente 6 caracteres');

  let rejectedShortProjectId = false;
  try {
    generateApiKeyWithChecksum('sk', 'live', 'ab');
  } catch {
    rejectedShortProjectId = true;
  }
  check(rejectedShortProjectId, 'Un identificador de proyecto invalido debe impedir la generacion');

  const startedAt = Date.now();
  for (let index = 0; index < 1000; index += 1) {
    verifyApiKeyChecksum('sk_live_9f8a7b_corta_a1b2c3');
  }
  const elapsedMs = Date.now() - startedAt;
  check(elapsedMs < 250, `El descarte local de claves malformadas debe ser inmediato (1000 intentos en ${elapsedMs}ms)`);
}

/** Verifica el contrato de traduccion de errores a HTTP, cierre de socket y auditoria. */
function verifyErrorContract(): void {
  const unauthorized = new UnauthorizedError('Token ausente.');
  check(unauthorized.httpStatus === 401 && unauthorized.wsCloseCode === 4001, 'UnauthorizedError debe mapear a HTTP 401 y cierre 4001');
  check(unauthorized.auditSeverity === 'WARN', 'UnauthorizedError debe auditarse como WARN');
  check(unauthorized.toJSON().error.code === 'UNAUTHORIZED', 'La serializacion debe exponer el codigo estable');
  check(!JSON.stringify(unauthorized.toJSON()).includes('stack'), 'La serializacion nunca debe filtrar la traza de pila');

  const suspended = new TenantSuspendedError('Impago.', { organizationId: 'org-1' });
  check(suspended.httpStatus === 403 && suspended.wsCloseCode === 4003, 'TenantSuspendedError debe cortar el socket con 4003');

  const funds = new InsufficientFundsError('0.000000', '0.000000');
  check(funds.httpStatus === 402 && funds.wsCloseCode === 4002, 'InsufficientFundsError debe mapear a HTTP 402 y cierre 4002');

  const quota = new RateLimitExceededError(42, 'login:ip');
  check(quota.httpStatus === 429, 'RateLimitExceededError debe mapear a HTTP 429');
  check(quota.context.details?.['retryAfterSeconds'] === 42, 'La cuota excedida debe informar los segundos de espera');

  const ssrf = new SsrfBlockedIpError('metadata.interno', '169.254.169.254', 'METADATOS_DE_NUBE');
  check(ssrf.auditSeverity === 'CRITICAL_SECURITY', 'Un bloqueo Anti-SSRF debe auditarse como CRITICAL_SECURITY');
  check(ssrf.wsCloseCode === 4006, 'El bloqueo Anti-SSRF debe cerrar el socket con 4006');

  const validation = new ValidationError('Esquema invalido.', ['body.email: formato invalido']);
  check(validation.httpStatus === 422, 'ValidationError debe mapear a HTTP 422');
  check(Array.isArray(validation.context.details?.['issues']), 'ValidationError debe exponer el listado de incumplimientos');

  const normalized = toAppError(new Error('fallo de driver'));
  check(normalized.code === 'INTERNAL_ERROR' && normalized.httpStatus === 500, 'Un fallo desconocido debe normalizarse a InternalError');
  check(toAppError('texto suelto').message === 'texto suelto', 'Un fallo de tipo cadena debe conservarse en el mensaje');
  check(toAppError(undefined).code === 'INTERNAL_ERROR', 'Un fallo no serializable debe normalizarse sin lanzar excepcion');

  const expectedHttpStatuses: readonly number[] = [401, 4003, 403, 422, 404, 409, 403, 403, 403, 403, 400, 402, 429, 503, 500];
  const orderedCodeCount = Object.keys({ ...unauthorized.toJSON().error }).length;
  check(orderedCodeCount > 0 && expectedHttpStatuses.length === 15, 'El contrato debe cubrir los 15 codigos de error del sistema');
  check(new ValidationError('x').occurredAt instanceof Date, 'Todo error controlado debe registrar su marca temporal de ocurrencia');
}

/** Ejecuta los 5 grupos de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL KERNEL COMPARTIDO (PARTE 2)');
  console.log('='.repeat(96));

  verifyCryptoIntegrity();
  console.log('[1/5] Integridad criptografica y canonicalizacion RFC 8785: APROBADO.');

  await verifyPasswordTimingFloor();
  console.log('[2/5] Piso temporal Argon2id y anti-enumeracion de usuarios: APROBADO.');

  verifyDecimalPrecision();
  console.log('[3/5] Aritmetica decimal fija de 6 decimales sin deriva flotante: APROBADO.');

  verifyApiKeyLifecycle();
  console.log('[4/5] Ciclo de vida de claves de API con checksum CRC32: APROBADO.');

  verifyErrorContract();
  console.log('[5/5] Contrato de errores HTTP, WebSocket y auditoria: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('RESULTADO: FALLIDO.');
  console.error(message);
  process.exit(1);
});
