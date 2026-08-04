/**
 * verify-smart-apply-auto-prep-phase3-unit.mjs — Smart Apply Auto Prep Phase 3
 * unit checks for the two newly-extracted shared modules
 * (src/lib/platform/jobDiscoveryService.js, src/lib/smartApply/generation.js).
 * Pure logic only, no dev server, no network.
 *
 * Run: node scripts/verify/verify-smart-apply-auto-prep-phase3-unit.mjs
 */
import { normalizeAdzuna, normalizeRapid, deduplicate } from "../../src/lib/platform/jobDiscoveryService.js";
import { buildIdentityBlock, buildSmartApplyPrompt, validateSmartApplyPackage, SMART_APPLY_DOC_FIELDS } from "../../src/lib/smartApply/generation.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

console.log("\n=== jobDiscoveryService: normalize + dedupe ===");
{
  const adzuna = normalizeAdzuna({ id: "1", title: "Software Engineer", company: { display_name: "Acme" }, location: { display_name: "Remote" }, description: "Remote role using React", redirect_url: "https://x", created: "2026-08-01" });
  check("normalizeAdzuna prefixes id with adzuna_", adzuna.id === "adzuna_1");
  check("normalizeAdzuna detects remote from description text", adzuna.remote === true);

  const rapid = normalizeRapid({ job_id: "2", job_title: "PM", employer_name: "Beta", job_city: "Austin", job_state: "TX", job_is_remote: false, job_description: "desc" });
  check("normalizeRapid prefixes id with rapid_", rapid.id === "rapid_2");
  check("normalizeRapid combines city/state", rapid.location === "Austin, TX");

  const deduped = deduplicate([
    { title: "Engineer", company: "Acme" },
    { title: "engineer", company: "acme" }, // case-insensitive duplicate
    { title: "Engineer", company: "Other" },
  ]);
  check("deduplicate collapses case-insensitive title+company duplicates", deduped.length === 2);
}

console.log("\n=== smartApply/generation: prompt + validation (§7 identical-to-manual functions) ===");
{
  const block = buildIdentityBlock({ full_name: "Jane Doe", email_address: "jane@x.com", phone: "555-0100" });
  check("buildIdentityBlock includes all three identity fields when present", block.includes("Jane Doe") && block.includes("jane@x.com") && block.includes("555-0100"));
  check("buildIdentityBlock omits missing fields cleanly", buildIdentityBlock({}) === "");

  const prompt = buildSmartApplyPrompt("", "RESUME TEXT", { title: "Engineer", company: "Acme", description: "Build things" }, { full_name: "Jane Doe" });
  check("buildSmartApplyPrompt embeds resume text and job fields", prompt.includes("RESUME TEXT") && prompt.includes("Engineer") && prompt.includes("Acme"));

  const okResult = { tailoredResume: "Jane Doe\n(415) 555-0100\njane@x.com\n...", coverLetter: "Dear Hiring Manager, ...", recruiterMessage: "Hi, ...", networkingMessage: "Hi, ..." };
  const okIntegrity = validateSmartApplyPackage(okResult, "US");
  check("validateSmartApplyPackage passes a clean package with contact info present", okIntegrity.ok === true);
  check("validateSmartApplyPackage covers all four primary document fields", SMART_APPLY_DOC_FIELDS.every(f => f in okIntegrity.documents));

  const placeholderResult = { ...okResult, coverLetter: "Dear [Recruiter Name], I am excited..." };
  const badIntegrity = validateSmartApplyPackage(placeholderResult, "US");
  check("validateSmartApplyPackage fails a package with an unresolved placeholder token", badIntegrity.ok === false && badIntegrity.documents.coverLetter.issues.includes("placeholder"));

  const noContactResult = { tailoredResume: "No contact info here at all.", coverLetter: "Dear Hiring Manager, ...", recruiterMessage: "Hi", networkingMessage: "Hi" };
  const noContactIntegrity = validateSmartApplyPackage(noContactResult, "US");
  check("validateSmartApplyPackage fails a resume missing required contact info", noContactIntegrity.ok === false && noContactIntegrity.documents.tailoredResume.issues.includes("missing_email"));
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
