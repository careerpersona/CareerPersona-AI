-- CareerPersona AI — Back Office, Work Order 7: Support Cases & Internal Notes
-- Creates support_cases and support_case_notes. No other schema changes.
--
-- Design decisions:
--   - Same "RLS enabled, zero policies" pattern as staff/admin_audit_log
--     (20260903000000_back_office_foundation.sql) -- closes both tables to
--     `anon`/`authenticated` entirely. The only way to read or write either
--     table is the Worker's service_role connection. No Back Office UI or
--     customer client ever talks to these tables directly, and neither is
--     ever included in any customer-facing API response (internal-only by
--     construction, not just by convention).
--   - user_id references auth.users(id) ON DELETE CASCADE, matching every
--     other per-customer table in this schema (applications,
--     smart_apply_queue, etc.) rather than introducing profiles(id) as a
--     one-off FK target.
--   - created_by / assigned_to / author_id reference auth.users(id) ON
--     DELETE SET NULL -- same rationale as admin_audit_log.actor_user_id:
--     a staff member's account being removed must never delete or orphan
--     support history, only null out who did it.
--   - support_case_notes.case_id is ON DELETE CASCADE from support_cases,
--     so deleting a case (e.g. via the account-deletion purge, which this
--     migration adds "support_cases" to) takes its notes with it without a
--     second explicit delete.

CREATE TABLE IF NOT EXISTS public.support_cases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  priority     text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  subject      text        NOT NULL,
  description  text,
  created_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role only (bypasses RLS). Intentional: no
-- client, customer or staff, may ever read or write this table directly.

CREATE INDEX support_cases_user_id_idx     ON public.support_cases (user_id);
CREATE INDEX support_cases_status_idx      ON public.support_cases (status);
CREATE INDEX support_cases_assigned_to_idx ON public.support_cases (assigned_to);
CREATE INDEX support_cases_created_at_idx  ON public.support_cases (created_at DESC);

CREATE TRIGGER update_support_cases_updated_at BEFORE UPDATE ON public.support_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS public.support_case_notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid        NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
  author_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  note       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.support_case_notes ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role only, same rationale as support_cases.
-- Work Order 7, item 7: internal notes are staff-only data and must never
-- be reachable from a customer-facing API — this is enforced structurally
-- here (no policy grants anon/authenticated anything), not just by the
-- Worker choosing not to return them.

CREATE INDEX support_case_notes_case_id_idx ON public.support_case_notes (case_id, created_at);

-- Account-deletion purge (worker.js, ACCOUNT_DELETION_TABLES) must also
-- clear a deleted customer's support cases -- add it to that list (its own
-- comment there documents why: the purge explicitly deletes from every
-- listed table before removing the auth user/profiles row, rather than
-- relying on FK cascade timing). support_case_notes is NOT added
-- separately: it cascades automatically once its parent support_cases row
-- is deleted, per the ON DELETE CASCADE above.
comment on table public.support_cases is 'Work Order 7. Must remain listed in worker.js ACCOUNT_DELETION_TABLES.';
