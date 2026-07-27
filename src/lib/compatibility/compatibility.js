// Compatibility Engine -- computes Match % from structured data only, zero
// LLM calls. Pure function: accepts job/profile/resumeSkills and a scoring
// config, returns a structured breakdown. Never touches Supabase.
//
// v1 ships four components (Skills, Job Title, Salary, Location/Remote) --
// Education, Certifications, Industry, and Employment Type have no backing
// data anywhere in the app today and are intentionally absent from
// scoringConfig's weight table, not silently faked. When a component's raw
// score is unavailable (null), its weight is excluded from both the weighted
// sum and the denominator -- real renormalization, so missing data never
// drags the score down, per the "don't penalize an incomplete profile"
// requirement.

import { normalizeSkillSet } from "./skills.js";
import { SCORING_CONFIGS, CURRENT_SCORING_VERSION } from "./scoringConfig.js";

function tokenize(str) {
  return new Set(
    String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 2)
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return null;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? null : intersection / union;
}

function scoreSkillsMatch({ job, resumeSkills, skillDictionary }) {
  const jobSkills = job?.skills || [];
  // No resume uploaded yet (or resume has no extractable skills) -- treat as
  // unavailable, not a failing 0. Scoring it as 0 would actively drag the
  // score down for a signal the candidate simply hasn't provided, which is
  // exactly the "never artificially penalize for a missing resume" case the
  // architecture spec calls out explicitly.
  if (jobSkills.length === 0 || !resumeSkills || resumeSkills.length === 0) return null;
  const normJob = normalizeSkillSet(jobSkills, skillDictionary);
  const normResume = normalizeSkillSet(resumeSkills || [], skillDictionary);
  if (normJob.size === 0) return null;
  let matched = 0;
  for (const s of normJob) if (normResume.has(s)) matched++;
  return matched / normJob.size;
}

function scoreJobTitleMatch({ job, profile }) {
  if (!profile?.preferred_job_title?.trim()) return null;
  return jaccard(tokenize(profile.preferred_job_title), tokenize(job?.title));
}

function parseSalaryNumber(raw) {
  if (!raw) return null;
  // Reuses the same digit-stripping parse already used elsewhere in this app
  // (CareerProgressPage, App.jsx) for consistency -- shares its known "120k"
  // -> 120 limitation, which is pre-existing app behavior, not introduced here.
  const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function scoreSalaryMatch({ job, profile }) {
  const desired = parseSalaryNumber(profile?.desired_salary);
  const ceiling = job?.salaryMax ?? job?.salaryMin ?? null;
  if (desired == null || ceiling == null) return null;
  if (desired <= ceiling) return 1; // job pays at/above what the candidate wants -- never penalized
  return Math.max(0, Math.min(1, ceiling / desired)); // job pays less -- degrade smoothly, not a cliff
}

function scoreLocationMatch({ job, profile }) {
  if (job?.remote) return 1; // remote jobs are geographically compatible with everyone
  const profileLoc = profile?.location?.trim();
  const jobLoc = job?.location?.trim();
  if (!profileLoc || !jobLoc) return null;
  const a = tokenize(profileLoc);
  const b = tokenize(jobLoc);
  for (const t of a) if (b.has(t)) return 1;
  return 0; // deliberately coarse text-match heuristic -- no geodistance data exists anywhere in this app
}

const SCORERS = {
  skills: scoreSkillsMatch,
  jobTitle: scoreJobTitleMatch,
  salary: scoreSalaryMatch,
  location: scoreLocationMatch,
};

export function computeCompatibility(
  { job, profile, resumeSkills, skillDictionary } = {},
  config = SCORING_CONFIGS[CURRENT_SCORING_VERSION]
) {
  const raw_components = {};
  const components = {};
  let weightedSum = 0;
  let availableWeight = 0;
  let totalWeight = 0;

  for (const key of Object.keys(config.weights)) {
    const weight = config.weights[key];
    totalWeight += weight;
    const scorer = SCORERS[key];
    const raw = scorer ? scorer({ job, profile, resumeSkills, skillDictionary }) : null;
    raw_components[key] = raw;
    if (raw == null) {
      components[key] = null;
      continue;
    }
    const contribution = raw * weight;
    components[key] = contribution;
    weightedSum += contribution;
    availableWeight += weight;
  }

  const match_score = availableWeight > 0 ? Math.round((100 * weightedSum) / availableWeight) : 0;

  return {
    match_score,
    weights_version: config.version,
    components,
    raw_components,
    available_weight: availableWeight,
    total_weight: totalWeight,
  };
}
