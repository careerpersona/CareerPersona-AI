-- Add salary_insight and company_insight to smart_apply_queue
-- These are V1 blueprint-approved Smart Apply package outputs (promoted 2026-07-01).

ALTER TABLE smart_apply_queue ADD COLUMN IF NOT EXISTS salary_insight jsonb;
ALTER TABLE smart_apply_queue ADD COLUMN IF NOT EXISTS company_insight jsonb;
