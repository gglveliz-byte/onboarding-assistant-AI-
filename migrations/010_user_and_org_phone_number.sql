-- ============================================================================================
-- MIGRACION 010: NUMERO TELEFONICO DE CONTACTO PARA USUARIOS Y ORGANIZACIONES
-- ============================================================================================
--
-- @proposito
--   Incorpora el soporte fisico para almacenar el numero telefonico internacional (prefijo +
--   linea local, e.g. "+57 3001234567") del usuario creador y de la organizacion B2B.
--   Permite el contacto directo y soporte de bienvenida para inquilinos registrados.
--
-- @tablas_bd_o_redis
--   - PostgreSQL: `users` (columna `phone_number`), `organizations` (columna `phone_number`).
-- ============================================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(32);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone_number VARCHAR(32);

COMMENT ON COLUMN users.phone_number IS 'Numero telefonico de contacto del usuario con codigo de area internacional';
COMMENT ON COLUMN organizations.phone_number IS 'Numero telefonico de contacto principal de la organizacion con codigo de area';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oa_app') THEN
        GRANT SELECT, INSERT, UPDATE ON users TO oa_app;
        GRANT SELECT, INSERT, UPDATE ON organizations TO oa_app;
    END IF;
END
$$;
