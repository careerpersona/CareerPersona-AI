-- The applications status CHECK constraint was missing 'Withdrawn', which is
-- a valid status in the frontend STATUSES array. Any upsert with status
-- 'Withdrawn' silently failed, causing data loss on page refresh.
alter table applications drop constraint applications_status_check;
alter table applications add constraint applications_status_check
  check (status = any (array[
    'Saved'::text,
    'Applied'::text,
    'Phone Screen'::text,
    'Interview'::text,
    'Final Interview'::text,
    'Offer'::text,
    'Rejected'::text,
    'Withdrawn'::text,
    'Ghosted'::text
  ]));
