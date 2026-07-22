-- CareerPersona AI — Subscription & Billing — Phase 1, Migration A
-- Adds billing columns to profiles and protects them from direct client writes.
-- Blueprint #2: profiles billing extension + column protection.
--
-- NOTE: authenticated role has table-level UPDATE on profiles, so column-level REVOKE
-- is ineffective here. We use a BEFORE UPDATE trigger instead — functionally equivalent
-- and works correctly alongside the existing table-level grants.

-- A1. Add billing columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_status  text        NOT NULL DEFAULT 'no_subscription',
  ADD COLUMN IF NOT EXISTS trial_started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at        timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_customer_id   text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end   timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamptz;

-- A2. One Stripe customer per user (NULL allowed — not yet a Stripe customer)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_stripe_customer_id_key UNIQUE (stripe_customer_id);

-- A3. Valid subscription_status values
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_status_check CHECK (
    subscription_status IN (
      'no_subscription',
      'trial_active',
      'trial_expired',
      'pro_active',
      'pro_past_due',
      'pro_cancelled',
      'premium_active',
      'admin'
    )
  );

-- A4. Trigger to protect billing columns from direct client writes.
--     Allows: service_role (Worker), postgres (migrations/pg_cron), NULL-role contexts.
--     Blocks: authenticated and anon clients attempting to change any billing column.
CREATE OR REPLACE FUNCTION public.protect_billing_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- auth.role() returns NULL in pg_cron, migration, and direct postgres contexts.
  -- service_role is the Worker; postgres is the superuser / migration runner.
  IF auth.role() IS NULL OR auth.role() IN ('service_role', 'postgres') THEN
    RETURN NEW;
  END IF;

  IF (OLD.subscription_status     IS DISTINCT FROM NEW.subscription_status)
    OR (OLD.trial_started_at      IS DISTINCT FROM NEW.trial_started_at)
    OR (OLD.trial_ends_at         IS DISTINCT FROM NEW.trial_ends_at)
    OR (OLD.stripe_customer_id    IS DISTINCT FROM NEW.stripe_customer_id)
    OR (OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id)
    OR (OLD.current_period_start  IS DISTINCT FROM NEW.current_period_start)
    OR (OLD.current_period_end    IS DISTINCT FROM NEW.current_period_end)
    OR (OLD.cancel_at_period_end  IS DISTINCT FROM NEW.cancel_at_period_end)
    OR (OLD.grace_period_ends_at  IS DISTINCT FROM NEW.grace_period_ends_at)
  THEN
    RAISE EXCEPTION 'Billing columns are managed by the server. Use the API to manage your subscription.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_column_protection
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_billing_columns();
