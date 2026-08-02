-- Application Outcome Intelligence (Premium Feature #2) -- schema per the locked
-- blueprint's §15 Data Specification. resume_version_id is intentionally NOT added
-- here: applications.resume_id already exists and serves the same purpose (see
-- src/data/applications.js toRow/fromRow) -- reused instead of duplicated.

alter table applications add column if not exists response_status text not null default 'pending'
  check (response_status in ('pending','interview_invited','rejected','ghosted','offer','withdrawn'));
alter table applications add column if not exists response_received_at timestamptz;
alter table applications add column if not exists rejection_stage text
  check (rejection_stage is null or rejection_stage in ('ats','phone_screen','technical','final_round','offer_stage'));
alter table applications add column if not exists first_interview_at timestamptz;
alter table applications add column if not exists application_source text
  check (application_source is null or application_source in ('linkedin','indeed','company_website','referral','direct'));
alter table applications add column if not exists cover_letter_sent boolean not null default false;
alter table applications add column if not exists smart_apply_used boolean not null default false;
alter table applications add column if not exists smart_apply_queue_item_id uuid references smart_apply_queue(id) on delete set null;
alter table applications add column if not exists smart_apply_score integer;
alter table applications add column if not exists days_since_posted integer;
alter table applications add column if not exists company_size_estimate text
  check (company_size_estimate is null or company_size_estimate in ('startup','small','mid','large','enterprise'));
alter table applications add column if not exists industry text;
alter table applications add column if not exists remote_policy text
  check (remote_policy is null or remote_policy in ('remote','hybrid','onsite'));
alter table applications add column if not exists referral_used boolean not null default false;
alter table applications add column if not exists salary_range_min numeric;
alter table applications add column if not exists salary_range_max numeric;

create table if not exists outcome_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generated_at timestamptz not null default now(),
  period_start timestamptz not null,
  period_end timestamptz not null,
  application_count integer not null default 0,
  outcomes_logged_count integer not null default 0,
  confidence_tier text not null check (confidence_tier in ('early_signal','emerging','high_confidence')),
  analysis jsonb not null,
  created_at timestamptz not null default now()
);
alter table outcome_analyses enable row level security;
create policy "Users can manage own outcome analyses" on outcome_analyses for all using (auth.uid() = user_id);
create index if not exists outcome_analyses_user_generated_idx on outcome_analyses(user_id, generated_at desc);

create table if not exists outcome_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pattern_type text not null check (pattern_type in ('company_size','industry','timing','cover_letter','smart_apply','resume_version','referral','remote_policy','salary_range')),
  pattern_value text not null,
  direction text not null check (direction in ('positive','negative','neutral')),
  stability text not null check (stability in ('stable','changing','volatile')),
  confidence text not null check (confidence in ('early_signal','emerging','high_confidence')),
  response_rate numeric not null,
  sample_size integer not null,
  data_completeness numeric not null,
  first_observed timestamptz not null default now(),
  last_updated timestamptz not null default now(),
  previous_direction text check (previous_direction is null or previous_direction in ('positive','negative','neutral')),
  unique (user_id, pattern_type, pattern_value)
);
alter table outcome_patterns enable row level security;
create policy "Users can manage own outcome patterns" on outcome_patterns for all using (auth.uid() = user_id);
create index if not exists outcome_patterns_user_type_idx on outcome_patterns(user_id, pattern_type);

create table if not exists recommendation_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recommendation_text text not null,
  target_metric text not null,
  applied_at timestamptz not null default now(),
  evaluation_due_at timestamptz not null,
  metric_before numeric,
  metric_after numeric,
  evaluation_result text check (evaluation_result is null or evaluation_result in ('confirmed','no_change','insufficient_data')),
  created_at timestamptz not null default now()
);
alter table recommendation_evaluations enable row level security;
create policy "Users can manage own recommendation evaluations" on recommendation_evaluations for all using (auth.uid() = user_id);
create index if not exists recommendation_evaluations_user_due_idx on recommendation_evaluations(user_id, evaluation_due_at);
