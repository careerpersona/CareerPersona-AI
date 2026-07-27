-- Skill alias/normalization dictionary for the Career Compatibility Engine's
-- Skills Match component (e.g. "React.js" and "ReactJS" both resolve to
-- "React" before resume-vs-job overlap is computed). Kept in Supabase rather
-- than hardcoded so it can be tuned without a redeploy, per the architecture
-- spec. Read-only reference data -- same trust level as static app config,
-- so RLS allows anyone to select but nothing else.

create table if not exists skill_synonyms (
  alias text primary key,       -- lowercased, e.g. "react.js"
  canonical text not null       -- e.g. "React"
);

insert into skill_synonyms (alias, canonical) values
  ('react.js', 'React'), ('reactjs', 'React'),
  ('js', 'JavaScript'),
  ('node', 'Node.js'), ('nodejs', 'Node.js'), ('node.js', 'Node.js'),
  ('golang', 'Go'),
  ('postgres', 'PostgreSQL'), ('postgresql', 'PostgreSQL'),
  ('k8s', 'Kubernetes'),
  ('ts', 'TypeScript'),
  ('vue.js', 'Vue'), ('vuejs', 'Vue'),
  ('next.js', 'Next.js'), ('nextjs', 'Next.js'),
  ('c sharp', 'C#'), ('csharp', 'C#')
on conflict (alias) do nothing;

alter table skill_synonyms enable row level security;
create policy "Anyone can read skill synonyms" on skill_synonyms for select using (true);
