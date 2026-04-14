-- Migración: ampliar admin_propietario_relations con permisos y delegación granular
-- Ejecutar en Supabase SQL Editor

ALTER TABLE admin_propietario_relations
  ADD COLUMN IF NOT EXISTS permiso TEXT DEFAULT 'total',
  ADD COLUMN IF NOT EXISTS propiedades_delegadas JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fecha_expiracion DATE;

-- Valores posibles de permiso:
--   'total'       -> acceso completo (ver, editar, crear, eliminar)
--   'edicion'     -> puede ver y editar, no eliminar
--   'lectura'     -> solo lectura
--   'facturas'    -> solo gestión de facturas/servicios
--
-- propiedades_delegadas: array de UUIDs de inmuebles. [] = todas.
-- fecha_expiracion: NULL = sin vencimiento.

COMMENT ON COLUMN admin_propietario_relations.permiso IS 'Nivel de acceso del administrador';
COMMENT ON COLUMN admin_propietario_relations.propiedades_delegadas IS 'Array de IDs de inmuebles delegados. [] = todos';
COMMENT ON COLUMN admin_propietario_relations.fecha_expiracion IS 'Fecha de vencimiento del acceso. NULL = sin vencimiento';
