-- Extend resume_analysis_history with three future-proof optional fields.
-- All columns are nullable so existing rows are unaffected and the INSERT
-- path is backwards-compatible — callers that don't supply a value get NULL.
ALTER TABLE resume_analysis_history
  ADD COLUMN IF NOT EXISTS analysis_mode  text,   -- 'Uploaded Resume' | 'AI Resume Creator'
  ADD COLUMN IF NOT EXISTS resume_status  text,   -- 'Draft' | 'Optimized'
  ADD COLUMN IF NOT EXISTS resume_health  text;   -- 'Poor' | 'Fair' | 'Good' | 'Excellent'
