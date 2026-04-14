-- ═══════════════════════════════════════════════════════════
-- MIGRATION: agregar permiso 'expensas' (consorcio/edificio)
-- ═══════════════════════════════════════════════════════════
-- El permiso 'expensas' habilita a un administrador a gestionar
-- expensas de un propietario, típicamente usado cuando el consorcio
-- o un administrador de edificio gestiona solo esa parte.
--
-- Seguro correr varias veces (idempotente).

-- ── SELECT de expensas: admin con cualquier permiso ya puede leer (política existente) ──

-- ── UPDATE de expensas: habilitar también 'expensas' ──
DROP POLICY IF EXISTS "admin_update_expensas" ON expensas;
CREATE POLICY "admin_update_expensas" ON expensas
  FOR UPDATE TO authenticated
  USING (public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios', 'expensas'));

-- ── INSERT de expensas: habilitar también 'expensas' ──
DROP POLICY IF EXISTS "admin_insert_expensas" ON expensas;
CREATE POLICY "admin_insert_expensas" ON expensas
  FOR INSERT TO authenticated
  WITH CHECK (public.admin_permiso_sobre(propietario_id) IN ('total', 'servicios', 'expensas'));

-- Listo. Después de correr esto, los admins con permiso='expensas'
-- pueden leer, crear y actualizar expensas de los propietarios que
-- los delegaron (respetando propiedades_delegadas si corresponde).
