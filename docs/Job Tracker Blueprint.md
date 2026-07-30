# CareerPersona AI — Job Tracker Blueprint

## Grounding note (read first)

This blueprint is written against what actually exists in the codebase today, not a blank slate. Three pieces of real, working infrastructure directly overlap with this feature and change what "new" actually means here:

- **`company_watchlist`** (table + `useCompanyWatchlist` hook + a live "Company Watchlist" tab inside Opportunity Intelligence) already implements company-level tracking: add/remove a company, a free-text `status` (defaults `'watching'`), notes, enriched at render time with how many saved jobs and networking contacts match that company. This is a real, working first version of half of this blueprint's vision.
- **`saved_jobs.previous_description`** ("Employer Change Intelligence") already captures a job's prior description whenever a fresh search happens to resurface a saved job, specifically so a future feature could detect and explain what changed — but it is **passive**: it only fires when the user re-runs a search that happens to include that job again. There is no scheduled or active checking today.
- **`notifications`** (table + `useNotifications` hook + the header bell icon with an unread count) is a real, generic, already-wired delivery mechanism — `type`, `title`, `body`, `link_page`, `read`. Nothing new needs inventing to deliver an alert; it needs new notification *rows*, not new plumbing.

**Naming collision to resolve before or alongside implementation**: the string "Job Tracker →" (`opportunity.jobTracker`) is *already* used today as a shortcut label pointing at the Application Tracker (`setPage("tracker")`), inside Opportunity Intelligence's "Better Job Opportunities" card. If this new feature is also called "Job Tracker," that label now points at the wrong thing. This needs a deliberate decision (rename the old shortcut, e.g., to "Application Tracker →"; or name this new feature something else, e.g., "Opportunity Watchlist"). Not resolved in this document — flagged for you to decide.

---

## 1. Overall Product Architecture

Two trackable entity types, one product surface:

- **Company-level tracking** — "watch this company generally." Backed by the existing `company_watchlist` table, extended rather than replaced.
- **Job-level tracking** — "watch this specific posting for changes." Needs a **new** table (working name `job_watchlist` — pending the naming decision above), separate from `saved_jobs`. `saved_jobs` means "staged for Smart Apply"; a watched job means "I want to be told if this changes." Overloading one table with two meanings is exactly the kind of ambiguity the Application Tracker review just surfaced as a real bug (`addTracker` silently writing `status: "Applied"`) — this blueprint should not repeat that mistake.

Both entity types are surfaced together on one new page, kept **structurally and semantically separate from the Application Tracker**: no shared table, no shared status vocabulary, no foreign key into `applications` or `smart_apply_queue`. The only connection to the application pipeline is a manual, explicit user action (Save / Smart Apply) taken *from* a tracked item — never automatic, never implied by the act of tracking itself.

## 2. Ideal User Workflow

1. User finds a job (Job Search) or a company they care about (anywhere a company name appears — Job Search, Saved Jobs, Opportunity Intelligence). They press Track.
2. The item appears immediately in the Job Tracker page, in the Companies or Opportunities section depending on what was tracked.
3. In the background (see §8 for the honest gap here), CareerPersona AI periodically checks tracked items: does this company have new open roles that match the user's profile? Has this job's salary, requirements, or status changed? Has the user's own resume/profile changed enough that a previously-mediocre match is now strong?
4. When something meaningful happens, the user gets a notification (bell icon) and the tracked item itself shows what changed.
5. From a tracked item, the user can Save it, Smart Apply to it, or stop tracking — Job Tracker hands off to the existing pipeline; it never starts one on its own.

## 3. What Happens When the User Presses Track

- The button is context-aware: on a job card, it tracks that job (with a secondary, non-default option to also track the company); on a company name/logo, it tracks the company.
- Pressing it is a single, optimistic, non-blocking action — same pattern as the existing Save toggle (`toggleSave`): instant visual state change (filled icon / "Tracking" badge), no navigation, no modal.
- A lightweight inline confirmation appears (same visual language as the existing `jobSearch.aiUnlockGuidance` banner), with a link to view it in the Job Tracker page.
- On the backend, this writes one row capturing a **snapshot** of the current state (salary, location, a description fingerprint for jobs; nothing to snapshot yet for a fresh company) — this snapshot is what future checks diff against to detect "what changed."
- It does not touch `saved_jobs`, `smart_apply_queue`, or `applications` in any way.

## 4. First-Time User Experience

This app has no existing modal/dialog system for onboarding — every precedent (the resume-required banner in Job Search, the "AI unlock" guidance) is a dismissible **inline banner**, not a blocking wizard. Follow that precedent rather than introducing a new UI pattern for one feature:

- The first time a user presses Track (tracked via a profile flag or localStorage, consistent with how other one-time hints are handled), show a single dismissible inline explainer near the action: one sentence on what tracking means ("We'll watch this and let you know when something changes — this doesn't apply for you"), a "Got it" dismiss, and a link to the Job Tracker page.
- No forced tour, no multi-step wizard. If the nav item is new, a subtle one-time highlight/pulse on the nav entry until first visited is enough.

## 5. Best Page Layout for Tracked Opportunities

Two precedents already exist in this app for organizing a page around a related-but-distinct pair of lists: Saved Jobs' "two sections on one page" (Saved Jobs, then Smart Apply Queue below it) and Opportunity Intelligence's tab bar (Opportunities / Watchlist / Trends). **Recommend the tab pattern**, since Opportunity Intelligence already established tabs for this exact adjacent concept (its own "Watchlist" tab) — reusing it is more consistent than introducing a third layout convention:

- **Tab: Opportunities** — tracked jobs, each as a card.
- **Tab: Companies** — tracked companies, each showing current open-role count and best match among them (extends what `watchlistEnriched` already computes in Opportunity Intelligence today).
- **Tab: Activity** — a simple chronological feed of detected changes across everything tracked (new role posted, salary changed, closed) — this is what makes the feature feel alive rather than a static list.

Filter/sort controls follow the same visual language as Job Search's sort dropdown and Tracker's status chips — status filter (Active / Changed / Closed), search box, sort by most-recently-changed.

## 6. Information Displayed on Each Tracked Item

**Tracked job card**: title, company, location, current salary with a delta indicator if it moved since tracked, live Match % (see §7), "tracking since" date, a specific change badge when relevant ("Salary increased," "Requirements changed," "Closing soon," "No longer listed"), and quick actions — View posting, Save, Smart Apply, Stop Tracking.

**Tracked company card**: company name, user's notes (editable inline — `updateNotes` already exists), count of currently open roles matching the user's search criteria, best match score among them, "watching since" date, quick actions — View open roles (routes into Job Search pre-filtered by company), Stop Tracking, Edit notes.

## 7. AI-Powered Insights and Recommendations

Per the "consume before you compute" principle already locked in the Premium Architecture Foundation, this feature should be almost entirely a consumer of existing intelligence, not a new AI pipeline:

- **Match %** for every open role at a tracked company, and for a tracked job's current state, comes from the existing Compatibility Engine — deterministic, zero-cost, already built. No new AI call needed for scoring.
- **"Growing companies" / trending signals** already exist as AI output from Opportunity Intelligence's `refreshAnalysis` — cross-reference tracked companies against that existing output instead of writing a second, competing prompt.
- The **one genuinely new AI surface** worth adding: a short, plain-language "why this matters" line generated *only* when a real change is actually detected (not on every check, not per item on a timer) — e.g., "Acme raised the salary range by $15K and added a remote option, closer to what you're looking for." Small, event-triggered, justified by data no existing module already explains.

## 8. Notification Strategy

Delivery is solved — reuse `notifications`/`useNotifications` as-is, with a new `type` (e.g., `"job_tracker"`) and `link_page` pointing at the new page. Zero new UI needed for delivery; the bell icon and unread count already work.

**The honest gap is detection, not delivery.** Today's only related mechanism — `syncSavedJobData`'s description-diffing — is passive: it only runs when the user happens to search again and the same job resurfaces. It is not a "watch this in the background" system. Making Job Tracker actually proactive requires new backend infrastructure this app doesn't have yet: a scheduled check (e.g., a Cloudflare Worker Cron Trigger) that periodically re-queries Adzuna/JSearch for tracked jobs and companies regardless of whether the user is searching. This should be named explicitly as new infrastructure to build, not implied to already exist.

Trigger conditions once that exists: new matching role at a tracked company; salary, requirements, or remote status changed on a tracked job; a tracked job closes or is delisted. Batch into a digest rather than one notification per event where possible, to avoid the header bell becoming noise.

## 9. Dashboard Integration

Follow the existing Dashboard card convention exactly (Briefing, Plan, Career Progress cards): a Job Tracker card showing count tracked, count with new activity since last visit, the top one or two changes, and a link into the full page. Several existing Dashboard cards are on record (Architecture Review Report v1.0) as wired-but-showing-placeholder-content — this should ship as a genuinely complete card from the start, not another placeholder to revisit later.

## 10. Mobile UX

Reuse the `isMobile` matchMedia pattern already used throughout Job Search, Saved Jobs, and PackageView — same breakpoint, same compact-card conventions (stacked buttons, reduced padding). The Track button on a mobile job card should sit in the same row-of-actions pattern already used for Save/Track/Smart Apply today, just relabeled/reworked per the naming decision. A swipe-to-stop-tracking gesture could reuse the existing `SwipeToApply` gesture component's pattern for visual consistency, but this is a nice-to-have, not a requirement for v1.

## 11. Database / Data Model Recommendations

- **Extend `company_watchlist`** rather than replacing it: add `last_checked_at` (for the future scheduled-check system) and keep `status` as free text validated at the application layer, not a DB `CHECK` constraint — the Application Tracker's status constraint has already needed one migration to add a missing value it should have allowed from the start; free text with app-level validation is lower-friction while this feature's status vocabulary is still settling.
- **New table for job-level tracking** (name pending): `user_id`, `job_id` (external job identifier, matching `saved_jobs`' convention), `job_title`, `company`, a snapshot of salary/location/description (or a hash) captured at track time, `last_checked_at`, `status`, `created_at`. Deliberately mirrors `saved_jobs`' existing column shape where the data overlaps, but stays a fully separate table.
- **RLS**: identical `auth.uid() = user_id` pattern already used on every other table in this schema.
- **No foreign keys to `applications` or `smart_apply_queue`.** The separation this blueprint calls for should be enforced by the schema, not just by convention in the UI code — that's exactly the kind of enforcement the Application Tracker investigation showed was missing.

## 12. Scaling Into an Enterprise-Quality AI Opportunity Tracking System

- **Active monitoring**: replace passive, search-triggered detection with scheduled server-side checks (Worker Cron) — the single biggest infrastructure step this blueprint depends on.
- **Shared caching across users**: once many users track the same company/job, dedupe outbound API calls behind a shared cache layer, following the same pattern as the existing `SUBSCRIPTION_CACHE` KV binding in `worker.js`, rather than one Adzuna/JSearch call per user per tracked item.
- **Plan-tiered limits**: number of tracked items and notification frequency (digest vs. near-real-time) gated by subscription tier, consistent with the billing/entitlement architecture already locked for Premium features.
- **Delivery beyond in-app**: email/webhook delivery as a later layer on top of the same `notifications` rows, once in-app delivery is proven out.
- **Governance**: if/when this becomes a Premium-gated feature, it should follow the Premium Architecture Foundation's existing conventions verbatim — versioned, explainable persisted output; no duplicate LLM calls where an existing module already has the answer; no direct calls into other Premium features' internals.

---

*This is a design document only. No code, schema, or UI was written or modified. The naming collision in the grounding note and the passive-vs-active detection gap in §8 are the two things most likely to need a decision from you before implementation starts.*
