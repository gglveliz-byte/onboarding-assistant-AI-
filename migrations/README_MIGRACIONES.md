# CARPETA OFICIAL DE MIGRACIONES SQL & ROW-LEVEL SECURITY (POSTGRESQL 16+)

Esta carpeta contiene el esquema físico completo, las funciones de aislamiento multi-tenant (**Row-Level Security - RLS**), los candados de inmutabilidad contable/auditoría, los datos semilla de producción (**Whop Pricing Matrix & Documentos Legales**) y el ejecutor transaccional con verificación `SHA-256`.

## 1. Inventario de Archivos y Cumplimiento de Reglas Globales (<500 Líneas)

Todos los archivos cumplen estrictamente la skill `reglas-globales-construccion-codigo` (menos de 500 líneas por archivo y cabecera documental completa en español):

| Orden | Archivo | Propósito Técnico | Tablas / Objetos Creados |
| :---: | :--- | :--- | :--- |
| **001** | `001_extensions_enums_and_rls_functions.sql` | Extensiones, 14 tipos `ENUM` y funciones de sesión RLS | `pgcrypto`, `citext`, `vector`, `btree_gist`, `app_current_org_id()`, `app_current_user_id()`, `app_is_superadmin()` |
| **002** | `002_identity_sessions_mfa_and_legal_tables.sql` | Identidad B2B/SuperAdmin, Refresh rotativo, MFA, Break-Glass y Legal | `organizations`, `users`, `auth_sessions`, `password_reset_tokens`, `user_mfa_recovery_codes`, `mfa_break_glass_requests`, `legal_documents`, `user_legal_acceptances`, `memberships` |
| **003** | `003_projects_domains_keys_and_rag_maps_tables.sql` | Proyectos, `allowed_domains`, API Keys SHA-256, Chromium efímero y Mapa RAG | `projects`, `api_keys`, `allowed_domains`, `training_browser_sessions`, `functional_maps`, `map_elements` (`vector(1536)` HNSW), `prompt_versions` |
| **004** | `004_whop_billing_voice_sessions_and_audit_tables.sql` | Matriz Whop, Overrides, Suscripciones, Voz, Libro Mayor y Auditoría | `pricing_plans_config`, `organization_pricing_overrides`, `whop_subscriptions`, `voice_sessions`, `usage_ledger`, `action_events`, `audit_logs` |
| **005** | `005_row_level_security_policies_and_indexes.sql` | Activación `FORCE ROW LEVEL SECURITY` y candados `append-only` | 18 Políticas RLS multi-tenant + Triggers de inmutabilidad en `usage_ledger` y `audit_logs` |
| **006** | `006_seed_pricing_matrix_and_legal_documents.sql` | Semillas idempotentes de planes Whop ($5-$50+) y documentos legales v1.0.0 | Planes `PAYG`, `PLAN_5`, `PLAN_10`, `PLAN_30`, `PLAN_50`, `CUSTOM_ENTERPRISE` + 5 documentos legales |
| **CLI** | `../src/shared/infrastructure/database/migrator.ts` | Orquestador TypeScript con verificacion de integridad `SHA-256` | Tabla de control `schema_migrations` |

> **Ejecutor unico:** el orquestador vive en `src/shared/infrastructure/database/migrator.ts` y resuelve por si mismo esta carpeta `migrations/` de la raiz del repositorio. No existe ninguna copia duplicada del migrador dentro de `migrations/` (Regla 1: cero duplicacion de utilidades).

## 2. Cómo Ejecutar las Migraciones

### Opción A: Usando el Orquestador TypeScript (recomendado, desde la raíz del repositorio)
```bash
npx tsx src/shared/infrastructure/database/migrator.ts
# o mediante el script declarado en package.json
npm run db:migrate
```

### Opción B: Ejecución Directa con `psql`
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_extensions_enums_and_rls_functions.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_identity_sessions_mfa_and_legal_tables.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/003_projects_domains_keys_and_rag_maps_tables.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_whop_billing_voice_sessions_and_audit_tables.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/005_row_level_security_policies_and_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/006_seed_pricing_matrix_and_legal_documents.sql
```
