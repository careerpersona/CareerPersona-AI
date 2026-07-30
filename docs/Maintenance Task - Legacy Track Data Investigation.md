# Maintenance Task: Investigate legacy Track-created Application records

**Status:** Open — not started
**Priority:** Low-to-medium (likely small/test-account population today; resolve before wider rollout)
**Opened:** 2026-07-29, during Job Tracker release verification
**Do not modify production data until this review is complete.**

## Background

Before the Job Tracker fix (commit `7e5f87f`), the Job Search page's "+ Track"
button called a buggy `addTracker` function that unconditionally inserted an
`applications` row with `status: "Applied"` on every click — silently creating
a fake "Applied" application instead of adding the job to a watchlist. This
function had no idempotency, so repeated clicks on the same job could create
duplicate rows.

**Exposure window:** commit `f298329` (2026-06-22) through `d76dba4`
(2026-07-28) — roughly 5 weeks in production (Cloudflare Pages auto-deploys
from every push to `main`, so this was live for that entire window, not just
in development).

The fix itself (rename + Job Tracker implementation) is committed and
deployed. This task is only about the data the old behavior may have already
written.

## What's already known (from release verification)

- The old `addTracker` code always wrote this exact shape:
  `{ status: "Applied", date: <creation date>, notes: "", url: job.applyUrl }`
  — no `resume`, no `coverLetter`, no `atsScore`, no `followUpDate`, no
  `contactName`/`contactEmail`.
- Every other path that writes `status: "Applied"` in this app populates at
  least one of those fields (Smart Apply's "Mark Applied" always sets
  `resume`/`coverLetter`; the manual Add Application form is a deliberate,
  user-typed entry). That gives a reliable fingerprint for rows that could
  only have come from the bug.
- Confirmed via the production REST API (anon key) that all fingerprint
  columns exist on `applications`, and confirmed the anon key has **zero**
  cross-user visibility (`select=count` as unauthenticated → `{"count":0}`,
  RLS-scoped) — so an exact count could not be obtained during release
  verification without elevated (service-role) database access, which was not
  used.

## Task

1. **Run the fingerprint query below with appropriate database privileges**
   (e.g. via the Supabase SQL Editor, which has the necessary access — no
   credential handling required outside the dashboard):

   ```sql
   -- Candidate rows: can only have come from the broken Track button.
   -- Every other "Applied" write path always populates resume_used/cover_letter
   -- (Smart Apply) or is a deliberate manual form entry.
   select id, user_id, company, job_title, apply_url, date_applied, created_at
   from applications
   where status = 'Applied'
     and apply_url is not null
     and notes is null
     and ats_score is null
     and resume_used is null
     and cover_letter is null
     and follow_up_date is null
     and contact_name is null
     and contact_email is null
   order by created_at desc;
   ```

   For a quick scope check first:

   ```sql
   select count(*) as candidate_rows, count(distinct user_id) as affected_users
   from applications
   where status = 'Applied'
     and apply_url is not null
     and notes is null
     and ats_score is null
     and resume_used is null
     and cover_letter is null
     and follow_up_date is null
     and contact_name is null
     and contact_email is null;
   ```

2. **Determine how many records/users are affected.** Note whether any user
   has multiple candidate rows for the same `company`/`job_title` (evidence of
   the duplicate-click issue, not just the mislabeling issue).

3. **Decide the appropriate response**, based on actual scope:
   - **No action** — if the result set is empty or limited to known
     internal/test accounts.
   - **User notification** — if real users are affected but the volume is
     small enough for a manual/individual touch (e.g. a soft flag in their
     Application Tracker for them to confirm or dismiss).
   - **One-time cleanup migration** — only if volume and confidence in the
     fingerprint warrant it, and only ever as a reversible, reviewed operation
     (e.g. flip to a `Needs Review` status rather than deleting rows outright,
     so nothing is silently destroyed).

4. **Do not modify production data as part of this investigation** — this
   task is read-only until the review above produces a decision.

## Out of scope

Any change to the fingerprint heuristic's precision/recall, and any automated
recurring cleanup job — this is a one-time historical cleanup, not a new
ongoing system.
