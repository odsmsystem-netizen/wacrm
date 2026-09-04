-- ============================================================
-- Round-robin real para asignar conversaciones.
--
-- Hasta ahora el paso `assign_conversation` de las automatizaciones
-- decía hacer round-robin pero tomaba `.limit(1)` de profiles sin
-- ordenar: siempre el mismo agente. El propio comentario del código lo
-- admitía ("preserving that shape until a real round-robin algorithm
-- replaces it"). Esto es ese reemplazo.
--
-- Reparte por turnos: recibe quien lleva más tiempo sin que le asignen
-- nada. Para saberlo hace falta recordar CUÁNDO se asignó cada
-- conversación, que es lo que no se guardaba en ninguna parte —
-- `updated_at` cambia con cualquier mensaje, así que no sirve.
-- ============================================================

-- Momento en que la conversación pasó a su agente actual. NULL cuando
-- nunca se ha asignado, y se vuelve a NULL al liberarla.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Las conversaciones ya asignadas antes de esta migración no tienen
-- fecha real de asignación. Se les pone su `updated_at` como
-- aproximación: sin esto, todo agente con historial parecería no haber
-- recibido nunca nada y el primer reparto saldría torcido.
UPDATE conversations
   SET assigned_at = updated_at
 WHERE assigned_agent_id IS NOT NULL
   AND assigned_at IS NULL;

-- El índice sirve a la consulta de abajo, que busca el MAX(assigned_at)
-- por agente dentro de una cuenta.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_at
  ON conversations (account_id, assigned_agent_id, assigned_at DESC);

-- ============================================================
-- pick_next_agent(account_id) → user_id del siguiente en turno
--
-- Devuelve NULL si la cuenta no tiene a nadie elegible, y quien llama
-- debe tratar ese caso como "no se pudo asignar", nunca como error.
--
-- Se excluye a `viewer` a propósito: puede leer la bandeja pero no
-- responder, así que asignarle un cliente lo dejaría esperando a
-- alguien que no le puede contestar.
-- ============================================================
CREATE OR REPLACE FUNCTION pick_next_agent(p_account_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT p.user_id
    FROM profiles p
    LEFT JOIN LATERAL (
      SELECT MAX(c.assigned_at) AS ultima_asignacion
        FROM conversations c
       WHERE c.account_id = p_account_id
         AND c.assigned_agent_id = p.user_id
    ) t ON TRUE
   WHERE p.account_id = p_account_id
     AND p.account_role <> 'viewer'
   -- NULLS FIRST: quien nunca ha recibido nada va antes que nadie.
   -- El desempate por user_id hace el resultado determinista, para que
   -- dos llamadas simultáneas no dependan del orden del planificador.
   ORDER BY t.ultima_asignacion ASC NULLS FIRST, p.user_id ASC
   LIMIT 1;
$$;

-- El EXECUTE hay que darlo explícitamente: en instancias donde se revocó
-- el privilegio por defecto a PUBLIC (lo normal en un Supabase
-- autohospedado), `service_role` no puede invocar la función sin esto.
-- Es exactamente el fallo que arregló la migración 031, y del peor tipo:
-- `pickNextAgent` se traga el error y devuelve null, así que el reparto
-- no truena — simplemente no asigna a nadie, nunca, sin decir por qué.
--
-- Solo al service role: los dos llamadores (el motor de automatizaciones
-- y el PATCH de la API pública) usan ese cliente, y nadie más necesita
-- poder preguntar a quién le toca.
--
-- Idempotente: GRANT no hace nada si el privilegio ya está.
GRANT EXECUTE ON FUNCTION pick_next_agent(UUID) TO service_role;

COMMENT ON FUNCTION pick_next_agent(UUID) IS
  'Siguiente agente en turno: el que lleva más tiempo sin recibir una asignación. Excluye viewers. NULL si no hay nadie elegible.';

COMMENT ON COLUMN conversations.assigned_at IS
  'Cuándo se asignó la conversación a su agente actual. Lo usa pick_next_agent para repartir por turnos; NULL si no está asignada.';
