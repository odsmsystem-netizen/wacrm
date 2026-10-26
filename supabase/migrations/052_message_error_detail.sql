-- 052_message_error_detail.sql
--
-- Motivo de fallo de un mensaje saliente. Cuando Meta no entrega un mensaje
-- (p. ej. 131042 problema de pago, 131049 límite de ecosistema, 131026 número
-- sin WhatsApp) avisa por webhook con status `failed` y un bloque `errors`.
-- Hasta ahora solo se guardaba el status; el motivo se perdía y la bandeja
-- mostraba una "x" roja sin explicación.
--
-- Solo la columna: NULL = no falló, o falló antes de esta migración (o Meta
-- no mandó detalle). Sin índice: nunca se filtra por este campo.
-- Idempotente: se puede reaplicar sin efecto.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_detail TEXT;

COMMENT ON COLUMN messages.error_detail IS
  'Motivo de fallo reportado por Meta en el webhook de estado (código · título — detalle), ya formateado para mostrarse. Solo se llena cuando status = failed. NULL = sin fallo o sin detalle.';
