# CareerPersona AI — Real-Time Interview Co-Pilot Locked Blueprint

## Overview
This document captures the final locked architecture for CareerPersona AI's Real-Time Interview Co-Pilot. It preserves the existing co-pilot philosophy and structure, and incorporates the approved refinements without adding any new AI analyses.

The Interview Co-Pilot remains built on the current six AI analyses:
- Job-specific interview question generation
- Answer quality assessment and feedback
- Mock interview performance synthesis
- Readiness scoring and progress tracking
- Per-question behavioral/technical performance breakdown
- Strengths / improvement coaching guidance

All approved refinements are implemented as metadata, memory, trend, or coaching-layer enhancements to those existing analyses.

## Architectural Principles
- Preserve the current single active interview session model with completed history.
- Keep `interview_sessions.session_state` as the authoritative interview intelligence layer.
- Persist working state continuously via `session_state` and `saveSession()`; on reload, restore `jobDesc`, `resume`, `questions`, `activeQ`, `mockIdx`, `mockAnswerDraft`, `mode`, `showReview`, and `reflectionJournal` from `recoveryState`, treating the session row as the source of truth for resumption.
- Use the existing AI prompts and page flow; enrich them by reading and writing stronger performance memory metadata.
- Avoid any additional standalone AI analysis pipeline. Refinements must reuse and amplify existing outputs.
- Treat interview intelligence as a platform memory layer, not only a one-off mock summary.

## Data Model
The core interview data model remains the existing `interview_sessions` row structure:
- `user_id`
- `job_description`
- `questions` — generated interview questions and metadata
- `answers` — saved practice answers and feedback objects
- `mode` — `browse` or `mock`
- `readiness_score` — session readiness score field
- `session_state` — canonical interview performance memory
  - `resume`
  - `resumeFileName`
  - `mockAnswers`
  - `mockSummary`
  - `mockIdx`
  - `mockAnswerDraft`
  - `activeQ`
  - `showReview`
  - `confidenceTimeline`
  - `reflectionJournal`
  - `energyProfile`
  - `interviewerStyle`
  - `recoveryState`

### Performance Memory as Authority
`session_state` is the authoritative interview intelligence layer. It stores the full working session state plus the derived performance memory that downstream interview intelligence consumes.

The Performance Memory layer includes:
- `questions` and answer record history, tagged for long-term retrieval
- `mockSummary` and AI performance metadata
- `readiness_score` and trend context
- `confidenceTimeline` spanning the full interview lifecycle
- `energyProfile` signals and cross-session interviewer style evidence
- `reflectionJournal` post-interview learning entries
- `recoveryState` for exact resume/restart behavior

The platform reads this layer for all interview-related prompts and dashboards.

## Existing Flow with Refinements

### 1. Job-Specific Question Generation
The current `generate()` flow stays unchanged in structure. It remains responsible for producing the candidate's tailored question set.

Refinements:
- Store generated questions in `questions` as the Personal Question Memory.
- Tag each question with category, difficulty, interviewer-style clues, company, industry, role, and interview stage (e.g. phone screen, panel, final round) so questions can be retrieved and understood along any of these dimensions later.
- Embed resume + job context and prior session performance memory into the question prompt so the output reflects evolving coaching.

### 2. Answer Feedback and Scoring
The existing `getFeedbackFor()` flow remains the only AI answer assessment path.

Refinements:
- Persist feedback objects into `savedFeedback` and `mockAnswers`.
- Include `energyProfile` metadata derived from answer tone, pacing, and confidence cues.
- Add explicit `successFactor` labels to feedback, e.g. STAR clarity, technical depth, concise storytelling, outcome focus.
- When an answer is assessed as weak or incomplete, include a `recoverySuggestion` in the feedback object — real-time coaching such as clarifying the point, expanding with more detail, substituting a stronger example, or reconnecting the answer back to the original question. Recovery suggestions coach the candidate's own material; they never fabricate or supply an answer, preserving authenticity.
- Save reflections and lessons learned into `reflectionJournal` (see Interview Decision Journal below).

### 3. Mock Interview Performance Synthesis
The current `buildMockSummary()` flow remains the single mock synthesis step.

Refinements:
- Keep the existing average score and AI summary output.
- Strengthen the summary to include:
  - Interview Confidence Timeline anchor points for this session, tagged to their lifecycle stage (see Section 4)
  - Performance Momentum direction
  - Interviewer Style Intelligence, expressed with the confidence level warranted by accumulated evidence across sessions
  - Interview Success Factors observed in this run
  - Energy Management guidance drawn from the candidate's current interview schedule and workload, not just this session
  - A Coaching Evolution note contrasting earlier coaching focus with current focus, so the candidate can see how the coaching has matured
- Persist all of the above into `mockSummary.aiSummary` and `session_state`.

### 4. Readiness Scoring and Trends
The existing readiness score remains the key numeric indicator.

Refinements:
- Record `readiness_score` as the canonical score for each completed session.
- Build the Interview Confidence Timeline as an ordered set of stage-tagged anchor points stored in `confidenceTimeline`, spanning the full interview lifecycle rather than only practice-session scores:
  - **Preparation** — anchor captured during question generation (Section 1), reflecting readiness going into practice.
  - **Practice** — anchors captured during answer feedback (Section 2), reflecting confidence as individual answers are drilled.
  - **Pre-Interview** — anchor captured from the readiness score at the point the candidate moves from practice into a full mock run.
  - **Live Interview** — anchors captured across the mock interview run itself (`mockAnswers`, `mockIdx` progression), standing in for the live interview experience the practice simulates.
  - **Reflection** — anchor captured from the post-session `reflectionJournal` entries (Section 9).
  - **Outcome** — an optional anchor, populated when the real-world result of the interview becomes available; left unset otherwise, with no dependency on new tables or external integrations.
- Derive Performance Momentum from the direction of `readiness_score` across sessions and from the slope of `mockSummary` strength/improvement signals.
- Expose momentum as a lightweight trend label in the summary and UI.
- Expose the confidence timeline itself (not just momentum) so the UI can show how confidence moved across the lifecycle, not only between sessions.

### 5. Personal Question Memory
This refinement is implemented by making generated questions and practiced answers persistent first-class memory objects.

Implementation:
- Persist `questions` and `mockAnswers` in the active session.
- Persist the same structure in completed history rows for recovery and future reference.
- Tag each stored question by company, industry, role, interview stage, and competency (Section 1), so the memory can be organized and retrieved along any of these dimensions.
- Use these tags to recall prior practice, avoid repeat questions, and surface relevant past questions when preparing for a similar company, role, or competency in the future.
- Keep the memory within the existing interview session table instead of adding a separate memory store.

### 6. Interviewer Style Intelligence
This refinement is layered on top of the existing question generation and mock review process, and is cumulative rather than a single-session judgment.

Implementation:
- Each question generation prompt returns or tags the interviewer's likely style for that session (e.g. structured, conversational, technical, behavioral, executive, fast-paced, collaborative).
- Store that per-session tag in `session_state.interviewerStyle`.
- Derive a cumulative style profile by reading the `interviewerStyle` tags across the candidate's completed session history rather than trusting any single session in isolation.
- Only surface a style as recognized once enough historical evidence supports it; state it with a confidence qualifier when evidence is thin, rather than asserting it outright after one session.
- Use the cumulative, confidence-weighted style read to adapt coaching language and the next question set without adding a separate analysis stage.

### 7. Recovery Intelligence
Recovery Intelligence is real-time coaching that helps a candidate recover after a weak or incomplete answer — it is not session restoration. (Technical resume-on-reload is existing baseline behavior, unaffected by this refinement — see Architectural Principles and the `recoveryState` field.)

Implementation:
- Applied inside the existing `getFeedbackFor()` answer-assessment flow (Section 2); it is not a separate analysis pipeline.
- When an answer is assessed as weak or incomplete, the feedback includes a `recoverySuggestion`: a concrete next step such as clarifying the point, expanding with more detail, substituting a stronger example, or reconnecting the answer back to the original question.
- Recovery suggestions work only with the candidate's own material — prompting them toward a better answer, never generating or supplying one — preserving the platform's authenticity guarantee.
- Persist `recoverySuggestion` alongside the rest of the feedback object in `savedFeedback` / `mockAnswers`, so recovery guidance is retained for review and for future coaching context.

### 8. Interview Energy Management
Energy Management helps a candidate manage preparation and recovery across multiple interviews — it is not single-session emotional state detection.

Implementation:
- Read across the candidate's active and completed `interview_sessions` rows (one row per job/interview being prepared for) to build a lightweight schedule signal: how many interviews are being concurrently prepared for, how recently the candidate last practiced, and the gap between sessions.
- Use this schedule signal to inform guidance on recovery time between practice sessions, preparation balance across concurrent interviews, and prioritization toward the interviews that matter most — derived entirely from existing session rows and their timestamps, with no new scheduling table.
- Continue deriving the per-session `energyProfile` tone signal ("calm", "energized", "focused", "needs warming up") from the answer scoring prompt; it now feeds into the cross-session schedule read as one input rather than being the definition of Energy Management itself.
- Surface schedule-level energy guidance in the mock summary (Section 3) and use it to guide coaching pacing across the candidate's next few sessions.

### 9. Interview Decision Journal
The Decision Journal is a post-interview learning journal — a structured memory object within `session_state`, not a new AI analysis.

Implementation:
- Append entries to `reflectionJournal` after a mock review completes (the Reflection stage of the Interview Confidence Timeline, Section 4).
- Each journal entry captures:
  - what surprised me
  - what worked well
  - what I would improve
  - unexpected questions
  - cultural observations
  - lessons learned
- Use the journal as a source of context for later coaching prompts (Section 10), for the Reflection anchor in the Confidence Timeline, and for future session recovery.

### 10. Coaching Evolution
Coaching Evolution is enforced through iterative use of the authoritative Performance Memory layer, and is made visible to the candidate, not just used silently.

Implementation:
- Include prior session `mockSummary.aiSummary`, `reflectionJournal`, and the accumulated `confidenceTimeline` and interviewer-style history in every new coaching prompt.
- As interview history accumulates, use the memory layer to progressively personalize coaching: early coaching leans on foundational signals (e.g. STAR structure, clarity); as those are consistently demonstrated, coaching shifts emphasis toward more advanced signals (e.g. executive communication, leadership presence, strategic thinking) drawn from the same `successFactor` and `reflectionJournal` history.
- Surface this shift back to the candidate as an explicit Coaching Evolution note in `mockSummary.aiSummary` (Section 3) — contrasting what coaching used to emphasize with what it emphasizes now — so the candidate can experience the coaching maturing alongside them.
- The existing answer feedback and mock summary flows remain the only coach-generation pathways.

## Locked Blueprint Summary
The final locked architecture is:

1. `interview_sessions` remains the single active interview session plus completed history model.
2. `session_state` is the platform's authoritative interview performance memory layer.
3. The six existing AI analyses remain unchanged in count and responsibility.
4. Approved refinements are layered as metadata, memory persistence, trend derivation, and coaching adaptation.
5. No new AI analyses are introduced.
6. Interview intelligence is read from and written to the same session row, ensuring consistent recovery, history, and dashboard context.

## Key Data Layer Responsibilities

### `interview_sessions` row
- Core persistence for active and completed interview practice.
- Stores questions, feedback, answers, readiness score, and session state.
- Enforces one active session at a time.

### `session_state`
- Authoritative interview memory layer.
- Hosts recovery state, personal question memory, the lifecycle-spanning confidence timeline, cross-session energy and interviewer-style signals, and the post-interview reflection journal.
- Feeds all interview-related AI context and UI summaries.

### `mockSummary`
- Primary performance summary object.
- Contains average score, answered/skipped counts, and AI summary fields.
- Enriches the summary with lifecycle-stage confidence timeline anchors, momentum, cumulative interviewer style, cross-session energy guidance, success factors, and an explicit coaching evolution note.

## User Experience Guarantees
- Returning users recover exactly where they left off.
- Confidence is shown across the full interview lifecycle — preparation through reflection, and outcome when available — not only as a session-to-session trend.
- Interviewer style guidance strengthens in confidence as evidence accumulates across interviews, rather than being asserted from a single session.
- A weak or incomplete answer is met with real-time recovery coaching, not just a low score.
- Preparation and recovery time are balanced across the candidate's concurrent interviews, not optimized for a single session.
- Post-interview reflections are captured and retained as structured learning.
- Coaching visibly matures across sessions by re-reading past performance memory, and the candidate can see that evolution.

## Locked Design Requirements
- Keep the existing Interview page flow and AI prompt boundaries.
- Do not add any new standalone analysis module.
- Use the Performance Memory layer as the single source of truth for interview intelligence.
- Ensure all refinements are expressed as enhancements to the existing six analyses and session data model.

## Final Note
This blueprint is locked for the Real-Time Interview Co-Pilot feature. Any future enhancements must preserve the current session-based architecture and must only extend the Performance Memory layer or the existing coaching summaries.
