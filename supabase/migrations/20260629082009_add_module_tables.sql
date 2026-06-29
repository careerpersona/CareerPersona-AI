-- CareerPersona AI — additive schema for modules with no backend home yet.
-- Does NOT modify the existing tables: profiles, applications, saved_jobs, job_matches, subscriptions, user_resumes.
-- Reuses existing conventions: uuid_generate_v4(), auth.users FK, auth.uid() = user_id RLS, update_updated_at() trigger fn.

-- Module 5: Smart Apply Center
create table smart_apply_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null,
  resume_id uuid references user_resumes(id),
  job_title text not null,
  company text not null,
  tailored_resume text,
  cover_letter text,
  recruiter_message text,
  networking_message text,
  company_research jsonb,
  salary_research jsonb,
  interview_probability integer,
  hiring_probability integer,
  missing_skills text[],
  application_questions jsonb,
  status text not null default 'queued',
  application_id uuid references applications(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Modules 1 & 2: cached generated content
create table ai_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  briefing_date date not null default current_date,
  content jsonb not null,
  created_at timestamptz default now(),
  unique (user_id, briefing_date)
);

create table ai_action_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_date date not null default current_date,
  tasks jsonb not null,
  productivity_score integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, plan_date)
);

-- Module 6: Interview Intelligence
create table interview_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text,
  job_title text,
  job_description text,
  questions jsonb not null,
  answers jsonb default '[]',
  mode text not null default 'practice',
  readiness_score integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Module 7: Salary & Market Intelligence
create table salary_research (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_title text not null,
  location text,
  experience_level text,
  results jsonb not null,
  created_at timestamptz default now()
);

create table salary_offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company text not null,
  job_title text,
  base_salary numeric,
  bonus numeric,
  equity text,
  benefits jsonb,
  notes text,
  created_at timestamptz default now()
);

-- Module 9: AI Career Assistant — persistent chat
create table assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text default 'New conversation',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

-- Module 10: Notifications & Activity
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link_page text,
  read boolean default false,
  created_at timestamptz default now()
);

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  description text not null,
  metadata jsonb,
  created_at timestamptz default now()
);

-- Module 11: Opportunity Intelligence
create table company_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  notes text,
  status text not null default 'watching',
  created_at timestamptz default now(),
  unique (user_id, company_name)
);

create table opportunity_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generated_at timestamptz default now(),
  companies jsonb not null
);

-- Existing feature with no backend yet: Networking page
create table networking_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  company text,
  email text,
  status text default 'Not Contacted',
  subject text,
  date_saved date default current_date,
  generated_messages jsonb,
  created_at timestamptz default now()
);

-- RLS: enable + owner-only policy on every new table
alter table smart_apply_queue enable row level security;
create policy "Users can manage own smart apply queue" on smart_apply_queue for all using (auth.uid() = user_id);

alter table ai_briefings enable row level security;
create policy "Users can manage own briefings" on ai_briefings for all using (auth.uid() = user_id);

alter table ai_action_plans enable row level security;
create policy "Users can manage own action plans" on ai_action_plans for all using (auth.uid() = user_id);

alter table interview_sessions enable row level security;
create policy "Users can manage own interview sessions" on interview_sessions for all using (auth.uid() = user_id);

alter table salary_research enable row level security;
create policy "Users can manage own salary research" on salary_research for all using (auth.uid() = user_id);

alter table salary_offers enable row level security;
create policy "Users can manage own salary offers" on salary_offers for all using (auth.uid() = user_id);

alter table assistant_conversations enable row level security;
create policy "Users can manage own conversations" on assistant_conversations for all using (auth.uid() = user_id);

alter table assistant_messages enable row level security;
create policy "Users can manage own messages" on assistant_messages for all using (
  auth.uid() = (select user_id from assistant_conversations where id = conversation_id)
);

alter table notifications enable row level security;
create policy "Users can manage own notifications" on notifications for all using (auth.uid() = user_id);

alter table activity_log enable row level security;
create policy "Users can manage own activity log" on activity_log for all using (auth.uid() = user_id);

alter table company_watchlist enable row level security;
create policy "Users can manage own watchlist" on company_watchlist for all using (auth.uid() = user_id);

alter table opportunity_snapshots enable row level security;
create policy "Users can manage own opportunity snapshots" on opportunity_snapshots for all using (auth.uid() = user_id);

alter table networking_contacts enable row level security;
create policy "Users can manage own networking contacts" on networking_contacts for all using (auth.uid() = user_id);

-- updated_at triggers, reusing the existing update_updated_at() function
create trigger update_smart_apply_queue_updated_at before update on smart_apply_queue for each row execute function update_updated_at();
create trigger update_ai_action_plans_updated_at before update on ai_action_plans for each row execute function update_updated_at();
create trigger update_interview_sessions_updated_at before update on interview_sessions for each row execute function update_updated_at();
create trigger update_assistant_conversations_updated_at before update on assistant_conversations for each row execute function update_updated_at();

-- Storage bucket for resume file uploads (private; access governed by storage RLS policies below)
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false);

create policy "Users can manage own resume files" on storage.objects for all using (
  bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text
);
