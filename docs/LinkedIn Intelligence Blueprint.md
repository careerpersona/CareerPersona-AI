# LinkedIn Intelligence — Architecture Blueprint

**Status: Locked — 2026-08-03 — Implementation Reference Only.**
Feature Blueprint · Free foundation + Premium layer · Placement: ResumePage (existing LinkedIn Optimizer tab, evolved) · Gate: Free deterministic core, Premium interpretive layer · Complexity: Medium

Formerly Premium Feature #1 ("LinkedIn Profile Intelligence" in the original blueprint sequence). Renamed to **LinkedIn Intelligence** 2026-08-03 after a codebase naming-collision search found no conflict (see [[project_governance_rules_locked]] / `docs/architecture/AI-Ownership-Registry.md`). Built as an evolution of the existing, shipped, Free-tier **LinkedIn Optimizer** (`src/App.jsx` Tool 8) — not a rewrite. Every claim about current behavior in this document is cited to the architectural audit performed 2026-08-03 (see Decision Log).

---

## §1. Defining Principle

The architectural audit found that LinkedIn Optimizer has zero deterministic logic: even the three scores it displays (`atsAlignmentScore`, `profileCompleteness`, `headlineScore`) are invented by the AI inside the same call that generates content, never computed in code. This is inconsistent with every other locked Intelligence feature in this codebase (Outcome Intelligence, Referral Intelligence, Proactive Job Alerts), all of which compute facts deterministically first and use AI only to interpret them — per the AI Justification Rule.

The governance decision resolving this (Decision Log, below) is: **compute what's objectively computable, let AI interpret what's genuinely subjective.** LinkedIn Intelligence is not "LinkedIn Optimizer plus more AI." It is LinkedIn Optimizer with a real deterministic foundation underneath it, plus a Premium layer of interpretation, strategy, and longitudinal intelligence built on top of that foundation — mirroring the shape every other locked feature already took.

**Product framing (locked):** Free is *"get real numbers for free."* Premium is *"pay for deeper intelligence."* Not *"pay to get real numbers."*

## §2. What Changes vs. What's Preserved

| | Today (audited) | LinkedIn Intelligence |
|---|---|---|
| Profile completeness score | AI-invented number | **Deterministic** — computed from actual resume field presence |
| Keyword/skill coverage | AI-invented "skills to add" / "keywords to feature" lists | **Deterministic** — computed via the Career Compatibility Engine's existing skill-extraction module |
| Headline score | AI-invented number | Removed as a bare number; folded into AI-interpretive guidance (there is no objective ground truth for "is this headline good" — see §4) |
| Headline / About / bullet rewrites | AI-generated content | **Preserved, unchanged** — this is genuinely generative work, not a fact being invented |
| Recruiter visibility tips | AI-generated generic tips | **Preserved as Free**; deepened into Recruiter Visibility Intelligence as a Premium capability (§5) |
| Persistence | Session-only (`sessionStorage`, cleared on session end) | **Persisted** — new table, owned by LinkedIn Intelligence (§6) |
| Premium gating | None — fully Free, no `isPremium` prop even reaches `ResumePage` | Free deterministic core + existing generation stay Free; new interpretive/longitudinal capabilities are Premium-gated |
| UI | Full results panel, score strip, chip lists, copy buttons | **Preserved** — same shell, same components, values re-sourced from the deterministic engine instead of AI JSON; new Premium sections added as Deep Dives, same pattern as every other locked feature |
| Localization | 10 LinkedIn-specific keys + shared result-panel keys, 13 locales | Preserved; net-new Premium-section keys added following the same rollout process used for Referral Intelligence / Proactive Job Alerts |

**LinkedIn Intelligence consumes the Compatibility Engine's skill extraction as a read-only dependency. The Compatibility Engine remains the owner of skill extraction and normalization under the Ownership Rule. LinkedIn Intelligence owns only the LinkedIn-specific interpretation and presentation of those outputs.**

**Existing Free functionality will not be reduced as part of this modernization.** Users gain trustworthy, reproducible numbers in place of AI-invented ones — they do not lose any capability currently available in LinkedIn Optimizer.

## §3. Free Tier — Deterministic Foundation

Two deterministic computations replace the two AI-invented scores that have an objective basis. Both live in a new pure module (no Supabase, no AI calls — same discipline as `discoveryEngine.js` / `patternEngine.js` / `scoringEngine.js`), e.g. `src/lib/linkedinIntelligence/deterministicScoring.js`.

**Profile Completeness Score** — percentage of a fixed checklist of resume/profile signals actually present: headline/title present, About/summary present and above a minimum length, each work experience entry has at least one bullet, a skills section exists with a minimum count, education present, (if a LinkedIn profile was pasted) headline and About present there too. Renormalized over only the checklist items that are structurally possible to evaluate from what's provided — the same "unavailable component excluded from the denominator, never scored as zero" principle already established in the Career Compatibility Engine's `compatibility.js`.

**Keyword/Skill Coverage Score** — reuses `extractSkillKeywords`/`normalizeSkill` from `src/lib/compatibility/skills.js` (already the platform's shared skill-extraction primitive, already used by job-search matching) rather than inventing a second implementation. Computed as resume-extracted skills vs. target-extracted skills (target = pasted job description if provided, otherwise the resume's own stated target role/title) — an overlap ratio, same shape as the Compatibility Engine's own Skills component. Produces a real "keywords to feature" / "skills to add" list from the actual gap, not an AI-improvised one.

**What stays AI, and why (AI Justification Rule):** Headline/About/bullet rewriting is generative work — there's no deterministic alternative that produces better prose, so AI is justified as-is. Recruiter-visibility tips and "headline quality" have no objective ground truth to compute against — judgment about what reads well to a human recruiter is inherently interpretive, so AI is the right tool, not a workaround. The distinction is not "less AI" — it's "AI only where a deterministic alternative was considered and found genuinely insufficient," which is what the rule has always required.

**Free tier keeps:** the existing generation workflow, the existing refine-with-pasted-profile flow, the existing UI shell, and now gets deterministic, reproducible scores instead of AI-invented ones — a strict quality improvement for Free users, not a downgrade.

## §4. Premium Layer — LinkedIn Intelligence

Each capability below is a single-responsibility AI module (per the One Responsibility per AI Module rule), consuming the Free tier's deterministic facts and the persisted history (§6) as its input — never recomputing them.

| Capability | AI Justification | Deterministic input | Output |
|---|---|---|---|
| **Profile Strategy Analysis** | Deciding *which* completeness/keyword gap matters most for this specific user's target roles is a prioritization judgment, not a formula — the deterministic engine can report the gaps, but not rank them by real-world impact. | Completeness breakdown, keyword coverage gap, target role/title | Prioritized action plan: what to fix first and why |
| **Recruiter Visibility Intelligence** | "How discoverable is this profile to a recruiter searching for X" depends on norms and judgment about search/discovery behavior — not a computable metric. | Headline, About section, keyword coverage, target role | Qualitative visibility guidance, deeper than the Free tier's generic tips |
| **Profile Evolution Tracking** | The score-over-time *diff* is itself deterministic (it's just data); the AI's job is narrating *why* it likely changed and what to focus on next — mirroring Outcome Intelligence's "AI changed its mind, here's why" transparency pattern (§9 of that blueprint). | Two or more persisted analysis snapshots (§6) | "Your completeness score rose from 62 to 81 after your last resume update; your keyword coverage for [role] is still your biggest gap" |

**Cross-feature integration (documented, not yet designed in depth):** LinkedIn Intelligence would become the sole owner of a "profile readiness" signal that other features could read — e.g., Proactive Job Alerts' Discovery Engine could consume a completeness/keyword-coverage signal the same way it already consumes Referral Intelligence and the Compatibility Engine (per the locked Ownership Rule: LinkedIn Intelligence owns this signal; consumers read it, never recompute it). **Any future module (Career Progress, Smart Apply Auto Mode, Interview Co-Pilot, etc.) may consume these deterministic outputs under the Ownership Rule, but no consuming module may redefine or recompute them.** This is noted as a future integration point for `docs/architecture/AI-Ownership-Registry.md`, not specified further here — designing it now would be implementation, not blueprint.

**What is explicitly not in scope for the Premium layer:** re-litigating the Free tier's content generation. Premium does not get a "better" headline/About rewrite — it gets interpretation, strategy, and history on top of the same generation everyone gets.

## §5. Ownership

| Module | Owns | LinkedIn Intelligence's relationship |
|---|---|---|
| `src/lib/compatibility/skills.js` (Career Compatibility Engine) | Skill extraction, skill normalization/dictionary | LinkedIn Intelligence **imports and reuses** this — never a second skill-extraction implementation. Confirmed already the platform's established shared primitive. |
| New `src/lib/linkedinIntelligence/deterministicScoring.js` | Profile completeness formula, keyword-coverage formula (using the Compatibility Engine's extraction, not duplicating it) | Owned by LinkedIn Intelligence. Any future feature wanting a "profile readiness" fact imports from here — never recomputes it. |
| New persisted table (§6) | The user's LinkedIn profile analysis history — content and scores | Owned by LinkedIn Intelligence exclusively. No other feature writes to it. |

**LinkedIn Intelligence owns the computation of Profile Completeness and Keyword Coverage, but it does not own skill extraction or normalization. Those remain permanently owned by the Career Compatibility Engine.**

## §6. Architecture — Persistence

**Confirmed prerequisite (audit §9):** LinkedIn Optimizer's output is session-only today (`sessionStorage`, cleared on session end) and the existing `resume_analysis_history` table only logs *that* a run happened, not what it produced. Neither is sufficient to build on. Persistence must be introduced as part of this feature, not assumed to already exist.

**New table** (name illustrative — exact schema is implementation, not blueprint): `linkedin_profile_analyses`.

Applies to **all tiers** — this is not Premium-gated infrastructure. Free users get their generation and scores saved (an improvement over today's session-only behavior); the Premium gate applies to which *capabilities* read/write the interpretive columns, not to whether the row exists at all.

| Field group | Contents |
|---|---|
| Identity | `id`, `user_id`, `resume_id` (nullable FK), `created_at` |
| Deterministic (Free, all tiers) | `completeness_score`, `completeness_breakdown` (jsonb), `keyword_coverage_score`, `keywords_matched` (jsonb), `keywords_missing` (jsonb), `weights_version` (mirrors the Compatibility Engine's own versioned-config pattern, so historical scores stay attributable to the formula that produced them) |
| Generated content (Free, all tiers) | `headline`, `about_section`, `experience_optimizations` (jsonb), `recruiter_visibility_tips` (jsonb) — the existing generation, now persisted instead of session-only |
| Interpretive (Premium only) | `strategy_analysis` (jsonb — narrative + the deterministic facts it cites, per the AI Explanation Rule precedent), `recruiter_visibility_intelligence` (jsonb) |

Row-per-analysis (not row-per-user) — consistent with `outcome_analyses`/`referral_analyses`, and required for Profile Evolution Tracking (§4) to have something to diff against.

**Historical rows must never be recalculated in place when deterministic formulas evolve.** New scoring versions produce new analyses; existing analyses remain historically accurate to the formula version that created them. This preserves the integrity of historical comparisons (Profile Evolution Tracking diffs two real, formula-attributed snapshots, never a snapshot silently re-scored under a newer formula) and is the reason `weights_version` exists on every row.

## §7. Standing Governance Rules Applied

- **AI Justification Rule** — Applied per-capability in §3/§4: every AI call has a stated deterministic alternative that was considered and found insufficient, not just "it wasn't separated yet."
- **AI Intelligence Architecture Rule – Data-Driven Availability** — Free deterministic scores are always available the moment a resume exists (no artificial gate). Premium capabilities gate on real data: Profile Evolution Tracking requires 2+ persisted analyses to exist before it can say anything; Profile Strategy Analysis and Recruiter Visibility Intelligence require at least one completed deterministic scoring pass — never a usage-count or time-based gate.
- **One Responsibility per AI Module** — Three distinct Premium capabilities (§4), each with one job; none recomputes another's inputs.
- **Reuse Before Recreation** — The single largest architectural finding of this blueprint: `src/lib/compatibility/skills.js` already exists and is reused directly rather than rebuilding skill extraction a second time.
- **Ownership Rule** — §5 states owner/consumer explicitly for every piece of shared logic and data, before any code is written.
- **Documentation Governance Rule** — This document is a **Blueprint**, a third document type alongside Frozen ADRs and Living References: it locks *before* implementation (not after, like an ADR) and becomes the fixed implementation reference once approved. It will be updated to "Locked" status only by explicit architect approval, then treated as frozen for the duration of implementation — the same discipline already applied to the existing locked blueprints for Outcome Intelligence and Real-Time Interview Co-Pilot.

## §8. Decision Log

| Date | Decision |
|---|---|
| 2026-08-03 | Architectural audit of the existing LinkedIn Optimizer performed and approved — confirmed zero deterministic logic, session-only persistence, no Premium gating, no cross-feature consumption (full findings in conversation record; summarized in §1–§2 above). |
| 2026-08-03 | Naming decision: canonical name locked as **LinkedIn Intelligence** (renamed from "LinkedIn Profile Intelligence"), confirmed via codebase-wide search to have no naming collision. |
| 2026-08-03 | **Option A vs. Option B evaluated.** Option A (preserve the Free tool unchanged, add a Premium layer on top) scored worse on 8 of 9 evaluation criteria (user trust, product consistency, long-term maintainability, Premium differentiation, Reuse Before Recreation, Ownership Rule, AI Justification Rule) — engineering effort was its only short-term advantage, and that advantage was judged to be a deferral, not a savings. **Option B (modernize the foundation, then build the Premium layer on top) approved.** |
| 2026-08-03 | **Governance ruling:** the AI Justification Rule applies to all user-facing AI-generated facts platform-wide, not only to new Premium features. The existing LinkedIn Optimizer's non-deterministic scores are ruled **legacy architecture that predates the governance rules, not a deliberate or permanent governance exception.** Correct action: modernize it as part of this initiative, not grandfather it. This ruling is precedent for any future feature found to have the same pattern. |
| 2026-08-03 | Blueprint drafted and reviewed section-by-section against the full document text (not a summary) across three parts, with four refinements incorporated during review (§2 Compatibility Engine ownership statement, §2 no-reduction-in-Free-functionality statement, §4 cross-feature consumer generalization, §5 explicit skill-extraction non-ownership statement) plus a §6 historical-immutability clarification. |
| 2026-08-03 | **Blueprint locked.** Status updated from Draft to Locked — Implementation Reference Only. Implementation authorized. |
| 2026-08-03 | Phase 1 (Free-tier deterministic engine) implemented and verified: `src/lib/linkedinIntelligence/deterministicScoring.js` (Profile Completeness, Keyword Coverage), `src/lib/linkedinIntelligence/scoringConfig.js` (versioned config). `parseResumeDoc`/`RESUME_SECTION_NAMES` relocated from `App.jsx` to a new shared `src/lib/resumeParsing.js` to avoid a circular import between App.jsx and the new lib module (the same bug class documented in ADR-Referral-Intelligence.md Evidence E.1) — pure relocation, no logic change. 24/24 new unit checks pass; full platform regression 321/321 pass (297 pre-existing + 24 new); `npx vite build` and `eslint` clean (App.jsx's pre-existing lint baseline unchanged, confirmed by diffing against the pre-change state). Architect-approved with one deferred follow-up: add an AI Ownership Registry entry for LinkedIn Intelligence's new deterministic outputs after Phase 2. |
| 2026-08-05 | Phase 2 (Persistence) implemented and verified: migration `20260805000000_linkedin_intelligence.sql` creates `linkedin_profile_analyses`, owned exclusively by LinkedIn Intelligence, applied and confirmed live in production (all 16 columns queryable via direct REST check). Append-only by design — no update path exists in the data-access layer, enforcing the §6 historical-immutability rule structurally, not just by convention. `src/data/linkedinIntelligence.js` (`useLinkedInProfileAnalyses`) added as the sole read/write hook for this table, mirroring `useReferralAnalyses`'s shape exactly; writes only the Free-tier deterministic/generated-content columns — the Premium interpretive columns remain unwritten until Phase 3. Not yet wired into `runLinkedinOpt`/the UI (still session-only in the running app) — that wiring is Phase 3/4 scope; full read/write behavioral verification will land then. Lint and build clean; full regression 321/321. |
| 2026-08-05 | Phase 3 (Premium AI Layer) implemented and verified. `src/lib/linkedinIntelligence/aiPrompts.js` added: Free-tier content-generation prompt (revised to drop `atsAlignmentScore`/`profileCompleteness`/`headlineScore`/`topSkillsToAdd`/`keywordsToFeature` now that they're deterministic or Premium-interpretive) plus two Premium capabilities (Profile Strategy Analysis + Recruiter Visibility Intelligence, bundled into one call) and Profile Evolution Tracking (separate call, own trigger point, never persisted — no column exists for it in the locked §6 schema, so it's recomputed on demand from two real rows instead). `runLinkedinOpt` rewired to call the new orchestration (`runLinkedinIntelligenceAnalysis` in `src/data/linkedinIntelligence.js`): deterministic scores computed first, Free content generated, Premium interpretation generated when available, **all persisted in one insert** — preserving the insert-only guarantee from Phase 2 exactly (no update path was added; Premium fields are populated at insert time, never backfilled onto an existing row). `isPremium` threaded into `ResumePage` for the first time (previously absent entirely, per the audit). UI adapted in place: 2-stat deterministic strip replaces the 3-stat AI-invented one, deterministic `keywords_missing` replaces the AI-improvised skill list, two new Premium sections and a Free-tier upsell note added, existing content-generation UI (headline/About/bullets/tips) untouched. Two real bugs caught and fixed before verification: an auto-fire race against the async persisted-analysis fetch (could have generated a duplicate analysis for a resume that already had one) and a stray `setLinkedinOptData(null)` call left over from the old session-state setter (would have thrown at runtime) — both found by tracing the code, not by the test suite. Verification: 34 new AI-layer unit checks + 8 new deterministic-diff checks (66 LinkedIn Intelligence unit checks total); full platform regression 365/365; end-to-end Playwright verification against the dev server across three scenarios (Free, Premium fresh, Premium with 2 prior analyses) — 39/39 checks, demonstrating the real deterministic computation, the real insert payload (confirmed field-by-field, including confirming the removed fields are actually absent), real tier-gating, and a real Profile Evolution click-through, not inferred from unit tests alone. AI Ownership Registry updated with LinkedIn Intelligence's deterministic and AI-responsibility rows, and its stale pre-Phase-2 non-integration entry corrected rather than silently deleted, per the Documentation Governance Rule. |

| 2026-08-05 | Phase 4 (UI refinement), Phase 5 (cross-feature ownership verification), Phase 6 (localization), and Phase 7 (RC validation) completed. Full evidence record in `docs/architecture/ADR-LinkedIn-Intelligence.md`. **LinkedIn Intelligence declared Release Candidate Complete and frozen.** |

---

**Implementation status: Complete.** All phases (1–7) implemented, verified, and RC-validated. See `docs/architecture/ADR-LinkedIn-Intelligence.md` for the full evidence record and freeze declaration. This blueprint remains the locked implementation reference; no further changes are made to it.
