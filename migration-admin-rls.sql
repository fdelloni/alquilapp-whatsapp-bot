-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN: RLS para que administradores puedan acceder a datos de
-- los propietarios que los delegaron, limitado a las propiedades
-- autorizadas en admin_propietario_relations.propiedades_delegadas
-- ═══════════════════════════════════════════════════════════════════
-- Ejecutar en Supabase SQL Editor
-- Idempotente: se puede correr varias veces sin problema.
--
-- Tablas reales del proyecto (verificado):
--   propiedades       → col: propietario_id
--   contratos         → col: propietario_id, propiedad_id
--   cobros            → col: propietario_id, contrato_id
--   servicios         → col: propietario_id, propiedad_id
--   expensas          → col: propietario_id
--   facturas_servicios→ col: servicio_id (se relaciona con servicios)
--   reclamos          → col: propiedad_id
-- ═══════════════════════════════════════════════════════════════════

-- ── Función helper: devuelve TRUE si el usuario actual es un admin
--    con acceso a una propiedad específica (prop_id) del propietario
--    indicado (prop_owner_id), respetando propiedades_delegadas y
--    fecha_expiracion.
CREATE OR REPLACE FUNCTION public.admin_tiene_acceso_a_propiedad(
  prop_id UUID,
  prop_owner_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  rel_row RECORD;
BEGIN
  SELECT permiso, propiedades_delegadas, fecha_expiracion
    INTO rel_row
    FROM admin_propietario_relations
    WHERE admin_id = auth.uid()
      AND propietario_id = prop_owner_id
      AND estado = 'aceptado'
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF rel_row.fecha_expiracion IS NOT NULL
     AND rel_row.fecha_expiracion < CURRENT_DATE THEN
    RETURN FALSE;
  END IF;

  IF rel_row.propiedades_delegadas IS NULL
     OR jsonb_array_length(rel_row.propiedades_delegadas) = 0 THEN
    RETURN TRUE;
  END IF;

  RETURN rel_row.propiedades_delegadas ? prop_id::text;
END;
$$;

-- ── Función helper: nivel de permiso del admin actual sobre un propietario
CREATE OR REPLACE FUNCTION public.admin_permiso_sobre(prop_owner_id UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT permiso
    FROM admin_propietario_relations
    WHERE admin_id = auth.uid()
      AND propietario_id = prop_owner_id
      AND estado = 'aceptado'
      AND (fecha_expiracion IS NULL OR fecha_expiracion >= CURRENT_DATE)
    LIMIT 1;
$$;

-- ── Función helper: lista de propietarios delegados al admin actual
CREATE OR REPLACE FUNCTION public.admins_propietarios_delegados()
RETURNS TABLE (propietario_id UUID, permiso TEXT, propiedades_delegadas JSONB)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT propietario_id, permiso, propiedades_delegadas
    FROM admin_propietario_relations
    WHERE admin_id = auth.uid()
      AND estado = 'aceptado'
      AND (fecha_expiracion IS NULL OR fecha_expiracion >= CURRENT_DATE);
$$;

-- ═══════════════════════════════════════════════════════════════════
-- POLÍTICAS RLS
-- ═══════════════════════════════════════════════════════════════════

-- ── propiedades ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_select_propiedades" ON propiedades;
CREATE POLICY "admin_select_propiedades" ON propiedades
  FOR SELECT
  USING (public.admin_tiene_acceso_a_propiedad(id, propietario_id));

DROP POLICY IF EXISTS "admin_update_propiedades" ON propiedades;
CREATE POLICY "admin_update_propiedades" ON propiedades
  FOR UPDATE
  USING (
    public.admin_tiene_acceso_a_propiedad(id, propietario_id)
    AND public.admin_permiso_sobre(propietario_id) = 'total'
  );

-- ── contratos ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_select_contratos" ON contratos;
CREATE POLICY "admin_select_contratos" ON contratos
  FOR SELECT
  USING (public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id));

DROP POLICY IF EXISTS "admin_update_contratos" ON contratos;
CREATE POLICY "admin_update_contratos" ON contratos
  FOR UPDATE
  USING (
    public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id)
    AND public.admin_permiso_sobre(propietario_id) = 'total'
  );

-- ── cobros ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_select_cobros" ON cobros;
CREATE POLICY "admin_select_cobros" ON cobros
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contratos c
      WHERE c.id = cobros.contrato_id
        AND public.admin_tiene_acceso_a_propiedad(c.propiedad_id, c.propietario_id)
    )
  );

DROP POLICY IF EXISTS "admin_update_cobros" ON cobros;
CREATE POLICY "admin_update_cobros" ON cobros
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contratos c
      WHERE c.id = cobros.contrato_id
        AND public.admin_tiene_acceso_a_propiedad(c.propiedad_id, c.propietario_id)
        AND public.admin_permiso_sobre(c.propietario_id) IN ('total', 'cobros')
    )
  );

DROP POLICY IF EXISTS "admin_insert_cobros" ON cobros;
CREATE POLICY "admin_insert_cobros" ON cobros
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contratos c
      WHERE c.id = cobros.contrato_id
        AND public.admin_tiene_acceso_a_propiedad(c.propiedad_id, c.propietario_id)
        AND public.admin_permiso_sobre(c.propietario_id) IN ('total', 'cobros')
    )
  );

-- ── servicios ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_select_servicios" ON servicios;
CREATE POLICY "admin_select_servicios" ON servicios
  FOR SELECT
  USING (public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id));

DROP POLICY IF EXISTS "admin_update_servicios" ON servicios;
CREATE POLICY "admin_update_servicios" ON servicios
  FOR UPDATE
  USING (
    public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id)
    AND public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios')
  );

DROP POLICY IF EXISTS "admin_insert_servicios" ON servicios;
CREATE POLICY "admin_insert_servicios" ON servicios
  FOR INSERT
  WITH CHECK (
    public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id)
    AND public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios')
  );

-- ── expensas ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_select_expensas" ON expensas;
CREATE POLICY "admin_select_expensas" ON expensas
  FOR SELECT
  USING (
    -- expensas no tiene propiedad_id: validar por propietario_id completo
    public.admin_permiso_sobre(propietario_id) IS NOT NULL
  );

DROP POLICY IF EXISTS "admin_update_expensas" ON expensas;
CREATE POLICY "admin_update_expensas" ON expensas
  FOR UPDATE
  USING (public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios'));

DROP POLICY IF EXISTS "admin_insert_expensas" ON expensas;
CREATE POLICY "admin_insert_expensas" ON expensas
  FOR INSERT
  WITH CHECK (public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios'));

-- ── facturas_servicios ──────────────────────────────────────────
DO $BODY$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'facturas_servicios') THEN
    EXECUTE $INNER$
      DROP POLICY IF EXISTS "admin_select_facturas" ON facturas_servicios;
      CREATE POLICY "admin_select_facturas" ON facturas_servicios
        FOR SELECT
        USING (
          EXISTS (
            SELECT 1 FROM servicios s
            WHERE s.id = facturas_servicios.servicio_id
              AND public.admin_tiene_acceso_a_propiedad(s.propiedad_id, s.propietario_id)
          )
        );
      DROP POLICY IF EXISTS "admin_insert_facturas" ON facturas_servicios;
      CREATE POLICY "admin_insert_facturas" ON facturas_servicios
        FOR INSERT
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM servicios s
            WHERE s.id = facturas_servicios.servicio_id
              AND public.admin_tiene_acceso_a_propiedad(s.propiedad_id, s.propietario_id)
              AND public.admin_permiso_sobre(s.propietario_id) IN ('total', 'servicios')
          )
        );
    $INNER$;
  END IF;
END $BODY$;

-- ── reclamos ────────────────────────────────────────────────────
DO $BODY$
DECLARE
  has_owner_col BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reclamos') THEN
    -- Detectar si reclamos tiene propietario_id (para el join); si no, vamos vía propiedades
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'reclamos' AND column_name = 'propietario_id'
    ) INTO has_owner_col;

    IF has_owner_col THEN
      EXECUTE $INNER$
        DROP POLICY IF EXISTS "admin_select_reclamos" ON reclamos;
        CREATE POLICY "admin_select_reclamos" ON reclamos
          FOR SELECT
          USING (public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id));

        DROP POLICY IF EXISTS "admin_update_reclamos" ON reclamos;
        CREATE POLICY "admin_update_reclamos" ON reclamos
          FOR UPDATE
          USING (
            public.admin_tiene_acceso_a_propiedad(propiedad_id, propietario_id)
            AND public.admin_permiso_sobre(propietario_id) IN ('total', 'lectura')
          );
      $INNER$;
    ELSE
      EXECUTE $INNER$
        DROP POLICY IF EXISTS "admin_select_reclamos" ON reclamos;
        CREATE POLICY "admin_select_reclamos" ON reclamos
          FOR SELECT
          USING (
            EXISTS (
              SELECT 1 FROM propiedades p
              WHERE p.id = reclamos.propiedad_id
                AND public.admin_tiene_acceso_a_propiedad(p.id, p.propietario_id)
            )
          );
      $INNER$;
    END IF;
  END IF;
END $BODY$;

-- ═══════════════════════════════════════════════════════════════════
-- GRANTS
-- ═══════════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION public.admin_tiene_acceso_a_propiedad(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_permiso_sobre(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admins_propietarios_delegados() TO authenticated;
