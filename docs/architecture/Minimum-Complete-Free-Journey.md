# CareerPersona Core Journey

**Status:** 🔒 Frozen — permanent architectural reference for every future Free-versus-Paid feature placement decision.
**Date:** 2026-08-06
**Produced during:** Subscription Architecture work, immediately before Step 4 (Pricing & Quotas). Builds on, and should be read alongside: the Engineering Cost Classification, Customer Value Classification, Subscription Recommendation, and Business Validation produced in the same review.

This document defines two related but distinct things, and the distinction is the point:

- **The CareerPersona Core Journey** — the sequence of outcomes every user must move through to experience what the product actually promises. This is conceptual and tier-agnostic. It does not name a single feature, page, or subscription tier, and it should not need to change just because the architecture underneath it does.
- **The Minimum Complete Free Journey** — the *current implementation* of the Core Journey at the Free tier: which features satisfy which step, today. This half is bound to the present architecture and is expected to be revisited as the product evolves — the Core Journey above it is what stays stable.

Future Free-vs-Paid decisions should reference the Core Journey and the Architectural Principle below, rather than re-deriving the onboarding journey from scratch.

---

## 1. Product Promise

**CareerPersona AI promises that a job seeker will never have to guess whether an opportunity is genuinely worth their time — every job is evaluated against their real background, not a generic filter — and that they will always know what to do next to become a stronger candidate for it.**

Two commitments live inside that promise, and the architecture exists to keep both:

- **Evidence over guesswork** — a match score, a gap, a recommendation is always traceable to the user's own data, never invented or generic.
- **A next action always exists** — nothing in the product is a dead end.

Neither commitment names a feature. Both are outcomes. Everything below exists to make them concrete.

---

## 2. The CareerPersona Core Journey

The Core Journey is the outcome sequence, independent of which page or feature currently implements each step:

1. **Create an account with no friction and no payment risk.** Nothing about the product's value has been demonstrated yet, so nothing should be asked of the user yet.
2. **Establish who they are, professionally, in under a minute.** Enough coordinates — target role, location, work-type preference — for the rest of the product to reason about them specifically instead of generically.
3. **Bring their real career history into the product.** The pivot point of the entire journey: before this, the product only knows what the user *said* about themselves; after it, the product has actual evidence to reason from.
4. **See real, live opportunities in their field** — not samples, not a teaser list.
5. **Understand, with evidence, why a specific opportunity is or isn't a fit for them.**
6. **Organize the opportunities that matter to them**, so discovery doesn't evaporate into browser tabs.
7. **Experience the product working on their behalf without being asked.** A free, zero-cost preview of the automation story the top tier later delivers in full.

> ### ★ Primary Outcome
> **Step 5 — understanding, with evidence, why a specific opportunity is or isn't a fit — is the Primary Outcome of the CareerPersona Core Journey.**
>
> Every other step exists to make this one possible or worth acting on. Step 1 and 2 exist so the product knows who to evaluate against. Step 3 exists so there is real evidence to evaluate with. Step 4 exists so there is something real to evaluate. Steps 6 and 7 exist because the user needs somewhere to act on what Step 5 just told them. **If a user never reaches Step 5, they have not experienced CareerPersona AI — only a worse version of something available anywhere else.** This is the one step that separates the product from a generic job board, and the one outcome every future Free-vs-Paid decision should protect first.

---

## 3. Minimum Complete Free Journey

*(the Core Journey above, as currently implemented at the Free tier — this section is bound to today's architecture and is expected to be revisited as the product evolves)*

| Core Journey step | Current implementation | Cost |
|---|---|---|
| 1. Create an account | Supabase auth (email/password, no card) | Zero |
| 2. Establish identity & intent | `ProfilePage` — target role, location, work-type preference | Zero |
| 3. Bring in real career history | Resume **Import** — `ResumePage`, Upload/Paste mode (`resumeSource === "upload"`), client-side `parseResumeDoc` | Zero |
| 4. See real, live opportunities | Job Search (Adzuna + JSearch/RapidAPI) | High — capped by usage limit, not a tier gate (Step 4) |
| 5. Understand why a job fits — **Primary Outcome** | Career Compatibility Engine (`match_score` + components) | Zero |
| 6. Organize what matters | Saved Jobs + Application Tracker (core CRUD) | Zero |
| 7. Experience passive value | Job/Application Change Detection | Low |

A brand-new user can walk all seven steps today, end to end, without a credit card and without the business spending more than the cost of two AI calls (Change Detection) plus the externally-metered Job Search calls that Step 4 will cap. Every other cost in the app belongs to what comes *after* this journey, not inside it.

---

## 4. Required User Outcomes

Derived from the Core Journey, not assumed in advance:

| # | Outcome | Why it's required |
|---|---|---|
| 1 | Establish identity & intent | Nothing downstream can be personalized without it. |
| 2 | Contribute real career evidence | Stated preferences aren't evidence — without this, matching degrades to keyword search on a job title. |
| 3 | See real, current opportunities | A sample/demo list cannot deliver the Primary Outcome, because nothing about it is verifiably true for this user. |
| **4** | **Understand, with evidence, why a specific job is or isn't a fit** | **★ Primary Outcome.** The one outcome that separates this product from a generic job board. |
| 5 | Organize the opportunities that matter | Discovery without retention gives the user no reason to return. |
| 6 | Experience the product working without being asked | Plants the seed for the top tier's entire value proposition, at zero cost, before a cent is spent. |

---

## 5. Architecture Mapping

| Outcome | Feature(s) | Current placement | Supports or blocks |
|---|---|---|---|
| 1. Establish identity & intent | `ProfilePage` | Free — no gate exists | Supports |
| 2. Contribute real career evidence | Resume **Import** (Upload/Paste) | Free — no gate exists | Supports |
| 3. See real, current opportunities | Job Search | Free (approved), pending Step 4 usage cap | Supports, pending cap |
| **4. Understand why a job fits** | **Career Compatibility Engine** | **Free (approved), Zero cost** | **Supports fully — the cleanest deliverable of the Primary Outcome in the entire architecture** |
| 5. Organize what matters | Saved Jobs + Application Tracker (core CRUD) | Free — no gate exists | Supports |
| 6. Experience passive value | Job/Application Change Detection | Free (approved) | Supports |

### Newly recognized first-class capabilities

Two capabilities on this map were never inventoried by the earlier Engineering Cost / Customer Value classification — correctly, since that pass was explicitly scoped to AI/API call sites, and neither of these makes one:

- **Resume Import** (Upload/Paste, `ResumePage`)
- **Application Tracking** (core CRUD, outside the Insights tab)

Both are essential to the Core Journey even though neither was visible in an AI/API-scoped inventory. That makes them **first-class architectural capabilities in their own right, not incidental implementation details of some other feature.** Future capability inventories should list them explicitly, even though they carry no AI/API cost line of their own.

### Resume Builder, resolved

This mapping is what answers the question that motivated this whole review. "Resume Builder" (the AI-generation call, `resumeSource === "ai"`) satisfies no outcome above that Resume **Import** doesn't already satisfy at zero cost — the Compatibility Engine consumes `resume.content` identically regardless of how it was produced. Resume Builder remains Pro. See §7 for this worked as the Architectural Principle's first application.

---

## 6. Architectural Principle

*This is an Architectural Principle, not a Governance Rule. Governance Rules in this codebase are earned through repeated validation across multiple real decisions ([[project_governance_rules_locked]]). This principle has been demonstrated successfully exactly once — the Resume Builder decision below. It guides design from here forward; it is not yet locked, and should be promoted to a Governance Rule only once it has independently resolved a second real placement decision, not on a fixed schedule.*

> **A feature may belong in the Free plan only if it is required to complete the CareerPersona Core Journey.**
>
> Every proposed Free feature must identify which required outcome of the Core Journey it satisfies.
>
> If it satisfies no required outcome, it should not be placed in the Free plan without an explicit architectural exception and documented reasoning.

---

## 7. Architectural Assessment

**What Free durably contains, under this model:** identity (`ProfilePage`), Resume Import, Job Search (usage-capped, not tier-gated), the Career Compatibility Engine, Application Tracking, and Change Detection. Nothing more is required, and — per the Principle above — nothing more should be added without first identifying which Core Journey outcome it satisfies.

**The Resume Builder decision, as the Principle's first worked application.** The question this review started with was *"Should Resume Builder be Free?"* — a feature-level question with no stable answer, since it invites re-litigation every time the feature changes. Applying the Principle replaced it with a structural question: *"Is Resume Builder required to complete the CareerPersona Core Journey?"* Traced against the Architecture Mapping in §5, the answer is no — Resume Import already satisfies Outcome 2 at zero cost, and Resume Builder satisfies no outcome that Import doesn't. The feature-level debate resolved itself the moment the right question was asked. That is the model this document exists to make repeatable.

**How to apply this document to a future decision:**

1. Identify which Core Journey outcome (§4) the proposed feature would satisfy.
2. Check the Architecture Mapping (§5) for whether that outcome is already satisfied by something else, at what cost.
3. If the feature satisfies no outcome, or duplicates one already satisfied elsewhere, it does not belong in Free under the Architectural Principle (§6) — without an explicit, documented exception.
4. If it satisfies an outcome nothing else does, place it in Free and add it to §5 as a new row, so the map stays a true record of the architecture rather than a historical snapshot.

This document does not need to be re-derived for the next Free-vs-Paid question. It needs to be applied.
