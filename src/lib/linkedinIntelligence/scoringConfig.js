// Versioned configuration for LinkedIn Intelligence's deterministic engine.
// Same pattern as src/lib/compatibility/scoringConfig.js -- the engine
// (deterministicScoring.js) always takes a config object as a parameter
// rather than hardcoding weights, so a new version is a new export here plus
// one line in LINKEDIN_SCORING_CONFIGS, never a change to the scoring logic.
//
// Per the blueprint's §6 clarification: historical rows are never
// recalculated in place when a formula version changes. A persisted
// analysis's `weights_version` records which config produced it, so it stays
// historically accurate even after CURRENT_LINKEDIN_SCORING_VERSION advances.

export const linkedinScoringConfigV1 = {
  version: "v1",
  // Equal-weighted presence checklist for Profile Completeness -- each item
  // is either present (1) or absent (0); items that can't be evaluated from
  // what was provided (e.g. no pasted LinkedIn profile) are excluded from
  // both the numerator and the denominator, never scored as a failing 0,
  // mirroring the Compatibility Engine's renormalization principle exactly.
  completenessChecklist: {
    headline: 1,
    about: 1,
    experienceBullets: 1,
    skills: 1,
    education: 1,
  },
};

export const LINKEDIN_SCORING_CONFIGS = {
  v1: linkedinScoringConfigV1,
};

export const CURRENT_LINKEDIN_SCORING_VERSION = "v1";
