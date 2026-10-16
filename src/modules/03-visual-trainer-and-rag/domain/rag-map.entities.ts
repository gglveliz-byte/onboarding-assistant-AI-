/**
 * @archivo src/modules/03-visual-trainer-and-rag/domain/rag-map.entities.ts
 * @modulo 03-visual-trainer-and-rag (Dominio, Entidades y Esquemas Zod del Mapa RAG)
 * @proposito
 *   Modela el dominio del Mapa Funcional inmutable sellado criptograficamente con SHA-256,
 *   los elementos visuales de la interfaz de usuario con selectores en cascada, las versiones
 *   del System Prompt y los esquemas de validacion estricta Zod.
 *
 * @resumen_contenido
 *   - Enums y tipos: `MapSourceMode`, `DomActionType`, `RiskLevel`.
 *   - Entidades de dominio: `FunctionalMapEntity`, `MapElementEntity`, `PromptVersionEntity`.
 *   - Esquemas Zod: `mapElementSchema`, `functionalMapSchema`, `updatePromptSchema`.
 *   - Esquema `urlRoutePatternSchema`: Ruta normalizada o marcador global explicito (C1-49).
 *   - DTOs inmutables con soporte estricto de tipos (`exactOptionalPropertyTypes`).
 *
 * @dependencias_internas
 *   - `zod`: Validacion rigurosa de esquemas.
 *   - `@shared/kernel/result-and-errors.ts`: Dominio tipado y gestion de errores.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`, `prompt_versions`, `projects`.
 *   - Redis: `rag_map:proj:<id>:meta`, `rag_map:proj:<id>:routes`.
 */

import { z } from 'zod';
import { VoiceModelType } from '../../02-projects-and-keys/domain/projects-keys.entities';

/** Modos de creacion o actualizacion del mapa funcional. */
export type MapSourceMode = 'VISUAL_TRAINER' | 'JSON_CODE_EDITOR' | 'CLI_PUSH';

/** Tipos de accion fisica permitidas sobre un elemento del DOM. */
export type DomActionType = 'NONE' | 'CLICK' | 'TYPE' | 'BOTH';

/** Nivel de riesgo operacional de una accion para el motor de voz. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Coordenadas y dimensiones de una caja geometrica en un viewport. */
export interface ElementBoxDto {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Entidad inmutable de un Elemento Funcional del DOM. */
export interface MapElementEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly functionalMapId: string;
  readonly elementKey: string;
  readonly urlRoutePattern: string;
  readonly title: string;
  readonly functionalDescription: string;
  readonly isActionable: boolean;
  readonly actionType: DomActionType;
  readonly stepOrderHint: number | null;
  readonly primarySelector: string;
  readonly accessibilitySelector: string | null;
  readonly structuralCssSelector: string | null;
  readonly xpathFallback: string | null;
  readonly selectorStabilityScore: number;
  readonly desktopBbox: ElementBoxDto;
  readonly tabletBbox: ElementBoxDto;
  readonly mobileBbox: ElementBoxDto;
  readonly elementMetadata: Record<string, unknown>;
  readonly semanticEmbedding?: readonly number[] | null | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Entidad inmutable del Mapa Funcional sellado con SHA-256. */
export interface FunctionalMapEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly versionNumber: number;
  readonly versionLabel: string | null;
  readonly sourceMode: MapSourceMode;
  readonly canonicalMapJson: Record<string, unknown>;
  readonly contentSha256Hash: string;
  readonly totalElementsCount: number;
  readonly isActive: boolean;
  readonly publishedByUserId: string | null;
  readonly publishedAt: Date;
  readonly createdAt: Date;
}

/** Entidad inmutable de una Version de Prompt y Parametros de Voz. */
export interface PromptVersionEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly versionNumber: number;
  readonly systemPrompt: string;
  readonly onboardingStepsJson: readonly Record<string, unknown>[];
  readonly primaryVoiceModel: VoiceModelType;
  readonly fallbackVoiceModel: VoiceModelType;
  readonly modelTemperature: number;
  readonly strictStepEnforcement: boolean;
  readonly askConfirmationBeforeSubmit: boolean;
  readonly updatedViaChannel: 'DASHBOARD_UI' | 'REST_API';
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
}

/** Validador de caja geometrica individual. */
export const elementBoxSchema = z.object({
  top: z.number().min(0),
  left: z.number().min(0),
  width: z.number().min(0),
  height: z.number().min(0),
});

/** Marcador explicito del elemento presente en TODAS las rutas (enlace de ayuda global). */
export const GLOBAL_ROUTE_PATTERN = '*';

/** Caracteres admitidos en una ruta normalizada: los de un `pathname` ya codificado. */
const ROUTE_PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&()+,;=:@%/]*$/u;

/**
 * Patron de ruta admitido para un elemento del mapa funcional (C1-49).
 *
 * Antes se aceptaba cualquier texto no vacio, de modo que un elemento podia declarar una direccion
 * completa (`https://host/checkout`), un comodin embebido (`/checkout*`) o texto arbitrario: el
 * primero nunca coincide con la ruta real de la pantalla y convertia el elemento en un registro
 * muerto; los otros ampliaban su alcance sin que nadie lo hubiera declarado. El patron debe ser una
 * ruta normalizada que empiece por `/`, o el marcador global explicito `*`, que sigue siendo la
 * unica forma —auditable— de declarar un elemento presente en todas las rutas.
 */
export const urlRoutePatternSchema = z
  .string()
  .min(1, 'El patron de ruta es requerido')
  .max(512, 'El patron de ruta no puede superar los 512 caracteres')
  .refine((pattern) => pattern === GLOBAL_ROUTE_PATTERN || ROUTE_PATH_PATTERN.test(pattern), {
    message:
      'El patron de ruta debe ser una ruta que empiece por "/" (por ejemplo "/checkout") o el marcador global "*": no se admiten direcciones completas, comodines embebidos ni texto arbitrario',
  });

/**
 * Esquema Zod de un elemento del mapa funcional.
 * Aplica refinamiento estricto de consistencia: si `isActionable` es false,
 * `actionType` debe ser 'NONE'. Si es true, debe ser 'CLICK', 'TYPE' o 'BOTH'.
 */
export const mapElementInputSchema = z
  .object({
    elementKey: z
      .string()
      .min(1, 'La clave del elemento es requerida')
      .max(120)
      .regex(/^[a-zA-Z0-9_\-.:]+$/, 'La clave contiene caracteres invalidos'),
    urlRoutePattern: urlRoutePatternSchema.default('/'),
    title: z.string().min(1, 'El titulo es requerido').max(200),
    functionalDescription: z.string().min(1, 'La descripcion funcional es requerida'),
    isActionable: z.boolean().default(false),
    actionType: z.enum(['NONE', 'CLICK', 'TYPE', 'BOTH']).default('NONE'),
    stepOrderHint: z.number().int().min(0).optional(),
    primarySelector: z.string().min(1, 'El selector principal es obligatorio'),
    accessibilitySelector: z.string().optional(),
    structuralCssSelector: z.string().optional(),
    xpathFallback: z.string().optional(),
    selectorStabilityScore: z.number().int().min(0).max(100).default(100),
    desktopBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
    tabletBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
    mobileBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
    elementMetadata: z.record(z.unknown()).default({}),
  })
  .refine(
    (el) => {
      if (!el.isActionable && el.actionType !== 'NONE') return false;
      if (el.isActionable && el.actionType === 'NONE') return false;
      return true;
    },
    {
      message:
        'Inconsistencia en accion: Si isActionable=false, actionType debe ser NONE; si es true, debe ser CLICK, TYPE o BOTH',
      path: ['actionType'],
    }
  );

export type MapElementInput = z.infer<typeof mapElementInputSchema>;

/** Esquema de publicacion de mapa funcional inmutable. */
export const publishFunctionalMapInputSchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  versionLabel: z.string().max(120).optional(),
  sourceMode: z.enum(['VISUAL_TRAINER', 'JSON_CODE_EDITOR', 'CLI_PUSH']).default('VISUAL_TRAINER'),
  elements: z.array(mapElementInputSchema).min(1, 'El mapa debe contener al menos un elemento funcional'),
  publishedByUserId: z.string().uuid().optional(),
});

export type PublishFunctionalMapInput = z.infer<typeof publishFunctionalMapInputSchema>;

/** Esquema de actualizacion del System Prompt y Parametros de Voz. */
export const updateAssistantPromptInputSchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  systemPrompt: z.string().min(10, 'El prompt del sistema debe contener al menos 10 caracteres'),
  onboardingStepsJson: z.array(z.record(z.unknown())).default([]),
  primaryVoiceModel: z
    .enum(['GEMINI_3_8_LIVE', 'QWEN_3_8_OMNI_FLASH_REALTIME'])
    .default('GEMINI_3_8_LIVE'),
  fallbackVoiceModel: z
    .enum(['GEMINI_3_8_LIVE', 'QWEN_3_8_OMNI_FLASH_REALTIME'])
    .default('QWEN_3_8_OMNI_FLASH_REALTIME'),
  modelTemperature: z.number().min(0.0).max(1.0).default(0.2),
  strictStepEnforcement: z.boolean().default(true),
  askConfirmationBeforeSubmit: z.boolean().default(true),
  updatedViaChannel: z.enum(['DASHBOARD_UI', 'REST_API']).default('DASHBOARD_UI'),
  createdByUserId: z.string().uuid().optional(),
});

export type UpdateAssistantPromptInput = z.infer<typeof updateAssistantPromptInputSchema>;

/**
 * Esquema estricto para validar los elementos del mapa funcional deserializados desde Redis (C1-46).
 * Previene que entradas corruptas o inyecciones maliciosas alcancen el contexto del motor de voz.
 */
export const cachedMapElementSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  functionalMapId: z.string(),
  elementKey: z.string().min(1),
  urlRoutePattern: urlRoutePatternSchema.default('/'),
  title: z.string().min(1),
  functionalDescription: z.string().min(1),
  isActionable: z.boolean(),
  actionType: z.enum(['NONE', 'CLICK', 'TYPE', 'BOTH']),
  stepOrderHint: z.number().nullable().optional(),
  primarySelector: z.string().min(1),
  accessibilitySelector: z.string().nullable().optional(),
  structuralCssSelector: z.string().nullable().optional(),
  xpathFallback: z.string().nullable().optional(),
  selectorStabilityScore: z.number().default(100),
  desktopBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
  tabletBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
  mobileBbox: elementBoxSchema.default({ top: 0, left: 0, width: 0, height: 0 }),
  elementMetadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

export type CachedMapElement = z.infer<typeof cachedMapElementSchema>;

/** Esquema de validacion para el mapa completo de rutas almacenado en Redis. */
export const cachedRouteMapSchema = z.record(z.string(), z.array(cachedMapElementSchema));

export type CachedRouteMap = z.infer<typeof cachedRouteMapSchema>;
