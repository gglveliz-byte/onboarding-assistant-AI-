/**
 * @archivo src/modules/01-identity-and-rbac/application/identity-public-projections.ts
 * @modulo 01-identity-and-rbac (Proyecciones Publicas de Identidad)
 * @proposito
 *   Convierte las entidades de identidad en objetos aptos para viajar al cliente, **excluyendo todo
 *   material sensible**. Existe por un defecto medido en la auditoria: los manejadores de inicio de
 *   sesion, registro y renovacion respondian con la entidad completa, de modo que cada respuesta
 *   contenia el **hash de la contrasena** —material para romperla por fuerza bruta fuera de linea—, el
 *   **secreto del segundo factor**, el codigo de verificacion por correo en claro y el token de
 *   renovacion. Cualquier XSS, registro de peticiones o intermediario de red los exponia.
 *
 *   El criterio de diseno es una **lista blanca explicita** y no una lista negra de campos prohibidos.
 *   La diferencia importa: con una lista negra, cualquier campo sensible que se añada mañana a la
 *   entidad se filtraria por omision hasta que alguien recordara excluirlo. Con una lista blanca, un
 *   campo nuevo **no se expone hasta que alguien decida exponerlo**, que es el modo de fallo correcto
 *   para un dato de identidad.
 *
 * @resumen_contenido
 *   - Interface `PublicUser`: Campos de usuario aptos para el cliente.
 *   - Interface `PublicOrganization`: Campos de organizacion aptos para el cliente.
 *   - Funcion `toPublicUser()`: Proyeccion de la entidad de usuario.
 *   - Funcion `toPublicOrganization()`: Proyeccion de la entidad de organizacion.
 *
 * @dependencias_internas
 *   - `UserEntity` y `OrganizationEntity` (`../domain/identity.entities.ts`).
 *
 * @dependencias_externas
 *   - Ninguna (Capa de aplicacion pura: cero acoplamiento a librerias).
 *
 * @tablas_bd_o_redis
 *   - Ninguna: la proyeccion opera en memoria sobre entidades ya cargadas.
 */

import type { OrganizationEntity, UserEntity } from '../domain/identity.entities';

/**
 * Campos de usuario que pueden viajar al cliente.
 *
 * Se omite deliberadamente todo lo que permite **autenticar como el usuario** o **debilitar su segundo
 * factor**: el hash de la contrasena, el secreto del segundo factor, las credenciales de llave fisica,
 * el resumen del codigo de verificacion y los identificadores de proveedores de identidad externos.
 */
export interface PublicUser {
  /** Identificador del usuario. */
  readonly id: string;
  /** Correo electronico, que el usuario ya conoce porque es su identificador de acceso. */
  readonly email: string;
  /** Nombre completo, usado para saludar en la interfaz. */
  readonly fullName: string;
  /** Indica si el correo ya fue verificado, para que la interfaz pueda pedirlo si falta. */
  readonly emailVerified: boolean;
  /** Indica si el segundo factor por aplicacion esta activo. */
  readonly mfaTotpEnabled: boolean;
  /** Indica si el segundo factor por llave fisica esta activo. */
  readonly mfaWebauthnEnabled: boolean;
  /** Momento del ultimo acceso, para los paneles de seguridad del propio usuario. */
  readonly lastLoginAt: string | null;
  /** Telefono de contacto del usuario. */
  readonly phoneNumber?: string | null;
  /** Momento de creacion de la cuenta. */
  readonly createdAt: string;
}

/** Campos de organizacion que pueden viajar al cliente. */
export interface PublicOrganization {
  /** Identificador de la organizacion. */
  readonly id: string;
  /** Nombre visible de la organizacion. */
  readonly name: string;
  /** Identificador legible usado en direcciones. */
  readonly slug: string;
  /** Telefono de contacto de la organizacion. */
  readonly phoneNumber?: string | null;
}

/**
 * Proyecta una entidad de usuario a los campos que pueden viajar al cliente.
 *
 * @param user - Entidad de usuario tal como la devuelve el repositorio.
 * @returns Objeto con la lista blanca de campos publicos, sin material sensible.
 */
export function toPublicUser(user: UserEntity): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    emailVerified: user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined,
    mfaTotpEnabled: user.mfaTotpEnabled,
    mfaWebauthnEnabled: user.mfaWebauthnEnabled,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    phoneNumber: user.phoneNumber ?? null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/**
 * Proyecta una entidad de organizacion a los campos que pueden viajar al cliente.
 *
 * Acepta `null` porque la renovacion de sesion puede no resolver organizacion —por ejemplo cuando el
 * usuario pertenece a varias o a ninguna— y ese caso debe propagarse como ausencia explicita en lugar
 * de provocar un fallo en el borde.
 *
 * @param organization - Entidad de organizacion, o `null` cuando no se resolvio ninguna.
 * @returns Objeto con la lista blanca de campos publicos, o `null`.
 */
export function toPublicOrganization(organization: OrganizationEntity | null): PublicOrganization | null {
  if (organization === null) {
    return null;
  }
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    phoneNumber: organization.phoneNumber ?? null,
  };
}
