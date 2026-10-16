/**
 * @archivo tests/integration/support/rag-map-doubles.ts
 * @modulo 03-visual-trainer-and-rag (Dobles en Memoria para Pruebas del Mapa RAG)
 * @proposito
 *   Provee implementaciones efimeras y deterministas en memoria de PostgreSQL con contexto
 *   RLS y de Redis Cluster para ejecutar pruebas de integracion ultra veloces del Mapa RAG
 *   sin depender de una base de datos externa ni alterar el estado de produccion.
 */

import type { PoolClient } from 'pg';
import { RlsDatabasePool } from '@shared/infrastructure/database/rls-pool';
import { RedisClusterClient } from '@shared/infrastructure/redis/redis-cluster.client';
import { CryptoUtils } from '@shared/kernel/crypto.util';

/**
 * Crea un almacenamiento simulado en memoria para functional_maps, map_elements,
 * prompt_versions y cache en Redis.
 */
export function createInMemoryStorage() {
  const projects = new Map<string, any>();
  const functionalMaps = new Map<string, any>();
  const mapElements = new Map<string, any>();
  const promptVersions = new Map<string, any>();
  const redisStore = new Map<string, string>();

  const mockClient = {
    query: async (sql: string, params?: unknown[]) => {
      const q = sql.trim();

      // INSERT INTO functional_maps
      if (q.startsWith('INSERT INTO functional_maps')) {
        const id = CryptoUtils.generateCsprngToken(16);
        const [orgId, projId, ver, label, mode, canon, hash, count, pubBy] = params!;
        const row = {
          id,
          organization_id: orgId,
          project_id: projId,
          version_number: ver,
          version_label: label,
          source_mode: mode,
          canonical_map_json: JSON.parse(canon as string),
          content_sha256_hash: hash,
          total_elements_count: count,
          is_active: true,
          published_by_user_id: pubBy,
          published_at: new Date(),
          created_at: new Date(),
        };
        functionalMaps.set(id, row);
        return { rows: [row], rowCount: 1 };
      }

      // SELECT functional_maps by content hash
      if (q.includes('FROM functional_maps WHERE project_id = $1 AND content_sha256_hash = $2')) {
        const [projId, hash] = params!;
        for (const m of functionalMaps.values()) {
          if (m.project_id === projId && m.content_sha256_hash === hash) {
            return { rows: [m], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // SELECT COALESCE(MAX(version_number), 0) + 1 FROM functional_maps
      if (q.includes('MAX(version_number)') && q.includes('FROM functional_maps')) {
        const [projId] = params!;
        let maxVer = 0;
        for (const m of functionalMaps.values()) {
          if (m.project_id === projId && m.version_number > maxVer) {
            maxVer = m.version_number;
          }
        }
        return { rows: [{ next_ver: maxVer + 1 }], rowCount: 1 };
      }

      // SELECT functional_maps by id
      if (q.startsWith('SELECT * FROM functional_maps WHERE id = $1')) {
        const [id] = params!;
        const row = functionalMaps.get(id as string);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // SELECT functional_maps by version
      if (q.includes('FROM functional_maps WHERE project_id = $1 AND version_number = $2')) {
        const [projId, ver] = params!;
        for (const m of functionalMaps.values()) {
          if (m.project_id === projId && m.version_number === ver) {
            return { rows: [m], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // SELECT functional_maps active
      if (q.includes('FROM functional_maps WHERE project_id = $1 AND is_active = TRUE')) {
        const [projId] = params!;
        for (const m of functionalMaps.values()) {
          if (m.project_id === projId && m.is_active) {
            return { rows: [m], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // UPDATE functional_maps SET is_active
      if (q.startsWith('UPDATE functional_maps SET is_active = FALSE WHERE project_id = $1')) {
        const [projId] = params!;
        for (const m of functionalMaps.values()) {
          if (m.project_id === projId) m.is_active = false;
        }
        return { rows: [], rowCount: functionalMaps.size };
      }
      if (q.startsWith('UPDATE functional_maps SET is_active = TRUE WHERE id = $1 AND project_id = $2')) {
        const [id, projId] = params!;
        const m = functionalMaps.get(id as string);
        if (m && m.project_id === projId) m.is_active = true;
        return { rows: [], rowCount: m ? 1 : 0 };
      }

      // UPDATE projects SET active_functional_map_id
      if (q.startsWith('UPDATE projects SET active_functional_map_id = $1')) {
        const [mapId, projId] = params!;
        const p = projects.get(projId as string);
        if (p) p.active_functional_map_id = mapId;
        return { rows: [], rowCount: 1 };
      }

      // INSERT INTO map_elements (soporta insercion masiva de N elementos)
      if (q.startsWith('INSERT INTO map_elements')) {
        const returnedRows: any[] = [];
        const stride = 19;
        const total = Math.floor((params?.length ?? 0) / stride);
        for (let i = 0; i < total; i++) {
          const offset = i * stride;
          const id = CryptoUtils.generateCsprngToken(16);
          const [
            orgId, projId, mapId, key, route, title, desc, act, actType,
            stepHint, pSel, aSel, cSel, xSel, score, dBbox, tBbox, mBbox, meta,
          ] = params!.slice(offset, offset + stride);
          const row = {
            id,
            organization_id: orgId,
            project_id: projId,
            functional_map_id: mapId,
            element_key: key,
            url_route_pattern: route,
            title,
            functional_description: desc,
            is_actionable: act,
            action_type: actType,
            step_order_hint: stepHint,
            primary_selector: pSel,
            accessibility_selector: aSel,
            structural_css_selector: cSel,
            xpath_fallback: xSel,
            selector_stability_score: score,
            desktop_bbox_json: JSON.parse(dBbox as string),
            tablet_bbox_json: JSON.parse(tBbox as string),
            mobile_bbox_json: JSON.parse(mBbox as string),
            element_metadata_json: JSON.parse(meta as string),
            semantic_embedding: null,
            created_at: new Date(),
            updated_at: new Date(),
          };
          mapElements.set(id, row);
          returnedRows.push(row);
        }
        return { rows: returnedRows, rowCount: returnedRows.length };
      }

      // SELECT map_elements by functional_map_id
      if (q.includes('FROM map_elements WHERE functional_map_id = $1')) {
        const [mapId] = params!;
        const matched: any[] = [];
        for (const el of mapElements.values()) {
          if (el.functional_map_id === mapId) matched.push(el);
        }
        return { rows: matched, rowCount: matched.length };
      }

      // SELECT map_elements by route
      if (q.includes('FROM map_elements') && q.includes('url_route_pattern = $2')) {
        const [mapId, route] = params!;
        const matched: any[] = [];
        for (const el of mapElements.values()) {
          if (el.functional_map_id === mapId && (el.url_route_pattern === route || el.url_route_pattern === '*')) {
            matched.push(el);
          }
        }
        return { rows: matched, rowCount: matched.length };
      }

      // SELECT MAX(version_number) FROM prompt_versions
      if (q.includes('MAX(version_number)') && q.includes('FROM prompt_versions')) {
        const [projId] = params!;
        let maxVer = 0;
        for (const pv of promptVersions.values()) {
          if (pv.project_id === projId && pv.version_number > maxVer) {
            maxVer = pv.version_number;
          }
        }
        return { rows: [{ next_ver: maxVer + 1 }], rowCount: 1 };
      }

      // INSERT INTO prompt_versions
      if (q.startsWith('INSERT INTO prompt_versions')) {
        const id = CryptoUtils.generateCsprngToken(16);
        const [orgId, projId, ver, sysPrompt, steps, pVoice, fVoice, temp, strictStep, askConf, channel, user] = params!;
        const row = {
          id,
          organization_id: orgId,
          project_id: projId,
          version_number: ver,
          system_prompt: sysPrompt,
          onboarding_steps_json: JSON.parse(steps as string),
          primary_voice_model: pVoice,
          fallback_voice_model: fVoice,
          model_temperature: temp,
          strict_step_enforcement: strictStep,
          ask_confirmation_before_submit: askConf,
          updated_via_channel: channel,
          created_by_user_id: user,
          created_at: new Date(),
        };
        promptVersions.set(id, row);
        return { rows: [row], rowCount: 1 };
      }

      // UPDATE projects prompt info
      if (q.startsWith('UPDATE projects SET') && q.includes('system_prompt = $1')) {
        const [sysPrompt, steps, pVoice, fVoice, temp, strictStep, askConf, ver, projId] = params!;
        const p = projects.get(projId as string);
        if (p) {
          p.system_prompt = sysPrompt;
          p.onboarding_steps_json = JSON.parse(steps as string);
          p.primary_voice_model = pVoice;
          p.fallback_voice_model = fVoice;
          p.model_temperature = temp;
          p.strict_step_enforcement = strictStep;
          p.ask_confirmation_before_submit = askConf;
          p.active_prompt_version_number = ver;
        }
        return { rows: [], rowCount: 1 };
      }

      // SELECT projects
      if (q.includes('SELECT system_prompt, active_prompt_version_number') && q.includes('FROM projects WHERE id = $1')) {
        const [projId] = params!;
        const p = projects.get(projId as string);
        return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
      }
      if (q.includes('SELECT ask_confirmation_before_submit FROM projects WHERE id = $1')) {
        const [projId] = params!;
        const p = projects.get(projId as string);
        return { rows: p ? [{ ask_confirmation_before_submit: p.ask_confirmation_before_submit }] : [], rowCount: p ? 1 : 0 };
      }
      if (q.includes('SELECT onboarding_steps_json FROM projects WHERE id = $1')) {
        const [projId] = params!;
        const p = projects.get(projId as string);
        return { rows: p ? [{ onboarding_steps_json: p.onboarding_steps_json }] : [], rowCount: p ? 1 : 0 };
      }
      if (q.includes('FROM projects WHERE id = $1 AND organization_id = $2')) {
        const [projId, orgId] = params!;
        const p = projects.get(projId as string);
        if (p && p.organization_id === orgId) {
          return { rows: [{ id: p.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('SELECT organization_id FROM projects WHERE id = $1')) {
        const [projId] = params!;
        const p = projects.get(projId as string);
        return { rows: p ? [{ organization_id: p.organization_id }] : [], rowCount: p ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;

  const mockRlsPool = {
    runInTenantTransaction: async (_context: unknown, fn: (client: PoolClient) => Promise<any>) => {
      return fn(mockClient);
    },
    withClient: async (fn: (client: PoolClient) => Promise<any>) => {
      return fn(mockClient);
    },
  } as unknown as RlsDatabasePool;

  const mockRedisClient = {
    json: {
      setJson: async (key: string, val: unknown) => {
        redisStore.set(key, JSON.stringify(val));
      },
      getJson: async (key: string) => {
        const v = redisStore.get(key);
        return v ? JSON.parse(v) : null;
      },
    },
    keys: {
      remove: async (key: string) => {
        redisStore.delete(key);
      },
    },
  } as unknown as RedisClusterClient;

  return { projects, functionalMaps, mapElements, promptVersions, redisStore, mockRlsPool, mockRedisClient };
}
