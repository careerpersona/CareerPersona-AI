// LinkedIn Intelligence -- deterministic scoring engine. Pure functions only,
// same discipline as discoveryEngine.js / patternEngine.js / scoringEngine.js
// / compatibility.js -- no Supabase, no AI calls.
//
// Per the locked blueprint (docs/LinkedIn Intelligence Blueprint.md §3):
// replaces the two AI-invented scores (profileCompleteness, atsAlignmentScore)
// that have an objective basis. Headline quality and recruiter-visibility
// guidance stay AI-driven (§4) -- there is no deterministic alternative for
// genuinely subjective judgment, which is the correct application of the AI
// Justification Rule, not an exception to it.
//
// Ownership: this module owns Profile Completeness and Keyword Coverage
// computation. It does NOT own skill extraction or normalization -- those
// remain permanently owned by the Career Compatibility Engine
// (src/lib/compatibility/skills.js), imported here and never reimplemented.

import { parseResumeDoc } from "../resumeParsing.js";
import { extractSkillKeywords, normalizeSkillSet } from "../compatibility/skills.js";
import { LINKEDIN_SCORING_CONFIGS, CURRENT_LINKEDIN_SCORING_VERSION } from "./scoringConfig.js";

const SUMMARY_SECTION_TITLES = new Set([
  "SUMMARY", "PROFESSIONAL SUMMARY", "CAREER SUMMARY", "EXECUTIVE SUMMARY", "OBJECTIVE",
  "CAREER OBJECTIVE", "PROFESSIONAL OBJECTIVE", "PROFILE", "ABOUT", "OVERVIEW", "HIGHLIGHTS",
]);
const EXPERIENCE_SECTION_TITLES = new Set([
  "EXPERIENCE", "WORK EXPERIENCE", "PROFESSIONAL EXPERIENCE", "EMPLOYMENT", "EMPLOYMENT HISTORY",
  "WORK HISTORY", "CAREER HISTORY", "RELEVANT EXPERIENCE",
]);
const EDUCATION_SECTION_TITLES = new Set(["EDUCATION", "ACADEMIC BACKGROUND", "EDUCATIONAL BACKGROUND", "ACADEMIC HISTORY"]);
const SKILLS_SECTION_TITLES = new Set([
  "SKILLS", "TECHNICAL SKILLS", "CORE COMPETENCIES", "COMPETENCIES", "KEY SKILLS", "EXPERTISE",
  "CORE SKILLS", "PROFESSIONAL SKILLS", "TECHNOLOGIES", "TECHNICAL EXPERTISE",
]);

// Minimum combined text length for a Summary/About-type section to count as
// genuinely present -- a bare section header with no real content underneath
// is not "about section present," matching the blueprint's "above a minimum
// length" requirement.
const MIN_ABOUT_LENGTH = 40;

function sectionsByTitleGroup(parsed, titleGroup) {
  return (parsed.sections || []).filter(s => titleGroup.has(s.title));
}

function sectionTextLength(section) {
  return (section.items || []).reduce((sum, item) => sum + (item.text ? item.text.length : 0), 0);
}

function hasHeadline(parsed) {
  return (parsed.headerLines || []).some(l => l.type === "title" && l.text && l.text.trim().length >= 3);
}

function hasAbout(parsed) {
  return sectionsByTitleGroup(parsed, SUMMARY_SECTION_TITLES).some(s => sectionTextLength(s) >= MIN_ABOUT_LENGTH);
}

function hasExperienceBullets(parsed) {
  return sectionsByTitleGroup(parsed, EXPERIENCE_SECTION_TITLES).some(s => (s.items || []).some(i => i.type === "bullet"));
}

function hasSkills(parsed, resumeText) {
  const explicitSection = sectionsByTitleGroup(parsed, SKILLS_SECTION_TITLES).some(s => (s.items || []).length > 0);
  if (explicitSection) return true;
  // Fallback: some resumes list technologies inline without a dedicated
  // Skills header -- extractSkillKeywords still finds them.
  return extractSkillKeywords(resumeText).length > 0;
}

function hasEducation(parsed) {
  return sectionsByTitleGroup(parsed, EDUCATION_SECTION_TITLES).some(s => (s.items || []).length > 0);
}

// Same headline/about presence checks, applied to a pasted LinkedIn profile's
// raw text -- reuses parseResumeDoc rather than a second parser, since a
// pasted LinkedIn profile is unstructured text with the same shape problem
// (does it have a headline, does it have real About content) as a resume.
function hasPastedHeadline(linkedinProfileText) {
  const parsed = parseResumeDoc(linkedinProfileText);
  return hasHeadline(parsed) || (parsed.name && parsed.name.trim().length >= 3);
}
function hasPastedAbout(linkedinProfileText) {
  return String(linkedinProfileText || "").trim().length >= MIN_ABOUT_LENGTH;
}

// Profile Completeness Score -- percentage of a checklist of profile/resume
// signals actually present. Items that cannot be evaluated from what was
// provided (e.g. no pasted LinkedIn profile, so the two pasted-profile items
// don't apply) are excluded from both the numerator and the denominator --
// real renormalization, never scored as a failing 0. Mirrors
// src/lib/compatibility/compatibility.js's available_weight/total_weight
// pattern exactly.
export function computeProfileCompleteness(
  { resumeText, linkedinProfileText } = {},
  config = LINKEDIN_SCORING_CONFIGS[CURRENT_LINKEDIN_SCORING_VERSION]
) {
  const parsed = parseResumeDoc(resumeText);
  const weights = config.completenessChecklist;

  const checks = {
    headline: hasHeadline(parsed),
    about: hasAbout(parsed),
    experienceBullets: hasExperienceBullets(parsed),
    skills: hasSkills(parsed, resumeText),
    education: hasEducation(parsed),
  };

  let availableWeight = 0;
  let totalWeight = 0;
  let earnedWeight = 0;
  const breakdown = {};

  for (const key of Object.keys(weights)) {
    const w = weights[key];
    totalWeight += w;
    availableWeight += w;
    breakdown[key] = checks[key];
    if (checks[key]) earnedWeight += w;
  }

  // Pasted-profile items only apply -- and only enter the denominator -- when
  // a LinkedIn profile was actually pasted. No pasted profile is not a
  // failing 0 on these two items; it is "not structurally possible to
  // evaluate," per the same principle as the Compatibility Engine's
  // unavailable-component handling.
  if (linkedinProfileText && linkedinProfileText.trim()) {
    const pastedChecks = {
      pastedHeadline: hasPastedHeadline(linkedinProfileText),
      pastedAbout: hasPastedAbout(linkedinProfileText),
    };
    for (const key of Object.keys(pastedChecks)) {
      totalWeight += 1;
      availableWeight += 1;
      breakdown[key] = pastedChecks[key];
      if (pastedChecks[key]) earnedWeight += 1;
    }
  }

  const completeness_score = availableWeight > 0 ? Math.round((100 * earnedWeight) / availableWeight) : 0;

  return {
    completeness_score,
    completeness_breakdown: breakdown,
    weights_version: config.version,
    available_weight: availableWeight,
    total_weight: totalWeight,
  };
}

// Keyword/Skill Coverage Score -- resume-extracted skills vs. target-extracted
// skills (target = job description text if provided, otherwise the user's
// stated target role/title -- the caller resolves which to pass). Same
// overlap-ratio shape as the Compatibility Engine's own Skills component
// (compatibility.js's scoreSkillsMatch), reusing extractSkillKeywords /
// normalizeSkillSet directly rather than a second implementation.
export function computeKeywordCoverage(
  { resumeText, targetText, skillDictionary } = {},
  config = LINKEDIN_SCORING_CONFIGS[CURRENT_LINKEDIN_SCORING_VERSION]
) {
  const resumeSkills = extractSkillKeywords(resumeText);
  const targetSkills = extractSkillKeywords(targetText);

  // No target to compare against, or nothing extractable from the resume --
  // unavailable, not a failing 0 (the "don't penalize for missing input"
  // principle applied identically to compatibility.js's scoreSkillsMatch).
  if (targetSkills.length === 0 || resumeSkills.length === 0) {
    return { keyword_coverage_score: null, keywords_matched: [], keywords_missing: [], weights_version: config.version };
  }

  const normTarget = normalizeSkillSet(targetSkills, skillDictionary);
  const normResume = normalizeSkillSet(resumeSkills, skillDictionary);
  if (normTarget.size === 0) {
    return { keyword_coverage_score: null, keywords_matched: [], keywords_missing: [], weights_version: config.version };
  }

  const matched = [];
  const missing = [];
  for (const skill of normTarget) {
    if (normResume.has(skill)) matched.push(skill);
    else missing.push(skill);
  }

  const keyword_coverage_score = Math.round((100 * matched.length) / normTarget.size);

  return {
    keyword_coverage_score,
    keywords_matched: matched,
    keywords_missing: missing,
    weights_version: config.version,
  };
}

// Profile Evolution Tracking (blueprint §4) -- the score-over-time diff
// between two already-persisted analyses. This IS deterministic (it's just
// arithmetic over two rows); only the narrative explaining *why* it likely
// changed and what to focus on next is AI's job (src/lib/linkedinIntelligence/aiPrompts.js).
// This function never recomputes either snapshot's scores -- it only compares
// the two as already persisted, preserving each row's historical accuracy to
// the formula version that produced it.
export function computeProfileEvolution(latest, previous) {
  if (!latest || !previous) return { hasSignal: false };

  const completenessDelta = (latest.completenessScore != null && previous.completenessScore != null)
    ? latest.completenessScore - previous.completenessScore
    : null;
  const keywordCoverageDelta = (latest.keywordCoverageScore != null && previous.keywordCoverageScore != null)
    ? latest.keywordCoverageScore - previous.keywordCoverageScore
    : null;

  const stillMissing = (latest.keywordsMissing || []).filter(k => (previous.keywordsMissing || []).includes(k));
  const newlyResolved = (previous.keywordsMissing || []).filter(k => !(latest.keywordsMissing || []).includes(k));

  return {
    hasSignal: completenessDelta != null || keywordCoverageDelta != null,
    completenessDelta,
    keywordCoverageDelta,
    stillMissing,
    newlyResolved,
    latestCompletenessScore: latest.completenessScore ?? null,
    previousCompletenessScore: previous.completenessScore ?? null,
    latestKeywordCoverageScore: latest.keywordCoverageScore ?? null,
    previousKeywordCoverageScore: previous.keywordCoverageScore ?? null,
  };
}
