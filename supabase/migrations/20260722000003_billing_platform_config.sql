-- CareerPersona AI — Subscription & Billing — Phase 1, Migration D
-- Creates platform_config table — all business values in one place.
-- Blueprint #2: platform_config section. No hardcoded billing constants anywhere in code.
--
-- To adjust any limit or price: UPDATE platform_config SET value = '...' WHERE key = '...'.
-- No code deploy required.

CREATE TABLE IF NOT EXISTS public.platform_config (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read config values (for UI display of limits)
CREATE POLICY "Authenticated users can read platform config"
  ON public.platform_config
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.platform_config TO authenticated;

-- Seed: all business values
INSERT INTO public.platform_config (key, value, description) VALUES
  ('trial_days',                '7',   'Number of days in the trial period'),
  ('trial_ai_requests',         '10',  'Total AI requests allowed during the trial period'),
  ('trial_resume_analyses',     '3',   'Resume analyses allowed during the trial period'),
  ('trial_interview_sessions',  '3',   'Interview sessions allowed during the trial period'),
  ('trial_salary_analyses',     '2',   'Salary analyses allowed during the trial period'),
  ('pro_ai_requests_monthly',   '500', 'AI requests allowed per calendar month on Pro plan'),
  ('grace_period_days',         '14',  'Grace period after payment failure (matches Stripe Smart Retry window)'),
  ('stripe_price_id_pro',       '',    'Stripe Price ID for Pro plan monthly — set via dashboard before enabling checkout'),
  ('stripe_publishable_key',    '',    'Stripe publishable key — set via dashboard, used by frontend checkout')
ON CONFLICT (key) DO NOTHING;
