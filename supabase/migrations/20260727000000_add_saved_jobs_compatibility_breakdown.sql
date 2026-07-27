-- Persists the full Career Compatibility Engine breakdown alongside the existing
-- top-line match_score/ats_score integers on saved_jobs. match_score itself is
-- unchanged in shape/meaning (still a plain 0-100 integer read by Dashboard,
-- SavedJobsPage, and OpportunityPage) -- this column adds the structured
-- {components, raw_components, gates, confidence, weights_version, computed_at}
-- detail behind it, written only when a job is saved (same timing as match_score
-- today). weights_version inside the jsonb lets historical scores stay
-- attributable to the scoring model that produced them as the model evolves.

alter table saved_jobs add column if not exists compatibility_breakdown jsonb;
