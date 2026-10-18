/**
 * @archivo apps/web/src/components/rag-editor/CanonicalJsonCodeEditor.tsx
 * @modulo 08-frontend-rag-editor (Panel Derecho: Editor de Código JSON Canónico RFC 8785)
 * @proposito
 *   Renderiza el 50% derecho del editor dual. Provee un editor de código monospaciado
 *   en `berkeleyMono 12px` con numeración de líneas tabular, formateador determinista
 *   RFC 8785 y detección inmediata de inconsistencias sintácticas o identificadores duplicados.
 *
 * @resumen_contenido
 *   - Área de texto monospaciada con numeración de líneas sincronizada.
 *   - Alerta visual ante errores de parseo JSON (`syntaxError`) en color Crimson #cf2d56.
 *   - Botón de formateo rápido JSON / RFC 8785.
 *   - Botón de copiado de especificación canónica al portapapeles.
 *
 * @dependencias_internas
 *   - Ninguna (Editor de texto reactivo puro).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps.canonical_json`.
 */

'use client';

import React, { useState, useRef } from 'react';

export interface CanonicalJsonCodeEditorProps {
  readonly jsonCode: string;
  readonly syntaxError: string | null;
  readonly onChangeJson: (rawCode: string) => void;
  readonly onFormatJson: () => void;
}

export function CanonicalJsonCodeEditor({
  jsonCode,
  syntaxError,
  onChangeJson,
  onFormatJson,
}: CanonicalJsonCodeEditorProps) {
  const [copied, setCopied] = useState(false);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = jsonCode.split('\n');
  const lineCount = Math.max(lines.length, 1);

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div
      className="h-full flex flex-col bg-[#f7f7f4] overflow-hidden select-none"
      data-testid="canonical-json-code-editor"
    >
      {/* Barra Superior de Herramientas del Editor de Código */}
      <div className="p-4 bg-[#f2f1ed] border-b border-[#cdcdc9] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-sans uppercase tracking-wider text-[#84847e]">
            JSON Canónico (RFC 8785)
          </span>
          <span
            className="text-[11px] font-mono text-[#84847e] bg-[#e6e5e0] px-2 py-0.5 rounded"
            style={{ borderRadius: '3px', fontVariantNumeric: 'tabular-nums' }}
          >
            {lineCount} líneas
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onFormatJson}
            className="px-2.5 py-1 text-xs font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors"
            style={{ borderRadius: '4px' }}
          >
            Formatear
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="px-2.5 py-1 text-xs font-sans bg-[#e6e5e0] text-[#26251e] hover:bg-[#cdcdc9] rounded border border-[#cdcdc9] transition-colors"
            style={{ borderRadius: '4px' }}
          >
            {copied ? '✓ Copiado' : 'Copiar'}
          </button>
        </div>
      </div>

      {/* Alerta de Error de Sintaxis o Esquema */}
      {syntaxError && (
        <div
          className="p-3 bg-[#cf2d56]/10 border-b border-[#cf2d56]/30 text-xs font-mono text-[#cf2d56] flex items-center gap-2 flex-shrink-0"
          data-testid="json-syntax-error-banner"
        >
          <span>✕</span>
          <span className="truncate">{syntaxError}</span>
        </div>
      )}

      {/* Cuerpo del Editor: Numeración de Líneas y Textarea */}
      <div className="flex-1 flex overflow-hidden bg-[#f7f7f4]">
        {/* Numeración de Líneas Tabular */}
        <div
          ref={gutterRef}
          className="w-12 py-3 bg-[#f2f1ed]/60 border-r border-[#cdcdc9] text-right pr-2 text-[11px] font-mono text-[#a1a19f] select-none overflow-hidden"
          style={{ fontVariantNumeric: 'tabular-nums', lineHeight: '20px' }}
        >
          {Array.from({ length: lineCount }).map((_, idx) => (
            <div key={idx + 1}>{idx + 1}</div>
          ))}
        </div>

        {/* Textarea Monospaciado */}
        <textarea
          value={jsonCode}
          onChange={(e) => onChangeJson(e.target.value)}
          onScroll={handleScroll}
          wrap="off"
          spellCheck={false}
          className="flex-1 p-3 text-[12px] font-mono bg-[#f7f7f4] text-[#26251e] focus:outline-none resize-none leading-[20px] overflow-auto select-text whitespace-pre"
          style={{
            fontFamily: "'berkeleyMono', monospace",
            tabSize: 2,
            whiteSpace: 'pre',
          }}
          placeholder="[ { id: '...', title: '...' } ]"
        />
      </div>
    </div>
  );
}
