/**
 * @archivo apps/web/postcss.config.mjs
 * @modulo apps/web (cadena de compilacion de estilos)
 * @proposito
 *   Configura PostCSS dentro del pipeline de Next.js para compilar Tailwind CSS v4 sobre la
 *   hoja global del workspace web.
 *
 * @resumen_contenido
 *   - Objeto `config`: declara el plugin oficial `@tailwindcss/postcss` que transforma
 *     `src/app/globals.css` (directiva `@import "tailwindcss"`, bloque `@theme` y utilidades).
 *   - `export default config`: exportacion ESM que Next.js consume de forma automatica.
 *
 * @dependencias_internas
 *   - `apps/web/src/app/globals.css` (hoja de entrada compilada por este pipeline).
 *
 * @dependencias_externas
 *   - `@tailwindcss/postcss` (plugin oficial de Tailwind CSS v4 para PostCSS).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (configuracion de compilacion: no accede a datos).
 */

const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
