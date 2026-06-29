-- Additive supplement to `profiles` for fields the app's Profile page collects
-- that aren't columns on the existing (untouched) profiles table.
-- 1:1 with profiles, keyed by the same auth.uid().

create table profile_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_address text,
  preferred_job_title text,
  preferred_industry text,
  work_type text,
  desired_salary text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profile_details enable row level security;
create policy "Users can manage own profile details" on profile_details for all using (auth.uid() = user_id);

create trigger update_profile_details_updated_at before update on profile_details for each row execute function update_updated_at();
