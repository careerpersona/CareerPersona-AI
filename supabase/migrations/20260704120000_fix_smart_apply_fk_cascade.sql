-- Fix smart_apply_queue FK constraints to use ON DELETE SET NULL instead of
-- the default RESTRICT. Without this, deleting an application (or resume) that
-- has a smart_apply_queue row pointing at it produces a FK violation and the
-- Tracker delete fails with "Delete failed" for every Smart-Applied record.
--
-- ON DELETE SET NULL: the queue row is preserved (Smart Apply history stays intact)
-- but application_id / resume_id is nulled out when the referenced row is deleted.

ALTER TABLE smart_apply_queue
  DROP CONSTRAINT smart_apply_queue_application_id_fkey,
  ADD  CONSTRAINT smart_apply_queue_application_id_fkey
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL;

ALTER TABLE smart_apply_queue
  DROP CONSTRAINT smart_apply_queue_resume_id_fkey,
  ADD  CONSTRAINT smart_apply_queue_resume_id_fkey
    FOREIGN KEY (resume_id) REFERENCES user_resumes(id) ON DELETE SET NULL;
