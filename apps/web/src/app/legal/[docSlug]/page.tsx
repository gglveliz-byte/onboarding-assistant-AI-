/**
 * @archivo apps/web/src/app/legal/[docSlug]/page.tsx
 * @modulo apps/web (Rutas Públicas de Documentación Legal)
 * @proposito
 *   Página pública de lectura de un instrumento legal vigente. Componente de servidor sin
 *   directiva que recibe `params` del App Router y delega todo el render editorial al visor
 *   cliente `LegalDocumentViewer` (así se evita cualquier dependencia de `next/navigation`).
 *
 * @resumen_contenido
 *   - `LegalDocumentPage`: contenedor `.atelier-shell` que monta el visor por `docSlug`.
 *
 * @dependencias_internas
 *   - `LegalDocumentViewer` (`../../../components/auth-legal/LegalDocumentViewer`).
 *   - Clases `.atelier-*` de `apps/web/src/styles/dashboard-docs-cursor-atelier.css`
 *     (importadas por `../layout.tsx`).
 *
 * @dependencias_externas
 *   - Solo `react` (tipo `ReactElement`). Prohibido importar `next/*`.
 *
 * @tablas_bd_o_redis
 *   - Ninguna directa: el visor cliente consume `GET /api/v1/legal/documents` (público).
 */

import type { ReactElement } from 'react';
import { LegalDocumentViewer } from '../../../components/auth-legal/LegalDocumentViewer';

/**
 * Página pública `/legal/[docSlug]`: monta el visor editorial del documento solicitado.
 *
 * @param props - Propiedades de la ruta con el slug del documento legal.
 * @returns Contenedor Atelier con el visor cliente del documento legal.
 */
export default function LegalDocumentPage(props: {
  readonly params: { readonly docSlug: string };
}): ReactElement {
  return (
    <div className="atelier-shell" style={{ minHeight: '100vh', padding: '32px 24px' }}>
      <LegalDocumentViewer docSlug={props.params.docSlug} />
    </div>
  );
}
