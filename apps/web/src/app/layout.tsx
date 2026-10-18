/**
 * @archivo apps/web/src/app/layout.tsx
 * @modulo apps/web/src/app (raiz del App Router del frontend web)
 * @proposito
 *   Define el layout raiz compartido por todas las divisiones del frontend: declara los metadatos
 *   comerciales de la marca, el viewport del dispositivo y la estructura `html`/`body` en espanol
 *   sobre la que se anidan los layouts de cada portal (comercial, autenticacion y paneles).
 *
 * @resumen_contenido
 *   - `metadata`: titulo por defecto, plantilla de titulos y descripcion comercial sin tecnicismos.
 *   - `viewport`: ancho de dispositivo, escala inicial y color de tema alineado al lienzo claro.
 *   - `RootLayout`: componente servidor que envuelve el arbol de paginas de todos los portales.
 *
 * @dependencias_internas
 *   - `./globals.css` (hoja global de Tailwind y tokens Auros Light).
 *
 * @dependencias_externas
 *   - `next` (tipos `Metadata` y `Viewport`).
 *   - `react` (tipo `ReactNode`).
 *
 * @tablas_bd_o_redis
 *   - Ninguna (cascaron de presentacion: no accede a datos).
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/** Metadatos comerciales compartidos por todo el frente web. */
export const metadata: Metadata = {
  title: {
    default: 'Onboarding Assistant — Asistente de voz que guía y opera tu producto',
    template: '%s · Onboarding Assistant',
  },
  description:
    'Convierte tu software en una experiencia autónoma: un asistente de voz en tiempo real que comprende tu interfaz, guía a tus usuarios paso a paso y ejecuta acciones en pantalla.',
};

/** Viewport global: escala inicial y color de la barra del navegador sobre el lienzo claro. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f2fbf9',
};

/**
 * Estructura raiz del documento: fija el idioma espanol y monta el arbol completo de portales.
 *
 * @param props - Propiedades del layout raiz.
 * @returns Documento HTML con el contenido de la pagina activa.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
