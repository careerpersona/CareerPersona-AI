// Shared resume-text structural parser -- relocated from src/App.jsx (Phase 1
// of LinkedIn Intelligence) so it can be imported by both App.jsx (existing
// resume rendering) and src/lib/linkedinIntelligence/deterministicScoring.js
// (new) without creating a circular import between App.jsx and a lib module,
// the exact bug class documented in ADR-Referral-Intelligence.md's Evidence
// E.1. Pure relocation -- no logic change from the original App.jsx version.

import { isEmailPresent, isPhonePresent } from "./contactNormalization.js";

export const RESUME_SECTION_NAMES = new Set([
  'SUMMARY','PROFESSIONAL SUMMARY','CAREER SUMMARY','EXECUTIVE SUMMARY','OBJECTIVE',
  'CAREER OBJECTIVE','PROFESSIONAL OBJECTIVE','PROFILE','ABOUT','OVERVIEW','HIGHLIGHTS',
  'EXPERIENCE','WORK EXPERIENCE','PROFESSIONAL EXPERIENCE','EMPLOYMENT','EMPLOYMENT HISTORY',
  'WORK HISTORY','CAREER HISTORY','RELEVANT EXPERIENCE',
  'EDUCATION','ACADEMIC BACKGROUND','EDUCATIONAL BACKGROUND','ACADEMIC HISTORY',
  'SKILLS','TECHNICAL SKILLS','CORE COMPETENCIES','COMPETENCIES','KEY SKILLS','EXPERTISE',
  'CORE SKILLS','PROFESSIONAL SKILLS','TECHNOLOGIES','TECHNICAL EXPERTISE',
  'CERTIFICATIONS','CERTIFICATION','LICENSES','LICENSE','CREDENTIALS',
  'PROFESSIONAL CERTIFICATIONS','PROFESSIONAL DEVELOPMENT','TRAINING',
  'PROJECTS','KEY PROJECTS','PORTFOLIO','SELECTED PROJECTS','NOTABLE PROJECTS',
  'TECHNICAL PROJECTS','PERSONAL PROJECTS','OPEN SOURCE','OPEN SOURCE CONTRIBUTIONS',
  'ACHIEVEMENTS','ACCOMPLISHMENTS','AWARDS','HONORS','RECOGNITIONS','HONORS AND AWARDS',
  'PUBLICATIONS','RESEARCH','PAPERS','PRESENTATIONS','SPEAKING ENGAGEMENTS',
  'VOLUNTEER','VOLUNTEERING','VOLUNTEER EXPERIENCE','COMMUNITY SERVICE','CIVIC ACTIVITIES',
  'LANGUAGES','INTERESTS','HOBBIES','PERSONAL INTERESTS','ACTIVITIES','EXTRACURRICULAR',
  'ADDITIONAL','ADDITIONAL INFORMATION','OTHER','LEADERSHIP','LEADERSHIP EXPERIENCE',
  'PROFESSIONAL MEMBERSHIPS','MEMBERSHIPS','AFFILIATIONS','PROFESSIONAL AFFILIATIONS',
  'REFERENCES','PROFESSIONAL REFERENCES','CONFERENCES','PATENTS','CONSULTING',
  'FREELANCE','CONTRACT WORK','INDEPENDENT PROJECTS','MILITARY','MILITARY SERVICE',
  'MILITARY EXPERIENCE','INTERNSHIPS','INTERNSHIP EXPERIENCE','VOLUNTEER WORK',
]);

export function parseResumeDoc(rawText) {
  const result = { name: '', headerLines: [], sections: [] };
  if (!rawText) return result;

  // Flat-text normalization: if text has very few newlines (old PDF extraction produced
  // one long space-joined string per page), insert \n before every known section name
  // that is preceded by a lowercase character. This fixes existing stored Supabase data
  // without requiring re-upload.
  let text = rawText;
  const newlineCount = (text.match(/\n/g) || []).length;
  if (newlineCount < 3 && text.length > 80) {
    const names = Array.from(RESUME_SECTION_NAMES).sort((a, b) => b.length - a.length);
    for (const name of names) {
      const re = new RegExp('([a-z0-9.,;!?]) +(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?= )', 'g');
      text = text.replace(re, '$1\n$2\n');
    }
  }

  const isSec  = (t) => RESUME_SECTION_NAMES.has(t.trim().toUpperCase());
  const isBullet = (t) => /^[•\-*▪▸◦]\s/.test(t);
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length) { result.name = lines[i].trim(); i++; }

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (isSec(t)) break;
    const isContactLine = isEmailPresent(t) || isPhonePresent(t);
    result.headerLines.push({ text: t, type: isContactLine ? 'contact' : 'title' });
    i++;
  }

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (!isSec(t)) { i++; continue; }

    const section = { title: t.trim().toUpperCase(), items: [] };
    i++;
    let afterGap = true;

    while (i < lines.length) {
      const l = lines[i].trim();
      if (isSec(l)) break;
      if (!l) {
        if (section.items.length) section.items.push({ type: 'gap' });
        afterGap = true;
        i++;
        continue;
      }
      if (isBullet(l)) {
        section.items.push({ type: 'bullet', text: l.replace(/^[•\-*▪▸◦]\s*/, '').trim() });
        afterGap = false;
      } else {
        section.items.push({ type: afterGap ? 'roleHeader' : 'text', text: l });
        afterGap = false;
      }
      i++;
    }
    while (section.items.length && section.items[section.items.length - 1].type === 'gap') {
      section.items.pop();
    }
    result.sections.push(section);
  }

  return result;
}
