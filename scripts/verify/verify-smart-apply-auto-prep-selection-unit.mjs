/**
 * verify-smart-apply-auto-prep-selection-unit.mjs — Smart Apply Auto Prep
 * Phase 2 unit tests for Qualification and Selection
 * (src/lib/smartApplyAutoPrep/selection.js). Pure logic, no dev server.
 *
 * Run: node scripts/verify/verify-smart-apply-auto-prep-selection-unit.mjs
 */
import { isJobQualifiedForAutoPrep, selectJobsForAutoPrep } from "../../src/lib/smartApplyAutoPrep/selection.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

function record({ matchScore = 80, confidence = "High", gatesPassed = true } = {}) {
  return {
    match_score: matchScore,
    confidence,
    gates: [{ id: "remote_onsite_requirement", passed: gatesPassed, reason: gatesPassed ? "" : "not remote" }],
  };
}

console.log("\n=== Qualification (closed input list: Match Score, Eligibility Gates, Confidence Tier) ===");
{
  check("High confidence + passing gates -> qualified", isJobQualifiedForAutoPrep(record({ confidence: "High", gatesPassed: true })) === true);
  check("Medium confidence -> NOT qualified (stricter than manual Smart Apply)", isJobQualifiedForAutoPrep(record({ confidence: "Medium", gatesPassed: true })) === false);
  check("Low confidence -> NOT qualified", isJobQualifiedForAutoPrep(record({ confidence: "Low", gatesPassed: true })) === false);
  check("High confidence but failing gate -> NOT qualified", isJobQualifiedForAutoPrep(record({ confidence: "High", gatesPassed: false })) === false);
  check("Missing record -> NOT qualified, not a crash", isJobQualifiedForAutoPrep(null) === false);
  check("Missing gates array -> NOT qualified, not a crash", isJobQualifiedForAutoPrep({ confidence: "High" }) === false);
}
{
  // A high match_score alone, with no gates/confidence backing it, must never qualify --
  // qualification is never influenced by match_score directly, only by gates+confidence.
  const r = { match_score: 99, confidence: "Medium", gates: [{ passed: true }] };
  check("High match_score does not override a non-High confidence tier", isJobQualifiedForAutoPrep(r) === false);
}

console.log("\n=== Selection (rank order only, no random, no FIFO) ===");
{
  const entries = [
    { job: { id: "a" }, compatibility: record({ matchScore: 70 }) },
    { job: { id: "b" }, compatibility: record({ matchScore: 95 }) },
    { job: { id: "c" }, compatibility: record({ matchScore: 82 }) },
  ];
  const selected = selectJobsForAutoPrep(entries, 10);
  check("Selection is sorted by match_score descending, not discovery order (FIFO)", selected.map(e => e.job.id).join(",") === "b,c,a");
}
{
  const entries = [
    { job: { id: "a" }, compatibility: record({ matchScore: 95 }) },
    { job: { id: "b" }, compatibility: record({ matchScore: 90 }) },
    { job: { id: "c" }, compatibility: record({ matchScore: 85 }) },
  ];
  const selected = selectJobsForAutoPrep(entries, 2);
  check("Budget limits selection to the top N by rank, not the first N discovered", selected.length === 2 && selected[0].job.id === "a" && selected[1].job.id === "b");
}
{
  const entries = [
    { job: { id: "a" }, compatibility: record({ matchScore: 90, confidence: "High" }) },
    { job: { id: "b" }, compatibility: record({ matchScore: 90, confidence: "Medium" }) }, // disqualified
  ];
  const selected = selectJobsForAutoPrep(entries, 10);
  check("Disqualified jobs are excluded from selection entirely, regardless of match_score", selected.length === 1 && selected[0].job.id === "a");
}
{
  const entries = [{ job: { id: "a" }, compatibility: record({ matchScore: 90 }) }];
  check("Zero budget -> empty selection, not an error", selectJobsForAutoPrep(entries, 0).length === 0);
  check("Negative/undefined budget -> empty selection, not a crash", selectJobsForAutoPrep(entries, undefined).length === 0);
}
{
  // Determinism check: run the same input twice, confirm identical order --
  // guards against any accidental reliance on unstable sort / randomness.
  const entries = [
    { job: { id: "x" }, compatibility: record({ matchScore: 80 }) },
    { job: { id: "y" }, compatibility: record({ matchScore: 80 }) },
    { job: { id: "z" }, compatibility: record({ matchScore: 80 }) },
  ];
  const run1 = selectJobsForAutoPrep(entries, 10).map(e => e.job.id).join(",");
  const run2 = selectJobsForAutoPrep(entries, 10).map(e => e.job.id).join(",");
  check("Equal match_scores produce a deterministic, reproducible tie-break order", run1 === run2 && run1 === "x,y,z");
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
