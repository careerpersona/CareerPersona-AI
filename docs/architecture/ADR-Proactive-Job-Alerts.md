# ADR: Proactive Job Alerts Architecture

**Status:** Accepted — Release Candidate Complete, Frozen
**Date:** 2026-08-03
**Owners:** Architect approval across Phases 1–8 (see Decision Log below)

## Context

Proactive Job Alerts was scoped as the fourth Premium AI Intelligence feature and the first passive one: instead of a user manually triggering analysis (Referral Intelligence, Application Outcome Intelligence), the platform continuously evaluates every opportunity across connected job sources on a schedule and surfaces only what crosses a real threshold. This shifted the architecture in two ways not present in earlier features:

1. **A four-layer pipeline was required, not a single engine + AI call.** Discovery (deterministic candidate evaluation) had to be separated from Scheduling (Cloudflare Cron timing/orchestration), which had to be separated from the AI Layer (interpretation) and the Delivery Pipeline (persistence/state). Each layer needed a locked, single responsibility so that a scheduled background process couldn't quietly accumulate logic that belonged elsewhere.
2. **The feature is the platform's largest cross-feature consumer to date.** It reads from Referral Intelligence, the Career Compatibility Engine, Application Outcome Intelligence, and Company Watchlist — more simultaneous dependencies than any prior feature. This made an explicit Ownership Rule ("who remains responsible for this information?") as important as the established AI Justification Rule ("why is AI needed here?").

By the time implementation began, this codebase already had two proven precedents to build on rather than reinvent: Outcome Intelligence's "facts in code, AI only interprets" split, and Referral Intelligence's single-ownership discipline for shared deterministic logic (`scoringEngine.js`). Both were reused, not redesigned.

## Decision

### 1. Four-layer architecture, each with one locked responsibility
- **Discovery Engine** (`src/lib/proactiveJobAlerts/discoveryEngine.js`) — deterministic only: source aggregation, profile matching, signal enrichment, tier assignment, confidence-tier assignment, constraint filtering, candidate selection. Never generates narrative.
- **AI Layer** (`aiPrompts.js` + the six analyses executed in `worker.js`) — interpretation, prioritization, narrative, guidance only. Never recomputes, alters, or replaces a Discovery Engine output.
- **Scheduler** (`worker.js`'s `scheduled()` handler + cadence dispatch) — timing, triggering, orchestration only.
- **Delivery Pipeline** (`persistAlertCandidates`/`markAlertsDelivered` in `worker.js`) — persistence, notification prep, state transitions only.

### 2. Six fixed AI analyses, one responsibility each
01 Critical Opportunity Engine (6h cadence), 02 Curated Weekly Pipeline, 03 Market Intelligence, 04 Watchlist Activity Monitor (12h cadence), 05 Alert Effectiveness Analysis, 06 Timing Intelligence — all documented with an explicit AI Justification (deterministic alternative considered / why insufficient / why AI is genuinely needed) in `docs/architecture/Proactive-Job-Alerts-AI-Analysis-Matrix.md`. Weekly analyses (02+03+05+06) are bundled into one `askClaude` call via conditional section inclusion, mirroring Referral Intelligence's weekly-bundling pattern — never four separate calls.

### 3. Deterministic ownership is never duplicated — reuse or import, never reimplement
Locked and verified concretely (see Evidence A):
- `discoveryEngine.js` imports `computeCompatibility`/`evaluateEligibility` from the Career Compatibility Engine (`src/lib/compatibility/`) — never recomputes match score or eligibility itself.
- `discoveryEngine.js` imports `matchContactsToCompany`/`computeRelationshipStrength` from Referral Intelligence's `scoringEngine.js` as a third caller, per that feature's locked single-ownership rule — never reimplements contact matching.
- Dream-company status is read directly from `company_watchlist.status === 'dream_company'` — no second boolean column was added anywhere.
- `marketSignals.js` imports `hasResponse`/`isPositiveOutcome` from Application Outcome Intelligence's `patternEngine.js` — the canonical eligibility definition for "responded"/"positive outcome" against the normalized `responseStatus` field. This was **not** true from the start: Phase 6 found and fixed a genuine duplicate-ownership violation where `marketSignals.js` had independently reimplemented this logic against the raw, un-normalized `status` field (see Evidence E).

### 4. AI Explanation Rule (locked, permanent)
"AI may explain why. It must never invent what happened." Every AI explanation traces back to a deterministic fact already produced by the Discovery Engine or another approved deterministic module — urgency factors, confidence score, delivery cap, diversity constraint, market signal, referral signal, compatibility result, outcome pattern. Enforced structurally: every persisted `alerts.explanation` row pairs the AI narrative text with a `basedOn` object naming the exact deterministic inputs it was given, and the UI renders both together (`AIInsightBlock` + `FactChips` in `ProactiveAlertsPanel.jsx`) — never the narrative alone.

### 5. Ownership Rule (locked, permanent, promoted to a standing review question)
For every integration point: which module owns the information, which module consumes it. Proactive Job Alerts may read, display, or incorporate existing intelligence but must never become a second source of truth for it. This is now, alongside the AI Justification Rule, a standing review question for every remaining Premium feature — explicitly including Smart Apply Auto Mode and Real-Time Interview Co-Pilot. The full ownership evidence table lives in `docs/architecture/AI-Ownership-Registry.md`, a living reference (not an ADR) intended to be extended, not rewritten, as each future feature ships.

### 6. Cloudflare Cron Triggers for scheduled execution, not pg_cron
Per the precedent already locked-but-unactivated in `20260722000006_billing_cron.sql`. Three schedules in `wrangler.toml`'s top-level `[triggers]` block: `0 */6 * * *` (Critical), `0 */12 * * *` (Watchlist), `0 6 * * 1` (Weekly) — no `--env` flag, matching the established deploy convention.

### 7. Deployment verification is mandatory for every phase touching `worker.js`
`npx vite build` succeeding is never treated as evidence of Worker correctness. Every phase that modified scheduling infrastructure required `wrangler deploy --dry-run` → real deploy (confirming bindings + "Deployed proxy triggers" with cron schedules listed) → local `wrangler dev --test-scheduled` firing verification before being considered complete.

### 8. Two genuine, evidence-based non-integrations — documented, not forced
- **LinkedIn Profile Intelligence**: no server-side persistence exists at all (`cp_resume_linkedin_profile` is `sessionStorage`-only, cleared on logout). Not integrable until that feature has its own persisted store.
- **`alert_source_id` feedback loop** (both `saved_jobs` and `applications`): `alert_candidates` has no `job_url`/`redirect_url` column, and `ProactiveAlertsPanel.jsx` has no click-through, save, or apply action on any card by design (Phase 5 built it as pure read-only display). Wiring this requires new UI surface — Phase 5/UX scope, not Phase 6 integration scope — and was deferred rather than forced through a fragile fuzzy match.

## Consequences

- Every future Premium feature that wants to read alert/candidate data does so by importing from the modules above, not by querying `alert_candidates`/`alerts` directly and reinterpreting the columns itself.
- The Ownership Rule + AI Ownership Registry give the next two roadmap features (Smart Apply Auto Mode, Real-Time Interview Co-Pilot) a concrete reference to check against before writing a single line of integration code — the two biggest sources of architectural drift (unnecessary AI, duplicate ownership) now have a standing check, not just a one-time review.
- The cost of the four-layer split: the Delivery Pipeline and Discovery Engine both do more explicit data-shape translation than a single combined function would need. This was accepted as the correct trade — it is what made the Phase 6 duplicate-ownership bug (Evidence E) findable by a direct grep instead of invisible inside a merged function.

---

## Evidence

Reproducible — every command referenced here can be re-run against the current codebase.

### A. Deterministic ownership — verified by import, not assertion

Direct inspection of `discoveryEngine.js` imports (not a description of intent):
```
import { computeCompatibility, evaluateEligibility } from "../compatibility/index.js";
import { matchContactsToCompany, computeRelationshipStrength } from "../referralIntelligence/scoringEngine.js";
```
`watchlistEntry?.status === "dream_company"` — the only dream-company check in the module; no second boolean column exists in the `company_watchlist` migration. `marketSignals.js` imports `hasResponse`/`isPositiveOutcome` from `patternEngine.js` (fixed in Phase 6 — see Evidence E for the violation this replaced). Full ownership table with consumer-by-consumer citations: `docs/architecture/AI-Ownership-Registry.md`.

### B. Regression verification — 295/295 passed

Re-run fresh at RC sign-off, via the Regression Runner (not ad hoc scripts):
| Suite | Checks | Result |
|---|---|---|
| `proactive-job-alerts` feature (discovery-engine-unit, market-effectiveness-unit, proactive-alerts-ai-layer-unit, watchlist-activity-unit, proactive-alerts-ui-phase5) | 170 | ✅ 170/170 |
| `referral-intelligence` feature (cross-feature regression — Discovery Engine is a third consumer of `scoringEngine.js`) | 125 | ✅ 125/125 |
| Outcome Intelligence data-driven availability (`verify-outcome-intel-data-driven-availability.cjs` — sanity check on the Phase 6 `patternEngine.js` export-only change) | 26 | ✅ 26/26 |
| **Total** | **321** | **✅ 321/321** |

### C. Localization verification — complete coverage, zero regression

`tools/localization-validator/`: coverage confirmed 0/71 keys (`nav.alerts` + full `alerts.*` namespace) missing across all 13 locales after the Phase 7 translation sweep (was 71/71 missing beforehand, a clean uniform gap). Zero key collisions. Diff purity: pure additions only (0 removed/modified lines across 14 locale files). Zero hardcoded-string advisory findings. The pre-existing, unrelated 65-key-per-locale gap (`pricing.*`/`savedJobs.*`/`settings.*`/`interview.*`, logged in `docs/backlog/Localization-Debt-Cleanup.md`) was confirmed identical in count before and after this feature's changes (verified by stashing and re-running the validator against the pre-Phase-7 state) — proving it is pre-existing debt, not something this feature introduced or left unaddressed.

### D. Runtime & deployment verification

**Worker deployment**: `wrangler deploy --dry-run --env=""` confirmed an identical 98.30 KiB bundle to the last real deploy (2026-08-03T04:28:53Z, version `706191ca-0fee-463d-80ee-0b2ef3681f52`, confirmed via `wrangler deployments list`) — proving the currently-live Worker matches the current codebase exactly, with no drift since Phase 6. All three cron schedules (`0 */6 * * *`, `0 */12 * * *`, `0 6 * * 1`) fired successfully via local `wrangler dev --test-scheduled`, dispatching correctly and reaching the Supabase call layer (the expected `supabase_get_401` boundary from this local session's placeholder secrets — confirmed via `/health` showing `"db":"unconfigured"` — not a code or import error).

**Runtime i18n**: LTR (Spanish, German) and RTL (Arabic) locales screenshot-verified rendering the `alerts` page correctly — right-to-left Arabic script displays properly within the app's existing LTR-mirrored layout (a pre-existing, unrelated architectural decision), with no clipping, overflow, or layout regression. Zero auth-screen leaks, zero page errors, across all tested locales.

**Manual end-to-end walkthrough** (interactive Playwright pass, not scripted assertions alone): real hamburger-menu click-through navigation from Dashboard to the Alerts page; non-premium gate correctly blocks content; premium critical-alert card renders with real data; "Why did this change?" transparency tool clicked and resolved a real async lookup, rendering the exact persisted `tier_change_reason` string; all 4 deep-dive accordions (Market Intelligence, Watchlist Activity, Alert Effectiveness, Timing Intelligence) present and interactive; zero unexpected console or page errors across the full walkthrough (the only excluded noise was two unrelated background billing endpoints the fake-session test harness cannot authenticate against, unrelated to Proactive Job Alerts).

### E. Duplicate-ownership violation found and resolved during Phase 6

While writing the Ownership Rule evidence table, a claim that `marketSignals.js` "reuses" `patternEngine.js`'s response-eligibility definitions was checked before being written down, per Phase 6's "demonstrate, don't assert" requirement. The claim was false: `marketSignals.js` had its own local `isPositiveOutcome`/`hasResponse` functions operating on the raw `status` field with hand-rolled string values (`"Interview"`, `"Offer"`, `"Applied"`, `"Ghosted"`), while `patternEngine.js` — the true owner — operates on the normalized `responseStatus` field (`"interview_invited"`, `"offer"`, `"pending"`) via `applications.js`'s `RESPONSE_STATUS_FROM_STATUS` mapping. Fixed by exporting `hasResponse`/`isPositiveOutcome` from `patternEngine.js`, removing the local duplicates from `marketSignals.js`, correcting `worker.js`'s `fetchUserAlertContext` to select `response_status` and map it to `responseStatus` (it had been reading the wrong, raw field), and updating the unit-test fixtures accordingly — all 29 `market-effectiveness-unit` checks still passed after the fix, confirming behavior was preserved while the duplication was removed. This is the concrete case the four-layer separation (Consequences, above) was designed to make findable.

### F. Production data verification

Both migrations confirmed live against production Supabase via direct REST queries (anon key, read-only, `limit=0` schema checks — no service-role key used): `alert_candidates`, `alerts`, `market_signals`, `alert_learning_weights` all return HTTP 200; `alerts.explanation`, `saved_jobs.alert_source_id`, `applications.alert_source_id`, and the full `alert_candidates` column set from migration 1 all resolve without a PostgREST schema error — confirming the live database matches the committed migration files exactly.

## Decision Log

| Phase | Decision |
|---|---|
| Kickoff | Blueprint re-confirmed aligned with current architecture; three routine blueprint-vs-reality conflicts resolved without escalation (skip `is_dream_company` column, consume `scoringEngine.js` directly, use Cloudflare Cron over pg_cron). |
| Phase 1 | DB migration approved and applied; verified live. |
| Phase 2 | Discovery Engine locked deterministic-only; reuses Referral Intelligence + Compatibility Engine. |
| Phase 3 | AI Analysis Layer approved after distinctness + AI Justification verified for all 6 analyses. |
| Phase 4 | Cloudflare Scheduler & Delivery Pipeline approved; mandatory deployment-verification discipline applied for the first time on this feature. |
| Phase 5 | User Experience Layer approved; AI Explanation Rule locked with full traceability evidence. |
| Phase 6 | Cross-Feature Integration approved; Ownership Rule locked and promoted to a standing rule for all future features; duplicate-ownership violation found and fixed (Evidence E). |
| Phase 7 | Localization approved, toolkit-verified, zero regressions. |
| Phase 8 / RC approval | Full RC validation (Evidence A–F) passed via Regression Runner, Localization Validator, deployment verification, and manual end-to-end validation; Proactive Job Alerts declared Release Candidate Complete and frozen. |

## Status: Frozen

No further feature work, polishing, or architectural changes are to be made under the Proactive Job Alerts implementation. The two documented non-integrations (§8) and any future enhancement are separate roadmap items, subject to their own review.
