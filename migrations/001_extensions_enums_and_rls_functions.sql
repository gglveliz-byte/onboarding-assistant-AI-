/**
 * @archivo migrations/001_extensions_enums_and_rls_functions.sql
 * @modulo 00-database-core (Cimientos PostgreSQL 16, 17, 18+, Dominios ENUM y Contexto RLS)
 * @proposito
 *   Inicializa las extensiones criptograficas, de texto insensible a mayusculas y de
 *   vectores (pgvector) requeridas por la plataforma. Define todos los tipos enumerados
 *   estrictos del modelo de dominio e implementa las funciones de contexto de sesion
 *   para Row-Level Security (RLS) multi-tenant y triggers de auditoria temporal.
 *
 * @resumen_contenido
 *   - Extensiones: `pgcrypto`, `citext`, `vector`, `btree_gist`.
 *   - 14 Tipos ENUM (`org_status_enum`, `rbac_role_enum`, `api_key_type_enum`, etc.).
 *   - Funcion `app_current_org_id()`: Extrae `app.current_org_id` de la transaccion actual.
 *   - Funcion `app_current_user_id()`: Extrae `app.current_user_id` de la transaccion actual.
 *   - Funcion `app_is_superadmin()`: Evalua si la sesion actual tiene privilegio SuperAdmin.
 *   - Funcion `trigger_set_updated_at()`: Actualiza automaticamente `updated_at = NOW()`.
 *   - Funcion `trigger_prevent_immutable_mutation()`: Impide UPDATE/DELETE en tablas append-only.
 *
 * @dependencias_internas
 *   - Ninguna (Primer archivo en la cadena de migraciones).
 *
 * @tablas_bd_o_redis
 *   - Variables de sesion PostgreSQL: `app.current_org_id`, `app.current_user_id`, `app.is_superadmin`.
 */

BEGIN;

-- =============================================================================
-- 1. EXTENSIONES OBLIGATORIAS DEL MOTOR PostgreSQL 16, 17, 18+
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- =============================================================================
-- 2. TIPOS ENUMERADOS (DOMINIOS ESTRICTOS DE NEGOCIO Y SEGURIDAD)
-- =============================================================================

-- Estado operativo de una organizacion (Tenant B2B)
DO $$ BEGIN
    CREATE TYPE org_status_enum AS ENUM (
        'ACTIVE',
        'SUSPENDED',
        'PENDING_VERIFICATION',
        'DELETED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Roles de Control de Acceso Basado en Roles (Matriz RBAC)
DO $$ BEGIN
    CREATE TYPE rbac_role_enum AS ENUM (
        'SUPERADMIN',
        'OWNER',
        'DEVELOPER',
        'BILLING',
        'VIEWER'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Clasificacion criptografica de API Keys (Publica para SDK vs Secreta para Backend)
DO $$ BEGIN
    CREATE TYPE api_key_type_enum AS ENUM (
        'PUBLISHABLE',
        'SECRET'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Entorno de ejecucion del proyecto y de las API Keys
DO $$ BEGIN
    CREATE TYPE api_key_env_enum AS ENUM (
        'LIVE',
        'TEST'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Acciones fisicas permitidas sobre un elemento del DOM en el Mapa Funcional RAG
DO $$ BEGIN
    CREATE TYPE dom_action_type_enum AS ENUM (
        'NONE',
        'CLICK',
        'TYPE',
        'BOTH'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Motores de Inteligencia Artificial de Voz en Tiempo Real soportados
DO $$ BEGIN
    CREATE TYPE ai_voice_model_enum AS ENUM (
        'QWEN_3_8_OMNI_FLASH_REALTIME',
        'GEMINI_3_8_LIVE'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Codigos oficiales de planes de facturacion sincronizados con Whop
DO $$ BEGIN
    CREATE TYPE billing_plan_code_enum AS ENUM (
        'PAYG',
        'PLAN_5',
        'PLAN_10',
        'PLAN_30',
        'PLAN_50',
        'CUSTOM_ENTERPRISE'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estados del ciclo de vida de una suscripcion/membresia en Whop
DO $$ BEGIN
    CREATE TYPE whop_sub_status_enum AS ENUM (
        'ACTIVE',
        'TRIALING',
        'PAST_DUE_OR_INVALID',
        'CANCELED',
        'SUSPENDED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tipos de asientos contables en el libro mayor inmutable (usage_ledger)
DO $$ BEGIN
    CREATE TYPE ledger_entry_type_enum AS ENUM (
        'PLAN_ACTIVATION_GRANT',
        'PAYMENT_SUCCEEDED_RENEWAL',
        'PAYMENT_SUCCEEDED_TOPUP',
        'VOICE_MINUTE_DEDUCTION',
        'CREDIT_SUPERADMIN_GRANT',
        'MANUAL_ADJUSTMENT',
        'REFUND_REVERSAL'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estados de una sesion de voz en tiempo real
DO $$ BEGIN
    CREATE TYPE voice_session_status_enum AS ENUM (
        'HANDSHAKE_ISSUED',
        'ACTIVE_STREAMING',
        'COMPLETED_NORMAL',
        'TERMINATED_BARGE_IN_LIMIT',
        'TERMINATED_INSUFFICIENT_FUNDS',
        'TERMINATED_TENANT_SUSPENDED',
        'FAILED_PROVIDER_ERROR'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estados de ejecucion de una herramienta fisica DOM (click_element / type_text)
DO $$ BEGIN
    CREATE TYPE action_execution_status_enum AS ENUM (
        'DISPATCHED',
        'ACK_SUCCESS',
        'REJECTED_BY_GUARDRAIL',
        'BLOCKED_SENSITIVE_FIELD',
        'FAILED_SELECTOR_NOT_FOUND',
        'TIMEOUT'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Catalogo de documentos legales y regulatorios obligatorios
DO $$ BEGIN
    CREATE TYPE legal_doc_type_enum AS ENUM (
        'TOS_B2B',
        'PRIVACY_POLICY',
        'DPA_ENTERPRISE',
        'AI_VOICE_AUP',
        'END_USER_VOICE_CONSENT'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estados de una solicitud de recuperacion de emergencia MFA (Break-Glass Owner)
DO $$ BEGIN
    CREATE TYPE mfa_recovery_status_enum AS ENUM (
        'PENDING_DNS_OR_WHOP_CHALLENGE',
        'COOLING_OFF_24H',
        'PENDING_SUPERADMIN_APPROVAL',
        'APPROVED_AND_EXECUTED',
        'REJECTED_OR_EXPIRED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estados de una sesion del Navegador de Entrenamiento Remoto Efimero
DO $$ BEGIN
    CREATE TYPE training_session_status_enum AS ENUM (
        'PROVISIONING_CONTAINER',
        'DNS_SSRF_VALIDATED',
        'ACTIVE_NAVIGATION_MODE',
        'ACTIVE_CAPTURE_OVERLAY_MODE',
        'BLOCKED_SSRF_VIOLATION',
        'DESTROYED_CLEAN'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- 3. FUNCIONES DE CONTEXTO DE SEGURIDAD PARA ROW-LEVEL SECURITY (RLS)
-- =============================================================================

/**
 * Devuelve el UUID de la organizacion activa establecido mediante
 * `SET LOCAL app.current_org_id = '<uuid>'` al inicio de la transaccion.
 * Si no existe o es invalido, retorna NULL (bloqueando el acceso por defecto).
 */
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_org_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

/**
 * Devuelve el UUID del usuario autenticado establecido mediante
 * `SET LOCAL app.current_user_id = '<uuid>'` al inicio de la transaccion.
 */
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

/**
 * Evalua si la transaccion actual fue abierta por un operador SuperAdmin
 * autenticado con hardware Passkey FIDO2 (`SET LOCAL app.is_superadmin = 'true'`).
 */
CREATE OR REPLACE FUNCTION app_is_superadmin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(current_setting('app.is_superadmin', true), 'false') = 'true';
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- 4. FUNCIONES DE TRIGGERS UNIVERSALES (TIMESTAMPS E INMUTABILIDAD)
-- =============================================================================

/**
 * Actualiza automaticamente la columna `updated_at` en cada operacion UPDATE.
 */
CREATE OR REPLACE FUNCTION trigger_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/**
 * Impide cualquier modificacion (UPDATE) o borrado fisico (DELETE) en tablas
 * contables o de auditoria inmutable (Append-Only Ledger & Audit Logs).
 */
CREATE OR REPLACE FUNCTION trigger_prevent_immutable_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'OPERACION_PROHIBIDA_TABLA_INMUTABLE: La tabla % es estrictamente append-only y no permite %.', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

COMMIT;
