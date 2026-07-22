-- CareerPersona AI — Subscription & Billing — Phase 1, Migration B
-- Replaces the single-state subscriptions table with Blueprint #2 subscription history design.
--
-- Decision rationale:
--   The existing subscriptions table has UNIQUE(user_id), which is incompatible with the
--   Blueprint #2 history design (multiple rows per user, one per Stripe subscription period).
--   It also references profiles.id rather than auth.users.id. Rename is the correct path.
--
-- The 3 existing dev rows (placeholder free/active, no Stripe data) are preserved in
-- subscriptions_legacy. handle_new_user() is updated to stop writing there — trial state
-- now lives in profiles.subscription_status (DEFAULT 'no_subscription').

-- B1. Rename existing single-state table
ALTER TABLE public.subscriptions RENAME TO subscriptions_legacy;

-- B2. Rename constraints to free up the names for the new table
--     (PostgreSQL constraint names are schema-scoped, so old names would conflict)
ALTER TABLE public.subscriptions_legacy RENAME CONSTRAINT subscriptions_pkey
  TO subscriptions_legacy_pkey;
ALTER TABLE public.subscriptions_legacy RENAME CONSTRAINT subscriptions_user_id_key
  TO subscriptions_legacy_user_id_key;
ALTER TABLE public.subscriptions_legacy RENAME CONSTRAINT subscriptions_user_id_fkey
  TO subscriptions_legacy_user_id_fkey;
ALTER TABLE public.subscriptions_legacy RENAME CONSTRAINT subscriptions_stripe_customer_id_key
  TO subscriptions_legacy_stripe_customer_id_key;
ALTER TABLE public.subscriptions_legacy RENAME CONSTRAINT subscriptions_stripe_subscription_id_key
  TO subscriptions_legacy_stripe_subscription_id_key;

-- B3. Rename the trigger that moved with the table
ALTER TRIGGER update_subscriptions_updated_at ON public.subscriptions_legacy
  RENAME TO update_subscriptions_legacy_updated_at;

-- B4. Update handle_new_user() — remove the subscriptions INSERT.
--     Trial state is now tracked in profiles.subscription_status (DEFAULT 'no_subscription').
--     Trial activation fires on first verified login via POST /api/trial/activate (Worker).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;

-- B5. Create Blueprint #2 subscription history table.
--     Stores one row per Stripe subscription period. Multiple rows per user are expected.
--     user_id FK targets auth.users (canonical user identity), not profiles.
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_id text        NOT NULL,
  stripe_customer_id     text        NOT NULL,
  plan                   text        NOT NULL,
  status                 text        NOT NULL,
  current_period_start   timestamptz NOT NULL,
  current_period_end     timestamptz NOT NULL,
  cancel_at_period_end   boolean     NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  ended_at               timestamptz,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

-- B6. RLS: users can read their own subscription history
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription history"
  ON public.subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for authenticated.
-- Only the Worker (service_role, bypasses RLS) writes to this table.

-- B7. Grant SELECT so the RLS SELECT policy can apply for authenticated users
GRANT SELECT ON public.subscriptions TO authenticated;

-- B8. updated_at trigger (reuses existing update_updated_at function)
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- B9. Indexes for common access patterns
CREATE INDEX subscriptions_user_id_idx
  ON public.subscriptions (user_id);
CREATE INDEX subscriptions_stripe_subscription_id_idx
  ON public.subscriptions (stripe_subscription_id);
CREATE INDEX subscriptions_status_period_idx
  ON public.subscriptions (status, current_period_end);
