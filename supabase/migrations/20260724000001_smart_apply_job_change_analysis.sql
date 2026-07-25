-- AI-generated change summary for a saved job whose posting was updated after
-- the application package was prepared.  Populated on first view of the
-- Job Posting Changes section in PackageView; never overwritten by the sync layer.

ALTER TABLE smart_apply_queue
  ADD COLUMN IF NOT EXISTS job_change_analysis jsonb;
