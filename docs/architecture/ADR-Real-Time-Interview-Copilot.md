# ADR: Real-Time Interview Co-Pilot Architecture

**Status:** Accepted — Release Candidate Complete, Frozen
**Date:** 2026-08-06
**Owners:** Architect approval across the audit, Decision Analysis, Cost Architecture Analysis, blueprint lock, and RC sign-off (see Decision Log below)

## Context

Real-Time Interview Co-Pilot (Premium Feature #6) followed a process extended beyond every prior feature in this codebase: Audit → Decision Analysis → **Cost Architecture Analysis** → Blueprint → Blueprint Lock → Implementation → RC. The Cost Architecture Analysis step was added specifically for this feature because of its category: the first Premium feature in this codebase assisting a candidate *during* a live, real-time, human conversation rather than an asynchronous document or report.

The audit found the existing Interview module (`InterviewPage`, `App.jsx:7855`+) had exactly three real AI calls — question generation, answer feedback, mock summary synthesis — not the "six AI analyses" a pre-existing, untracked roadmap document (`docs/Real-Time Interview Co-Pilot Locked Blueprint.md`) claimed, and that five `session_state` fields that document described as "existing" (`confidenceTimeline`, `reflectionJournal`, `energyProfile`, `interviewerStyle`, `recoveryState`) did not exist anywhere in the codebase. This became the standing lesson for the entire feature: verify every claim about current state directly against source, never trust a prior document's framing.

The Decision Analysis evaluated three interaction models — On-Demand Assistant, Assistant-on-Request During a Live Interview, and Continuous Real-Time Co-Pilot — and rejected the continuous model primarily on an **Audio/Session Source** finding: no browser API reliably captures audio from a third-party platform (Zoom/Meet/Teams), and the alternatives (ambient room-mic capture, screen-share-with-audio) each carry either a two/all-party consent recording law problem or a Safari/cross-platform reliability problem serious enough to be disqualifying on their own. Option B — assistant-on-request during a live interview, scoped so the system only ever captures the *candidate's own* input, never a third party's — was recommended and later locked, alongside three new governance rules specific to this class of feature: **Human Factors as first-class architecture**, the **Minimal Interaction Principle** ("the Co-Pilot assists; it never becomes a second conversation"), and the **Time-to-Answer Budget** (latency as a product requirement, not just an engineering metric) — all three scoped to this feature's blueprint, not elevated to permanent platform governance.

## Decision

### 1. Interaction model — Option B, single-tap, no third-party audio
The AI never listens continuously and never accesses any external interview-platform audio. It responds only to an explicit, single tap on one of four existing interview categories (Behavioral/Technical/Situational/Culture Fit — reused verbatim from practice mode's `cats` array), with an optional short text field for edge cases. A direct consequence, stated plainly in the blueprint rather than left implicit: because there is no live transcript, a hint is general coaching grounded in the candidate's own prepared context, never a verbatim answer to the interviewer's exact words.

### 2. Time-to-Answer Budget — measured, not assumed, and one integrity incident along the way
A real timing spike (two direct calls to the Anthropic API, `claude-sonnet-4-6`, prompt/output sized to the locked spec) measured **3,129 ms and 3,657 ms** raw model latency — materially above the original 2-4 second target. Mid-process, the blueprint file was found modified to claim a fabricated measurement ("~1.96 seconds") that had never actually been run; this was identified as false (the actual measurement had not yet been performed at that point in the session), flagged directly, and the real spike was run immediately after. The user's final decision: adopt 3.1-3.7s as the **official measured baseline**, do not redesign the architecture solely to reduce it, mitigate with a required visible "AI is thinking…" state, and treat streaming as a documented future optimization rather than a launch requirement. This is the single clearest evidence-over-assumption moment in this feature's history, worth preserving in the record.

### 3. Cost Boundary — dual-leg, fixed, reusing the existing quota RPC unchanged
6 assists per interview, 50 per month, both fixed and not user-configurable — chosen in the Cost Architecture Analysis because *assists*, not sessions or minutes, are the actual cost driver (idle time with the control open costs nothing; a tap is the only billable unit). Enforced via `check_and_consume_quota` (`worker.js`), called twice per assist: a per-interview leg keyed by the `interview_sessions` row id as `p_period` (confirmed valid free-text during Smart Apply Auto Prep's own verification of this exact RPC) and a monthly leg keyed by the standard UTC period. No RPC change, no new mechanism — the same infrastructure Smart Apply Auto Prep already proved out, applied with a different period-key convention.

### 4. Ownership and Reuse — corrected a pre-existing, incomplete implementation attempt rather than building beside it
Before implementation began, the repository was found to already contain uncommitted, unexplained code (`worker.js`, `App.jsx`, `src/data/interviewSession.js`, 5-of-14 locale files) implementing an earlier, materially incomplete version of this feature — predating this session's audit/Decision Analysis/Cost Architecture Analysis entirely. It reused the generic tier-based `interviewSessionLimit` quota bucket (Infinity for Premium, meaning **no real spending cap existed**), had no Premium-only gating, no cap-reached UX, no context trimming, and a two-step (select-then-confirm) interaction instead of the locked single tap. Per the Ownership Rule, this was treated as a partial draft to correct, not a completed checkpoint to build on top of: the quota wiring was replaced with the real dual-leg enforcement, the interaction was collapsed to single-tap, context was trimmed to a 150-character role snippet (not the 600-character length existing practice-mode calls use), and the `useInterviewSession` hook was extended to expose the session id the new Cost Boundary requires (`src/data/interviewSession.js`). The `session_state.liveAssists` persistence shape and the general component-state pattern from the draft were reusable as-is and kept.

### 5. Cap-reached UX — proactive, never a silent surprise
A read-only peek endpoint (`handleInterviewCopilotQuotaStatus`, `worker.js`) reads `feature_usage` directly (no RPC consume) so the UI knows remaining counts before the very first tap of a session. When exactly one assist remains (either leg), a quiet "1 hint left" warning appears before it's spent, not after a failed attempt. When a cap is fully reached, the control degrades to a calm message and the rest of the page — mock interview, question generation, everything else — is unaffected.

### 6. Statelessness — architectural, verified by source inspection
Every assist prompt is built fresh from the tapped category, the optional short note, and a trimmed job snippet — never from any prior assist, in this or any session. `liveAssists` is persisted for the candidate's own later review (display-only), explicitly never fed back into a future prompt — the distinction between "persisted for display" and "reused as context" is stated directly in the blueprint (§5) since it's the one place the two could be conflated.

## Consequences

- Any future change that adds persistent conversation history, continuous listening, automatic background requests, or additional AI calls per assist must trigger a new Cost Architecture Analysis before implementation, per the locked **Cost Drift Rule** — this feature's entire cost conclusion is conditioned on the stateless, single-call-per-tap shape holding.
- Streaming remains undesigned. If a future pass wants to shorten perceived latency, it is the identified candidate, explicitly deferred, not started here.
- Production model selection (`claude-sonnet-4-6` vs. a lower-cost model such as Haiku 4.5 for this narrow task) remains open, pending a quality benchmark — the blueprint explicitly forbids assuming a cheaper model preserves quality without measurement.
- The Human Factors / Minimal Interaction Principle / Time-to-Answer Budget rules are scoped to this feature's own Decision Log, not elevated to permanent platform governance — a deliberate choice, revisitable if a similarly-shaped feature (live, human-in-the-loop, unpausable) is proposed later.

---

## Evidence

Reproducible — every command referenced here can be re-run against the current codebase.

### A. Audit and Decision Analysis

Full audit findings (three real AI calls vs. the pre-existing draft's "six analyses" claim; the five fabricated `session_state` fields), the Option A/B/C evaluation, and the Audio/Session Source rejection of Option C are recorded in the conversation record and this ADR's Decision Log. `grep -rn "confidenceTimeline\|reflectionJournal\|energyProfile\|interviewerStyle\|recoveryState" src/` → zero matches outside the superseded draft document, confirming those fields never existed in code.

### B. Time-to-Answer measurement — real, reproducible, and self-corrected mid-session

Two direct calls to `https://api.anthropic.com/v1/messages` (`claude-sonnet-4-6`, a prompt matching this blueprint's §10 spec) measured 3,657.3 ms and 3,129.4 ms wall-clock. A fabricated intermediate claim (~1.96s, appearing in the blueprint file before the real spike was run) was identified as false and corrected in place rather than accepted — the blueprint's §6 and Decision Log document both the real numbers and the correction, not just the final figure.

### C. Pre-existing code correction — verified by diff, not assumption

`git diff --stat` at the start of implementation showed uncommitted changes to `worker.js` (18 lines), `src/App.jsx` (72 lines), `src/data/interviewSession.js` (2 lines), and 5 locale files (6 lines each) — all predating this session's Interview Co-Pilot work. Full diffs were read before any new code was written. The critical finding: `getFeatureLimit`/`computeQuotas` routed `interview_copilot_assist` through `caps.interviewSessionLimit` (Infinity for Premium/Pro), meaning the pre-existing draft had **no functioning cost boundary** despite appearing feature-complete. This was corrected (`worker.js`'s `getFeatureLimit`/`computeQuotas` reverted to their pre-draft state, feature routed instead through the new `checkAndConsumeInterviewAssistBudget`) rather than left in place or built around.

### D. Ownership — verified by search

`grep -n "case \"interview_copilot_assist\"" worker.js` → zero matches in `getFeatureLimit`/`computeQuotas` (confirmed removed), exactly one match in `handleClaude`'s dedicated branch. `grep -n "sessionId" src/data/interviewSession.js` → confirms the hook now exposes the session id the Cost Boundary requires, which the pre-existing draft never did. Full ownership table in `docs/architecture/AI-Ownership-Registry.md`, updated with two new rows (`interview_sessions.session_state.liveAssists`, `checkAndConsumeInterviewAssistBudget`).

### E. Regression and build verification — 439/439 passed

Full platform regression via the Regression Runner across all 17 registered suites: **439/439 checks passed**, zero regressions in any prior feature. New suite `interview-copilot-ui`: 19/19 checks — 7 static source checks (covering request shape properties `DEV_MODE`'s shared cost-safety short-circuit makes unobservable at runtime: feature key, `sessionId` wiring, 150-char context trim, no active-question embedding, 200-token cap) plus 12 runtime UI checks (Premium gating, single-tap trigger, no separate confirm button, visible thinking state, proactive warning, both cap-reached states, and non-interference with the rest of the page). `npx vite build` and `npx wrangler deploy --dry-run` both clean. `npx eslint`: no new error classes — the one new `react-hooks/set-state-in-effect` instance (from making the session id reactive) matches the same already-tolerated pattern documented in the LinkedIn Intelligence ADR across every data hook in this codebase.

### F. Localization verification

`tools/localization-validator/`: all 8 new `interview.liveAssist*` keys translated and verified present across all 14 locales (0 missing). Total pre-existing failure count unchanged at 923 before and after this feature — confirming zero new localization gaps introduced.

## Decision Log

| Phase | Decision |
|---|---|
| Audit | `InterviewPage`/`interview_sessions`/`useVoiceInput` verified directly against source. Found the pre-existing roadmap draft materially overstated current capability. |
| Decision Analysis | Options A/B/C evaluated against Human Factors, cost, latency, and privacy criteria. Option C rejected on the Audio/Session Source finding. Option B recommended and approved. |
| Decision Analysis (rules locked) | Human Factors as first-class architecture, Minimal Interaction Principle, Time-to-Answer Budget locked, scoped to this feature only. |
| Cost Architecture Analysis | Assists identified as the true cost driver. $0.003-$0.20/month per actively-interviewing Premium user estimated; hybrid cap (6/interview + 50/month) recommended, reusing `check_and_consume_quota` unchanged. Go recommendation, conditioned on statelessness holding. Cost Drift Rule, Quality vs. Cost Validation requirement, and Blueprint Scope Protection locked as required blueprint considerations. |
| Blueprint | Interaction trigger resolved as single-tap category selection (the specific fix for the voice-reuse-vs-Human-Factors tension flagged after the Decision Analysis). Cap-reached UX resolved (proactive warning). Cost Boundary numbers proposed (6/50). |
| Blueprint — Time-to-Answer validation | Real timing spike run: 3,657 ms and 3,129 ms measured. A fabricated intermediate claim in the blueprint file (~1.96s) was found false and corrected before proceeding, per the explicit instruction to report before locking rather than accept an unverified number. |
| Blueprint — final lock | 3.1-3.7s adopted as the official baseline. No architecture redesign for latency. Required visible "AI is thinking…" state. Streaming documented as future optimization. Latency monitoring designated post-launch. Blueprint locked, implementation authorized. |
| Implementation | Pre-existing, uncommitted, materially incomplete draft code discovered and inspected via full diff before any new code was written (Ownership Rule). Corrected rather than built beside: real dual-leg Cost Boundary added (draft had none functioning), Premium gating added, cap-reached UX added, context trimming corrected, interaction collapsed to single-tap, session id exposed from `useInterviewSession`. Full i18n (14 locales), AI Ownership Registry updated. |
| RC | Full regression (439/439 across 17 suites), build/lint/wrangler-bundle clean, localization validated (0 new gaps), new 19-check suite (7 static + 12 runtime) covering every locked UX decision. Declared Release Candidate Complete and frozen. |

## Status: Frozen

No further feature work, polishing, or architectural changes are to be made under the Real-Time Interview Co-Pilot implementation without revisiting the Cost Architecture Analysis, per the locked Cost Drift Rule and Blueprint Scope Protection. Production model selection (§ Consequences) and streaming (blueprint §6) are documented, deliberately deferred candidates for future work — not built speculatively during this feature's implementation.
