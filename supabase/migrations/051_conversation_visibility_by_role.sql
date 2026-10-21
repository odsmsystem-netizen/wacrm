-- ============================================================
-- Visibilidad de conversaciones según el rol.
--
-- Antes: cualquier miembro de la cuenta veía TODAS las conversaciones y
-- mensajes (017: conversations_select = is_account_member(account_id)).
--
-- Ahora:
--   * owner y admin  -> ven todo lo que llega a la cuenta.
--   * agent y viewer -> solo las conversaciones asignadas a ellos
--                       (assigned_agent_id = auth.uid()). Una
--                       conversación sin asignar no la ve ningún agente.
--
-- Lo cubre RLS, no solo la pantalla: la bandeja, el conteo de no leídos,
-- Realtime (y por tanto los avisos de escritorio) y cualquier consulta
-- directa con el JWT del usuario pasan por las mismas políticas.
--
-- Ojo con las políticas `FOR ALL` de 017 (messages_modify,
-- message_reactions_modify): un FOR ALL también aplica a SELECT y las
-- políticas permisivas se suman con OR, así que dejarlas tal cual
-- anularía el filtro. Por eso se reemplazan aquí.
--
-- Efectos a tener presentes:
--   * Reasignar a otra persona hace que el agente que reasigna deje de
--     verla (puede hacerlo: el WITH CHECK solo exige ser agente).
--   * Las rutas del servidor con service role (webhooks, API pública,
--     Claudia) no pasan por RLS y siguen viendo todo.
--
-- Idempotente: se puede reaplicar sin efecto.
-- ============================================================

CREATE OR REPLACE FUNCTION can_view_conversation(
  p_account_id  UUID,
  p_assigned_to UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id, 'admin')
      OR (is_account_member(p_account_id) AND p_assigned_to = auth.uid());
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION can_view_conversation(UUID, UUID) IS
  'owner/admin ven todas las conversaciones de su cuenta; agent y viewer solo las asignadas a ellos.';

-- ---- conversations -----------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_view_conversation(account_id, assigned_agent_id));

-- USING limita qué filas se pueden tocar; WITH CHECK deja que el agente
-- reasigne la conversación a otra persona (la fila nueva ya no es suya).
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id))
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id));

-- ---- messages ----------------------------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- ---- message_reactions -------------------------------------------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;

CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- ---- Reasignar -----------------------------------------------------
-- Con el filtro de arriba, un agente ya no puede hacer un UPDATE directo
-- que le pase su conversación a otra persona: Postgres exige que la fila
-- resultante siga siendo visible para quien la actualiza, y al
-- reasignarla deja de serlo. Por eso la reasignación pasa por esta
-- función, que valida el permiso y escribe `assigned_at` (del que depende
-- el reparto rotativo, 040).
--
-- Reglas: debe poder ver la conversación (owner/admin cualquiera; agente
-- solo las suyas), y el destino debe ser NULL o un miembro de la cuenta.
-- SECURITY DEFINER conserva auth.uid(), así que el trigger de avisos de
-- asignación (027) sigue atribuyendo bien quién reasignó.
CREATE OR REPLACE FUNCTION reassign_conversation(
  p_conversation_id UUID,
  p_agent_id        UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account  UUID;
  v_assigned UUID;
BEGIN
  SELECT account_id, assigned_agent_id INTO v_account, v_assigned
    FROM conversations WHERE id = p_conversation_id;

  IF NOT FOUND
     OR NOT is_account_member(v_account, 'agent')
     OR NOT can_view_conversation(v_account, v_assigned) THEN
    RAISE EXCEPTION 'conversation_not_accessible' USING ERRCODE = '42501';
  END IF;

  IF p_agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = p_agent_id AND account_id = v_account
  ) THEN
    RAISE EXCEPTION 'agent_not_in_account' USING ERRCODE = '22023';
  END IF;

  UPDATE conversations
     SET assigned_agent_id = p_agent_id,
         assigned_at       = now()
   WHERE id = p_conversation_id;
END;
$$;

ALTER FUNCTION reassign_conversation(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION reassign_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reassign_conversation(UUID, UUID) TO authenticated, service_role;
