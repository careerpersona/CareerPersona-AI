-- CareerPersona AI — Subscription & Billing — Phase 1, Migration G
-- Schedules pg_cron jobs for SQL-side billing maintenance.
-- Blueprint #4: pg_cron job ownership (pure SQL jobs only — KV/Stripe/HTTP jobs use Cloudflare Cron Triggers).
--
-- REQUIREMENT: pg_cron extension (Supabase Pro plan).
-- This migration is a safe no-op on the free tier — it logs a notice and returns without error.
-- Enable these jobs by upgrading to Supabase Pro and re-running this migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available. Billing cron jobs will not be scheduled. Upgrade to Supabase Pro to activate: billing-trial-expiration-scan, billing-daily-usage-aggregation, billing-ai-log-cleanup.';
    RETURN;
  END IF;

  -- G1. Trial expiration scan: daily at 00:05 UTC
  --     Marks users whose trial period has ended as trial_expired.
  --     The protect_billing_columns trigger allows NULL-role context (pg_cron) to write.
  PERFORM cron.schedule(
    'billing-trial-expiration-scan',
    '5 0 * * *',
    $sql$
      UPDATE public.profiles
      SET    subscription_status = 'trial_expired'
      WHERE  subscription_status = 'trial_active'
        AND  trial_ends_at < now();
    $sql$
  );

  -- G2. Daily usage aggregation: 00:15 UTC
  --     Aggregates yesterday's ai_request_log into usage_daily_summary (permanent store).
  --     Runs after trial expiration so same-day edge cases land in the right state.
  PERFORM cron.schedule(
    'billing-daily-usage-aggregation',
    '15 0 * * *',
    $sql$
      INSERT INTO public.usage_daily_summary
        (user_id, summary_date, feature, request_count, tokens_in, tokens_out)
      SELECT
        user_id,
        created_at::date         AS summary_date,
        feature,
        COUNT(*)                 AS request_count,
        COALESCE(SUM(tokens_in),  0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out
      FROM public.ai_request_log
      WHERE created_at::date = CURRENT_DATE - 1
      GROUP BY user_id, created_at::date, feature
      ON CONFLICT (user_id, summary_date, feature) DO UPDATE
        SET request_count = EXCLUDED.request_count,
            tokens_in     = EXCLUDED.tokens_in,
            tokens_out    = EXCLUDED.tokens_out;
    $sql$
  );

  -- G3. ai_request_log 90-day TTL cleanup: Sunday at 03:00 UTC
  --     usage_daily_summary preserves permanent aggregates; raw log is time-limited.
  PERFORM cron.schedule(
    'billing-ai-log-cleanup',
    '0 3 * * 0',
    $sql$
      DELETE FROM public.ai_request_log
      WHERE created_at < now() - INTERVAL '90 days';
    $sql$
  );

  RAISE NOTICE 'pg_cron billing jobs scheduled: billing-trial-expiration-scan (daily 00:05), billing-daily-usage-aggregation (daily 00:15), billing-ai-log-cleanup (Sunday 03:00).';
END;
$$;
