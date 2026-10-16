/**
 * @archivo src/config/env.connection-identity.ts
 * @modulo 00-foundations (Auditoria de la Identidad de Conexion a PostgreSQL y su Precedencia)
 * @proposito
 *   Impide que una ambiguedad de configuracion desactive el aislamiento multi-tenant en silencio.
 *   Existe por un fallo medido (hallazgo C1-29): el entorno donde corre el proyecto exporta
 *   `DATABASE_URL` con el rol propietario (`rolbypassrls = true`) mientras el archivo `.env` declara
 *   el rol de aplicacion (`oa_app`, sin ese atributo). Como el cargador respeta la precedencia del
 *   entorno —correcta segun doce factores—, `getEnvConfig().DATABASE_URL` resolvia el rol
 *   propietario, las 27 politicas RLS dejaban de aplicarse y NINGUNA senal lo indicaba: ni un error,
 *   ni una advertencia, ni una suite en rojo. Este modulo convierte esa discrepancia en un hallazgo
 *   explicito y, en produccion, en una negativa a arrancar.
 *
 * @resumen_contenido
 *   - Tipos `ConnectionIdentitySeverity`, `ConnectionIdentityFindingCode`, `ConnectionRoleIdentity`,
 *     `ConnectionIdentityFinding` y `ConnectionIdentityAnalysisInput`.
 *   - Funcion `parseConnectionRoleIdentity()`: Extrae rol, base de datos y host de una cadena de conexion.
 *   - Funcion `buildConnectionIdentityFindings()`: Unica autoridad de diagnostico y de severidad.
 *   - Funcion `formatConnectionIdentityBanner()`: Rotulo en espanol del aviso de arranque.
 *   - Funcion `emitConnectionIdentityAlert()`: Escritura del aviso en la salida de error estandar.
 *   - Funcion `assertNoBlockingConnectionIdentityFinding()`: Aborta el arranque ante un hallazgo bloqueante.
 *
 * @politics_de_severidad
 *   El diagnostico distingue dos hechos y no los mezcla, porque tienen consecuencias distintas:
 *   1) `IDENTIDAD_APLICACION_IGUAL_A_PROPIETARIO` — la identidad resuelta para la aplicacion es la
 *      MISMA que `DATABASE_OWNER_URL` declara como propietaria. Es un hecho DEMOSTRABLE sin conectar
 *      a la base: el contrato de este proyecto afirma que el rol propietario es la identidad
 *      privilegiada de migraciones; si la aplicacion usa esa misma identidad, las politicas RLS no
 *      se aplican. Severidad: BLOQUEANTE en produccion, ALERTA en el resto.
 *   2) `IDENTIDAD_DECLARADA_ENMASCARADA_POR_EL_ENTORNO` — el archivo declara una identidad de
 *      conexion distinta de la que el proceso usara. Es la ambiguedad propiamente dicha. Severidad:
 *      ADVERTENCIA siempre; jamas bloquea, porque que una variable de entorno gane al archivo es la
 *      precedencia correcta y bloquearla romperia despliegues legitimos.
 *   Se eligio NO bloquear en todo entorno para el hecho (1) por una razon operativa concreta: los
 *   entornos de desarrollo y de pruebas comparten su shell con la variable heredada, de modo que un
 *   fallo incondicional impediria ejecutar cualquier suite —incluidas las que verifican RLS— en lugar
 *   de corregir la configuracion. La propiedad de seguridad se conserva donde importa: en produccion
 *   el proceso NO arranca, y en cualquier entorno el aviso es imposible de silenciar (se escribe en la
 *   salida de error estandar, no a traves del logger, que podria estar en nivel `silent`).
 *
 * @dependencias_internas
 *   - Tipos `ConnectionIdentityEnvironmentKey` y `NodeEnvironment` (`./env.contract.ts`). La vigilancia
 *     abarca exactamente las claves de `CONNECTION_IDENTITY_ENVIRONMENT_KEYS` de ese mismo contrato.
 *   - `ShadowedEnvironmentDeclaration` (`./env.dotenv-loader.ts`, solo tipo: el ledger de sustituciones).
 *
 * @dependencias_externas
 *   - Ninguna (El analisis de la cadena de conexion usa el `URL` nativo del runtime).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: NO abre conexion alguna; interpreta las cadenas `DATABASE_URL` y
 *     `DATABASE_OWNER_URL` para razonar sobre los atributos del rol de conexion (`rolbypassrls`).
 */

import type { ConnectionIdentityEnvironmentKey, NodeEnvironment } from './env.contract';
import type { ShadowedEnvironmentDeclaration } from './env.dotenv-loader';

/** Gravedad de un hallazgo de identidad de conexion, en orden creciente de severidad. */
export type ConnectionIdentitySeverity = 'ADVERTENCIA' | 'ALERTA' | 'BLOQUEANTE';

/** Codigos cerrados de los hallazgos que esta auditoria puede emitir. */
export type ConnectionIdentityFindingCode =
  | 'IDENTIDAD_APLICACION_IGUAL_A_PROPIETARIO'
  | 'IDENTIDAD_DECLARADA_ENMASCARADA_POR_EL_ENTORNO';

/** Identidad de rol extraida de una cadena de conexion de PostgreSQL. */
export interface ConnectionRoleIdentity {
  /** Nombre del rol con el que se autentica la conexion (el atributo `rolbypassrls` es suyo). */
  readonly roleName: string;
  /** Nombre de la base de datos destino, cadena vacia cuando la URL no lo declara. */
  readonly databaseName: string;
  /** Host de la cadena de conexion, cadena vacia cuando la URL no lo declara. */
  readonly hostName: string;
}

/** Hallazgo de la auditoria de identidad de conexion. */
export interface ConnectionIdentityFinding {
  /** Codigo cerrado del hallazgo. */
  readonly code: ConnectionIdentityFindingCode;
  /** Gravedad del hallazgo segun la politica de severidad del modulo. */
  readonly severity: ConnectionIdentitySeverity;
  /** Variable de entorno a la que se atribuye el hallazgo y que el contrato senala como culpable. */
  readonly attribute: ConnectionIdentityEnvironmentKey;
  /** Descripcion del riesgo en espanol, apta para mostrarse en un error de arranque. */
  readonly description: string;
  /** Accion correctiva recomendada, en imperativo. */
  readonly recommendation: string;
}

/** Entrada del analisis: valores ya resueltos y el ledger de sustituciones del cargador. */
export interface ConnectionIdentityAnalysisInput {
  /** Identidad de conexion resuelta para la aplicacion (`DATABASE_URL` del proceso ya validado). */
  readonly databaseUrl: string | undefined;
  /** Identidad resuelta del propietario (`DATABASE_OWNER_URL`), opcional por contrato. */
  readonly ownerUrl: string | undefined;
  /** Entorno de ejecucion resuelto, que decide si el hallazgo bloqueante impide arrancar. */
  readonly environmentName: NodeEnvironment;
  /** Declaraciones del archivo sustituidas por el entorno, en la ultima carga del cargador. */
  readonly shadowedDeclarations: readonly ShadowedEnvironmentDeclaration[];
}

/**
 * Extrae la identidad del rol de una cadena de conexion de PostgreSQL.
 *
 * @param connectionString - Cadena `postgresql://` o `postgres://` a interpretar.
 * @returns Identidad del rol, o `null` cuando la cadena no es interpretable como URL.
 */
export function parseConnectionRoleIdentity(connectionString: string | undefined): ConnectionRoleIdentity | null {
  if (connectionString === undefined || connectionString.trim().length === 0) {
    return null;
  }

  try {
    const parsedUrl = new URL(connectionString.trim());
    return {
      roleName: decodeUserInfo(parsedUrl.username),
      databaseName: decodeUserInfo(parsedUrl.pathname.replace(/^\//u, '')),
      hostName: parsedUrl.host,
    };
  } catch {
    return null;
  }
}

/**
 * Decodifica el componente de usuario o de ruta de una URL de conexion sin abortar ante una
 * secuencia de escape invalida aportada por un tercero.
 *
 * @param rawComponent - Componente tal como lo devuelve el analizador de URLs.
 * @returns Componente decodificado, o el valor original cuando no es decodificable.
 */
function decodeUserInfo(rawComponent: string): string {
  try {
    return decodeURIComponent(rawComponent);
  } catch {
    return rawComponent;
  }
}

/**
 * Determina si dos identidades de conexion corresponden al MISMO rol del motor.
 *
 * Se compara el nombre del rol y no el host ni la base de datos: `rolbypassrls` es un atributo del
 * rol, y los roles de PostgreSQL son unicos por cluster, de modo que dos cadenas con el mismo rol
 * (aunque una use el agrupador de conexiones y otra el host directo) omiten RLS por igual.
 *
 * @param applicationRole - Rol resuelto para la aplicacion.
 * @param ownerRole - Rol declarado como propietario.
 * @returns `true` cuando ambos nombres designan el mismo rol.
 */
function isSameRole(applicationRole: ConnectionRoleIdentity, ownerRole: ConnectionRoleIdentity): boolean {
  return applicationRole.roleName.length > 0 && applicationRole.roleName.toLowerCase() === ownerRole.roleName.toLowerCase();
}

/**
 * Unica autoridad de diagnostico de la identidad de conexion: evalua los hechos medibles y les
 * asigna severidad segun el entorno. Tanto el contrato de entorno (validacion) como el punto de
 * acceso a la configuracion (arranque) invocan esta misma funcion, de modo que no existan dos
 * criterios distintos sobre el mismo riesgo.
 *
 * @param input - Valores resueltos, entorno de ejecucion y sustituciones registradas por el cargador.
 * @returns Lista inmutable de hallazgos, vacia cuando la identidad de conexion es inequivoca y segura.
 */
export function buildConnectionIdentityFindings(
  input: ConnectionIdentityAnalysisInput
): readonly ConnectionIdentityFinding[] {
  const findings: ConnectionIdentityFinding[] = [];
  const applicationRole = parseConnectionRoleIdentity(input.databaseUrl);
  const ownerRole = parseConnectionRoleIdentity(input.ownerUrl);
  const isProduction = input.environmentName === 'production';

  if (applicationRole !== null && ownerRole !== null && isSameRole(applicationRole, ownerRole)) {
    findings.push({
      code: 'IDENTIDAD_APLICACION_IGUAL_A_PROPIETARIO',
      severity: isProduction ? 'BLOQUEANTE' : 'ALERTA',
      attribute: 'DATABASE_URL',
      description:
        `La identidad de conexion resuelta para la aplicacion usa el rol "${applicationRole.roleName}", el MISMO rol que ` +
        `DATABASE_OWNER_URL declara como propietario de la base de datos ("${ownerRole.roleName}"). El rol propietario es ` +
        'la identidad privilegiada que este contrato reserva a las migraciones, y en este despliegue tiene (o puede tener) ' +
        'rolbypassrls: si lo tiene, las politicas RLS NO se aplican en ejecucion y el aislamiento entre organizaciones ' +
        'depende unicamente del filtrado de la aplicacion. El fallo es silencioso por naturaleza: las consultas responden, ' +
        'ninguna suite funcional falla y la unica forma de detectarlo es comparar las dos identidades de conexion.',
      recommendation:
        'Usar en DATABASE_URL un rol de aplicacion sin BYPASSRLS (por ejemplo oa_app) y reservar DATABASE_OWNER_URL para ' +
        'migraciones y tareas administrativas. Si el rol propietario procede de una variable heredada del shell o del ' +
        'orquestador, retirarla del entorno del proceso para que se aplique la identidad declarada en el archivo.',
    });
  }

  for (const declaration of input.shadowedDeclarations) {
    const declaredIdentity = parseConnectionRoleIdentity(declaration.declaredValue);
    const declaredRoleLabel = declaredIdentity === null ? 'rol no interpretable' : `rol "${declaredIdentity.roleName}"`;
    const effectiveRoleLabel =
      declaration.key === 'DATABASE_URL'
        ? applicationRole === null
          ? 'una identidad no interpretable'
          : `el rol "${applicationRole.roleName}"`
        : 'la identidad del propietario';

    findings.push({
      code: 'IDENTIDAD_DECLARADA_ENMASCARADA_POR_EL_ENTORNO',
      severity: 'ADVERTENCIA',
      attribute: declaration.key === 'DATABASE_URL' ? 'DATABASE_URL' : 'DATABASE_OWNER_URL',
      description:
        `El archivo .env declara ${declaration.key} con ${declaredRoleLabel}, pero el entorno del proceso ya definia esa ` +
        `variable y conserva la precedencia: la conexion usara ${effectiveRoleLabel}. La precedencia entorno-sobre-archivo ` +
        'es correcta (doce factores) y NO se modifica; lo que se denuncia es la ambiguedad, porque a partir de aqui la ' +
        'identidad efectiva no es la que cualquiera deduciria leyendo el archivo.',
      recommendation:
        'Confirmar cual de las dos identidades rige en este entorno y eliminar la otra: si la correcta es la del archivo, ' +
        `retirar ${declaration.key} del entorno del proceso; si es la del entorno, actualizar el archivo para que no declare ` +
        'una identidad distinta.',
    });
  }

  return Object.freeze(findings);
}

/**
 * Redacta el aviso de arranque en espanol con todos los hallazgos relevantes.
 *
 * @param findings - Hallazgos emitidos por `buildConnectionIdentityFindings()`.
 * @param environmentName - Entorno de ejecucion, incluido en el rotulo para situar el aviso.
 * @returns Texto del aviso, listo para escribirse en la salida de error estandar.
 */
export function formatConnectionIdentityBanner(
  findings: readonly ConnectionIdentityFinding[],
  environmentName: NodeEnvironment
): string {
  const worstSeverity = findings.some((finding) => finding.severity === 'BLOQUEANTE')
    ? 'BLOQUEANTE'
    : findings.some((finding) => finding.severity === 'ALERTA')
      ? 'ALERTA'
      : 'ADVERTENCIA';
  const separator = '='.repeat(96);
  const lines: string[] = [
    separator,
    `[${worstSeverity} DE IDENTIDAD DE CONEXION] entorno: ${environmentName} | hallazgos: ${findings.length}`,
    'La identidad con la que se conectara a PostgreSQL no es inequivoca o no es la del rol de aplicacion.',
    'Si el rol de conexion tiene rolbypassrls, las politicas RLS no se aplican y el aislamiento entre',
    'organizaciones queda a cargo unicamente del filtrado de la aplicacion.',
    '-'.repeat(96),
  ];

  for (const finding of findings) {
    lines.push(`[${finding.severity}] ${finding.code}`);
    lines.push(`  ${finding.description}`);
    lines.push(`  -> ${finding.recommendation}`);
  }

  lines.push(separator);
  return `${lines.join('\n')}\n`;
}

/**
 * Escribe el aviso de identidad de conexion en la salida de error estandar.
 *
 * Se escribe directamente en `process.stderr` y no a traves del logger estructurado de forma
 * deliberada: un logger en nivel `silent` —o cualquier configuracion que descarte mensajes de
 * advertencia— volveria a dejar el fallo sin decir, que es exactamente el modo de fallo que este
 * modulo existe para impedir.
 *
 * @param findings - Hallazgos emitidos por `buildConnectionIdentityFindings()`.
 * @param environmentName - Entorno de ejecucion, incluido en el rotulo del aviso.
 */
export function emitConnectionIdentityAlert(
  findings: readonly ConnectionIdentityFinding[],
  environmentName: NodeEnvironment
): void {
  if (findings.length === 0) {
    return;
  }
  process.stderr.write(formatConnectionIdentityBanner(findings, environmentName));
}

/**
 * Aborta la resolucion de la configuracion cuando existe un hallazgo bloqueante, enumerando todos
 * los motivos. Se invoca en el punto de acceso a la configuracion para que ni siquiera un llamador
 * que evite el contrato de Zod pueda arrancar en el estado peligroso.
 *
 * @param findings - Hallazgos emitidos por `buildConnectionIdentityFindings()`.
 * @throws Error con el codigo `IDENTIDAD_CONEXION_BLOQUEANTE` y el detalle de cada hallazgo.
 */
export function assertNoBlockingConnectionIdentityFinding(
  findings: readonly ConnectionIdentityFinding[]
): void {
  const blockingFindings = findings.filter((finding) => finding.severity === 'BLOQUEANTE');
  if (blockingFindings.length === 0) {
    return;
  }

  const details = blockingFindings
    .map((finding) => `  - ${finding.attribute}: ${finding.description}\n    -> ${finding.recommendation}`)
    .join('\n');
  throw new Error(
    `IDENTIDAD_CONEXION_BLOQUEANTE: el proceso no puede arrancar en produccion con una identidad de conexion que ` +
      `omite las politicas RLS.\n${details}`
  );
}
