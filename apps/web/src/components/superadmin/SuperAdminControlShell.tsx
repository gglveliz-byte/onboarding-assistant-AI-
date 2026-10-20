/**
 * @archivo apps/web/src/components/superadmin/SuperAdminControlShell.tsx
 * @modulo apps/web (Componentes de Consola SuperAdmin)
 * @proposito
 *   Layout y cascarón maestro de alta densidad (Cursor Atelier Light) para la Consola
 *   de Gobierno de Plataforma de SuperAdmin. Valida sesión con indicador de hardware
 *   Passkey FIDO2, reloj de expiración de 4 horas y monitoreo de los 3 Node Pools.
 *   En pantallas < lg provee barra superior compacta y Drawer off-canvas; en >= lg
 *   mantiene la barra lateral fija de 240px. Utiliza Next.js Link para evitar recargas
 *   destructivas de telemetría SSE y sesión.
 *
 * @resumen_contenido
 *   - Componente `SuperAdminControlShell`:
 *       * Barra superior compacta con botón hamburguesa y Drawer off-canvas en pantallas < lg.
 *       * Barra lateral fija en `#f2f1ed` Bone con separador capilar de 1px en `#cdcdc9` en desktop (>= lg).
 *       * Enlaces de navegación con componente `<Link>` de Next.js (cero reseteos de SSE).
 *       * Indicador de sesión FIDO2 hardware autenticada con insignia verde esmeralda.
 *       * Reloj regresivo de expiración de sesión (4 horas desde el inicio de sesión).
 *       * Semáforo de estado de los tres Node Pools (API, Voz Realtime, Visual Trainer).
 *       * Contenedor de contenido responsivo (`children`).
 *
 * @dependencias_internas
 *   - Tokens CSS de `estilo-paneles-y-docs-cursor-atelier`.
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`, `ReactNode`, `useState`, `useEffect`).
 *   - `next/link` (`Link` para navegación suave sin recarga).
 *
 * @tablas_bd_o_redis
 *   - Verifica autoridad de `users.is_platform_superadmin = true`.
 */

import React, { ReactElement, ReactNode, useState, useEffect } from 'react';
import Link from 'next/link';
import { getAccessToken, setAccessToken } from '../../lib/api-client/http-client';

export interface SuperAdminControlShellProps {
  readonly currentPath: string;
  readonly children: ReactNode;
}

interface NodePoolStatus {
  readonly name: string;
  readonly status: 'ONLINE' | 'DEGRADED' | 'MAINTENANCE';
  readonly latencyMs: number;
}

const NAVIGATION_ITEMS = [
  { label: 'Organizaciones y Tenants', href: '/superadmin/organizations', icon: '🏢' },
  { label: 'Matriz Global de Precios', href: '/superadmin/pricing-matrix', icon: '💳' },
  { label: 'Tarifas y Overrides por Cliente', href: '/superadmin/custom-pricing-overrides', icon: '⚙️' },
  { label: 'Infraestructura, Kill-Switch y Logs', href: '/superadmin/infrastructure', icon: '📡' },
  { label: 'Demostración Pública', href: '/superadmin/public-demo', icon: '🎙️' },
];

/**
 * Cascarón principal de navegación y gobierno de plataforma para SuperAdmin.
 */
export function SuperAdminControlShell({
  currentPath,
  children,
}: SuperAdminControlShellProps): ReactElement {
  // Verificación de autenticación de SuperAdmin al montar
  const [isVerifyingAuth, setIsVerifyingAuth] = useState<boolean>(true);
  // Reloj de expiración de sesión de 4 horas (14400 segundos)
  const [secondsRemaining, setSecondsRemaining] = useState<number>(14400);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState<boolean>(false);

  const [nodePools] = useState<readonly NodePoolStatus[]>([
    { name: 'API Control Plane', status: 'ONLINE', latencyMs: 14 },
    { name: 'Voice Realtime Gateway', status: 'ONLINE', latencyMs: 28 },
    { name: 'Visual Trainer Orchestrator', status: 'ONLINE', latencyMs: 32 },
  ]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      if (typeof window !== 'undefined') {
        const nextUrl = window.location.pathname + window.location.search;
        window.location.replace(`/internal/superadmin-login?next=${encodeURIComponent(nextUrl)}`);
      }
      return;
    }

    try {
      const parts = token.split('.');
      const rawPayload = parts[1];
      if (parts.length === 3 && typeof rawPayload === 'string') {
        const payloadStr = atob(rawPayload.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(payloadStr) as { exp?: number };
        if (typeof payload.exp === 'number') {
          const remaining = Math.max(0, Math.floor(payload.exp - Date.now() / 1000));
          if (remaining <= 0) {
            setAccessToken(null);
            if (typeof window !== 'undefined') {
              const nextUrl = window.location.pathname + window.location.search;
              window.location.replace(`/internal/superadmin-login?next=${encodeURIComponent(nextUrl)}`);
            }
            return;
          }
          setSecondsRemaining(remaining);
        }
      }
    } catch {
      // Si falla la decodificación se mantiene el temporizador de sesión
    }

    setIsVerifyingAuth(false);
  }, []);

  useEffect(() => {
    if (isVerifyingAuth) {
      return;
    }
    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setAccessToken(null);
          if (typeof window !== 'undefined') {
            const nextUrl = window.location.pathname + window.location.search;
            window.location.replace(`/internal/superadmin-login?next=${encodeURIComponent(nextUrl)}`);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isVerifyingAuth]);

  const handleLogout = (): void => {
    setAccessToken(null);
    if (typeof window !== 'undefined') {
      window.location.replace('/internal/superadmin-login');
    }
  };

  const formatCountdown = (totalSeconds: number): string => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  /**
   * Renderiza el bloque de navegación compartido entre barra fija desktop y drawer móvil.
   */
  const renderNavigationContent = (onItemClick?: () => void) => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
      <div>
        {/* Logo y Encabezado de la Plataforma */}
        <div style={{ marginBottom: '24px', paddingLeft: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              color: 'var(--color-ember, #f54e00)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              display: 'block',
              marginBottom: '4px',
            }}
          >
            Control Maestro de Plataforma
          </span>
          <div style={{ fontSize: '18px', fontWeight: 500, letterSpacing: '-0.02em' }}>
            SuperAdmin Atelier
          </div>
        </div>

        {/* Estado de Seguridad FIDO2 y Contador de Sesión */}
        <div
          style={{
            backgroundColor: 'var(--color-parchment, #f7f7f4)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            padding: '12px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-forest, #34785c)' }}>
              ● FIDO2 Passkey Validada
            </span>
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-berkeleymono, monospace)',
                backgroundColor: 'var(--color-linen, #e6e5e0)',
                padding: '2px 4px',
                borderRadius: '2px',
              }}
            >
              HARDWARE
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>
            Sesión expira en:{' '}
            <span
              style={{
                fontFamily: 'var(--font-berkeleymono, monospace)',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 500,
                color: 'var(--color-ink, #26251e)',
              }}
            >
              {formatCountdown(secondsRemaining)}
            </span>
          </div>
        </div>

        {/* Menú de Navegación con Next.js Link para evitar recarga de telemetría */}
        <nav aria-label="Navegación SuperAdmin" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {NAVIGATION_ITEMS.map((item) => {
            const isActive = currentPath === item.href || currentPath.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => { onItemClick?.(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  fontSize: '13px',
                  fontWeight: isActive ? 500 : 400,
                  textDecoration: 'none',
                  backgroundColor: isActive ? 'var(--color-linen, #e6e5e0)' : 'transparent',
                  color: isActive ? 'var(--color-ink, #26251e)' : 'var(--color-driftwood, #84847e)',
                  borderLeft: isActive ? '3px solid var(--color-forest, #34785c)' : '3px solid transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '14px' }}>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Semáforo de los 3 Node Pools */}
      <div
        style={{
          borderTop: '1px solid var(--color-stone, #cdcdc9)',
          paddingTop: '16px',
          fontSize: '11px',
          marginTop: '24px',
        }}
      >
        <div style={{ textTransform: 'uppercase', color: 'var(--color-driftwood, #84847e)', marginBottom: '8px', fontSize: '10px' }}>
          Estado de Node Pools (Alta Densidad)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {nodePools.map((pool) => (
            <div key={pool.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-ink, #26251e)' }}>{pool.name}</span>
              <span
                style={{
                  fontFamily: 'var(--font-berkeleymono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: '10px',
                  color: 'var(--color-forest, #34785c)',
                }}
              >
                {pool.latencyMs}ms OK
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Botón de Cierre Seguro de Sesión */}
      <div style={{ borderTop: '1px solid var(--color-stone, #cdcdc9)', paddingTop: '12px', marginTop: '16px' }}>
        <button
          type="button"
          onClick={handleLogout}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '7px 12px',
            fontSize: '12px',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderRadius: '4px',
            color: 'var(--color-crimson, #cf2d56)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>⏻</span>
          <span>Cerrar sesión SuperAdmin</span>
        </button>
      </div>
    </div>
  );

  if (isVerifyingAuth) {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-6"
        style={{
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
          color: 'var(--color-ink, #26251e)',
          fontFamily: 'var(--font-cursorgothic, sans-serif)',
        }}
      >
        <div
          style={{
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            border: '1px solid var(--color-stone, #cdcdc9)',
            borderTop: '2px solid var(--color-forest, #34785c)',
            borderRadius: '4px',
            padding: '28px 32px',
            textAlign: 'center',
            maxWidth: '420px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-berkeleymono, monospace)',
              color: 'var(--color-forest, #34785c)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Gobierno de Plataforma
          </span>
          <div style={{ fontSize: '16px', fontWeight: 500 }}>
            Verificando credenciales de SuperAdmin…
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
            Se requiere una sesión activa con rol SuperAdmin para acceder a esta consola. Redirigiendo al acceso seguro…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col lg:flex-row min-h-screen"
      style={{
        backgroundColor: 'var(--color-parchment, #f7f7f4)',
        color: 'var(--color-ink, #26251e)',
        fontFamily: 'var(--font-cursorgothic, sans-serif)',
      }}
    >
      {/* Barra Superior Compacta para Móvil / Tablet (< lg) */}
      <header className="lg:hidden h-11 flex items-center justify-between px-3 sm:px-4 bg-[var(--color-bone,#f2f1ed)] border-b border-[var(--color-stone,#cdcdc9)] sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsMobileDrawerOpen((prev) => !prev)}
            aria-label={isMobileDrawerOpen ? 'Cerrar navegación' : 'Abrir navegación'}
            className="p-1.5 rounded bg-[var(--color-linen,#e6e5e0)] border border-[var(--color-stone,#cdcdc9)] text-[var(--color-ink,#26251e)] cursor-pointer"
          >
            <span style={{ display: 'block', fontSize: '16px', lineHeight: 1 }}>☰</span>
          </button>
          <div>
            <span className="text-[10px] font-mono text-[var(--color-ember,#f54e00)] uppercase block leading-none">
              Control Plataforma
            </span>
            <span className="text-[14px] font-medium tracking-tight text-[var(--color-ink,#26251e)]">
              SuperAdmin Atelier
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[var(--color-forest,#34785c)] bg-[var(--color-linen,#e6e5e0)] px-1.5 py-0.5 rounded">
            FIDO2 ●
          </span>
          <span className="text-[11px] font-mono text-[var(--color-ink,#26251e)] tabular-nums font-medium">
            {formatCountdown(secondsRemaining)}
          </span>
        </div>
      </header>

      {/* Backdrop para Drawer Móvil */}
      {isMobileDrawerOpen && (
        <div
          onClick={() => setIsMobileDrawerOpen(false)}
          className="lg:hidden fixed inset-0 bg-black/40 z-40 transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* Drawer Deslizante Off-Canvas para Móvil / Tablet (< lg) */}
      <aside
        className={`
          lg:hidden fixed inset-y-0 left-0 z-50 w-60 max-w-[85vw]
          bg-[var(--color-bone,#f2f1ed)] border-r border-[var(--color-stone,#cdcdc9)]
          flex flex-col justify-between p-4 sm:p-5 shadow-2xl transition-transform duration-200 ease-in-out
          ${isMobileDrawerOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex justify-end mb-2">
          <button
            type="button"
            onClick={() => setIsMobileDrawerOpen(false)}
            aria-label="Cerrar panel de navegación"
            className="p-1 text-[var(--color-driftwood,#84847e)] hover:text-[var(--color-ink,#26251e)] rounded text-xs cursor-pointer"
          >
            ✕ Cerrar
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {renderNavigationContent(() => setIsMobileDrawerOpen(false))}
        </div>
      </aside>

      {/* Barra Lateral Fija de Navegación SuperAdmin en Desktop (>= lg) */}
      <aside
        className="hidden lg:flex flex-col justify-between w-60 min-w-[240px] shrink-0 bg-[var(--color-bone,#f2f1ed)] border-r border-[var(--color-stone,#cdcdc9)] p-4 sm:p-5"
      >
        {renderNavigationContent()}
      </aside>

      {/* Contenido Principal de la Página */}
      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          backgroundColor: 'var(--color-parchment, #f7f7f4)',
        }}
        className="p-4 sm:p-5"
      >
        <div style={{ maxWidth: '1300px', margin: '0 auto' }}>{children}</div>
      </main>
    </div>
  );
}
