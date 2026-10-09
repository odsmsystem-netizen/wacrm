-- 050_claudia_promociones.sql
--
-- Promociones de Claudia IA (submenú «Anuncios» del módulo Claudia):
--   * Interruptor para que Claudia hable de promociones (apagado por omisión).
--   * Texto con las promociones vigentes y cómo ofrecerlas (máx. 5 000).
--   * Horario: días ISO (1 = lunes … 7 = domingo) y rango de horas, en la
--     zona America/Mexico_City, más «siempre» que ignora el horario.
--   * Imágenes de las promociones, en un bucket público para que Meta pueda
--     bajarlas sin autenticar al enviarlas por WhatsApp.
--
-- Semántica (la evalúa el AGENTE en cada mensaje; el CRM solo guarda):
--   vigente = activas AND (siempre OR dentro_del_horario)
--
-- Las promociones NO forman parte del prompt_extra cacheado: por eso no se
-- toca el trigger claudia_config_bump (solo sube `revision` cuando cambian
-- personalidad o instrucciones_extra) y cambiar una promoción no le tira a
-- Claudia el caché del prompt.
--
-- Idempotente: se puede reaplicar sin efecto.

-- ============================================================
-- 1. Columnas nuevas en claudia_config
-- ============================================================
ALTER TABLE claudia_config
  ADD COLUMN IF NOT EXISTS promociones_activas boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promociones_siempre boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promociones_texto text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS promociones_dias smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  ADD COLUMN IF NOT EXISTS promociones_inicio time NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS promociones_fin time NOT NULL DEFAULT '18:00';

-- Postgres no tiene ADD CONSTRAINT IF NOT EXISTS: se borra y se vuelve a crear.
ALTER TABLE claudia_config DROP CONSTRAINT IF EXISTS claudia_config_promociones_texto_largo;
ALTER TABLE claudia_config ADD CONSTRAINT claudia_config_promociones_texto_largo
  CHECK (char_length(promociones_texto) <= 5000);

-- Al menos un día y todos entre 1 y 7. `<@` verifica que el arreglo esté
-- contenido en {1..7}; cardinality() > 0 descarta el arreglo vacío.
ALTER TABLE claudia_config DROP CONSTRAINT IF EXISTS claudia_config_promociones_dias_validos;
ALTER TABLE claudia_config ADD CONSTRAINT claudia_config_promociones_dias_validos
  CHECK (
    cardinality(promociones_dias) > 0
    AND promociones_dias <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
  );

-- Sin rangos que crucen la medianoche: el inicio siempre es menor que el fin.
ALTER TABLE claudia_config DROP CONSTRAINT IF EXISTS claudia_config_promociones_horario_orden;
ALTER TABLE claudia_config ADD CONSTRAINT claudia_config_promociones_horario_orden
  CHECK (promociones_inicio < promociones_fin);

-- ============================================================
-- 2. Imágenes de las promociones
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_promociones_imagenes (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Ruta dentro del bucket claudia-promos: {account_id}/{uuid}.{jpg|png}
  ruta       text NOT NULL,
  nombre     text NOT NULL,
  tamano     integer NOT NULL,
  orden      integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  -- La ruta debe vivir en la carpeta de la PROPIA cuenta. Sin esto, un administrador podría
  -- insertar por la API de Supabase una fila con la ruta de otra cuenta, y el agente le mandaría
  -- a sus clientes la URL pública de una imagen ajena.
  CONSTRAINT claudia_promociones_imagenes_ruta_de_la_cuenta
    CHECK (ruta LIKE account_id::text || '/%')
);

CREATE INDEX IF NOT EXISTS claudia_promociones_imagenes_account_idx
  ON claudia_promociones_imagenes (account_id, orden);

ALTER TABLE claudia_promociones_imagenes ENABLE ROW LEVEL SECURITY;

-- Mismo esquema que claudia_knowledge (042): leen los miembros; escriben
-- solo admin o superior.
DROP POLICY IF EXISTS claudia_promociones_imagenes_select ON claudia_promociones_imagenes;
CREATE POLICY claudia_promociones_imagenes_select ON claudia_promociones_imagenes FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS claudia_promociones_imagenes_insert ON claudia_promociones_imagenes;
CREATE POLICY claudia_promociones_imagenes_insert ON claudia_promociones_imagenes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_promociones_imagenes_update ON claudia_promociones_imagenes;
CREATE POLICY claudia_promociones_imagenes_update ON claudia_promociones_imagenes FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_promociones_imagenes_delete ON claudia_promociones_imagenes;
CREATE POLICY claudia_promociones_imagenes_delete ON claudia_promociones_imagenes FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 3. Bucket claudia-promos (público, solo JPEG y PNG, 5 MB)
--
-- Público porque Meta tiene que poder bajar la URL sin autenticar al
-- enviar la imagen por WhatsApp. WhatsApp solo acepta JPEG y PNG como
-- imagen, por eso no se admiten otros tipos.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'claudia-promos',
  'claudia-promos',
  TRUE,
  5242880, -- 5 MB
  ARRAY['image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 4. Políticas de storage
--
-- Lectura pública. Escritura y borrado solo dentro de la carpeta de la
-- cuenta propia ({account_id}/...) y por admin o superior.
-- Drop-then-create (Postgres no tiene CREATE POLICY IF NOT EXISTS).
-- ============================================================
DROP POLICY IF EXISTS "Claudia promos are publicly readable" ON storage.objects;
CREATE POLICY "Claudia promos are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'claudia-promos');

DROP POLICY IF EXISTS "Admins can upload claudia promos" ON storage.objects;
CREATE POLICY "Admins can upload claudia promos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'claudia-promos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS "Admins can update claudia promos" ON storage.objects;
CREATE POLICY "Admins can update claudia promos"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'claudia-promos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS "Admins can delete claudia promos" ON storage.objects;
CREATE POLICY "Admins can delete claudia promos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'claudia-promos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'admin')
    )
  );
