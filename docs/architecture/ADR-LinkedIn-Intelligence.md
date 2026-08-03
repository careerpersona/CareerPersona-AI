# ADR: LinkedIn Intelligence Architecture

**Status:** Accepted — Release Candidate Complete, Frozen
**Date:** 2026-08-05
**Owners:** Architect approval across the audit, Option A/B decision, blueprint lock, and Phases 1–7 (see Decision Log below)

## Context

LinkedIn Intelligence began differently from every prior Premium feature in this codebase: instead of building a new capability from a blank page, the process started with a mandatory architectural audit of an existing, shipped, Free-tier tool — "LinkedIn Optimizer" (`ResumePage` Tool 8) — per the locked Implementation Rule ("do not design from scratch").

The audit (2026-08-03) found that LinkedIn Optimizer had **zero deterministic logic**: even its three displayed scores (`atsAlignmentScore`, `profileCompleteness`, `headlineScore`) were invented by the AI inside the same call that generated content, never computed in code — a pattern inconsistent with every other locked Intelligence feature (Outcome Intelligence, Referral Intelligence, Proactive Job Alerts), all of which compute facts deterministically first and use AI only to interpret them. The audit also found the tool's output was session-only (`sessionStorage`), with no Premium gating anywhere in `ResumePage` at all.

This produced a genuine governance question, escalated deliberately rather than resolved unilaterally: **does the AI Justification Rule apply to all user-facing AI-generated facts platform-wide, or only to new Premium features?** Two options were evaluated (Option A: preserve the Free tool unchanged, add a Premium layer on top; Option B: modernize the deterministic foundation first, then build Premium on top). Option B was approved, and the existing non-deterministic scores were ruled **legacy architecture that predates governance, not a deliberate or permanent exception** — the correct action was to modernize, not grandfather.

## Decision

### 1. Deterministic foundation replaces AI-invented facts, exactly where a deterministic alternative exists
`src/lib/linkedinIntelligence/deterministicScoring.js` computes Profile Completeness (checklist-presence renormalization, mirroring the Compatibility Engine's "unavailable excluded from denominator, never scored as zero" principle) and Keyword/Skill Coverage (target-vs-resume overlap, reusing the Compatibility Engine's skill extraction directly). Headline/About/bullet generation and recruiter-visibility judgment remain AI — genuinely generative or genuinely subjective, with no deterministic alternative, which is the correct application of the AI Justification Rule, not an exception to it.

### 2. Reuse Before Recreation — the single largest architectural finding
`src/lib/compatibility/skills.js` (`extractSkillKeywords`/`normalizeSkillSet`) is imported directly, making LinkedIn Intelligence a third consumer of the Career Compatibility Engine alongside job-search matching and Proactive Job Alerts — never a second skill-extraction implementation. Separately, `parseResumeDoc` (resume-text structural parsing) was found already implemented and battle-tested inside `App.jsx`; rather than reimplementing it, it was relocated to a new shared `src/lib/resumeParsing.js` — a pure code move, zero logic change — so both `App.jsx`'s existing resume rendering and the new deterministic engine import one implementation, avoiding the exact circular-import bug class documented in Referral Intelligence's Evidence E.1.

### 3. Premium AI layer — three single-responsibility capabilities, deterministic-input only
Profile Strategy Analysis (prioritizes deterministic gaps), Recruiter Visibility Intelligence (qualitative visibility judgment), and Profile Evolution Tracking (narrates an already-computed score diff between two persisted analyses — the diff itself is deterministic arithmetic, never recomputed by the AI). Strategy Analysis and Recruiter Visibility Intelligence are bundled into one `askClaude` call (mirroring Referral Intelligence's conditional-section pattern); Profile Evolution Tracking is a separate call with its own trigger point, per One Responsibility per AI Module.

### 4. Persistence — one table, one owner, insert-only
`linkedin_profile_analyses` (migration `20260805000000_linkedin_intelligence.sql`) is owned exclusively by `src/data/linkedinIntelligence.js`. Applies to all tiers — Free users' work is now persisted too, not gated infrastructure. The data-access layer exposes only `refresh`/`saveAnalysis` (insert); **no update function exists anywhere in the module**, so a historical row cannot be recalculated in place — a structural guarantee, not a documentation promise. Premium interpretive columns (`strategy_analysis`, `recruiter_visibility_intelligence`) are populated in the *same* insert as the deterministic/content columns, never via a later write to an existing row. `weights_version` is stamped on every row so historical scores stay attributable to the formula version that produced them, even after a future formula change.

### 5. Profile Evolution Tracking is deliberately never persisted
The locked blueprint's schema (§6) allocates columns for exactly two interpretive outputs, not three — Profile Evolution Tracking's narrative is recomputed on demand from two already-persisted rows rather than given a column of its own, because storing it would be redundant with data that already exists and is cheap to re-derive.

### 6. Naming and UI consistency completed as part of this feature, not deferred
The feature's canonical name — **LinkedIn Intelligence** — was locked 2026-08-03 after a codebase-wide collision search found none. The live, user-facing UI title (`resume.linkedinToolTitle`/`linkedinPanelTitle`) previously read "LinkedIn Profile Intelligence" in English and all 13 other locales; this was corrected to the canonical name as part of this feature's own implementation (Phase 4), on the reasoning that a permanent naming inconsistency in the most user-visible surface would be worse than a deliberate, documented, one-time modification to otherwise-frozen translated strings (see Evidence D).

## Consequences

- Any future feature wanting a "profile readiness" fact imports from `deterministicScoring.js`; none may recompute completeness or keyword coverage independently.
- Free users keep every existing capability and gain trustworthy, reproducible numbers in place of AI-invented ones — a strict improvement, not a downgrade traded for Premium differentiation.
- The insert-only persistence model means any future capability needing to enrich an existing analysis (rather than create a new one) requires a genuine architectural decision, not a routine implementation choice — the current design makes that boundary structural rather than a convention someone could accidentally violate.
- Cross-feature consumption (e.g., Proactive Job Alerts reading a LinkedIn readiness signal) remains a documented, unbuilt future integration point (AI Ownership Registry) — not built speculatively during this feature's implementation.

---

## Evidence

Reproducible — every command referenced here can be re-run against the current codebase.

### A. Audit and governance decision

Full audit findings, the Option A/B evaluation (Option B won 8 of 9 criteria), and the governance ruling that legacy non-deterministic scores are not a permanent exception are recorded in the conversation record and summarized in `docs/LinkedIn Intelligence Blueprint.md` §1–§2 and §8 (Decision Log). The blueprint itself was reviewed section-by-section against its full text (not a summary) across three parts before being locked, with four refinements incorporated during that review.

### B. Ownership — verified by search, not assertion

`grep -rn "^function parseResumeDoc\|^export function parseResumeDoc" src/` → exactly one match (`src/lib/resumeParsing.js`). `grep -rn "^export function computeProfileCompleteness\|^export function computeKeywordCoverage\|^export function computeProfileEvolution" src/` → exactly one match each, all in `deterministicScoring.js`. `grep -rn "linkedin_profile_analyses" src/ worker.js` → the only real query site is `src/data/linkedinIntelligence.js`; every other match is a comment. `grep -rln "extractSkillKeywords"` confirms LinkedIn Intelligence as a legitimate third consumer of the Compatibility Engine (alongside `App.jsx` job-search matching and `worker.js`), not a second implementation. Full ownership table in `docs/architecture/AI-Ownership-Registry.md`, updated this feature — including correcting its own stale pre-Phase-2 entry in place rather than silently deleting it, per the Documentation Governance Rule.

### C. Regression and build verification — 365/365 passed

Full platform regression via the Regression Runner: **365/365 checks** (299 pre-existing + 66 new — 32 deterministic-engine unit checks including the Phase 3 Profile Evolution additions, 34 AI-layer unit checks). `npx vite build` clean throughout every phase. `eslint` on `App.jsx`: baseline unchanged at 146 problems/134 errors (confirmed by diffing against the pre-feature state at each checkpoint) — no new error class introduced; the one new-file lint condition (`react-hooks/set-state-in-effect` in `linkedinIntelligence.js`) is an established, already-tolerated pattern, confirmed identical in `referralIntelligence.js`, `resumes.js`, and `proactiveJobAlerts.js`.

### D. Localization verification

`tools/localization-validator/`: coverage confirmed 0 missing keys for all 9 new/changed LinkedIn Intelligence keys across all 13 non-English locales (translated in Phase 6). Zero hardcoded-string advisory findings. The pre-existing, unrelated 65-key-per-locale debt (`pricing.*`/`savedJobs.*`/`settings.*`/`interview.*`) confirmed identical before and after this feature — untouched, not addressed here, per the existing backlog.

**Diff purity — one deliberate, fully-attributed exception**: `git diff -U0 -- src/i18n/locales/*.js | grep "^-" | grep -v "^---"` shows exactly 39 removed lines, and every one of them is `linkedinToolTitle`/`linkedinPanelTitle`/`linkedinOptimizedStatus` across the 13 non-English locales — the intentional canonical-name correction (Decision §6), not accidental content drift. No other existing translation was touched.

Runtime-verified, not just coverage-checked: a Playwright pass against the dev server confirmed the deep-panel Premium content (not just the outer page) renders correctly translated in Arabic (RTL) and German (LTR) — canonical tool title, deterministic stat labels, and both Premium section headings — 10/10 checks, screenshot-confirmed clean RTL layout with no overflow, consistent with the app's existing (unmodified) LTR-mirrored RTL architecture.

### E. Runtime end-to-end verification — demonstrated, not inferred

Per the explicit Phase 3 instruction that "this is the point where end-to-end behavior is demonstrated rather than inferred": a Playwright harness against the dev server, with Supabase REST calls intercepted (not production data), exercised three real scenarios —

1. **Free tier**: real deterministic insert, real completeness/keyword-coverage computation confirmed field-by-field in the actual insert payload, confirmed the five removed fields (`atsAlignmentScore`/`profileCompleteness`/`headlineScore`/`topSkillsToAdd`/`keywordsToFeature`) are genuinely absent from the schema, Premium fields correctly null, upsell note rendered.
2. **Premium, fresh**: same deterministic checks, plus `strategy_analysis`/`recruiter_visibility_intelligence` populated in the *same* insert (no second write), both Premium sections rendered.
3. **Premium, with history**: auto-fire correctly skipped when a persisted analysis already exists (no duplicate generated), Profile Evolution button appeared only at 2+ analyses, clicked through to a real async narrative render.

39/39 checks passed. Two real defects were found and fixed *before* this verification ran, by reasoning about the new data flow rather than by the test suite catching them after the fact: an auto-fire race against the async persisted-analysis fetch (could have generated a duplicate analysis), and a stray `setLinkedinOptData(null)` call left over from the old session-state setter that would have thrown at runtime. The verification harness itself required two fixes (stale mock refresh state, wrong sort order) before it correctly reflected real Supabase behavior — both found and corrected before trusting its output.

### F. Production data verification

`linkedin_profile_analyses` confirmed live via direct REST query (anon key, read-only, `limit=0` schema check) — all 16 columns from the migration resolve without a PostgREST error, confirming the live database matches the committed migration file exactly, re-confirmed at RC sign-off.

## Decision Log

| Phase | Decision |
|---|---|
| Audit | Architectural audit of existing LinkedIn Optimizer performed — zero deterministic logic, session-only persistence, no Premium gating, no cross-feature consumption found. |
| Option A/B | Option B (modernize foundation, then build Premium layer) approved over Option A (preserve as-is, add Premium on top) — 8 of 9 evaluation criteria. Governance ruling: legacy non-deterministic scores are not a permanent AI Justification Rule exception. |
| Blueprint | `docs/LinkedIn Intelligence Blueprint.md` drafted, reviewed section-by-section against full text across 3 parts (4 refinements incorporated), then locked. |
| Phase 1 | Free-tier deterministic engine (`deterministicScoring.js`, `scoringConfig.js`) implemented; `parseResumeDoc` relocated to avoid circular import. 24/24 new checks, 321/321 regression. |
| Phase 2 | Persistence (`linkedin_profile_analyses` migration + `linkedinIntelligence.js` data hook) implemented, applied, verified live. Insert-only by design. |
| Phase 3 | Premium AI layer implemented and wired into the real user flow — deterministic engine and persistence became live, not just built. 66 new unit checks, 365/365 regression, 39/39 end-to-end scenarios. Two real defects found by code reasoning before testing. |
| Phase 4 | UI refinement: canonical naming correction applied to live UI (13 locales), mobile responsive verification (375px, Free + Premium) — 4/4 checks. |
| Phase 5 | Cross-feature ownership verification — single writer confirmed, single definition confirmed for every new function, no new integration built (consistent with the blueprint's own deferral). |
| Phase 6 | Localization — 9 new/changed keys translated into 13 locales, 0 missing, diff-purity exception fully attributed and documented, runtime i18n verification (RTL + LTR) 10/10. |
| Phase 7 / RC | Full RC validation — 365/365 regression, build/lint clean, localization validated, production migration re-confirmed live. Declared Release Candidate Complete and frozen. |

## Status: Frozen

No further feature work, polishing, or architectural changes are to be made under the LinkedIn Intelligence implementation. Documented future integration points (cross-feature consumption of the deterministic readiness signal) are separate roadmap items, subject to their own review.
