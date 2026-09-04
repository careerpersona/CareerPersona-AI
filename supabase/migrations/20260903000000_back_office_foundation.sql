-- CareerPersona AI — Back Office, Work Order 1: secure foundation
-- Creates `staff` (Back Office authorization) and `admin_audit_log` (privileged
-- action trail). No other schema changes; no existing table, RLS policy, or
-- function is touched.
--
-- Design decisions:
--   - Authorization is a NEW, separate concept from profiles.subscription_status.
--     That column is (and remains) a billing-plan/quota label -- it is never
--     consulted by requireAdmin() in the Worker and must not be repurposed.
--   - Both tables have RLS enabled with ZERO policies, matching the existing
--     webhook_dedup pattern (see 20260722000004_billing_logs.sql) -- this
--     closes the table to `anon` and `authenticated` entirely. The only way
--     to read or write either table is the Worker's service_role connection,
--     which bypasses RLS by Supabase design. No Back Office UI or customer
--     client ever talks to these tables directly.
--   - A user can hold both a `profiles` row (customer) and a `staff` row
--     (Back Office operator) at the same time -- the two are independent.

-- 1. staff: who is allowed into the Back Office, and at what role.
--    One row per user (UNIQUE user_id) -- role changes and revocations are
--    UPDATEs, not new rows. `granted_by` is nullable: the very first
--    superadmin is inserted by hand (no granting admin exists yet).
CREATE TABLE IF NOT EXISTS public.staff (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('support', 'billing_ops', 'superadmin')),
  granted_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  active      boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role only (bypasses RLS). Intentional: no client
-- (anon or authenticated, customer or staff) may ever read or write this
-- table directly. The Worker's requireAdmin() is the sole consumer.

CREATE INDEX staff_user_id_active_idx ON public.staff (user_id) WHERE active = true;

CREATE TRIGGER update_staff_updated_at BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2. admin_audit_log: append-only trail of every privileged Back Office action.
--    actor_user_id / target_user_id SET NULL on delete (not CASCADE) — an
--    audit record must outlive the accounts it references, matching the
--    stripe_events precedent for records that must survive account deletion.
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role     text        NOT NULL,
  action         text        NOT NULL,
  target_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  before         jsonb,
  after          jsonb,
  metadata       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role only (bypasses RLS), same rationale as staff.

CREATE INDEX admin_audit_log_actor_idx  ON public.admin_audit_log (actor_user_id, created_at DESC);
CREATE INDEX admin_audit_log_target_idx ON public.admin_audit_log (target_user_id, created_at DESC);
CREATE INDEX admin_audit_log_action_idx ON public.admin_audit_log (action, created_at DESC);
