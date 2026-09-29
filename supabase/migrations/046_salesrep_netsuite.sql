-- 046_salesrep_netsuite.sql
--
-- Enlaza a cada vendedor de wacrm con su representante de ventas de
-- NetSuite, para que una conversación pueda derivarse a la persona que
-- ya atiende a esa empresa.
--
-- El agente Claudia obtiene de su catálogo sincronizado el `salesrep_id`
-- del cliente (un entero de NetSuite, guardado aquí como texto porque
-- llega como cadena en el JSON de la API y nada lo suma ni lo ordena).
-- Con esta columna, wacrm puede traducir ese id al usuario que le
-- corresponde sin exponer la lista del equipo en un endpoint aparte.
--
-- Ver docs/superpowers/specs/2026-09-29-identificacion-cliente-y-derivacion-design.md

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS netsuite_salesrep_id TEXT;

COMMENT ON COLUMN profiles.netsuite_salesrep_id IS
  'salesrep_id del representante de ventas en NetSuite. NULL para quien no vende.';

-- Único POR CUENTA y solo donde hay valor.
--
-- Único: si dos perfiles reclamaran el mismo representante, a cuál de
-- los dos llega el cliente dependería del orden que devuelva Postgres —
-- impredecible y distinto entre consultas. Mejor que la base lo impida.
--
-- Parcial (WHERE NOT NULL): un índice único normal trataría los NULL
-- como distintos entre sí, lo que aquí funcionaría de casualidad; ser
-- explícito deja claro que "sin representante" es el caso corriente y no
-- una fila a medio llenar. La mayoría de los usuarios del CRM no vende.
--
-- Por cuenta: wacrm es multi-cuenta y los ids de NetSuite solo son
-- únicos dentro de la instancia que los emite. Dos cuentas distintas
-- podrían usar el mismo id legítimamente.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_netsuite_salesrep_id_key
  ON profiles (account_id, netsuite_salesrep_id)
  WHERE netsuite_salesrep_id IS NOT NULL;
