/**
 * @archivo apps/web/next.config.mjs
 * @modulo apps/web (Configuracion de Next.js 15: Reverse Proxy hacia Fastify Control Plane)
 * @proposito
 *   Redirige todas las peticiones publicas y privadas /api/v1/* al backend Fastify,
 *   erradicando errores 404, evitando problemas de CORS y preservando cookies HttpOnly.
 *
 * @resumen_contenido
 *   - Objeto `nextConfig`: Configura reactStrictMode, desactiva poweredByHeader y define rewrites.
 *   - `rewrites()`: Resuelve el backendOrigin de Fastify mediante INTERNAL_API_URL,
 *     NEXT_PUBLIC_API_BASE_URL o http://127.0.0.1:3000 y enruta /api/v1/:path*.
 *
 * @dependencias_internas
 *   - Ninguna (modulo de configuracion de Next.js).
 *
 * @dependencias_externas
 *   - `next` (tipos NextConfig).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (configuracion de servidor de borde web).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  async rewrites() {
    const backendOrigin =
      process.env.INTERNAL_API_URL ||
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      'http://127.0.0.1:3000';

    return [
      {
        source: '/api/v1/:path*',
        destination: `${backendOrigin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
