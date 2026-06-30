-- Language Selector: stores the user's chosen UI language so it follows
-- them across devices/sessions. Stored alongside the rest of profile_details
-- (additive supplement to the original profiles table, same pattern as
-- preferred_job_title etc.) rather than altering profiles directly.
alter table profile_details add column if not exists preferred_language text not null default 'en';
