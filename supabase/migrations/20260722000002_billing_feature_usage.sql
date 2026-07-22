-- CareerPersona AI — Subscription & Billing — Phase 1, Migration C
-- Creates feature_usage table with period_key pattern for atomic quota tracking.
-- Blueprint #2: feature_usage section.
--
-- period_key values:
--   'trial'  — absolute trial-period counts (never resets during trial)
--   'YYYY-MM' — monthly counts for Pro users (resets each calendar month)

CREATE TABLE IF NOT EXISTS public.feature_usage (
  user_id      uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature      text    NOT NULL,
  period_key   text    NOT NULL DEFAULT 'trial',
  usage_count  integer NOT NULL DEFAULT 0,
  last_used_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, feature, period_key)
);

ALTER TABLE public.feature_usage ENABLE ROW LEVEL SECURITY;

-- Users can read their own usage (for quota display in UI)
CREATE POLICY "Users can view own feature usage"
  ON public.feature_usage
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only service_role writes (via check_and_consume_quota RPC)
GRANT SELECT ON public.feature_usage TO authenticated;

-- Covered by the PRIMARY KEY but explicit for query planner clarity
CREATE INDEX feature_usage_user_feature_period_idx
  ON public.feature_usage (user_id, feature, period_key);
