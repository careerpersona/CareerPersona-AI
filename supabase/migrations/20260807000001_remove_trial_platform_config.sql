-- CareerPersona AI — Trial Removal, Migration 2
-- Removes the 5 trial-only platform_config rows. Confirmed via grep that no
-- code (worker.js, src/) reads config.trial_days, config.trial_ai_requests,
-- config.trial_resume_analyses, config.trial_interview_sessions, or
-- config.trial_salary_analyses anymore -- getCapabilities()'s trial_active
-- case was removed in the same change set that removed handleTrialActivate.
--
-- pro_ai_requests_monthly, grace_period_days, stripe_price_id_pro, and
-- stripe_publishable_key are untouched -- shared billing config, unrelated
-- to trial.

DELETE FROM public.platform_config
WHERE key IN (
  'trial_days',
  'trial_ai_requests',
  'trial_resume_analyses',
  'trial_interview_sessions',
  'trial_salary_analyses'
);
