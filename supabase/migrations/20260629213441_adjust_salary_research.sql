-- Salary & Market Intelligence: the existing UI keeps one active search/result
-- per user (form fields + AI results), edited in place and re-run — not a
-- history log. Make results nullable (cleared by "New Search" while the form
-- stays), add the two form fields the original table left out, and add
-- updated_at so the single row can be upserted like interview_sessions.
alter table salary_research alter column results drop not null;
alter table salary_research add column if not exists skills text;
alter table salary_research add column if not exists company_type text;
alter table salary_research add column if not exists updated_at timestamptz default now();

create trigger update_salary_research_updated_at before update on salary_research
  for each row execute function update_updated_at();
