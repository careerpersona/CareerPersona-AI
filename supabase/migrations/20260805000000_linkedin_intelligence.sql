-- LinkedIn Intelligence (Premium Feature #1, evolved from the existing Free
-- "LinkedIn Optimizer" tool). Per the locked blueprint
-- (docs/LinkedIn Intelligence Blueprint.md §6): replaces LinkedIn Optimizer's
-- session-only storage with real persistence, owned exclusively by LinkedIn
-- Intelligence. No other feature writes to this table.
--
-- Applies to ALL tiers -- not Premium-gated infrastructure. Free users get
-- their deterministic scores and generated content persisted; the Premium
-- gate applies to which columns get populated (strategy_analysis /
-- recruiter_visibility_intelligence are Premium-only), not to whether the
-- row exists at all.
--
-- Row-per-analysis (never row-per-user, never updated in place), matching
-- referral_analyses/outcome_analyses' append-only shape -- historical rows
-- must never be recalculated in place when deterministic formulas evolve.
-- New scoring versions produce new rows; weights_version records which
-- config produced each one, so historical comparisons (Profile Evolution
-- Tracking) stay attributable to the formula that actually generated them.

create table linkedin_profile_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  resume_id uuid references user_resumes(id) on delete set null,
  created_at timestamptz default now(),

  -- Deterministic (Free, all tiers) -- computed by
  -- src/lib/linkedinIntelligence/deterministicScoring.js. Never recomputed
  -- or overwritten in an existing row.
  completeness_score integer,
  completeness_breakdown jsonb,
  keyword_coverage_score integer,
  keywords_matched jsonb,
  keywords_missing jsonb,
  weights_version text not null default 'v1',

  -- Generated content (Free, all tiers) -- the existing LinkedIn Optimizer
  -- generation, now persisted instead of session-only (sessionStorage).
  headline text,
  about_section text,
  experience_optimizations jsonb,
  recruiter_visibility_tips jsonb,

  -- Interpretive (Premium only) -- populated starting Phase 3.
  strategy_analysis jsonb,
  recruiter_visibility_intelligence jsonb
);

alter table linkedin_profile_analyses enable row level security;

create policy "Users can manage own linkedin profile analyses" on linkedin_profile_analyses
  for all using (auth.uid() = user_id);

create index idx_linkedin_profile_analyses_user_id on linkedin_profile_analyses(user_id, created_at desc);
