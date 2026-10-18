/**
 * @archivo apps/web/src/components/auth-legal/LegalDocumentViewer.tsx
 * @modulo apps/web (Visor Editorial Legal Público y Modelo Compartido de Documentos Legales)
 * @proposito
 *   Visor cliente de lectura editorial para los instrumentos legales vigentes (ToS B2B,
 *   Privacidad, DPA, AUP de voz y consentimiento de usuario final). Carga el catálogo público
 *   (`GET /api/v1/legal/documents`), localiza el documento por slug, renderiza su Markdown con
 *   tipografía editorial Atelier e índice lateral pegajoso con anclas, y expone versión, fecha
 *   de vigencia y sello SHA-256. Además publica el modelo y el cuerpo renderizador reutilizados
 *   por `MandatoryLegalReconsentModal` (frontera de 4 archivos de la familia auth-legal).
 *
 * @resumen_contenido
 *   - `LegalDocumentCode` + `DOC_SLUG_TO_CODE`: mapa congelado slug público → código legal.
 *   - `LegalDocumentDto`: proyección editorial; `abbreviateSha256()` y `parseLegalDocumentsEnvelope()`.
 *   - `LegalDocumentBody`: cuerpo renderizado (headings con ancla, párrafos y listas).
 *   - `LegalDocumentViewer`: estados de carga, no disponible y error, con reintento anónimo en 401.
 *
 * @dependencias_internas
 *   - `MonoMetadataTag` (`../atelier-primitives/AtelierUiPrimitives`) y clases `.atelier-*` del CSS Atelier.
 *
 * @dependencias_externas
 *   - Solo `react` (tipos y hooks). Prohibido `next/*` y librerías de Markdown.
 *
 * @tablas_bd_o_redis
 *   - Consume `GET /api/v1/legal/documents` (acceso `PUBLIC`; sin credenciales).
 */

'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { MonoMetadataTag } from '../atelier-primitives/AtelierUiPrimitives';

/** Códigos canónicos de los instrumentos legales obligatorios sembrados en el catálogo. */
export type LegalDocumentCode =
  | 'TOS_B2B'
  | 'PRIVACY_POLICY'
  | 'DPA_ENTERPRISE'
  | 'AI_VOICE_AUP'
  | 'END_USER_VOICE_CONSENT';

/** Mapa congelado de slug público → código de documento del catálogo legal. */
export const DOC_SLUG_TO_CODE: Record<string, LegalDocumentCode> = {
  'tos-b2b': 'TOS_B2B',
  'privacy-policy': 'PRIVACY_POLICY',
  'dpa-enterprise': 'DPA_ENTERPRISE',
  'ai-voice-aup': 'AI_VOICE_AUP',
  'end-user-voice-consent': 'END_USER_VOICE_CONSENT',
};

/** Navegación sobria entre instrumentos vigentes para el estado «no disponible». */
const LEGAL_DOCUMENT_NAV_ITEMS: readonly { readonly slug: string; readonly label: string }[] = [
  { slug: 'tos-b2b', label: 'Términos y Condiciones B2B' },
  { slug: 'privacy-policy', label: 'Política de Privacidad' },
  { slug: 'dpa-enterprise', label: 'Acuerdo de Procesamiento de Datos (DPA)' },
  { slug: 'ai-voice-aup', label: 'Política de Uso Aceptable de Voz IA' },
  { slug: 'end-user-voice-consent', label: 'Consentimiento de Voz para Usuario Final' },
];

/** Proyección editorial de un documento legal expuesto por el backend. */
export interface LegalDocumentDto {
  readonly id: string;
  readonly docType: string;
  readonly versionTag: string | null;
  readonly title: string;
  readonly contentMarkdown: string;
  readonly contentSha256: string | null;
  readonly publishedAtIso: string | null;
}

/** Encabezado de sección con ancla para el índice lateral. */
interface LegalDocumentHeading {
  readonly id: string;
  readonly level: number;
  readonly title: string;
}

/** Bloque renderizable del Markdown editorial. */
type LegalDocumentBlock =
  | { readonly kind: 'heading'; readonly heading: LegalDocumentHeading }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'paragraph'; readonly text: string };

/** Fragmento de encabezado del cuerpo del documento para el índice lateral. */
type LegalHeadingBlock = Extract<LegalDocumentBlock, { readonly kind: 'heading' }>;

/** Verifica si un valor JSON es un objeto indexable no nulo. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lee un campo de texto de un objeto JSON; devuelve `null` si no es cadena. */
function readStringField(record: Readonly<Record<string, unknown>>, fieldName: string): string | null {
  const value = record[fieldName];
  return typeof value === 'string' ? value : null;
}

/** Abrevia un hash SHA-256 para etiquetas compactas (12 iniciales + 4 finales). */
export function abbreviateSha256(hash: string): string {
  return hash.length <= 18 ? hash : `${hash.slice(0, 12)}…${hash.slice(-4)}`;
}

/** Parsea un elemento del arreglo `documents` del catálogo legal. */
function parseLegalDocumentItem(rawItem: unknown): LegalDocumentDto | null {
  if (!isRecord(rawItem)) {
    return null;
  }
  const id = readStringField(rawItem, 'id');
  const docType = readStringField(rawItem, 'docType');
  const title = readStringField(rawItem, 'title');
  if (id === null || docType === null || title === null) {
    return null;
  }
  return {
    id,
    docType,
    title,
    versionTag: readStringField(rawItem, 'versionTag'),
    contentMarkdown: readStringField(rawItem, 'contentMarkdown') ?? '',
    contentSha256: readStringField(rawItem, 'contentSha256'),
    publishedAtIso: readStringField(rawItem, 'publishedAt'),
  };
}

/** Parsea el sobre `{ documents: [...] }` del catálogo legal. */
export function parseLegalDocumentsEnvelope(payload: unknown): readonly LegalDocumentDto[] {
  if (!isRecord(payload) || !Array.isArray(payload['documents'])) return [];
  return payload['documents'].map(parseLegalDocumentItem).filter((item): item is LegalDocumentDto => item !== null);
}

/** Descarga el catálogo vigente; ante 401 reintenta sin credenciales de sesión. */
async function requestActiveLegalDocuments(): Promise<readonly LegalDocumentDto[]> {
  const init: RequestInit = { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' };
  let response = await fetch('/api/v1/legal/documents', init);
  if (response.status === 401) {
    response = await fetch('/api/v1/legal/documents', { ...init, credentials: 'omit' });
  }
  if (!response.ok) throw new Error(`El catálogo legal respondió con estado ${response.status}.`);
  return parseLegalDocumentsEnvelope(await response.json());
}

/** Genera un ancla legible y única para un título de sección. */
function slugifyLegalHeading(title: string, usedIds: readonly string[]): string {
  const baseSlug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fallbackSlug = baseSlug.length > 0 ? baseSlug : 'seccion';
  if (!usedIds.includes(fallbackSlug)) {
    return fallbackSlug;
  }
  let suffix = 2;
  while (usedIds.includes(`${fallbackSlug}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${fallbackSlug}-${String(suffix)}`;
}

/**
 * Fragmenta el Markdown/texto en bloques editoriales: encabezados `#` (con ancla única),
 * párrafos (líneas consecutivas agrupadas) y listas `-`/`*`.
 */
function parseLegalDocumentBlocks(markdown: string): readonly LegalDocumentBlock[] {
  const blocks: LegalDocumentBlock[] = [];
  const usedIds: string[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') });
      paragraphLines = [];
    }
  };
  const flushList = (): void => {
    if (listItems.length > 0) {
      blocks.push({ kind: 'list', items: listItems });
      listItems = [];
    }
  };
  const flushPending = (): void => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushPending();
      continue;
    }
    if (line.startsWith('#')) {
      flushPending();
      const headingMatch = /^(#+)\s*(.*)$/.exec(line);
      if (headingMatch !== null) {
        const hashes = headingMatch[1] ?? '';
        const headingTitle = (headingMatch[2] ?? '').trim();
        if (headingTitle.length > 0) {
          const headingId = slugifyLegalHeading(headingTitle, usedIds);
          usedIds.push(headingId);
          const heading: LegalDocumentHeading = {
            id: headingId,
            level: Math.min(hashes.length, 3),
            title: headingTitle,
          };
          blocks.push({ kind: 'heading', heading });
        }
      }
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushParagraph();
      listItems.push(line.slice(2).trim());
      continue;
    }
    flushList();
    paragraphLines.push(line);
  }
  flushPending();
  return blocks;
}

function renderLegalDocumentBlock(block: LegalDocumentBlock, blockIndex: number): ReactElement {
  if (block.kind === 'heading') {
    const headingFontSize = block.heading.level <= 1 ? '20px' : block.heading.level === 2 ? '17px' : '15px';
    return (
      <h2
        key={block.heading.id}
        id={block.heading.id}
        className="atelier-heading-sm"
        style={{ fontSize: headingFontSize, fontWeight: 400, color: 'var(--color-ink, #26251e)', scrollMarginTop: '24px' }}
      >
        {block.heading.title}
      </h2>
    );
  }
  if (block.kind === 'list') {
    return (
      <ul key={`list-${String(blockIndex)}`} style={{ margin: 0, paddingLeft: '20px', fontSize: '15px', lineHeight: 1.5, fontWeight: 400, color: 'var(--color-ink, #26251e)' }}>
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <p key={`paragraph-${String(blockIndex)}`} style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, fontWeight: 400, color: 'var(--color-ink, #26251e)' }}>
      {block.text}
    </p>
  );
}

/** Cuerpo editorial del documento: prosa EB Garamond con encabezados anclados y listas. */
export function LegalDocumentBody(props: { readonly markdown: string }): ReactElement {
  const blocks = parseLegalDocumentBlocks(props.markdown);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {blocks.map((block, blockIndex) => renderLegalDocumentBlock(block, blockIndex))}
    </div>
  );
}

/**
 * Visor editorial público de un documento legal vigente, localizado por `docSlug`.
 */
export function LegalDocumentViewer(props: { readonly docSlug: string }): ReactElement {
  const [documents, setDocuments] = useState<readonly LegalDocumentDto[] | null>(null);
  const [hasLoadFailed, setHasLoadFailed] = useState<boolean>(false);

  // Carga única del catálogo público al montar; la navegación entre slugs reutiliza el caché.
  useEffect(() => {
    let isCancelled = false;
    void requestActiveLegalDocuments()
      .then((loadedDocuments) => {
        if (!isCancelled) {
          setDocuments(loadedDocuments);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setDocuments([]);
          setHasLoadFailed(true);
        }
      });
    return (): void => {
      isCancelled = true;
    };
  }, []);

  const requestedCode: LegalDocumentCode | null = DOC_SLUG_TO_CODE[props.docSlug] ?? null;
  const activeDocument = documents === null || requestedCode === null
    ? null
    : (documents.find((item) => item.docType === requestedCode) ?? null);

  if (documents === null) {
    return (
      <section className="atelier-card" style={{ maxWidth: '720px', margin: '0 auto' }}>
        <p className="atelier-eyebrow" style={{ margin: 0 }}>Documento legal</p>
        <p className="atelier-help-text" style={{ margin: '8px 0 0' }}>Cargando documento legal vigente…</p>
      </section>
    );
  }

  if (activeDocument === null) {
    return (
      <section
        className="atelier-card"
        style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        <p className="atelier-eyebrow" style={{ margin: 0 }}>Documento no disponible</p>
        <h1 className="atelier-heading-lg" style={{ fontSize: '26px' }}>
          {hasLoadFailed
            ? 'No fue posible cargar el catálogo legal'
            : 'Este documento no está publicado en el catálogo vigente'}
        </h1>
        <p className="atelier-prose" style={{ margin: 0 }}>
          {hasLoadFailed
            ? 'Intenta de nuevo en unos momentos.'
            : `La ruta «${props.docSlug}» no corresponde a un instrumento legal vigente.`}
        </p>
        <div>
          <p className="atelier-help-text" style={{ margin: 0 }}>Otros documentos legales vigentes:</p>
          <ul style={{ margin: '8px 0 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {LEGAL_DOCUMENT_NAV_ITEMS.filter((item) => item.slug !== props.docSlug).map((item) => (
              <li key={item.slug}>
                <a className="atelier-link" href={`/legal/${item.slug}`}>{item.label}</a>
              </li>
            ))}
          </ul>
        </div>
        <p className="atelier-help-text" style={{ margin: 0 }}>
          Para consultar versiones anteriores contacta a soporte.
        </p>
      </section>
    );
  }

  const parsedBlocks = parseLegalDocumentBlocks(activeDocument.contentMarkdown);
  const sectionHeadings: readonly LegalDocumentHeading[] = parsedBlocks
    .filter((block): block is LegalHeadingBlock => block.kind === 'heading')
    .map((block) => block.heading);
  const publishedAtLabel = activeDocument.publishedAtIso === null
    ? null
    : activeDocument.publishedAtIso.slice(0, 10);

  return (
    <div
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '24px',
        alignItems: 'flex-start',
        padding: 'clamp(14px, 3vw, 24px)',
        backgroundColor: 'var(--color-parchment, #f7f7f4)',
      }}
    >
      <aside
        aria-label="Índice del documento"
        style={{
          position: 'sticky',
          top: '20px',
          width: '100%',
          maxWidth: '260px',
          flex: '1 1 240px',
          backgroundColor: 'var(--color-bone, #f2f1ed)',
          border: '1px solid var(--color-stone, #cdcdc9)',
          borderRadius: '4px',
          padding: '14px',
        }}
      >
        <details open style={{ cursor: 'pointer' }}>
          <summary style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="atelier-eyebrow" style={{ margin: 0 }}>Índice ({sectionHeadings.length})</span>
            <span style={{ fontSize: '11px', color: 'var(--color-driftwood, #84847e)' }}>▼</span>
          </summary>
          {sectionHeadings.length === 0 ? (
            <p className="atelier-help-text" style={{ margin: '8px 0 0' }}>
              Este documento no contiene secciones con ancla.
            </p>
          ) : (
            <nav
              aria-label="Secciones del documento"
              className="atelier-scrollarea"
              style={{
                marginTop: '10px',
                maxHeight: '240px',
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              {sectionHeadings.map((heading) => (
                <a
                  key={heading.id}
                  className="atelier-link"
                  href={`#${heading.id}`}
                  style={{ fontSize: '13px', paddingLeft: heading.level > 1 ? '10px' : 0 }}
                >
                  {heading.title}
                </a>
              ))}
            </nav>
          )}
        </details>
        <hr className="atelier-divider" style={{ margin: '12px 0' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {activeDocument.versionTag === null ? null : (
            <MonoMetadataTag label="Versión" value={activeDocument.versionTag} />
          )}
          {publishedAtLabel === null ? null : <MonoMetadataTag label="Vigente desde" value={publishedAtLabel} />}
          {activeDocument.contentSha256 === null ? null : (
            <MonoMetadataTag label="SHA-256" value={abbreviateSha256(activeDocument.contentSha256)} tone="accent" />
          )}
        </div>
      </aside>

      <main style={{ flex: '1 1 500px', minWidth: '280px' }}>
        <article style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <header
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              borderBottom: '1px solid var(--color-stone, #cdcdc9)',
              paddingBottom: '16px',
            }}
          >
            <p className="atelier-eyebrow" style={{ margin: 0 }}>Documento legal vigente</p>
            <h1 className="atelier-heading-lg">{activeDocument.title}</h1>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              {activeDocument.versionTag === null ? null : (
                <span className="atelier-mono" style={{ color: 'var(--color-driftwood, #84847e)' }}>
                  {activeDocument.versionTag}
                </span>
              )}
              {publishedAtLabel === null ? null : (
                <span className="atelier-mono" style={{ color: 'var(--color-driftwood, #84847e)' }}>
                  Vigente desde {publishedAtLabel}
                </span>
              )}
              {activeDocument.contentSha256 === null ? null : (
                <MonoMetadataTag label="SHA-256" value={abbreviateSha256(activeDocument.contentSha256)} tone="accent" />
              )}
            </div>
            {activeDocument.contentSha256 === null ? null : (
              <p
                className="atelier-mono"
                style={{ margin: 0, color: 'var(--color-driftwood, #84847e)', overflowWrap: 'anywhere' }}
              >
                {activeDocument.contentSha256}
              </p>
            )}
          </header>

          {parsedBlocks.length === 0 ? (
            <p className="atelier-help-text" style={{ margin: 0 }}>
              El contenido de este documento aún no está disponible para lectura pública.
            </p>
          ) : (
            <LegalDocumentBody markdown={activeDocument.contentMarkdown} />
          )}

          <hr className="atelier-divider" />
          <p className="atelier-help-text" style={{ margin: 0 }}>
            Para consultar versiones anteriores contacta a soporte.
          </p>
        </article>
      </main>
    </div>
  );
}
