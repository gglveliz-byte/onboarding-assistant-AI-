/**
 * @archivo scripts/check-file-lines.mjs
 * @modulo 00-foundations (Auditoria Ejecutable del Tope de 500 Lineas por Archivo)
 * @proposito
 *   Recorre el repositorio y certifica el cumplimiento de la Regla 2 de la skill
 *   `reglas-globales-construccion-codigo`: ningun archivo de codigo o SQL puede superar
 *   las 500 lineas fisicas. Reporta ademas los umbrales de alerta preventiva (381-450) y
 *   limite critico (451-500) para anticipar particiones modulares antes de romper la regla.
 *
 * @resumen_contenido
 *   - Constantes `INCLUDED_EXTENSIONS`, `EXCLUDED_DIRECTORIES`, `MAX_LINES`, `WARN_LINES`.
 *   - Funcion `collectAuditableFiles()`: Descubre recursivamente los archivos auditables.
 *   - Funcion `countPhysicalLines()`: Cuenta lineas fisicas reales de cada archivo.
 *   - Funcion `classifyFile()`: Clasifica el estado de cada archivo segun su conteo.
 *   - Bloque `main`: Imprime la tabla de auditoria y sale con codigo 1 ante cualquier violacion.
 *
 * @dependencias_internas
 *   - Ninguna (Herramienta de linea de comandos sin acoplamiento al codigo de aplicacion).
 *
 * @dependencias_externas
 *   - `node:fs`, `node:path`, `node:url` (Recorrido de disco y resolucion de rutas).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (Herramienta puramente estatica de auditoria de codigo fuente).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extensiones de archivo sujetas a la auditoria de tamano. */
const INCLUDED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.lua']);

/** Directorios excluidos del recorrido (dependencias, artefactos de build y cache local). */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.next', '.git', '.npm-cache', 'coverage', 'out', '.turbo']);

/** Tope estricto de lineas fisicas por archivo. */
const MAX_LINES = 500;

/** Umbral de alerta preventiva: a partir de aqui se evalua particionar antes de crecer. */
const WARN_LINES = 380;

/** Umbral de limite critico: prohibido agregar lineas netas sin dividir el archivo. */
const CRITICAL_LINES = 450;

/**
 * Descubre recursivamente todos los archivos auditables bajo un directorio raiz.
 *
 * @param {string} rootDirectory - Ruta absoluta del directorio a recorrer.
 * @returns {string[]} Lista de rutas absolutas de los archivos auditables.
 */
function collectAuditableFiles(rootDirectory) {
  const discovered = [];

  const walk = (currentDirectory) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          walk(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && INCLUDED_EXTENSIONS.has(path.extname(entry.name))) {
        discovered.push(absolutePath);
      }
    }
  };

  walk(rootDirectory);
  return discovered.sort((left, right) => left.localeCompare(right));
}

/**
 * Cuenta las lineas fisicas reales de un archivo, incluyendo comentarios y lineas vacias.
 *
 * @param {string} absolutePath - Ruta absoluta del archivo a medir.
 * @returns {number} Numero de lineas fisicas del archivo.
 */
function countPhysicalLines(absolutePath) {
  const contents = fs.readFileSync(absolutePath, 'utf8');
  if (contents.length === 0) {
    return 0;
  }
  const normalized = contents.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

/**
 * Clasifica el estado de un archivo segun su conteo de lineas y los umbrales oficiales.
 *
 * @param {number} lineCount - Conteo de lineas fisicas del archivo.
 * @returns {'SALUDABLE' | 'ALERTA_PREVENTIVA' | 'LIMITE_CRITICO' | 'VIOLACION_BLOQUEANTE'} Estado del archivo.
 */
function classifyFile(lineCount) {
  if (lineCount > MAX_LINES) {
    return 'VIOLACION_BLOQUEANTE';
  }
  if (lineCount > CRITICAL_LINES) {
    return 'LIMITE_CRITICO';
  }
  if (lineCount > WARN_LINES) {
    return 'ALERTA_PREVENTIVA';
  }
  return 'SALUDABLE';
}

/**
 * Ejecuta la auditoria completa e imprime el reporte en consola.
 * Sale con codigo 1 si existe al menos un archivo que supera el tope de 500 lineas.
 */
function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = collectAuditableFiles(repositoryRoot);

  let violations = 0;
  let criticals = 0;
  let warnings = 0;
  let maximum = { relativePath: '(ninguno)', lineCount: 0 };

  console.log('AUDITORIA DE TOPE DE LINEAS POR ARCHIVO (maximo estricto: 500)');
  console.log('='.repeat(96));

  for (const absolutePath of files) {
    const lineCount = countPhysicalLines(absolutePath);
    const relativePath = path.relative(repositoryRoot, absolutePath).replace(/\\/gu, '/');
    const status = classifyFile(lineCount);

    if (lineCount > maximum.lineCount) {
      maximum = { relativePath, lineCount };
    }
    if (status === 'VIOLACION_BLOQUEANTE') {
      violations += 1;
    } else if (status === 'LIMITE_CRITICO') {
      criticals += 1;
    } else if (status === 'ALERTA_PREVENTIVA') {
      warnings += 1;
    }

    console.log(`${String(lineCount).padStart(5)} / 500  ${status.padEnd(22)} ${relativePath}`);
  }

  console.log('='.repeat(96));
  console.log(`Archivos auditados: ${files.length}`);
  console.log(`Archivo mas extenso: ${maximum.relativePath} (${maximum.lineCount} lineas)`);
  console.log(`Resumen -> Violaciones: ${violations} | Limite critico: ${criticals} | Alerta preventiva: ${warnings}`);

  if (violations > 0) {
    console.error('RESULTADO: FALLO. Existen archivos que superan las 500 lineas y deben particionarse de inmediato.');
    process.exit(1);
  }

  console.log('RESULTADO: APROBADO. Ningun archivo supera las 500 lineas fisicas.');
}

main();
