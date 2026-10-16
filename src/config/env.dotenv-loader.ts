/**
 * @archivo src/config/env.dotenv-loader.ts
 * @modulo 00-foundations (Cargador Propio de Variables de Entorno sin Dependencias Externas)
 * @proposito
 *   Lee el archivo `.env` del directorio de trabajo e inyecta cada variable en `process.env`
 *   respetando la precedencia del entorno real del sistema operativo. Evita incorporar
 *   dependencias externas de terceros para una tarea de arranque tan critica y garantiza
 *   que ningun valor leido sea jamas impreso en consola, previniendo fugas de credenciales.
 *
 * @resumen_contenido
 *   - Funcion `loadDotEnvFile()`: Carga `.env` linea por linea con soporte de comillas.
 *   - Funcion `hasEnvironmentValue()`: Comprueba presencia de una variable con valor util.
 *   - Funcion `getShadowedEnvironmentDeclarations()`: Registro de las identidades de conexion que el
 *     archivo declaro y que el entorno del proceso sustituyo (auditoria C1-29).
 *
 * @precedencia
 *   El entorno del proceso SIEMPRE gana al archivo `.env`: una variable ya definida jamas se
 *   sobrescribe. Es la regla de doce factores y es correcta en produccion, pero implica que el
 *   archivo puede declarar una identidad de conexion distinta de la que realmente se usara sin que
 *   nada lo manifieste. Por eso las claves de `CONNECTION_IDENTITY_ENVIRONMENT_KEYS` sustituidas
 *   quedan registradas en un ledger consultable: la precedencia no cambia, la sustitucion deja de
 *   ser silenciosa. El ledger se REEMPLAZA en cada carga (no se acumula) y jamas imprime valores.
 *
 * @dependencias_internas
 *   - `CONNECTION_IDENTITY_ENVIRONMENT_KEYS` (`./env.contract.ts`) para acotar que sustituciones
 *     se conservan en memoria: se retiene la menor cantidad de valores secretos posible.
 *
 * @dependencias_externas
 *   - `node:fs`, `node:path` (Lectura de disco y resolucion de rutas absolutas).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Trabaja exclusivamente sobre el sistema de archivos local).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTION_IDENTITY_ENVIRONMENT_KEYS } from './env.contract';

/** Patron de nombre de variable de entorno valido (mayusculas, digitos y guion bajo). */
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Conjunto de claves de identidad de conexion cuya sustitucion por el entorno se conserva. */
const AUDITED_SHADOW_KEYS: ReadonlySet<string> = new Set<string>(CONNECTION_IDENTITY_ENVIRONMENT_KEYS);

/**
 * Declaracion de identidad de conexion que el archivo `.env` aporto y que NO se aplico porque el
 * entorno del proceso ya definia esa misma variable con otro valor.
 */
export interface ShadowedEnvironmentDeclaration {
  /** Nombre de la variable de entorno sustituida por el entorno del proceso. */
  readonly key: string;
  /**
   * Valor que declaro el archivo. Puede contener credenciales de conexion: NUNCA debe imprimirse,
   * registrarse en logs ni incluirse en mensajes de error; solo se inspecciona en memoria.
   */
  readonly declaredValue: string;
}

/** Ledger de sustituciones de la ultima carga ejecutada del archivo de variables. */
let shadowedDeclarations: readonly ShadowedEnvironmentDeclaration[] = Object.freeze([]);

/**
 * Devuelve las identidades de conexion que el archivo declaro y que el entorno del proceso
 * sustituyo en la ultima carga. Permite que el contrato de entorno avise de una ambiguedad que, de
 * otro modo, seria invisible: el proceso funciona, pero con una identidad distinta de la declarada.
 *
 * @returns Lista inmutable de sustituciones registradas, vacia cuando el archivo gano o no aplica.
 */
export function getShadowedEnvironmentDeclarations(): readonly ShadowedEnvironmentDeclaration[] {
  return shadowedDeclarations;
}

/**
 * Carga el archivo `.env` indicado y devuelve el conjunto de claves realmente incorporadas.
 * Las variables ya definidas en el entorno del proceso conservan siempre la precedencia,
 * de modo que un despliegue en contenedor nunca sea sobrescrito por un archivo local.
 *
 * Cuando el archivo declara una identidad de conexion distinta de la que el proceso ya tiene, la
 * declaracion del archivo no se aplica (precedencia intacta) pero queda registrada en el ledger
 * consultable mediante `getShadowedEnvironmentDeclarations()`.
 *
 * @param fileName - Nombre o ruta relativa del archivo de variables (por omision `.env`).
 * @returns Lista inmutable con los nombres de las variables cargadas desde el archivo.
 */
export function loadDotEnvFile(fileName: string = '.env'): readonly string[] {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) {
    shadowedDeclarations = Object.freeze([]);
    return [];
  }

  const loadedKeys: string[] = [];
  const replacedDeclarations: ShadowedEnvironmentDeclaration[] = [];
  const fileContents = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of fileContents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    const isQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted && value.length >= 2) {
      value = value.slice(1, -1);
    }

    const inheritedValue = process.env[key];
    if (inheritedValue === undefined) {
      process.env[key] = value;
      loadedKeys.push(key);
      continue;
    }

    // La variable del proceso conserva la precedencia. Si ademas declara una identidad de conexion
    // distinta de la del archivo, se registra la sustitucion para que el contrato pueda avisar.
    if (inheritedValue !== value && AUDITED_SHADOW_KEYS.has(key)) {
      replacedDeclarations.push(Object.freeze({ key, declaredValue: value }));
    }
  }

  shadowedDeclarations = Object.freeze(replacedDeclarations);
  return loadedKeys;
}

/**
 * Comprueba si una variable de entorno existe y contiene un valor no vacio.
 *
 * @param key - Nombre de la variable de entorno a inspeccionar.
 * @returns `true` cuando la variable esta definida con contenido util.
 */
export function hasEnvironmentValue(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value.trim().length > 0;
}
