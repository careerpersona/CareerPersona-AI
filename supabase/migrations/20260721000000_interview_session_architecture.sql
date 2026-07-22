-- Blueprint #1: Interview Session Architecture
-- Separates the single active session from permanent completed history.
-- A partial unique index enforces at the database level that only one
-- active session can exist per user at a time.

alter table interview_sessions
  add column if not exists status text not null default 'active';

-- All existing rows are active (none were ever explicitly completed before
-- this migration, so the default covers the back-fill correctly).

create unique index if not exists interview_sessions_one_active_per_user
  on interview_sessions (user_id)
  where (status = 'active');
