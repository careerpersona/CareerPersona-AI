-- smart_apply_queue is missing job_description, which the enqueue() insert has
-- always sent. The column was never included in the original CREATE TABLE
-- (20260629082009_add_module_tables.sql), causing every Smart Apply insert to
-- fail with PGRST204 in production.

ALTER TABLE smart_apply_queue ADD COLUMN IF NOT EXISTS job_description text;
