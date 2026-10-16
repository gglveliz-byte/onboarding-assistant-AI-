/**
 * @archivo scripts/ensure-test-services.ts
 * @modulo Scripts de Infraestructura y Pruebas (C1-53)
 * @proposito
 *   Verifica y asegura la disponibilidad de los servicios externos requeridos por la bateria
 *   de pruebas (Redis Cluster/Standalone en puerto 6379 y PostgreSQL en Neon).
 *   Si Redis no esta corriendo en local, intenta levantarlo de forma autonoma usando el binario
 *   embebido en .tools/redis para evitar falsos negativos en suites de integracion.
 *
 * @resumen_contenido
 *   - Funcion `isPortOpen()`: Comprueba conectividad TCP directa hacia host y puerto.
 *   - Funcion `ensureRedisRunning()`: Levanta el demonio local si no responde.
 *   - Funcion `ensureDatabaseReachable()`: Comprueba conectividad SQL contra DATABASE_URL.
 *   - Funcion `main()`: Orquesta las verificaciones y emite informe de pre-vuelo.
 */

import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { getEnvConfig } from '../src/config/env.schema';

/**
 * Comprueba si un puerto TCP esta escuchando conexiones.
 *
 * @param port - Puerto a verificar.
 * @param host - Direccion de host (por omision 127.0.0.1).
 * @param timeoutMs - Tiempo maximo de espera en milisegundos.
 * @returns Promesa que resuelve a `true` si el puerto esta abierto.
 */
export async function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    const cleanup = () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.once('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.once('error', () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Asegura que el servicio Redis este activo en el puerto indicado.
 *
 * @param port - Puerto esperado (por omision 6379).
 * @returns Promesa que resuelve a `true` cuando Redis esta listo.
 */
export async function ensureRedisRunning(port = 6379): Promise<boolean> {
  const isOpen = await isPortOpen(port);
  if (isOpen) {
    process.stdout.write(`[PRE-FLIGHT] Redis detectado y respondiendo en 127.0.0.1:${port}.\n`);
    return true;
  }

  process.stdout.write(`[PRE-FLIGHT] Redis no responde en 127.0.0.1:${port}. Buscando binario local...\n`);

  const localBinary = path.resolve(
    process.cwd(),
    '.tools',
    'redis',
    'Redis-8.0.2-Windows-x64-msys2',
    'redis-server.exe'
  );

  const dataDir = path.resolve(process.cwd(), '.tools', 'redis-data');

  if (!fs.existsSync(localBinary)) {
    process.stderr.write(
      `[PRE-FLIGHT] ERROR: No se encontro el binario de Redis en ${localBinary}.\n` +
      `Por favor ejecute manualmente: redis-server --port ${port}\n`
    );
    return false;
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  process.stdout.write(`[PRE-FLIGHT] Levantando Redis desde ${localBinary}...\n`);
  const child = spawn(
    localBinary,
    ['--port', String(port), '--dir', dataDir, '--save', "''", '--appendonly', 'no'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.unref();

  // Esperar hasta 4 segundos a que abra el puerto
  for (let attempt = 1; attempt <= 8; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortOpen(port)) {
      process.stdout.write(`[PRE-FLIGHT] Redis inicializado exitosamente en 127.0.0.1:${port}.\n`);
      return true;
    }
  }

  process.stderr.write(`[PRE-FLIGHT] ERROR: Redis no abrio el puerto ${port} tras iniciar el proceso.\n`);
  return false;
}

/**
 * Comprueba que la base de datos PostgreSQL sea alcanzable.
 *
 * @returns Promesa que resuelve a `true` si PostgreSQL responde.
 */
export async function ensureDatabaseReachable(): Promise<boolean> {
  let databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    try {
      const env = getEnvConfig();
      databaseUrl = env['DATABASE_URL'];
    } catch {
      // Ignorar si falla la validacion completa del schema
    }
  }

  if (!databaseUrl) {
    process.stderr.write('[PRE-FLIGHT] ADVERTENCIA: Variable DATABASE_URL no configurada.\n');
    return false;
  }

  try {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    const result = await pool.query('SELECT 1 as ping');
    await pool.end();
    const ok = result.rows[0]?.ping === 1;
    if (ok) {
      process.stdout.write('[PRE-FLIGHT] PostgreSQL conectado exitosamente.\n');
    }
    return ok;
  } catch (error) {
    process.stderr.write(
      `[PRE-FLIGHT] ERROR: Fallo al conectar con PostgreSQL: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return false;
  }
}

/**
 * Punto de entrada principal para ejecucion por CLI.
 */
async function main(): Promise<void> {
  process.stdout.write('=== [PRE-FLIGHT] VERIFICACION DE SERVICIOS PARA PRUEBAS ===\n');
  const redisOk = await ensureRedisRunning(6379);
  const dbOk = await ensureDatabaseReachable();

  if (!redisOk || !dbOk) {
    process.stderr.write('[PRE-FLIGHT] Fallo en la preparacion del entorno de pruebas.\n');
    process.exit(1);
  }

  process.stdout.write('[PRE-FLIGHT] Todos los servicios requeridos estan en linea (0 fallos de entorno).\n');
  process.exit(0);
}

if (require.main === module) {
  void main();
}
