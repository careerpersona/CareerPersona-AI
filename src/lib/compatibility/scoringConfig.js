// Versioned weight configuration for the Career Compatibility Engine.
// The engine (compatibility.js/confidence.js) always takes a config object as
// a parameter rather than hardcoding weights -- a new version is a new export
// here plus one line in SCORING_CONFIGS, never a change to the scoring logic.

export const scoringConfigV1 = {
  version: "v1",
  weights: {
    skills: 0.45,
    jobTitle: 0.25,
    salary: 0.15,
    location: 0.15,
  },
  confidenceThresholds: {
    high: 0.8,
    medium: 0.5,
  },
};

export const SCORING_CONFIGS = {
  v1: scoringConfigV1,
};

export const CURRENT_SCORING_VERSION = "v1";
