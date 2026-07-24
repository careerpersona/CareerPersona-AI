-- Synchronization support for saved_jobs.
--
-- previous_description: snapshot of the job description before the most recent
--   sync, captured the moment a description change is detected. Enables the
--   Employer Change Intelligence phase to compare old vs new content without
--   additional API calls or AI generation.
--
-- last_synced_at: timestamp of the most recent lightweight sync run. Lets the
--   next phase know how fresh the stored employer data is.

ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS previous_description text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
