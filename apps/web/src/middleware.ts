/**
 * @archivo apps/web/src/middleware.ts
 * @modulo apps/web (Guardia de Sesión de las Rutas Privadas del Dashboard)
 * @proposito
 *   Impide que cualquier ruta del Dashboard del Desarrollador (`/dashboard/*`) se sirva sin una
 *   sesión autenticada. La guardia se ejecuta en el servidor, ANTES de renderizar, de modo que
 *   ningún dato (ni real, ni de demostración) llega al navegador de un visitante anónimo: la
 *   petición se redirige al portal de acceso conservando el destino en el parámetro `next`.
 *
 * @resumen_contenido
 *   - `middleware()`: comprueba la cookie de sesión `__Host-oa_rt` (HttpOnly, `SameSite=Strict`)
 *     que el backend emite en el login, el registro y la renovación del token.
 *   - `config.matcher`: limita la guardia a `/dashboard/:path*`.
 *
 * @dependencias_internas
 *   - Ninguna (utilidades de `next/server`).
 *
 * @dependencias_externas
 *   - `next/server` (`NextResponse`, tipo `NextRequest`).
 *
 * @notas
 *   - La cookie es la señal de sesión del servidor; la validez real del token de acceso la
 *     comprueba el backend en cada petición, y el frente refleja el 401 en la interfaz.
 *   - El destino se conserva en `next` para que el portal de acceso pueda devolver al usuario
 *     a la ruta exacta que intentó abrir.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (la guardia no toca PostgreSQL ni Redis).
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Cookie HttpOnly de sesión que emite el backend en login, registro y renovación. */
const SESSION_COOKIE_NAME = '__Host-oa_rt';

/**
 * Redirige al portal de acceso cuando la ruta del dashboard se pide sin sesión.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);
  if (hasSession) {
    return NextResponse.next();
  }
  const loginUrl = new URL('/auth/login', request.url);
  loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
