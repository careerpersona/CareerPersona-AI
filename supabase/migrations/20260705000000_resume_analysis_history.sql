-- Resume Analysis History: persists every analysis and improvement event per user.
-- Used as the single source of truth for Resume Performance Analytics.
-- localStorage is a read-through cache populated/invalidated by the frontend hook.
CREATE TABLE IF NOT EXISTS resume_analysis_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resume_id      uuid        REFERENCES user_resumes(id) ON DELETE SET NULL,
  resume_name    text,
  ats_score      integer,
  potential_ats_score integer,
  job_title      text,
  company        text,
  analysis_type  text        NOT NULL DEFAULT 'Initial Analysis',
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE resume_analysis_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own resume_analysis_history"
  ON resume_analysis_history FOR ALL
  USING (auth.uid() = user_id);

-- Newest-first index — the frontend always queries ordered by created_at DESC LIMIT 50.
CREATE INDEX IF NOT EXISTS resume_analysis_history_user_created
  ON resume_analysis_history (user_id, created_at DESC);
