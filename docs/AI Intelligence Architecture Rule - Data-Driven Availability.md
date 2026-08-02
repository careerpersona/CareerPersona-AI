# AI Intelligence Architecture Rule — Data-Driven Availability

## Purpose

Establish a consistent architecture standard for how AI Intelligence features become available across CareerPersona AI.

This rule ensures Premium AI features grow naturally alongside the user's career journey while remaining statistically honest and avoiding artificial feature gates.

## Principle

AI Intelligence features should become available when the system has enough relevant data to produce a meaningful, statistically honest insight.

Availability should be determined by data readiness, not arbitrary usage milestones or application-count thresholds.

## Philosophy

CareerPersona AI rewards real career progress, not repetitive user activity.

Users should never feel encouraged to perform unnecessary actions simply to unlock Premium functionality.

Instead, the platform should naturally become more intelligent as meaningful career data is collected.

## Default Rule

Every new AI Intelligence feature must first answer one question:

> **What is the minimum real data required to produce a trustworthy insight?**

That answer determines feature availability.

## Count-Based Gating

Application-count milestones, usage counters, or other numeric thresholds should not be the default gating mechanism.

If a feature proposes count-based gating, the architecture review must explicitly justify why:

- the required insight cannot be determined from available data,
- a data-driven availability model is not appropriate,
- and a count-based gate provides a better user experience.

This justification should be documented before implementation.

## Availability vs. Confidence

Availability and confidence are separate architectural concepts.

**Availability**
Determines whether sufficient data exists to generate an insight.

**Confidence**
Communicates how reliable that insight is based on the available evidence.

An insight may be available with limited confidence.

Unavailable insights should explain what additional data is needed, rather than instructing users to perform arbitrary actions.

## UX Philosophy

Unavailable insights should communicate progress, not restriction.

Avoid language such as:

- "Waiting for..."
- "Unlocks at..."
- "Apply more to unlock..."

Prefer language that explains:

- what data enables the insight,
- how the feature naturally grows alongside the user's career,
- why additional data will improve future guidance.

Users should always understand why an insight is unavailable and what real-world activity will naturally enable it.

## Relationship to AI Module Architecture

This rule complements the existing AI Intelligence architecture principles.

Each AI Intelligence module must:

- Have one clearly defined responsibility.
- Avoid duplicating another module's intelligence.
- Become available when its own required data is sufficient.
- Never rely on another module's arbitrary milestones for availability.

Availability should always be driven by the data required for that module's specific responsibility.

## Scope

This is the default architecture rule for all AI Intelligence modules within CareerPersona AI.

Modules may deviate from this rule only after a documented architecture review concludes that a data-driven availability model is not appropriate for that specific feature.

Every exception must include a written justification.

## Reference Implementation

Application Outcome Intelligence (2026-08-02 migration, commit `59f14b7`) is the reference implementation of this rule: `computeAnalysisAvailability` in `src/lib/outcomeIntelligence/patternEngine.js` gives each of its six analyses an independent, data-specific predicate rather than a shared application-count threshold. See `docs/Application Outcome Intelligence Locked Blueprint.md` for the full feature architecture.
