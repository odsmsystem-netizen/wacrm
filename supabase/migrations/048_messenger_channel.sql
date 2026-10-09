-- 048_messenger_channel.sql
--
-- Messenger como segundo canal de la bandeja. Ver
-- docs/superpowers/specs/2026-10-05-messenger-bandeja-design.md
--
-- Un contacto de Messenger no tiene teléfono: se identifica por el PSID que
-- Meta le asigna por página. Por eso `contacts.phone` pasa a admitir NULL y
-- una restricción obliga a que cada canal traiga SU identificador — sin ella
-- se podría crear un contacto que no es alcanzable por ningún canal.
--
-- Todo lo que existe queda como 'whatsapp' (DEFAULT), así que ninguna fila
-- actual cambia de significado.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_channel_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_check CHECK (channel IN ('whatsapp', 'messenger'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_channel_identity_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_identity_check CHECK (
    (channel = 'whatsapp' AND phone IS NOT NULL)
    OR (channel = 'messenger' AND external_id IS NOT NULL)
  );

-- Un PSID no puede duplicar contactos dentro de una cuenta. Parcial porque
-- los contactos de WhatsApp no tienen external_id.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_channel_external_id_key
  ON contacts (account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'messenger'));

-- Una página de Facebook por cuenta, y una página no puede estar conectada a
-- dos cuentas: el webhook localiza la cuenta por page_id.
CREATE TABLE IF NOT EXISTS messenger_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE,
  page_name TEXT,
  page_access_token TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS messenger_config_updated_at ON messenger_config;
CREATE TRIGGER messenger_config_updated_at
  BEFORE UPDATE ON messenger_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE messenger_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messenger_config_select ON messenger_config;
DROP POLICY IF EXISTS messenger_config_insert ON messenger_config;
DROP POLICY IF EXISTS messenger_config_update ON messenger_config;
DROP POLICY IF EXISTS messenger_config_delete ON messenger_config;
CREATE POLICY messenger_config_select ON messenger_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY messenger_config_insert ON messenger_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_update ON messenger_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_delete ON messenger_config FOR DELETE USING (is_account_member(account_id, 'admin'));
