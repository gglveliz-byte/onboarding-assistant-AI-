/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/trainer-proxy-http.handler.ts
 * @modulo 03-visual-trainer-and-rag (Manejador de Proxy Inverso con Inyector DOM para el Entrenador)
 * @proposito
 *   Permite renderizar de forma segura y transparente cualquier aplicación web externa dentro
 *   del iframe del Visor del Entrenador Visual en el Dashboard. Neutraliza cabeceras restrictivas
 *   (`X-Frame-Options`, `Content-Security-Policy`), valida cada destino contra el escudo Anti-SSRF
 *   de 4 capas, inyecta la etiqueta `<base>` para preservar la carga de recursos relativos e inyecta
 *   el script puente `injected-trainer-bridge.script.ts` que permite captura de coordenadas e
 *   intercepción de enlaces para navegación perpetua dentro del proxy.
 *
 * @resumen_contenido
 *   - Funcion `handleTrainerProxyRequest`: Manejador HTTP invocado por la ruta `GET .../trainer/proxy`.
 *   - Funcion auxiliar `injectBridgeAndBase`: Transforma el HTML original inyectando `<base>` y el puente JS.
 *   - Manejo de respuestas HTML y binarias (imágenes, scripts y estilos pasantes).
 *
 * @dependencias_internas
 *   - `PinnedDnsSsrfGuard` (./pinned-dns-ssrf.guard.ts): Escudo de 4 capas contra IPs privadas y metadata.
 *   - `buildInjectedTrainerBridgeScript` (./injected-trainer-bridge.script.ts): Código puente inyectado.
 *   - `HttpRequestLike`, `HttpHandlerResult`, `AuthenticatedRequestContext` (@shared/infrastructure/http/http-server.types).
 *   - `SsrfBlockedIpError` (@shared/kernel/result-and-errors).
 *
 * @dependencias_externas
 *   - `node:buffer` (Manejo de respuestas binarias para recursos no HTML).
 *
 * @tablas_bd_o_redis
 *   - Ninguna directa (auditoría registrada mediante el sink del escudo SSRF si aplica).
 */

import { Buffer } from 'node:buffer';
import type {
  AuthenticatedRequestContext,
  HttpHandlerResult,
  HttpRequestLike,
} from '@shared/infrastructure/http/http-server.types';
import { SsrfBlockedIpError } from '@shared/kernel/result-and-errors';
import { PinnedDnsSsrfGuard } from './pinned-dns-ssrf.guard';
import { buildInjectedTrainerBridgeScript } from './injected-trainer-bridge.script';

/** Cabeceras de usuario simulando un navegador Chrome moderno para el scrape seguro. */
const PROXY_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Inyecta la etiqueta `<base>` y el script puente del entrenador antes de devolver el HTML al iframe.
 */
function injectBridgeAndBase(html: string, targetOrigin: string, proxyBase: string): string {
  const baseTag = `<base href="${targetOrigin}/">`;
  const bridgeScript = `<script id="__oa_trainer_bridge__">\n${buildInjectedTrainerBridgeScript(
    proxyBase,
    targetOrigin
  )}\n</script>`;

  let modified = html;

  // Remover cualquier <base> previo del sitio para evitar desvíos
  modified = modified.replace(/<base[^>]*>/gi, '');

  // 1. Inyectar <base> al inicio de <head>
  if (/<head[^>]*>/i.test(modified)) {
    modified = modified.replace(/(<head[^>]*>)/i, `$1\n  ${baseTag}`);
  } else {
    modified = `${baseTag}\n${modified}`;
  }

  // 2. Inyectar el script puente antes del cierre de </body> o </html>
  if (/<\/body>/i.test(modified)) {
    modified = modified.replace(/<\/body>/i, `  ${bridgeScript}\n</body>`);
  } else if (/<\/html>/i.test(modified)) {
    modified = modified.replace(/<\/html>/i, `  ${bridgeScript}\n</html>`);
  } else {
    modified = `${modified}\n${bridgeScript}`;
  }

  return modified;
}

/**
 * Genera una página HTML amigable cuando la conexión remota no puede completarse.
 */
function buildProxyErrorHtml(title: string, message: string, attemptedUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${title} - Onboarding Assistant</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fcfcfa; color: #26251e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
    .card { max-width: 540px; background: #ffffff; border: 1px solid #e6e5e0; border-radius: 8px; padding: 28px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; background: #fdf0ec; color: #f54e00; margin-bottom: 12px; }
    h1 { font-size: 17px; margin: 0 0 10px 0; color: #26251e; }
    p { font-size: 13px; line-height: 1.5; color: #7a7974; margin: 0 0 14px 0; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; background: #f2f1ed; padding: 3px 6px; border-radius: 3px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">⚠️ Entrenador Visual · Error de Carga</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p>Destino: <code>${attemptedUrl}</code></p>
  </div>
</body>
</html>`;
}

/**
 * Maneja la solicitud de navegación proxificada.
 *
 * @param req - Petición HTTP recibida.
 * @param ctx - Contexto autenticado de la sesión.
 * @param projectId - Identificador del proyecto activo.
 * @param ssrfGuard - Escudo Anti-SSRF.
 */
export async function handleTrainerProxyRequest(
  req: HttpRequestLike,
  ctx: AuthenticatedRequestContext,
  projectId: string,
  ssrfGuard: PinnedDnsSsrfGuard
): Promise<HttpHandlerResult> {
  const targetUrl = (req.query['url'] ?? '').trim();

  if (!targetUrl) {
    return {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: buildProxyErrorHtml(
        'URL no proporcionada',
        'Debes especificar el parámetro ?url= con la dirección web que deseas inspeccionar.',
        ''
      ),
    };
  }

  // 1. Normalizar protocolo
  let normalizedTarget = targetUrl;
  if (!normalizedTarget.startsWith('http://') && !normalizedTarget.startsWith('https://')) {
    normalizedTarget = `https://${normalizedTarget}`;
  }

  // 2. Validación preventiva contra el Escudo Anti-SSRF de 4 Capas
  try {
    await ssrfGuard.assertSafeUrl(normalizedTarget, {
      ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
      projectId,
    });
  } catch (err: unknown) {
    const isSsrf = err instanceof SsrfBlockedIpError;
    const msg = isSsrf
      ? `Acceso bloqueado por política de seguridad Anti-SSRF (${(err as Error).message}). Las direcciones privadas o de metadatos están prohibidas.`
      : `La URL proporcionada no es válida o no está permitida (${err instanceof Error ? err.message : 'Error de validación'}).`;

    return {
      status: isSsrf ? 403 : 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: buildProxyErrorHtml('Destino No Autorizado', msg, normalizedTarget),
    };
  }

  // 3. Ejecutar la petición HTTP hacia el destino remoto con timeout controlado
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const upstreamResponse = await fetch(normalizedTarget, {
      method: 'GET',
      headers: PROXY_FETCH_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const finalUrl = upstreamResponse.url || normalizedTarget;
    const targetOrigin = new URL(finalUrl).origin;
    const rawContentType = upstreamResponse.headers.get('content-type') || 'text/html; charset=utf-8';
    const isHtml = rawContentType.toLowerCase().includes('text/html');

    const rawToken = req.query['token'];
    const tokenPart = typeof rawToken === 'string' && rawToken.length > 0 ? `token=${encodeURIComponent(rawToken)}&` : '';
    const proxyBase = `/api/v1/projects/${encodeURIComponent(projectId)}/trainer/proxy?${tokenPart}url=`;

    if (isHtml) {
      const htmlText = await upstreamResponse.text();
      const transformedHtml = injectBridgeAndBase(htmlText, targetOrigin, proxyBase);

      return {
        status: upstreamResponse.status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
          'access-control-allow-origin': '*',
        },
        body: transformedHtml,
      };
    }

    // 4. Recursos no-HTML (ej: imágenes, fuentes o hojas de estilo solicitadas directamente)
    const arrayBuffer = await upstreamResponse.arrayBuffer();
    const binaryBuffer = Buffer.from(arrayBuffer);

    return {
      status: upstreamResponse.status,
      headers: {
        'content-type': rawContentType,
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
      },
      body: binaryBuffer,
    };
  } catch (fetchErr: unknown) {
    clearTimeout(timeoutId);
    const isAbort = fetchErr instanceof Error && fetchErr.name === 'AbortError';
    const message = isAbort
      ? 'El servidor remoto tardó más de 12 segundos en responder (Tiempo de espera agotado).'
      : `No fue posible conectar con el servidor remoto: ${
          fetchErr instanceof Error ? fetchErr.message : 'Fallo de red'
        }`;

    return {
      status: 504,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: buildProxyErrorHtml('Error de Conexión', message, normalizedTarget),
    };
  }
}
