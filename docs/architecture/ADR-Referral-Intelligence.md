# ADR: Referral Intelligence Architecture

**Status:** Accepted — Release Candidate Complete, Frozen
**Date:** 2026-08-02
**Owners:** Architect approval across Phases 1–9 (see Decision Log below)

## Context

CareerPersona AI already has an established pattern for "AI Intelligence" features (Outcome Intelligence being the most direct precedent): deterministic facts computed in code, a single AI call that interprets those facts into narrative guidance, and data-driven availability gating instead of usage-count gating. Referral Intelligence was scoped as the third Premium AI Intelligence feature, surfacing which of a user's networking contacts and target companies represent real referral opportunities.

Two forces shaped the architecture before any code was written:

1. **Referral-adjacent logic already existed, scattered.** `OpportunityPage` had its own inline case-insensitive company-name matching (once for the "Referral Opportunities" card, once for the Company Watchlist's "has contact" badge) — two independent copies of the same matching rule, with no scoring or ranking behind either.
2. **The project's own track record on duplicated logic.** Earlier AI Intelligence features in this codebase had already demonstrated that letting each consuming page compute its own version of a shared concept (matching, scoring) reliably drifts over time. The architecture review for this feature made single ownership a locked precondition before implementation began, not an aspiration to revisit later.

## Decision

### 1. Referral Intelligence is the single owner of referral business logic
No other module — Opportunity Intelligence, Smart Apply Auto Mode, Daily Briefing, Today's Action Plan, or any future Premium feature — may compute its own referral score, match, tier, or ranking. This was locked explicitly before Phase 1 implementation began and re-affirmed as a standing review check after Phase 7.

### 2. All referral scoring, matching, tiering, and ranking live in `scoringEngine.js`
`src/lib/referralIntelligence/scoringEngine.js` is a pure-function module (no Supabase, no AI calls — same discipline as `src/lib/outcomeIntelligence/patternEngine.js`). It exports:
- `computeRelationshipStrength(contact)` — per-contact 0–100 score + tier, from engagement (status), recency (60-day half-life), and follow-up investment, with true renormalization for missing dimensions (never zero-filled).
- `matchContactsToCompany(companyName, contacts)` — the single case-insensitive company-matching implementation, replacing the two independent copies that previously existed in `OpportunityPage`.
- `computeCompanyReadiness(...)` — per-target-company 0–100 score + tier + best-matched contact, gated on having both a contact and a target signal.
- `computeTargetCompanies(...)` — dedupes watchlist ∪ saved jobs ∪ applications into one target-company list.
- `computeReferralAvailability(...)` — the three data-driven availability predicates (see decision 6).
- `rankByScore(list)` — the single ranking implementation (`[...list].sort((a,b) => b.score - a.score)`), added mid-implementation once a Phase 6 review surfaced that three call sites had each written their own identical comparator (see Evidence, Runtime & Review Findings).

### 3. Deterministic engine and AI narrative are permanently separated
Scores, tiers, matches, and rankings are always computed in code first. The AI (`buildReferralIntelligencePayload` in `src/data/referralIntelligence.js`) is given the already-computed DATA blocks as prompt input and is instructed to prioritize/explain/suggest — never to calculate, re-rank, or invent a number not present in the DATA block. This mirrors Outcome Intelligence's "facts computed in code, AI only interprets" pattern exactly.

### 4. Networking hosts the primary UI; Referral Intelligence owns the logic
Following the architecture-placement review (which compared a standalone page against embedding in an existing surface, using Outcome Intelligence's Application Tracker integration and LinkedIn Profile Intelligence's Resume-page integration as precedent), Referral Intelligence was placed as a second, structurally isolated "Intelligence" tab inside `NetworkingPage`, sibling to the pre-existing Outreach tab (linkedin/email/followup/tips). No standalone page, no new Dashboard element. UI placement is a presentation decision; it does not change logic ownership — the tab renders `ReferralIntelligencePanel.jsx`, which itself contains zero scoring/matching/ranking logic (see Evidence).

### 5. AI interprets deterministic facts but never computes them
Enforced structurally, not just by prompt instruction: `buildReferralIntelligencePayload` only includes a section's prompt block and JSON-schema key when that section's availability predicate (from `computeReferralAvailability`) is true. The AI is never asked to decide whether a section is available — that decision is made in code before the AI is called at all.

### 6. Opportunity Intelligence consumes Referral Intelligence; it does not calculate its own
Phase 7 replaced `OpportunityPage`'s inline `referralJobs` matcher and `watchlistEnriched.hasContact` matcher with calls to the shared engine. The Referral Opportunities card is now genuinely two-tier: the ranked company list is *always* live output from `computeTargetCompanies`/`computeCompanyReadiness`/`rankByScore` (never gated on whether an analysis has run), and — layered on top — if a persisted `referral_analyses` row exists, its AI narrative (`content.analyses.topOpportunities.finding`) is read and displayed directly as an "AI Insight" callout, never recomputed.

### 7. Follows three existing platform-wide rules
- **Data-Driven Availability Rule** (locked earlier in this project, `docs/AI Intelligence Architecture Rule - Data-Driven Availability.md`): availability is computed from real data predicates, never from application/usage counts. Referral Intelligence has three independent predicates (`topOpportunities`, `outreachTiming`, `relationshipBuilding`) with no overall confidence tier — a deliberate scoping decision, since its dimensions are direct facts/counts, not statistical patterns needing a sample-size-based confidence measure (unlike Outcome Intelligence's Early Signal/Emerging/High Confidence ladder).
- **AI Justification Rule**: every AI-generated finding is paired with an `evidence` field naming the deterministic fact it's grounded in, and the prompt explicitly forbids inventing a score, rank, or fact not present in the DATA block.
- **One Responsibility per AI Module**: Referral Intelligence's single `askClaude` call has one job — synthesize narrative guidance from pre-computed facts. It does not fetch data, does not score, does not persist anything beyond its own output row.

## Consequences

- Adding a fourth consumer of referral scoring (a future feature) is a one-line import from `scoringEngine.js`, not a new implementation.
- Any future change to how relationship strength or company readiness is computed happens in exactly one file, and every consumer picks it up automatically.
- The cost of this discipline: `ReferralIntelligencePanel.jsx` and `OpportunityPage` both do slightly more wiring (mapping engine output to display state) than a page-local shortcut would require. This was accepted as the correct trade — see Evidence for the concrete case where skipping this discipline briefly crept back in and was caught.

---

## Evidence

This section is the record of *why* the architecture above was approved, not just what was approved. It is reproducible — every grep and script referenced here can be re-run against the current codebase.

### A. Codebase verification — referral logic centralization

**Method:** direct grep across `src/` (not visual inspection), run twice — once scoped to `App.jsx` after Phase 7, once broadened to the full `src/` tree as the final RC release check.

**Company/contact matching** — `grep -rn "c\.company.*toLowerCase|company.*toLowerCase\(\).*===.*toLowerCase" src/`: 9 matches. One is `matchContactsToCompany`'s own definition in `scoringEngine.js`. The remaining 8 were individually inspected and confirmed unrelated to referral matching: job-to-watchlist matching (`JobSearchPage`), application dedup (`TrackerPage`), a contact dedup key (`NetworkingPage`'s save flow), and — inside `OpportunityPage` — job-to-already-ranked-company lookups that consume the engine's output (`rc.companyName`) rather than compute a match of their own. Zero independent reimplementations of referral contact-matching found.

**Scoring/ranking comparator** — `grep -rn "b\.score - a\.score" src/`: **exactly 1 match**, inside `rankByScore()` in `scoringEngine.js`. (Before this was centralized in Phase 6's approval review, this exact comparator existed independently in three places — see Runtime & Review Findings below.)

**Full symbol audit** — `grep -rn "tierFor|TIER_THRESHOLDS|STATUS_ENGAGEMENT|recencyWeight|computeRelationshipStrength|computeCompanyReadiness|computeTargetCompanies|computeReferralAvailability|matchContactsToCompany|rankByScore" src/`: every match is either the definition in `scoringEngine.js` or an import+call site in a consumer (`ReferralIntelligencePanel.jsx`, `App.jsx`'s `OpportunityPage`, `src/data/referralIntelligence.js`). One incidental match — `patternEngine.js`'s own `recencyWeight` — was inspected and confirmed to be Outcome Intelligence's separate, differently-tuned function (30-day half-life, for application-outcome recency) for a different scoring domain, not a referral-logic duplicate.

**Conclusion:** Referral Intelligence is confirmed, by direct search rather than assertion, to be the sole owner of deterministic referral business logic in the codebase.

### B. Functional verification matrix — 40/40 passed

Script: `scripts/verify/verify-referral-intelligence-rc.cjs`. Four data-state scenarios plus error handling, each cross-checking `NetworkingPage`'s Intelligence tab against `OpportunityPage`'s Referral Opportunities card in the same browser context (both must reflect identical output from the same engine call for the same input data):

| Scenario | Checks | Result |
|---|---|---|
| 1 — No contacts, no target companies, no analysis | 9 | ✅ 9/9 |
| 2 — One contact, no matching target company | 9 | ✅ 9/9 |
| 3 — Contact with target company, no persisted analysis | 9 | ✅ 9/9 |
| 4 — Full data + persisted analysis + history | 10 | ✅ 10/10 |
| Error handling — Run Analysis backend failure | 3 | ✅ 3/3 |
| **Total** | **40** | **✅ 40/40** |

### C. Responsive verification — 34/34 passed

Script: `scripts/verify/verify-referral-intelligence-responsive.cjs`. Desktop (1400px), tablet (768px), and mobile (375px), checking zero horizontal overflow at every checkpoint (Outreach tab, Intelligence tab, both deep-dive sections expanded, Opportunity Intelligence page, Premium gate) — 34/34 automated checks passed. Supplemented with visual inspection of 4 mobile screenshots (Snapshot, expanded deep dives, Opportunity page, Premium gate): long strings ("Northwind International Holdings," full AI narrative sentences) wrap cleanly with no clipping, the 3-stat grid stacks correctly at mobile width, and the Premium gate renders centered and readable — matching the established Outcome Intelligence quality bar.

### D. Regression verification — 41/41 passed

Three regression suites, each re-run fresh at RC sign-off:
- `verify-networking-phase2-structural.cjs` — 10/10 (existing Outreach tab, all 4 sub-tabs, byte-for-byte unaffected by the new Intelligence tab).
- `verify-referral-intelligence-phase6.cjs` — 15/15 (Premium gating isolation, Snapshot, deep dives, Run Analysis flow).
- `verify-opportunity-phase7.cjs` — 16/16 (Opportunity Intelligence consumption of the shared engine).
- **Total: 41/41**, zero page errors across all three.

Localization regression: `git diff --stat` across all 14 locale files showed pure insertions only (378 lines added, 0 removed) — existing translations are provably untouched, not just assumed unaffected. Spot-checked pre-existing Spanish keys (`networking.title`, `theirName`, `coffeeChatLabel`, `opportunity.pageTitle`, `betterJobsTitle`) directly against source to confirm they remained translated and distinct from the English fallback.

### E. Runtime verification — issues found and resolved during development

Runtime (Playwright-against-dev-server) verification, not build success alone, was treated as the bar for correctness throughout — `npx vite build` succeeding was explicitly *not* trusted as sufficient evidence at two points where it would have missed a real defect:

1. **Circular-import TDZ crash (Phase 6).** `ReferralIntelligencePanel.jsx` imports `{ C, Btn, Card }` from `App.jsx`, which imports the panel back — a genuine circular dependency. A module-scope constant (`TIER_COLOR`) dereferenced `C.green` etc. at import time, before `App.jsx`'s own `export const C` had initialized in the cycle. `vite build` succeeded regardless (bundling doesn't execute module-eval order); the dev-server Playwright check caught `Cannot access 'C' before initialization` immediately. Fixed by converting the module-scope constant into a function called at render time.
2. **Duplicated ranking comparator (Phase 6 review).** An architect review of the newly-added "Warmest Contacts" list asked whether it was generated exclusively from the shared engine. Direct grep found the same `.sort((a,b) => b.score - a.score)` comparator independently written in three places (inside `scoringEngine.js`'s own `computeCompanyReadiness`, in the AI payload builder, and in the panel's contact ranking). None had drifted in behavior, but the duplication itself was flagged as violating single-ownership. Resolved by extracting `rankByScore()` into `scoringEngine.js` and re-pointing all three call sites at it — re-verified with the full regression suite (25/25 at the time) before sign-off.

Both issues were caught by verification designed specifically to test the thing that could plausibly break (import-cycle initialization order; logic-duplication under architectural review), not by incidental discovery — the verification approach was to run the actual dev server and interact with the real component tree, and to grep for exact duplicated patterns rather than trust a description of the code.

### F. Localization verification — complete coverage, namespace-validated

Before the 13-locale translation sweep, four explicit validations were run and passed:
1. **Coverage** — a script checked all 26 new `networking.*` keys and 1 `opportunity.referralAiInsightLabel` key against all 13 non-English locales; confirmed 0/26 and 0/1 present beforehand (a clean, uniform gap — not partial), then re-run after the sweep confirming 0 missing across all 13 locales.
2. **No hardcoded strings** — scanned `ReferralIntelligencePanel.jsx` and the `OpportunityPage` Referral Opportunities JSX for un-translated text nodes; every user-facing string routes through `t(...)`.
3. **Existing translations unmodified** — `git diff --stat` on all 14 locale files: pure insertions only.
4. **Namespace collision check** — read the full `opportunity` namespace (127 keys) end to end; `referralAiInsightLabel` is the only "Insight"-named key in that namespace, no exact or near-duplicate.

Translation strategy reused established precedent rather than inventing new phrasing: keys structurally identical to existing Outcome Intelligence keys (`referralUpgradeBtn`/`referralDeepDivesHeading`/`referralHistoryHeading`/`referralRunAnalysis`/`referralRunFailed`) reused each locale's already-shipped `oiUpgradeBtn`/`oiDeepDivesHeading`/etc. translations for consistency. One existing, 100%-consistent platform convention was discovered and followed: standalone feature-name headings (e.g. `oiPremiumTitle: "Application Outcome Intelligence"`, untranslated in all 13 locales) are kept in English as a product name — applied identically to `referralIntroTitle`/`referralPremiumTitle` (`"Referral Intelligence"`).

Runtime-verified (not just coverage-checked): a dedicated script navigated German, Japanese, and Arabic (RTL) sessions through the Intelligence tab, confirming tab labels, Snapshot heading, and tier badges render translated with zero page errors — 18/18 checks.

## Decision Log

| Phase | Decision |
|---|---|
| Architecture Audit & Placement Review | Standalone page vs. Networking-embedded tab evaluated; embedding approved. |
| Implementation Blueprint | 11 deliverables, locked: single ownership, tab placement, facts/narrative split, one new table, permanent rules. |
| Pre-implementation refinements | Scoring-engine single-ownership locked as a permanent rule; App.jsx encapsulation investigated (4 `export` keywords, zero logic change); Phase 5 split into 5A (structural) / 5B (functional, independent approval). |
| Phase 6 approval | Real UI approved after a refinement request centralized `rankByScore` (see Evidence E.2). |
| Phase 7 approval | Opportunity Intelligence consumption approved; scoring-engine ownership and namespace-integrity established as standing review checks for all future Referral Intelligence integrations. |
| Phase 8 approval | Localization validated (coverage, no hardcoded strings, no regression, no namespace collision) before the 13-locale sweep; sweep approved. |
| Phase 9 / RC approval | Full RC validation (Evidence A–F) passed; Referral Intelligence declared Release Candidate Complete and frozen. |

## Status: Frozen

No further feature work, polishing, or architectural changes are to be made under the Referral Intelligence implementation. Any future change is a separate roadmap item or enhancement request, subject to its own review.
