-- CareerPersona AI — Back Office: AI Usage & Cost historical retention
-- correction. ai_request_log is a 90-day ledger by design (pg_cron cleanup,
-- 20260722000006_billing_cron.sql); cost/error/latency (added to it by
-- 20260905000000_ai_usage_metering.sql) would otherwise be lost forever once
-- a row ages out. usage_daily_summary is the existing PERMANENT aggregate --
-- it already survives the 90-day cleanup, so it becomes the long-term
-- historical source for these fields instead of inventing a new table.
--
-- Minimum necessary change: three summed columns (cost is additive across a
-- day; latency is kept as a sum + the existing request_count so an average
-- is still reconstructable later -- a daily aggregate was never going to
-- preserve per-request percentiles, that's an inherent, disclosed trade-off
-- of aggregating by day, not something this migration can or should work
-- around).

ALTER TABLE public.usage_daily_summary
  ADD COLUMN cost_usd       numeric(10, 6) NOT NULL DEFAULT 0,
  ADD COLUMN error_count    integer        NOT NULL DEFAULT 0,
  ADD COLUMN latency_sum_ms bigint         NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.usage_daily_summary.cost_usd is 'Sum of ai_request_log.cost_usd for this user/feature/day -- the permanent record once the source row ages out of the 90-day ledger.';
COMMENT ON COLUMN public.usage_daily_summary.error_count is 'Count of ai_request_log rows with success = false for this user/feature/day.';
COMMENT ON COLUMN public.usage_daily_summary.latency_sum_ms is 'Sum of ai_request_log.latency_ms for this user/feature/day. Divide by request_count for an average; per-request percentiles are not reconstructable from a daily aggregate.';

-- Re-schedule the existing job (same name -- cron.schedule() upserts by job
-- name, this is the standard way to change a pg_cron job's command without
-- editing the migration that first created it) to also roll up the three
-- new columns. Same free-tier no-op guard as the original migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available. billing-daily-usage-aggregation not re-scheduled (still using its prior definition, itself a no-op on this tier).';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'billing-daily-usage-aggregation',
    '15 0 * * *',
    $sql$
      INSERT INTO public.usage_daily_summary
        (user_id, summary_date, feature, request_count, tokens_in, tokens_out, cost_usd, error_count, latency_sum_ms)
      SELECT
        user_id,
        created_at::date         AS summary_date,
        feature,
        COUNT(*)                                  AS request_count,
        COALESCE(SUM(tokens_in),  0)               AS tokens_in,
        COALESCE(SUM(tokens_out), 0)               AS tokens_out,
        COALESCE(SUM(cost_usd),   0)               AS cost_usd,
        COALESCE(SUM((NOT success)::int), 0)       AS error_count,
        COALESCE(SUM(latency_ms), 0)               AS latency_sum_ms
      FROM public.ai_request_log
      WHERE created_at::date = CURRENT_DATE - 1
      GROUP BY user_id, created_at::date, feature
      ON CONFLICT (user_id, summary_date, feature) DO UPDATE
        SET request_count  = EXCLUDED.request_count,
            tokens_in      = EXCLUDED.tokens_in,
            tokens_out     = EXCLUDED.tokens_out,
            cost_usd       = EXCLUDED.cost_usd,
            error_count    = EXCLUDED.error_count,
            latency_sum_ms = EXCLUDED.latency_sum_ms;
    $sql$
  );

  RAISE NOTICE 'billing-daily-usage-aggregation re-scheduled: now also rolls up cost_usd, error_count, latency_sum_ms.';
END;
$$;
