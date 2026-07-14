-- Job Intelligence: one AI landscape analysis per user per day
create table job_intelligence_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_date date not null default current_date,
  content jsonb not null,
  created_at timestamptz default now(),
  unique (user_id, analysis_date)
);

alter table job_intelligence_analysis enable row level security;

create policy "Users can manage own job_intelligence_analysis"
  on job_intelligence_analysis for all
  using (auth.uid() = user_id);
