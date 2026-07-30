-- Job Tracker: job-level tracking, kept as its own table per the locked
-- architecture decision (separate tables behind one unified UI, not a
-- polymorphic extension of company_watchlist). Mirrors saved_jobs' column
-- shape for the fields that overlap, since both describe a job posting, but
-- is a fully independent table: no FK to saved_jobs, smart_apply_queue, or
-- applications. Job Tracker must never touch the application pipeline.
create table job_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null,
  job_title text not null,
  company text not null,
  location text,
  salary_min numeric,
  salary_max numeric,
  employment_type text,
  remote boolean default false,
  description text,
  apply_url text,
  status text not null default 'watching',
  last_checked_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, job_id)
);

alter table job_watchlist enable row level security;
create policy "Users can manage own job watchlist" on job_watchlist for all using (auth.uid() = user_id);

-- Additive only -- does not revisit the locked separate-tables decision.
-- Tracks the best match score seen among a tracked company's open roles, so
-- the notification layer can detect "a new role scores meaningfully better
-- than anything seen from this company before" without a second table.
alter table company_watchlist add column if not exists best_seen_match integer;
alter table company_watchlist add column if not exists last_checked_at timestamptz;
