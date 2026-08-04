-- Shared platform infrastructure (docs/Smart Apply Auto Prep Blueprint.md §11).
-- Owned exclusively by src/lib/platform/aiBudget.js. One row per user per
-- automation-capable feature -- Smart Apply Auto Prep is the first consumer
-- (feature_key = 'smart_apply_auto_prep'); a future feature (e.g. Real-Time
-- Interview Co-Pilot) adds its own feature_key with zero schema change.
--
-- `value` is deliberately opaque at this shared-table level -- its meaning is
-- entirely feature-defined. Smart Apply Auto Prep's own code interprets it as
-- "packages per day" (0/1/2); a future feature interprets its own value in
-- its own terms. This table never encodes per-feature semantics itself.

create table automation_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_key text not null,
  value integer not null default 0,
  updated_at timestamptz default now(),
  unique (user_id, feature_key)
);

alter table automation_preferences enable row level security;

create policy "Users can manage own automation preferences" on automation_preferences
  for all using (auth.uid() = user_id);

create trigger update_automation_preferences_updated_at before update on automation_preferences
  for each row execute function update_updated_at();

create index idx_automation_preferences_user_feature on automation_preferences(user_id, feature_key);
