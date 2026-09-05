-- CareerPersona AI — Back Office: AI Usage & Cost metering
-- Extends the existing ai_request_log table (20260722000004_billing_logs.sql)
-- rather than creating a new one -- every column this dashboard needs is a
-- per-call fact that belongs on the same row as the request it describes.
-- No other schema change: usage_daily_summary is left untouched (it lacks
-- cost/error/latency and is pg_cron-owned, not worker.js-owned; the
-- dashboard's today/7d/30d windows are all comfortably inside
-- ai_request_log's existing 90-day retention, so no new aggregate table or
-- job is needed).
--
-- Backfill: existing rows were only ever written on a successful Anthropic
-- call (see worker.js's pre-existing logAIRequest), so DEFAULT true for
-- `success` is factually correct for 100% of history, not a guess.

ALTER TABLE public.ai_request_log
  ADD COLUMN success    boolean NOT NULL DEFAULT true,
  ADD COLUMN error_code text,
  ADD COLUMN latency_ms integer,
  ADD COLUMN cost_usd   numeric(10, 6);

COMMENT ON COLUMN public.ai_request_log.success is 'false = the Anthropic call itself failed (see error_code); token/cost columns are null in that case unless Anthropic still returned partial usage.';
COMMENT ON COLUMN public.ai_request_log.error_code is 'Anthropic HTTP status or a short internal code, e.g. "500". Null when success = true.';
COMMENT ON COLUMN public.ai_request_log.latency_ms is 'Wall-clock time for the Anthropic fetch() call, in milliseconds.';
COMMENT ON COLUMN public.ai_request_log.cost_usd is 'Computed at write time from tokens_in/tokens_out and the model''s per-token rate at that time (worker.js AI_MODEL_PRICING) -- historically accurate even if pricing changes later.';
