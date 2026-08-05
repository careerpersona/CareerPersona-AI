# Architecture Governance Retrospective — Premium Roadmap #1–#6

**Status:** Living reference — written at the close of Premium Feature #6 (Real-Time Interview Co-Pilot), covers Premium Features #1–#6 in full.
**Date:** 2026-08-06
**Scope:** #1 LinkedIn Intelligence, #2 Application Outcome Intelligence, #3 Referral Intelligence, #4 Proactive Job Alerts, #5 Smart Apply Auto Prep, #6 Real-Time Interview Co-Pilot.

This document looks backward across the whole Premium roadmap, not forward at any one feature. It draws only on what each feature's own ADR (or, for #2, its Locked Blueprint — see §6) already recorded as evidence — it does not re-litigate any frozen decision, and nothing here reopens a frozen feature.

---

## 1. Governance rules that consistently proved valuable

These rules paid for themselves — each caught or prevented a real, specific defect, cited below, not just a theoretical risk.

**AI Justification Rule** ("why is AI needed here, what deterministic alternative was considered, why was it insufficient"). Directly responsible for:
- LinkedIn Intelligence's core finding: the pre-existing "LinkedIn Optimizer" had the AI invent its own scores (`atsAlignmentScore`, `profileCompleteness`, `headlineScore`) with zero deterministic backing — a direct violation, corrected by building `deterministicScoring.js` and reserving AI for genuinely generative/subjective work only.
- Real-Time Interview Co-Pilot's Option C rejection — the AI Justification lens made "should the AI act without an explicit per-instance request" the deciding question, not just cost or latency.

**Ownership Rule** ("who remains responsible for this information — a consumer may read it, never become a second source of truth"). Directly responsible for:
- Referral Intelligence's `rankByScore()` extraction (Phase 6): three independently-written, identical sort comparators found and consolidated to one.
- Proactive Job Alerts' Phase 6 fix: `marketSignals.js` had silently reimplemented outcome-eligibility logic against the *wrong, raw* field (`status` instead of normalized `responseStatus`) instead of importing the true owner's definition — a duplicate-ownership violation that was also, independently, a data-correctness bug.
- Real-Time Interview Co-Pilot's implementation-start finding: a pre-existing, uncommitted draft routed its cost check through the wrong (tier-based, effectively unlimited) quota bucket instead of owning its own dedicated boundary.

**Reuse Before Recreation.** Every feature from #3 onward reused at least one prior feature's deterministic engine or infrastructure rather than rebuilding it: Proactive Job Alerts imports Referral Intelligence's `scoringEngine.js` and the Compatibility Engine directly; Smart Apply Auto Prep extracted and shared `jobDiscoveryService.js` and `smartApply/generation.js` rather than duplicating worker-side and client-side logic; Interview Co-Pilot reused `check_and_consume_quota` unchanged, keyed differently, rather than inventing a second quota mechanism.

**Data-Driven Availability Rule** (availability computed from real data predicates, never from usage/application counts). Locked after Outcome Intelligence's confidence-tier system, then applied identically by Referral Intelligence's three independent availability predicates — the same rule, not a re-derivation.

**"Verify by search/diff, not assertion" as the default evidentiary standard.** Every ADR from Referral Intelligence onward includes reproducible `grep`/diff commands as evidence, not prose claims. This habit directly caught: the circular-import TDZ crash that `vite build` alone missed (Referral Intelligence, Evidence E.1); the `marketSignals.js` field bug (Proactive Job Alerts, Evidence E); a self-introduced transcription error in Smart Apply Auto Prep's `fetchRapid` extraction, caught by re-reading source rather than trusting memory; and, this feature, the fabricated "~1.96s" figure, caught by refusing to treat an unverified number as measured evidence and running the real spike instead.

---

## 2. New governance rules introduced during the roadmap

Governance here was not static — it grew in response to what each feature actually needed, not applied uniformly from day one.

| Rule | Introduced at | Why |
|---|---|---|
| AI Justification Rule, Data-Driven Availability, One Responsibility per AI Module, Reuse Before Recreation, Ownership Rule, Documentation Governance Rule | Locked before this roadmap's visible history, reaffirmed continuously | The original six-rule foundation every later addition builds on. |
| Ownership Rule promoted from "applied" to "standing review question for every future feature" | Proactive Job Alerts, Phase 6 | The feature's own scale (largest cross-feature consumer to date: Referral Intelligence, Compatibility Engine, Outcome Intelligence, Watchlist) made an implicit rule insufficient — it needed to be a checked step, not a background assumption. |
| AI Explanation Rule ("AI may explain why; it must never invent what happened") | Proactive Job Alerts, Decision 4 | Specific to narrative-generation features reading deterministic facts — enforced structurally (every persisted explanation pairs with a `basedOn` fact object), not just by prompt instruction. |
| Full ADR-with-reproducible-Evidence format (Context → Decision → Consequences → Evidence → Decision Log → Status) | Referral Intelligence | Application Outcome Intelligence (#2) shipped under a Locked Blueprint only, no ADR — see §6. The heavier format was adopted starting with #3 and has been used for every feature since. |
| "Audit existing capability before any design" as a mandatory first phase, even for features touching pre-existing shipped tools | LinkedIn Intelligence | Generalized from the finding that the existing LinkedIn Optimizer had no deterministic logic at all — auditing first, rather than assuming existing code is a safe foundation, became the standard opening move for every feature after. |
| Self-audit-and-report-exceptions as a review mode (vs. mandatory section-by-section review) | Smart Apply Auto Prep | Once enough shared precedent existed, full paragraph-by-paragraph blueprint review was replaced with "self-audit against the locked decisions, report only deviations" — a real process-efficiency change, not a relaxation of rigor (the audits still had to cite the exact locked constraint each check was verifying against). |
| **Cost Architecture Analysis** — a distinct phase between Decision Analysis and Blueprint | Real-Time Interview Co-Pilot | The first feature category (real-time, human-in-the-loop, live-conversation-adjacent) where "is this financially sustainable" could not be answered by the existing Audit → Decision Analysis → Blueprint sequence alone — it needed its own evidence-based modeling (interaction frequency, token consumption, per-session/monthly/scaling cost) before a blueprint could responsibly be drafted. |
| **Cost Drift Rule** (any future change that increases AI request frequency or token growth must trigger a new Cost Architecture Analysis before implementation) | Real-Time Interview Co-Pilot, locked as part of the Cost Architecture Analysis | Makes the Cost Architecture Analysis's conclusions non-transferable to a future, differently-shaped version of the same feature — closes the exact gap that would otherwise let a "small" future change quietly invalidate a cost model no one re-checked. |
| Human Factors as first-class architecture / Minimal Interaction Principle / Time-to-Answer Budget | Real-Time Interview Co-Pilot, Decision Analysis | The first feature category where "can a human actually use this in the moment it's intended" is a harder constraint than the prior five features' questions (who owns this, should AI do this, can we reuse infrastructure, what does it cost). **Deliberately scoped to this feature's own Decision Log, not elevated to permanent platform governance** — a considered choice to wait for a second real feature of the same shape before generalizing (see §5, Recommendation 3). |
| Documented Risk Disposition requirement at RC (a named risk must be explicitly Accepted-with-reasoning-and-trigger or Deferred-with-conditions, never left merely identified) | Real-Time Interview Co-Pilot, RC phase | Introduced ad hoc for this feature's cumulative-interruption risk; not yet a standing rule for prior or future features (see §5, Recommendation 4). |

---

## 3. Lessons learned across all six features

**Auditing first catches problems no amount of careful design later would have found.** LinkedIn Intelligence's audit found the existing tool's "scores" were AI inventions with no code behind them — a design pass starting from "improve the existing scores" would have preserved the defect. Interview Co-Pilot's audit found a pre-existing roadmap document overstated the codebase's actual AI call count (six claimed, three real) and described five `session_state` fields that didn't exist anywhere — a blueprint written from that document's claims, rather than verified source, would have been built on fiction.

**Build success is not runtime correctness, and this had to be learned more than once.** Referral Intelligence's circular-import crash passed `vite build` cleanly and only failed at runtime. This became codified as an explicit rule for Proactive Job Alerts ("`wrangler deploy --dry-run` succeeding is never treated as evidence of Worker correctness" — Decision 7) — a lesson from one feature turned into a written standing practice for the next, which is the retrospective process working as intended.

**Code that "looks complete" can silently violate a locked rule without ever erroring.** Two independent instances, in two different features, of the same underlying failure shape: `marketSignals.js` computed a plausible-looking number from the wrong field (Proactive Job Alerts); a pre-existing Interview Co-Pilot draft enforced a real-looking but functionally infinite quota. Neither would surface via a crash, a failed build, or a casual read — both required deliberate verification (grep for the true owner's export; trace the actual quota bucket to its limit value) to catch.

**Unverified numbers must never be allowed to masquerade as measured ones.** The clearest single incident of the whole roadmap: a blueprint file was found to contain a specific, plausible-sounding latency figure ("~1.96 seconds") that had never actually been measured by any tool call. It was rejected explicitly rather than accepted because it looked precise, and a real measurement (3,129ms and 3,657ms) was run in its place before anything was locked. This is the discipline this whole document is grounded in, demonstrated under real pressure, not just stated as a principle.

**Localization discipline matured from a blunt gate into a tool that supports deliberate exceptions.** Early features (Referral Intelligence, Proactive Job Alerts) treated "pure additions only" diff purity as an unconditional pass/fail signal. LinkedIn Intelligence needed a genuine exception (a canonical name correction touching 13 already-translated locales) and the process adapted: the exception was found, fully attributed, and documented rather than either silently allowed or used to block a legitimate correction.

---

## 4. Patterns repeatedly discovered and corrected

- **Duplicate business logic accumulating in consumer pages** — found *before* Referral Intelligence's Phase 1 even began (two independent copies of company-name matching already existed in `OpportunityPage`), then found *again*, inside Referral Intelligence's own implementation, three sessions later (three independent `rankByScore` comparators, Phase 6). The same failure mode recurred within a single feature's own build, not just across features — duplication pressure doesn't stop once a feature owns its logic; it has to be actively checked for at every review point, not just at kickoff.
- **A shared module silently reading the wrong field instead of the true owner's normalized one** — `marketSignals.js`/`patternEngine.js` (Proactive Job Alerts). The bug and the ownership violation were the same event, not two separate problems — worth remembering that "who owns this" and "is this correct" are often the same question asked two ways.
- **A pre-existing or draft implementation that appears finished but has no real enforcement behind its most important constraint** — Interview Co-Pilot's discovered draft had a complete-looking UI and a plausible quota check that, traced to its actual limit value, enforced nothing. The lesson generalized from Proactive Job Alerts' Evidence E: apparent completeness is not evidence of correctness; only tracing the actual enforced value is.
- **Self-caught transcription/memory errors during code relocation, corrected by re-verification before trusting a first draft** — this is a *positive* recurring pattern, not a bug pattern: Smart Apply Auto Prep's `fetchRapid` extraction was first drafted from memory, found wrong on re-read, and corrected via diff against the real source before it shipped. The discipline of re-verifying one's own work, not just the original code, shows up as a repeated (successful) safeguard across features.

---

## 5. Recommendations for improving the governance process going forward

1. **Make "inspect for pre-existing/uncommitted repository state before designing anything" an explicit, named kickoff step for every future feature**, not incidental diligence that happens to occur when something looks unusual. It mattered decisively for Interview Co-Pilot; there's no reason to rely on it being noticed rather than checked.
2. **Define an explicit trigger condition for when Cost Architecture Analysis is required**, rather than leaving it to be re-derived each time a feature "feels" like it might need one. A reasonable starting trigger: any feature involving real-time or live human interaction, or any feature projected to materially increase AI call frequency beyond the per-user patterns already established by shipped features. Without a named trigger, the risk is that feature #7 quietly skips a step that should have applied.
3. **Define an explicit graduation path for feature-scoped governance rules.** Human Factors / Minimal Interaction Principle / Time-to-Answer Budget were deliberately kept scoped to Interview Co-Pilot rather than generalized on a single data point. That was the right call with only one example — but there is currently no defined trigger for *when* a second feature needing the same shape of rule should cause it to graduate to permanent platform governance. Recommend: the second feature that independently needs the same rule is the trigger, not a fixed number or a calendar review.
4. **Formalize the Documented Risk Disposition requirement (Accepted-with-reasoning-and-trigger, or Deferred-with-conditions) as a standing RC gate for every future feature**, not something introduced ad hoc because it was asked for this time. A risk identified but left without an explicit disposition is exactly the gap this recommendation closes.
5. **Require a verification-method citation for any numeric claim entering a locked document** — a measured latency, a cost estimate, a regression count — either the exact tool call/script that produced it, or an explicit "estimate, not measured" label. This would have made the fabricated 1.96s figure visibly anomalous the moment it appeared (a number with no citation, in a document where every other number carries one), rather than something that had to be caught by memory of what had and hadn't actually been run.
6. **Decide, deliberately, what to do about Application Outcome Intelligence's missing ADR** (§6) — either backfill a minimal ADR for documentation consistency across the full roadmap, or explicitly record that it predates the ADR convention and is intentionally exempt, per the Documentation Governance Rule's own standard for frozen features. Leaving it unaddressed by default is the one inconsistency this retrospective surfaced without resolving.

---

## 6. Note on Application Outcome Intelligence (#2)

Application Outcome Intelligence shipped under a Locked Blueprint (`docs/Application Outcome Intelligence Locked Blueprint.md`, Status: "Architecture Locked — July 2026") with no accompanying ADR — it predates the ADR-with-reproducible-Evidence format that Referral Intelligence (#3) introduced. This retrospective does not backfill that gap or reinterpret the feature's frozen decisions; it is noted here as the one place this roadmap's documentation format is inconsistent across all six features, and left for a deliberate decision (Recommendation 6) rather than silently corrected or silently ignored.
