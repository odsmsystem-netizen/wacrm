-- ============================================================
-- 045 — Que `actualizado` lo ponga Postgres, no la aplicación.
--
-- Las rutas de Claudia escribían `actualizado: new Date().toISOString()`
-- desde Node, mientras que `creado` lo pone el `DEFAULT now()` de
-- Postgres. Son DOS RELOJES DISTINTOS y nada garantiza que coincidan.
--
-- No es teórico: el 2026-09-09 el contenedor iba 184 segundos por
-- detrás de la base de datos (deriva típica de la VM de WSL2 tras
-- suspender el equipo). Resultado: encender una fuente recién subida
-- le grababa una fecha de modificación ANTERIOR a su propia fecha de
-- creación. Ese día costó un buen rato de diagnóstico, porque parecía
-- que las filas no se habían tocado cuando sí.
--
-- Corregir el reloj del host alivia el síntoma pero no la causa: el
-- desfase volverá. La única forma de que ambas marcas sean comparables
-- es que salgan del mismo reloj, y el reloj bueno es el de la base.
--
-- No basta con quitar la asignación en la aplicación: `DEFAULT now()`
-- solo actúa al INSERTAR. Sin este trigger, un UPDATE dejaría
-- `actualizado` congelado en la fecha de alta para siempre.
--
-- `claudia_config` NO se toca: ya resuelve lo suyo en
-- `claudia_config_bump_revision()` (migración 042), y además solo
-- refresca la marca cuando cambia algo que Claudia realmente lee.
-- ============================================================

CREATE OR REPLACE FUNCTION claudia_marcar_actualizado()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.actualizado := now();
  RETURN NEW;
END;
$$;

-- BEFORE UPDATE: tiene que modificar NEW antes de que la fila se
-- escriba. Convive sin problema con los `*_bump` existentes, que son
-- AFTER y devuelven NULL.
DROP TRIGGER IF EXISTS claudia_knowledge_actualizado ON claudia_knowledge;
CREATE TRIGGER claudia_knowledge_actualizado
  BEFORE UPDATE ON claudia_knowledge
  FOR EACH ROW EXECUTE FUNCTION claudia_marcar_actualizado();

DROP TRIGGER IF EXISTS claudia_behaviors_actualizado ON claudia_behaviors;
CREATE TRIGGER claudia_behaviors_actualizado
  BEFORE UPDATE ON claudia_behaviors
  FOR EACH ROW EXECUTE FUNCTION claudia_marcar_actualizado();
