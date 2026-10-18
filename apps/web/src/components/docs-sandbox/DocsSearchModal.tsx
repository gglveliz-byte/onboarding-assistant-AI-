/**
 * @archivo apps/web/src/components/docs-sandbox/DocsSearchModal.tsx
 * @modulo 08. Frontend Compartido — Documentación y Sandbox (División 2 / Subagente 2.6)
 * @proposito
 *   Modal de búsqueda de documentación (Cmd+K) con filtro por etiqueta y resumen.
 */

'use client';

import type {
  ChangeEvent, KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent, ReactElement,
} from 'react';
import { useCallback } from 'react';
import { AtelierSecondaryButton } from '../atelier-primitives/AtelierUiPrimitives';
import type { DocsSearchEntry } from './DeveloperDocsShell';

/** Propiedades del modal de búsqueda. */
export interface DocsSearchModalProps {
  readonly entries: readonly DocsSearchEntry[];
  readonly query: string;
  readonly onQueryChange: (nextQuery: string) => void;
  readonly onClose: () => void;
}

/**
 * Overlay modal (radio 8px) con input de búsqueda y lista filtrada del árbol:
 * `Enter` navega al primer resultado y un clic fuera del panel lo cierra.
 */
export function DocsSearchModal(props: DocsSearchModalProps): ReactElement {
  const { entries, query, onQueryChange, onClose } = props;

  const handleOverlayClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => onQueryChange(event.target.value), [onQueryChange],
  );

  const handleQueryKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const firstEntry = entries[0];
    if (event.key !== 'Enter' || firstEntry === undefined) return;
    onClose();
    window.location.assign(firstEntry.href);
  }, [entries, onClose]);

  return (
    <div className="atelier-modal-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="atelier-modal" role="dialog" aria-modal="true" aria-label="Buscador de documentación">
        <h2 className="atelier-modal__title">Buscar en la documentación</h2>
        <div className="atelier-modal__body">
          <input className="atelier-input" type="search" autoFocus value={query} onChange={handleQueryChange}
            onKeyDown={handleQueryKeyDown} placeholder="Busca guías, selectores o endpoints…" aria-label="Texto de búsqueda" />
          <div className="atelier-scrollarea" style={{ marginTop: '12px', maxHeight: '280px' }}>
            {entries.length === 0 ? (
              <p className="atelier-help-text" style={{ margin: 0 }}>Sin resultados para «{query}».</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {entries.map((entry, index) => (
                  <li key={entry.href}>
                    <a href={entry.href} onClick={onClose} style={{ display: 'block', padding: '10px 12px', textDecoration: 'none', border: '1px solid var(--color-stone)', borderRadius: 'var(--radius-tiles)', backgroundColor: index === 0 ? 'var(--color-linen)' : 'var(--color-bone)' }}>
                      <span style={{ display: 'block', fontSize: '13.5px', color: 'var(--color-ink)' }}>{entry.label}</span>
                      <span className="atelier-mono" style={{ display: 'block', marginTop: '2px', color: 'var(--color-driftwood)' }}>{entry.href}</span>
                      <span style={{ display: 'block', marginTop: '4px', fontSize: '12.5px', lineHeight: 1.45, color: 'var(--color-driftwood)' }}>{entry.summary}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="atelier-modal__actions">
          <AtelierSecondaryButton onClick={onClose}>Cerrar</AtelierSecondaryButton>
        </div>
      </div>
    </div>
  );
}
