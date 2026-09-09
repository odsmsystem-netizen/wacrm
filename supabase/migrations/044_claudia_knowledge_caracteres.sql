-- ============================================================
-- 044 — Peso de cada fuente de conocimiento, sin devolver el texto.
--
-- El listado de la base de conocimiento excluye `texto` a propósito:
-- una lista de precios pesa decenas de miles de caracteres y la
-- pantalla solo enseña título y estado, así que devolverlo
-- multiplicaría por mil el peso de una petición que se hace cada vez
-- que alguien abre la pestaña.
--
-- Pero sin ese dato la interfaz tampoco puede avisar de lo que de
-- verdad importa: TODO el texto de las fuentes activas viaja dentro
-- del prompt de Claudia en CADA mensaje de CADA conversación, y no
-- hay ningún tope global. Hoy el administrador puede acercarse a la
-- ventana de contexto sin que nada en la pantalla se lo insinúe, y el
-- fallo aparecería en producción, frente a un cliente.
--
-- Una columna generada resuelve las dos cosas: la calcula Postgres,
-- no duplica el texto y el listado se la puede llevar gratis.
-- `length(text)` es IMMUTABLE, que es lo que exige una columna
-- generada; y `texto` es NOT NULL DEFAULT '', así que nunca es nula.
-- ============================================================

ALTER TABLE claudia_knowledge
  ADD COLUMN IF NOT EXISTS caracteres integer
  GENERATED ALWAYS AS (length(texto)) STORED;

COMMENT ON COLUMN claudia_knowledge.caracteres IS
  'Largo de `texto`, calculado por Postgres. Permite mostrar cuánto pesa '
  'el prompt de Claudia sin que el listado tenga que devolver el texto.';
