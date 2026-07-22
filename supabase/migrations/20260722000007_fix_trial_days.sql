-- CareerPersona AI — Subscription & Billing — Phase 1, Correction
-- Updates trial_days from the incorrect initial seed value (14) to the
-- Blueprint #3-specified value (7). The seed migration used 14 in error;
-- this migration corrects the live database value.

UPDATE public.platform_config
SET value = '7'
WHERE key = 'trial_days';
