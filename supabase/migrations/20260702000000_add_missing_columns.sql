-- Additive column additions for applications and saved_jobs.
-- The original six tables (profiles, applications, saved_jobs, job_matches,
-- subscriptions, user_resumes) were created by the JobPilot project before this
-- codebase connected to them. The data hooks (applications.js, savedJobs.js)
-- reference columns that may not exist in the original schema, causing every
-- upsert to silently fail when those columns are missing. These ALTER TABLE
-- statements use IF NOT EXISTS so they are safe to apply even if some columns
-- already exist.

-- applications: columns that toRow sends and fromRow reads
alter table applications add column if not exists follow_up_date date;
alter table applications add column if not exists contact_name text;
alter table applications add column if not exists contact_email text;
alter table applications add column if not exists apply_url text;
alter table applications add column if not exists ats_score integer;
alter table applications add column if not exists resume_used text;
alter table applications add column if not exists cover_letter text;

-- saved_jobs: columns that toRow sends and fromRow reads
alter table saved_jobs add column if not exists location text;
alter table saved_jobs add column if not exists salary_min numeric;
alter table saved_jobs add column if not exists salary_max numeric;
alter table saved_jobs add column if not exists employment_type text;
alter table saved_jobs add column if not exists remote boolean default false;
alter table saved_jobs add column if not exists description text;
alter table saved_jobs add column if not exists apply_url text;
alter table saved_jobs add column if not exists source text;
alter table saved_jobs add column if not exists date_posted text;
alter table saved_jobs add column if not exists match_score integer;
alter table saved_jobs add column if not exists ats_score integer;
