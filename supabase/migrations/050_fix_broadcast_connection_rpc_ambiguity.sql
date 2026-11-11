-- ============================================================
-- 050_fix_broadcast_connection_rpc_ambiguity.sql
--
-- 049 re-created `create_broadcast_with_recipients` with the extra
-- `p_whatsapp_connection_id` argument, but the rebuilt body went back to
-- a bare `RETURNING id, contact_id`. `contact_id` is also a RETURNS
-- TABLE output variable, and plpgsql resolves names at execution time,
-- so the first call fails with:
--
--   SQLSTATE 42702 — column reference "contact_id" is ambiguous
--
-- That is exactly the bug 041 fixed for the previous signature, and it
-- breaks POST /api/v1/broadcasts (the broadcast wizard writes its rows
-- from the browser instead, so it is unaffected).
--
-- Only the RETURNING clause changes: the body, the 9-argument
-- signature, the result columns and the ACL stay identical to 049.
-- Grants are restated so a replay from an empty database lands the same
-- ACL (CREATE OR REPLACE with a changed signature creates a NEW
-- function, and new functions get PUBLIC EXECUTE by default).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id             UUID,
  p_user_id                UUID,
  p_name                   TEXT,
  p_template_name          TEXT,
  p_template_language      TEXT,
  p_total_recipients       INTEGER,
  p_contact_ids            UUID[],
  p_template_params        JSONB[],
  p_whatsapp_connection_id UUID DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
  v_connection_id UUID := p_whatsapp_connection_id;
BEGIN
  IF v_connection_id IS NULL THEN
    SELECT wc.id INTO v_connection_id
    FROM whatsapp_config wc
    WHERE wc.account_id = p_account_id
    ORDER BY wc.connection_number
    LIMIT 1;
  END IF;

  SELECT wc.id INTO v_connection_id
  FROM whatsapp_config wc
  WHERE wc.id = v_connection_id
    AND wc.account_id = p_account_id;

  IF v_connection_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp connection not found for this account';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, whatsapp_connection_id
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients, v_connection_id
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    -- Qualified: a bare `contact_id` collides with the RETURNS TABLE
    -- output variable of the same name (see the header).
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

-- 049 restricted the function to the service role; restate it for the
-- re-created signature so a replay from scratch matches.
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) TO service_role;
