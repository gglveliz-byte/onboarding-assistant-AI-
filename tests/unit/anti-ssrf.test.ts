/**
 * @archivo tests/unit/anti-ssrf.test.ts
 * @modulo 03-visual-trainer-and-rag (Prueba de Fuego del Escudo Anti-SSRF y Anti-DNS-Rebinding)
 * @proposito
 *   Enfrenta el escudo a una bateria de vectores de ataque reales: servicios de metadatos de la
 *   nube, bucle local en todas sus notaciones (decimal, hexadecimal, octal y IPv4 mapeado en IPv6),
 *   rangos privados RFC 1918, CGNAT, direcciones de documentacion y esquemas no autorizados. Tambien
 *   certifica la fijacion de resolucion que neutraliza el DNS Rebinding, comprobando que la IP
 *   devuelta es la misma que se verifico contra los rangos prohibidos.
 *
 * @resumen_contenido
 *   - Bloque `verifyBlockedAttackVectors()`: 20 vectores de ataque que deben ser bloqueados.
 *   - Bloque `verifyAllowedPublicDestinations()`: Destinos publicos legitimos que deben permitirse.
 *   - Bloque `verifyPinningRuleGeneration()`: Regla de fijacion y conservacion del nombre de host.
 *   - Bloque `verifySecondaryRequestFiltering()`: Peticiones secundarias abortadas sin excepcion.
 *   - Bloque `verifyAuditReporting()`: Registro de auditoria con el motivo exacto del bloqueo.
 *
 * @dependencias_internas
 *   - `PinnedDnsSsrfGuard` (`src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard.ts`).
 *   - `SsrfBlockedIpError` (`src/shared/kernel/result-and-errors.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas, sin dependencias adicionales).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `audit_logs` (La prueba verifica el motivo que alli se registraria).
 */

import * as assert from 'node:assert';
import { PinnedDnsSsrfGuard, type SsrfAuditSink } from '../../src/modules/03-visual-trainer-and-rag/infrastructure/pinned-dns-ssrf.guard';
import { SsrfBlockedIpError } from '../../src/shared/kernel/result-and-errors';

/** Contador de verificaciones superadas durante la ejecucion. */
let passedAssertions = 0;

/** Registro en memoria de los intentos bloqueados reportados al destino de auditoria. */
const auditedAttempts: { hostname: string; resolvedIp: string; reason: string }[] = [];

/** Destino de auditoria de prueba que acumula los intentos bloqueados. */
const testAuditSink: SsrfAuditSink = {
  recordBlockedAttempt: async (event) => {
    auditedAttempts.push({ hostname: event.hostname, resolvedIp: event.resolvedIp, reason: event.reason });
  },
};

/** Escudo bajo prueba con resolutores externos reales. */
const guard = new PinnedDnsSsrfGuard({
  externalResolvers: ['1.1.1.1', '8.8.8.8'],
  lookupTimeoutMs: 4000,
  auditSink: testAuditSink,
});

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

/** Verifica que los 20 vectores de ataque conocidos sean bloqueados. */
async function verifyBlockedAttackVectors(): Promise<void> {
  const attackVectors: readonly { readonly url: string; readonly expectedReasonFragment: string; readonly label: string }[] = [
    { url: 'http://169.254.169.254/latest/meta-data/', expectedReasonFragment: 'METADATOS', label: 'metadatos de nube' },
    { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', expectedReasonFragment: 'METADATOS', label: 'credenciales IAM' },
    { url: 'http://100.100.100.200/latest/meta-data/', expectedReasonFragment: 'METADATOS', label: 'metadatos alternativos' },
    { url: 'http://127.0.0.1/admin', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local' },
    { url: 'http://127.0.0.2:8080/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local en 127.0.0.2' },
    { url: 'http://2130706433/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local en notacion decimal' },
    { url: 'http://0x7f000001/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local en notacion hexadecimal' },
    { url: 'http://017700000001/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local en notacion octal' },
    { url: 'http://[::1]/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'bucle local IPv6' },
    { url: 'http://[::ffff:127.0.0.1]/', expectedReasonFragment: 'BUCLE_LOCAL', label: 'IPv4 mapeado en IPv6' },
    { url: 'http://10.0.0.1/', expectedReasonFragment: 'RED_PRIVADA', label: 'red privada 10/8' },
    { url: 'http://172.16.5.5/', expectedReasonFragment: 'RED_PRIVADA', label: 'red privada 172.16/12' },
    { url: 'http://172.31.255.254/', expectedReasonFragment: 'RED_PRIVADA', label: 'borde alto de 172.16/12' },
    { url: 'http://192.168.0.1/', expectedReasonFragment: 'RED_PRIVADA', label: 'red privada 192.168/16' },
    { url: 'http://100.64.0.1/', expectedReasonFragment: 'CGNAT', label: 'rango CGNAT' },
    { url: 'http://0.0.0.0/', expectedReasonFragment: 'NO_ESPECIFICADA', label: 'direccion no especificada' },
    { url: 'http://198.18.0.1/', expectedReasonFragment: 'BENCHMARKING', label: 'rango de benchmarking' },
    { url: 'http://[fd00:ec2::254]/latest/meta-data/', expectedReasonFragment: 'METADATOS', label: 'metadatos IPv6' },
    { url: 'http://[fe80::1]/', expectedReasonFragment: 'ENLACE_LOCAL', label: 'enlace local IPv6' },
    { url: 'http://[fc00::1]/', expectedReasonFragment: 'UNICO_LOCAL', label: 'unico local IPv6' },
  ];

  for (const vector of attackVectors) {
    let blockedError: unknown = null;
    try {
      await guard.assertSafeUrl(vector.url);
    } catch (error) {
      blockedError = error;
    }

    const blocked = blockedError instanceof SsrfBlockedIpError;
    check(blocked, `El vector "${vector.label}" (${vector.url}) debe ser bloqueado`);
    if (blockedError instanceof SsrfBlockedIpError) {
      const reason = String(blockedError.context.details?.['reason'] ?? '');
      check(
        reason.includes(vector.expectedReasonFragment),
        `El vector "${vector.label}" debe reportar el motivo ${vector.expectedReasonFragment} (reportado: ${reason})`
      );
      check(blockedError.httpStatus === 400, `El bloqueo de "${vector.label}" debe mapear a HTTP 400`);
      check(blockedError.auditSeverity === 'CRITICAL_SECURITY', `El bloqueo de "${vector.label}" debe auditarse como critico`);
    }
  }
}

/** Verifica que los esquemas y puertos no autorizados sean rechazados antes de resolver DNS. */
async function verifyRejectedSchemesAndPorts(): Promise<void> {
  const rejectedUrls: readonly { readonly url: string; readonly label: string }[] = [
    { url: 'file:///etc/passwd', label: 'esquema de archivo local' },
    { url: 'gopher://127.0.0.1:6379/_INFO', label: 'esquema gopher' },
    { url: 'ftp://example.com/', label: 'esquema FTP' },
    { url: 'dict://127.0.0.1:11211/', label: 'esquema de diccionario' },
    { url: 'http://example.com:22/', label: 'puerto SSH' },
    { url: 'http://example.com:6379/', label: 'puerto de Redis' },
    { url: 'http://example.com:5432/', label: 'puerto de PostgreSQL' },
    { url: 'http://example.com:2375/', label: 'puerto del motor de contenedores' },
    { url: 'no-es-una-url', label: 'cadena que no es URL' },
    { url: 'http://', label: 'URL sin host' },
  ];

  for (const candidate of rejectedUrls) {
    let rejected = false;
    try {
      await guard.assertSafeUrl(candidate.url);
    } catch {
      rejected = true;
    }
    check(rejected, `El vector "${candidate.label}" (${candidate.url}) debe ser rechazado`);
  }
}

/** Verifica que un destino publico legitimo sea permitido con su IP fijada. */
async function verifyAllowedPublicDestinations(): Promise<void> {
  const target = await guard.assertSafeUrl('https://example.com/', { organizationId: 'org-prueba', projectId: 'prj-prueba' });

  check(target.hostname === 'example.com', 'El destino publico debe conservar su nombre de host');
  check(target.port === 443, 'HTTPS debe resolver al puerto 443 por omision');
  check(target.usesTls, 'Una URL HTTPS debe marcarse como cifrada');
  check(target.protocol === 'https:', 'El esquema debe normalizarse a https:');
  check(target.pinnedIp.version === 4 || target.pinnedIp.version === 6, 'La IP fijada debe tener una version valida');
  check(target.pinnedIp.canonical.length > 0, 'La IP fijada debe exponer su representacion canonica');
  check(
    target.chromiumPinningRule.startsWith(`MAP example.com ${target.pinnedIp.canonical}`),
    'La regla de fijacion debe mapear el host a la IP validada'
  );
  check(target.chromiumPinningRule.includes('EXCLUDE localhost'), 'La regla de fijacion debe excluir el bucle local');

  const httpTarget = await guard.assertSafeUrl('http://example.com/');
  check(httpTarget.port === 80 && !httpTarget.usesTls, 'HTTP debe resolver al puerto 80 sin cifrado');

  const ipv6Target = await guard.assertSafeUrl('https://[2606:4700:4700::1111]/');
  check(ipv6Target.pinnedIp.version === 6, 'Un literal IPv6 publico debe conservar su version');
  check(ipv6Target.chromiumPinningRule.includes('[2606:'), 'La regla de fijacion debe entrecomillar el literal IPv6');
}

/** Verifica que la resolucion DNS se fije y se reutilice desde memoria dentro de su vigencia. */
async function verifyDnsPinningAndCaching(): Promise<void> {
  guard.clearResolutionCache();
  check(guard.cachedHostnameCount === 0, 'Limpiar la memoria debe dejar cero nombres almacenados');

  const firstResolution = await guard.resolveHostname('example.com');
  check(firstResolution.blockedRiskLabel === null, 'Un dominio publico no debe reportar bloqueo');
  check(firstResolution.addresses.length >= 1, 'La resolucion debe devolver al menos una direccion');
  check(!firstResolution.servedFromCache, 'La primera resolucion no puede venir de la memoria');
  check(guard.cachedHostnameCount === 1, 'La resolucion debe quedar almacenada en memoria');

  const secondResolution = await guard.resolveHostname('example.com');
  check(secondResolution.servedFromCache, 'La segunda resolucion debe servirse desde la memoria');
  check(
    secondResolution.pinnedAddress?.canonical === firstResolution.pinnedAddress?.canonical,
    'La direccion fijada debe ser identica entre resoluciones consecutivas'
  );

  guard.clearResolutionCache();
  check(guard.cachedHostnameCount === 0, 'La memoria debe poder vaciarse entre sesiones de entrenamiento');
}

/** Verifica que las peticiones secundarias se aborten devolviendo null en lugar de lanzar. */
async function verifySecondaryRequestFiltering(): Promise<void> {
  const dangerousSecondary = await guard.validateSecondaryRequest('http://169.254.169.254/latest/meta-data/iam/', {
    organizationId: 'org-prueba',
    projectId: 'prj-prueba',
  });
  check(dangerousSecondary === null, 'Una peticion secundaria hacia metadatos debe abortarse devolviendo null');

  const internalSecondary = await guard.validateSecondaryRequest('http://10.1.2.3/panel-interno');
  check(internalSecondary === null, 'Una peticion secundaria hacia red privada debe abortarse');

  const invalidSchemeSecondary = await guard.validateSecondaryRequest('file:///etc/shadow');
  check(invalidSchemeSecondary === null, 'Una peticion secundaria con esquema no autorizado debe abortarse');

  const legitimateSecondary = await guard.validateSecondaryRequest('https://example.com/assets/logo.png');
  check(legitimateSecondary !== null, 'Una peticion secundaria legitima debe permitirse');
  check(legitimateSecondary?.hostname === 'example.com', 'La peticion permitida debe conservar su destino');
}

/** Verifica que cada bloqueo quede registrado en auditoria con su motivo exacto. */
async function verifyAuditReporting(): Promise<void> {
  auditedAttempts.length = 0;

  await guard
    .resolveHostname('169.254.169.254', { organizationId: 'org-auditoria' }, 'http://169.254.169.254/')
    .catch(() => undefined);

  check(auditedAttempts.length >= 1, 'Un intento hacia metadatos debe generar un registro de auditoria');
  const firstAttempt = auditedAttempts[0];
  check(firstAttempt?.hostname === '169.254.169.254', 'El registro debe identificar el host atacado');
  check(firstAttempt?.reason === 'METADATOS_DE_NUBE', 'El registro debe clasificar el motivo exacto del bloqueo');
  check(firstAttempt?.resolvedIp === '169.254.169.254', 'El registro debe conservar la direccion bloqueada');
}

/** Ejecuta los 6 grupos de aserciones e informa el resultado consolidado. */
async function main(): Promise<void> {
  console.log('PRUEBA DE FUEGO DEL ESCUDO ANTI-SSRF Y ANTI-DNS-REBINDING (PARTE 7)');
  console.log('='.repeat(96));

  await verifyBlockedAttackVectors();
  console.log('[1/6] Vectores de ataque bloqueados (metadatos, bucle local, RFC 1918, CGNAT): APROBADO.');

  await verifyRejectedSchemesAndPorts();
  console.log('[2/6] Esquemas y puertos no autorizados rechazados antes de resolver DNS: APROBADO.');

  await verifyAllowedPublicDestinations();
  console.log('[3/6] Destinos publicos legitimos permitidos con IP fijada: APROBADO.');

  await verifyDnsPinningAndCaching();
  console.log('[4/6] Fijacion de resolucion DNS y memoria de corta vigencia: APROBADO.');

  await verifySecondaryRequestFiltering();
  console.log('[5/6] Filtrado de peticiones secundarias sin interrumpir la sesion: APROBADO.');

  await verifyAuditReporting();
  console.log('[6/6] Registro de auditoria con el motivo exacto del bloqueo: APROBADO.');

  console.log('='.repeat(96));
  console.log(`RESULTADO: APROBADO. ${passedAssertions} aserciones superadas.`);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
