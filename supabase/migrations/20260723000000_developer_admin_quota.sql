-- Set developer account to admin (bypasses all quota limits) and raise
-- trial_ai_requests so testing never runs dry.
--
-- Admin plan in the Worker: aiRequestLimit = Infinity, all checks skipped.
-- trial_ai_requests now 1000 so even non-admin trial users can test freely.

UPDATE public.profiles
SET subscription_status = 'admin'
WHERE id = (
  SELECT id FROM auth.users WHERE email = 'info@sellatrend.com'
);

UPDATE public.platform_config
SET value = '1000'
WHERE key = 'trial_ai_requests';
