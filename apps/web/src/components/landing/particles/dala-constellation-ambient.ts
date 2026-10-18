/**
 * @archivo apps/web/src/components/landing/particles/dala-constellation-ambient.ts
 * @modulo apps/web/src/components/landing/particles (Constelación Dala de fondo — glifos ambientales)
 * @proposito
 *   Pintor de los glifos ambientales flotantes del fondo vivo de constelación: microtriángulos
 *   wireframe de polvo estelar con deriva vertical envolvente, oscilación horizontal suave y
 *   rotación propia, proyectados en perspectiva sobre el mismo lienzo claro (#f2fbf9) que las
 *   tres esculturas. Módulo independiente para mantener el compositor principal bajo el tope
 *   de líneas del proyecto.
 *
 * @resumen_contenido
 *   - `drawAmbientGlyphs(ctx, glyphs, ...)`: dibuja la colección completa de glifos; los muta
 *     (avanzan su rotación propia) y descarta los que salen del viewport.
 *
 * @dependencias_internas
 *   - `./dala-constellation-geometry` (tipo `BackdropGlyph`).
 *
 * @dependencias_externas
 *   - Ninguna.
 *
 * @tablas_bd_o_redis
 *   - Ninguna (capa de presentación pura: no accede a datos).
 */

import type { BackdropGlyph } from './dala-constellation-geometry';

/** Deriva vertical del polvo estelar (unidades/segundo) y periodo envolvente del campo. */
const GLYPH_DRIFT_SPEED = 12;
const GLYPH_FIELD_PERIOD = 1200;

/** Glifos ambientales flotantes: polvo estelar con deriva vertical y rotación propia. */
export function drawAmbientGlyphs(
  ctx: CanvasRenderingContext2D,
  glyphs: readonly BackdropGlyph[],
  width: number,
  height: number,
  time: number,
  cx: number,
  cy: number,
  fov: number,
  baseScale: number
): void {
  for (let j = 0; j < glyphs.length; j += 1) {
    const glyph = glyphs[j];
    if (glyph === undefined) {
      continue;
    }
    const glyphDy =
      ((glyph.y - time * GLYPH_DRIFT_SPEED * glyph.speed + GLYPH_FIELD_PERIOD * 0.5) % GLYPH_FIELD_PERIOD) -
      GLYPH_FIELD_PERIOD * 0.5;
    const glyphDx = glyph.x + Math.sin(time * 0.5 + glyph.phase) * 28;

    const glyphScale = fov / (fov + glyph.z + 400);
    const glyphSx = cx + glyphDx * glyphScale;
    const glyphSy = cy + glyphDy * glyphScale;

    if (glyphSx < -40 || glyphSx > width + 40 || glyphSy < -40 || glyphSy > height + 40) {
      continue;
    }

    glyph.rotZ += glyph.vRot;
    glyph.rotX += glyph.vRot * 0.8;

    const r = glyph.size * glyphScale * baseScale;
    const squash = 0.45 + 0.55 * Math.abs(Math.cos(glyph.rotX));
    const gCos = Math.cos(glyph.rotZ);
    const gSin = Math.sin(glyph.rotZ);
    const gY0 = -r;
    const gX1 = 0.866 * r;
    const gY1 = 0.5 * r * squash;
    const gX2 = -0.866 * r;
    const gY2 = 0.5 * r * squash;

    ctx.beginPath();
    ctx.moveTo(glyphSx - gY0 * gSin, glyphSy + gY0 * gCos);
    ctx.lineTo(glyphSx + gX1 * gCos - gY1 * gSin, glyphSy + gX1 * gSin + gY1 * gCos);
    ctx.lineTo(glyphSx + gX2 * gCos - gY2 * gSin, glyphSy + gX2 * gSin + gY2 * gCos);
    ctx.closePath();
    ctx.strokeStyle = glyph.color;
    ctx.globalAlpha = glyph.alpha;
    ctx.lineWidth = glyph.strokeWidth;
    ctx.stroke();
  }
}
