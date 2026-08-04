-- Smart Apply Auto Prep -- Daily Cron & Budget Boundary Verification finding.
-- enqueueAutoPrepRow (worker.js) and the client's enqueue() (src/data/smartApply.js)
-- both dedup via a SELECT-then-INSERT check ("does a non-terminal row already
-- exist for this job?"), which is not atomic. A redelivered/duplicate cron
-- invocation (Cloudflare Cron Triggers do not guarantee exactly-once
-- delivery) or a client-side double-click/multi-tab race could both pass the
-- SELECT before either INSERT commits, producing two rows for the same job.
--
-- This index makes the dedup rule a database-level invariant instead of an
-- application-level convention -- "at most one non-terminal row per
-- (user_id, job_id)" is now true regardless of which code path, or how many
-- concurrent callers, attempt to enqueue the same job. Additive only: no
-- existing data is modified, and it cannot fail unless a duplicate
-- non-terminal row already exists (none expected, but if creation fails,
-- that itself would surface a pre-existing data integrity issue worth
-- investigating, not silently working around).

CREATE UNIQUE INDEX IF NOT EXISTS smart_apply_queue_active_job_uidx
  ON smart_apply_queue (user_id, job_id)
  WHERE status NOT IN ('applied', 'skipped');
