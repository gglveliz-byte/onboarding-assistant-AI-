-- ============================================================================================
-- MIGRACION 007: ROL DE APLICACION SIN BYPASSRLS Y COBERTURA RLS DE LAS TABLAS DE IDENTIDAD
-- ============================================================================================
--
-- @proposito
--   Corrige el defecto de seguridad mas grave de la plataforma: la aplicacion se conectaba con
--   `neondb_owner`, un rol con el atributo `BYPASSRLS`, de modo que las 19 politicas de aislamiento
--   multi-tenant NO se aplicaban en ejecucion. Las politicas estaban bien escritas y las tablas
--   tenian `FORCE ROW LEVEL SECURITY`, pero `BYPASSRLS` se impone a todo: un rol con ese atributo
--   omite las politicas aunque esten forzadas. El aislamiento dependia, por tanto, unicamente del
--   filtrado de la aplicacion, y cualquier consulta que olvidara el filtro habria expuesto datos de
--   otra organizacion.
--
--   Ademas cierra un segundo hueco: seis tablas con datos de identidad no tenian RLS habilitado
--   (`users`, `auth_sessions`, `password_reset_tokens`, `user_mfa_recovery_codes`, `legal_documents`
--   y `pricing_plans_config`). Las cinco primeras contienen datos personales y secretos de
--   autenticacion; la sexta es un catalogo global de precios cuya lectura legitima es compartida.
--
-- @resumen_contenido
--   1. Creacion idempotente del rol de aplicacion `oa_app` SIN `BYPASSRLS`.
--   2. Permisos de DML sobre el esquema publico y de uso de secuencias.
--   3. Permisos de ejecucion sobre las funciones de contexto RLS.
--   4. Privilegios por omision para los objetos que creen las migraciones futuras.
--   5. RLS por organizacion en las cinco tablas de identidad.
--   6. RLS de lectura y escritura exclusiva del SuperAdmin en el catalogo global de precios.
--   7. Diagnostico final que falla de forma explicita si algo quedo mal.
--
-- @dependencias_internas
--   - `app_current_org_id()`, `app_current_user_id()` y `app_is_superadmin()` (migracion 001).
--   - `users` y `organizations` (migracion 002) y `pricing_plans_config` (migracion 004).
--
-- @dependencias_externas
--   - Ninguna. Se ejecuta con el rol propietario a traves de `migrator.ts`.
--
-- @tablas_bd_o_redis
--   - PostgreSQL: `users`, `auth_sessions`, `password_reset_tokens`, `user_mfa_recovery_codes`,
--     `legal_documents` y `pricing_plans_config`.
--
-- @nota_operativa
--   Este archivo NO cambia la cadena de conexion de la aplicacion. Crear el rol es aditivo y
--   reversible; usar `oa_app` en `DATABASE_URL` es una decision de despliegue explicita. Mientras no
--   se cambie, la aplicacion sigue conectandose con el rol propietario y las politicas siguen sin
--   aplicarse: el script `npm run verify:production` lo reporta como bloqueante.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 1. ROL DE APLICACION SIN BYPASSRLS
-- --------------------------------------------------------------------------------------------
-- El rol se crea con `NOLOGIN` de forma deliberada: la contrasena y el permiso de conexion se
-- otorgan por entorno con `ALTER ROLE oa_app WITH LOGIN PASSWORD '...'`, de modo que ninguna
-- credencial quede escrita en el control de versiones. `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`
-- y `NOBYPASSRLS` son los cuatro atributos que garantizan que este rol no pueda escapar del
-- aislamiento ni alterar el esquema.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oa_app') THEN
        CREATE ROLE oa_app WITH
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            NOBYPASSRLS
            CONNECTION LIMIT -1;
        RAISE NOTICE 'Rol oa_app creado sin BYPASSRLS.';
    ELSE
        -- Si el rol ya existia, se fuerzan los atributos de seguridad por si alguien lo altero.
        ALTER ROLE oa_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        RAISE NOTICE 'El rol oa_app ya existia: atributos de seguridad reafirmados.';
    END IF;
END
$$;

-- --------------------------------------------------------------------------------------------
-- 2. PERMISOS DE DATOS SOBRE EL ESQUEMA PUBLICO
-- --------------------------------------------------------------------------------------------
-- La aplicacion necesita leer y escribir datos, pero NO alterar el esquema: el DDL queda reservado
-- al rol propietario que ejecuta las migraciones.
GRANT USAGE ON SCHEMA public TO oa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oa_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oa_app;

-- --------------------------------------------------------------------------------------------
-- 3. PERMISOS SOBRE LAS FUNCIONES DE CONTEXTO RLS
-- --------------------------------------------------------------------------------------------
-- Sin `EXECUTE` sobre `app_current_org_id()` y `app_is_superadmin()`, la propia evaluacion de las
-- politicas fallaria para este rol y toda consulta devolveria un error de permisos.
GRANT EXECUTE ON FUNCTION app_current_org_id() TO oa_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO oa_app;
GRANT EXECUTE ON FUNCTION app_is_superadmin() TO oa_app;

-- --------------------------------------------------------------------------------------------
-- 4. PRIVILEGIOS POR OMISION PARA OBJETOS FUTUROS
-- --------------------------------------------------------------------------------------------
-- Sin esta clausula, cada migracion posterior que creara una tabla exigiria volver a otorgar los
-- permisos a mano, y olvidarlo produciria un fallo de permisos en produccion que no aparece en las
-- pruebas porque estas corren con el rol propietario.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO oa_app;

-- --------------------------------------------------------------------------------------------
-- 5. RLS EN LAS CINCO TABLAS DE IDENTIDAD
-- --------------------------------------------------------------------------------------------
-- Se habilita y se FUERZA la seguridad a nivel de fila. `FORCE` es imprescindible: sin el, el
-- propietario de la tabla (que es el rol que ejecuta las migraciones) seguiria omitiendo las
-- politicas, y una prueba que corriera con ese rol mediria un aislamiento que en produccion no
-- existe.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_users_tenant_isolation ON users;
CREATE POLICY rls_users_tenant_isolation ON users
    FOR ALL
    USING (
        app_is_superadmin()
        OR id = app_current_user_id()
        OR EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.user_id = users.id
               AND m.organization_id = app_current_org_id()
        )
    )
    WITH CHECK (
        app_is_superadmin()
        OR id = app_current_user_id()
        OR EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.user_id = users.id
               AND m.organization_id = app_current_org_id()
        )
    );

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

-- Una sesion de autenticacion pertenece al usuario que la abrio. El acceso se limita al propio
-- usuario y al personal de gobierno: permitir que un miembro de la organizacion viera las sesiones
-- de sus companeros expondria sus identificadores de refresco y sus huellas de dispositivo.
DROP POLICY IF EXISTS rls_auth_sessions_owner_isolation ON auth_sessions;
CREATE POLICY rls_auth_sessions_owner_isolation ON auth_sessions
    FOR ALL
    USING (app_is_superadmin() OR user_id = app_current_user_id())
    WITH CHECK (app_is_superadmin() OR user_id = app_current_user_id());

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

-- Los enlaces de recuperacion son credenciales de un solo uso: si un tercero pudiera listarlos,
-- bastaria con leer el token vigente para tomar la cuenta sin conocer la contrasena.
DROP POLICY IF EXISTS rls_password_reset_tokens_owner_isolation ON password_reset_tokens;
CREATE POLICY rls_password_reset_tokens_owner_isolation ON password_reset_tokens
    FOR ALL
    USING (app_is_superadmin() OR user_id = app_current_user_id())
    WITH CHECK (app_is_superadmin() OR user_id = app_current_user_id());

ALTER TABLE user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery_codes FORCE ROW LEVEL SECURITY;

-- Los codigos de recuperacion de segundo factor son secretos de autenticacion: su lectura por un
-- tercero anularia el segundo factor de la victima.
DROP POLICY IF EXISTS rls_mfa_recovery_codes_owner_isolation ON user_mfa_recovery_codes;
CREATE POLICY rls_mfa_recovery_codes_owner_isolation ON user_mfa_recovery_codes
    FOR ALL
    USING (app_is_superadmin() OR user_id = app_current_user_id())
    WITH CHECK (app_is_superadmin() OR user_id = app_current_user_id());

ALTER TABLE legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_documents FORCE ROW LEVEL SECURITY;

-- Los documentos legales son de lectura publica por diseno: los terminos de servicio y el acuerdo de
-- procesamiento de datos deben poder consultarse ANTES de crear una cuenta, es decir sin contexto de
-- organizacion. Su escritura, en cambio, queda reservada al gobierno de la plataforma: permitir que
-- un tenant editara el texto de los terminos que el mismo acepta invalidaria su valor probatorio.
DROP POLICY IF EXISTS rls_legal_documents_public_read ON legal_documents;
CREATE POLICY rls_legal_documents_public_read ON legal_documents
    FOR SELECT
    USING (TRUE);

DROP POLICY IF EXISTS rls_legal_documents_superadmin_write ON legal_documents;
CREATE POLICY rls_legal_documents_superadmin_write ON legal_documents
    FOR ALL
    USING (app_is_superadmin())
    WITH CHECK (app_is_superadmin());

-- --------------------------------------------------------------------------------------------
-- 6. RLS EN EL CATALOGO GLOBAL DE PRECIOS
-- --------------------------------------------------------------------------------------------
ALTER TABLE pricing_plans_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_plans_config FORCE ROW LEVEL SECURITY;

-- El catalogo de precios es publico —la landing comercial muestra los planes antes de que exista
-- ninguna cuenta—, pero su modificacion solo puede hacerla el gobierno de la plataforma.
DROP POLICY IF EXISTS rls_pricing_plans_public_read ON pricing_plans_config;
CREATE POLICY rls_pricing_plans_public_read ON pricing_plans_config
    FOR SELECT
    USING (TRUE);

DROP POLICY IF EXISTS rls_pricing_plans_superadmin_write ON pricing_plans_config;
CREATE POLICY rls_pricing_plans_superadmin_write ON pricing_plans_config
    FOR ALL
    USING (app_is_superadmin())
    WITH CHECK (app_is_superadmin());

-- --------------------------------------------------------------------------------------------
-- 7. DIAGNOSTICO DE CIERRE
-- --------------------------------------------------------------------------------------------
-- Esta comprobacion convierte un fallo silencioso en un error explicito: si el rol conservara
-- `BYPASSRLS` o alguna tabla quedara sin proteger, la migracion falla y el despliegue se detiene.
DO $$
DECLARE
    bypass_attribute BOOLEAN;
    unprotected_tables TEXT;
BEGIN
    SELECT rolbypassrls INTO bypass_attribute FROM pg_roles WHERE rolname = 'oa_app';
    IF bypass_attribute IS NULL THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: el rol oa_app no existe tras la migracion.';
    END IF;
    IF bypass_attribute THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: el rol oa_app tiene BYPASSRLS y las politicas no se aplicarian.';
    END IF;

    SELECT STRING_AGG(c.relname, ', ' ORDER BY c.relname) INTO unprotected_tables
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname <> 'schema_migrations'
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);

    IF unprotected_tables IS NOT NULL THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: tablas sin RLS habilitado y forzado: %', unprotected_tables;
    END IF;

    RAISE NOTICE 'DIAGNOSTICO_CORRECTO: oa_app sin BYPASSRLS y todas las tablas con RLS forzado.';
END
$$;
