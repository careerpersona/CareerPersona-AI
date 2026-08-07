-- Resets trial_ai_requests to its originally-designed value (10). A prior
-- developer-testing migration (20260723000000_developer_admin_quota.sql)
-- raised it to 1000 so the developer's own trial account wouldn't run dry
-- during testing, but that value was never reverted before this quota audit
-- caught it live in platform_config. Left at 1000, an unresolved 7-day trial
-- could cost up to ~$70 in Anthropic spend before ever converting to paid.
--
-- Developer admin status (subscription_status = 'admin', unlimited, set by
-- that same migration) is untouched -- that account bypasses quota checks
-- entirely and was never affected by this value.

UPDATE public.platform_config
SET value = '10'
WHERE key = 'trial_ai_requests';
