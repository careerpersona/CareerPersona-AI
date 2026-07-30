# CareerPersona AI — Job Tracker UX Blueprint

Architecture is locked (see `Job Tracker Blueprint.md`): separate tables, one unified experience, completely independent of the Application Tracker. This document designs the user experience only — no schema, no code.

## Identity, in one sentence

**Save Job** bookmarks something for later. **Smart Apply** prepares an application. **Application Tracker** follows an application you already submitted. **Track** watches something *for you*, in the background, and tells you when it's worth another look — whether or not you ever apply. A user should be able to answer "what is Track for?" after seeing it used once: *it's the only one of the four that doesn't require you to do anything else first, and the only one that acts while you're not looking.*

---

## 1. First Click Experience

**No modal. No side panel. A single anchored callout, shown exactly once.**

This app has no modal/onboarding pattern anywhere today (every precedent — the resume-required banner, the AI-unlock guidance — is a dismissible inline callout), and introducing one just for Track would itself be an inconsistency worth avoiding. A feature about *not* requiring extra steps shouldn't onboard itself with an extra step.

- The moment a user clicks Track for the first time ever, a small popover anchors to the button (not a full-width banner, not a page take-over): one line of copy, one icon, done. *"Tracking watches this in the background and lets you know when something changes — it doesn't create an application."* Directly under it, a secondary link: *"View Job Tracker."*
- Dismissal is automatic on next interaction (click anywhere, or an explicit small "Got it") — **no "don't show again" checkbox.** A checkbox is one more thing to notice and click; showing it exactly once, automatically, and never again achieves the same outcome with less friction. Track the "seen it" state the same way other one-time hints in this app are tracked.
- It never appears again after the first click, on any device, for any subsequent job or company tracked.

---

## 2. After Tracking

**Instant, local, reversible — never a navigation.**

- **Button state**: Track → Tracking, same visual language as the existing Save toggle (outline → filled icon), so the interaction *feels* familiar the first time a user sees it, not novel.
- **Micro-animation**: a brief scale/pulse on the button itself, confirming the click landed — nothing that moves other content on the page.
- **Toast**, bottom or top per existing toast conventions, auto-dismissing in ~4–5 seconds: *"Now tracking [Company] — Undo · View."* Undo removes the row immediately, no confirmation dialog needed (it's cheap and instantly reversible). View jumps to the Job Tracker page.
- The user stays exactly where they were — mid-search, mid-scroll. Tracking must never interrupt the task they were actually doing.
- The first-click callout from §1 does not reappear; from the second track onward, this toast is the entire feedback loop.

---

## 3. Job Tracker Page Design

**Header**: page title + one summary line — *"12 tracked · 3 updates this week"* — same density as existing Dashboard card headers.

**Tabs** (per locked architecture — one unified UI over two tables): `Opportunities` · `Companies` · `Activity`. Same visual treatment as the existing tab bar already used in Opportunity Intelligence (underline on active tab) — no new tab component invented.

**Controls row**: status filter chips (`All` / `Updated` / `New Match` / `Closed`), a search box (company or title), and a sort dropdown defaulting to **Most Recently Changed** (not creation date — the whole point of this page is "what needs my attention," so recency of *change* should win over recency of *adding*). Alternatives: Match % · Date Tracked. This mirrors the existing Job Search sort dropdown and Tracker status-chip pattern, not a new interaction model.

### Opportunity (job) card
| | |
|---|---|
| **Primary** | Job title (largest, bold) · Company · Location · Match % badge, top-right, color-coded on the existing match-score thresholds |
| **Secondary** | Salary, with a delta shown only when it changed (*"↑ $135K–$150K, was $120K–$140K"*) · date tracked · a one-line AI interpretation, present **only** when a real change was detected (see §5) |
| **Status** | `Active` (unchanged) · `Updated` (something changed since last view) · `Closed` (delisted — kept visible, viscerally deprioritized via reduced opacity, not removed) |
| **Actions** | View posting · Save · Smart Apply · Stop Tracking (rightmost, subdued styling — same visual weight as existing "Remove" actions) |
| **Priority** | `Updated` cards sort first by default and get a colored left-border accent — the same "needs attention" visual language already used elsewhere in this app, not a new indicator style |

### Company card
| | |
|---|---|
| **Primary** | Company name (bold) · open-role count matching the user's profile · best Match % among those roles |
| **Secondary** | date first tracked · notes preview (inline-editable — this already works today via the existing watchlist hook) · AI line only when something changed (*"2 new roles posted since you started watching"*) |
| **Status** | `Watching` (steady state) · `New Activity` (accent) — companies have no "closed" state |
| **Actions** | View open roles (→ Job Search, pre-filtered by company) · Edit notes · Stop Tracking |

**Empty state**: icon + *"You're not tracking anything yet"* + one line on what it's for + a CTA into Job Search — same shape as the existing empty state already used on Saved Jobs, not a new pattern.

**Mobile**: single-column stacked cards, action row collapses to icon-only buttons in a row (same compact pattern Job Search's mobile cards already use for Save/Track/Smart Apply today), tab bar becomes horizontally scrollable if needed.

---

## 4. Notification Strategy

**Immediate** — only things where delay has a real cost (someone else could act first):
- Salary increased on a tracked job.
- A tracked job that had appeared closed has reopened.
- A new role at a tracked company scores meaningfully better than anything seen from that company before.

**Daily digest** — meaningful, not urgent, batched into one notification, and only sent when there's genuinely something to say:
- New postings at tracked companies since yesterday (count + top 1–2 highlights).
- Non-salary changes on tracked jobs (requirements, remote status).

**Weekly digest** — synthesis, not raw data (this is the one AI-narrated tier, capped to once per user per week):
- Hiring-trend signal across tracked companies (reusing existing Opportunity Intelligence output, not a new analysis).
- Market movement relevant to the roles being tracked (only if backed by real Salary Intelligence data — never fabricated).

**Never notify**: cosmetic description rewording with no material field change. A materiality check (see §5) must gate every tier — this is what keeps the daily/weekly tiers from becoming noise.

---

## 5. AI Evaluation — AI Justification Rule applied to every candidate

### ✅ PASS — "Why this changed" interpretation line

- **User question**: "Does this specific change actually matter for me, and why?"
- **Deterministic alternative considered**: a structured before/after diff shown as plain badges (salary delta, remote-status flip, a requirement added/removed).
- **Why deterministic isn't enough**: a raw diff shows *what* changed but not whether it's *significant* against this specific user's target salary, constraints, or preferences, and can't fold several simultaneous changes into one takeaway a person can act on at a glance.
- **AI value**: takes the deterministic diff plus the user's own profile/goals and produces one short, grounded sentence of interpretation — genuinely synthesizing significance, not describing the posting.
- **Guardrail**: fires only on an actual detected change (event-triggered, never on a timer or per-poll), and is always given the deterministic diff as its input — never asked to compare raw job text itself.

### ✅ PASS — Weekly digest synthesis

- **User question**: "Across everything I'm tracking, what matters most this week, and what should I look at first?"
- **Deterministic alternative considered**: a flat bulleted list of raw counts and events.
- **Why deterministic isn't enough**: ranking heterogeneous signals (a salary bump vs. a new posting vs. a company-wide hiring trend) against one user's goals is a judgment call, not a formula — a flat list just relocates that synthesis work onto the user, every week.
- **AI value**: ranks and synthesizes into one short, prioritized narrative.
- **Guardrail**: capped at one generation per user per week; built from existing Opportunity Intelligence output, not a new independent analysis pipeline.

### ❌ REJECTED — AI-predicted interview probability for a tracked-but-unapplied job

- **User question (attempted)**: "How likely am I to get an interview here?"
- **Deterministic alternative**: the Compatibility Engine's match score already answers "how well do I fit," which is the real, honest version of this question.
- **Why deterministic isn't enough — it actually is**: the real `interview_probability` elsewhere in this app is explicitly conditioned on an actual generated, tailored application package. No such package exists for a merely-tracked job.
- **AI value**: none defensible. A number generated with nothing real to condition on is narration wearing the costume of a prediction, and risks handing the user false precision.
- **Verdict**: do not build. If "how likely" is the real question, the answer is: generate a Smart Apply package, where the real, conditioned number already exists.

### ❌ REJECTED — AI picks the "best" new role at a tracked company

- **User question (attempted)**: "Which of the new roles here is my best fit?"
- **Deterministic alternative**: Compatibility Engine match score, sorted descending.
- **Why deterministic isn't enough — it already is**: this is a sort, not a judgment call.
- **AI value**: none — this would be AI re-deriving a number a `.sort()` already produces correctly, which is exactly the duplicate-computation this project's own Premium Architecture principles already rule out.
- **Verdict**: sort by Match %. No AI call.

**Standing principle applied throughout**: AI interprets already-computed, already-true facts. AI is never asked to narrate a job posting, invent a probability with no conditioning signal, or re-derive something a deterministic function already answers.

---

## 6. Explicit Non-Behavior — permanent acceptance criteria

Track must **never**:

- Create an `applications` row.
- Create or modify an Application Tracker entry, or change its status.
- Write to `smart_apply_queue`, or trigger AI package generation, automatically.
- Count toward Application Tracker statistics or success rate.
- Mark, or visually imply, a job as "Applied."
- Affect application history or analytics in any way.
- Replace or hide the Save Job action — Save and Track are always both available, independently of each other.
- Reuse or resemble the Application Tracker's status vocabulary (`Phone Screen`, `Interview`, `Offer`, etc.). Job Tracker's own states (`Active` / `Updated` / `Closed` / `Watching`) must never be visually or semantically confusable with the application pipeline.
- Require an application to exist before something can be tracked, or require tracking before something can be applied to. The two systems are usable in either order, or independently, always.
- Let "Stop Tracking" delete or alter a Saved Job, a Smart Apply package, or an Application Tracker entry that happens to reference the same job or company. Stopping a watch only ever removes the watch.

This list is the direct, permanent fix for the exact failure this whole review chain started from — a Track-like action that silently wrote `status: "Applied"`. It is acceptance criteria, not aspiration: any future change to this feature that violates one of these lines is a regression, full stop.

---

## Final UX Recommendation Summary

- First click: one anchored, one-time callout — no modal, no checkbox.
- After tracking: instant local feedback (button state + toast + undo), zero navigation.
- One page, two tabs for entity type plus an Activity feed, unified controls, cards designed so an "Updated" item is impossible to miss and a quiet one is impossible to feel nagged by.
- Notifications tiered strictly by urgency, gated by a materiality check, capped so the weekly digest is the only recurring AI-authored content a user receives.
- Every AI feature in this document passed an explicit interpret-vs-narrate test in writing; two plausible-sounding features were rejected on the record rather than quietly included.
- A permanent, explicit checklist of what this feature must never do, written directly from the one real bug that made this whole review necessary.

*Design only. No code, schema, or locked architecture was touched or revisited.*
