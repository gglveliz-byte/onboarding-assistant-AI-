/**
 * @archivo tests/unit/identity-public-projections.test.ts
 * @modulo 01-identity-and-rbac (Prueba de las Proyecciones Publicas)
 * @proposito
 *   Verifica que las respuestas de identidad **no contengan material sensible**. Existe por un defecto
 *   medido en la auditoria: los manejadores de inicio de sesion, registro y renovacion respondian con
 *   la entidad de usuario **completa**, de modo que **cada** respuesta contenia el hash de la contrasena,
 *   el secreto del segundo factor, las credenciales de llave fisica, el resumen del codigo de
 *   verificacion y los identificadores de proveedores de identidad externos. Cualquier XSS, registro de
 *   peticiones o intermediario de red los exponia.
 *
 *   La prueba comprueba la proyeccion por su **lista blanca**: verifica que estan los campos que deben
 *   estar y, sobre todo, que **no** estan los que nunca deben salir. La segunda parte es la que importa,
 *   porque es la que falla si alguien añade un campo sensible nuevo a la entidad.
 *
 * @resumen_contenido
 *   - Funcion `buildUser()`: Entidad de usuario completamente poblada, incluidos los campos sensibles.
 *   - Funcion `verifySensitiveFieldsAreAbsent()`: Ningun campo sensible sobrevive a la proyeccion.
 *   - Funcion `verifySafeFieldsArePresent()`: Los campos utiles si llegan.
 *   - Funcion `verifyNewFieldsDoNotLeak()`: Un campo sensible añadido despues NO se filtra.
 *   - Funcion `verifyOrganizationProjection()`: La organizacion tambien se proyecta y admite ausencia.
 *
 * @dependencias_internas
 *   - `toPublicUser()` y `toPublicOrganization()` (`src/modules/01-identity-and-rbac/application/identity-public-projections.ts`).
 *   - `UserEntity` y `OrganizationEntity` (`.../domain/identity.entities.ts`).
 *
 * @dependencias_externas
 *   - `node:assert` (Aserciones nativas). No se toca ningun servicio.
 *
 * @tablas_bd_o_redis
 *   - Ninguna. La prueba es puramente funcional sobre entidades en memoria.
 */

import * as assert from 'node:assert';
import {
  toPublicOrganization,
  toPublicUser,
  type PublicUser,
} from '../../src/modules/01-identity-and-rbac/application/identity-public-projections';
import type { OrganizationEntity, UserEntity } from '../../src/modules/01-identity-and-rbac/domain/identity.entities';

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
 * Construye una entidad de usuario **completamente poblada**, incluidos todos los campos sensibles.
 *
 * Poblarlos es el punto de la prueba: si la entidad viniera vacia, la proyeccion pareceria correcta sin
 * haber demostrado nada.
 *
 * @param extra - Campos adicionales que se desean inyectar.
 * @returns Entidad de usuario lista para proyectar.
 */
function buildUser(extra: Record<string, unknown> = {}): UserEntity {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'usuario@ejemplo.com',
    fullName: 'Usuario De Prueba',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$HASH-DE-CONTRASENA-QUE-NO-DEBE-SALIR',
    tokenVersion: 7,
    isPlatformSuperadmin: false,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    emailVerificationOtpSha256: 'RESUMEN-DEL-CODIGO-QUE-NO-DEBE-SALIR',
    emailVerificationExpiresAt: new Date('2026-01-01T00:15:00.000Z'),
    mfaTotpEnabled: true,
    mfaTotpSecretEnc: Buffer.from('SECRETO-TOTP-QUE-NO-DEBE-SALIR'),
    mfaWebauthnEnabled: true,
    mfaWebauthnCredentialsJson: { credentialId: 'CREDENCIAL-QUE-NO-DEBE-SALIR' },
    oauthGoogleSub: 'GOOGLE-SUB-QUE-NO-DEBE-SALIR',
    oauthGithubId: 'GITHUB-ID-QUE-NO-DEBE-SALIR',
    oauthMicrosoftOid: 'MICROSOFT-OID-QUE-NO-DEBE-SALIR',
    failedLoginAttempts: 3,
    lockedUntil: null,
    lastLoginAt: new Date('2026-02-01T12:00:00.000Z'),
    lastLoginIp: '203.0.113.7',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T12:00:00.000Z'),
    ...extra,
  } as unknown as UserEntity;
}

/** Verifica que ningun campo sensible sobreviva a la proyeccion. */
function verifySensitiveFieldsAreAbsent(): void {
  const proyectado = toPublicUser(buildUser()) as unknown as Record<string, unknown>;
  const serializado = JSON.stringify(proyectado);

  // Esta es la asercion que protege al usuario: ninguna parte del material sensible puede aparecer,
  // ni como campo ni como valor anidado.
  const materialSensible: readonly (readonly [string, string])[] = [
    ['passwordHash', 'HASH-DE-CONTRASENA-QUE-NO-DEBE-SALIR'],
    ['mfaTotpSecretEnc', 'SECRETO-TOTP-QUE-NO-DEBE-SALIR'],
    ['emailVerificationOtpSha256', 'RESUMEN-DEL-CODIGO-QUE-NO-DEBE-SALIR'],
    ['mfaWebauthnCredentialsJson', 'CREDENCIAL-QUE-NO-DEBE-SALIR'],
    ['oauthGoogleSub', 'GOOGLE-SUB-QUE-NO-DEBE-SALIR'],
    ['oauthGithubId', 'GITHUB-ID-QUE-NO-DEBE-SALIR'],
    ['oauthMicrosoftOid', 'MICROSOFT-OID-QUE-NO-DEBE-SALIR'],
    ['tokenVersion', 'tokenVersion'],
    ['failedLoginAttempts', 'failedLoginAttempts'],
    ['lockedUntil', 'lockedUntil'],
    ['lastLoginIp', 'lastLoginIp'],
  ];

  for (const [campo, valor] of materialSensible) {
    check(
      !(campo in proyectado),
      `La proyeccion NO debe incluir el campo ${campo}`
    );
    check(
      !serializado.includes(valor),
      `La proyeccion NO debe contener el valor de ${campo} en ninguna profundidad`
    );
  }
}

/** Verifica que los campos utiles para la interfaz si lleguen. */
function verifySafeFieldsArePresent(): void {
  const proyectado = toPublicUser(buildUser());

  check(proyectado.id === '11111111-1111-4111-8111-111111111111', 'El identificador debe estar presente');
  check(proyectado.email === 'usuario@ejemplo.com', 'El correo debe estar presente');
  check(proyectado.fullName === 'Usuario De Prueba', 'El nombre completo debe estar presente');
  check(proyectado.emailVerified === true, 'El estado de verificacion del correo debe estar presente');
  check(proyectado.mfaTotpEnabled === true, 'El estado del segundo factor por aplicacion debe estar presente');
  check(proyectado.mfaWebauthnEnabled === true, 'El estado del segundo factor por llave fisica debe estar presente');
  check(proyectado.lastLoginAt === '2026-02-01T12:00:00.000Z', 'El ultimo acceso debe estar presente y en formato de instante');
  check(proyectado.createdAt === '2026-01-01T00:00:00.000Z', 'La fecha de creacion debe estar presente y en formato de instante');
}

/** Verifica que un campo sensible añadido DESPUES a la entidad no se filtre por olvido. */
function verifyNewFieldsDoNotLeak(): void {
  // Se simula un campo sensible que alguien añada mañana a la entidad —por ejemplo el secreto de un
  // segundo factor nuevo—. Con una lista blanca NO se expone; con una lista negra se habria filtrado
  // hasta que alguien recordara excluirlo. Esta asercion es la que documenta esa decision de diseño.
  const conCampoNuevo = buildUser({
    mfaBackupCodesHash: 'CODIGO-DE-RESPALDO-QUE-NO-DEBE-SALIR',
    recoveryEmailToken: 'TOKEN-DE-RECUPERACION-QUE-NO-DEBE-SALIR',
  });
  const serializado = JSON.stringify(toPublicUser(conCampoNuevo));

  check(
    !serializado.includes('CODIGO-DE-RESPALDO-QUE-NO-DEBE-SALIR'),
    'Un campo sensible añadido despues NO debe filtrarse: la lista blanca lo excluye por omision'
  );
  check(
    !serializado.includes('TOKEN-DE-RECUPERACION-QUE-NO-DEBE-SALIR'),
    'Un token de recuperacion añadido despues NO debe filtrarse'
  );
}

/** Verifica la proyeccion de la organizacion, incluida la ausencia explicita. */
function verifyOrganizationProjection(): void {
  const organizacion = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Organizacion De Prueba',
    slug: 'organizacion-de-prueba',
  } as unknown as OrganizationEntity;

  const proyectada = toPublicOrganization(organizacion);
  check(proyectada !== null, 'Una organizacion presente debe proyectarse');
  check(proyectada?.id === organizacion.id, 'El identificador de la organizacion debe estar presente');
  check(proyectada?.name === organizacion.name, 'El nombre de la organizacion debe estar presente');
  check(proyectada?.slug === organizacion.slug, 'El identificador legible debe estar presente');

  // La renovacion de sesion puede no resolver organizacion, y ese caso debe propagarse como ausencia
  // explicita en lugar de provocar un fallo en el borde.
  check(toPublicOrganization(null) === null, 'La ausencia de organizacion debe propagarse como nulo');
}

/** Ejecuta los cuatro bloques de aserciones e informa el resultado consolidado. */
function main(): void {
  console.log('PRUEBA DE LAS PROYECCIONES PUBLICAS DE IDENTIDAD');
  console.log('='.repeat(96));

  verifySensitiveFieldsAreAbsent();
  console.log('[1/4] Ningun campo sensible sobrevive a la proyeccion: APROBADO.');

  verifySafeFieldsArePresent();
  console.log('[2/4] Los campos utiles para la interfaz si llegan: APROBADO.');

  verifyNewFieldsDoNotLeak();
  console.log('[3/4] Un campo sensible añadido despues NO se filtra: APROBADO.');

  verifyOrganizationProjection();
  console.log('[4/4] La organizacion se proyecta y su ausencia se propaga: APROBADO.');

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
