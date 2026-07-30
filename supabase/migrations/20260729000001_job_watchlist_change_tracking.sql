-- Additive follow-up to 20260729000000_job_watchlist.sql: fields needed to
-- detect and surface what changed, without which the Job Tracker UX
-- blueprint's "why this changed" line and "Updated" status have nothing to
-- diff against.
alter table job_watchlist add column if not exists previous_salary_min numeric;
alter table job_watchlist add column if not exists previous_salary_max numeric;
alter table job_watchlist add column if not exists previous_description text;
alter table job_watchlist add column if not exists ai_change_summary text;
alter table job_watchlist add column if not exists has_unread_change boolean not null default false;
