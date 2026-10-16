-- ============================================================================================
-- MIGRACION 009: RESOLUCION DE IDENTIDAD ANTERIOR AL CONTEXTO DE INQUILINO
-- ============================================================================================
--
-- @proposito
--   Rompe una **dependencia circular** que impedia que la autenticacion funcionara: para encontrar
--   una clave de API, la politica de seguridad a nivel de fila exige conocer la organizacion
--   propietaria; pero la organizacion propietaria solo se conoce **despues** de encontrar la clave.
--
--   Consecuencia medida: conectado con el rol de aplicacion (sin privilegio de omision de politicas),
--   la consulta exacta del inicio de sesion y del handshake devolvia **cero filas**, de modo que
--   **toda** validacion de clave respondia «clave inexistente» y **el sistema solo funcionaba
--   conectado con un rol privilegiado**, que es precisamente el escenario en el que el aislamiento
--   multi-tenant deja de aplicarse. Es decir: o la autenticacion fallaba al cien por cien, o el
--   aislamiento estaba apagado. No habia un tercer camino.
--
-- @resumen_contenido
--   1. Funcion `app_resolve_api_key_by_hash()`: Resolucion de identidad sin contexto de inquilino.
--   2. Permiso de ejecucion para el rol de aplicacion.
--   3. Diagnostico de cierre que falla si el permiso publico quedo abierto.
--
-- @dependencias_internas
--   - Tabla `api_keys` (migracion 003) y sus politicas (migraciones 005 y 007).
--   - Rol `oa_app` (migracion 007).
--
-- @dependencias_externas
--   - Ninguna. Se ejecuta con el rol propietario a traves del migrador.
--
-- @tablas_bd_o_redis
--   - PostgreSQL: `api_keys` (Lectura controlada por la funcion).
--
-- @nota_de_seguridad
--   La funcion se declara `SECURITY DEFINER` porque su unica razon de existir es **leer una fila cuya
--   organizacion todavia no se conoce**. Es deliberado y su superficie se limita al minimo:
--
--     * Recibe **unicamente el resumen SHA-256** de la clave, nunca la clave en claro. Quien no
--       conozca la clave no puede derivar su resumen, de modo que no puede alcanzar ninguna fila.
--     * Devuelve **solo cuatro columnas**: la organizacion y el proyecto propietarios, la marca de
--       revocacion y el identificador de la clave. No expone el resumen almacenado, ni los permisos
--       concedidos, ni las direcciones desde las que se uso.
--     * El `search_path` se fija de forma explicita para que nadie pueda desviar la resolucion de
--       nombres hacia un esquema propio.
--     * `EXECUTE` se retira de `PUBLIC` y se concede solo al rol de aplicacion: sin esa revocacion,
--       el permiso por omision de PostgreSQL dejaria la funcion al alcance de cualquier rol.
--
--   Una operacion de resolucion de identidad es, por naturaleza, **previa a la autenticacion**: no
--   puede exigir un contexto de inquilino que aun no existe. Lo que si puede —y debe— es tener la
--   superficie minima posible, que es lo que hace esta definicion.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 1. FUNCION DE RESOLUCION DE IDENTIDAD
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_resolve_api_key_by_hash(p_key_hash TEXT)
RETURNS TABLE (
    key_id UUID,
    organization_id UUID,
    project_id UUID,
    revoked_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT k.id, k.organization_id, k.project_id, k.revoked_at
      FROM api_keys k
     WHERE k.key_hash = p_key_hash
     LIMIT 1;
$$;

COMMENT ON FUNCTION app_resolve_api_key_by_hash(TEXT) IS
    'Resuelve la organizacion y el proyecto propietarios de una clave de API a partir de su resumen '
    'SHA-256, sin exigir contexto de inquilino. Existe porque la politica de aislamiento de api_keys '
    'requiere conocer la organizacion, que a su vez solo se conoce tras resolver la clave: sin esta '
    'funcion, la autenticacion devuelve cero filas con un rol sin privilegio de omision y el sistema '
    'solo funciona en el escenario inseguro. Devuelve la superficie minima necesaria y recibe '
    'unicamente el resumen, nunca la clave en claro.';

-- --------------------------------------------------------------------------------------------
-- 2. PERMISO DE EJECUCION RESTRINGIDO AL ROL DE APLICACION
-- --------------------------------------------------------------------------------------------
-- La revocacion de `PUBLIC` es imprescindible: PostgreSQL concede `EXECUTE` a `PUBLIC` por omision en
-- toda funcion nueva, de modo que sin este paso cualquier rol con acceso al esquema podria invocarla.
REVOKE ALL ON FUNCTION app_resolve_api_key_by_hash(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_api_key_by_hash(TEXT) TO oa_app;

-- --------------------------------------------------------------------------------------------
-- 3. DIAGNOSTICO DE CIERRE
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
    grants_public BOOLEAN;
    is_security_definer BOOLEAN;
    has_search_path BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
         WHERE routine_name = 'app_resolve_api_key_by_hash' AND grantee = 'PUBLIC'
    ) INTO grants_public;
    IF grants_public THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: la funcion de resolucion conserva EXECUTE para PUBLIC.';
    END IF;

    SELECT prosecdef, proconfig IS NOT NULL
      INTO is_security_definer, has_search_path
      FROM pg_proc WHERE proname = 'app_resolve_api_key_by_hash';

    IF NOT is_security_definer THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: la funcion de resolucion no es SECURITY DEFINER y no romperia el circulo.';
    END IF;

    IF NOT has_search_path THEN
        RAISE EXCEPTION 'DIAGNOSTICO_FALLIDO: la funcion de resolucion no fija search_path y su resolucion de nombres es desviable.';
    END IF;

    RAISE NOTICE 'DIAGNOSTICO_CORRECTO: resolucion de identidad disponible solo para el rol de aplicacion, con search_path fijo.';
END
$$;
