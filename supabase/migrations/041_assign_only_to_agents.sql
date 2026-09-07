-- ============================================================
-- El reparto automático solo cae en agentes.
--
-- La 040 excluía únicamente a los `viewer`, así que owners y admins
-- entraban al turno. En un equipo chico eso tiene sentido —el dueño
-- también atiende—, pero cuando hay gente dedicada a la bandeja no lo
-- tiene: al dueño le caen clientes que no va a contestar mientras un
-- agente libre se queda esperando.
--
-- Ojo con la consecuencia: si la cuenta se queda sin nadie con rol
-- `agent`, `pick_next_agent` devuelve NULL y NADA se asigna solo. No
-- es un fallo silencioso —el endpoint responde 409 no_agent_available y
-- queda en el log— pero conviene saberlo antes de cambiarle el rol al
-- último agente que quede.
--
-- Asignar a mano desde la bandeja sigue funcionando con cualquier rol;
-- esto solo gobierna el reparto automático.
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
     AND p.account_role = 'agent'
   -- NULLS FIRST: quien nunca ha recibido nada va antes que nadie.
   -- El desempate por user_id hace el resultado determinista, para que
   -- dos llamadas simultáneas no dependan del orden del planificador.
   ORDER BY t.ultima_asignacion ASC NULLS FIRST, p.user_id ASC
   LIMIT 1;
$$;

-- CREATE OR REPLACE conserva los permisos existentes, pero el GRANT se
-- repite por si esta migración se aplica sobre una base donde la 040 no
-- llegó a correr. Es idempotente.
GRANT EXECUTE ON FUNCTION pick_next_agent(UUID) TO service_role;

COMMENT ON FUNCTION pick_next_agent(UUID) IS
  'Siguiente agente en turno: el que lleva más tiempo sin recibir una asignación. Solo roles `agent` — owners y admins quedan fuera del reparto automático. NULL si no hay nadie elegible.';
