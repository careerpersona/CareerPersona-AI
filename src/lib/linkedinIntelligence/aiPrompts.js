// LinkedIn Intelligence -- Premium AI Analysis Layer. Pure prompt-building and
// response-parsing only (no askClaude import, directly Node-testable) -- same
// split as Proactive Job Alerts' aiPrompts.js and Referral Intelligence's
// buildReferralIntelligencePayload. The orchestration that actually calls
// askClaude lives in src/data/linkedinIntelligence.js.
//
// Two capabilities, one responsibility each, per the locked blueprint §4:
// - Profile Strategy Analysis: prioritizes the deterministic completeness/
//   keyword gaps into an action plan. Never re-scores them.
// - Recruiter Visibility Intelligence: qualitative visibility guidance from
//   the existing headline/About/keyword-coverage facts. Never invents a
//   score.
// Bundled into one askClaude call (same conditional-section-inclusion
// pattern as Referral Intelligence) since both fire at the same trigger
// point -- right after a Premium user generates/regenerates their profile.
//
// Profile Evolution Tracking is a separate, third capability with its own
// trigger point (viewing history, once 2+ analyses exist) -- its own call,
// per One Responsibility per AI Module.

// AI Intelligence Architecture Rule -- Data-Driven Availability. Both Premium
// capabilities require nothing more than "the deterministic scoring pass
// this row was inserted with already ran" -- per blueprint §7, never a
// usage-count or time-based gate.
export function isPremiumAnalysisAvailable({ completenessScore } = {}) {
  return completenessScore != null;
}

// Profile Evolution Tracking requires two persisted snapshots to diff against
// -- there is nothing to compare with only one.
export function isProfileEvolutionAvailable({ analysisCount } = {}) {
  return (analysisCount || 0) >= 2;
}

function fmtMissing(list) {
  return (list && list.length) ? list.join(", ") : "none";
}

// Returns null when neither section is available -- no AI call made at all,
// matching Proactive Job Alerts' "nothing to say, don't call the model" rule.
export function buildLinkedinPremiumPrompt({
  completenessBreakdown, keywordCoverageScore, keywordsMissing, headline, aboutSection, targetRole,
} = {}) {
  const available = isPremiumAnalysisAvailable({ completenessScore: completenessBreakdown ? 1 : null });
  if (!available) return null;

  const missingChecklist = Object.entries(completenessBreakdown || {})
    .filter(([, present]) => !present)
    .map(([key]) => key);

  const d1 = `Completeness checklist gaps: ${missingChecklist.length ? missingChecklist.join(", ") : "none -- profile is fully complete"}. Keyword coverage: ${keywordCoverageScore != null ? `${keywordCoverageScore}%` : "not evaluated (no target role/job description provided)"}. Missing keywords for the target role: ${fmtMissing(keywordsMissing)}.`;
  const d2 = `Current headline: ${headline || "(none generated yet)"}. Current About section: ${aboutSection ? aboutSection.slice(0, 400) : "(none generated yet)"}. Target role: ${targetRole || "(not specified)"}. Keyword coverage: ${keywordCoverageScore != null ? `${keywordCoverageScore}%` : "not evaluated"}.`;

  const SECTIONS = [
    {
      key: "strategyAnalysis", available: true,
      block: `=== ANALYSIS 1: PROFILE STRATEGY ===\nDATA: ${d1}\nTask: Of the gaps listed in DATA, decide which ONE or TWO matter most for this user's target role and explain why -- do not just repeat the list. Never invent a gap not present in DATA.`,
      schema: `"strategyAnalysis":{"priorityActions":["<action 1>","<action 2>"],"reasoning":"<2-3 sentences>"}`,
    },
    {
      key: "recruiterVisibilityIntelligence", available: true,
      block: `=== ANALYSIS 2: RECRUITER VISIBILITY ===\nDATA: ${d2}\nTask: Assess how discoverable and compelling this profile is to a recruiter searching for the target role, based only on the DATA above. Never invent a numeric score.`,
      schema: `"recruiterVisibilityIntelligence":{"guidance":["<tip 1>","<tip 2>"],"searchabilityNote":"<1-2 sentences>"}`,
    },
  ];

  const prompt = `You are CareerPersona AI — LinkedIn Intelligence Analyst. Generate ${SECTIONS.length} independent recommendations about a user's LinkedIn profile, based only on deterministic facts already computed in code.

CRITICAL RULES:
- Each analysis must derive exclusively from its own DATA block. Do NOT cross-reference other sections.
- Never invent a score, percentage, or fact not present in the DATA blocks -- your job is to prioritize, explain, and suggest, never to calculate.

${SECTIONS.map(s => s.block).join("\n\n")}

Return ONLY this JSON, no markdown:
{"v":1,"analyses":{${SECTIONS.map(s => s.schema).join(",")}}}`;

  return { prompt, sectionKeys: SECTIONS.map(s => s.key) };
}

export function parseLinkedinPremiumResponse(raw) {
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    return parsed?.v === 1 ? parsed.analyses : null;
  } catch { return null; }
}

// Profile Evolution Tracking -- the AI's only job is narrating why the
// already-computed deterministic diff (evolution, from
// deterministicScoring.js's computeProfileEvolution) likely changed and what
// to focus on next. It never recomputes the diff itself.
export function buildProfileEvolutionPrompt(evolution, targetRole) {
  if (!evolution || !evolution.hasSignal) return null;

  const parts = [];
  if (evolution.completenessDelta != null) {
    parts.push(`Profile completeness moved from ${evolution.previousCompletenessScore} to ${evolution.latestCompletenessScore} (${evolution.completenessDelta >= 0 ? "+" : ""}${evolution.completenessDelta}).`);
  }
  if (evolution.keywordCoverageDelta != null) {
    parts.push(`Keyword coverage for the target role moved from ${evolution.previousKeywordCoverageScore}% to ${evolution.latestKeywordCoverageScore}% (${evolution.keywordCoverageDelta >= 0 ? "+" : ""}${evolution.keywordCoverageDelta}%).`);
  }
  if (evolution.newlyResolved?.length) parts.push(`Keywords newly present since last analysis: ${evolution.newlyResolved.join(", ")}.`);
  if (evolution.stillMissing?.length) parts.push(`Keywords still missing: ${evolution.stillMissing.join(", ")}.`);

  const data = parts.join(" ");

  const prompt = `You are CareerPersona AI — LinkedIn Intelligence Analyst. Explain a change in this user's LinkedIn profile scores between two analyses, based only on the deterministic diff already computed in code.

CRITICAL RULES:
- The diff below is already computed and final -- never recompute it or state different numbers.
- Explain likely cause (e.g. resume update, added keywords) only in general terms; never claim certainty about what the user did.

DATA: ${data}
Target role: ${targetRole || "(not specified)"}

Return ONLY this JSON, no markdown:
{"v":1,"evolution":{"narrative":"<2-3 sentences on what changed>","focusNext":"<1 sentence on what to focus on next>"}}`;

  return { prompt };
}

export function parseProfileEvolutionResponse(raw) {
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    return parsed?.v === 1 ? parsed.evolution : null;
  } catch { return null; }
}

// Free-tier content generation -- the genuinely generative part of LinkedIn
// Optimizer, preserved per blueprint §3 ("What stays AI, and why"). Revised
// from the original inline App.jsx prompt to drop the three fields that
// moved to the deterministic engine (atsAlignmentScore, profileCompleteness)
// or to the interpretive Premium layer (headlineScore, topSkillsToAdd,
// keywordsToFeature -- keyword gaps are now computeKeywordCoverage's
// keywords_missing, never AI-improvised). The AI generates content; it no
// longer invents facts about that content.
export function buildFreeContentPrompt({ resume, linkedinProfile, jobDesc, contextString } = {}) {
  if (!resume || !resume.trim()) return null;
  const hasProfile = linkedinProfile && linkedinProfile.trim();
  return `${contextString ? contextString + "\n\n" : ""}You are a LinkedIn profile expert and personal branding coach. ${hasProfile ? "Analyze and optimize this LinkedIn profile." : "Generate LinkedIn profile content from this resume."} Return ONLY a JSON object, no markdown, no explanation:
{"headline":"<optimized LinkedIn headline max 120 chars>","aboutSection":"<optimized About section 200-250 words, first person, engaging, keyword-rich>","experienceOptimizations":[{"company":"<company name>","title":"<job title>","optimizedBullets":["<impactful bullet 1>","<impactful bullet 2>","<impactful bullet 3>"]}],"recruiterVisibilityTips":["<tip 1>","<tip 2>","<tip 3>"]}
RESUME:${resume}${hasProfile ? "\n\nCURRENT LINKEDIN PROFILE:\n" + linkedinProfile : ""}${jobDesc && jobDesc.trim() ? "\nTARGET JOB:\n" + jobDesc : ""}`;
}

export function parseFreeContentResponse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}
