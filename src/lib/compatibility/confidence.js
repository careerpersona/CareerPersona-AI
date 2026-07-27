// Confidence Engine -- how reliable a Match % is, based on how much of the
// scoring weight had real data available. Deliberately does NOT re-derive
// weight coverage itself; it takes the already-computed available_weight/
// total_weight pair from compatibility.js's computeCompatibility() output, so
// there is exactly one place in the codebase that knows what data was
// available for a given job/profile pair.

import { SCORING_CONFIGS, CURRENT_SCORING_VERSION } from "./scoringConfig.js";

export function computeConfidence(
  { available_weight, total_weight } = {},
  config = SCORING_CONFIGS[CURRENT_SCORING_VERSION]
) {
  const coverage = total_weight > 0 ? available_weight / total_weight : 0;
  const { high, medium } = config.confidenceThresholds;
  const confidence = coverage >= high ? "High" : coverage >= medium ? "Medium" : "Low";
  return { confidence, data_coverage: coverage };
}
