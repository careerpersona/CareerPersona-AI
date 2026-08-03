-- Proactive Job Alerts (Premium Feature #4). Locked blueprint:
-- https://claude.ai/code/artifact/779890b3-2265-42d7-b86f-94e78d2d56db
--
-- Implementation notes (deviations from the blueprint's literal SQL, resolved
-- against current architecture rather than escalated -- see implementation
-- report):
--   1. No `company_watchlist.is_dream_company` column. "Dream company" is
--      already fully expressed by the existing `company_watchlist.status =
--      'dream_company'` value (used throughout App.jsx, userContext.js, and
--      the frozen scoringEngine.js) -- a second boolean would duplicate that
--      fact, not add one. Analysis 04's dream-company tier boost reads the
--      existing status column directly.
--   2. gen_random_uuid(), not uuid_generate_v4() -- matches every other
--      migration in this project (the blueprint's uuid_generate_v4() was the
--      one inconsistent legacy reference in the whole migration history).

-- Universal evaluation log (platform discovery memory). Append-only per
-- Architectural Rule 3 -- rows are created for every evaluated opportunity
-- and updated as lifecycle_status advances, never deleted.
create table alert_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null,
  job_title text not null,
  company text not null,
  source text not null,
  match_score integer,
  alert_tier text,
  confidence_tier text,
  lifecycle_status text not null default 'discovered',
  discard_reason text,
  urgency_factors jsonb,
  signal_enrichments jsonb,
  previous_tier text,
  tier_change_reason text,
  estimated_close_date date,
  posted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);

alter table alert_candidates enable row level security;
create policy "Users can manage own alert candidates" on alert_candidates for all using (auth.uid() = user_id);
create trigger update_alert_candidates_updated_at before update on alert_candidates for each row execute function update_updated_at();
create index idx_alert_candidates_user_lifecycle on alert_candidates(user_id, lifecycle_status);
create index idx_alert_candidates_user_tier on alert_candidates(user_id, alert_tier) where alert_tier is not null;

-- Delivered alerts (what the user actually received -- distinct from every
-- evaluated candidate above).
create table alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references alert_candidates(id) on delete cascade,
  digest_type text not null,
  delivered_at timestamptz default now(),
  engaged_at timestamptz,
  dismissed_at timestamptz,
  application_id uuid references applications(id) on delete set null,
  created_at timestamptz default now()
);

alter table alerts enable row level security;
create policy "Users can manage own alerts" on alerts for all using (auth.uid() = user_id);
create index idx_alerts_user_delivered on alerts(user_id, delivered_at desc);

-- Market-level signals (role volume, salary trends, speed-of-fill) --
-- Analysis 03 (Market Intelligence) and Analysis 06 (Timing Intelligence)'s
-- persisted output.
create table market_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_type text not null,
  scope text not null,
  role_category text,
  industry text,
  location text,
  value jsonb not null,
  observed_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table market_signals enable row level security;
create policy "Users can manage own market signals" on market_signals for all using (auth.uid() = user_id);
create index idx_market_signals_user_type on market_signals(user_id, signal_type, observed_at desc);

-- AI learning weights -- updated by Analysis 05 (Alert Effectiveness) and
-- Analysis 06 (Timing Intelligence)'s self-correction loops.
create table alert_learning_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weight_type text not null,
  category text,
  weight_value numeric not null,
  data_points integer default 0,
  last_updated_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (user_id, weight_type, category)
);

alter table alert_learning_weights enable row level security;
create policy "Users can manage own alert learning weights" on alert_learning_weights for all using (auth.uid() = user_id);

-- Existing-table extensions (additive only).
alter table saved_jobs add column if not exists alert_source_id uuid references alert_candidates(id) on delete set null;
alter table applications add column if not exists alert_source_id uuid references alert_candidates(id) on delete set null;
