-- ═══════════════════════════════════════════════════════════════
-- AlquilApp — Migraciones para Notificaciones Automáticas WhatsApp
-- Ejecutar en Supabase → SQL Editor (una sola vez)
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Agregar teléfono del inquilino a la tabla contratos ──────
--    Esto guarda el número al que se le enviarán los mensajes automáticos.
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS inquilino_telefono varchar(30);

COMMENT ON COLUMN contratos.inquilino_telefono
  IS 'Número de WhatsApp del inquilino (con código de área, sin el 0 inicial). Ej: 9 3493 444071';


-- ── 2. Tabla para registrar las notificaciones enviadas ─────────
--    Sirve para NO enviar el mismo mensaje dos veces al mismo cobro.
CREATE TABLE IF NOT EXISTS notificaciones_wa (
  id          uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  cobro_id    uuid    REFERENCES cobros(id) ON DELETE CASCADE,
  tipo        varchar(20) NOT NULL,
    -- Valores posibles: '5dias' | '2dias' | 'vence_hoy'
  telefono    varchar(30),
  estado      varchar(20) DEFAULT 'enviado',
    -- Valores posibles: 'enviado' | 'error'
  enviado_en  timestamptz DEFAULT now()
);

-- Índice para búsquedas rápidas de duplicados
CREATE INDEX IF NOT EXISTS idx_notif_wa_cobro_tipo
  ON notificaciones_wa (cobro_id, tipo);

COMMENT ON TABLE notificaciones_wa
  IS 'Log de notificaciones WhatsApp enviadas automáticamente a inquilinos';


-- ── 3. Permisos (necesario para que el service_role pueda insertar) ──
ALTER TABLE notificaciones_wa ENABLE ROW LEVEL SECURITY;

-- Política: solo el service_role puede leer/escribir (el bot usa service_role key)
CREATE POLICY "Service role full access" ON notificaciones_wa
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');


-- ── 4. Tabla para historial de conversaciones WhatsApp ──────────
--    Guarda el historial de cada usuario para que el bot mantenga
--    el contexto aunque el servidor se reinicie.
CREATE TABLE IF NOT EXISTS conversaciones_wa (
  id          bigserial   PRIMARY KEY,
  telefono    text        UNIQUE NOT NULL,
  messages    jsonb       NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Índice para búsquedas por teléfono
CREATE INDEX IF NOT EXISTS idx_conversaciones_wa_telefono
  ON conversaciones_wa (telefono);

-- Permisos: solo el service_role puede leer/escribir
ALTER TABLE conversaciones_wa ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON conversaciones_wa
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE conversaciones_wa
  IS 'Historial de conversaciones del bot de WhatsApp por número de teléfono';


-- ═══════════════════════════════════════════════════════════════
-- v4.0 — Recibos PDF, Facturas de Servicios, Recordatorios
-- ═══════════════════════════════════════════════════════════════

-- ── 5. Agregar columna para facturas de servicios en notificaciones_wa ──
--    Permite registrar notificaciones de servicios (además de cobros).
ALTER TABLE notificaciones_wa
  ADD COLUMN IF NOT EXISTS servicio_factura_id uuid REFERENCES facturas_servicios(id) ON DELETE CASCADE;

ALTER TABLE notificaciones_wa
  ADD COLUMN IF NOT EXISTS clave_unica text;

-- Índice para búsquedas de duplicados de facturas de servicios
CREATE INDEX IF NOT EXISTS idx_notif_wa_servfact_tipo
  ON notificaciones_wa (servicio_factura_id, tipo);

-- Índice para clave única (servicios con dia_vto fijo)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_wa_clave_unica
  ON notificaciones_wa (clave_unica) WHERE clave_unica IS NOT NULL;

-- Hacer cobro_id nullable (ya que ahora puede ser notif de servicio)
ALTER TABLE notificaciones_wa ALTER COLUMN cobro_id DROP NOT NULL;

COMMENT ON COLUMN notificaciones_wa.servicio_factura_id
  IS 'ID de la factura de servicio (luz, gas, agua) para notificaciones de servicios';

COMMENT ON COLUMN notificaciones_wa.clave_unica
  IS 'Clave para evitar duplicados en notificaciones por dia_vto fijo (servicio_id_tipo_YYYY-MM)';


-- ── 6. Bucket de Supabase Storage para recibos PDF ──
--    NOTA: Crear manualmente desde Supabase Dashboard:
--    Storage → New Bucket → Nombre: "recibos" → Public: sí
--    (El bot también intenta crearlo automáticamente vía API)
