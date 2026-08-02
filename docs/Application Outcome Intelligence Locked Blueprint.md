# Application Outcome Intelligence — Architecture Blueprint

**Status: Architecture Locked — July 2026 — Implementation Reference Only**
Feature Blueprint · Premium · Placement: TrackerPage — Insights Tab · Gate: Premium Only · Complexity: Medium

Premium Feature #2 in the locked feature sequence (#1 LinkedIn Profile Intelligence, #2 Application Outcome Intelligence, #3 Referral Intelligence, #4 Proactive Job Alerts, #5 AI Auto-Apply V1, #6 Real-Time Interview Co-Pilot).

---

## §1. Defining Principle

Most job trackers answer one question: what happened? Application Outcome Intelligence answers a fundamentally different set: why did it happen, what patterns explain it, and what should the user do differently next? The distinction is the difference between a logbook and an analyst. The tracker is the logbook — it records events. Outcome Intelligence is the analyst that reads across every record, extracts the signal buried in the noise, and tells the user exactly what to change. The AI must become demonstrably smarter after every outcome logged. That is not a feature description — it is a performance requirement.

Analysis depth over analysis breadth. The six analyses defined in this blueprint are fixed. They do not expand with new analysis sections — they get progressively smarter as more outcome data accumulates. Each analysis evolves through confidence tiers. A Pattern Recognition finding based on 3 applications carries different weight than one based on 35, and the user always sees which they're looking at.

## §2. Platform Architecture Role

Outcome Intelligence is the platform's long-term learning memory — not an isolated analytics feature. It is a required dependency for every Premium module, not an optional enhancement. Every module that generates recommendations or surfaces intelligence must first ask: "What has Outcome Intelligence learned?" A module that ignores outcome patterns is producing generic output when it could produce evidence-based output. This is an architectural constraint, not a design preference.

**The `outcome_patterns` Table — Platform Interface**

- *What it is:* A persistent, queryable table of learned patterns that every module reads from. Updated after each analysis run. Each row is one learned pattern: type, value, response rate, sample size, confidence, stability, data completeness, first observed, last updated.
- *Why it exists:* Other modules should not run full outcome analyses themselves. They query `outcome_patterns` for the patterns relevant to their function. This is the clean interface between Outcome Intelligence and the rest of the system. No tight coupling — modules read structured data, not raw application records.
- *Required consumers:* Resume Intelligence, Job Intelligence, Opportunity Intelligence, Smart Apply, Interview Intelligence, Salary Intelligence, Networking Intelligence, AI Daily Briefing, Today's Action Plan, AI Career Assistant.
- *Availability gate:* The table is populated only after the first analysis runs (minimum 5 outcomes logged). Before that, consumers fall back to their default behavior. After the first analysis, they begin consuming outcome-aware patterns.

## §3. The Learning Engine

How the AI accumulates intelligence and knows how much to trust what it has learned.

Compound learning principle: Early analyses surface tentative hypotheses. Later analyses reveal high-confidence patterns. The system's recommendations must explicitly reflect this — a finding based on 3 applications carries a different weight than one based on 30, and the user must always know which they're looking at. The system does not pretend to know more than its data supports.

- **Under 5 outcomes** — No pattern analysis runs. The page shows raw stats only and a clear explanation of what the feature will learn as data accumulates. Learning Milestone progress visible. No recommendations generated from insufficient data.
- **Early Signal** — 5–15 outcomes. First patterns visible. Every finding is labeled "Early Signal." Phrased as: "Early evidence suggests..." not "you should..." Users are calibrated to treat these as hypotheses, not conclusions.
- **Emerging** — 15–30 outcomes. Patterns with consistent signals solidify. Confident recommendations begin. The system distinguishes between patterns that have held consistently and early signals that turned out to be noise.
- **High Confidence** — 30+ outcomes. Strong, specific recommendations. Predictive company profile scoring becomes meaningful. The system shifts from "consider" to "based on strong evidence from your history."

**Confidence Calculation — Four Factors**

- *Sample size:* Number of applications matching this pattern dimension. More data = higher potential confidence ceiling.
- *Consistency:* How consistently the pattern holds across observations. A pattern seen in 14 of 15 cases is more confident than one seen in 8 of 15.
- *Recency weight:* Recent outcomes weighted more heavily than old ones. The user improves — older data matters progressively less. A 90-day rolling window with exponential recency weighting.
- *Data completeness:* Outcomes logged / total applications older than 14 days. If the user has 80 applications but only 12 outcomes logged, confidence is capped regardless of what those 12 show. The 68 unlogged outcomes are unknown — they could be rejections. Missing data suppresses confidence.

*Pattern decay:* Patterns that no longer hold as the user improves must fade. A user who got 0% enterprise responses in Month 1 but has since improved should not be told to avoid enterprise in Month 4. Recency weighting handles this — the 90-day window means Month 1 observations carry very little weight when a strong counter-pattern has emerged recently.

## §4. Pattern System — Three Attributes per Pattern

Every pattern in `outcome_patterns` carries three orthogonal attributes.

- **Direction:** Positive (predicts responses) / Negative (predicts silence) / Neutral (no signal)
- **Confidence:** High (strong evidence) / Medium (emerging) / Low (early signal)
- **Stability:** Stable (consistent over time) / Changing (trajectory underway) / Volatile (inconsistent signal)

Why stability matters independently of direction: A pattern that is Negative + Stable is a reliable signal to act on (avoid this company type). A pattern that is Negative + Changing signals a trend in progress — the AI should say "enterprise response rates were poor but are improving over the last 6 weeks" rather than advising continued avoidance. A Volatile pattern should be presented as uncertain regardless of its current direction — insufficient consistency to act on confidently.

- *Example — Stable:* Enterprise companies: 3 months of consistent 0–3% response rate. Stable — confident recommendation to deprioritize.
- *Example — Changing:* Enterprise: Month 1 poor, Month 2 improving, Month 3 strong results. Changing — AI flags trend rather than replacing the previous conclusion silently.
- *Example — Volatile:* Startup companies: alternates between high and low response by month with no apparent driver. Volatile — AI presents as uncertain, does not make strong recommendation.

## §5. Timeline Intelligence — Cause and Effect

The AI should recognize when user improvements correlate with outcome changes and explain the likely causal relationship. Timeline Intelligence connects major user actions — resume updates, LinkedIn optimization, switching to Smart Apply, changing targeting strategy — with measurable outcome metric changes that follow. This moves the analysis from correlation ("your response rate improved in July") to causality ("your response rate improved in the 3 weeks after you updated Resume v3, which is the most likely contributing factor").

Worked example:

- *User Action* — Updated Resume v3 — improved bullet specificity, added PLG keyword. July 5 · sourced from Activity Log
- *User Action* — LinkedIn optimized — Hiring Readiness: Developing → Strong. July 8 · sourced from `linkedin_analyses`
- *User Action* — Started using Smart Apply — 6 packages generated. July 12 · sourced from `smart_apply_queue`
- *Outcome Change* — Response rate increased from 7% to 19% over subsequent 10 applications. July 22 · measured from `applications` table
- *AI Insight* — "After optimizing Resume v3 and starting Smart Apply, your interview rate improved significantly. Resume v3 shows the strongest correlation with this improvement based on application timing." Generated at next analysis run

**Data Sources**

- *User actions tracked:* Resume version changes (from `user_resumes` created_at / updated_at). LinkedIn analysis runs (from `linkedin_analyses`). Smart Apply first use (from `smart_apply_queue`). Significant application strategy changes (from `outcome_patterns` stability changes). Activity Log entries.
- *Outcome metrics measured:* Response rate (7-day rolling, 14-day rolling, 30-day rolling). Interview conversion rate. Application volume. Time-to-response average. Computed from the `applications` table before and after each action event.
- *Causal attribution approach:* The AI does not claim certainty — it says "most likely contributing factor" or "correlates strongly with." When multiple actions precede an improvement, it surfaces all of them and notes which shows the strongest timing correlation. Attribution is directional, not definitive.

## §6. Recommendation Impact Tracking

Recommendations become measurable. When a user marks a recommendation "Applied," the system records: which recommendation, the metric it targets, and a timestamp. At the next analysis run (or 30 days later if the user hasn't re-analyzed), the system evaluates whether the specific metric that recommendation targeted improved. This closes the loop on every recommendation — turning one-time suggestions into a tracked, accountable advisory system.

- *Trigger:* User marks recommendation Applied → system stores `recommendation_evaluation_due_at` (30 days from marking, or next analysis run, whichever comes first).
- *Evaluation:* Next analysis run after due date compares the metric the recommendation targeted (e.g., response rate on applications submitted within 48 hours) before vs. after the Applied date.
- *Attribution caveat:* The AI always notes that multiple factors may have contributed. "Since following this recommendation, your response rate improved 18% — though other factors may also have contributed." Honest attribution is non-negotiable.
- *Output format:* A "Recommendation Results" section in the analysis output: the original recommendation, the metric it targeted, the before value, the after value, and a plain-language evaluation. "Confirmed improvement," "No measurable change," or "Insufficient data yet."
- *No-change handling:* If a recommendation showed no measurable improvement, the AI notes it honestly and either retires the recommendation or investigates whether a different factor is overriding the effect. Recommendations that consistently fail to produce improvement are deprioritized in future analyses.

## §7. Learning Milestones

As data accumulates, new analysis capabilities unlock. The cold-start limitation becomes visible progress rather than a frustrating wall.

- 🔓 **Application Funnel** — Unlocks at 1 logged outcome — tracks response rate, stage conversion
- 🔓 **Early Pattern Analysis** — Unlocks at 5 outcomes — first hypotheses, Early Signal tier
- 🔒 **Industry Analysis** — Unlocks at 10 outcomes across 2+ industries
- 🔒 **Company Profile Fit** — Unlocks at 15 outcomes with company size data
- 🔒 **Resume Version Comparison** — Unlocks when 2+ resume versions have been used with 5+ each
- 🔒 **Predictive Company Scoring** — Unlocks at 30+ outcomes — high-confidence tier required

Milestone notifications are push-triggered: "Industry Analysis just unlocked — your outcome history now covers enough industries to find patterns." This creates a moment of delight and directly re-engages the user with the feature at each capability threshold, rather than expecting them to re-check the page on their own.

## §8. The Six AI Analyses — Fixed, Progressive

Six analyses. No additional sections ever. Each gets smarter over time as confidence tier increases — not replaced by new analyses.

### Analysis 01 — Response Pattern Analysis *(Core Analysis)*
"What do the applications that worked have in common?"

- *What it does:* Reads across all applications with logged outcomes and finds the common characteristics of those that received positive responses (interview invite, offer) versus those that received silence or rejection. Compares across all available dimensions simultaneously — not single-factor correlations but multi-factor patterns.
- *How it gets smarter:* At Early Signal tier, surfaces the single most obvious pattern. At High Confidence tier, surfaces multi-factor compound patterns ("Series B fintech, 200-1000 employees, applied within 72 hours of posting" is more predictive than any single factor alone).
- *Output:* "Applications that received responses share these characteristics. Applications that didn't share these. The largest gap between the two groups is [dimension]. Here is what that means for your next application."
- *Fields:* `response_status`, `company_size_estimate`, `industry`, `application_source`, `days_since_posted`, `cover_letter_sent`, `smart_apply_used`, `remote_policy`

### Analysis 02 — Funnel Stage Intelligence *(Funnel Analysis)*
"Where exactly in the hiring process am I losing?"

- *What it does:* Maps the user's entire pipeline — Applications → Response → Phone Screen → Technical → Final Round → Offer — and calculates conversion rate at each stage. The insight is which stage has the biggest leak, because each stage failure has a completely different fix.
- *Stage failure routing:* ATS rejection → keyword or qualification mismatch → Resume Intelligence. Phone screen loss → first impression or experience narrative → Resume Intelligence + Interview Prep. Technical round loss → skills gap → Interview Intelligence. Final round loss → cultural fit or competing candidate → interview coaching.
- *How it gets smarter:* Requires rejection stage data (the optional field users enter when logging a rejection). More complete stage data = more specific routing. At high confidence, can predict which stage a specific application type is likely to fail at before the user submits.
- *Fields:* `rejection_stage`, `response_status`, `first_interview_at`, `offer_received_at`

### Analysis 03 — Company Profile Fit *(Targeting Intelligence)*
"What type of company is most likely to hire me right now?"

- *What it does:* Builds a "responsive company profile" for this specific user — the combination of company characteristics that predicts positive outcomes. Paired with a "low-response profile" — the combination that consistently predicts silence. Both are directional guides, not permanent verdicts.
- *Characteristics analyzed:* Company size band, industry sector, funding stage where inferable, remote/hybrid/onsite policy, JD language signals (growth-stage vs. mature, collaborative vs. independent).
- *How it gets smarter:* At High Confidence, this analysis produces a Predictive Company Score for new job postings — a qualitative tier (High Fit / Moderate / Low Probability) applied before the user applies. Not a percentage — a tier with explanation.
- *Fields:* `company_size_estimate`, `industry`, `remote_policy`, `application_source`, `response_status`

### Analysis 04 — Application Quality Correlation *(Platform ROI Analysis)*
"Does improving application quality actually improve outcomes?"

- *What it does:* Closes the ROI loop on CareerPersona's own tools. Does Smart Apply increase response rates? Does applying with a cover letter help? Does a tailored resume (measured by Smart Apply match score) produce better outcomes? Does applying within 24 hours matter?
- *Why it's unique:* Only CareerPersona knows whether Smart Apply was used, what the AI match score was, which resume the user sent, or whether a tailored cover letter was written. External trackers have none of this data. This analysis is only possible here.
- *How it gets smarter:* Early tier confirms directional signals (Smart Apply seems to help). High confidence tier quantifies the effect (Smart Apply applications above match score 75 produce 2.1x the response rate). At scale, this data recalibrates Smart Apply's auto-preparation threshold.
- *Fields:* `smart_apply_used`, `smart_apply_score`, `cover_letter_sent`, `resume_version_id`, `days_since_posted`, `response_status`

### Analysis 05 — Resume Version Effectiveness *(Resume Intelligence)*
"Which resume is actually getting me hired?"

- *What it does:* Tracks response rates by resume version and surfaces which version outperforms others. More importantly, examines what's different between the high-performing and low-performing versions — based on the job types and company profiles each version was used for — and feeds that signal back into Resume Intelligence.
- *How it's possible:* Only because Smart Apply records which resume version was used in each queue item. This cross-table linkage is a unique data asset. Without the Smart Apply queue's `resume_id` field, version-level performance tracking is impossible.
- *Output:* "'Senior Engineer v2' has a 24% response rate vs. 9% for 'Senior Engineer v3'. Here's what's different about the applications where v2 was used, and what v3 might be doing wrong based on the JDs it was used for."
- *Fields:* `resume_version_id` (from queue), `response_status`, `company_size_estimate`, `industry`, `smart_apply_score`

### Analysis 06 — Strategic Prediction Engine *(Forward Engine)*
"Given everything learned, what should I do next?"

- *What it does:* Synthesis layer. After the other five analyses run, produces forward-looking strategic guidance with three components and one additional sub-analysis (Opportunity Cost).
  1. *Targeting recalibration* — Which company types to pursue more aggressively. Which to deprioritize. Explicitly time-boxed: "for the next 30 applications" — not permanent verdicts.
  2. *Application approach changes* — Based on Application Quality Correlation findings: "Apply to saved jobs faster, your conversion is 3.1x higher on same-week applications."
  3. *Resume and skills signals* — Based on skills and language patterns in JDs that responded versus those that didn't: what single resume change the pattern data most strongly suggests.
  4. *Opportunity Cost Intelligence (sub-analysis)* — Saved jobs never applied to, Smart Apply packages abandoned, high-match jobs that expired before application. "You missed 5 high-match opportunities this month because applications were delayed by more than 72 hours." This sub-analysis uses data that no other analysis section covers — it measures what didn't happen, not what did. Lives here, not as a standalone section, consistent with the six-analysis constraint.
- *Fields:* `saved_jobs` (not applied), `smart_apply_queue` (abandoned), `job_matches` (expired), all pattern dimensions

## §9. Insight Evolution & AI Transparency

Old conclusions are not silently replaced. Insights show their evolution, and when the AI changes its mind, it explains why.

- *Month 1:* Healthcare companies show very low response rates across 4 applications. → Healthcare: poor early signal. Recommend deprioritizing.
- *Month 2:* Healthcare showing first positive responses — 2 of 6 applications responded. → Healthcare pattern changing. After resume v3 update, responses improving.
- *Month 3:* Healthcare now strongest performing sector — 34% response rate. → Healthcare is now a primary target. Resume v3 + keyword changes drove this shift.

**When the AI Changes Its Mind — Required Format**

- *Trigger:* A pattern changes direction (negative → positive, or vice versa) between two consecutive analyses with at least 3 new data points in the changed dimension.
- *Required explanation:* The AI must state: (1) what the previous conclusion was, (2) what the new data showed, (3) how many new data points drove the change, (4) whether it attributes the change to user improvement, a timeline action, or natural variance.
- *Example format:* "Last month: Healthcare companies were a weak segment (4 applications, 0 responses). This month: 6 new healthcare applications after your resume update produced 2 responses. This pattern appears to be changing — likely connected to your resume v3 update on July 5."
- *Trust purpose:* Users who see the AI acknowledge its previous conclusions — and explain why it updated them — develop appropriate trust. They learn when to follow recommendations strongly and when to treat them as early signals. Unexplained changes erode trust; explained changes build it.

## §10. External Market Context

Sometimes declining outcomes are caused by the market, not the user. CareerPersona has no external hiring market data feed. Market context is inferred from two observable signals that already exist in the platform — not fabricated from unavailable data.

- *Signal 1 — Across-the-Board Decline:* If response rates drop simultaneously across ALL company types, industries, and application approaches in the same period, the pattern is unlikely to be user-caused. A user strategy failure typically produces decline in specific segments, not universal decline. Simultaneous universal decline is flagged as a probable external factor.
- *Signal 2 — Job Posting Volume Proxy:* The existing Job Intelligence API is a market proxy. If new job posting volume in the user's target role drops significantly week-over-week (detectable from the job search results), the AI surfaces this as a possible market context signal: "New job postings in your target role have decreased by 40% over the last 3 weeks — this may explain lower response activity."
- *Framing rule:* Market context is always surfaced as a possibility, never a certainty. "Recent hiring activity appears lower across your target market — this may be contributing to lower response rates." The AI does not falsely reassure ("it's not your fault") but does offer the context that prevents misattribution. The user makes the judgment — the AI provides the data.

## §11. Opportunity Cost Intelligence

What didn't happen is as analytically important as what did. Lives inside Analysis 06 (Strategic Prediction Engine) — not a standalone section.

- *What it measures:* Saved jobs never applied to. Smart Apply packages generated but abandoned (queue item reached "ready" but was never marked "applied"). High job match score postings that expired before the user applied. Applications delayed past the optimal timing window (based on the user's own response rate data for same-week vs. delayed applications).
- *Example outputs:* "You missed 5 high-match opportunities this month — applications were delayed more than 72 hours." / "3 Smart Apply packages were generated but never submitted. These represented companies in your highest-response segment." / "7 saved jobs expired without application. 4 were in your strongest-performing industry category."
- Opportunity Cost Intelligence uses data that no other analysis section covers — it measures inaction, not action. This is why it belongs in the Strategic Prediction Engine rather than any of the five pattern analyses, which all measure submitted applications. No overlap with TrackerPage — TrackerPage shows individual application records. Opportunity Cost aggregates across missed application events that never became records.

## §12. Dashboard Card

Dashboard = hiring pulse. Full page = deep analysis. The card creates urgency and curiosity; the page delivers substance.

Mock: *Outcome Intelligence · Full Analysis ↗* — 47 Applied · 9 Response (19%) · 5 Interview (56%) · 1 Offer (20%). **What's Working:** "Mid-market fintech responds to you 3.2× more than enterprise — your strongest segment." **What to Change:** "Apply within 48 hours — your conversion is 2.7× higher on same-week applications." *Last analyzed: 4 days ago · High Confidence*

The dashboard card always shows the single most actionable "What's Working" insight and the single most actionable "What to Change" signal — not statistics lists. If the confidence tier is below Emerging, the card shows raw funnel numbers only with a "Log more outcomes to unlock pattern insights" prompt. No Early Signal patterns surface on the dashboard — only Emerging or High Confidence findings.

## §13. Full Page Layout (Top to Bottom)

- **Zone 1 — Funnel Overview:** Visual pipeline: Applications → Response → Interview → Offer with real counts and conversion rates at each stage. Time-to-response average. Comparison to previous analysis period (↑ ↓ or —). This is data, not AI — computed directly from logged outcomes. Always visible regardless of confidence tier.
- **Zone 2 — Top AI Insights:** Three to five findings displayed as insight cards. Each card: the finding in plain language, the evidence ("based on 22 applications, 60 days"), the confidence tier badge, the stability badge, and the single recommended action. New insights since last analysis flagged "New." Market context flag surfaced here when triggered.
- **Zone 3 — What's Working / What to Change:** Explicit two-column view. Left: characteristics and behaviors that correlate with positive outcomes — stated as strategic assets. Right: specific shifts the pattern data supports — concrete behavior changes with evidence. No vague suggestions.
- **Zone 4 — Six Analysis Deep Dives:** Collapsible sections for each of the six analyses. Full pattern detail, confidence indicators, stability badges, data completeness display, charts. Timeline Intelligence visible within this zone as a supporting view for each analysis that has timeline events.
- **Zone 5 — Recommendation Results:** Tracks all Applied recommendations and their evaluation status: Confirmed improvement / No measurable change / Pending evaluation. Shows before/after metric for confirmed recommendations.
- **Zone 6 — Learning Milestones:** Current milestone status — what's unlocked, what's next, how close. Motivates continued outcome logging.
- **Zone 7 — Analysis History:** Timeline of all generated analyses. Differential view between any two consecutive analyses: which patterns strengthened, which weakened, what changed, what the AI changed its mind about and why.

## §14. Cross-Module Intelligence — Consumption Map

Every Premium module reads from `outcome_patterns`. A module that ignores outcome patterns is producing generic output when evidence-based output is available.

| Module | Relationship | How It Consumes |
|---|---|---|
| Resume Intelligence | Reads patterns | Resume Version Effectiveness feeds back version-level performance data. Skills that appear in JDs that produced positive outcomes become priority additions. Recommendations shift from generic best practice to "this specifically helps users with your outcome history." |
| Job Intelligence | Reads patterns | Job match scores recalibrated by outcome history. Company types in the high-response profile get score boost. Company types in the zero-response profile get score weight reduction. More fintech surfaces if fintech patterns are positive. The feed becomes personalized to what actually produces outcomes. |
| Opportunity Intelligence | Reads patterns | Companies matching the user's responsive company profile get elevated in the watchlist. Dream companies that also match the success profile get "High Probability" context. Companies matching the zero-response profile get a note — not hidden, but contextualized with outcome history. |
| Smart Apply | Reads + Writes | Application Quality Correlation data recalibrates the auto-preparation score threshold. If the data shows applications above match score 75 produce 2x outcomes, the threshold is calibrated accordingly. Smart Apply also writes to `outcome_patterns` via `resume_version_id` linkage — it's the source of version performance data. |
| Interview Intelligence | Reads patterns | Funnel Stage Intelligence tells Interview Intelligence which stage is the bottleneck. Phone screen loss → behavioral prep priority. Technical loss → technical depth priority. Final round loss → culture fit and negotiation focus. Prep becomes targeted at the stage that's actually failing, not spread generically. |
| Salary Intelligence | Reads patterns | Salary range alignment surfaces. If applications in a certain salary range consistently get responses and others don't, Salary Intelligence flags the gap: "You're targeting $180K but the roles responding to you cluster around $150–165K." |
| Networking Intelligence | Reads patterns | If referral applications convert at materially higher rates than cold applications — which most users find to be true — Networking Intelligence gets elevated priority in the Action Plan. The finding is quantified for this specific user, not stated as a general truth. |
| AI Daily Briefing | Reads patterns | Briefing gains outcome-aware context. "Your response rate drops on Monday applications — today's priorities favor saving applications for Thursday." / "You've applied to 6 enterprise companies with 0 responses — today's briefing recommends mid-market targets." Pattern changes surface as briefing highlights. |
| Today's Action Plan | Reads patterns | Action Plan becomes outcome-calibrated. If cover letters show positive correlation, the plan suggests writing one for today's application. If the user is behind historical application pace, the plan flags it. Best-performing resume version is surfaced if it hasn't been used recently. |
| AI Career Assistant | Reads patterns | Full read access to outcome patterns via UserContext. "Why am I not getting callbacks?" receives an answer grounded in real data: "80% of your applications go to enterprise companies, which is your lowest-response segment at 2% — your mid-market response rate is 3x higher." The assistant stops giving generic advice and starts giving this user's evidence-backed advice. |

## §15. Data Specification

**Extend table — `applications` — New Outcome Fields**

| Field | Type | Notes |
|---|---|---|
| `response_status` | text | `pending \| interview_invited \| rejected \| ghosted \| offer`. Default: `pending`. |
| `response_received_at` | timestamptz | When the user received a response. Nullable. |
| `rejection_stage` | text | `ats \| phone_screen \| technical \| final_round \| offer_stage`. Optional — user-provided when logging a rejection. Powers Funnel Stage Intelligence. |
| `first_interview_at` | timestamptz | First interview date. Nullable. |
| `application_source` | text | `linkedin \| indeed \| company_website \| referral \| direct`. How the user found and applied. |
| `cover_letter_sent` | boolean | Whether the user sent a cover letter with this application. |
| `resume_version_id` | uuid FK | Which resume version was used. Pre-populated from Smart Apply queue. Manual otherwise. |
| `smart_apply_used` | boolean | Was a Smart Apply package prepared for this application? |
| `smart_apply_queue_item_id` | uuid FK | Links to the full Smart Apply package when applicable. |
| `smart_apply_score` | integer | AI match score from Smart Apply if used. Nullable. |
| `days_since_posted` | integer | Approximate age of the job posting when applied. Powers timing analysis. |
| `company_size_estimate` | text | `startup \| small \| mid \| large \| enterprise`. User-provided or inferred from JD. |
| `industry` | text | Industry sector. Pre-populated from Job Intelligence where available. |
| `remote_policy` | text | `remote \| hybrid \| onsite`. From JD. |
| `referral_used` | boolean | Whether a referral contact was involved in this application. |
| `salary_range_min` / `salary_range_max` | numeric | From JD if disclosed. Nullable. |

**New table — `outcome_analyses` — Full Analysis Records**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | Standard primary key |
| `user_id` | uuid FK | RLS scoped to `auth.uid()` |
| `generated_at` | timestamptz | When this analysis was run |
| `period_start` / `period_end` | timestamptz | Applications window this analysis covers |
| `application_count` | integer | Total applications in the analysis window |
| `outcomes_logged_count` | integer | Outcomes with status logged — used for data completeness calculation |
| `confidence_tier` | text | `early_signal \| emerging \| high_confidence` — overall tier for this analysis run |
| `analysis` | jsonb | Full AI output: `{ analyses: [6 sections], topInsights[], whatWorking[], whatToChange[], marketContextFlag, opportunityCost, recommendationResults[] }` |

**New table — `outcome_patterns` — Platform Learning Memory**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | Standard primary key |
| `user_id` | uuid FK | RLS scoped to `auth.uid()` |
| `pattern_type` | text | `company_size \| industry \| timing \| cover_letter \| smart_apply \| resume_version \| referral \| remote_policy \| salary_range` |
| `pattern_value` | text | The specific value within that type (e.g., "mid" for company_size, "fintech" for industry) |
| `direction` | text | `positive \| negative \| neutral` |
| `stability` | text | `stable \| changing \| volatile` |
| `confidence` | text | `early_signal \| emerging \| high_confidence` |
| `response_rate` | numeric | Response rate for this pattern dimension (0.0–1.0) |
| `sample_size` | integer | Number of applications in this pattern bucket |
| `data_completeness` | numeric | Outcomes logged / eligible applications (0.0–1.0). Caps confidence when low. |
| `first_observed` / `last_updated` | timestamptz | When this pattern was first detected and most recently updated |
| `previous_direction` | text | Direction from the prior analysis run. Used to detect changes and trigger "AI changed its mind" explanation. |

**New table — `recommendation_evaluations` — Impact Tracking**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | Standard primary key |
| `user_id` | uuid FK | RLS scoped to `auth.uid()` |
| `recommendation_text` | text | The recommendation that was marked Applied |
| `target_metric` | text | Which metric this recommendation targeted (e.g., `response_rate_timing`) |
| `applied_at` | timestamptz | When the user marked the recommendation Applied |
| `evaluation_due_at` | timestamptz | 30 days after `applied_at` — when the system evaluates whether the metric improved |
| `metric_before` | numeric | Metric value at time of marking Applied |
| `metric_after` | numeric | Metric value at evaluation. Nullable until evaluated. |
| `evaluation_result` | text | `confirmed \| no_change \| insufficient_data`. Set at evaluation time. |

## §16. Settings

- *Analysis trigger threshold:* Minimum new outcomes required before a new analysis is recommended. Default: 5. User-configurable between 3 (more frequent) and 10 (wait for more data). The system will not auto-run — it recommends and the user initiates.
- *Outcome logging reminders:* Opt-in notification when an application crosses 14 days with no logged outcome: "Your application to [Company] is 14 days old. Log the outcome to keep your pattern data current." Keeps the data fresh without requiring users to remember.
- *Milestone notifications:* Push notification when a new analysis capability unlocks: "Industry Analysis just unlocked — log 2 more outcomes to unlock Company Profile Fit." On by default. Opt-out available.
- *Recommendation evaluations:* Whether the system automatically evaluates Applied recommendations at the 30-day mark. On by default. Users who want to evaluate manually can disable auto-evaluation.
- *Outcome data sharing:* Whether `outcome_patterns` data is available to AI Career Assistant and other modules. On by default. Users who want their Career Assistant to give generic advice rather than outcome-aware advice can disable — but this is a significant capability downgrade.
- *Confidence display:* Confidence tier badges are always shown — not a user preference. This is a product honesty commitment, not a UI option. Users cannot suppress confidence information.

## §17. Success Metrics

The core metric is behavioral change: users demonstrably adjusting their application strategy based on evidence. Reading insights without acting on them produces no hiring outcome improvement. Every metric below is a proxy for behavior change, not content consumption.

- *Outcome logging rate:* % of tracked applications with outcomes logged within 60 days. The existential metric — low logging rate kills intelligence quality. Target: 70%+ for Premium users actively using the feature.
- *First analysis within 14 days:* % of new Premium users who log 5+ outcomes and run their first analysis within 14 days of subscribing. Measures feature discovery and activation.
- *Re-analysis rate:* % of users who run a second analysis after logging new outcomes. Indicates the first analysis produced actionable value.
- *Recommendation applied rate:* % of recommendations marked Applied. Measures whether the output is actionable, not just readable. A recommendation that's never applied is a recommendation that's not landing.
- *Confirmed recommendation improvement rate:* Of Applied recommendations that reach their evaluation date, what % show "confirmed improvement"? Directly measures accuracy of the AI's recommendations. Target: >50%.
- *Cross-module pattern consumption:* % of active Premium users whose Job Intelligence scores are being influenced by `outcome_patterns`. Measures whether Outcome Intelligence is functioning as a platform dependency or remaining an isolated feature.
- *Interview rate correlation (longitudinal):* Do users who actively engage with Outcome Intelligence (high logging rate, multiple analyses, applied recommendations) achieve higher interview rates than matched users who don't? The ultimate success metric — requires 6+ months of data.

## §18. Competitive Advantage

**What competitors offer**

- *Excel / Notion / Airtable:* Manual databases. Users build their own columns and filters — the pattern analysis doesn't happen automatically. The insight burden is entirely on the user.
- *Teal / Huntr / Simplify / Jobscan:* Job trackers with better UI. Record what happened, show it visually. Some basic stats. No pattern analysis. No cross-module intelligence. Don't know which resume version was used.
- *LinkedIn application tracking:* Aggregate numbers only, LinkedIn-applied jobs only, no analysis, no cross-module intelligence.

**CareerPersona's structural advantages**

- *Proprietary application quality signals:* Only CareerPersona knows whether Smart Apply was used, what the AI match score was, which resume version was sent. This enables Application Quality Correlation — the ROI analysis of good application hygiene. No competitor has this data.
- *Platform-wide intelligence propagation:* Every competitor is an isolated island. Outcome Intelligence is a required platform dependency that makes Resume Intelligence, Job Intelligence, Interview Intelligence, and the Career Assistant all evidence-based rather than generic.
- *Confidence-tiered learning:* No competitor distinguishes between findings based on 3 applications and findings based on 35. This calibration builds appropriate trust rather than overpromising on thin data.
- *Cause-and-effect Timeline Intelligence:* No tracker connects user improvement actions to outcome metric changes and explains the likely causal relationship. This is unique.
- *Accountable recommendations:* Recommendations are evaluated 30 days after they're applied. No competitor tracks whether their advice worked. This closes the loop that makes the AI credible over time.

---

## Locked Implementation Decisions (added 2026-08-01, post-review)

These decisions resolve two points where the application evolved after this blueprint was originally locked (July 2026) — specifically, the Application Tracker status taxonomy and Job Tracker/`job_watchlist` were built afterward. They are additive clarifications, not changes to the blueprint's architecture, analyses, or purpose above.

1. **Withdrawn applications are excluded from all Application Outcome Intelligence calculations.** A `Withdrawn` status reflects a user-initiated action (the applicant chose to pull out), not an employer outcome. It carries no signal about company responsiveness, fit, or market conditions, so it is excluded from every analysis, pattern, and metric in this blueprint — it is neither a positive nor a negative outcome, it is simply not an outcome the six analyses are designed to reason about.

2. **Opportunity Cost Intelligence (§11) remains scoped to Saved Jobs only, exactly as originally defined.** `job_watchlist` (the Job Tracker feature, built after this blueprint was locked) is intentionally excluded. Saved Jobs represents an expressed intent to apply; Job Watchlist represents an intent to monitor a job or company without necessarily applying. Conflating the two would misrepresent monitoring activity as missed application opportunity. Opportunity Cost Intelligence's data sources remain exactly as specified in §11: `saved_jobs` (not applied), `smart_apply_queue` (abandoned), `job_matches` (expired) — unchanged from the original text.
