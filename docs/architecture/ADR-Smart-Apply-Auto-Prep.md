# ADR: Smart Apply Auto Prep Architecture

**Status:** Accepted — Release Candidate Complete, Frozen
**Date:** 2026-08-06
**Owners:** Architect approval across the audit, decision analysis, blueprint lock, Phases 1–4, the Daily Cron & Budget Boundary Verification, and RC sign-off (see Decision Log below)

## Context

Smart Apply Auto Prep (roadmap name "AI Auto-Apply V1") began with a mandatory audit of the existing manual Smart Apply implementation and a full Anthropic API usage audit, per the standard process established during LinkedIn Intelligence. That audit surfaced a critical historical precedent: an earlier automatic-generation pipeline (auto-firing AI Match on every search result, then auto-firing full Smart Apply generation on the top 5) had been deliberately **removed** in commits `5adc224`/`6e6ca2e` for cost and trust reasons. Any new automatic pipeline had to explain, concretely, what changed to make automation safe this time — not simply reintroduce the removed behavior under a new name.

Two things had changed since the removal: (1) qualification is now free and deterministic (the Career Compatibility Engine, built for the AI Match removal, replaced a per-job Claude call entirely), and (2) this feature introduces the first genuine persistent, cross-session Cost Boundary in the app's history — the old system had only a per-batch concurrency limit with zero cross-session budget tracking. A full Architecture Decision Analysis evaluated three automation models (including "True Auto Mode" — real submission), rejected true autonomous submission on three independently sufficient grounds (no submission integration exists, ToS risk lands on the user's own account rather than an API key, no semantic-correctness guarantee beyond placeholder-token checking), and locked a scope: **automatic preparation only, submission always manual.**

## Decision

### 1. Feature purpose and boundary — never submits, only prepares
Locked 9-step workflow (`docs/Smart Apply Auto Prep Blueprint.md` §1): Job Search + Compatibility Engine score → Auto Prep reads results → selects highest-ranked qualifying jobs → AI prepares package → AI validates → AI saves to queue → user opens app → user reviews → user swipes/clicks Apply. The feature's own name makes the boundary self-evident, closing "true autonomous submission" permanently, not just as a V1 scoping choice.

### 2. Qualification and Selection — closed input list, zero new scoring
Qualification uses exactly three existing Compatibility Engine outputs — `match_score`, `gates` (must all pass), `confidence` (must be **High**, stricter than manual Smart Apply's no-restriction default) — and nothing else. Selection is `match_score` descending with a deterministic tie-break; random and FIFO selection are explicitly prohibited. `src/lib/smartApplyAutoPrep/selection.js` introduces no ranking logic beyond a stable sort of an already-computed score.

### 3. Cost Boundary — fixed, non-scaling, dual-cap
A plain Daily Preparation Setting (Off / 1 / 2 applications per day — no "Level"/"Tier" terminology anywhere in the UI) paired with a **fixed 20/month ceiling that never scales with the daily setting**. `src/lib/platform/aiBudget.js` supplies feature-key-scoped period-key and result-combination logic; the atomic RPC-consuming half (`checkAndConsumeAutomationBudget`) was deliberately built in `worker.js` rather than the shared module, because `check_and_consume_quota` is granted to `service_role` only (verified by reading the RPC's own `REVOKE/GRANT` statements directly) — a client-callable budget check would allow `p_user_id` spoofing.

### 4. Reuse Before Recreation — two mid-implementation extractions, both behavior-preserving
Two gaps were found only once server-side execution was actually attempted, and both were resolved by relocation, not reimplementation, verified by direct diff against the pre-extraction source in each case:

- **Job discovery** (`fetchAdzuna`/`fetchRapid`/`normalizeAdzuna`/`normalizeRapid`/`deduplicate`/`fetchFreshPostings`) was already serving two consumers (interactive Job Search, Proactive Job Alerts) as private `worker.js` helpers before this feature recognized it as platform infrastructure. Relocated to `src/lib/platform/jobDiscoveryService.js`; Proactive Job Alerts and Smart Apply Auto Prep are now independent consumers of one implementation, with the one real coupling found (`PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE`) generalized to a plain parameter rather than carried in as a hidden assumption.
- **Package generation and validation** (`buildIdentityBlock`/`buildSmartApplyPrompt`/`validateSmartApplyPackage`) were pure functions living in `App.jsx` with no browser dependency. Relocated to `src/lib/smartApply/generation.js` so the blueprint's §7 guarantee — "the exact same, unmodified functions" — is structurally true, not merely asserted. The surrounding **persistence layer** (`src/data/smartApply.js`) was deliberately *not* relocated: it is a React hook bound to a browser session and a client-local orphan-recovery Set with no server-cron equivalent (a cron invocation either finishes a row or marks it failed in the same pass — there is no "orphaned by a closed tab" case). `worker.js` implements its own service-role persistence functions replicating the same status semantics and dedup rule, not the same code, since the transport/auth model is fundamentally different.

### 5. Server-side resume and profile resolution — two gaps the original blueprint didn't anticipate
Written assuming a browser session, the blueprint had no concept of what a cron job (no `activeResumeId`, which is pure client `useState`, never persisted) should use. Locked resolution: Auto Prep requires an explicit `user_resumes.is_default` resume and **skips the user entirely if none is set** — no most-recently-analyzed fallback; automatic preparation only ever acts on a resume the user explicitly chose. `fetchProfileForAutoPrep` mirrors `src/data/profile.js`'s canonical `profiles`/`profile_details` merge shape service-role, for the same reason the persistence layer above was reimplemented rather than shared.

### 6. Unified Fallback — one destination, two causes, no new vocabulary
Both an exhausted Cost Boundary and a technical generation failure route to the identical "Ready for Manual Preparation" outcome. Concretely: a job blocked by budget is simply never selected (no queue row created, nothing to clean up); a job that fails after being enqueued is marked `failed` — generalizing the existing status manual generation failures already use, never a fourth status.

### 7. Daily Cron & Budget Boundary Verification — one real gap found and fixed, not just documented
A dedicated verification pass (performed against the running implementation, before Phase 4) confirmed: both budget periods are UTC-calendar-based, never user-timezone-based; the single daily cron (`0 13 * * *` UTC) means "UTC calendar day" and "the one daily execution" are equivalent in practice; no user can exceed their configured limit due to timezone (enforcement is one atomic, timezone-blind counter); the Qualification Boundary is verified to contain zero `Date`/wall-clock references anywhere in `eligibility.js`/`compatibility.js`/`confidence.js`. One real gap was found: `enqueueAutoPrepRow`'s non-terminal-row dedup check was a non-atomic SELECT-then-INSERT, exploitable by a redelivered cron invocation or a client-side double-click race on manual Smart Apply. Resolved via `20260806000002_smart_apply_queue_active_job_uidx.sql` — a partial unique index (`smart_apply_queue(user_id, job_id) WHERE status NOT IN ('applied','skipped')`) making the dedup rule a database-level invariant for both the automatic and manual enqueue paths, with the resulting 409 handled as the existing-row case, not an error.

### 8. Persistence — extends the existing queue, no new table
`automation_preferences` (new, shared platform table, `{user_id, feature_key, value}` — deliberately opaque at the shared-table level, meaning entirely feature-defined) and two new columns on the existing `smart_apply_queue` (`generation_source: 'manual'|'automatic'`, `generation_result` reserved and unpopulated in V1). The original blueprint's separate `auto_apply_decisions` table concept was not built — `smart_apply_queue` already is the record of what got prepared and how.

## Consequences

- Any future automation-capable feature (e.g., Real-Time Interview Co-Pilot) reuses `aiBudget.js`'s period-key/combination helpers with its own feature key and cap numbers; the module never encodes feature-specific caps itself.
- The partial unique index on `smart_apply_queue` is a permanent, database-level invariant now protecting both the manual and automatic enqueue paths — any future third caller inherits the same protection for free.
- `src/lib/smartApply/generation.js` is now the single implementation of Smart Apply's generation/validation logic; a future change to prompt construction or Package Integrity Validation changes behavior for both manual and automatic Smart Apply identically, by construction.
- The "skip if no default resume" decision means Auto Prep will silently do nothing for a user who has multiple resumes but never explicitly set one as default — a deliberate product tradeoff (never guess which resume to use unattended), not an oversight, and the first thing to revisit if user feedback indicates it's a common blocker.
- A per-user-local budget period (rather than global UTC) was explicitly evaluated and deferred, not rejected — a real enhancement candidate if a future need arises, not a bug fix.

---

## Evidence

Reproducible — every command referenced here can be re-run against the current codebase.

### A. Audit and governance decision

Full audit of the removed automatic-generation pipeline (commits `5adc224`/`6e6ca2e`), the Architecture Decision Analysis (True Auto Mode evaluation, ToS risk analysis, six-original-concept verdicts), and the locked product-decision revision (feature renamed from "AI Auto-Apply V1" to Smart Apply Auto Prep) are recorded in the conversation record and `docs/Smart Apply Auto Prep Blueprint.md` §13/§16 (Decision Log). The blueprint's own self-audit found and fixed one real conflict before lock: an early draft's "Employer Memory" qualification concept violated the newly-closed qualification input list and was fully removed (not relocated), since the existing queue dedup already covered its legitimate concern.

### B. Ownership — verified by search, not assertion

`grep -n "^async function fetchAdzuna\|^async function fetchRapid\|^function normalizeAdzuna\|^function normalizeRapid\|^function deduplicate\|^async function fetchFreshPostings" worker.js` → no matches (all relocated); the same search against `src/lib/platform/jobDiscoveryService.js` → exactly one match each. `grep -n "^const buildSmartApplyPrompt\|^const validateSmartApplyPackage" src/App.jsx` → no matches; `src/lib/smartApply/generation.js` → exactly one match each, both `export`ed. `grep -n "async function checkAndConsumeAutomationBudget" worker.js src/lib/platform/aiBudget.js` → exactly one match, in `worker.js`, confirming the service-role-only constraint was actually honored, not just documented. Full ownership table in `docs/architecture/AI-Ownership-Registry.md`, updated this feature with four new/modified rows (`jobDiscoveryService.js` consumer update, `smartApplyAutoPrep/selection.js`, `smartApply/generation.js`, `platform/aiBudget.js` + `automation_preferences`).

### C. Extraction discipline — verified by diff, not assumption

Both mid-implementation extractions (§4 above) were verified byte-identical to their pre-extraction source via direct diff (`sed`-extracted blocks, normalized for the `export`/local-`const` difference, then `diff`) before the original code was removed — the same discipline established during LinkedIn Intelligence's `parseResumeDoc` relocation. One self-caught error during the job discovery extraction: a first draft of `fetchRapid`'s response-parsing logic was written from memory rather than verified source (a simplified single-fallback parse instead of the actual 3-way `jobsArray` fallback), caught by a full re-read before finalizing, corrected, then confirmed identical via diff — documented as a reminder that unverified re-reads must be treated with suspicion even within the same session.

### D. Regression and build verification — 418/418 passed

Full platform regression via the Regression Runner across all 16 registered suites (12 pre-existing + 4 new): **418/418 checks passed**, zero regressions in Referral Intelligence, Proactive Job Alerts, or LinkedIn Intelligence. New suites: `ai-budget-manager-unit` (11 checks), `smart-apply-auto-prep-selection-unit` (13 checks), `smart-apply-auto-prep-phase3-unit` (12 checks — Job Discovery normalize/dedupe + generation/validation), `smart-apply-auto-prep-phase4-ui` (9 checks — Settings control, `automation_preferences` write-through, Auto-Prepared badge). `npx vite build` clean throughout every phase. `npx wrangler deploy --dry-run` clean (worker.js bundles successfully, 303.95 KiB / gzip 69.32 KiB). `npx eslint worker.js`: one new error introduced and fixed (an unused `isJobQualifiedForAutoPrep` import); all remaining errors confirmed pre-existing baseline (`catch (_) {}` pattern, present in `git show HEAD:worker.js` before this feature).

### E. Localization verification

`tools/localization-validator/`: `savedJobs.autoPreparedBadge` translated and verified present in all 14 locales (0 missing). `settings.autoPrepHeading`/`autoPrepLabel`/`autoPrepOff`/`autoPrep1`/`autoPrep2`/`autoPrepHelper` added to `en.js` only, consistent with the pre-existing, already-established pattern for the entire billing/usage subsection of Settings (confirmed via baseline comparison: `git stash` + validator run → 845 pre-existing failures at HEAD; post-feature → 923; the exact delta of 78 = 6 keys × 13 locales, matching this addition precisely, with zero unexpected new gaps). The `t()` fallback chain (`LOCALES[language] ?? LOCALES.en ?? fallback ?? key`) means these render in English rather than blank or a raw key in any locale.

### F. Runtime end-to-end verification — demonstrated, not inferred

A Playwright harness against the dev server, with Supabase REST calls intercepted (not production data), verified real navigation (not localStorage/hash presets, both of which are overridden by the app's forced-dashboard-on-login effect) through the actual desktop nav menu: Settings page renders the Smart Apply Auto Prep card with correct heading and helper text, zero "Level"/"Tier"/"Automation Level" terminology anywhere on the page, all three daily-setting options present, changing the setting produces a correct `automation_preferences` upsert (`value: 1, feature_key: "smart_apply_auto_prep"`), and the Smart Apply Queue shows exactly one "Auto-Prepared" badge on the `generation_source: "automatic"` row and none on the `"manual"` row. 9/9 checks passed.

### G. Production data verification

`automation_preferences`, `smart_apply_queue.generation_source`/`generation_result`, and the `smart_apply_queue_active_job_uidx` partial unique index were applied via `npx supabase db push` against the live project and confirmed via successful migration application (no rollback, no error) — re-confirmed at RC sign-off.

## Decision Log

| Phase | Decision |
|---|---|
| Audit | Manual Smart Apply and the removed automatic-generation pipeline audited; Anthropic API usage audited. Cost/complexity driver identified as the removed auto-fire pipeline, not manual Smart Apply itself. |
| Decision Analysis | True Auto Mode (Option C) evaluated and rejected on three independent grounds. Cost Ceiling Requirement introduced (Qualification Boundary / Cost Boundary two-boundary framework). Automation Level scope resolved as per-feature, validated against Real-Time Interview Co-Pilot. |
| Locked Revision | Feature renamed Smart Apply Auto Prep. 9-step never-auto-submits workflow locked. Qualification restricted to a closed input list. Selection locked to rank-order-only. Daily Preparation Setting (Off/1/2) + fixed 20/month ceiling locked. Self-audit found and removed one conflict (Employer Memory). |
| Phase 1 | `automation_preferences` migration applied; `src/lib/platform/aiBudget.js` (pure halves) + unit tests; `src/data/automationPreferences.js` client hook. |
| Phase 2 | `src/lib/smartApplyAutoPrep/selection.js` (Qualification + Selection, reusing the Compatibility Engine unmodified) + unit tests. |
| Job Discovery Extraction | `fetchAdzuna`/`fetchRapid`/`normalizeAdzuna`/`normalizeRapid`/`deduplicate`/`fetchFreshPostings` relocated to `src/lib/platform/jobDiscoveryService.js`, verified byte-identical by diff (one self-caught transcription error corrected before finalizing). Proactive Job Alerts and Smart Apply Auto Prep became independent consumers. |
| Generation Extraction | `buildIdentityBlock`/`buildSmartApplyPrompt`/`validateSmartApplyPackage` relocated to `src/lib/smartApply/generation.js`, verified byte-identical by diff. Persistence layer deliberately not relocated — reimplemented service-role in `worker.js` with identical status semantics. |
| Phase 3 | Server-side cadence built in `worker.js` (`0 13 * * *` cron): profile/resume resolution (skip-if-no-default locked), skill-dictionary fetch, `checkAndConsumeAutomationBudget` (built here, not in `aiBudget.js`, per the service-role-only RPC constraint), selection, generation, Unified Fallback persistence. |
| Boundary Verification | Daily Cron & Budget Boundary Verification performed. UTC-global-period design confirmed as an intentional V1 decision (documented in blueprint §11). One real gap found (non-atomic enqueue dedup) and fixed via a partial unique index migration, not merely documented — `enqueueAutoPrepRow` updated to treat the resulting 409 as the existing-row case. |
| Phase 4 | Settings UI (Daily Preparation Setting control, correct helper text, no Level/Tier terminology) and Smart Apply Queue Auto-Prepared badge built. 14-locale i18n for the badge; Settings copy added to `en.js` consistent with the section's pre-existing localization scope. |
| RC | Full regression (418/418 across 16 suites), build/lint/wrangler-bundle clean, localization validated against baseline, runtime Playwright verification (9/9), production migrations confirmed live. Declared Release Candidate Complete and frozen. |

## Status: Frozen

No further feature work, polishing, or architectural changes are to be made under the Smart Apply Auto Prep implementation. The per-user-local budget period (§ Consequences) and the deferred `generation_result` feedback-loop column are documented future candidates, subject to their own review — not built speculatively during this feature's implementation.
