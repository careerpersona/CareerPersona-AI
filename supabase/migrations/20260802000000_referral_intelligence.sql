-- Referral Intelligence (Premium Feature #3). Persists only the AI narrative --
-- relationship-strength and company-readiness scores are computed live from
-- existing tables (networking_contacts, company_watchlist, applications,
-- outcome_patterns) via src/lib/referralIntelligence/scoringEngine.js, never
-- persisted here. Mirrors outcome_analyses' shape: one row per "Run Analysis"
-- click, never updated in place, most recent read via generated_at desc.

create table referral_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generated_at timestamptz default now(),
  contact_count integer not null default 0,
  company_count integer not null default 0,
  content jsonb not null
);

alter table referral_analyses enable row level security;

create policy "Users can manage own referral analyses" on referral_analyses
  for all using (auth.uid() = user_id);

create index idx_referral_analyses_user_id on referral_analyses(user_id, generated_at desc);
