-- 049_conversation_ad_referral.sql
--
-- Origen del cliente de WhatsApp: cuando alguien toca un anuncio de Meta
-- "Clic para enviar mensaje por WhatsApp" (o una publicación) y escribe, el
-- primer mensaje del webhook trae un bloque `referral`. Se guarda en la
-- conversación para mostrar la insignia ANUNCIO/PUBLICACIÓN en la bandeja y
-- contar los orígenes en el Panel.
--
-- Solo la columna: NULL = contacto orgánico (o conversación anterior a esta
-- migración, que no traía el dato). Sin índice: las tablas son chicas.
-- Idempotente: se puede reaplicar sin efecto.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_referral JSONB;

COMMENT ON COLUMN conversations.ad_referral IS
  'Bloque referral de Meta (anuncio o publicación que originó el contacto de WhatsApp), ya validado: source_type, source_id, source_url, headline, body, media_type, image_url, video_url, thumbnail_url, ctwa_clid y captured_at. NULL = contacto orgánico. El anuncio más reciente sobrescribe al anterior.';
