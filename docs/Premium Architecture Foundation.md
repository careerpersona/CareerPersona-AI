# CareerPersona AI — Premium Architecture Foundation

## Purpose

The Premium layer is a set of paid features that sit **on top of** CareerPersona AI's existing AI Intelligence modules (Job Intelligence, the Career Compatibility Engine, Resume/ATS Intelligence, Interview Co-Pilot, Salary Intelligence, Network Intelligence). Premium's job is to **orchestrate and extend** what those modules already know about a candidate — not to stand up a second, parallel intelligence stack. Every Premium feature is a consumer of existing intelligence first, and only produces new analysis for questions no existing module already answers.

## Core Principle

**Consume before you compute.** Before a Premium feature writes a new prompt or a new scoring function, it must check whether an existing AI Intelligence module already produced the answer. If it did, Premium reads that result. If it didn't, the new analysis Premium adds must answer a genuinely new question — never restate, re-score, or re-explain something another module already covers with a different phrasing. This principle exists to prevent four specific failure modes: duplicate LLM calls, duplicate reports, conflicting conclusions, and redundant calculations. Any Premium design that reintroduces one of these should be treated as a defect, not a style preference.

## Responsibility Model

Each Premium feature owns exactly one clearly-scoped responsibility and is accountable for its own output end to end — its own prompt (when a new one is genuinely needed), its own persistence, its own UI surface. No Premium feature's responsibility may overlap another's; if two features seem to need the same underlying judgment (e.g., "is this candidate a strong fit"), that judgment belongs to an existing Intelligence module (the Compatibility Engine, in that example), and both features consume it rather than each forming their own opinion.

## Data Ownership

Each Premium feature owns its own table(s) and is the only writer to them. It never writes into another Premium feature's table or into an existing AI Intelligence module's table — even to "help." Existing Intelligence module data (compatibility scores, ATS results, interview readiness, salary benchmarks, network signals) is **read-only input** to Premium features; Premium never mutates it, versions it, or forks a copy of it into its own schema. If a Premium feature needs to persist something derived from that data, it stores its own derived record, referencing the source (job id, resume id, session id) rather than duplicating the source's fields.

## Shared Data Flow

Every Premium feature follows the same read → derive → persist shape:
1. **Read** the candidate's profile, the relevant existing Intelligence outputs, and its own prior state (if any).
2. **Derive** its feature-specific output — ideally by combining/reformatting existing intelligence; only calling an LLM for content that is genuinely new.
3. **Persist** the result to its own table, in a versioned, explainable shape (mirroring the existing `compatibility_breakdown` pattern: store the inputs' provenance and a version tag, not just the final answer), so later changes to the underlying logic don't silently reinterpret old records.

There is no shared "Premium orchestration" service that features must route through — each feature performs this flow independently, reading the same underlying Intelligence tables directly.

## Integration with Existing AI Intelligence Modules

Premium features integrate with existing modules the same way any other part of the app does: through the existing `src/data/*.js` hooks and Supabase tables, never through a new duplicate access path. If an existing hook already exposes what a Premium feature needs, that hook is reused as-is. Premium features must not fork, wrap, or re-implement an existing Intelligence module's logic to get a slightly different shape — if the existing shape is inconvenient, that's a signal to extend the existing module (a separate, deliberate decision) rather than to build around it inside Premium.

## Communication Between Premium Features

Premium features do not call each other directly and do not import one another's internals. If Feature B needs something Feature A produced, it reads Feature A's persisted output from Supabase — exactly the same way it reads any Intelligence module's output. This keeps every feature's dependency surface flat and inspectable: a feature's inputs are always "existing tables it reads," never "another feature's live code path." No shared in-memory state, no event bus, no feature-to-feature RPC.

## Boundaries That Prevent Duplicated Logic

- No two Premium features (or a Premium feature and an existing module) may independently compute the same judgment about the same entity.
- No Premium feature re-runs an LLM call whose answer already exists in a readable table for the same candidate/job/session.
- No Premium feature produces a second "report" covering ground an existing module's report already covers — it extends that report's underlying data or presents it differently, rather than authoring a competing narrative.
- Before adding a new scoring number, check whether an existing score (match score, ATS score, readiness score) already answers the question; extend or reference it before inventing a new one.

## Shared Conventions

- Follow the existing `src/lib/` (pure logic, no I/O) vs. `src/data/` (Supabase-touching hooks) split already established in this codebase.
- Gate access through the existing billing/entitlement state (`profile.plan` / billing state), not a new Premium-specific auth mechanism.
- All user-facing text goes through `t()`, consistent with the locked i18n architecture.
- Persisted Premium output is versioned and explainable, not just a final value, matching the precedent set by the Compatibility Engine's scoring records.
- New Premium tables follow the existing naming and RLS conventions already used across the app's Supabase schema.

---

*This document defines shared conventions only. It is not an implementation plan for any individual Premium feature, including LinkedIn Profile Intelligence. Frozen after one review pass; revisit only if implementation surfaces a real conflict, not a hypothetical one.*
