-- ============================================================
-- 042_claudia_config.sql — Módulo "Configuración de Claudia IA"
--
-- Claudia no es el asistente interno de wacrm: corre como un servicio
-- aparte (Python) y habla con el CRM por la API pública con una llave.
-- Por eso NO se reaprovechan `ai_configs` ni `ai_knowledge_documents`
-- de las migraciones 029/030 — esas alimentan al motor interno, que
-- para las cuentas que usan Claudia está inerte. Colgar el módulo
-- nuevo de ellas ataría la configuración a un motor que nadie ejecuta.
--
-- Cuatro cosas configurables, una tabla cada una:
--   claudia_config     — personalidad y la revisión (ver abajo)
--   claudia_knowledge  — documentos, imágenes y URLs ya convertidos a texto
--   claudia_behaviors  — objetivos y comportamientos que se anexan al cerebro
--   claudia_usage      — tokens y costo REALES de cada llamada a Anthropic
--   claudia_credits    — recargas registradas a mano (ver la nota del saldo)
--
-- La revisión es el detalle que hace esto barato. Claudia mete la
-- configuración dentro del bloque cacheado de su prompt (ver
-- brain.py:_system_para_api), así que bajarla de nuevo sin necesidad no
-- solo gasta red: invalida el caché de Anthropic y encarece CADA turno
-- siguiente. Con la revisión, Claudia pregunta "¿sigue en la 7?" y solo
-- se baja el contenido cuando de verdad cambió.
--
-- Idempotente — se puede correr varias veces.
-- ============================================================

-- ============================================================
-- Configuración general (una fila por cuenta)
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_config (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,

  -- 1 = muy formal … 5 = muy cercano. Se guarda el número y no el texto
  -- del prompt a propósito: así se puede reescribir cómo suena cada
  -- nivel sin migrar los datos de nadie.
  personalidad smallint NOT NULL DEFAULT 3
    CHECK (personalidad BETWEEN 1 AND 5),

  -- Texto libre que el administrador quiera anexar tal cual. Es la
  -- válvula de escape para lo que no cabe en "personalidad" ni en un
  -- comportamiento con título.
  instrucciones_extra text NOT NULL DEFAULT '',

  -- Sube con CUALQUIER cambio del módulo (esta tabla, conocimiento o
  -- comportamientos). Es lo que Claudia compara para no rebajarse la
  -- configuración —y tirar su caché de prompt— sin motivo.
  revision     bigint NOT NULL DEFAULT 1,

  actualizado  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE claudia_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claudia_config_select ON claudia_config;
CREATE POLICY claudia_config_select ON claudia_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS claudia_config_insert ON claudia_config;
CREATE POLICY claudia_config_insert ON claudia_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_config_update ON claudia_config;
CREATE POLICY claudia_config_update ON claudia_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Base de conocimiento
--
-- Guarda TEXTO ya extraído, no el archivo crudo. La extracción (PDF,
-- Word, la descripción de una imagen, el contenido de una URL) ocurre
-- UNA vez, al subir. Si se dejara para la hora de responder, cada
-- consulta del cliente pagaría el parseo y —en el caso de las
-- imágenes— una llamada de visión completa. El archivo original se
-- conserva en Storage solo para que el administrador lo pueda volver a
-- ver o reprocesar.
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_knowledge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  tipo         text NOT NULL CHECK (tipo IN ('documento', 'imagen', 'url')),
  titulo       text NOT NULL,

  -- Nombre del archivo subido o la URL. Es lo que se le muestra al
  -- administrador para que reconozca la fuente.
  origen       text NOT NULL DEFAULT '',

  -- Ruta en Supabase Storage. Vacía para las URLs, que no suben nada.
  storage_path text NOT NULL DEFAULT '',

  -- El resultado que de verdad consume Claudia.
  texto        text NOT NULL DEFAULT '',

  -- La extracción puede tardar o fallar (un PDF escaneado sin texto,
  -- una URL caída). El estado se guarda para que la interfaz pueda
  -- decir qué pasó en vez de mostrar una entrada vacía sin explicación.
  estado       text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'listo', 'error')),
  error        text NOT NULL DEFAULT '',

  bytes        integer NOT NULL DEFAULT 0,

  -- Permite apagar una fuente sin borrarla — útil para una lista de
  -- precios vieja que quizá haya que reactivar.
  activo       boolean NOT NULL DEFAULT true,

  creado       timestamptz NOT NULL DEFAULT now(),
  actualizado  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claudia_knowledge_account_idx
  ON claudia_knowledge (account_id, creado DESC);

ALTER TABLE claudia_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claudia_knowledge_select ON claudia_knowledge;
CREATE POLICY claudia_knowledge_select ON claudia_knowledge FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS claudia_knowledge_insert ON claudia_knowledge;
CREATE POLICY claudia_knowledge_insert ON claudia_knowledge FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_knowledge_update ON claudia_knowledge;
CREATE POLICY claudia_knowledge_update ON claudia_knowledge FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_knowledge_delete ON claudia_knowledge;
CREATE POLICY claudia_knowledge_delete ON claudia_knowledge FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Comportamientos — objetivos y acciones que se anexan al cerebro
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_behaviors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  titulo       text NOT NULL,
  instruccion  text NOT NULL,

  -- Poder desactivar sin borrar importa más aquí que en el
  -- conocimiento: un comportamiento que sale mal se apaga en un clic y
  -- se vuelve a encender cuando se corrige el texto.
  activo       boolean NOT NULL DEFAULT true,

  -- El orden llega al prompt tal cual. Cuando dos instrucciones se
  -- contradicen, la que va después es la que el modelo tiende a seguir,
  -- así que la posición es información, no adorno.
  orden        integer NOT NULL DEFAULT 0,

  creado       timestamptz NOT NULL DEFAULT now(),
  actualizado  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claudia_behaviors_account_idx
  ON claudia_behaviors (account_id, orden, creado);

ALTER TABLE claudia_behaviors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claudia_behaviors_select ON claudia_behaviors;
CREATE POLICY claudia_behaviors_select ON claudia_behaviors FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS claudia_behaviors_insert ON claudia_behaviors;
CREATE POLICY claudia_behaviors_insert ON claudia_behaviors FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_behaviors_update ON claudia_behaviors;
CREATE POLICY claudia_behaviors_update ON claudia_behaviors FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_behaviors_delete ON claudia_behaviors;
CREATE POLICY claudia_behaviors_delete ON claudia_behaviors FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Consumo — tokens y costo reales
--
-- Una fila por llamada a Anthropic, con los tokens que la propia
-- respuesta reporta. Esto es exacto, no una estimación: el costo se
-- calcula de los contadores que devuelve la API, incluidos los de
-- caché, que son los que explican por qué el gasto real es una
-- fracción del que se supondría contando solo tokens de entrada.
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_usage (
  id                 bigserial PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  modelo             text NOT NULL DEFAULT '',
  tokens_entrada     integer NOT NULL DEFAULT 0,
  tokens_salida      integer NOT NULL DEFAULT 0,

  -- Separados a propósito: escribir en caché cuesta MÁS que un token
  -- normal y leer de él cuesta MUCHO menos. Sumarlos a `entrada`
  -- volvería imposible explicar la factura.
  tokens_cache_escritura integer NOT NULL DEFAULT 0,
  tokens_cache_lectura   integer NOT NULL DEFAULT 0,

  costo_usd          numeric(12, 6) NOT NULL DEFAULT 0,

  creado             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claudia_usage_account_creado_idx
  ON claudia_usage (account_id, creado DESC);

ALTER TABLE claudia_usage ENABLE ROW LEVEL SECURITY;

-- El gasto es información de facturación: se lee desde admin para
-- arriba, igual que `ai_usage_log`. La escritura llega siempre por la
-- API con llave (service-role), nunca desde el navegador.
DROP POLICY IF EXISTS claudia_usage_select ON claudia_usage;
CREATE POLICY claudia_usage_select ON claudia_usage FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Recargas de crédito
--
-- Anthropic no publica el saldo restante de una organización: su API
-- de administración expone consumo y costo, nunca el saldo. Así que el
-- número que se ve en su consola no se puede leer desde aquí.
--
-- Lo que sí se puede es reconstruirlo: el administrador registra lo
-- que recargó y cuándo, y el módulo le resta el gasto medido en
-- `claudia_usage` desde esa fecha. Sale un saldo estimado que solo
-- cuenta lo que gasta Claudia — si la misma llave se usa en otra
-- cosa, el estimado quedará por encima del real, y la interfaz lo
-- tiene que decir.
-- ============================================================
CREATE TABLE IF NOT EXISTS claudia_credits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  monto_usd    numeric(12, 2) NOT NULL CHECK (monto_usd > 0),
  nota         text NOT NULL DEFAULT '',

  -- Cuándo se recargó. Es la fecha desde la que se acumula el gasto a
  -- descontar, y se deja editable porque el administrador puede
  -- registrar la recarga días después de haberla hecho.
  recargado_en timestamptz NOT NULL DEFAULT now(),
  creado       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claudia_credits_account_idx
  ON claudia_credits (account_id, recargado_en DESC);

ALTER TABLE claudia_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claudia_credits_select ON claudia_credits;
CREATE POLICY claudia_credits_select ON claudia_credits FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_credits_insert ON claudia_credits;
CREATE POLICY claudia_credits_insert ON claudia_credits FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS claudia_credits_delete ON claudia_credits;
CREATE POLICY claudia_credits_delete ON claudia_credits FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- La revisión
--
-- Un disparador por tabla en vez de confiar en que cada endpoint se
-- acuerde de subirla. Si dependiera del código de la API, la primera
-- ruta nueva que alguien escriba sin recordar esta regla dejaría a
-- Claudia sirviendo configuración vieja de forma indefinida y sin
-- ningún error visible — el peor tipo de fallo.
-- ============================================================
CREATE OR REPLACE FUNCTION claudia_bump_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cuenta uuid;
BEGIN
  cuenta := COALESCE(NEW.account_id, OLD.account_id);

  INSERT INTO claudia_config (account_id, revision, actualizado)
  VALUES (cuenta, 2, now())
  ON CONFLICT (account_id) DO UPDATE
    SET revision = claudia_config.revision + 1,
        actualizado = now();

  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora
END;
$$;

DROP TRIGGER IF EXISTS claudia_knowledge_bump ON claudia_knowledge;
CREATE TRIGGER claudia_knowledge_bump
  AFTER INSERT OR UPDATE OR DELETE ON claudia_knowledge
  FOR EACH ROW EXECUTE FUNCTION claudia_bump_revision();

DROP TRIGGER IF EXISTS claudia_behaviors_bump ON claudia_behaviors;
CREATE TRIGGER claudia_behaviors_bump
  AFTER INSERT OR UPDATE OR DELETE ON claudia_behaviors
  FOR EACH ROW EXECUTE FUNCTION claudia_bump_revision();

-- `claudia_config` sube su propia revisión en el UPDATE. Va aparte de
-- la función de arriba porque esa hace INSERT ... ON CONFLICT sobre
-- esta misma tabla: usarla aquí sería un disparador que se dispara a
-- sí mismo.
CREATE OR REPLACE FUNCTION claudia_config_bump_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Solo si cambió algo que Claudia realmente lee. Sin esta guarda, un
  -- UPDATE que no toca nada subiría la revisión y le tiraría el caché
  -- de prompt sin que nada hubiera cambiado.
  IF NEW.personalidad IS DISTINCT FROM OLD.personalidad
     OR NEW.instrucciones_extra IS DISTINCT FROM OLD.instrucciones_extra THEN
    NEW.revision := OLD.revision + 1;
    NEW.actualizado := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS claudia_config_bump ON claudia_config;
CREATE TRIGGER claudia_config_bump
  BEFORE UPDATE ON claudia_config
  FOR EACH ROW EXECUTE FUNCTION claudia_config_bump_revision();

-- ============================================================
-- Bucket del material de la base de conocimiento
--
-- PRIVADO, a diferencia de `flow-media`. Aquí sube listas de precios,
-- políticas internas y fichas técnicas: material del negocio que no
-- tiene por qué quedar legible para cualquiera que adivine una URL.
--
-- El archivo original se guarda SOLO para que el administrador lo pueda
-- volver a ver o reprocesar. Lo que Claudia consume es el texto ya
-- extraído en `claudia_knowledge.texto`, así que si algún día se vacía
-- este bucket, Claudia sigue sabiendo lo mismo.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'claudia-knowledge',
  'claudia-knowledge',
  FALSE,
  20971520, -- 20 MB
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/markdown', 'text/csv', 'application/json',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Mismo namespace de carpeta que el resto del proyecto ('account-<uuid>'),
-- para que dos cuentas del mismo proyecto de Supabase no puedan colisionar.
DROP POLICY IF EXISTS "Members read claudia knowledge" ON storage.objects;
CREATE POLICY "Members read claudia knowledge"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'claudia-knowledge'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members write claudia knowledge" ON storage.objects;
CREATE POLICY "Members write claudia knowledge"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'claudia-knowledge'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members delete claudia knowledge" ON storage.objects;
CREATE POLICY "Members delete claudia knowledge"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'claudia-knowledge'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
