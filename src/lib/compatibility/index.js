// Career Compatibility Engine -- public entry point. Assembles the three pure
// engines (Eligibility, Compatibility, Confidence) into one record per job.
// Zero I/O, zero LLM calls -- safe to run synchronously for every job in a
// search's results.

import { evaluateEligibility } from "./eligibility.js";
import { computeCompatibility } from "./compatibility.js";
import { computeConfidence } from "./confidence.js";
import { SCORING_CONFIGS, CURRENT_SCORING_VERSION } from "./scoringConfig.js";

export { evaluateEligibility, DEFAULT_GATES } from "./eligibility.js";
export { computeCompatibility } from "./compatibility.js";
export { computeConfidence } from "./confidence.js";
export { extractSkillKeywords, normalizeSkill, normalizeSkillSet, SKILL_KEYWORDS } from "./skills.js";
export { scoringConfigV1, SCORING_CONFIGS, CURRENT_SCORING_VERSION } from "./scoringConfig.js";

// Full explainable record: { match_score, weights_version, confidence, components,
// raw_components, gates, computed_at } -- the shape persisted to
// saved_jobs.compatibility_breakdown, and the shape job cards read match_score off of.
export function buildCompatibilityRecord(
  { job, profile, resumeSkills, skillDictionary } = {},
  config = SCORING_CONFIGS[CURRENT_SCORING_VERSION]
) {
  const eligibility = evaluateEligibility({ job, profile });
  const compatibility = computeCompatibility({ job, profile, resumeSkills, skillDictionary }, config);
  const { confidence } = computeConfidence(compatibility, config);

  return {
    match_score: compatibility.match_score,
    weights_version: compatibility.weights_version,
    confidence,
    components: compatibility.components,
    raw_components: compatibility.raw_components,
    gates: eligibility.gates,
    computed_at: new Date().toISOString(),
  };
}
