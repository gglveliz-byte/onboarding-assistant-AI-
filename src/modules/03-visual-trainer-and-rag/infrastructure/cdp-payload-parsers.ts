/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/cdp-payload-parsers.ts
 * @modulo 03-visual-trainer-and-rag (Validadores de Respuestas del Protocolo de Desarrollo)
 * @proposito
 *   Normaliza y valida todo lo que devuelve el navegador remoto a traves del Protocolo de
 *   Herramientas de Desarrollo (CDP). El navegador es un proceso externo y su respuesta llega como
 *   `unknown`: sin esta capa, un cambio de version del motor o una extension maliciosa podria
 *   inyectar formas inesperadas que rompieran los casos de uso con `undefined`. Cada funcion
 *   descarta lo invalido y aplica valores por omision seguros, de modo que el agente instrumentador
 *   trabaje siempre con datos tipados y verificados.
 *
 * @resumen_contenido
 *   - Interface `ElementBoundingBox`: Caja geometrica normalizada de un elemento.
 *   - Interface `MappedElementDescriptor`: Elemento etiquetable con su cascada de selectores.
 *   - Interface `CapturedRoute`: Descripcion de la ruta activa del documento.
 *   - Clase `CdpPayloadParser`: Metodos estaticos de validacion y normalizacion.
 *
 * @dependencias_internas
 *   - Ninguna (Validadores puros: no dependen del cliente CDP ni del agente).
 *
 * @dependencias_externas
 *   - Ninguna (Analisis defensivo con tipos nativos de TypeScript).
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `map_elements` (Los descriptores normalizados alimentan sus columnas).
 */

/** Caja geometrica normalizada de un elemento, relativa a la pagina completa. */
export interface ElementBoundingBox {
  /** Coordenada horizontal absoluta del borde izquierdo. */
  readonly x: number;
  /** Coordenada vertical absoluta del borde superior. */
  readonly y: number;
  /** Ancho en pixeles. */
  readonly width: number;
  /** Alto en pixeles. */
  readonly height: number;
  /** Ancho del viewport en el que se midio. */
  readonly viewportWidth: number;
  /** Alto del viewport en el que se midio. */
  readonly viewportHeight: number;
}

/** Elemento etiquetable con su cascada completa de selectores y su caja geometrica. */
export interface MappedElementDescriptor {
  /** Clave estable del elemento dentro de la sesion (`el_<base36>_<tag>`). */
  readonly elementKey: string;
  /** Nombre de la etiqueta HTML en minusculas. */
  readonly tagName: string;
  /** Selector estable principal usado para la ejecucion fisica. */
  readonly primarySelector: string;
  /** Selector por rol y nombre accesible, o `null` si no es deducible. */
  readonly accessibilitySelector: string | null;
  /** Selector estructural CSS sin hashes dinamicos. */
  readonly structuralCssSelector: string;
  /** XPath de respaldo con indice posicional. */
  readonly xpathFallback: string;
  /** Puntaje de estabilidad del selector, de 0 a 100. */
  readonly selectorStabilityScore: number;
  /** Accion fisica probable del elemento. */
  readonly actionType: 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';
  /** Descripcion funcional legible extraida del elemento. */
  readonly functionalDescription: string;
  /** Caja geometrica en el viewport activo al momento de la recoleccion. */
  readonly bbox: ElementBoundingBox;
  /** Metadatos adicionales del elemento, sin datos sensibles. */
  readonly elementMetadata: Readonly<Record<string, unknown>>;
}

/** Descripcion de la ruta activa al momento de la recoleccion. */
export interface CapturedRoute {
  /** Ruta normalizada de la pagina. */
  readonly path: string;
  /** Titulo del documento. */
  readonly title: string;
  /** Estado de carga del documento. */
  readonly readyState: string;
}

/** Acciones fisicas reconocidas por el mapa funcional. */
export type ElementActionType = 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';

/**
 * Validador y normalizador de las respuestas del navegador remoto.
 * Todos los metodos son estaticos y puros: no mantienen estado y pueden probarse aisladamente.
 */
export class CdpPayloadParser {
  /**
   * Convierte un valor desconocido en un registro indexable.
   *
   * @param candidate - Valor a inspeccionar.
   * @returns Registro indexable, o `null` si el valor no es un objeto simple.
   */
  public static asRecord(candidate: unknown): Record<string, unknown> | null {
    return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  }

  /**
   * Convierte un valor desconocido en numero finito.
   *
   * @param candidate - Valor a inspeccionar.
   * @returns Numero finito, o `null` si no es convertible.
   */
  public static asNumber(candidate: unknown): number | null {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * Extrae un campo de texto no vacio de un valor devuelto por el navegador.
   *
   * @param candidate - Valor a inspeccionar.
   * @param fieldName - Nombre del campo buscado.
   * @returns Texto encontrado, o `null` si el campo no existe o no es una cadena util.
   */
  public static extractStringField(candidate: unknown, fieldName: string): string | null {
    const value = CdpPayloadParser.asRecord(candidate)?.[fieldName];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Interpreta y normaliza una caja geometrica devuelta por la pagina.
   *
   * @param candidate - Valor crudo de la caja.
   * @returns Caja normalizada con ceros en los campos ausentes.
   */
  public static parseBoundingBox(candidate: unknown): ElementBoundingBox {
    const record = CdpPayloadParser.asRecord(candidate);
    return {
      x: CdpPayloadParser.asNumber(record?.['x']) ?? 0,
      y: CdpPayloadParser.asNumber(record?.['y']) ?? 0,
      width: CdpPayloadParser.asNumber(record?.['width']) ?? 0,
      height: CdpPayloadParser.asNumber(record?.['height']) ?? 0,
      viewportWidth: CdpPayloadParser.asNumber(record?.['viewportWidth']) ?? 0,
      viewportHeight: CdpPayloadParser.asNumber(record?.['viewportHeight']) ?? 0,
    };
  }

  /**
   * Interpreta y normaliza la ruta activa devuelta por la pagina.
   *
   * @param candidate - Valor crudo de la ruta.
   * @returns Ruta normalizada con valores por omision seguros.
   */
  public static parseRoute(candidate: unknown): CapturedRoute {
    const record = CdpPayloadParser.asRecord(candidate);
    return {
      path: typeof record?.['path'] === 'string' ? (record['path'] as string) : '/',
      title: typeof record?.['title'] === 'string' ? (record['title'] as string) : '',
      readyState: typeof record?.['readyState'] === 'string' ? (record['readyState'] as string) : 'unknown',
    };
  }

  /**
   * Normaliza el tipo de accion devuelto por el agente inyectado.
   *
   * @param candidate - Valor crudo del tipo de accion.
   * @returns Accion reconocida, o `NONE` cuando el valor no es valido.
   */
  public static parseActionType(candidate: unknown): ElementActionType {
    return candidate === 'CLICK' || candidate === 'TYPE' || candidate === 'BOTH' ? candidate : 'NONE';
  }

  /**
   * Valida y normaliza la lista de elementos devuelta por la pagina.
   * Los elementos que no declaran clave ni selector principal se descartan: sin ellos el elemento
   * no podria ejecutarse despues y persistirlo solo generaria ruido en el mapa funcional.
   *
   * @param candidate - Valor crudo de la lista de elementos.
   * @returns Descriptores validos en el mismo orden en que llegaron.
   */
  public static parseElements(candidate: unknown): readonly MappedElementDescriptor[] {
    if (!Array.isArray(candidate)) {
      return [];
    }

    const descriptors: MappedElementDescriptor[] = [];
    for (const rawElement of candidate) {
      const record = CdpPayloadParser.asRecord(rawElement);
      if (record === null) {
        continue;
      }

      const elementKey = typeof record['elementKey'] === 'string' ? record['elementKey'] : null;
      const primarySelector = typeof record['primarySelector'] === 'string' ? record['primarySelector'] : null;
      if (elementKey === null || primarySelector === null) {
        continue;
      }

      descriptors.push({
        elementKey,
        tagName: typeof record['tagName'] === 'string' ? record['tagName'] : 'desconocido',
        primarySelector,
        accessibilitySelector: typeof record['accessibilitySelector'] === 'string' ? record['accessibilitySelector'] : null,
        structuralCssSelector:
          typeof record['structuralCssSelector'] === 'string' ? record['structuralCssSelector'] : primarySelector,
        xpathFallback: typeof record['xpathFallback'] === 'string' ? record['xpathFallback'] : '/',
        selectorStabilityScore: CdpPayloadParser.asNumber(record['selectorStabilityScore']) ?? 0,
        actionType: CdpPayloadParser.parseActionType(record['actionType']),
        functionalDescription: typeof record['functionalDescription'] === 'string' ? record['functionalDescription'] : '',
        bbox: CdpPayloadParser.parseBoundingBox(record['bbox']),
        elementMetadata: CdpPayloadParser.asRecord(record['elementMetadata']) ?? {},
      });
    }

    return descriptors;
  }
}
