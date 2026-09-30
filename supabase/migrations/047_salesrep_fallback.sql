-- 047_salesrep_fallback.sql
--
-- Del catálogo de representantes de NetSuite, 4 tienen cartera pero no van
-- a tener usuario en wacrm (la decisión del dueño del producto: Pablo ya
-- cubre esas cuentas y crear cuentas que nadie va a usar no vale la pena).
-- Sin esta columna, `resolveBySalesrep` no encuentra a nadie para esos
-- clientes, el PATCH público contesta 409 `salesrep_not_mapped`, y quien
-- llama (el agente Claudia) reintenta sin representante — lo que reparte
-- la conversación al azar en vez de a quien de verdad la va a atender.
--
-- Esta columna marca, por cuenta, a la persona que recibe esas
-- conversaciones huérfanas.
--
-- Ver docs/superpowers/specs/2026-09-29-identificacion-cliente-y-derivacion-design.md

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_salesrep_fallback BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.is_salesrep_fallback IS
  'true si este perfil recibe las conversaciones de un netsuite_salesrep_id que ningún perfil de la cuenta reclama. A lo más uno por cuenta (ver índice profiles_salesrep_fallback_key).';

-- Único POR CUENTA (mismo patrón que profiles_netsuite_salesrep_id_key en
-- la migración 046).
--
-- Único: si dos perfiles de la misma cuenta se marcaran como respaldo, a
-- cuál de los dos llega el cliente sin representante dependería del orden
-- que devuelva Postgres — impredecible y distinto entre consultas. Mejor
-- que la base lo impida en vez de confiar en que la UI nunca deje marcar
-- a un segundo.
--
-- Parcial (WHERE is_salesrep_fallback): un índice único normal sobre
-- (account_id, is_salesrep_fallback) fallaría en cuanto una cuenta tuviera
-- MÁS DE UN perfil con is_salesrep_fallback = false, que es el caso
-- normal — casi nadie es el respaldo. Filtrar a solo las filas marcadas
-- deja que el índice exprese "a lo más un respaldo", no "a lo más un
-- perfil con este valor cualquiera".
--
-- Por cuenta: wacrm es multi-cuenta; cada una decide su propio respaldo
-- (o ninguno) con independencia de las demás.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_salesrep_fallback_key
  ON profiles (account_id) WHERE is_salesrep_fallback;
