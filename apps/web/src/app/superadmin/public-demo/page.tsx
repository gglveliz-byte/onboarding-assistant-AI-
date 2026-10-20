/**
 * @archivo apps/web/src/app/superadmin/public-demo/page.tsx
 * @modulo apps/web (Rutas de Consola SuperAdmin)
 * @proposito
 *   Vista de gobierno de la DEMOSTRACIÓN PÚBLICA de la landing: fija la duración máxima por demo y el
 *   límite de demos por IP/día (sustituye el hardcodeo 90 s / 2). Renderiza `PublicDemoConfigPanel`
 *   dentro del `SuperAdminControlShell`.
 *
 * @resumen_contenido
 *   - `SuperAdminPublicDemoConfigPage`: envoltura del shell + panel de configuración.
 *
 * @dependencias_internas
 *   - `SuperAdminControlShell`, `PublicDemoConfigPanel` (`@/components/superadmin/...`).
 *
 * @dependencias_externas
 *   - `react` (`ReactElement`).
 *
 * @tablas_bd_o_redis
 *   - Consume `GET`/`PUT /api/v1/superadmin/public-demo-config` (Redis `oa:demo:config`).
 */

'use client';

import type { ReactElement } from 'react';
import { SuperAdminControlShell } from '../../../components/superadmin/SuperAdminControlShell';
import { PublicDemoConfigPanel } from '../../../components/superadmin/PublicDemoConfigPanel';

/** Página de configuración gobernable de la demostración pública. */
export default function SuperAdminPublicDemoConfigPage(): ReactElement {
  return (
    <SuperAdminControlShell currentPath="/superadmin/public-demo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <header style={{ borderBottom: '1px solid var(--color-stone, #cdcdc9)', paddingBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontFamily: 'var(--font-berkeleymono, monospace)', color: 'var(--color-driftwood, #84847e)', textTransform: 'uppercase', marginBottom: '4px' }}>
            GOBIERNO / PLANO PÚBLICO
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 400, margin: '0 0 6px', letterSpacing: '-0.015em' }}>
            Parámetros de la Demostración Pública
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-driftwood, #84847e)' }}>
            Ajusta cuánto dura cada demo de la landing y cuántas permite por IP al día. Se aplica a las
            siguientes sesiones; las demostraciones ya iniciadas conservan su ventana original.
          </p>
        </header>
        <PublicDemoConfigPanel />
      </div>
    </SuperAdminControlShell>
  );
}
