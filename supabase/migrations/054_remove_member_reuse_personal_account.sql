-- ============================================================
-- 054 — Quitar a un miembro: reutilizar su cuenta propia si ya existe
--
-- Síntoma (producción, 2026-11-09): al quitar a un miembro, el CRM
-- mostraba «Failed to update member» y el log traía
--   23505 duplicate key value violates unique constraint
--   "idx_accounts_one_per_owner"
--
-- Causa: `remove_account_member` (migración 018) SIEMPRE inserta una
-- cuenta personal nueva para el usuario retirado. Pero `accounts`
-- tiene un índice único sobre `owner_user_id` (017): cada usuario
-- puede ser dueño de UNA sola cuenta. Si el miembro conserva la
-- cuenta personal que se le creó al registrarse (porque entró al
-- equipo sin pasar por `redeem_invitation`, que sí la borra), el
-- INSERT choca y la baja es imposible.
--
-- Arreglo: si el usuario ya es dueño de una cuenta, se le devuelve
-- esa en lugar de crear otra. Si no tiene ninguna, se crea como antes.
-- El resto de las reglas (admin+, no el dueño, no uno mismo, misma
-- cuenta) no cambian.
--
-- Es CREATE OR REPLACE: se puede volver a correr sin riesgo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- la cuenta personal a la que pasa el usuario retirado
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- ¿Ya es dueño de una cuenta (la personal de su registro)? El
  -- índice único idx_accounts_one_per_owner impide crear una segunda,
  -- así que se reutiliza.
  -- Solo se reutiliza una cuenta realmente personal: distinta de la
  -- que se abandona y sin otros miembros. `owner_user_id` está
  -- desnormalizado y no basta por sí solo para fiarse de él.
  SELECT a.id
  INTO v_new_account_id
  FROM accounts a
  WHERE a.owner_user_id = p_user_id
    AND a.id <> v_target_account_id
    AND NOT EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.account_id = a.id AND p.user_id <> p_user_id
    );

  IF v_new_account_id IS NULL THEN
    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
      p_user_id
    )
    RETURNING id INTO v_new_account_id;
  END IF;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

-- ------------------------------------------------------------
-- Cierre del hueco que hacía explotable lo anterior: la política
-- accounts_update (017) deja a un admin hacer UPDATE de cualquier
-- columna de su cuenta, incluida owner_user_id. Se bloquea desde el
-- navegador (rol `authenticated`); transfer_account_ownership corre
-- como postgres (DEFINER) y no se ve afectada. Mismo patrón que 034.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_account_owner_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'owner_user_id cannot be changed directly; use transfer-ownership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_owner_column() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_owner_column ON public.accounts;
CREATE TRIGGER enforce_account_owner_column
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_owner_column();

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;
