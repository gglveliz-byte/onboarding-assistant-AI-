/**
 * @archivo scripts/verify-production-readiness.ts
 * @modulo Scripts de Verificacion (Puerta de Calidad Antes de Desplegar)
 * @proposito
 *   Comprueba, contra la base de datos y los servicios reales, que el sistema cumple las condiciones
 *   minimas para atender trafico de produccion. Existe porque las 19 suites de pruebas pasan con
 *   `neondb_owner`, un rol con `rolbypassrls = true` que **anula todas las politicas RLS**: es decir,
 *   el aislamiento multi-tenant que la plataforma promete no esta en vigor en ejecucion y ninguna
 *   prueba funcional lo detecta, porque las pruebas comprueban el comportamiento y el motor no aplica
 *   la politica. Un verificador que se ejecuta contra la infraestructura real es la unica forma de
 *   que esa discrepancia deje de ser invisible.
 *
 *   El script **no corrige nada**: mide y falla. Corregir el rol de conexion es una decision de
 *   despliegue con impacto directo en produccion y debe autorizarla una persona.
 *
 * @resumen_contenido
 *   - Constantes `TABLES_THAT_MUST_NOT_HAVE_RLS` y `SENSITIVE_TABLES_REQUIRING_RLS`.
 *   - Funcion `verifyDatabaseRole()`: Deteccion del atributo `BYPASSRLS`.
 *   - Funcion `verifyRowLevelSecurity()`: Cobertura de RLS y politicas por tabla.
 *   - Funcion `verifySchemaMigrations()`: Integridad de las migraciones aplicadas.
 *   - Funcion `verifyRedisAndPool()`: Salud de los servicios compartidos.
 *   - Funcion `main()`: Informe consolidado con codigo de salida segun la gravedad.
 *
 * @dependencias_internas
 *   - `getEnvConfig()` (`src/config/env.schema.ts`).
 *   - `RlsDatabasePool` y `RedisClusterClient` (kernel de infraestructura).
 *
 * @dependencias_externas
 *   - `pg` (Consulta directa al catalogo del motor para leer los atributos de rol y de tabla).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `pg_roles`, `pg_class` y `pg_policies` (Solo lectura del catalogo).
 *   - PostgreSQL: `schema_migrations` (Verificacion de las migraciones aplicadas).
 *   - Redis: Comprobacion de alcance del cliente.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCatalogSnapshot, type CatalogSnapshot } from './production-readiness.catalog';
import { RlsDatabasePool } from '../src/shared/infrastructure/database/rls-pool';
import { createRedisClusterClientFromEnv } from '../src/shared/infrastructure/redis/redis-cluster.client';
import { getEnvConfig, loadDotEnvFile } from '../src/config/env.schema';

/**
 * Tablas que legitimamente NO deben tener RLS.
 *
 * `schema_migrations` es metadatos de infraestructura: no contiene datos de ningun tenant y su
 * lectura es necesaria durante el arranque, antes de que exista contexto de organizacion. Aplicarle
 * politicas impediria al migrador comprobar que migraciones ya se aplicaron.
 */
const TABLES_THAT_MUST_NOT_HAVE_RLS: readonly string[] = Object.freeze(['schema_migrations']);

/**
 * Tablas con datos de tenant o de identidad que EXIGEN RLS habilitado.
 * Se listan de forma explicita para que una tabla nueva que olvide su politica no pase inadvertida:
 * una lista derivada del catalogo no detectaria lo que aun no existe.
 */
const SENSITIVE_TABLES_REQUIRING_RLS: readonly string[] = Object.freeze([
  'auth_sessions',
  'legal_documents',
  'password_reset_tokens',
  'pricing_plans_config',
  'user_mfa_recovery_codes',
  'users',
]);

/**
 * Lee una variable de conexion directamente del archivo `.env`, sin depender de la cache del
 * contrato de entorno.
 *
 * @param keyName - Nombre de la variable buscada.
 * @returns Valor sin comillas, o `null` cuando no esta declarada.
 */
function readDatabaseUrlFromEnvFile(keyName: string): string | null {
  try {
    const fileContents = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const rawLine of fileContents.split(/\r?\n/u)) {
      const trimmedLine = rawLine.trim();
      if (!trimmedLine.startsWith(`${keyName}=`)) {
        continue;
      }
      const rawValue = trimmedLine.slice(keyName.length + 1).trim();
      return rawValue.replace(/^["']|["']$/gu, '');
    }
    return null;
  } catch {
    return null;
  }
}

/** Gravedad de un hallazgo del verificador. */
type FindingSeverity = 'BLOQUEANTE' | 'ADVERTENCIA' | 'INFORMATIVO';

/** Hallazgo del verificador de preparacion. */
interface ReadinessFinding {
  /** Gravedad del hallazgo. */
  readonly severity: FindingSeverity;
  /** Area a la que pertenece. */
  readonly area: string;
  /** Descripcion del hallazgo. */
  readonly description: string;
  /** Accion recomendada, en imperativo. */
  readonly recommendation: string;
}

/** Contexto medido de la base de datos, compartido por las verificaciones. */

/** Puerto reservado por convencion del proyecto, usado para detectar configuraciones equivocadas. */
const EXPECTED_API_PORT = 3000;

function verifyDatabaseRole(snapshot: CatalogSnapshot): readonly ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];

  if (snapshot.bypassesRls) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Aislamiento multi-tenant',
      description:
        `El rol de conexion "${snapshot.roleName}" tiene BYPASSRLS activo, de modo que las politicas RLS ` +
        `NO se aplican en ejecucion. El aislamiento entre organizaciones depende hoy unicamente del ` +
        `filtrado de la aplicacion, y cualquier consulta que olvide el filtro expone datos de otro tenant.`,
      recommendation:
        'Crear un rol de aplicacion sin BYPASSRLS (por ejemplo oa_app) con permisos de DML sobre el esquema ' +
        'publico y usarlo en DATABASE_URL. El rol de propietario debe reservarse para las migraciones.',
    });
  }

  if (snapshot.isSuperuser) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Aislamiento multi-tenant',
      description: `El rol de conexion "${snapshot.roleName}" es superusuario: tambien omite RLS y ademas puede alterar el esquema.`,
      recommendation: 'Usar un rol de aplicacion sin privilegios de superusuario ni de propietario.',
    });
  }

  return findings;
}

/**
 * Verifica la cobertura de RLS de todas las tablas del esquema publico.
 *
 * @param snapshot - Instantanea del catalogo.
 * @returns Hallazgos detectados.
 */
function verifyRowLevelSecurity(snapshot: CatalogSnapshot): readonly ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];

  const tablesWithoutRls = snapshot.tables.filter(
    (table) => !table.rlsEnabled && !TABLES_THAT_MUST_NOT_HAVE_RLS.includes(table.tableName)
  );
  if (tablesWithoutRls.length > 0) {
    const sensitiveOnes = tablesWithoutRls.filter((table) => SENSITIVE_TABLES_REQUIRING_RLS.includes(table.tableName));
    findings.push({
      severity: sensitiveOnes.length > 0 ? 'BLOQUEANTE' : 'ADVERTENCIA',
      area: 'Aislamiento multi-tenant',
      description:
        `${tablesWithoutRls.length} tabla(s) del esquema publico no tienen RLS habilitado: ` +
        `${tablesWithoutRls.map((table) => table.tableName).join(', ')}. ` +
        (sensitiveOnes.length > 0
          ? `De ellas, ${sensitiveOnes.length} contienen datos de identidad (${sensitiveOnes.map((table) => table.tableName).join(', ')}).`
          : 'Ninguna contiene datos de identidad declarados.'),
      recommendation:
        'Habilitar RLS con politicas por organizacion en las tablas de identidad; para las tablas de ' +
        'catalogo global, documentar de forma explicita por que su lectura es publica.',
    });
  }

  const tablesWithRlsButNoPolicy = snapshot.tables.filter((table) => table.rlsEnabled && table.policyCount === 0);
  if (tablesWithRlsButNoPolicy.length > 0) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Aislamiento multi-tenant',
      description:
        `Con RLS habilitado pero SIN politicas, una tabla es inaccesible para todo rol que no omita RLS: ` +
        `${tablesWithRlsButNoPolicy.map((table) => table.tableName).join(', ')}.`,
      recommendation: 'Definir las politicas de la tabla o deshabilitar RLS si su lectura debe ser publica.',
    });
  }

  const tablesWithRlsNotForced = snapshot.tables.filter((table) => table.rlsEnabled && !table.rlsForced);
  if (tablesWithRlsNotForced.length > 0) {
    findings.push({
      severity: 'INFORMATIVO',
      area: 'Aislamiento multi-tenant',
      description:
        `${tablesWithRlsNotForced.length} tabla(s) tienen RLS habilitado pero no forzado: el PROPIETARIO de la ` +
        'tabla las omite aunque no tenga BYPASSRLS. Es el comportamiento esperado mientras las migraciones las ' +
        'ejecute el propietario, pero conviene tenerlo presente al auditar.',
      recommendation: 'No requiere accion inmediata; revisar si el rol de aplicacion llegara a ser propietario.',
    });
  }

  const totalPolicies = snapshot.tables.reduce((accumulator, table) => accumulator + table.policyCount, 0);
  findings.push({
    severity: 'INFORMATIVO',
    area: 'Aislamiento multi-tenant',
    description: `${snapshot.tables.length} tabla(s) y ${totalPolicies} politica(s) RLS declaradas en el esquema publico.`,
    recommendation: 'Ninguna.',
  });

  return findings;
}

/**
 * Verifica que las migraciones aplicadas sean las esperadas.
 *
 * La cifra esperada se **cuenta desde el directorio de migraciones** y no se escribe a mano. Un numero
 * fijo convierte la creacion legitima de una migracion nueva en un falso bloqueante de despliegue:
 * esa es exactamente la falsa alarma que produjo este verificador al anadirse la migracion 008. La
 * comprobacion real es que **lo aplicado coincida con lo que existe en el repositorio**, que es lo que
 * detecta una migracion que alguien olvido ejecutar.
 *
 * @param snapshot - Instantanea del catalogo.
 * @returns Hallazgos detectados.
 */
function verifySchemaMigrations(snapshot: CatalogSnapshot): readonly ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const expectedMigrationFiles = readdirSync(resolve(process.cwd(), 'migrations'))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  const missingMigrations = expectedMigrationFiles.filter(
    (fileName) => !snapshot.appliedMigrations.includes(fileName)
  );
  const unknownMigrations = snapshot.appliedMigrations.filter(
    (fileName) => !expectedMigrationFiles.includes(fileName)
  );

  if (missingMigrations.length > 0) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Esquema',
      description:
        `${missingMigrations.length} migracion(es) del repositorio NO estan aplicadas: ${missingMigrations.join(', ')}. ` +
        `Aplicadas: ${snapshot.appliedMigrations.length} de ${expectedMigrationFiles.length}.`,
      recommendation: 'Ejecutar `npm run db:migrate` y revisar el resultado antes de desplegar.',
    });
    return findings;
  }

  if (unknownMigrations.length > 0) {
    // Una migracion aplicada que ya no existe en el repositorio indica un despliegue desde una version
    // distinta del codigo: el esquema tiene cambios que nadie puede reproducir.
    findings.push({
      severity: 'ADVERTENCIA',
      area: 'Esquema',
      description:
        `${unknownMigrations.length} migracion(es) aplicadas que NO existen en el repositorio: ` +
        `${unknownMigrations.join(', ')}. El esquema procede de una version distinta del codigo.`,
      recommendation: 'Confirmar que se despliega la misma revision que genero el esquema.',
    });
  }

  findings.push({
    severity: 'INFORMATIVO',
    area: 'Esquema',
    description: `${snapshot.appliedMigrations.length} migraciones aplicadas: ${snapshot.appliedMigrations.join(', ')}.`,
    recommendation: 'Ninguna.',
  });
  return findings;
}

/**
 * Verifica la salud del pool de PostgreSQL y del cliente de Redis.
 *
 * @returns Hallazgos detectados.
 */
async function verifySharedServices(connectionString: string): Promise<readonly ReadinessFinding[]> {
  const findings: ReadinessFinding[] = [];
  const environment = getEnvConfig();

  const pool = new RlsDatabasePool({
    connectionString,
    maxConnections: 2,
    statementTimeoutMs: environment.DATABASE_STATEMENT_TIMEOUT_MS,
  });
  try {
    const health = await pool.healthCheck();
    findings.push({
      severity: 'INFORMATIVO',
      area: 'Infraestructura',
      description: `PostgreSQL responde (${health.engineVersion}, ${health.totalConnections} conexion/es).`,
      recommendation: 'Ninguna.',
    });
  } catch (error) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Infraestructura',
      description: `El pool de PostgreSQL no responde: ${error instanceof Error ? error.message : String(error)}.`,
      recommendation: 'Revisar DATABASE_URL y la conectividad de red antes de desplegar.',
    });
  } finally {
    await pool.close();
  }

  const redisClient = createRedisClusterClientFromEnv();
  try {
    const health = await redisClient.healthCheck();
    findings.push(
      health.reachable
        ? {
            severity: 'INFORMATIVO',
            area: 'Infraestructura',
            description: `Redis responde (${health.mode}, ${health.latencyMs} ms).`,
            recommendation: 'Ninguna.',
          }
        : {
            severity: 'BLOQUEANTE',
            area: 'Infraestructura',
            description: 'Redis no responde: sin el no hay cuotas, idempotencia de webhooks ni estado de sesion.',
            recommendation: 'Revisar REDIS_CLUSTER_URLS y la conectividad antes de desplegar.',
          }
    );
  } finally {
    await redisClient.close();
  }

  if (environment.NODE_ENV === 'production' && environment.PORT !== EXPECTED_API_PORT) {
    findings.push({
      severity: 'ADVERTENCIA',
      area: 'Configuracion',
      description: `El plano de control escuchara en el puerto ${environment.PORT} en lugar del ${EXPECTED_API_PORT} esperado por el balanceador.`,
      recommendation: 'Confirmar que la configuracion del balanceador apunta al puerto declarado.',
    });
  }

  if (environment.SSRF_ALLOW_PRIVATE_NETWORKS && environment.NODE_ENV === 'production') {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Seguridad',
      description:
        'SSRF_ALLOW_PRIVATE_NETWORKS esta habilitado en produccion: el escudo Anti-SSRF permitiria al navegador ' +
        'de entrenamiento alcanzar servicios internos, incluidos los metadatos del proveedor de nube.',
      recommendation: 'Deshabilitar SSRF_ALLOW_PRIVATE_NETWORKS en produccion.',
    });
  }

  return findings;
}

/**
 * Ejecuta todas las verificaciones y presenta el informe consolidado.
 */
async function main(): Promise<void> {
  console.log('VERIFICACION DE PREPARACION PARA PRODUCCION');
  console.log('='.repeat(96));

  // Se carga el archivo `.env` de forma explicita y se contrasta con lo que el proceso ya tenia:
  // si el archivo declara una identidad de conexion distinta de la vigente, el verificador debe
  // medir la del archivo —que es la que se desplegara— y avisar de la discrepancia, en lugar de
  // reportar como bloqueante un estado que ya fue corregido en la configuracion.
  const loadedKeys = loadDotEnvFile();
  const findings: ReadinessFinding[] = [];
  const ownerUrlFromFile = readDatabaseUrlFromEnvFile('DATABASE_OWNER_URL');
  const appUrlFromFile = readDatabaseUrlFromEnvFile('DATABASE_URL');
  if (appUrlFromFile !== null && ownerUrlFromFile !== null && appUrlFromFile === ownerUrlFromFile) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Aislamiento multi-tenant',
      description:
        'DATABASE_URL y DATABASE_OWNER_URL apuntan a la MISMA identidad de conexion: la aplicacion estaria ' +
        'usando el rol propietario y volveria a omitir las politicas RLS.',
      recommendation: 'Separar las dos identidades: aplicacion sin BYPASSRLS y propietario solo para migraciones.',
    });
  }
  console.log(`Variables de conexion leidas del archivo: ${loadedKeys.length} clave(s) declaradas.`);
  // Se mide la cadena declarada en el ARCHIVO, no la que herede el proceso: un `DATABASE_URL`
  // exportado en la sesion de shell mediria una identidad distinta de la que se va a desplegar y el
  // verificador reportaria como bloqueante un estado ya corregido en la configuracion.
  const inheritedUrl = process.env['DATABASE_URL'];
  const measuredUrl = appUrlFromFile ?? inheritedUrl ?? '';
  if (appUrlFromFile !== null && inheritedUrl !== undefined && appUrlFromFile !== inheritedUrl) {
    findings.push({
      severity: 'ADVERTENCIA',
      area: 'Configuracion',
      description:
        'La variable DATABASE_URL del proceso difiere de la declarada en el archivo .env. Se mide la del ' +
        'archivo, que es la que se desplegara; conviene limpiar la variable heredada para evitar confusion.',
      recommendation: 'Retirar DATABASE_URL del entorno del shell o del orquestador y dejar que provenga del archivo.',
    });
  }
  const snapshot = await readCatalogSnapshot(measuredUrl);

  if (snapshot === null) {
    findings.push({
      severity: 'BLOQUEANTE',
      area: 'Base de datos',
      description: 'No fue posible leer el catalogo de PostgreSQL: la base de datos no responde o DATABASE_URL es invalida.',
      recommendation: 'Verificar DATABASE_URL y la conectividad antes de continuar.',
    });
  } else {
    console.log(`Rol de conexion: ${snapshot.roleName} (superusuario: ${String(snapshot.isSuperuser)}, omite RLS: ${String(snapshot.bypassesRls)})`);
    console.log(`Tablas: ${snapshot.tables.length} | Politicas: ${snapshot.tables.reduce((accumulator, table) => accumulator + table.policyCount, 0)}`);
    findings.push(...verifyDatabaseRole(snapshot));
    findings.push(...verifyRowLevelSecurity(snapshot));
    findings.push(...verifySchemaMigrations(snapshot));
  }

  findings.push(...(await verifySharedServices(measuredUrl)));

  const blockingFindings = findings.filter((finding) => finding.severity === 'BLOQUEANTE');
  const warningFindings = findings.filter((finding) => finding.severity === 'ADVERTENCIA');

  console.log('');
  for (const severity of ['BLOQUEANTE', 'ADVERTENCIA', 'INFORMATIVO'] as const) {
    const matchingFindings = findings.filter((finding) => finding.severity === severity);
    if (matchingFindings.length === 0) {
      continue;
    }
    console.log(`--- ${severity} (${matchingFindings.length}) ---`);
    for (const finding of matchingFindings) {
      console.log(`  [${finding.area}] ${finding.description}`);
      if (severity !== 'INFORMATIVO') {
        console.log(`     -> ${finding.recommendation}`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(96));
  if (blockingFindings.length > 0) {
    console.log(
      `RESULTADO: NO APTO PARA PRODUCCION. ${blockingFindings.length} hallazgo(s) bloqueante(s) y ` +
        `${warningFindings.length} advertencia(s).`
    );
    process.exit(1);
  }
  if (warningFindings.length > 0) {
    console.log(`RESULTADO: APTO CON RESERVAS. ${warningFindings.length} advertencia(s) por resolver.`);
    process.exit(0);
  }
  console.log('RESULTADO: APTO PARA PRODUCCION. Sin hallazgos bloqueantes ni advertencias.');
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error('RESULTADO: FALLIDO.');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});





