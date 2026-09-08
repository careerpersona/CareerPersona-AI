-- Opportunity Intelligence: one AI analysis per user per day. Fixes the A-Z
-- audit's P1 finding that Opportunity Intelligence generated AI output with
-- zero persistence -- a page reload always lost it even though AI quota had
-- already been consumed for the call. Same schema and RLS as the sibling
-- module this mirrors, Job Intelligence (20260713000000_job_intelligence_
-- analysis.sql) -- no new persistence architecture, just this module's own
-- table following the pattern already established by every other AI module.
create table opportunity_intelligence_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_date date not null default current_date,
  content jsonb not null,
  created_at timestamptz default now(),
  unique (user_id, analysis_date)
);

alter table opportunity_intelligence_analysis enable row level security;

create policy "Users can manage own opportunity_intelligence_analysis"
  on opportunity_intelligence_analysis for all
  using (auth.uid() = user_id);

-- Account Deletion Lock (see 20260818010000_deletion_lock_direct_writes.sql)
-- -- reuses the existing project-wide guard function; purely additive, same
-- as every other feature table's own trigger declaration there.
CREATE TRIGGER deletion_lock_opportunity_intelligence_analysis BEFORE INSERT OR UPDATE OR DELETE ON public.opportunity_intelligence_analysis FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
