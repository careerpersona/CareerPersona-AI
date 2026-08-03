/**
 * verify-linkedin-intelligence-ai-layer-unit.mjs — LinkedIn Intelligence
 * Phase 3 unit tests for the Premium AI Analysis Layer (aiPrompts.js): prompt
 * building, Data-Driven Availability predicates, and response parsing.
 * Pure logic (aiPrompts.js's pure half only -- does not call a live AI, no
 * dev server required).
 *
 * Run: node scripts/verify/verify-linkedin-intelligence-ai-layer-unit.mjs
 */
import {
  isPremiumAnalysisAvailable, isProfileEvolutionAvailable,
  buildLinkedinPremiumPrompt, parseLinkedinPremiumResponse,
  buildProfileEvolutionPrompt, parseProfileEvolutionResponse,
  buildFreeContentPrompt, parseFreeContentResponse,
} from "../../src/lib/linkedinIntelligence/aiPrompts.js";
import { computeProfileEvolution } from "../../src/lib/linkedinIntelligence/deterministicScoring.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

console.log("\n=== Data-Driven Availability ===");
{
  check("Premium analysis available once completeness score exists", isPremiumAnalysisAvailable({ completenessScore: 81 }) === true);
  check("Premium analysis NOT available with no completeness score (not yet computed)", isPremiumAnalysisAvailable({ completenessScore: null }) === false);
  check("Premium analysis NOT available with no args at all", isPremiumAnalysisAvailable() === false);
  check("Profile Evolution available at 2+ analyses", isProfileEvolutionAvailable({ analysisCount: 2 }) === true);
  check("Profile Evolution NOT available at 1 analysis (nothing to diff against)", isProfileEvolutionAvailable({ analysisCount: 1 }) === false);
  check("Profile Evolution NOT available at 0 analyses", isProfileEvolutionAvailable({ analysisCount: 0 }) === false);
}

console.log("\n=== Premium Analysis Prompt (Strategy + Recruiter Visibility) ===");
{
  const r = buildLinkedinPremiumPrompt({});
  check("No completeness breakdown at all -> prompt is null (nothing to analyze)", r === null);
}
{
  const r = buildLinkedinPremiumPrompt({
    completenessBreakdown: { headline: true, about: true, experienceBullets: false, skills: true, education: true },
    keywordCoverageScore: 60,
    keywordsMissing: ["Terraform", "Kubernetes"],
    headline: "Senior PM | B2B SaaS",
    aboutSection: "I build products people love.",
    targetRole: "Senior Product Manager",
  });
  check("Real deterministic facts -> prompt built", r !== null && typeof r.prompt === "string");
  check("Prompt includes the specific incomplete checklist item as a fact", r.prompt.includes("experienceBullets"));
  check("Prompt includes missing keywords as facts", r.prompt.includes("Terraform") && r.prompt.includes("Kubernetes"));
  check("Prompt explicitly forbids inventing facts", /never invent/i.test(r.prompt));
  check("JSON schema requests no numeric score field from the AI", !/"score"|<0-100>|<score>/i.test(r.prompt));
  check("Both section keys present", r.sectionKeys.includes("strategyAnalysis") && r.sectionKeys.includes("recruiterVisibilityIntelligence"));
}
{
  const parsed = parseLinkedinPremiumResponse('{"v":1,"analyses":{"strategyAnalysis":{"priorityActions":["Add bullets"],"reasoning":"x"},"recruiterVisibilityIntelligence":{"guidance":["y"],"searchabilityNote":"z"}}}');
  check("Parses valid response into analyses object", parsed?.strategyAnalysis?.priorityActions?.[0] === "Add bullets");
  check("Both sections present in parsed output", !!parsed.recruiterVisibilityIntelligence);
}
{
  check("Malformed JSON response parses to null, not a crash", parseLinkedinPremiumResponse("not json") === null);
  check("Wrong version number rejected", parseLinkedinPremiumResponse('{"v":2,"analyses":{}}') === null);
}

console.log("\n=== Profile Evolution Prompt ===");
{
  const noSignal = computeProfileEvolution(null, null);
  const r = buildProfileEvolutionPrompt(noSignal, "Senior PM");
  check("No signal (missing snapshots) -> prompt is null (no AI call made)", r === null);
}
{
  const evolution = computeProfileEvolution(
    { completenessScore: 81, keywordCoverageScore: 60, keywordsMissing: ["Terraform"] },
    { completenessScore: 62, keywordCoverageScore: 40, keywordsMissing: ["Terraform", "Kubernetes"] }
  );
  const r = buildProfileEvolutionPrompt(evolution, "Senior PM");
  check("Real diff -> prompt built", r !== null && typeof r.prompt === "string");
  check("Prompt states the exact deterministic delta numbers, not re-derived ones", r.prompt.includes("81") && r.prompt.includes("62") && r.prompt.includes("19"));
  check("Prompt forbids recomputing the diff", /never recompute/i.test(r.prompt));
  check("Newly resolved keyword surfaced as a fact", r.prompt.includes("Kubernetes"));
}
{
  const parsed = parseProfileEvolutionResponse('{"v":1,"evolution":{"narrative":"Your score improved.","focusNext":"Add Kubernetes."}}');
  check("Parses valid evolution response", parsed?.narrative === "Your score improved.");
}
{
  check("Malformed evolution response parses to null", parseProfileEvolutionResponse("{broken") === null);
}

console.log("\n=== Free-Tier Content Generation Prompt ===");
{
  const r = buildFreeContentPrompt({ resume: "" });
  check("No resume -> prompt is null (nothing to generate from)", r === null);
}
{
  const r = buildFreeContentPrompt({ resume: "Jane Doe\nSenior PM\n...", linkedinProfile: "", jobDesc: "" });
  check("Resume only -> prompt built", typeof r === "string" && r.length > 0);
  check("Free-tier schema does NOT request atsAlignmentScore (moved to deterministic engine)", !r.includes("atsAlignmentScore"));
  check("Free-tier schema does NOT request profileCompleteness (moved to deterministic engine)", !r.includes("profileCompleteness"));
  check("Free-tier schema does NOT request headlineScore (folded into Premium interpretation)", !r.includes("headlineScore"));
  check("Free-tier schema does NOT request topSkillsToAdd (moved to deterministic keyword coverage)", !r.includes("topSkillsToAdd"));
  check("Free-tier schema does NOT request keywordsToFeature (moved to deterministic keyword coverage)", !r.includes("keywordsToFeature"));
  check("Free-tier schema still requests genuinely generative fields", r.includes("headline") && r.includes("aboutSection") && r.includes("experienceOptimizations") && r.includes("recruiterVisibilityTips"));
}
{
  const parsed = parseFreeContentResponse('{"headline":"h","aboutSection":"a"}');
  check("Parses valid free-content response", parsed?.headline === "h");
  check("Malformed free-content response parses to null", parseFreeContentResponse("{bad") === null);
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
