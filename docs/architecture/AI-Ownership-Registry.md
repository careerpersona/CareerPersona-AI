# AI Ownership Registry

Living architectural reference — not an ADR. Updated as new Premium features are
built. Its purpose is to answer, for any given piece of information used
anywhere in the app: **which module owns it, and who is allowed to read it.**

This exists because two questions have proven to be the main defense against
architectural drift in this codebase, and are now standing review questions
for every remaining Premium feature (including Smart Apply Auto Mode and
Real-Time Interview Co-Pilot):

- **AI Justification Rule** — Why is AI needed here? What deterministic
  alternative was considered, and why was it insufficient?
- **Ownership Rule** — Who remains responsible for this information? A
  consuming module may read, display, or incorporate another module's output,
  but it must never become a second source of truth for it.

A module appears in this registry once, under its owning feature. Every other
feature that touches its data is listed as a **consumer**, never as a second
owner.

## Deterministic ownership

| Module | Canonical ownership | Consumers |
|---|---|---|
| `src/lib/referralIntelligence/scoringEngine.js` | Contact-to-company matching (`matchContactsToCompany`), relationship-strength scoring (`computeRelationshipStrength`). Sole implementation — no module computes its own referral score. | NetworkingPage (native UI); Proactive Job Alerts Discovery Engine (`discoveryEngine.js`, read-only signal enrichment) |
| `src/lib/compatibility/` (`compatibility.js`, `eligibility.js`, `confidence.js`, `skills.js`) | Job-to-candidate match score, eligibility gates, and data-coverage confidence tier. Versioned scoring config (`scoringConfig.js`), pure functions, zero LLM calls. | JobSearchPage (native UI, `match_score`/`ats_score` persistence); Proactive Job Alerts Discovery Engine (read-only match/eligibility evaluation); Smart Apply Auto Prep (`isJobQualifiedForAutoPrep`/`selectJobsForAutoPrep`, read-only qualification/ranking against these records) |
| `src/lib/platform/jobDiscoveryService.js` | Server-side job-source fetching, normalization, and deduplication (Adzuna + JSearch/RapidAPI): `fetchAdzuna`, `fetchRapid`, `normalizeAdzuna`, `normalizeRapid`, `deduplicate`, `fetchFreshPostings`. Owns no qualification, scoring, ranking, or feature-specific business logic. Relocated 2026-08-06 from private `worker.js` helpers — it already had 2 consumers before the move (interactive Job Search, Proactive Job Alerts), formalizing pre-existing shared status rather than creating a new abstraction. | `handleJobSearch` (interactive Job Search endpoint, `worker.js`); Proactive Job Alerts' `runCriticalOpportunityCadence` (`worker.js`, passes its own `PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE` as the `resultsPage` parameter); Smart Apply Auto Prep's `runSmartApplyAutoPrepForUser` (`worker.js`, passes `SMART_APPLY_AUTO_PREP_RESULTS_PAGE`) |
| `src/lib/smartApplyAutoPrep/selection.js` | Qualification (`isJobQualifiedForAutoPrep`) and Selection (`selectJobsForAutoPrep`) for Smart Apply Auto Prep — reads the Career Compatibility Engine's already-computed `match_score`/`gates`/`confidence`, never recomputes them; introduces no ranking logic beyond a stable sort of `match_score`. | `runSmartApplyAutoPrepForUser` (`worker.js`) |
| `src/lib/smartApply/generation.js` | Smart Apply package prompt construction (`buildSmartApplyPrompt`) and Package Integrity Validation (`validateSmartApplyPackage`). Relocated 2026-08-06 from `App.jsx`, where these were already pure functions with no browser dependency, so manual Smart Apply (`App.jsx`) and Smart Apply Auto Prep (`worker.js`) call the exact same, unmodified functions — not two implementations kept in sync by convention. | Manual Smart Apply (`App.jsx`'s `smartApply`); Smart Apply Auto Prep's `runSmartApplyAutoPrepForUser` (`worker.js`) |
| `src/lib/platform/aiBudget.js` + `automation_preferences` table | Automation-budget mechanics (period keys, dual-cap combination) for any automation-capable feature — not just Smart Apply Auto Prep. The atomic RPC-consuming half (`checkAndConsumeAutomationBudget`) lives in `worker.js` itself (`check_and_consume_quota` is `service_role`-only, confirmed by reading the RPC grant directly), not in the shared pure module. | Smart Apply Auto Prep (`worker.js`, `dailyCap`/fixed 20 monthly cap); `src/data/automationPreferences.js` (client-side read/write of the stored preference value only, never the budget check itself) |
| `src/lib/outcomeIntelligence/patternEngine.js` | Outcome-pattern computation from logged applications; canonical definition of "responded" (`hasResponse`) and "positive outcome" (`isPositiveOutcome`) against the normalized `responseStatus` field; confidence tiers from outcomes-logged count. | Application Outcome Intelligence UI (native); Proactive Job Alerts Timing Intelligence (`marketSignals.js`, imports `hasResponse`/`isPositiveOutcome` — see Phase 6 fix, does not re-derive) |
| `company_watchlist` table (`status` column) | Dream-company status (`status === 'dream_company'`). No separate boolean flag exists anywhere. | Referral Intelligence, Application Outcome Intelligence, Proactive Job Alerts (all read `watchlistEntry.status` directly, never duplicate it) |
| `src/lib/proactiveJobAlerts/discoveryEngine.js` | Source aggregation, profile-match orchestration, signal enrichment, alert-tier assignment, confidence-tier assignment, diversity/balance constraints, delivery-cap enforcement. Deterministic only — never generates narrative. | `worker.js` scheduled cadences (server-side execution); `ProactiveAlertsPanel.jsx` (read-only display of persisted results) |
| `src/lib/proactiveJobAlerts/marketSignals.js` | Aggregate market/timing statistics: volume trend, hiring-freeze detection, salary signal, speed-of-fill, application-window stats. Reuses `patternEngine.js`'s eligibility definitions, never redefines them. | Analysis 03 (Market Intelligence), Analysis 06 (Timing Intelligence) |
| `src/lib/proactiveJobAlerts/watchlistActivity.js` | Per-company watchlist signal detection (new posting / volume increase / network contact joined / quiet). | Analysis 04 (Watchlist Activity Monitor) |
| `src/lib/proactiveJobAlerts/effectivenessMetrics.js` | Alert trust score, missed-opportunity detection, engagement trends, discovery coverage. | Analysis 05 (Alert Effectiveness) |
| `src/lib/linkedinIntelligence/deterministicScoring.js` | Profile Completeness (checklist renormalization), Keyword/Skill Coverage (target-vs-resume overlap), Profile Evolution diff (score delta between two persisted analyses). Imports the Career Compatibility Engine's skill extraction rather than reimplementing it — never owns skill extraction/normalization itself. | LinkedIn Intelligence's Premium AI layer (reads these facts, never recomputes them); `ResumePage`'s LinkedIn tool (native UI, Free tier) |
| `src/lib/resumeParsing.js` (`parseResumeDoc`) | Resume-text structural parsing (name, header lines, sections). Relocated from `App.jsx` Phase 1 so it has exactly one implementation platform-wide. | `App.jsx`'s resume rendering (PDF/DOCX/Print/Preview/Copy); `deterministicScoring.js`'s Profile Completeness check |
| `linkedin_profile_analyses` table | The user's LinkedIn Intelligence analysis history — deterministic scores, generated content, and Premium interpretive output, one row per analysis, insert-only (no update path exists in the data-access layer, so a historical row can never be recalculated in place). Owned exclusively by `src/data/linkedinIntelligence.js`. | `ResumePage`'s LinkedIn tool (native UI, both tiers) |

## AI responsibility — one module per concern

| AI module | Responsibility | Deterministic input it interprets | Never does |
|---|---|---|---|
| Referral Intelligence narrative (`scoringEngine.js` consumers) | Explains why a contact is a strong referral path | `scoringEngine.js` relationship scores | Compute its own relationship score |
| Application Outcome Intelligence narrative | Explains what a logged outcome pattern means for strategy | `patternEngine.js` pattern metrics | Compute its own response rate |
| Proactive Job Alerts — 01 Critical Opportunity Engine | Explains why a critical-tier candidate is urgent | Discovery Engine's urgency factors, match score, confidence tier | Decide which candidates are delivered (already decided deterministically) |
| Proactive Job Alerts — 02 Curated Weekly Pipeline | Explains why a curated-tier candidate is worth a look this week | Discovery Engine's curated candidates, stretch flag, industry | Re-rank or filter the pipeline |
| Proactive Job Alerts — 03 Market Intelligence | Interprets market conditions for the user's target roles | `marketSignals.js` volume/salary/freeze stats | Compute volume or salary trends itself |
| Proactive Job Alerts — 04 Watchlist Activity Monitor | Surfaces what's worth noticing across tracked companies | `watchlistActivity.js` per-company signals | Decide watchlist membership |
| Proactive Job Alerts — 05 Alert Effectiveness | Explains what the trust score / missed opportunities imply | `effectivenessMetrics.js` trust score, missed opportunities, trends, coverage | Compute the trust score itself |
| Proactive Job Alerts — 06 Timing Intelligence | Explains the best application-timing window | `marketSignals.js` application-window stats | Compute the window stats itself |
| LinkedIn Intelligence — Profile Strategy Analysis | Prioritizes which deterministic completeness/keyword gap matters most for the user's target role | `deterministicScoring.js` completeness breakdown + keyword gap | Re-score completeness or keyword coverage |
| LinkedIn Intelligence — Recruiter Visibility Intelligence | Qualitative assessment of how discoverable/compelling the profile is to a recruiter | Generated headline/About + keyword coverage facts | Invent a numeric visibility score |
| LinkedIn Intelligence — Profile Evolution Tracking | Narrates why a score changed between two persisted analyses and what to focus on next | `deterministicScoring.js`'s `computeProfileEvolution` diff (already computed) | Recompute the diff itself |

## Orchestration (no ownership of information, only of timing)

| Module | Responsibility |
|---|---|
| `worker.js` `scheduled()` + cadence dispatch | Cron timing, triggering, orchestration of the AI layer, delivery-pipeline persistence and state transitions. Owns none of the information it moves — every fact it persists was computed by one of the deterministic modules above. |

## Documented non-integrations (evidence, not silence)

- **LinkedIn Intelligence → other features (forward direction)**: LinkedIn Intelligence
  now has real persistence (`linkedin_profile_analyses`, added Phase 2) and could in
  principle expose a "profile readiness" signal to other modules (e.g. Proactive Job
  Alerts' Discovery Engine), per the locked blueprint §4. Not yet designed or built —
  documented as a future integration point, not implemented speculatively.
  (Superseded: this entry previously read "LinkedIn Profile Intelligence — no
  server-side persistence exists," true before Phase 2; kept as a corrected
  entry rather than silently deleted, per the Documentation Governance Rule's
  standard for living references.)

## How to extend this registry

When a new Premium feature is built, add one row per module it introduces to
whichever table above fits (deterministic ownership / AI responsibility /
orchestration), and add a **Consumers** entry to every existing row whose data
the new feature reads. If a new feature would need to write to a row it does
not own, that is the Ownership Rule signal to stop and escalate — not a
routine implementation decision.
