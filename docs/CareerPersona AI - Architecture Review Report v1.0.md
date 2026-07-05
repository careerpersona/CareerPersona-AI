# CareerPersona AI — Architecture Review Report

**Codebase reviewed:** `src/App.jsx` (275KB, ~3,800 lines), `src/data/` (14 files), `worker.js`
**Specification reviewed:** Master Architecture Specification v1.0 (Volumes 1–4)

> **Blueprint update — 2026-07-01**: Smart Apply package expanded. Salary Insight and Company Insight are now **required V1 responsibilities**, not future items. The complete Smart Apply package is 10 items. Implementation requires: (1) `smart_apply_queue` schema migration (+2 columns), (2) AI prompt update in 3 call sites, (3) `markReady` persistence update, (4) UserContext exposure. See Section 1 (Smart Apply) and Phase 5b for full specification.

---

## 1. ✅ Already Implemented

### Authentication & Session
- Real Supabase auth with Google OAuth via `supabase.auth.signInWithOAuth`
- `onAuthStateChange` listener with recovery mode (password reset flow)
- Session persistence via `cp_user` in localStorage with Supabase sync
- Password recovery flow (separate state, no auto-login during recovery)

### Database Layer (Supabase)
- Row Level Security on all tables, scoped to `auth.uid()`
- `profiles` + `profile_details` (two-table profile model joined in `profile.js`)
- `applications`, `saved_jobs`, `job_matches`, `user_resumes` (original 6)
- `ai_briefings` (upsert keyed on `user_id, briefing_date`)
- `ai_action_plans` (upsert keyed on `user_id, plan_date`)
- `smart_apply_queue` (enqueue, markReady, markFailed, markApplied, skip)
- `interview_sessions` (full question/answer/score storage)
- `salary_research` (per-research storage)
- `networking_contacts` (with `generated_messages` JSONB)
- `assistant_conversations` + `assistant_messages` (persistent chat)
- `activity_log` (write-only from all AI generation events)
- `notifications` (fire-and-forget on AI completion)

### Data Access Layer (`src/data/`)
All 14 files exist and are correctly wired:
`activityLog.js`, `aiActionPlan.js`, `aiBriefing.js`, `applications.js`, `assistantChat.js`, `interviewSession.js`, `networkingContacts.js`, `notifications.js`, `profile.js`, `resumes.js`, `salaryResearch.js`, `savedJobs.js`, `smartApply.js`, `syncList.js`

### AI Daily Briefing
- Auto-generates once per day without user trigger
- Loads from Supabase on login; sessionStorage fast path
- `isToday()` guard prevents stale-day reuse
- `loadedFor` + `appliedRef` double-generation guards
- Persists to `ai_briefings` table on every generation
- Error state with Retry button
- Full-page `BriefingPage` with Regenerate button

### Today's Action Plan
- Auto-generates once per day without user trigger
- Same guard patterns as Briefing
- Task completion embedded in plan object (`categories[i].status`)
- Dashboard ↔ PlanPage synchronized via `sessionStorage.cp_plan_dash`
- Persists to `ai_action_plans` on every generation and every toggle

### Cloudflare Worker
- Two routes: `POST /` (Claude proxy) + `POST /api/jobs` (job aggregation)
- Two job providers: Adzuna + JSearch (RapidAPI)
- Normalize → merge → deduplicate → sort pipeline
- Stateless — no user data stored in Worker
- API keys in Worker environment secrets
- CORS allows localhost, LAN IPs (any port), and production domain

### Job Intelligence
- Unified job list from two providers, deduplicated by title+company
- Per-job AI match scoring (`analyzeMatch`)
- Auto-batch score first 5 results after each search
- `useSavedJobs` with Supabase persistence + localStorage migration

### Resume Intelligence (Page)
- Full resume analysis: ATS score, missing keywords, tailored resume, cover letter
- Upload/save/manage multiple resumes (`useResumes`)
- `user_resumes` table with Supabase persistence

### Interview Intelligence (Page)
- Generate 8 tailored questions (8,000 token call)
- Per-answer feedback scoring
- `useInterviewSession` with Supabase persistence

### Salary Intelligence (Page)
- Full salary analysis, negotiation script, market comparison
- `useSalaryResearch` with Supabase persistence

### Networking Intelligence (Page)
- LinkedIn/email/InMail outreach generation
- Follow-up message writer
- `useNetworkingContacts` with Supabase + localStorage sync

### Smart Apply (Page — JobsPage)
- **Complete AI application package — 10 responsibilities, all V1 required (blueprint updated 2026-07-01):**
  1. Find matching jobs
  2. Analyze job descriptions
  3. Select the best resume
  4. Tailor the resume
  5. Generate a cover letter
  6. Generate a recruiter / outreach message
  7. Generate a networking message
  8. **Generate Salary Insight** ← promoted from future to V1
  9. **Generate Company Insight** ← promoted from future to V1
  10. Prepare the complete AI application package, save history, update UserContext
- `smart_apply_queue` with 4-status workflow (`queued → ready | failed | applied | skipped`)
- **Future Version capabilities (not V1 — documented for roadmap continuity):**
  - AI Auto Fill — automatically populate external ATS/application forms using the generated package
  - Multi-provider application support — submit directly to LinkedIn Easy Apply, Indeed, Greenhouse, Lever, and other platforms
  - One-click review before submission — present the complete package in a pre-flight checklist for user confirmation before any external submission fires
  - Additional future Smart Apply capabilities as approved in the blueprint

> Future capabilities are documented here so promoted items can always be traced (Salary Insight and Company Insight were in this list before their 2026-07-01 promotion to V1). Do not implement future items until they are explicitly promoted via a blueprint update.

### AI Career Assistant
- Persistent chat history via `assistant_conversations` + `assistant_messages`
- Chat widget on Dashboard bottom

### Internationalisation
- 14 languages supported via `I18nContext`
- Language preference persisted to Supabase `profiles.preferred_language`

### Career Progress (Dashboard card)
- Progress bars for: profile %, saved jobs, applications, interviews, offers

---

## 2. 🟡 Partially Implemented

### Dashboard Layout
**What exists**: Hero greeting, Row 1 (Briefing + Plan), placeholder Row 2 (Smart Apply + Opportunity), 2× three-column rows, AI Assistant at bottom.

**What's missing or wrong**: The layout does not match the locked spec. Row 3 in the spec is `Resume | Job | Interview Intelligence`. Row 4 is `Salary | Career Progress | Networking Intelligence`. The current implementation has `Resume | Job | Market Intelligence` (wrong card in slot 3) and `AI Recommendations | Career Progress | AI Activity` (entirely different from spec Row 4).

```
SPEC                              CURRENT
─────────────────────────────     ─────────────────────────────────────
Row 3: Resume | Job | Interview   Row 2: Resume | Job | Market Intel ⚠️
Row 4: Salary | Progress | Net    Row 3: AI Recs | Progress | Activity ⚠️
```

### Hero Section
A greeting (`"Good morning, [Name]"`) and subtitle exist. **Missing**: "Today's overall career health" score as specified. The Hero should show the user's unified career health metric.

### Resume Intelligence (Dashboard card)
Shows only profile completion % and a link to ResumePage. **Missing**: ATS score, missing keywords, skill gaps — the actual Resume Intelligence outputs. The card is a navigation prompt, not an intelligence display.

### Job Intelligence (Dashboard card)
Shows a count of saved jobs and last 3 titles. **Missing**: match scores, top opportunities ranked by relevance, new jobs detected since last visit. The card shows static counts, not AI intelligence.

### Smart Apply (Dashboard card)
Card exists in layout but shows "Smart Apply content coming soon." The `smart_apply_queue` table and `useSmartApplyQueue` hook are fully implemented. **Missing**: wiring the hook data to the dashboard card.

### Opportunity Intelligence (Dashboard card)
Card exists but shows "Opportunity Intelligence content coming soon." **Missing**: the AI agent, the `opportunity_snapshots` table, and all data wiring.

### Pricing / Subscription
A PricingPage exists with Free/Pro/Premium tiers described. Settings page shows current plan tier from `profile.plan`. **Missing**: Stripe integration (all billing buttons show `alert()`), no feature gates (all features accessible regardless of plan), no subscription enforcement.

### Career Progress (Dashboard card)
Progress bars exist. **Missing**: goal tracking, milestones, skill progress over time, learning progress, career milestones as specified.

### AI Career Assistant (Dashboard widget)
Chat exists. **Missing**: the assistant only receives 7 data points. Spec requires full UserContext including briefing, plan, interview readiness, salary research, and all specialist outputs.

---

## 3. ❌ Missing Components

### UserContext Engine
No `buildUserContext()` function exists anywhere. Every AI agent builds its own independent context string from whatever data is in its host component's scope. The engine described in Volume 3 (Section 30) — which runs on login, resume upload, Smart Apply, new interview, etc. — does not exist.

### AI Insights Layer
The standardized AI Insight format (Module Name, Priority Score, Headline, Explanation, Recommendation, Blocking Status, Confidence Score, Date Generated, Expiration Date, Related Features) does not exist in any form. No AI module publishes insights in this format. No `ai_insights` table exists in the database.

### AI Decision Engine
Does not exist. No coordinator reads AI Insights from all specialists, resolves conflicts, or produces a unified output. The Daily Briefing and Action Plan are generated independently with isolated context strings — not from aggregated AI Insights.

### AI Insight Engine
Does not exist. No module collects, deduplicates, scores, or distributes insights between specialists.

### Dynamic Priority Ranking
The 4 dashboard plan categories are always fixed: `priorities`, `applications`, `resume`, `interview` — hardcoded in the prompt string at line 627. No scoring algorithm reads user data to rank sections dynamically. Whether the user has an interview tomorrow or has never applied to a job, the same 4 categories appear.

### Cross-Agent Output Routing
When Resume Analysis identifies `keywordsMissing: ["TypeScript", "AWS"]`, this information goes into the `applications` table as text and is never read by any other agent. The Briefing Agent, Plan Agent, Interview Agent, and Chat Agent do not know these gaps exist.

### Interview Intelligence (Dashboard card)
Per the spec, Row 3 includes an Interview Intelligence card on the Dashboard. No such card exists. The InterviewPage is a full-page module only.

### Salary Intelligence (Dashboard card)
Per the spec, Row 4 includes a Salary Intelligence card on the Dashboard. The current "Market Intelligence" card reads from `localStorage.cp_salary_results` and shows one number. It is not a Salary Intelligence card — it is a partial display of salary research data.

### Networking Intelligence (Dashboard card)
Per the spec, Row 4 includes a Networking Intelligence card. No such card exists on the Dashboard. The networking feature is a full-page module only.

### `ai_insights` Database Table
Not in the schema. Required for the AI Insight Engine to store and share standardized insights between specialists.

### `company_watchlist` and `opportunity_snapshots` Tables
Not in the schema. Required for Opportunity Intelligence.

### `salary_offers` Table
Not in the schema. Required for offer tracking and negotiation context.

### `resume_versions` Table
Not in the schema. Spec calls for Resume Version Management as a Resume Intelligence responsibility.

### `skills` and `certifications` Tables
Skills and certifications are currently stored as plain text fields in `profile_details`. No structured tables for skills tracking, progress, or gap analysis.

### `career_goals` Table
Not in the schema. Career goals exist only as a plain text field in `profile_details`.

### `subscriptions` and `billing` Tables
Not in the schema. Billing is UI-only with placeholder `alert()` calls.

### AI Auto Fill (Version 2)
Not implemented. No infrastructure exists for this feature.

### AI Voice Interview Coach (Version 2)
Not implemented. No infrastructure exists for this feature.

---

## 4. ⚠️ Architecture Conflicts

### Conflict 1 — Dashboard Layout Does Not Match the Locked Spec

The spec (Volume 2, Section 18) locks the dashboard layout as:

```
Row 3: Resume Intelligence | Job Intelligence | Interview Intelligence
Row 4: Salary Intelligence | Career Progress  | Networking Intelligence
```

The current implementation has:

```
Row 2: Resume Intelligence | Job Intelligence | Market Intelligence
Row 3: AI Recommendations  | Career Progress  | AI Activity
```

"Market Intelligence" occupies the Interview Intelligence slot. "AI Recommendations" and "AI Activity" occupy the Salary and Networking slots. These are not equivalent — they are different modules entirely. The spec explicitly says the layout is locked.

### Conflict 2 — AI Daily Briefing Performs Analysis Instead of Summarizing AI Insights

The spec states (Volume 1, Part 3, Section 15): *"The Daily Briefing never performs analysis itself. It summarizes the latest AI Insights."*

The current implementation (`buildBriefingPayload`, line 596) calls Claude with 13 raw data points and asks Claude to infer everything — job opportunities, resume tips, market conditions, recruiter activity — from scratch. It is performing all analysis itself. It has no AI Insights to summarize because the AI Insight layer does not exist.

This is a fundamental architectural conflict. The Briefing Agent's role in the spec is synthesis, not analysis.

### Conflict 3 — Today's Action Plan Has 4 Fixed Categories (Spec Requires Dynamic Selection)

The spec (Volume 1, Part 2, Section 13; Volume 2, Section 20) requires:

> *"The Dashboard should never show fixed priorities. Each day the Decision Engine ranks all available Action Plan recommendations."*

The current plan prompt (line 627) hardcodes exactly 4 category IDs: `priorities`, `applications`, `resume`, `interview`. Claude is instructed to generate content for these 4 specific categories regardless of user state. This directly violates the Dynamic Priority Engine requirement.

### Conflict 4 — AI Agents Communicate Directly Instead of Through Shared Layers

The spec (Volume 1, Part 2, Section 11) states:

> *"AI Specialists should not directly call one another. Instead they communicate through two shared layers: UserContext and AI Insights."*

Currently all 12 AI agents call `askClaude()` directly with independent context strings. No shared layer mediates communication. This is the opposite of the specified architecture.

### Conflict 5 — Interview and Salary Data Still Read From localStorage in Dashboard

`DashboardPage` reads interview and salary data from `localStorage` at lines 709–711:

```js
const interviewSession = readLS("cp_interview_session_v1", null);
const salaryResults = readLS("cp_salary_results", null);
const networkContacts = readLS("cp_network_contacts", []);
```

These are device-local reads. If the user completes interview practice on device A and opens the Dashboard on device B, the Briefing and Plan agents receive `0 questions practiced` and `salary research: not done` — incorrect data. The spec requires Supabase as the single source of truth.

### Conflict 6 — `useSmartApplyQueue` Is Imported in `App.jsx` (Line 7) but Not Connected to the Dashboard

`useSmartApplyQueue` is imported but the Smart Apply Center dashboard card is a placeholder. The hook loads queue data from Supabase on every Dashboard mount, performing a DB read whose result is never used. This wastes a Supabase call on every Dashboard render.

---

## 5. 🚨 Potential Risks

### Risk 1 — Single 275KB File Will Become Unmaintainable
`App.jsx` is currently ~3,800 lines. Implementing the missing UserContext Engine, AI Insight Engine, Decision Engine, 3 new dashboard cards, and dynamic priority ranking inside this one file will push it past 6,000 lines. The spec calls for a multi-layer architecture. This requires component extraction before or during implementation — otherwise the file becomes a maintenance hazard.

### Risk 2 — No Feature Gating Means Free Users Access All Premium Features
All 11 AI modules are fully accessible regardless of `profile.plan`. The Pricing page exists, Stripe is not integrated, and no code gate checks the plan tier before calling Claude. If Free tier is meant to have limited AI calls, this must be enforced before launch or the business model cannot function.

### Risk 3 — Claude API Budget Exhaustion Silently Breaks All Features
All 12 AI agents share one Anthropic API key via the Worker. When the account runs out of credits, all features fail simultaneously with the same error. There is no per-feature fallback beyond the static fallback objects in `buildBriefingPayload` and `buildPlanPayload`. Job Search (Adzuna + JSearch) continues working, but every Claude-dependent module fails.

### Risk 4 — localStorage Reads for Salary/Interview in Dashboard Create Multi-Device Desync
Three critical data sources (salary results, interview session, network contacts) are still read from `localStorage` inside `DashboardPage` instead of from the Supabase hooks that already exist. A user switching devices sees an incomplete Dashboard even though their data is in Supabase.

### Risk 5 — No Rate Limiting on the Claude Proxy
The Worker proxies all Claude requests without rate limiting. A user (or automated script) could fire unlimited Claude calls through the Worker, burning API credits. No per-user, per-session, or per-minute limit exists.

### Risk 6 — `interviewSession` and `salaryResearch` Context Strings Are One Render Behind
When a user completes interview practice and immediately views the Dashboard in the same session, the `interviewSession` read at line 709 returns the localStorage value from before the session. The updated Supabase row is not reflected until the next page mount. This produces incorrect context strings for the Briefing and Plan agents.

### Risk 7 — Implementing AI Insights Alongside Existing Architecture Requires a Transition Strategy
The AI Insight layer is a fundamental new layer between raw data and recommendations. Adding it while keeping the current isolated-agent pattern running means both systems operate simultaneously during transition. Without a clear migration plan, the codebase will have two competing context assembly patterns, creating confusion and potential drift.

---

## 6. 🔗 AI Agent Communication Review

**Verdict: The 11 AI specialists do not work together through UserContext, AI Insights, or a Decision Engine. They operate as completely isolated modules.**

### Current communication pattern (actual)

```
Each AI agent independently:
  1. Reads whatever local state is in its host component
  2. Assembles a custom context string (7–13 data points)
  3. Calls askClaude() directly
  4. Stores result in component state + sessionStorage + Supabase
  5. Never notifies any other agent
```

### Required communication pattern (per spec)

```
UserContext Engine → UserContext (40+ data points)
    ↓
Each AI Specialist reads UserContext
    ↓
Each Specialist publishes AI Insight (10-field standardized format)
    ↓
AI Insight Engine collects, deduplicates, scores, distributes
    ↓
Decision Engine reads all AI Insights → produces Briefing, Plan, top-4 priorities
```

### What each agent currently knows vs what it should know

| Agent | Currently receives | Spec requires |
|---|---|---|
| Daily Briefing | 13 numbers (counts, %) | Full UserContext + all AI Insights from all specialists |
| Action Plan | 13 numbers (same as above) | Full UserContext + ranked priorities from Decision Engine |
| Chat Assistant | 7 numbers | Full UserContext + today's Briefing + today's Plan + interview readiness + salary vs market |
| Resume Analysis | Resume text + job description (from UI) | Same, but output routes back to UserContext.resumeAnalysis for other agents to consume |
| Job Match | Resume text (300 chars) | Full UserContext.activeResumeText + UserContext.profile |
| Smart Apply | Resume text + job description | UserContext including resumeAnalysis.skillGaps for smarter tailoring |
| Interview Questions | Job description + resume (1000 chars) | UserContext including interviewSession.activeInterviewsScheduled, resumeAnalysis.skillGaps |
| Interview Feedback | Question + answer + resume (600 chars) | Same — no change needed here |
| Salary | Manual form input | UserContext including applications with offers, profile.desiredSalary |
| Networking | Manual form input + contact | UserContext including profile for context |
| Opportunity Intel | Not implemented | UserContext including profile, savedJobs, applications (companies already targeted) |

### Cross-agent output routing (current vs required)

| Output | Currently goes to | Should also go to |
|---|---|---|
| Resume ATS score + skill gaps | `applications` table (raw text) | `UserContext.resumeAnalysis` → Briefing, Plan, Interview, Smart Apply prompts |
| Interview readiness score | `interview_sessions` table | `UserContext.interviewSession.readinessScore` → Briefing, Plan, Chat prompts |
| Salary vs market alignment | `salary_research` table + localStorage | `UserContext.salaryResearch.userVsMarket` → Briefing, Plan, Chat, Opportunity Intel |
| Smart Apply missing skills | `smart_apply_queue.missing_skills` | `UserContext.skillGapsAggregated` → Plan's skill development section |
| Today's Briefing priority | `ai_briefings` table | `UserContext.todayBriefing` → Chat reads it before answering |
| Today's Plan completion | `ai_action_plans` table | `UserContext.todayPlan.completionRate` → Briefing mentions progress |

---

## 7. 🗄️ Backend, Database & API Review

### Supabase — What Exists

| Table | Status | Notes |
|---|---|---|
| `profiles` | ✅ | Joined with `profile_details` in `profile.js` |
| `profile_details` | ✅ | Has `desired_salary`, `preferred_job_title`, `skills`, `certifications` as text fields |
| `applications` | ✅ | Full CRUD via `syncList.js` |
| `saved_jobs` | ✅ | Full CRUD via `syncList.js` |
| `job_matches` | ✅ | Written by job match agent |
| `user_resumes` | ✅ | Full CRUD via `resumes.js` |
| `smart_apply_queue` | 🟡 | 4-status workflow wired; **missing `salary_insight` (jsonb) and `company_insight` (jsonb)** columns — migration required for V1 completion |
| `ai_briefings` | ✅ | Upsert on `(user_id, briefing_date)` |
| `ai_action_plans` | ✅ | Upsert on `(user_id, plan_date)` |
| `interview_sessions` | ✅ | Full question/answer storage |
| `salary_research` | ✅ | Per-research rows |
| `networking_contacts` | ✅ | With `generated_messages` JSONB |
| `assistant_conversations` | ✅ | One per user |
| `assistant_messages` | ✅ | Full history |
| `activity_log` | ✅ | Written by all AI generation events |
| `notifications` | ✅ | Fire-and-forget |
| `subscriptions` | ❌ | Not in schema — needed for billing |
| `ai_insights` | ❌ | Not in schema — required by spec |
| `company_watchlist` | ❌ | Not in schema — for Opportunity Intelligence |
| `opportunity_snapshots` | ❌ | Not in schema — for Opportunity Intelligence |
| `salary_offers` | ❌ | Not in schema — for offer tracking |
| `resume_versions` | ❌ | Not in schema — for version management |
| `career_goals` | ❌ | Not in schema (currently a plain text field) |

### Cloudflare Worker — What Exists

| Capability | Status | Notes |
|---|---|---|
| Claude proxy (`POST /`) | ✅ | Model pinned to `claude-sonnet-4-6` |
| Job search (`POST /api/jobs`) | ✅ | Adzuna + JSearch in parallel |
| CORS (localhost, LAN, prod) | ✅ | Any LAN port accepted |
| Deduplication | ✅ | By title+company |
| Normalization | ✅ | Unified job format |
| Rate limiting | ❌ | No per-user or per-minute limits |
| AI Insights Engine | ❌ | Per spec, the Insight Engine could run here |
| UserContext Engine | ❌ | Not in Worker |
| Decision Engine | ❌ | Not in Worker |
| Cron / scheduled jobs | ❌ | No scheduled briefing pre-generation |

### Storage
- No `resumes` storage bucket confirmed. `user_resumes.file_url` column exists but no bucket backs it. PDF/DOCX uploads are not functional.

---

## 8. 📊 Dashboard Synchronization Review

### What is synchronized correctly

- Dashboard briefing card ↔ BriefingPage: Both read `useAiBriefing` and `sessionStorage.cp_briefing_dash`. Changes on BriefingPage (Regenerate) propagate to Dashboard on next mount. ✅
- Dashboard plan card ↔ PlanPage: Both read `useAiActionPlan` and `sessionStorage.cp_plan_dash`. Task completions toggled on PlanPage write back to `cp_plan_dash`, which Dashboard reads on remount. ✅
- Applications: `useSyncedList` provides diff-based sync between localStorage and Supabase. Changes on TrackerPage reflect on Dashboard immediately (same React state). ✅
- Saved jobs: Same `useSyncedList` pattern. ✅

### What is not synchronized

- **Salary data**: Dashboard reads `localStorage.cp_salary_results`. SalaryPage writes to Supabase. If a user generates salary research on device A, the Dashboard on device B never shows it. The `useSalaryResearch` hook exists and reads from Supabase but `DashboardPage` ignores it, reading localStorage instead. ❌
- **Interview session**: Dashboard reads `localStorage.cp_interview_session_v1`. InterviewPage writes to Supabase. Same multi-device desync issue. ❌
- **Network contacts**: Dashboard reads `localStorage.cp_network_contacts`. NetworkingPage uses `useSyncedList` which syncs to Supabase. ❌
- **Smart Apply queue**: `useSmartApplyQueue` is imported and called (burning a DB read on every Dashboard mount) but the result is never displayed — the card shows a placeholder. ❌
- **Resume analysis results**: No synchronization mechanism exists. Each `analyzeMatch` or full analysis result is stored in the `applications` table but never read back into the Dashboard context. ❌

### Navigation-induced remount behaviour

All pages unmount when navigating away (React conditional rendering pattern `{page === "x" && <Component />`). This means:
- All component state resets on navigation ✅ (expected, by design)
- sessionStorage serves as the cross-navigation cache for Briefing and Plan ✅
- Supabase hooks re-fire on every remount — this is correct but not optimized ⚠️
- The AI Insight layer would eliminate redundant re-fetches — but does not yet exist

---

## 9. 📋 Recommended Implementation Phases

Ordered by: dependency chain first, highest user impact second, lowest risk of regressions third.

---

### Phase 1 — Fix the 3 localStorage Reads in DashboardPage

**Effort**: 1–2 hours | **Risk**: Very low | **Spec compliance gain**: High

Replace the three `readLS()` calls in `DashboardPage` (lines 709–711) with the Supabase hooks that already exist:
- `useSalaryResearch(profile?.id)` instead of `readLS("cp_salary_results")`
- `useInterviewSession(profile?.id)` instead of `readLS("cp_interview_session_v1")`
- `useNetworkingContacts(profile?.id)` instead of `readLS("cp_network_contacts")`

These hooks are already written. This eliminates multi-device desync and gives the Briefing and Plan agents correct data. No spec compliance risk — this is fixing a regression.

---

### Phase 2 — Build `buildUserContext()` (UserContext Engine, Phase 1)

**Effort**: 1 day | **Risk**: None (additive only) | **Spec section**: Volume 3, Section 30

Create `src/data/userContext.js`. It exports one async function that accepts all already-loaded hook data, merges it, and returns the canonical UserContext object (as specified in the architecture design document already approved). No components change yet — this is a library function that runs in parallel and logs its output for validation.

No behavioral change. No UI change. Pure foundation.

---

### Phase 3 — Replace Context Strings with `getContextString(userContext)`

**Effort**: Half a day | **Risk**: Low | **Spec section**: Volume 1, Part 2, Section 11

Replace the 13-number context strings in `buildBriefingPayload()` and `buildPlanPayload()` and all other `askClaude()` call sites with `getContextString(userContext, verbosity)`. Every agent immediately receives 40+ data points instead of 7–13. This is the single highest-impact change for output quality.

Validation: Generate a briefing before and after and compare specificity.

---

### Phase 4 — Fix Dashboard Layout to Match Locked Spec

**Effort**: 1–2 days | **Risk**: Medium (visual change) | **Spec section**: Volume 2, Section 18

Restructure the 3rd and 4th dashboard rows to match:
- Row 3: Resume Intelligence | Job Intelligence | **Interview Intelligence**
- Row 4: **Salary Intelligence** | Career Progress | **Networking Intelligence**

Remove: "Market Intelligence" card, "AI Recommendations" card, "AI Activity" card (or relocate them).

Add intelligence cards for: Interview (readiness score, active sessions, last practiced), Salary (research result summary or prompt), Networking (contact count, last activity, waiting replies).

---

### Phase 5 — Wire Smart Apply Center Dashboard Card

**Effort**: 1 day | **Risk**: Low | **Spec section**: Volume 2, Section 21

`useSmartApplyQueue` already loads data on every Dashboard mount. Wire its output to the Smart Apply Center card. Show: queue size, "ready" count, last generated package summary, link to JobsPage.

---

### Phase 5b — Complete Smart Apply V1 Package (Salary + Company Insight)

**Effort**: 1 day | **Risk**: Low | **Blueprint updated**: 2026-07-01

Salary Insight and Company Insight are now required V1 Smart Apply outputs. Four code changes are required — in this order:

**Step 1 — Schema migration** (`smart_apply_queue` table):
```sql
ALTER TABLE smart_apply_queue ADD COLUMN salary_insight jsonb;
ALTER TABLE smart_apply_queue ADD COLUMN company_insight jsonb;
```

**Step 2 — AI prompt** (`autoSmartApply`, manual `smartApply`, `handleRetry` in `src/App.jsx`):

Add to the Claude prompt's requested JSON output:
- `salaryInsight`: `{ marketRange, userPositioning, negotiationLeverage, benchmarks[] }`
- `companyInsight`: `{ culture, recentNews, hiringTrend, redFlags[], greenFlags[], talkingPoints[] }`

**Step 3 — `markReady`** (`src/data/smartApply.js`):

Add `salary_insight` and `company_insight` to the upsert payload in the `markReady()` function.

**Step 4 — UserContext** (`src/data/userContext.js`):

Expose `salaryInsight` and `companyInsight` from queue rows inside `buildUserContext` / `getContextString` so other agents (Briefing, Chat, Interview) can read them.

**Step 5 — Display** (Dashboard Smart Apply card, SavedJobsPage queue card):

Add display fields for the two new insight blocks once data is available.

---

### Phase 6 — Implement AI Insights Standard Format

**Effort**: 2–3 days | **Risk**: Medium | **Spec section**: Volume 1, Part 2, Sections 9–10

Create the `ai_insights` Supabase table. Define the 10-field standard structure. Implement insight publishers for the 4 specialists that have enough data to publish now: Resume Intelligence (ATS score → insight), Interview Intelligence (readiness score → insight), Salary Intelligence (vs market → insight), Application Pipeline (response rate → insight).

Each publisher is a simple function that upserts one row to `ai_insights` after its analysis completes.

---

### Phase 7 — Implement Dynamic Priority Scoring

**Effort**: 1 day | **Risk**: Medium | **Spec section**: Volume 1, Part 2, Section 13

Implement `scoreSections(userContext)` as designed in the architecture design document. Pass `top4Priorities` to `buildPlanPayload`. Update the plan prompt to receive the ranked list. Remove the hardcoded 4-category instruction from line 627.

Regression check: confirm all 4 rendered categories display correctly regardless of which sections are ranked highest.

---

### Phase 8 — Implement AI Decision Engine (reads AI Insights → produces Briefing)

**Effort**: 2 days | **Risk**: Medium | **Spec section**: Volume 1, Part 2, Section 12

Modify `buildBriefingPayload` to first read `ai_insights` for the current user, then pass the structured insights (not raw data numbers) to the Claude prompt. The Briefing Agent transitions from "analyst" to "synthesizer." The prompt changes from "here are 13 numbers, infer everything" to "here are the AI Insights from all specialists, summarize them into a daily briefing."

---

### Phase 9 — Cross-Agent Output Routing

**Effort**: 1 day | **Risk**: Low | **Spec section**: Volume 1, Part 2, Section 11

When Resume Analysis completes → publish to `ai_insights` + update `userContext.resumeAnalysis`.
When Interview session updates → update `userContext.interviewSession.readinessScore`.
When Salary analysis completes → publish to `ai_insights` + update `userContext.salaryResearch.userVsMarket`.

Now the Decision Engine's next Briefing/Plan generation will include these real insights automatically.

---

### Phase 10 — Opportunity Intelligence

**Effort**: 3–4 days | **Risk**: Medium | **Spec section**: Volume 1, Part 3; Volume 2, Section 22

Create `opportunity_snapshots` and `company_watchlist` tables. Implement Opportunity Intelligence agent using full UserContext. Wire the dashboard card. This is the last of the two "coming soon" placeholder cards.

---

### Phase 11 — Storage Bucket + Resume Versions

**Effort**: 1 day | **Risk**: Low | **Spec section**: Volume 3, Section 33

Create the `resumes` Supabase Storage bucket (private, RLS-scoped to `auth.uid()` folder). Create `resume_versions` table. Wire file upload in ResumePage. Currently `user_resumes.file_url` column exists but no bucket backs it.

---

### Phase 12 — Stripe Integration + Subscription Enforcement

**Effort**: 3–5 days | **Risk**: High (external payment integration) | **Spec section**: Volume 4, Sections 42–44

Replace all `alert("Stripe coming soon")` calls with real Stripe Checkout flows. Add `subscriptions` table. Add feature gates: Claude calls for Pro features check `profile.plan === "pro"` before firing.

---

### Phase 13 — Rate Limiting on Worker

**Effort**: Half a day | **Risk**: Low | **Spec section**: Volume 3, Section 37

Add per-user rate limiting to the Cloudflare Worker's Claude proxy route using Cloudflare KV or Durable Objects. Prevents credit exhaustion from automated abuse.

---

### Phase 14 — Structured Skills/Certifications/Career Goals Tables

**Effort**: 2 days | **Risk**: Low | **Spec section**: Volume 3, Section 33

Add structured `skills`, `certifications`, and `career_goals` tables. Migrate from plain text fields in `profile_details`. This unlocks skill gap tracking, certification progress, and goal measurement as described in the Career Progress specialist responsibilities.

---

### Phase 15 — AI Auto Fill, Multi-Provider Application Support, and AI Voice Interview Coach

**Effort**: Weeks | **Risk**: High (new AI capabilities) | **Spec section**: Volume 4, Sections 43–44

Future Version features. Require significant infrastructure work before implementation.
- **AI Auto Fill** — browser automation or ATS API integration required; see also Section 1 Smart Apply future roadmap
- **Multi-provider application support** (LinkedIn Easy Apply, Indeed, Greenhouse, Lever) — external OAuth + form-submission layer required
- **One-click review before submission** — pre-flight checklist UI and external submission pipeline required
- **AI Voice Interview Coach** — WebRTC or audio API integration required

None of these may be implemented until explicitly promoted to a numbered version via a blueprint update. Separate planning sessions required for each.

---

## Summary Scorecard

| Category | Score | Notes |
|---|---|---|
| Auth & Security | 8/10 | Real OAuth, RLS — missing rate limiting |
| Database schema | 6/10 | 16 tables present, 7 missing |
| Data access layer | 9/10 | All 14 files correct, well-structured |
| Dashboard layout | 4/10 | Row 1 correct; Rows 3–4 wrong; 2 placeholders |
| AI specialist count | 9/11 | Smart Apply + Opportunity Intelligence not wired to dashboard |
| AI coordination | 0/10 | No UserContext Engine, no AI Insights, no Decision Engine |
| Cross-agent routing | 0/10 | Zero agents share outputs |
| Dynamic prioritization | 0/10 | 4 categories hardcoded |
| Billing/subscriptions | 1/10 | UI only, no Stripe, no feature gates |
| Performance optimization | 3/10 | Supabase re-fetches on every mount, localStorage desync |

**Phases 1–3 are the highest-ROI work**: they fix real bugs (multi-device desync), establish the UserContext foundation, and immediately improve every AI output without changing any UI.
