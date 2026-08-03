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
| `src/lib/compatibility/` (`compatibility.js`, `eligibility.js`, `confidence.js`, `skills.js`) | Job-to-candidate match score, eligibility gates, and data-coverage confidence tier. Versioned scoring config (`scoringConfig.js`), pure functions, zero LLM calls. | JobSearchPage (native UI, `match_score`/`ats_score` persistence); Proactive Job Alerts Discovery Engine (read-only match/eligibility evaluation) |
| `src/lib/outcomeIntelligence/patternEngine.js` | Outcome-pattern computation from logged applications; canonical definition of "responded" (`hasResponse`) and "positive outcome" (`isPositiveOutcome`) against the normalized `responseStatus` field; confidence tiers from outcomes-logged count. | Application Outcome Intelligence UI (native); Proactive Job Alerts Timing Intelligence (`marketSignals.js`, imports `hasResponse`/`isPositiveOutcome` — see Phase 6 fix, does not re-derive) |
| `company_watchlist` table (`status` column) | Dream-company status (`status === 'dream_company'`). No separate boolean flag exists anywhere. | Referral Intelligence, Application Outcome Intelligence, Proactive Job Alerts (all read `watchlistEntry.status` directly, never duplicate it) |
| `src/lib/proactiveJobAlerts/discoveryEngine.js` | Source aggregation, profile-match orchestration, signal enrichment, alert-tier assignment, confidence-tier assignment, diversity/balance constraints, delivery-cap enforcement. Deterministic only — never generates narrative. | `worker.js` scheduled cadences (server-side execution); `ProactiveAlertsPanel.jsx` (read-only display of persisted results) |
| `src/lib/proactiveJobAlerts/marketSignals.js` | Aggregate market/timing statistics: volume trend, hiring-freeze detection, salary signal, speed-of-fill, application-window stats. Reuses `patternEngine.js`'s eligibility definitions, never redefines them. | Analysis 03 (Market Intelligence), Analysis 06 (Timing Intelligence) |
| `src/lib/proactiveJobAlerts/watchlistActivity.js` | Per-company watchlist signal detection (new posting / volume increase / network contact joined / quiet). | Analysis 04 (Watchlist Activity Monitor) |
| `src/lib/proactiveJobAlerts/effectivenessMetrics.js` | Alert trust score, missed-opportunity detection, engagement trends, discovery coverage. | Analysis 05 (Alert Effectiveness) |

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

## Orchestration (no ownership of information, only of timing)

| Module | Responsibility |
|---|---|
| `worker.js` `scheduled()` + cadence dispatch | Cron timing, triggering, orchestration of the AI layer, delivery-pipeline persistence and state transitions. Owns none of the information it moves — every fact it persists was computed by one of the deterministic modules above. |

## Documented non-integrations (evidence, not silence)

- **LinkedIn Profile Intelligence** — no server-side persistence exists
  (`cp_resume_linkedin_profile` is `sessionStorage`-only). Not eligible for
  cross-feature consumption by any module until that feature has its own
  persisted store.

## How to extend this registry

When a new Premium feature is built, add one row per module it introduces to
whichever table above fits (deterministic ownership / AI responsibility /
orchestration), and add a **Consumers** entry to every existing row whose data
the new feature reads. If a new feature would need to write to a row it does
not own, that is the Ownership Rule signal to stop and escalate — not a
routine implementation decision.
