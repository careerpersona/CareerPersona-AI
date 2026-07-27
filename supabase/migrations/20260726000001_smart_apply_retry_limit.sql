-- Tracks how many times a smart_apply_queue row has failed generation, so
-- enqueue() can stop automatically regenerating a job that keeps failing
-- (previously: any "failed" row was silently reset and re-billed every time
-- the same job was rediscovered in a later search, with no limit).

ALTER TABLE smart_apply_queue ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
