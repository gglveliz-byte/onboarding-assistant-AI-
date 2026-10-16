/**
 * @archivo src/modules/02-projects-and-keys/infrastructure/projects-keys-row.mapper.ts
 * @modulo 02-projects-and-keys (Mapeador Desacoplado de Filas SQL a Entidades de Dominio)
 * @proposito
 *   Transforma de forma pura las filas crudas retornadas por PostgreSQL (snake_case)
 *   hacia las entidades inmutables y tipadas del dominio (camelCase) para proyectos,
 *   claves de API y dominios permitidos.
 */

import { ApiKeyType } from '@shared/kernel/api-key.util';
import {
  AllowedDomainEntity,
  ApiKeyEntity,
  ProjectEntity,
  ProjectEnvironment,
  VadSensitivity,
  VoiceModelType,
} from '../domain/projects-keys.entities';

/** Fila cruda retornada por PostgreSQL para la tabla `projects`. */
export interface ProjectRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly environment: string;
  readonly primary_voice_model: string;
  readonly fallback_voice_model: string;
  readonly voice_persona_code: string;
  readonly speech_speed: string;
  readonly vad_barge_in_sensitivity: string;
  readonly model_temperature: string;
  readonly system_prompt: string;
  readonly onboarding_steps_json: unknown;
  readonly strict_step_enforcement: boolean;
  readonly ask_confirmation_before_submit: boolean;
  readonly active_functional_map_id: string | null;
  readonly active_prompt_version_number: number;
  readonly is_active: boolean;
  readonly created_by_user_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Fila cruda de PostgreSQL para `api_keys`. */
export interface ApiKeyRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly key_type: string;
  readonly environment: string;
  readonly key_prefix: string;
  readonly last_four: string;
  readonly key_hash: string;
  readonly scopes: string[];
  readonly rotated_from_key_id: string | null;
  readonly grace_period_ends_at: Date | null;
  readonly last_used_at: Date | null;
  readonly last_used_ip: string | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by_user_id: string | null;
  readonly created_by_user_id: string | null;
  readonly created_at: Date;
}

/** Fila cruda de PostgreSQL para `allowed_domains`. */
export interface AllowedDomainRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly origin_pattern: string;
  readonly allow_localhost_dev: boolean;
  readonly dns_verification_token: string | null;
  readonly dns_verified_at: Date | null;
  readonly is_active: boolean;
  readonly created_by_user_id: string | null;
  readonly created_at: Date;
}

/**
 * Mapea una fila de `projects` a `ProjectEntity`.
 */
export function mapProjectRow(r: ProjectRow): ProjectEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    slug: r.slug,
    environment: r.environment as ProjectEnvironment,
    primaryVoiceModel: r.primary_voice_model as VoiceModelType,
    fallbackVoiceModel: r.fallback_voice_model as VoiceModelType,
    voicePersonaCode: r.voice_persona_code,
    speechSpeed: parseFloat(r.speech_speed),
    vadBargeInSensitivity: r.vad_barge_in_sensitivity as VadSensitivity,
    modelTemperature: parseFloat(r.model_temperature),
    systemPrompt: r.system_prompt,
    onboardingStepsJson: (Array.isArray(r.onboarding_steps_json)
      ? r.onboarding_steps_json
      : []) as readonly Record<string, unknown>[],
    strictStepEnforcement: r.strict_step_enforcement,
    askConfirmationBeforeSubmit: r.ask_confirmation_before_submit,
    activeFunctionalMapId: r.active_functional_map_id,
    activePromptVersionNumber: r.active_prompt_version_number,
    isActive: r.is_active,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Mapea una fila de `api_keys` a `ApiKeyEntity`.
 */
export function mapApiKeyRow(r: ApiKeyRow): ApiKeyEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    name: r.name,
    keyType: r.key_type as ApiKeyType,
    environment: r.environment as ProjectEnvironment,
    keyPrefix: r.key_prefix,
    lastFour: r.last_four,
    keyHash: r.key_hash,
    scopes: r.scopes ?? [],
    rotatedFromKeyId: r.rotated_from_key_id,
    gracePeriodEndsAt: r.grace_period_ends_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedByUserId: r.revoked_by_user_id,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
  };
}

/**
 * Mapea una fila de `allowed_domains` a `AllowedDomainEntity`.
 */
export function mapAllowedDomainRow(r: AllowedDomainRow): AllowedDomainEntity {
  return {
    id: r.id,
    organizationId: r.organization_id,
    projectId: r.project_id,
    originPattern: r.origin_pattern,
    allowLocalhostDev: r.allow_localhost_dev,
    dnsVerificationToken: r.dns_verification_token,
    dnsVerifiedAt: r.dns_verified_at,
    isActive: r.is_active,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
  };
}
