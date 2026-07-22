-- CareerPersona AI — Subscription & Billing — Phase 1, Migration E
-- Creates ai_request_log, usage_daily_summary, stripe_events, webhook_dedup.
-- Blueprint #2 + #4: analytics logging, billing events, webhook idempotency.

-- E1. ai_request_log: analytics only, 90-day TTL (pg_cron weekly cleanup).
--     No PII — no IP addresses, no request content. Blueprint #4 compliance.
CREATE TABLE IF NOT EXISTS public.ai_request_log (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature     text    NOT NULL,  -- 'resume_analysis' | 'briefing' | 'interview_prep' | etc.
  model       text,
  tokens_in   integer,
  tokens_out  integer,
  period_key  text    NOT NULL,  -- matches the feature_usage.period_key for this request
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE public.ai_request_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own AI request log"
  ON public.ai_request_log
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON public.ai_request_log TO authenticated;

CREATE INDEX ai_request_log_user_created_idx
  ON public.ai_request_log (user_id, created_at DESC);
-- Used by the pg_cron cleanup job
CREATE INDEX ai_request_log_created_at_idx
  ON public.ai_request_log (created_at);

-- E2. usage_daily_summary: permanent aggregates populated nightly from ai_request_log.
--     PK enforces idempotent ON CONFLICT upsert in the pg_cron job.
CREATE TABLE IF NOT EXISTS public.usage_daily_summary (
  user_id       uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  summary_date  date    NOT NULL,
  feature       text    NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, summary_date, feature)
);

ALTER TABLE public.usage_daily_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage summary"
  ON public.usage_daily_summary
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON public.usage_daily_summary TO authenticated;

-- E3. stripe_events: records all Stripe webhook events for audit and billing history.
--     user_id SET NULL on delete — preserves financial records per GDPR / Blueprint #4.
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text    UNIQUE NOT NULL,
  event_type      text    NOT NULL,
  user_id         uuid    REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_cents    integer,
  currency        text,
  payload         jsonb   NOT NULL,
  processed_at    timestamptz DEFAULT now()
);

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- Users can view their own Stripe events (invoice/payment history in Settings)
CREATE POLICY "Users can view own stripe events"
  ON public.stripe_events
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON public.stripe_events TO authenticated;

CREATE INDEX stripe_events_user_processed_idx
  ON public.stripe_events (user_id, processed_at DESC);
-- Used for dedup check before full stripe_events write
CREATE INDEX stripe_events_stripe_event_id_idx
  ON public.stripe_events (stripe_event_id);

-- E4. webhook_dedup: idempotency guard for Stripe webhook processing.
--     Worker checks this before processing any webhook event.
--     No client access — service_role only (bypasses RLS).
CREATE TABLE IF NOT EXISTS public.webhook_dedup (
  stripe_event_id text        PRIMARY KEY,
  processed_at    timestamptz DEFAULT now()
);

ALTER TABLE public.webhook_dedup ENABLE ROW LEVEL SECURITY;
-- No RLS policies — only accessible via service_role (bypasses RLS)
-- This is intentional: no client should ever read or write this table directly
