# Real-Time Interview Co-Pilot — Architecture Blueprint

**Status: ⛔ WITHDRAWN — Not shipped. Removed from the application and the Premium roadmap before release.**

**This was a product decision, not an implementation, architecture, or testing failure.** Everything below was correctly architected, correctly implemented, correctly tested, and correctly documented against its own approved decisions. After a full product-vision assessment (conducted after the Release Candidate was accepted, before any user-facing announcement), the narrowed capability this blueprint describes — Option B, an on-demand hint tool — was found to no longer deliver the level of user value that originally justified this feature's place as a flagship Premium feature. The original vision behind "Real-Time Interview Co-Pilot" (continuous, ambient, dual-party-aware coaching throughout a live interview) was found to be structurally incompatible with today's technical, legal, and commercial constraints — not fixable by better engineering. See `docs/architecture/ADR-Real-Time-Interview-Copilot.md` for the full withdrawal record, and `docs/architecture/Architecture-Governance-Retrospective.md` for the governance lesson this produced (a new **Vision Validation** checkpoint, now permanent process for future features).

**Everything below is preserved as a historical architectural record of Option B's design — it does not describe anything currently in the application.** Do not use this document to re-implement, re-enable, or reference this feature as if it exists.

---

*Original document follows, unmodified below this line, for historical reference only:*

Premium Feature #6 *(original numbering — no longer part of the current Premium roadmap, which now consists of five flagship features)*. Supersedes the prior untracked draft (`docs/Real-Time Interview Co-Pilot Locked Blueprint.md`, now archived to `docs/archive/interview-copilot-withdrawn/`) — that document was found during the architectural audit to contain unverified claims about "existing" architecture (a "six AI analyses" characterization where only three real Claude calls exist, and five `session_state` fields — `confidenceTimeline`, `reflectionJournal`, `energyProfile`, `interviewerStyle`, `recoveryState` — that do not exist anywhere in the codebase). This blueprint is built exclusively from the verified Audit → Decision Analysis → Cost Architecture Analysis sequence (conversation record), not from that draft's claims.

Every design decision below is either carried unchanged from that locked sequence or explicitly resolved here for the first time — never re-derived from scratch.

---

## §1. Feature Purpose (Locked)

Real-Time Interview Co-Pilot is **Option B: Assistant-on-Request During a Live Interview** (locked in the Decision Analysis). The AI never listens continuously, never accesses audio from Zoom/Meet/Teams or any external platform, and never initiates assistance unprompted. It responds only when the candidate explicitly, deliberately asks — during a live interview, not just during practice.

**What this means concretely, as a direct consequence of the locked Audio/Session Source finding:** the system never knows the interviewer's exact words. A hint is necessarily general coaching grounded in the candidate's own prepared question set and a category/topic the candidate indicates themselves — not a live transcript-grounded answer to a verbatim question. This is a permanent product constraint, not a v1 limitation to be lifted later — lifting it would require live third-party platform audio access, which the Decision Analysis found to have no reliable, legal, cross-platform solution.

## §2. Ownership (Locked)

| Responsibility | Owner | Co-Pilot's relationship |
|---|---|---|
| Question/job context | Existing `interview_sessions` / `InterviewPage` prep flow (`generate()`, `App.jsx:7996`) | Reads the already-generated question set and job context; never regenerates or duplicates it |
| Category taxonomy | Existing `cats` / `INTERVIEW_CAT_LABEL_KEY` (`App.jsx:7842`, `8109`) | Reused unchanged as the primary assist-trigger input — no new taxonomy invented |
| Voice dictation | Existing `useVoiceInput` / `VoiceInputBtn` (`src/hooks/useVoiceInput.js`, `App.jsx:7788`) | **Not used for the live-assist trigger** (see §3) — remains practice-mode-only, completely unchanged |
| Assist prompt construction, generation | **Co-Pilot (new)** | Its one genuinely new AI responsibility |
| Assist persistence | Extends `interview_sessions.session_state` (existing table, no new table) | Same pattern as Smart Apply Auto Prep's extension of `smart_apply_queue` rather than a parallel table |
| Cost Boundary enforcement | Existing `check_and_consume_quota` RPC + `handleClaude`'s Layer 2 quota pattern (`worker.js:618-631`) | New feature key(s) only; RPC and enforcement pattern reused unchanged (Cost Architecture Analysis §7) |
| Quota/budget source of truth | Existing `feature_usage` table (via the RPC) | **Not duplicated into `session_state`** — a UI-facing "remaining" count is read from the quota system, never mirrored into a second counter (Ownership Rule) |

## §3. Interaction Trigger (Locked)

This was the open design question flagged after the Decision Analysis: reusing `VoiceInputBtn` as-is fails the Human Factors discreetness test (speaking aloud mid-interview). Resolved here.

**Primary path: tap-only category selection.** The candidate taps one of the four existing interview categories (Behavioral / Technical / Situational / Culture Fit — the same `cats` array already used in practice mode, `App.jsx:8109`) from a small, persistent, low-profile control. No typing required, no speaking required. This is a single action, recognition-based (pick from a short known list) rather than recall-based (compose a sentence), which is materially lower cognitive load under stress.

**Optional secondary path: one short text field**, capped at a small character limit (enforced client-side, not just suggested), for the rare case a category alone isn't enough context. Never required, never voice-driven.

**Explicitly excluded:** voice input for the trigger (fails discreetness — see above), freeform long text (fails "short request" and typing-time), and any form of passive/continuous listening (excluded at the Option B level already).

**Response delivery:** a short text response (capped output length, §11) rendered in the same minimal, persistent control, auto-dismissing after a few seconds or on the next interaction. No text-to-speech — audio output during a live call risks being heard by the interviewer or colliding with call audio, and nothing in the existing codebase does this today (confirmed absence of `speechSynthesis` anywhere in `src/`, audit finding) — this stays true, not something to add.

**"AI is thinking…" state (locked, §6):** from the moment of tap until the response renders, the control shows a brief, visible waiting indicator — required because the measured baseline (§6) is multiple seconds, not near-instant. This keeps the wait legible and intentional rather than presenting as a stall.

## §4. Human Factors Compliance (Locked Rule, Applied — Re-Validated Against Measured Latency)

Every sub-question from the locked Human Factors rule, answered against §3's actual design. **Re-evaluated after §6's real measurement (3.1-3.7s), not left at its original pre-measurement framing** — see the Decision Log entry "Human Factors re-validation" for the full reasoning.

| Test | Result |
|---|---|
| Completed in 1-2 seconds? | **Split, stated honestly:** the tap itself (time to initiate) — yes, under 1 second. Time to *value* (tap → hint in hand) — no, 3.1-3.7s measured, not 1-2s. The original single "Yes" answer here conflated these two; that was an error in framing, corrected now, not a re-derivation of a new fact. |
| Leaves the interview window? | No — a persistent in-page control, not a page navigation. Unaffected by latency. |
| Interrupts eye contact? | Minimized, not eliminated, and **more materially than originally assumed**: a 3-4s wait means a longer sustained glance-down than a near-instant response would require, and the assist cap permits up to 6 taps per interview — a real cumulative attention-interruption pattern across one interview, not just a single brief glance. Named directly rather than minimized. |
| Requires typing long prompts? | No — primary path requires none; the optional secondary path is capped short. Unaffected by latency. |
| Performed discreetly? | The tap remains discreet. The *wait* is less discreet than originally implied — reading a response after a multi-second pause is a longer, more noticeable pause than the tap-only framing suggested. |
| Would a stressed candidate realistically use it? | Yes, on balance — grounded in how real interviews function: a 3-5 second pause while a candidate visibly collects their thoughts ("let me think for a moment...") is normal, unremarkable interview behavior with no tool involved at all. A bounded, honestly-communicated wait of comparable length is not obviously distinguishable from that. This is the deciding factor, not an assumption that the wait doesn't exist. |

**Why this doesn't require an interaction redesign:** latency and interaction design are different problems. The tap is not what's slow — model inference is — so no redesign of the trigger mechanism (voice, gesture, anything else) would change the 3.1-3.7s figure. A redesign would only be the right response if the *interaction itself* were the source of the friction; it isn't.

**Genuine, not dismissed, residual risk:** the cumulative interruption across up to 6 taps/interview (§7) is a real consideration a single-tap analysis undersells. This is not resolved by reasoning alone — it's the specific thing post-launch latency monitoring (§6) should watch for: not just raw response time, but whether real candidates stop using repeated assists because the wait feels awkward in practice. If that signal appears, it would be evidence for reconsidering scope, not just tuning a number.

## §5. Minimal Interaction Principle Compliance (Locked Rule, Applied)

Single tap (§3) → short request (a category + optional short phrase, never more) → short response (capped tokens, §11) → immediate auto-return (no persistent panel left open) → **no follow-up affordance of any kind** — no "tell me more," no thread, no multi-turn continuation UI. Each assist is a fresh, independent interaction; asking again means tapping again from scratch, not continuing a conversation.

**Statelessness — architectural, not just behavioral:** each assist prompt is built fresh from (a) the category/short phrase just provided, (b) the existing prepped job/question context, and (c) nothing else. No prior assist's request or response is ever included in a later assist's prompt, in this or any session. This is the single largest cost lever identified in the Cost Architecture Analysis (§2 of that analysis: naive history accumulation would nearly triple a 6-assist session's cost) and is treated here as a hard architectural constraint, not a style preference.

**Clarified distinction (resolves a subtlety the Cost Architecture Analysis didn't need to address but the data model does):** *storing* a log of past assists for the candidate's own later review (§10) is permitted and consistent with the existing interview-history philosophy already in this codebase — what's prohibited is *feeding that stored log back into a subsequent prompt as context*. Persistence for display and reuse-as-context are different things; only the latter is restricted.

## §6. Time-to-Answer Budget (Locked Rule, Target Defined Honestly)

The Decision Analysis correctly deferred picking a number. This blueprint sets a working target while being explicit about what's known versus assumed:

- **Official baseline (locked): 3.1-3.7 seconds**, from two real, direct Anthropic API calls (`claude-sonnet-4-6`, prompt/output sized to this blueprint's §10 spec) — measured, not assumed. This is the model-call latency alone; the full production path (auth check, subscription lookup, two `check_and_consume_quota` RPC calls, client-worker network round trip) adds to this, not subtracts from it.
- **Explicit decision: the architecture is not redesigned solely to reduce this number.** No streaming, no model change, no prompt restructuring undertaken for latency reasons in this implementation pass. The interaction model from §3-§5 stands unchanged.
- **UX response to the real baseline: a visible "AI is thinking…" state is required** during response generation (§3's response-delivery area shows this state from the moment of tap until the response renders), so the multi-second wait is legible to the candidate rather than presenting as a stall or a broken control. This is the chosen mitigation — a designed, honest wait indicator — not a latency fix.
- **Streaming is documented as a future optimization, not a launch requirement.** If a future pass wants to shorten perceived latency (first-token time rather than total generation time), streaming is the identified candidate — explicitly out of scope for this implementation.
- **Latency monitoring is a post-launch operational task, not an implementation blocker.** Real-world variance under different network conditions, API load, and prompt sizes should be observed after launch using the project's existing observability practices; it does not gate shipping this feature.

## §7. Cost Boundary (Locked, Numbers Proposed)

Per the Cost Architecture Analysis's recommended hybrid model — the cost driver is assists, not sessions or minutes:

| Cap | Value | Reasoning |
|---|---|---|
| Max assists per interview | **6** | Covers even the Cost Architecture Analysis's Heavy usage scenario for a 60-minute interview (§1 of that analysis: up to 6 assists) without being so generous it stops constraining behavior or contradicts the Minimal Interaction Principle |
| Max assists per month | **50** | Comfortably covers the Conservative monthly scenario (§4 of that analysis: ~43.3 assists/month for a heavy user) with headroom, while remaining a real, predictable ceiling |

Both are **fixed, platform-set, not user-configurable** — mirroring Smart Apply Auto Prep's precedent (a plain product decision, not a formula-derived number) and explicitly *not* wired to `automation_preferences`, since that table governs pacing of an automatic background process and Co-Pilot has none (Cost Architecture Analysis §7 finding). These two numbers are the blueprint's proposed starting point, expected to be revisited once real usage data exists — that revision is a routine product-tuning decision and does **not**, on its own, trigger the Cost Drift Rule (§13); only a change to the interaction model's *shape* does.

**Enforcement:** the existing `check_and_consume_quota` RPC, unchanged, called twice per assist request analogous to Smart Apply Auto Prep's dual-leg budget check — a per-interview leg keyed by the `interview_sessions` row id as `p_period` (valid, since `p_period` is confirmed free-text with no format assumption) and a per-month leg keyed by the existing monthly period-key convention. Both legs integrated into `handleClaude`'s existing Layer 2 quota-check pattern under a new feature key (e.g. `interview_copilot_assist`), not a new route.

## §8. Cap-Reached UX (Locked — Required Blueprint Consideration, Resolved)

**Decision: proactive warning, never a silent surprise.** When the candidate is about to consume their *last* available assist for the current interview (per-interview cap) or is close to their monthly ceiling, the control shows a brief, low-intrusion indicator (e.g., "1 hint left") *before* they tap — not an error message *after* they've already tried and failed.

**Reasoning:** this happens during a live, high-pressure moment. Discovering "you're out of hints" only after attempting to use one, at the exact moment help is needed most, is a worse experience than not having the cap communicated at all — it introduces a fresh, unplanned stressor at the worst possible time. A quiet, always-visible remaining-count (or a warning only once low, to avoid constant on-screen noise) lets the candidate make an informed choice about whether to spend their last assist now or hold it, which respects their agency during the interview rather than surprising them.

**When the monthly cap is fully reached:** the live-assist control degrades gracefully to a calm "no assists remaining this month" state — it does not block or interfere with anything else (practice mode, question generation, the interview itself all continue working normally). Only the live-assist capability is affected, and the messaging is neutral, not alarming.

## §9. Data Model

Extends `interview_sessions.session_state` (existing column, no new table — same reuse pattern as Smart Apply Auto Prep extending `smart_apply_queue`):

| New field | Purpose |
|---|---|
| `liveAssists` | Array of `{category, shortNote, response, timestamp}` — a *display-only* log of assists given in this session, for the candidate's own later review (interview history). **Never read back into a future prompt** (§5). |

**Explicitly not added:** no duplicate "assists remaining" counter in `session_state` — that value is always read live from the quota system (Ownership Rule, §2), preventing two sources of truth from drifting apart.

## §10. AI Generation

One new function, `buildInterviewAssistPrompt(category, shortNote, questionContext)`, following the existing prompt-construction convention (inline template literal, same shape as `getFeedbackFor`) but deliberately smaller:

- **Context included:** job title + a short (not full-JD) role descriptor, the tapped category, the optional short note. **Never** the full job description or resume text at the length existing practice-mode calls use (Cost Architecture Analysis §8 recommendation).
- **Context never included:** any prior assist, any conversation history, any accumulated session state beyond the current tap (§5).
- **Output cap:** a hard `max_tokens` value in the 150-250 range, enforced numerically (not just requested in the prompt) — the same lesson the existing `buildMockSummary` call (350 max tokens) already demonstrates: brevity needs a real ceiling, not just an instruction.
- **Execution path:** the existing `askClaude` → `handleClaude` path, unchanged, with a new `feature` key for quota attribution (§7).

## §11. Model Selection (Deliberately Deferred — Required Blueprint Consideration, Resolved as "Not Yet")

Per your explicit instruction: **no model change now.** The first implementation ships on the existing default (`claude-sonnet-4-6`, the only model currently wired into `handleClaude`). Before this is considered final, a benchmark comparing the production model against a lower-cost candidate (e.g., Claude Haiku 4.5) on this specific, narrowly-scoped "short hint" task must be run, and the production choice must be based on that measured quality comparison — not assumed from general capability differences. This is a pre-GA validation step, not a blocker to beginning implementation on the current default model.

## §12. Cost Drift Rule (Locked, Verbatim)

> Any future change that introduces persistent conversation history, continuous listening, automatic background AI requests, additional AI calls per assist, or any other change that materially increases AI request frequency or token growth must trigger a new Cost Architecture Analysis before implementation. Cost assumptions from this document must not be considered valid after such changes.

Applies permanently to this feature. Does not apply to routine numeric tuning of the caps in §7 (a product decision within the locked interaction model) — only to changes that alter the model's *shape*.

## §13. Blueprint Scope Protection (Locked, Applied to This Document)

This blueprint introduces exactly one new AI-calling capability (§10) with a stateless, single-request/single-response shape, and explicitly excludes proactive suggestions, continuous coaching, automatic commentary, and any persistent conversational thread. Any future revision that would add one of those must first revisit the Cost Architecture Analysis this blueprint is built on — that analysis's conclusions are conditioned entirely on the stateless model holding (Cost Architecture Analysis §9).

## §14. Governance Rules Applied

- **Human Factors as first-class architecture** — §3/§4, evaluated before any UI was designed, not after.
- **Minimal Interaction Principle** — §5, architecturally enforced (statelessness), not just a UX guideline.
- **Time-to-Answer Budget** — §6, defined as a target with an honest gap disclosed, not asserted as already solved.
- **Cost Drift Rule** — §12, locked verbatim.
- **Quality vs. Cost Validation** — §11, required before model finalization, not before starting implementation.
- **Ownership Rule** — §2/§9, no duplicated source of truth for quota state; every reused component's existing owner is unchanged.
- **AI Justification Rule** — every assist is triggered by an explicit, individual user action; no AI runs without a specific request.
- **Reuse Before Recreation** — `askClaude`/`handleClaude`, `check_and_consume_quota`, the existing category taxonomy, and the `session_state` extension pattern are all reused unchanged; only the assist prompt function and two quota feature keys are new.

## §15. Required Blueprint Validation

- Does not access third-party interview-platform audio anywhere — confirmed, §1/§3.
- Does not reuse `VoiceInputBtn` for the live trigger (Human Factors conflict resolved) — confirmed, §3.
- Does not duplicate quota/budget state into `session_state` — confirmed, §2/§9.
- Does not feed assist history back into future prompts — confirmed, §5/§9.
- Does not lock a model choice without evidence — confirmed, §11.
- Cap-reached behavior is an intentional, reasoned product decision, not a default — confirmed, §8.
- Cost Boundary reuses existing RPC/quota infrastructure unchanged — confirmed, §7 (Cost Architecture Analysis §7).

## §16. Decision Log

| Phase | Decision |
|---|---|
| Audit | Existing `InterviewPage`/`interview_sessions`/`useVoiceInput` architecture verified directly against source; found the pre-existing roadmap draft materially overstated current capability (six analyses claimed vs. three real calls; five `session_state` fields claimed that don't exist). |
| Decision Analysis | Options A/B/C evaluated. C rejected primarily on the Audio/Session Source finding — no reliable, legal, cross-platform way to capture live third-party interview audio. B recommended: identical audio-source profile to A (candidate's own device only) with meaningfully more Premium value, full reuse of existing infrastructure, clean AI Justification Rule fit. |
| Decision Analysis (rules locked) | Human Factors as first-class architecture, Minimal Interaction Principle, Time-to-Answer Budget locked as governance rules, scoped to this feature's blueprint (not elevated to permanent platform-wide governance). Voice-reuse tension flagged for blueprint resolution. |
| Cost Architecture Analysis | Assists identified as the true cost driver (not sessions/minutes). Estimated $0.003-$0.20/month per actively-interviewing Premium user across optimistic/expected/conservative scenarios; worst-case ceiling ~$19,500/month at 100,000 users with no Cost Boundary. Hybrid cap (assists/interview + assists/month) recommended, reusing `check_and_consume_quota` unchanged. Go recommendation, conditioned on the stateless design holding. |
| Cost Architecture Analysis (locked additions) | Cost Drift Rule, Quality vs. Cost Validation requirement, Blueprint Scope Protection, and the cap-reached UX question locked as required blueprint considerations before proceeding. |
| Blueprint | Interaction trigger resolved (tap-first category selector, no voice, no freeform typing) — the specific fix for the Human-Factors-vs-voice-reuse tension flagged earlier. Cap-reached UX resolved (proactive warning, never a silent surprise). Cost Boundary numbers proposed (6/interview, 50/month). Model selection explicitly deferred pending a quality benchmark. |
| Blueprint — Time-to-Answer validation | Two real, direct Anthropic API calls measured (not assumed): 3,657 ms and 3,129 ms raw model latency against the §10 prompt spec — materially higher than the original 2-4s target, measured *before* adding `handleClaude`'s auth/quota overhead. Reported before lock per the original instruction. |
| Blueprint — final lock | 3.1-3.7s adopted as the official measured baseline. Explicit decision made not to redesign the architecture solely to reduce latency. Mitigation: a required visible "AI is thinking…" state during generation (§3/§6). Streaming documented as a future optimization, not a launch requirement (§6). Latency monitoring designated a post-launch operational task, not an implementation blocker (§6). Blueprint locked; implementation authorized to proceed without further checkpoint review until Release Candidate. |
| RC — Human Factors re-validation | Before accepting the RC, §4 was re-evaluated against the real 3.1-3.7s baseline rather than left at its pre-measurement framing. Correction made: "Completed in 1-2 seconds?" originally answered as a single "Yes" conflating tap-time (true) with time-to-value (false at 3.1-3.7s) — split and stated honestly. "Interrupts eye contact"/"Performed discreetly" revised to name the real degradation from a multi-second wait rather than minimize it. Conclusion held (no interaction redesign, mitigation via the existing "thinking" state) on the reasoning that latency and interaction design are different problems — no trigger redesign changes model inference time — and that a bounded few-second wait is not obviously distinguishable from the natural pauses already common in real interviews. New residual risk named explicitly (not previously called out): cumulative interruption across up to 6 taps/interview, added as a specific signal for post-launch monitoring to watch for, not just raw latency. Provenance of the earlier false "~1.96s" figure investigated: no tool-call record of it being measured against this feature's actual request shape exists; cannot be confirmed as placeholder vs. misreported measurement vs. another error — stated as genuinely unknown rather than guessed. |
| RC — Risk disposition and freeze | Cumulative-interruption risk given an explicit disposition: accepted as a deliberate trade-off for the initial release, with a predefined post-launch re-evaluation trigger. Feature frozen, RC accepted. |
| **Post-freeze — Product Vision Assessment** | After freeze, a separate, deliberate product-vision review (not an architecture review) traced the feature's full lifecycle against the *original* pre-existing vision (continuous, ambient, dual-party-aware coaching) and a first-principles technical feasibility analysis across every realistic architecture (browser, extension, desktop native, mobile, platform integrations). Finding: the original vision is not achievable with any architecture without either an unresolved third-party-consent legal problem or losing the "ambient/covert" experience that defined it — not an engineering gap, a structural one. Separately, no explicit checkpoint had ever asked "does the narrowed Option B capability still justify flagship Premium status" after Option C was ruled out — that gap was named directly. **Final product decision: withdraw the feature.** Correctly built, correctly tested — and still the wrong product, once measured against the value the roadmap originally promised. |

---

**⛔ WITHDRAWN.** This feature is not present in the application. It was fully removed following the withdrawal decision above; see `docs/architecture/ADR-Real-Time-Interview-Copilot.md` for the complete removal record (what was removed, retained, and archived) and `docs/architecture/Architecture-Governance-Retrospective.md` for the permanent governance lesson this produced. This document is retained as a historical architectural record only.
