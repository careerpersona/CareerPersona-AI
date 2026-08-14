-- CareerPersona AI — Account Deletion & Data Export (Phase 7, Part A)
--
-- Two independent pieces of server-side state, for two different purposes:
--
-- 1. profiles.deletion_status / deletion_requested_at / deletion_scheduled_purge_at
--    -- the CLIENT-FACING lock. Read fresh on every session sync (fetchProfile),
--    never cached client-side, so the locked state is enforced on every
--    device/session/token-refresh, not just at login. Lifecycle: null ->
--    'scheduled' (request-deletion) -> 'in_progress' (purge cron picks it up).
--    Never reaches 'completed' -- the profiles row itself is deleted as part
--    of the purge, before completion is ever recorded (see below), so
--    'completed' is intentionally not a legal value here.
--
-- 2. account_deletion_log -- the SERVER-SIDE-ONLY purge tracking/completion
--    record. profiles is deleted partway through the purge (Storage -> 38
--    tables -> Auth user -> profiles -> KV), so nothing on profiles can be
--    used to represent final completion or to drive retry of the purge's
--    tail end once profiles is gone. This table is created at request time,
--    is what the purge scheduler actually queries (independent of whether
--    profiles still exists), and is itself never deleted by the purge --
--    only anonymized in place once the purge fully succeeds, then removed
--    automatically 12 months later (see cleanupExpiredDeletionLogs in
--    worker.js). No RLS policies: written and read only by the Worker via
--    service_role, never exposed to any client.
--
--    `id` (not `user_id`) is the primary key precisely because `user_id`
--    does not survive completion -- it's the one column that gets nulled
--    out by the anonymization step, so it can't also be what uniquely
--    identifies the row. Lifecycle:
--      'scheduled' (request-deletion; user_id set, deletion_event_id null)
--      -> 'in_progress' (purge cron picks it up)
--      -> 'completed' (written by ONE atomic UPDATE, in worker.js, that
--         simultaneously nulls user_id, generates and sets a fresh,
--         cryptographically random deletion_event_id unrelated to user_id,
--         and sets completed_at -- never a DELETE+INSERT, so the row is
--         never absent between "identifiable" and "anonymized"; a crash
--         before that UPDATE commits leaves user_id intact and the row
--         still findable by the scheduler, a crash after leaves it fully
--         anonymized and complete -- there is no partial state a retry can
--         observe).
--
--    The 12-month retention window for the anonymized record is an
--    operational product decision for now, not a legal conclusion -- it
--    requires legal review before being reflected in any published Privacy
--    Policy / retention policy.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deletion_status text,
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_purge_at timestamptz;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_deletion_status_check CHECK (
    deletion_status IS NULL OR deletion_status IN ('scheduled', 'in_progress')
  );

CREATE TABLE IF NOT EXISTS public.account_deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  deletion_event_id uuid UNIQUE,
  requested_at timestamptz NOT NULL,
  scheduled_purge_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed')),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS account_deletion_log_user_id_idx ON public.account_deletion_log (user_id);
CREATE INDEX IF NOT EXISTS account_deletion_log_retention_idx ON public.account_deletion_log (status, completed_at);

ALTER TABLE public.account_deletion_log ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies -- service_role (the Worker) bypasses RLS for all
-- reads/writes; no authenticated-user policy is added because this table is
-- never meant to be readable by any client, at any point in its lifecycle.
