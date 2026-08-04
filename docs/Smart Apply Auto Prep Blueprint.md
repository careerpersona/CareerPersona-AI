# Smart Apply Auto Prep — Architecture Blueprint

**Status: Frozen — Release Candidate Complete — 2026-08-06.** See `docs/architecture/ADR-Smart-Apply-Auto-Prep.md` for the frozen architectural record.
Feature Blueprint · Premium only · Placement: Job Search + Smart Apply Queue (extends existing Smart Apply) · Complexity: Medium-High

Premium Feature #5 in the original roadmap sequence, originally named "AI Auto-Apply V1." Renamed **Smart Apply Auto Prep** to make the feature's actual behavior unambiguous in its own name — it prepares applications automatically; it never submits them. Supersedes the prior draft (`docs/AI Auto-Apply V1 Blueprint.md`, removed) following a locked product-decision revision. Every design decision below is either carried from the locked Architecture Decision Analysis (conversation record, 2026-08-05) or explicitly revised by the locked decisions in this document — never re-derived from scratch.

---

## §1. Feature Purpose (Locked)

Smart Apply Auto Prep does not apply to jobs automatically. Its purpose is to eliminate *preparation* work while the user keeps complete control of the final application decision.

**Locked workflow:**
1. Job Search and the existing Career Compatibility Engine identify and score jobs (unchanged, pre-existing).
2. Smart Apply Auto Prep reads those existing deterministic results.
3. Smart Apply Auto Prep selects the highest-ranked qualifying jobs.
4. AI prepares the complete Smart Apply package.
5. AI validates the package.
6. AI saves the completed package into the Smart Apply Queue.
7. The user opens CareerPersona.
8. The user reviews the prepared package.
9. The user swipes/clicks Apply.

Nothing is ever submitted to an employer automatically — this closes Option C (true autonomous submission) permanently, not just as a V1 scoping choice. The feature's name itself now makes that boundary self-evident.

## §2. Ownership (Locked)

| Responsibility | Owner | Auto Prep's relationship |
|---|---|---|
| Job discovery | Existing Job Search architecture | Auto Prep reads jobs already surfaced — never fetches, dedupes, or normalizes postings itself |
| Job qualification (scoring, eligibility, confidence) | Career Compatibility Engine (`src/lib/compatibility/`) | Auto Prep reads `buildCompatibilityRecord`'s already-computed output — never recomputes, never a second scoring formula |
| Package generation, validation | Existing Smart Apply (`App.jsx`'s `buildSmartApplyPrompt`/`validateSmartApplyPackage`) | Auto Prep calls the identical, unmodified functions manual Smart Apply already uses (§7) |
| Automatic selection, budget enforcement, queue placement | **Smart Apply Auto Prep (new)** | Its one genuine responsibility |

Auto Prep is a pure consumer of two existing deterministic systems and one existing generation pipeline. It owns exactly one thing: deciding, within budget, which already-qualified jobs to prepare automatically and when.

## §3. Qualification (Locked — Closed Input List)

Qualification uses **only** the Career Compatibility Engine's existing outputs:

- **Match Score** (`compatibility.match_score`)
- **Eligibility Gates** (`compatibility.gates` — must all pass)
- **Confidence Tier** (`compatibility.confidence` — must be **High**; a stricter bar than manual Smart Apply, which has no such restriction, because the system should not act unattended on a job it isn't confident about)

No additional input is introduced. No new ranking system, no behavioral inference, no second Compatibility Engine, no AI-driven qualification judgment of any kind. A job either has `gates.passed === true` and `confidence === "High"`, or it does not qualify for automatic preparation — full stop.

## §4. Selection Rule (Locked — Preparation Order)

Among jobs passing §3, preparation order is **entirely determined by `match_score`, descending**. Random selection is prohibited. FIFO (discovery-order) selection is prohibited. Ties broken deterministically (e.g., by confidence tier, then discovery recency) — never randomly.

Selection logic: take qualifying jobs sorted by `match_score` descending, prepare from the top until either the day's remaining budget (§5) or the list of qualifying jobs is exhausted. The AI budget is always spent on the user's strongest deterministic opportunities first — this is a direct, mechanical consequence of the sort, not a separate judgment.

## §5. Daily Preparation Setting (Locked — User-Facing)

Replaces any "Automation Level"/"Trust Tier" framing in the UI entirely. One setting:

| UI Label | Meaning |
|---|---|
| Off | No automatic preparation |
| 1 application/day | Up to 1 automatic preparation per day |
| 2 applications/day | Up to 2 automatic preparations per day |

**Always-visible helper text below the setting:** *"Max 20 AI-prepared applications/month."*

**No "Level 1," "Level 2," "Level 3," "Tier," or "Automation Level" terminology appears anywhere in the UI.** Internally, the stored value is a plain integer (0/1/2) with a feature-defined meaning — never an abstract "level" requiring a lookup table to interpret (§11).

## §6. Monthly Cost Ceiling (Locked)

**20 Smart Apply packages per month, fixed.** Not user-configurable, and — critically — **not scaled by the daily setting**. Both "1/day" and "2/day" share the identical 20/month hard stop; the daily setting only controls *pacing* within that fixed ceiling (a "1/day" user takes at minimum 20 days to exhaust it; a "2/day" user could exhaust it in as few as 10 days, but never exceeds it either way). This is a genuinely predictable, market-condition-independent cost ceiling, exactly as required: a hot week with 30 qualifying jobs costs the same as a slow week with 2.

| Daily setting | Daily cap | Monthly cap |
|---|---|---|
| Off | 0 | 0 |
| 1 application/day | 1 | 20 (fixed) |
| 2 applications/day | 2 | 20 (fixed) |

## §7. AI Generation — Identical to Manual (Locked)

Auto Prep calls the **exact same, unmodified** generation and validation functions manual Smart Apply already uses — the same `buildSmartApplyPrompt`, the same `askClaude` call shape, the same `validateSmartApplyPackage` gate to `ready`/`needs_review`. No new prompt. No different validation. No quality difference of any kind between a manually-triggered and an automatically-triggered package.

**Premium differentiation is automation, not AI quality** (locked, §10 below) — this is the architectural guarantee that makes that claim true, not just a marketing statement.

## §8. Internal Safety Controls (Not UI-Exposed)

The following remain internal implementation details, never surfaced with this terminology to the user:

- Qualification Boundary (§3)
- Cost Boundary (§5/§6)
- Daily limit / Monthly limit enforcement
- **Duplicate prevention** — reuses the existing `enqueue()` dedup logic in `src/data/smartApply.js` unchanged (skips a job that already has a non-terminal queue row). No new duplicate-detection logic is introduced — the original "Employer Memory" concept is fully removed, not relocated, because this existing check already covers the legitimate underlying concern (see §11's validation note and §13).
- Queue management
- Held-not-discarded overflow
- Retry protection
- Budget protection

The user-visible language for any of these states is plain: e.g., "Ready to prepare — this month's limit is reached," never "Cost Boundary exceeded" or similar jargon.

## §9. Unified Fallback (Carried from the Decision Analysis, Unchanged)

| Outcome | Destination |
|---|---|
| Fails Qualification (§3) | Not selected for auto-prep; available for manual Smart Apply as today, unrestricted |
| Passes Qualification, fails Cost Boundary (§5/§6) | **Ready for Manual Preparation** |
| Passes both, but generation itself fails (timeout, worker failure, quota-service unavailable, malformed response) | **Ready for Manual Preparation** — same destination |

Both failure classes share one destination deliberately — "we didn't prepare it automatically" has one meaning to the user regardless of *why*. Generalizes the existing `markFailed` path already used by manual generation failures; no second failure vocabulary.

## §10. Premium User Experience (Locked)

Premium users never manually prepare packages for jobs that qualify — CareerPersona automatically performs resume tailoring, cover letter generation, recruiter message generation, networking message generation, package validation, and queue placement. The user only reviews and swipes/clicks Apply. No waiting for generation, no manual preparation step, for any job that qualified and fell within budget.

**Manual Smart Apply remains available, unchanged**, for jobs that don't qualify (e.g., a lower-confidence match the user still wants to try) or fall outside the current budget window — Auto Prep does not remove or gate the existing manual entry point; it simply makes it unnecessary for the jobs that matter most.

### Side-by-side (locked)

**Manual Smart Apply:** user selects a job → user starts Smart Apply → AI prepares one package → user reviews → user applies.

**Premium Smart Apply Auto Prep:** Career Compatibility Engine qualifies jobs → Smart Apply Auto Prep automatically prepares the highest-ranked qualifying jobs within the user's daily and monthly limits → user opens the queue → user reviews → user applies.

## §11. Automation Preference — Scope and Storage

The per-feature-vs-platform-wide question from the prior decision analysis is still architecturally live and still resolved the same way: **per-feature**, validated against Real-Time Interview Co-Pilot's categorically different automation axis (real-time intervention style vs. Smart Apply's background preparation pacing) — see the Architecture Decision Analysis for the full reasoning; unchanged by this revision.

**What changes here:** the stored value is no longer an abstract "level" mapped through a lookup table to differently-scaled caps (the prior draft's Levels 1–3 with escalating monthly ceilings). It's now a direct, literal daily-count preference (0/1/2), and the monthly ceiling is a fixed constant Smart Apply's own code supplies, not something encoded per level. This is simpler and more honest given §6's fixed, non-scaling monthly cap.

**Shared table** (platform infrastructure, `src/lib/platform/`):

| Field | Type | Notes |
|---|---|---|
| `user_id` | uuid FK | |
| `feature_key` | text | e.g. `smart_apply_auto_prep`; a future Interview Co-Pilot row uses its own key, zero schema change |
| `value` | integer | Deliberately opaque at the shared-table level — its meaning is entirely feature-defined. For Smart Apply, the feature's own code interprets it as "packages per day" (0/1/2). A future feature's code would interpret its own value in its own terms. |
| `updated_at` | timestamptz | |

**Shared interface** (`src/lib/platform/aiBudget.js`), unchanged in shape from the decision analysis, feature-key-scoped from the start:

```js
getAutomationPreference({ userId, featureKey })      // returns stored value, 0 if no row
setAutomationPreference({ userId, featureKey, value }) // ONLY ever called from a direct user Settings action
checkAndConsumeAutomationBudget({ userId, featureKey, dailyCap, monthlyCap })
// Smart Apply always passes monthlyCap: 20 (fixed), dailyCap: the user's stored value.
// Returns { allowed, reason: "daily_cap" | "monthly_cap" | null }. Never throws on cap-reached.
```

Reuses the existing `check_and_consume_quota` RPC for both the daily and monthly leg, exactly as the decision analysis specified — **verification required in Phase 1**: confirm the RPC's period-key parameter accepts an arbitrary key (e.g. a daily key format) rather than being hardcoded to monthly semantics; a small additive extension if not, not a new mechanism either way.

**Period basis (locked V1 design decision, confirmed in the §16 Daily Cron & Budget Boundary Verification):** both caps use **UTC calendar periods** (`aiBudget.js`'s `getDailyPeriodKey`/`getMonthlyPeriodKey`, `toISOString().slice(0,10)`/`.slice(0,7)`) — a single global schedule, not a per-user-local one. The preparation cadence itself is one daily Cloudflare Cron Trigger (`0 13 * * *` UTC), so every user gets at most one preparation opportunity per UTC day regardless of their own timezone — this is intentional, not an oversight: it keeps the Cost Boundary a single, auditable, timezone-blind counter, at the cost of every user's batch landing at the same fixed UTC instant rather than a locally-convenient time. A per-user-local-period design was not evaluated as a V1 requirement and would be a deliberate, separate enhancement, not a bug fix, if ever pursued.

## §12. Persistence

**`automation_preferences`** (new, shared platform table — see §11).

**Extends `smart_apply_queue`** (existing table, not a new parallel one):

| New field | Type | Notes |
|---|---|---|
| `generation_source` | text, default `'manual'` | `'manual' \| 'automatic'` — the Cost Boundary only ever applies to `'automatic'` rows |
| `generation_result` | text, nullable | **Reserved now, populated by nothing in V1.** `null \| 'accepted' \| 'edited' \| 'discarded'` — avoids a future migration when this feedback loop is eventually built. |

No new table for decisions/history — the original blueprint's `auto_apply_decisions` concept is not built; `smart_apply_queue` already is the record of what got prepared and how.

## §13. Six Original Concepts — Verdicts (Revised)

| Concept | Verdict | Where it lands |
|---|---|---|
| Investment Unit Budget | Redesigned | §5/§6 — fixed daily/monthly caps, not per-job unit weighting |
| Trust Modes | Redesigned | §5 — renamed Daily Preparation Setting, three plain states, no level terminology in UI |
| Professional Reputation Score | Removed | No clear function not already owned elsewhere; unchanged from the decision analysis |
| Employer Memory | **Removed** (revised from "Redesigned, narrow") | §8 — existing queue dedup already covers the legitimate concern; no new function introduced, per §3's newly-closed qualification input list |
| Competition Intelligence | Removed | No data source exists; unchanged |
| Eight-Stage Decision Engine | Redesigned, collapsed | §3→§5→§9 — the explicit sequence: qualify, select in rank order, check budget, generate, unified fallback |

## §14. Standing Governance Rules Applied

- **One Responsibility per Module** — Auto Prep's sole responsibility is automatic selection + budget-gated preparation of already-qualified jobs; nothing else.
- **Ownership Rule** — §2 states owner/consumer explicitly for every piece before any code is written; Auto Prep introduces zero new ownership of discovery or qualification.
- **AI Justification Rule** — Generation itself was already justified for manual Smart Apply; nothing new is asked of the AI here. Qualification and selection are 100% deterministic.
- **Reuse Before Recreation** — Compatibility Engine, existing queue dedup, existing `markFailed` vocabulary, existing generation/validation functions all reused unmodified.
- **Qualification Boundary before Cost Boundary** — §3 always evaluated before §5/§6; a job never consumes budget it wouldn't have qualified for anyway.
- **Deterministic qualification before AI generation** — no AI involvement anywhere upstream of §7.
- **AI generates content only; AI never submits applications; the user always makes the final decision** — locked in §1's workflow and unchanged by anything in this revision.

## §15. Required Blueprint Validation (Answered)

- Does not duplicate Job Search responsibilities — confirmed, §2.
- Does not duplicate Career Compatibility Engine responsibilities — confirmed, §2/§3.
- Does not introduce a second ranking or qualification engine — confirmed, §3/§4.
- Uses the existing deterministic Compatibility Engine as the single source of truth for qualification — confirmed, §3, after removing the one item (Employer Memory) that would have violated this; see §13.
- Preserves all existing governance rules — confirmed, §14.
- Keeps Smart Apply Auto Prep focused on one responsibility only — confirmed, §2.

## §16. Decision Log

| Date | Decision |
|---|---|
| 2026-08-05 | Audit of existing Smart Apply performed; automatic generation found deliberately removed previously for cost/trust reasons; Compatibility Engine confirmed as the sole existing deterministic scorer. |
| 2026-08-05 | Options A/B/C evaluated; Option C (true autonomous submission) rejected on its own merits. Option B approved as the foundation. |
| 2026-08-05 | Automation Level scope resolved as per-feature, validated against Real-Time Interview Co-Pilot. |
| 2026-08-05 | First blueprint draft written under the name "AI Auto-Apply V1." |
| 2026-08-05 | **Locked product revision.** Feature renamed Smart Apply Auto Prep. Workflow locked to a 9-step never-auto-submits sequence. Qualification restricted to a closed input list (Match Score, Eligibility Gates, Confidence Tier only). Selection rule locked to rank-order-only (no random/FIFO). Automation Level UI replaced with a plain Daily Preparation Setting (Off/1/2) and a fixed, non-scaling 20/month ceiling. Internal safety controls confirmed not UI-exposed. Premium differentiation locked to automation only, generation logic confirmed identical to manual. Required Blueprint Validation performed: one conflict found (Employer Memory violated the newly-closed qualification input list) and resolved by full removal rather than relocation, since the existing queue dedup already covers its legitimate concern. This document supersedes the prior draft. |
| 2026-08-06 | Job discovery recognized as platform infrastructure, not Proactive Job Alerts business logic. `fetchAdzuna`/`fetchRapid`/`normalizeAdzuna`/`normalizeRapid`/`deduplicate`/`fetchFreshPostings` relocated to `src/lib/platform/jobDiscoveryService.js`; Proactive Job Alerts and Smart Apply Auto Prep became independent consumers of one shared implementation, closing §2's "Auto Prep never fetches/dedupes/normalizes postings itself" against the real question of *how* it reads jobs already surfaced. |
| 2026-08-06 | §7's "identical, unmodified functions" guarantee made literal: `buildIdentityBlock`/`buildSmartApplyPrompt`/`validateSmartApplyPackage` (pure, no browser dependency) relocated from `App.jsx` to `src/lib/smartApply/generation.js`, shared by manual Smart Apply and Auto Prep's server-side cadence. The surrounding persistence layer (`src/data/smartApply.js`) was deliberately **not** relocated — it is a React hook bound to a browser session and a client-local orphan-recovery Set with no server-cron equivalent; `worker.js` implements its own service-role persistence functions replicating the same status semantics (queued → ready/needs_review/failed, same non-terminal-row dedup rule) rather than the same code, since the transport/auth model (RLS+session vs. service-role+cron) is fundamentally different. |
| 2026-08-06 | Phase 3 implemented: server-side cadence (`worker.js`, cron `0 13 * * *`, daily). Two gaps found and resolved during implementation, neither anticipated by the original blueprint (written assuming a browser session): (1) manual Smart Apply's `activeResumeId` is pure client React state, never persisted — Auto Prep instead requires an explicit `user_resumes.is_default` resume and **skips the user entirely if none is set** (no most-recently-analyzed fallback — locked decision, automatic preparation only ever acts on a resume the user explicitly chose); (2) `checkAndConsumeAutomationBudget`, deliberately left unbuilt in `aiBudget.js` per its own Phase 1 header note (the RPC is `service_role`-only), was built directly in `worker.js` as two independent `check_and_consume_quota` legs (`{featureKey}_daily`/`{featureKey}_monthly`) combined via `combineBudgetResults`. |
| 2026-08-06 | **Daily Cron & Budget Boundary Verification**, performed against the running Phase 3 implementation before proceeding to Phase 4. Findings, each verified by reading the actual source (not assumed): (1) both the daily and monthly period keys (`aiBudget.js`) are UTC-calendar-based (`toISOString().slice(0,10)`/`.slice(0,7)`), never user-timezone-based — confirmed no code path anywhere in the budget logic reads a user's timezone; (2) because the cadence itself is a single global cron (`0 13 * * *` UTC, not per-user-local), "UTC calendar day" and "anchored to the one daily cron execution" are equivalent in practice — there is exactly one opportunity per UTC day for any user's daily budget to be consumed; (3) no user can receive more or fewer preparations than their configured limit due to timezone — enforcement is one atomic, timezone-blind counter per `(user_id, feature, period)` (`check_and_consume_quota`'s `SELECT ... FOR UPDATE`); the only timezone effect is when in a user's local day the fixed 13:00 UTC batch lands, a UX fact, not a boundary bug; (4) Qualification Boundary (`eligibility.js`/`compatibility.js`/`confidence.js`) confirmed to contain zero `Date`/wall-clock/timezone references anywhere — fully deterministic; (5) **one real gap found**: `enqueueAutoPrepRow`'s non-terminal-row dedup check was a non-atomic SELECT-then-INSERT, exploitable by a redelivered/duplicate cron invocation (Cloudflare Cron Triggers do not guarantee exactly-once delivery) or a client-side double-click/multi-tab race on manual Smart Apply — **resolved**, not merely documented, via `20260806000002_smart_apply_queue_active_job_uidx.sql` (a partial unique index on `smart_apply_queue(user_id, job_id) WHERE status NOT IN ('applied','skipped')`), making the dedup rule a database-level invariant for both the automatic and manual enqueue paths; `enqueueAutoPrepRow` now treats the resulting 409 as the existing-row case, not an error. This section's global-UTC-period design (once-daily, single schedule, no per-user-local periods) is confirmed as an intentional V1 design decision, not an accidental implementation detail. |
| 2026-08-05 | Self-audit performed against every locked decision before lock. One deviation found: a documentation cross-reference in §7 pointed to the wrong section; corrected in place. No architectural deviations found. Qualification/Selection re-verified as existing-Compatibility-Engine-only; Employer Memory re-verified as completely removed with no renamed equivalent. |
| 2026-08-05 | **Blueprint locked.** Status updated from Draft to Locked — Implementation Reference Only. Implementation authorized. **Implementation Principle:** Smart Apply Auto Prep is an automation layer, not an intelligence layer. It consumes deterministic qualification and the existing Smart Apply generation pipeline; it owns no discovery, scoring, or application-submission logic. |

---

**Implementation status:** Locked. Proceeding phase-by-phase with architectural checkpoints, mirroring the LinkedIn Intelligence / Proactive Job Alerts / Referral Intelligence process.
