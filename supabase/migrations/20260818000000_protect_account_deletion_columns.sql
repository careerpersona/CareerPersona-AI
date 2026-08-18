-- CareerPersona AI — Phase 8, Finding C2 — Protect account-deletion columns
--
-- The Phase 8 auth/session security audit found that profiles.deletion_status,
-- profiles.deletion_requested_at, and profiles.deletion_scheduled_purge_at are
-- part of the account-deletion security boundary (the 20260811000000_account_
-- deletion.sql migration's own header calls deletion_status "the CLIENT-FACING
-- lock") but, unlike the sibling billing columns added in
-- 20260722000000_billing_profiles.sql, were never added to the
-- protect_billing_columns() trigger's protected-column list. That left them
-- writable directly by an authenticated client via RLS, letting a user set or
-- clear their own deletion lock without going through the Worker's
-- request-deletion/cancel-deletion endpoints — including the ability to clear
-- the visible lock while a real, service-role-driven deletion (tracked in
-- account_deletion_log, independent of these profiles columns) is still
-- scheduled to run.
--
-- This migration is purely additive: it does not touch
-- 20260811000000_account_deletion.sql, does not drop the existing
-- billing_column_protection trigger, and does not remove or alter protection
-- for any of the 9 existing billing columns. It replaces the trigger
-- function's body (CREATE OR REPLACE — the trigger itself, which references
-- the function by name, is untouched) to add the same auth.role() check for
-- the 3 deletion columns alongside the 9 already-protected billing columns.
--
-- The exception message is broadened from "Billing columns are managed by
-- the server..." to a wording that also correctly describes a rejected
-- deletion-column write, since the old message would have been factually
-- wrong when raised for a deletion-field change. No other behavior changes.

CREATE OR REPLACE FUNCTION public.protect_billing_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- auth.role() returns NULL in pg_cron, migration, and direct postgres contexts.
  -- service_role is the Worker; postgres is the superuser / migration runner.
  IF auth.role() IS NULL OR auth.role() IN ('service_role', 'postgres') THEN
    RETURN NEW;
  END IF;

  IF (OLD.subscription_status     IS DISTINCT FROM NEW.subscription_status)
    OR (OLD.trial_started_at      IS DISTINCT FROM NEW.trial_started_at)
    OR (OLD.trial_ends_at         IS DISTINCT FROM NEW.trial_ends_at)
    OR (OLD.stripe_customer_id    IS DISTINCT FROM NEW.stripe_customer_id)
    OR (OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id)
    OR (OLD.current_period_start  IS DISTINCT FROM NEW.current_period_start)
    OR (OLD.current_period_end    IS DISTINCT FROM NEW.current_period_end)
    OR (OLD.cancel_at_period_end  IS DISTINCT FROM NEW.cancel_at_period_end)
    OR (OLD.grace_period_ends_at  IS DISTINCT FROM NEW.grace_period_ends_at)
  THEN
    RAISE EXCEPTION 'Billing columns are managed by the server. Use the API to manage your subscription.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (OLD.deletion_status             IS DISTINCT FROM NEW.deletion_status)
    OR (OLD.deletion_requested_at      IS DISTINCT FROM NEW.deletion_requested_at)
    OR (OLD.deletion_scheduled_purge_at IS DISTINCT FROM NEW.deletion_scheduled_purge_at)
  THEN
    RAISE EXCEPTION 'Account-deletion columns are managed by the server. Use the API to request or cancel account deletion.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- No CREATE TRIGGER statement: billing_column_protection (created in
-- 20260722000000_billing_profiles.sql) already executes this function by
-- name on every UPDATE to public.profiles, so replacing the function body
-- in place is sufficient and takes effect immediately for that existing
-- trigger — nothing about the trigger definition itself needs to change.
