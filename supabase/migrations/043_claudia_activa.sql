-- ============================================================
-- 043_claudia_activa.sql — Interruptor general de Claudia IA
--
-- Hasta ahora la única forma de callar a Claudia era por conversación
-- (`conversations.ai_autoreply_disabled`, migración 039). Esto añade el
-- interruptor general: apagarla para toda la cuenta de una vez, desde la
-- barra superior, sin tener que ir conversación por conversación.
--
-- Arranca ENCENDIDA y así se queda para todas las cuentas que ya
-- existen: el interruptor da control, no cambia el comportamiento de
-- nadie el día que se despliega.
--
-- Apagada, Claudia sigue sondeando y avanzando su marcador de mensajes
-- vistos, pero no contesta. Esa distinción es deliberada: si el marcador
-- se congelara, al volver a encenderla respondería de golpe a todo lo
-- acumulado — precisamente a las conversaciones que un vendedor ya
-- atendió a mano mientras ella estaba apagada.
--
-- Idempotente.
-- ============================================================

ALTER TABLE claudia_config
  ADD COLUMN IF NOT EXISTS activa boolean NOT NULL DEFAULT true;

-- El disparador de revisión de la migración 042 solo miraba
-- `personalidad` e `instrucciones_extra`. `activa` NO se agrega ahí a
-- propósito: la revisión existe para saber cuándo hay que rebajarse el
-- bloque del prompt, y este campo no forma parte del prompt. Subirla al
-- encender o apagar tiraría el caché de Anthropic sin que el texto
-- hubiera cambiado una coma, y encarecería los turnos siguientes.
--
-- En su lugar, `activa` viaja SIEMPRE en la respuesta de
-- /api/v1/claudia/config —incluso cuando responde `sin_cambios`— para
-- que el interruptor surta efecto en la siguiente vuelta del sondeo
-- pase lo que pase con la revisión. Un interruptor que a veces tarda no
-- sirve como interruptor.
