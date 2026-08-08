// Resume Completeness Check — deterministic, zero AI cost. Reuses the existing
// shared resume-text section parser (parseResumeDoc / RESUME_SECTION_NAMES) so
// this stays consistent with how the rest of the app already reads a resume's
// structure, rather than re-implementing section detection.
//
// Answers "what is present or missing from my resume" only. It does NOT score
// quality, does NOT call Claude, and must never be confused with the ATS score
// (a real Claude-generated Pro output) -- callers should never label this a
// "score."

import { parseResumeDoc } from "./resumeParsing";

const SUMMARY_SECTIONS = new Set([
  'SUMMARY', 'PROFESSIONAL SUMMARY', 'CAREER SUMMARY', 'EXECUTIVE SUMMARY', 'OBJECTIVE',
  'CAREER OBJECTIVE', 'PROFESSIONAL OBJECTIVE', 'PROFILE', 'ABOUT', 'OVERVIEW',
]);
const EXPERIENCE_SECTIONS = new Set([
  'EXPERIENCE', 'WORK EXPERIENCE', 'PROFESSIONAL EXPERIENCE', 'EMPLOYMENT',
  'EMPLOYMENT HISTORY', 'WORK HISTORY', 'CAREER HISTORY', 'RELEVANT EXPERIENCE',
]);
const EDUCATION_SECTIONS = new Set([
  'EDUCATION', 'ACADEMIC BACKGROUND', 'EDUCATIONAL BACKGROUND', 'ACADEMIC HISTORY',
]);
const SKILLS_SECTIONS = new Set([
  'SKILLS', 'TECHNICAL SKILLS', 'CORE COMPETENCIES', 'COMPETENCIES', 'KEY SKILLS',
  'EXPERTISE', 'CORE SKILLS', 'PROFESSIONAL SKILLS', 'TECHNOLOGIES', 'TECHNICAL EXPERTISE',
]);

const MIN_LENGTH = 200; // characters -- below this, treat as too sparse to assess structurally

// Returns null when there's nothing to assess yet (no resume text) -- callers
// should not render the check in that state.
export function computeResumeCompleteness(resumeText) {
  if (!resumeText || !resumeText.trim()) return null;

  const parsed = parseResumeDoc(resumeText);
  const titles = new Set(parsed.sections.map(s => s.title));
  const hasAny = (names) => [...names].some(n => titles.has(n));

  const checks = {
    contact: parsed.headerLines.some(h => h.type === 'contact'),
    summary: hasAny(SUMMARY_SECTIONS),
    experience: hasAny(EXPERIENCE_SECTIONS),
    education: hasAny(EDUCATION_SECTIONS),
    skills: hasAny(SKILLS_SECTIONS),
    lengthOk: resumeText.trim().length >= MIN_LENGTH,
  };

  const passedCount = Object.values(checks).filter(Boolean).length;
  const totalCount = Object.keys(checks).length;

  return { checks, passedCount, totalCount };
}
