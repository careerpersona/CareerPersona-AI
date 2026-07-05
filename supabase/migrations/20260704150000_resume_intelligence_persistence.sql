-- Resume Intelligence: persist AI analysis results per resume and link applications
-- back to the resume that was analyzed.
--
-- Analysis columns on user_resumes:
--   ats_score / potential_ats_score  — last AI analysis score for this resume (0-100)
--   keywords_found / keywords_missing — arrays from the ATS keyword analysis
--   suggestions                       — full suggestions array (jsonb)
--   score_breakdown                   — {keywordMatch, formatting, relevance}
--   top_priority                      — most impactful suggestion (suggestions[0])
--   last_analyzed_at                  — when the analysis was last persisted
--   version_label                     — optional user-editable label (e.g. "Senior Eng v2")
ALTER TABLE user_resumes
  ADD COLUMN IF NOT EXISTS ats_score integer,
  ADD COLUMN IF NOT EXISTS potential_ats_score integer,
  ADD COLUMN IF NOT EXISTS keywords_found text[],
  ADD COLUMN IF NOT EXISTS keywords_missing text[],
  ADD COLUMN IF NOT EXISTS suggestions jsonb,
  ADD COLUMN IF NOT EXISTS score_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS top_priority text,
  ADD COLUMN IF NOT EXISTS last_analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS version_label text;

-- Link applications back to the resume row that was used during analysis.
-- ON DELETE SET NULL: preserves the application record if the resume is later deleted,
-- consistent with the smart_apply_queue FK pattern.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS resume_id uuid REFERENCES user_resumes(id) ON DELETE SET NULL;
