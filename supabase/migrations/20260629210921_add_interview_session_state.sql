-- Interview Intelligence: the existing UI only ever has one active session
-- per user (browse/mock state, draft answers, mock summary, resume text).
-- Add a catch-all column for the fields that don't have a dedicated column
-- on interview_sessions, so the full local session shape can move to Supabase
-- without altering the page's behavior.
alter table interview_sessions add column if not exists session_state jsonb;
