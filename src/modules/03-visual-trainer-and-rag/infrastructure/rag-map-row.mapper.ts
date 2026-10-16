/**
 * @archivo src/modules/03-visual-trainer-and-rag/infrastructure/rag-map-row.mapper.ts
 * @modulo 03-visual-trainer-and-rag (Mapeador Puro de Filas SQL a Entidades del Mapa RAG)
 * @proposito
 *   Transforma de forma pura las filas crudas retornadas por PostgreSQL (snake_case)
 *   hacia las entidades inmutables y tipadas del dominio (camelCase) para mapas funcionales,
 *   elementos del DOM indexados y versiones del System Prompt.
 *
 * @resumen_contenido
 *   - Interfaces de fila: `FunctionalMapRow`, `MapElementRow`, `PromptVersionRow`.
 *   - Funciones mapeadoras: `mapFunctionalMapRow`, `mapMapElementRow`, `mapPromptVersionRow`.
 *
 * @dependencias_internas
 *   - `../domain/rag-map.entities.ts`: Entidades y tipos de dominio.
 *
 * @tablas_bd_o_redis
 *   - PostgreSQL: `functional_maps`, `map_elements`, `prompt_versions`.
 */

import { VoiceModelType } from '../../02-projects-and-keys/domain/projects-keys.entities';
import {
  DomActionType,
  ElementBoxDto,
  FunctionalMapEntity,
  MapElementEntity,
  MapSourceMode,
  PromptVersionEntity,
} from '../domain/rag-map.entities';

/** Fila cruda retornada por PostgreSQL para la tabla `functional_maps`. */
export interface FunctionalMapRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly version_number: number;
  readonly version_label: string | null;
  readonly source_mode: string;
  readonly canonical_map_json: unknown;
  readonly content_sha256_hash: string;
  readonly total_elements_count: number;
  readonly is_active: boolean;
  readonly published_by_user_id: string | null;
  readonly published_at: Date;
  readonly created_at: Date;
}

/** Fila cruda retornada por PostgreSQL para la tabla `map_elements`. */
export interface MapElementRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly functional_map_id: string;
  readonly element_key: string;
  readonly url_route_pattern: string;
  readonly title: string;
  readonly functional_description: string;
  readonly is_actionable: boolean;
  readonly action_type: string;
  readonly step_order_hint: number | null;
  readonly primary_selector: string;
  readonly accessibility_selector: string | null;
  readonly structural_css_selector: string | null;
  readonly xpath_fallback: string | null;
  readonly selector_stability_score: number;
  readonly desktop_bbox_json: unknown;
  readonly tablet_bbox_json: unknown;
  readonly mobile_bbox_json: unknown;
  readonly element_metadata_json: unknown;
  readonly semantic_embedding: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Fila cruda retornada por PostgreSQL para la tabla `prompt_versions`. */
export interface PromptVersionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly version_number: number;
  readonly system_prompt: string;
  readonly onboarding_steps_json: unknown;
  readonly primary_voice_model: string;
  readonly fallback_voice_model: string;
  readonly model_temperature: string | number;
  readonly strict_step_enforcement: boolean;
  readonly ask_confirmation_before_submit: boolean;
  readonly updated_via_channel: string;
  readonly created_by_user_id: string | null;
  readonly created_at: Date;
}

/** Helper para normalizar cajas geometricas desde JSONB o valores vacios. */
function parseBox(raw: unknown): ElementBoxDto {
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    return {
      top: typeof o['top'] === 'number' ? o['top'] : 0,
      left: typeof o['left'] === 'number' ? o['left'] : 0,
      width: typeof o['width'] === 'number' ? o['width'] : 0,
      height: typeof o['height'] === 'number' ? o['height'] : 0,
    };
  }
  return { top: 0, left: 0, width: 0, height: 0 };
}

/**
 * Mapea una fila de `functional_maps` a `FunctionalMapEntity`.
 */
export function mapFunctionalMapRow(r: FunctionalMapRow): FunctionalMapEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    versionNumber: r.version_number,
    versionLabel: r.version_label,
    sourceMode: r.source_mode as MapSourceMode,
    canonicalMapJson: (typeof r.canonical_map_json === 'object' && r.canonical_map_json !== null
      ? r.canonical_map_json
      : {}) as Record<string, unknown>,
    contentSha256Hash: r.content_sha256_hash,
    totalElementsCount: r.total_elements_count,
    isActive: r.is_active,
    publishedByUserId: r.published_by_user_id,
    publishedAt: r.published_at,
    createdAt: r.created_at,
  };
}

/**
 * Mapea una fila de `map_elements` a `MapElementEntity`.
 */
export function mapMapElementRow(r: MapElementRow): MapElementEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    functionalMapId: r.functional_map_id,
    elementKey: r.element_key,
    urlRoutePattern: r.url_route_pattern,
    title: r.title,
    functionalDescription: r.functional_description,
    isActionable: r.is_actionable,
    actionType: r.action_type as DomActionType,
    stepOrderHint: r.step_order_hint,
    primarySelector: r.primary_selector,
    accessibilitySelector: r.accessibility_selector,
    structuralCssSelector: r.structural_css_selector,
    xpathFallback: r.xpath_fallback,
    selectorStabilityScore: r.selector_stability_score,
    desktopBbox: parseBox(r.desktop_bbox_json),
    tabletBbox: parseBox(r.tablet_bbox_json),
    mobileBbox: parseBox(r.mobile_bbox_json),
    elementMetadata: (typeof r.element_metadata_json === 'object' && r.element_metadata_json !== null
      ? r.element_metadata_json
      : {}) as Record<string, unknown>,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Mapea una fila de `prompt_versions` a `PromptVersionEntity`.
 */
export function mapPromptVersionRow(r: PromptVersionRow): PromptVersionEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    versionNumber: r.version_number,
    systemPrompt: r.system_prompt,
    onboardingStepsJson: (Array.isArray(r.onboarding_steps_json)
      ? r.onboarding_steps_json
      : []) as readonly Record<string, unknown>[],
    primaryVoiceModel: r.primary_voice_model as VoiceModelType,
    fallbackVoiceModel: r.fallback_voice_model as VoiceModelType,
    modelTemperature:
      typeof r.model_temperature === 'number' ? r.model_temperature : parseFloat(r.model_temperature),
    strictStepEnforcement: r.strict_step_enforcement,
    askConfirmationBeforeSubmit: r.ask_confirmation_before_submit,
    updatedViaChannel: r.updated_via_channel as 'DASHBOARD_UI' | 'REST_API',
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
  };
}
