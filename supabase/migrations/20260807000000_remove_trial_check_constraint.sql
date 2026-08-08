-- CareerPersona AI — Trial Removal, Migration 1
-- Redefines profiles_subscription_status_check to drop trial_active/trial_expired
-- from the allowed values. New account lifecycle: no_subscription →
-- pro_active/premium_active. No code path writes trial_active/trial_expired
-- anymore (handleTrialActivate and its route were removed from worker.js).
--
-- Two existing rows currently hold subscription_status = 'trial_active' with
-- trial_ends_at already in the past (pg_cron's billing-trial-expiration-scan
-- job was never active on this project -- pg_cron extension is not installed --
-- so nothing ever wrote them to trial_expired). The application entitlement
-- layer (getCapabilities/computeBillingState) already treats any status outside
-- its known switch cases as Free/no-AI via the default branch, so this UPDATE
-- makes the stored column match the access level these accounts already have --
-- it does not change what either account can do. Without this normalization
-- step, a plain CHECK constraint add would fail outright (existing rows violate
-- the new allowed-values list), and a NOT VALID constraint would still reject
-- any future UPDATE to these same rows (Postgres re-checks the full row, not
-- just the changed columns), breaking unrelated profile edits for these users.
UPDATE public.profiles
SET    subscription_status = 'no_subscription'
WHERE  subscription_status IN ('trial_active', 'trial_expired');

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_subscription_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_status_check CHECK (
    subscription_status IN (
      'no_subscription',
      'pro_active',
      'pro_past_due',
      'pro_cancelled',
      'premium_active',
      'admin'
    )
  );
