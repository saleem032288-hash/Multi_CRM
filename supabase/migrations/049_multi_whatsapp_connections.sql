-- ============================================================
-- 049_multi_whatsapp_connections.sql — Unlimited WhatsApp numbers
--
-- Turns `whatsapp_config` from one-row-per-account into the account's
-- list of WhatsApp Cloud API connections:
--
--   * drops UNIQUE(account_id) so an account can hold any number of
--     connections (UNIQUE(phone_number_id) stays — a Meta number can
--     only ever belong to one account on this instance);
--   * adds the presentation/status columns the connection cards show
--     (connection_number, connection_name, phone_number, profile_*,
--     connection_status, verification_status, last status check);
--   * links conversations / messages / message_templates /
--     broadcasts to the connection they belong to, backfilling every
--     existing row to that account's first connection;
--   * swaps the one-conversation-per-contact and one-template-per-
--     account unique indexes for connection-scoped equivalents;
--   * adds per-connection service-message counters (maintained by a
--     trigger, reset through a SECURITY DEFINER RPC with an audit
--     trail) and connection status logs.
--
-- Existing data is preserved: nothing is dropped except the two
-- uniqueness constraints that encoded the single-number design.
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config → connection table
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_number      INTEGER,
  ADD COLUMN IF NOT EXISTS connection_name        TEXT,
  ADD COLUMN IF NOT EXISTS phone_number           TEXT,
  ADD COLUMN IF NOT EXISTS profile_name           TEXT,
  ADD COLUMN IF NOT EXISTS profile_picture_url    TEXT,
  ADD COLUMN IF NOT EXISTS connection_status      TEXT,
  ADD COLUMN IF NOT EXISTS verification_status    TEXT,
  ADD COLUMN IF NOT EXISTS last_status_check_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_status_error      TEXT,
  ADD COLUMN IF NOT EXISTS status_details         JSONB;

-- Backfill connection_number per account in creation order. The old
-- design guaranteed at most one row per account, so in practice this
-- assigns 1 to every existing connection.
DO $$
BEGIN
  UPDATE whatsapp_config wc
  SET connection_number = numbered.rn
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY account_id ORDER BY created_at, id
           ) AS rn
    FROM whatsapp_config
    WHERE connection_number IS NULL
  ) numbered
  WHERE wc.id = numbered.id;
END $$;

-- Defaults + constraints. Kept separate so the backfill above can run
-- before the NOT NULL applies.
ALTER TABLE whatsapp_config
  ALTER COLUMN connection_number SET DEFAULT 1;

UPDATE whatsapp_config SET connection_number = 1 WHERE connection_number IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_connection_number_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_connection_number_check
      CHECK (connection_number IS NULL OR connection_number > 0);
  END IF;
END $$;

ALTER TABLE whatsapp_config ALTER COLUMN connection_number SET NOT NULL;

-- connection_status mirrors the user-facing state. `status` (the legacy
-- connected/disconnected column) is kept in sync for existing readers
-- but the richer enum lives here.
UPDATE whatsapp_config
SET connection_status = CASE
      WHEN status = 'connected' THEN 'connected'
      ELSE 'disconnected'
    END
WHERE connection_status IS NULL;

ALTER TABLE whatsapp_config ALTER COLUMN connection_status SET DEFAULT 'disconnected';
UPDATE whatsapp_config SET connection_status = 'disconnected' WHERE connection_status IS NULL;
ALTER TABLE whatsapp_config ALTER COLUMN connection_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_connection_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_connection_status_check
      CHECK (connection_status IN (
        'connected', 'active', 'inactive', 'disconnected', 'error'
      ));
  END IF;
END $$;

UPDATE whatsapp_config
SET verification_status = CASE
      WHEN registered_at IS NOT NULL THEN 'verified'
      ELSE 'unknown'
    END
WHERE verification_status IS NULL;

ALTER TABLE whatsapp_config ALTER COLUMN verification_status SET DEFAULT 'unknown';
UPDATE whatsapp_config SET verification_status = 'unknown' WHERE verification_status IS NULL;
ALTER TABLE whatsapp_config ALTER COLUMN verification_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_verification_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_verification_status_check
      CHECK (verification_status IN (
        'verified', 'unverified', 'unknown', 'not_available'
      ));
  END IF;
END $$;

-- profile_name / phone_number could not be filled without calling Meta.
-- The status probe backfills them on first refresh; until then the UI
-- shows the saved display name / the number the user typed.

-- One connection per account per position.
DROP INDEX IF EXISTS idx_whatsapp_config_connection_number;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_connection_number
  ON whatsapp_config (account_id, connection_number);

-- Drop the single-connection constraint (migration 017).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- phone_number_id stays globally unique (migration 013), which is what
-- lets the webhook resolve an inbound delivery to exactly one row.

-- ============================================================
-- 2. Per-connection columns on dependent tables
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_connection_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_connection_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS whatsapp_connection_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_connection_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_connection
  ON conversations (whatsapp_connection_id);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_connection
  ON messages (whatsapp_connection_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_whatsapp_connection
  ON message_templates (whatsapp_connection_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_connection
  ON broadcasts (whatsapp_connection_id);

-- Backfill: every existing conversation / message / template /
-- broadcast belongs to its account's first connection. Rows belonging
-- to accounts that never had a WhatsApp connection stay NULL, which the
-- UI treats as "legacy / unknown number".
UPDATE conversations c
SET whatsapp_connection_id = wc.id
FROM whatsapp_config wc
WHERE c.whatsapp_connection_id IS NULL
  AND wc.account_id = c.account_id
  AND wc.connection_number = (
    SELECT min(wc2.connection_number)
    FROM whatsapp_config wc2
    WHERE wc2.account_id = c.account_id
  );

UPDATE messages m
SET whatsapp_connection_id = c.whatsapp_connection_id
FROM conversations c
WHERE m.whatsapp_connection_id IS NULL
  AND c.id = m.conversation_id
  AND c.whatsapp_connection_id IS NOT NULL;

UPDATE message_templates t
SET whatsapp_connection_id = wc.id
FROM whatsapp_config wc
WHERE t.whatsapp_connection_id IS NULL
  AND wc.account_id = t.account_id
  AND wc.connection_number = (
    SELECT min(wc2.connection_number)
    FROM whatsapp_config wc2
    WHERE wc2.account_id = t.account_id
  );

UPDATE broadcasts b
SET whatsapp_connection_id = wc.id
FROM whatsapp_config wc
WHERE b.whatsapp_connection_id IS NULL
  AND wc.account_id = b.account_id
  AND wc.connection_number = (
    SELECT min(wc2.connection_number)
    FROM whatsapp_config wc2
    WHERE wc2.account_id = b.account_id
  );

-- ============================================================
-- 3. Connection-scoped uniqueness
--
-- Conversations: one per (account, connection, contact). Legacy rows
-- with a NULL connection keep the old one-per-contact guarantee.
-- Templates: one per (account, connection, name, language), so the
-- same template name may exist under two different numbers.
-- ============================================================
DROP INDEX IF EXISTS idx_conversations_account_contact;
DROP INDEX IF EXISTS idx_conversations_account_contact_connection;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_connection
  ON conversations (account_id, whatsapp_connection_id, contact_id)
  WHERE whatsapp_connection_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_legacy
  ON conversations (account_id, contact_id)
  WHERE whatsapp_connection_id IS NULL;

-- Non-partial so PostgREST's `onConflict` upsert can target it.
-- NULL connection rows never conflict in Postgres (NULLs are distinct),
-- so legacy rows without a connection can still coexist.
DROP INDEX IF EXISTS message_templates_user_name_language_key;
DROP INDEX IF EXISTS idx_message_templates_connection_name_language;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_connection_name_language
  ON message_templates (account_id, whatsapp_connection_id, name, language);

-- ============================================================
-- 4. Service-message counters
--
-- One row per connection, never shared. The trigger only counts what
-- the existing "Free service messages" card counted: outgoing messages
-- (agent or bot) whose content_type is NOT 'template'.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_message_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_connection_id UUID NOT NULL UNIQUE
    REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_messages_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_counters_account
  ON whatsapp_message_counters (account_id);

-- Audit trail for resets. Kept even after the counter row is recreated.
CREATE TABLE IF NOT EXISTS whatsapp_message_counter_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  previous_count INTEGER NOT NULL DEFAULT 0,
  reset_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_counter_resets_connection
  ON whatsapp_message_counter_resets (whatsapp_connection_id, reset_at DESC);

-- Seed one counter per connection with the historical qualifying count
-- so the numbers are meaningful immediately after this migration.
INSERT INTO whatsapp_message_counters
  (whatsapp_connection_id, account_id, service_messages_count)
SELECT wc.id,
       wc.account_id,
       COALESCE((
         SELECT count(*)
         FROM messages m
         WHERE m.whatsapp_connection_id = wc.id
           AND m.sender_type IN ('agent', 'bot')
           AND m.content_type <> 'template'
       ), 0)
FROM whatsapp_config wc
ON CONFLICT (whatsapp_connection_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.bump_whatsapp_message_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection_id UUID;
BEGIN
  -- Only outgoing free-form messages count (same definition as the
  -- dashboard's Free service messages card).
  IF NEW.sender_type NOT IN ('agent', 'bot') THEN
    RETURN NEW;
  END IF;
  IF NEW.content_type = 'template' THEN
    RETURN NEW;
  END IF;

  v_connection_id := NEW.whatsapp_connection_id;
  IF v_connection_id IS NULL THEN
    SELECT whatsapp_connection_id INTO v_connection_id
    FROM conversations
    WHERE id = NEW.conversation_id;
  END IF;
  IF v_connection_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO whatsapp_message_counters
    (whatsapp_connection_id, account_id, service_messages_count)
  SELECT v_connection_id, wc.account_id, 1
  FROM whatsapp_config wc
  WHERE wc.id = v_connection_id
  ON CONFLICT (whatsapp_connection_id) DO UPDATE
    SET service_messages_count =
          whatsapp_message_counters.service_messages_count + 1,
        updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_whatsapp_message_counter ON messages;
CREATE TRIGGER trg_bump_whatsapp_message_counter
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_whatsapp_message_counter();

-- Reset RPC. SECURITY DEFINER so the client cannot write the counter
-- directly; membership is checked against the owning account.
CREATE OR REPLACE FUNCTION public.reset_whatsapp_message_counter(
  p_connection_id UUID
)
RETURNS TABLE(service_messages_count INTEGER, last_reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_previous INTEGER;
  v_reset_at TIMESTAMPTZ := NOW();
  v_user_id UUID := auth.uid();
BEGIN
  SELECT wc.account_id INTO v_account_id
  FROM whatsapp_config wc
  WHERE wc.id = p_connection_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp connection not found';
  END IF;

  IF NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'Not authorized to reset this counter';
  END IF;

  INSERT INTO whatsapp_message_counters
    (whatsapp_connection_id, account_id, service_messages_count)
  VALUES (p_connection_id, v_account_id, 0)
  ON CONFLICT (whatsapp_connection_id) DO NOTHING;

  SELECT c.service_messages_count INTO v_previous
  FROM whatsapp_message_counters c
  WHERE c.whatsapp_connection_id = p_connection_id
  FOR UPDATE;

  UPDATE whatsapp_message_counters c
  SET service_messages_count = 0,
      last_reset_at = v_reset_at,
      updated_at = v_reset_at
  WHERE c.whatsapp_connection_id = p_connection_id;

  INSERT INTO whatsapp_message_counter_resets
    (account_id, whatsapp_connection_id, previous_count, reset_by_user_id, reset_at)
  VALUES (v_account_id, p_connection_id, COALESCE(v_previous, 0), v_user_id, v_reset_at);

  RETURN QUERY
  SELECT 0, v_reset_at;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_whatsapp_message_counter(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_whatsapp_message_counter(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.reset_whatsapp_message_counter(UUID)
  TO authenticated, service_role;

-- ============================================================
-- 5. Connection status history
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_connection_status_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  connection_status TEXT NOT NULL,
  verification_status TEXT,
  phone_number_verified BOOLEAN,
  quality_rating TEXT,
  messaging_limit TEXT,
  error_message TEXT,
  details JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connection_status_logs_connection
  ON whatsapp_connection_status_logs (whatsapp_connection_id, checked_at DESC);

-- ============================================================
-- 6. RLS for the new tables
-- ============================================================
ALTER TABLE whatsapp_message_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_message_counter_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connection_status_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_message_counters_select ON whatsapp_message_counters;
CREATE POLICY whatsapp_message_counters_select ON whatsapp_message_counters
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_counter_resets_select ON whatsapp_message_counter_resets;
CREATE POLICY whatsapp_counter_resets_select ON whatsapp_message_counter_resets
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_connection_status_logs_select
  ON whatsapp_connection_status_logs;
CREATE POLICY whatsapp_connection_status_logs_select
  ON whatsapp_connection_status_logs
  FOR SELECT USING (is_account_member(account_id));

-- Writes happen through the trigger / SECURITY DEFINER RPC / service
-- role. No client INSERT/UPDATE/DELETE policies on purpose.

-- ============================================================
-- 7. Broadcast creation RPC — carry the sending connection
-- ============================================================
-- 037 and 038 each created an overload; drop both signatures before
-- re-creating the connection-aware one so old 7/8-arg calls cannot
-- bypass the new column.
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[]
);
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id            UUID,
  p_user_id               UUID,
  p_name                  TEXT,
  p_template_name         TEXT,
  p_template_language     TEXT,
  p_total_recipients      INTEGER,
  p_contact_ids           UUID[],
  p_template_params       JSONB[],
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
    INSERT INTO broadcast_recipients
      (broadcast_id, contact_id, status, template_params)
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

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
