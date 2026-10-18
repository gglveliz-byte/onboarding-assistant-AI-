/**
 * @archivo apps/web/src/components/docs-sandbox/DeveloperDocsShell.tsx
 * @modulo 08. Frontend Compartido — Documentación y Sandbox (División 2 / Subagente 2.6)
 * @proposito
 *   Shell editorial de `/docs`: barra superior de 44px con navegación central y buscador modal
 *   `Cmd+K`, árbol lateral en Bone con el ítem activo según la ruta, lienzo central de 1300px
 *   y selector segmentado de framework expuesto al contenido vía `useDocsFramework()`.
 * @resumen_contenido
 *   - `DOCS_FRAMEWORKS` + `DocsFrameworkId`: catálogo congelado de frameworks soportados.
 *   - `DocsNavItem`/`DocsNavSection` + `DOCS_NAV_SECTIONS`: árbol lateral y buscador `Cmd+K`.
 *   - `DocsSearchEntry` + `filterDocsSearchEntries()`: índice plano del buscador con filtro
 *     case-insensitive por etiqueta y resumen.
 *   - `DocsFrameworkContextValue` + `useDocsFramework()`: contrato congelado consumido por la
 *     guía `/docs` y el sandbox (subagentes 2.7/2.8).
 *   - `DeveloperDocsShellProps` + `DeveloperDocsShell`: shell de presentación puro.
 * @dependencias_internas
 *   - `AtelierSecondaryButton` (`../atelier-primitives/AtelierUiPrimitives.tsx`) y las clases de
 *     `apps/web/src/styles/dashboard-docs-cursor-atelier.css`.
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks). Prohibido `next/*`: navegación con `<a href>` y `window.location.assign`.
 * @notas
 *   - Contrato CONGELADO para 2.7/2.8 y el Carril 3; no alterar sin coordinar en el Ledger.
 */

'use client';

import type {
  ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent, ReactElement, ReactNode,
} from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AtelierSecondaryButton } from '../atelier-primitives/AtelierUiPrimitives';
import { Logo } from '../common/Logo';
import { DocsSearchModal } from './DocsSearchModal';

/** Badge compacto de método HTTP / WebSocket con fondo lino y borde piedra. */
export function HttpMethodBadge(props: { readonly method: 'GET' | 'POST' | 'WS' | 'PUT' | 'DELETE' }): ReactElement {
  const methodColor = props.method === 'GET' ? 'var(--color-forest, #34785c)' : props.method === 'POST' ? 'var(--color-amber, #c08532)' : props.method === 'WS' ? 'var(--color-verdant, #1f8a65)' : 'var(--color-ember, #f54e00)';
  return (
    <span
      className="atelier-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        fontSize: '11px',
        fontWeight: 600,
        borderRadius: '3px',
        backgroundColor: 'var(--color-linen, #e6e5e0)',
        border: '1px solid var(--color-stone, #cdcdc9)',
        color: methodColor,
      }}
    >
      {props.method}
    </span>
  );
}

/** Framework seleccionable para los ejemplos de integración del SDK. */
export const DOCS_FRAMEWORKS = [
  { id: 'react-nextjs', label: 'React / Next.js' },
  { id: 'vue3', label: 'Vue 3' },
  { id: 'angular', label: 'Angular' },
  { id: 'vanilla', label: 'Vanilla JS' },
] as const;

/** Identificador válido de framework para los ejemplos de la documentación. */
export type DocsFrameworkId = (typeof DOCS_FRAMEWORKS)[number]['id'];

/**
 * Comprueba si una cadena arbitraria corresponde a un framework soportado.
 * @param candidate - Valor por validar (por ejemplo `initialFrameworkId`).
 * @returns `true` si `candidate` es un `DocsFrameworkId` válido.
 */
function isDocsFrameworkId(candidate: string): candidate is DocsFrameworkId {
  return DOCS_FRAMEWORKS.some((framework) => framework.id === candidate);
}

/** Entrada individual del árbol lateral de documentación. */
export interface DocsNavItem {
  readonly label: string;
  readonly href: string;
  readonly summary: string;
}

/** Sección del árbol lateral que agrupa entradas bajo un título editorial. */
export interface DocsNavSection {
  readonly sectionTitle: string;
  readonly items: readonly DocsNavItem[];
}

/** Árbol congelado de navegación consumido por la barra lateral y el buscador `Cmd+K`. */
export const DOCS_NAV_SECTIONS: readonly DocsNavSection[] = [
  {
    sectionTitle: 'Primeros pasos',
    items: [
      { label: 'Guía de inicio', href: '/docs', summary: 'Instala el SDK e inicializa el asistente en React/Next.js, Vue 3, Angular o Vanilla JS.' },
      { label: 'Selectores data-oa-id', href: '/docs#selectores', summary: 'Marca los elementos de tu interfaz con identificadores inmutables para que el asistente los localice.' },
    ],
  },
  {
    sectionTitle: 'Integración',
    items: [
      { label: 'CLI de la plataforma', href: '/docs#cli', summary: 'Inicia sesión con el código de dispositivo XXXX-XXXX y sincroniza tu proyecto desde la terminal.' },
      { label: 'System Prompt por API', href: '/docs#system-prompt', summary: 'Actualiza el prompt con PUT /api/v1/projects/:projectId/prompt y revisa el sello SHA-256 del mapa.' },
    ],
  },
  {
    sectionTitle: 'Herramientas',
    items: [
      { label: 'Sandbox interactivo', href: '/docs/sandbox', summary: 'Ensaya click_element y type_text sobre una aplicación de prueba con inspector y consola de latencia.' },
      { label: 'Consentimiento de voz', href: '/docs#consentimiento', summary: 'Requisitos de uso aceptable y consentimiento del usuario final antes de activar la voz.' },
    ],
  },
];

/** Entrada aplanada del buscador con su sección de origen. */
export interface DocsSearchEntry extends DocsNavItem {
  readonly sectionTitle: string;
}

/** Índice plano del buscador construido a partir del árbol de navegación. */
const DOCS_SEARCH_INDEX: readonly DocsSearchEntry[] = DOCS_NAV_SECTIONS.flatMap((section) =>
  section.items.map((item) => ({
    sectionTitle: section.sectionTitle, label: item.label, href: item.href, summary: item.summary,
  })),
);

/**
 * Filtra el índice del buscador por etiqueta o resumen, sin distinguir mayúsculas.
 * @param query - Texto escrito por la persona usuaria.
 * @returns Subconjunto del índice que coincide; el índice completo si no hay texto.
 */
function filterDocsSearchEntries(query: string): readonly DocsSearchEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return DOCS_SEARCH_INDEX;
  return DOCS_SEARCH_INDEX.filter(
    (entry) =>
      entry.label.toLowerCase().includes(normalizedQuery) ||
      entry.summary.toLowerCase().includes(normalizedQuery),
  );
}

/** Contrato del contexto de framework expuesto al contenido montado en el shell. */
export interface DocsFrameworkContextValue {
  readonly frameworkId: DocsFrameworkId;
  readonly setFrameworkId: (frameworkId: DocsFrameworkId) => void;
}

const DocsFrameworkContext = createContext<DocsFrameworkContextValue | null>(null);

/**
 * Lee el framework activo y su mutador desde cualquier página montada dentro de
 * `DeveloperDocsShell` (guía de instalación y sandbox de los subagentes 2.7/2.8).
 * @returns Contrato congelado `{ frameworkId, setFrameworkId }` del shell.
 * @throws Error si se invoca fuera del shell de documentación.
 */
export function useDocsFramework(): DocsFrameworkContextValue {
  const contextValue = useContext(DocsFrameworkContext);
  if (contextValue === null) {
    throw new Error('useDocsFramework() requiere estar dentro de DeveloperDocsShell.');
  }
  return contextValue;
}

/** Enlaces centrales de la barra superior de 44px. */
const DOCS_TOP_LINKS: readonly { readonly label: string; readonly href: string }[] = [
  { label: 'Guía de inicio', href: '/docs' },
  { label: 'SDK', href: '/docs#instalacion' },
  { label: 'Sandbox', href: '/docs/sandbox' },
  { label: 'Referencia API', href: '/docs#system-prompt' },
];

/** Propiedades del shell de documentación (contrato congelado). */
export interface DeveloperDocsShellProps {
  readonly currentPath: string;
  readonly children: ReactNode;
  readonly initialFrameworkId?: string;
}



/**
 * Shell de documentación: barra superior de 44px, árbol lateral Bone, lienzo central de
 * 1300px, buscador modal `Cmd+K`/`Ctrl+K` y selector segmentado de framework que publica
 * su selección al contenido a través de `useDocsFramework()`.
 */
export function DeveloperDocsShell(props: DeveloperDocsShellProps): ReactElement {
  const { currentPath, children, initialFrameworkId } = props;

  const [frameworkId, setFrameworkIdState] = useState<DocsFrameworkId>(
    () => (initialFrameworkId !== undefined && isDocsFrameworkId(initialFrameworkId) ? initialFrameworkId : 'react-nextjs'),
  );
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState<boolean>(false);

  const setFrameworkId = useCallback((nextFrameworkId: DocsFrameworkId): void => {
    setFrameworkIdState(nextFrameworkId);
  }, []);
  const openSearch = useCallback((): void => {
    setSearchQuery('');
    setIsSearchOpen(true);
  }, []);
  const closeSearch = useCallback((): void => {
    setIsSearchOpen(false);
    setSearchQuery('');
  }, []);

  useEffect((): (() => void) => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === 'Escape') closeSearch();
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return (): void => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [closeSearch, openSearch]);

  useEffect((): (() => void) => {
    const handleResize = (): void => {
      if (window.innerWidth >= 768) setIsMobileDrawerOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return (): void => window.removeEventListener('resize', handleResize);
  }, []);

  const contextValue = useMemo<DocsFrameworkContextValue>(
    () => ({ frameworkId, setFrameworkId }),
    [frameworkId, setFrameworkId],
  );
  const searchResults = filterDocsSearchEntries(searchQuery);

  const navigationContent = (
    <>
      <p className="atelier-label" style={{ margin: 0 }}>Framework</p>
      <div role="group" aria-label="Selección de framework"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
        {DOCS_FRAMEWORKS.map((framework) => {
          const isSelected = framework.id === frameworkId;
          return (
            <button key={framework.id} type="button" aria-pressed={isSelected}
              className={isSelected ? 'atelier-btn atelier-btn--primary' : 'atelier-btn atelier-btn--secondary'}
              style={{ fontSize: '12px', padding: '4px 10px' }} onClick={(): void => { setFrameworkId(framework.id); setIsMobileDrawerOpen(false); }}>
              {framework.label}
            </button>
          );
        })}
      </div>
      <nav aria-label="Árbol de documentación"
        style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {DOCS_NAV_SECTIONS.map((section) => (
          <div key={section.sectionTitle}>
            <p className="atelier-eyebrow">{section.sectionTitle}</p>
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {section.items.map((item) => {
                const isActive = item.href === currentPath;
                return (
                  <li key={item.href}>
                    <a href={item.href} className={isActive ? 'atelier-window__tab--active' : undefined}
                      onClick={(): void => setIsMobileDrawerOpen(false)}
                      style={{ display: 'block', padding: '6px 10px', fontSize: '13px', lineHeight: 1.4, textDecoration: 'none', borderRadius: 'var(--radius-buttons)', color: isActive ? 'var(--color-ink)' : 'var(--color-driftwood)', ...(isActive ? { boxShadow: 'inset 2px 0 0 var(--color-forest)' } : {}) }}
                      {...(isActive ? { 'aria-current': 'page' as const } : {})}>
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <DocsFrameworkContext.Provider value={contextValue}>
      <div data-portal="workspace-atelier" className="atelier-shell"
        style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 40,
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '0 clamp(14px, 3vw, 24px)',
            borderBottom: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--color-bone, #f2f1ed)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="atelier-btn atelier-btn--ghost md:hidden"
              style={{ padding: '4px 8px', fontSize: '14px' }}
              aria-label="Alternar menú lateral"
              onClick={(): void => setIsMobileDrawerOpen((prev) => !prev)}
            >
              ☰
            </button>
            <Logo size={26} textTheme="dark" href="/" />
            <a href="/docs" style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-ink)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Docs
            </a>
          </div>
          <nav aria-label="Navegación principal de documentación"
            className="hidden md:flex items-center gap-4"
            style={{ alignItems: 'center', gap: '16px' }}>
            {DOCS_TOP_LINKS.map((link) => (
              <a key={link.href} href={link.href}
                style={{ fontSize: '13px', lineHeight: 1.4, whiteSpace: 'nowrap', textDecoration: 'none', color: link.href === currentPath ? 'var(--color-ink)' : 'var(--color-driftwood)' }}>
                {link.label}
              </a>
            ))}
          </nav>
          <AtelierSecondaryButton onClick={openSearch} ariaLabel="Abrir buscador de documentación">
            <span className="atelier-mono">⌘K</span>
          </AtelierSecondaryButton>
        </header>

        {/* Barra estática móvil: selector rápido de framework y acceso al árbol */}
        <div
          className="docs-mobile-subbar md:hidden"
          style={{
            position: 'sticky',
            top: '44px',
            zIndex: 35,
            backgroundColor: 'var(--color-bone, #f2f1ed)',
            borderBottom: '1px solid var(--border-hairline)',
            padding: '6px clamp(12px, 3vw, 20px)',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
            {DOCS_FRAMEWORKS.map((framework) => {
              const isSelected = framework.id === frameworkId;
              return (
                <button
                  key={framework.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={(): void => setFrameworkId(framework.id)}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    fontWeight: isSelected ? 600 : 400,
                    borderRadius: 'var(--radius-buttons)',
                    border: '1px solid',
                    borderColor: isSelected ? 'var(--color-ink)' : 'var(--color-stone)',
                    backgroundColor: isSelected ? 'var(--color-ink)' : 'var(--color-linen)',
                    color: isSelected ? 'var(--color-parchment)' : 'var(--color-ink)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {framework.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="atelier-btn atelier-btn--secondary"
            style={{ padding: '2px 8px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={(): void => setIsMobileDrawerOpen(true)}
            aria-label="Abrir menú de opciones"
          >
            Menú ▾
          </button>
        </div>

        <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
          <aside
            className="hidden md:flex"
            style={{
              position: 'sticky',
              top: '44px',
              height: 'calc(100vh - 44px)',
              width: '220px',
              flex: '0 0 220px',
              flexDirection: 'column',
              backgroundColor: 'var(--color-bone)',
              borderRight: '1px solid var(--color-stone)',
              padding: '16px 14px 32px',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              alignSelf: 'flex-start',
            }}
          >
            {navigationContent}
          </aside>

          {isMobileDrawerOpen ? (
            <div
              className="docs-mobile-drawer md:hidden"
              style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex' }}
              role="dialog"
              aria-modal="true"
            >
              <div
                style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(38,37,30,0.35)' }}
                onClick={(): void => setIsMobileDrawerOpen(false)}
              />
              <div
                style={{
                  position: 'relative',
                  width: '220px',
                  maxWidth: '85vw',
                  height: '100%',
                  backgroundColor: 'var(--color-bone, #f2f1ed)',
                  borderRight: '1px solid var(--color-stone, #cdcdc9)',
                  padding: '16px 14px 32px',
                  overflowY: 'auto',
                  WebkitOverflowScrolling: 'touch',
                  boxShadow: 'var(--shadow-xl)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
                  <button
                    type="button"
                    className="atelier-btn atelier-btn--ghost"
                    onClick={(): void => setIsMobileDrawerOpen(false)}
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                  >
                    ✕ Cerrar
                  </button>
                </div>
                <div className="md:hidden" style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '1px solid var(--color-stone, #cdcdc9)' }}>
                  <p className="atelier-eyebrow" style={{ marginBottom: '8px' }}>Navegación</p>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {DOCS_TOP_LINKS.map((link) => (
                      <li key={link.href}>
                        <a
                          href={link.href}
                          onClick={(): void => setIsMobileDrawerOpen(false)}
                          style={{
                            display: 'block',
                            padding: '6px 10px',
                            fontSize: '13.5px',
                            textDecoration: 'none',
                            borderRadius: 'var(--radius-buttons)',
                            color: link.href === currentPath ? 'var(--color-ink)' : 'var(--color-driftwood)',
                            backgroundColor: link.href === currentPath ? 'var(--color-linen)' : 'transparent',
                          }}
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                {navigationContent}
              </div>
            </div>
          ) : null}

          <main className="atelier-scrollarea" style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ maxWidth: '1300px', margin: '0 auto', padding: 'clamp(20px, 4vw, 40px) clamp(16px, 3vw, 24px) 80px' }}>{children}</div>
          </main>
        </div>
        {isSearchOpen ? (
          <DocsSearchModal entries={searchResults} query={searchQuery} onQueryChange={setSearchQuery} onClose={closeSearch} />
        ) : null}
      </div>
    </DocsFrameworkContext.Provider>
  );
}
