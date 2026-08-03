/**
 * verify-linkedin-intelligence-deterministic-unit.mjs — LinkedIn Intelligence
 * Phase 1+3 unit tests for the deterministic engine (deterministicScoring.js):
 * Profile Completeness, Keyword Coverage, and Profile Evolution (diff). Pure
 * logic, no dev server.
 *
 * Run: node scripts/verify/verify-linkedin-intelligence-deterministic-unit.mjs
 */
import { computeProfileCompleteness, computeKeywordCoverage, computeProfileEvolution } from "../../src/lib/linkedinIntelligence/deterministicScoring.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

const FULL_RESUME = `Jane Doe
Senior Product Manager
jane@email.com | (415) 555-0100

SUMMARY
Product leader with 8 years of experience shipping B2B SaaS products end to end, from discovery through GA, partnering closely with engineering and design.

EXPERIENCE
Acme Corp
Senior Product Manager (2020-Present)
• Led a cross-functional team of 12 to launch a new billing platform
• Grew activation rate by 24% through onboarding redesign
• Owned the roadmap for the analytics suite

EDUCATION
B.S. Computer Science, State University

SKILLS
Product Management, SQL, Figma, Roadmapping, A/B Testing, Agile
`;

const BARE_RESUME = `John Smith
john@email.com
`;

const NO_BULLETS_RESUME = `Sam Lee
sam@email.com

EXPERIENCE
Acme Corp
Software Engineer
Worked on the platform team.

SKILLS
JavaScript, React
`;

console.log("\n=== Profile Completeness ===");
{
  const r = computeProfileCompleteness({ resumeText: FULL_RESUME });
  check("Full resume: all 5 base checklist items present", r.completeness_score === 100);
  check("Full resume: breakdown marks headline present", r.completeness_breakdown.headline === true);
  check("Full resume: breakdown marks about present", r.completeness_breakdown.about === true);
  check("Full resume: breakdown marks experienceBullets present", r.completeness_breakdown.experienceBullets === true);
  check("Full resume: breakdown marks skills present", r.completeness_breakdown.skills === true);
  check("Full resume: breakdown marks education present", r.completeness_breakdown.education === true);
  check("Full resume: weights_version stamped", r.weights_version === "v1");
}
{
  const r = computeProfileCompleteness({ resumeText: BARE_RESUME });
  check("Bare resume (name + email only): low completeness score", r.completeness_score < 40);
  check("Bare resume: no About section detected", r.completeness_breakdown.about === false);
  check("Bare resume: no education detected", r.completeness_breakdown.education === false);
}
{
  const r = computeProfileCompleteness({ resumeText: NO_BULLETS_RESUME });
  check("Experience section with no bullets -> experienceBullets false", r.completeness_breakdown.experienceBullets === false);
  check("Skills present via inline SKILLS section", r.completeness_breakdown.skills === true);
}
{
  const withoutPasted = computeProfileCompleteness({ resumeText: FULL_RESUME });
  const withPasted = computeProfileCompleteness({ resumeText: FULL_RESUME, linkedinProfileText: "Senior PM | B2B SaaS\n\nI build products people love, with a track record of shipping platforms end to end for enterprise customers." });
  check("No pasted profile -> denominator excludes pasted-profile items (total_weight stays 5)", withoutPasted.total_weight === 5);
  check("Pasted profile provided -> denominator grows to include pasted-profile items (total_weight becomes 7)", withPasted.total_weight === 7);
  check("Pasted profile with real headline+about -> both pasted items scored present", withPasted.completeness_breakdown.pastedHeadline === true && withPasted.completeness_breakdown.pastedAbout === true);
}
{
  const r = computeProfileCompleteness({ resumeText: "" });
  check("Empty resume -> 0 score, not a crash", r.completeness_score === 0);
}

console.log("\n=== Keyword Coverage ===");
{
  const r = computeKeywordCoverage({ resumeText: FULL_RESUME, targetText: "Looking for a Product Manager with SQL, Figma, and Agile experience." });
  check("Resume covering all target skills -> 100% coverage", r.keyword_coverage_score === 100);
  check("Matched list contains the overlapping skills", r.keywords_matched.includes("SQL") && r.keywords_matched.includes("Figma") && r.keywords_matched.includes("Agile"));
  check("No missing skills when full coverage", r.keywords_missing.length === 0);
}
{
  const r = computeKeywordCoverage({ resumeText: FULL_RESUME, targetText: "Need someone strong in Kubernetes, Terraform, and Docker." });
  check("Resume with zero overlap -> 0% coverage, not null (target skills exist)", r.keyword_coverage_score === 0);
  check("Missing list contains the ungapped target skills", r.keywords_missing.length === 3);
}
{
  const r = computeKeywordCoverage({ resumeText: FULL_RESUME, targetText: "" });
  check("No target text -> unavailable (null), not a fabricated 0%", r.keyword_coverage_score === null);
}
{
  const r = computeKeywordCoverage({ resumeText: "", targetText: "SQL, Figma" });
  check("No resume text -> unavailable (null), not a fabricated 0%", r.keyword_coverage_score === null);
}
{
  const dict = { "product mgmt": "Product Management" };
  const r = computeKeywordCoverage({ resumeText: FULL_RESUME, targetText: "Seeking a Product Management leader.", skillDictionary: dict });
  check("Skill dictionary passthrough does not break matching for an already-canonical term", r.keyword_coverage_score === 100);
}

console.log("\n=== Profile Evolution (deterministic diff) ===");
{
  const r = computeProfileEvolution(null, null);
  check("Missing either snapshot -> no signal, not a crash", r.hasSignal === false);
}
{
  const latest = { completenessScore: 81, keywordCoverageScore: 60, keywordsMissing: ["Terraform"] };
  const previous = { completenessScore: 62, keywordCoverageScore: 40, keywordsMissing: ["Terraform", "Kubernetes"] };
  const r = computeProfileEvolution(latest, previous);
  check("Two real snapshots -> hasSignal true", r.hasSignal === true);
  check("Completeness delta computed correctly (81-62=19)", r.completenessDelta === 19);
  check("Keyword coverage delta computed correctly (60-40=20)", r.keywordCoverageDelta === 20);
  check("Newly resolved keyword identified (Kubernetes no longer missing)", r.newlyResolved.includes("Kubernetes") && !r.newlyResolved.includes("Terraform"));
  check("Still-missing keyword identified (Terraform)", r.stillMissing.includes("Terraform"));
}
{
  const latest = { completenessScore: 70, keywordCoverageScore: null, keywordsMissing: [] };
  const previous = { completenessScore: 70, keywordCoverageScore: null, keywordsMissing: [] };
  const r = computeProfileEvolution(latest, previous);
  check("No keyword coverage on either snapshot -> keywordCoverageDelta null, not fabricated 0", r.keywordCoverageDelta === null);
  check("Identical completeness scores -> delta 0, still a real signal", r.completenessDelta === 0 && r.hasSignal === true);
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
