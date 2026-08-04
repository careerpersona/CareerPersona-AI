// Shared platform infrastructure -- Smart Apply package generation (prompt)
// and Package Integrity Validation. Relocated from src/App.jsx (2026-08-06)
// where these were pure functions with no browser dependency, to make the
// locked blueprint's §7 guarantee literally true: Smart Apply Auto Prep
// (worker.js, server-side) and manual Smart Apply (App.jsx, client-side)
// call the exact same, unmodified functions -- not two implementations kept
// in sync by convention.
//
// Behavior-preserving relocation, same discipline as the parseResumeDoc and
// Job Discovery extractions -- no logic change from the original App.jsx
// versions, verified by diff.
//
// Ownership: this module owns Smart Apply's prompt construction and package
// validation only. It owns no persistence, no queue/status semantics, no AI
// call itself (askClaude / the Worker's direct Anthropic call stay with each
// caller) -- those remain owned by each consuming context, since a browser
// session (RLS + a session-local active-generation set) and a server cron
// invocation (service-role, no browser session) persist results through
// necessarily different code, even though the generation logic they call is
// identical.

import { parseResumeDoc } from "../resumeParsing.js";
import { isEmailPresent, isPhonePresent } from "../contactNormalization.js";

export const buildIdentityBlock = (profile) => [
  profile?.full_name ? `Name: ${profile.full_name}` : "",
  profile?.email_address ? `Email: ${profile.email_address}` : "",
  profile?.phone ? `Phone: ${profile.phone}` : "",
].filter(Boolean).join("\n");

export const buildSmartApplyPrompt = (ctx, resume, job, profile) => {
  const identityBlock = buildIdentityBlock(profile);
  return `${ctx ? ctx + "\n\n" : ""}You are an expert job application assistant. Given this candidate's identity, resume, and job, produce a complete application package. Return ONLY valid JSON, no markdown:
{"tailoredResume":"<resume rewritten and optimized for this specific job, full text>","coverLetter":"<professional 3 paragraph cover letter for this job>","recruiterMessage":"<short personalized LinkedIn message to a recruiter at this company, 2-3 sentences>","networkingMessage":"<short message to a potential referral contact at this company, 2-3 sentences>","missingSkills":["<skill1>","<skill2>","<skill3>"],"interviewProbability":<0-100>,"hiringProbability":<0-100>,"applicationQuestions":["<likely application question 1>","<likely application question 2>","<likely application question 3>"],"salaryInsight":{"marketRange":{"low":<annual USD>,"median":<annual USD>,"high":<annual USD>},"userPositioning":"<1 sentence: how candidate likely compares to market range>","negotiationLeverage":"<1 sentence: strongest leverage point for negotiation>","benchmarks":["<comparable role or location benchmark>"]},"companyInsight":{"culture":"<1-2 sentences on company culture and work environment>","recentNews":"<1-2 sentences on recent company news relevant to a job seeker>","hiringTrend":"<growing|stable|shrinking>","redFlags":["<potential concern about this role or company>"],"greenFlags":["<positive signal about this role or company>"],"talkingPoints":["<specific talking point to use in interviews or outreach>"]}}

CANDIDATE CONTACT INFO (use exactly as given for the resume header and cover letter signature — do not alter, guess, or add to it):
${identityBlock || "(not provided — omit a contact line for any field not listed above)"}

CONTACT INFO RULES:
- Only use contact details listed above, or details that already appear verbatim in the RESUME text below. Never invent, guess, or auto-generate a phone number, email address, LinkedIn URL, GitHub URL, portfolio URL, or personal website.
- If a contact detail (e.g. LinkedIn, GitHub, portfolio) is not present above and not present in the source resume text, omit that line entirely from the tailored resume header. A missing line is correct; a bracketed placeholder like "[LinkedIn]" or "[GitHub]" is never acceptable.

RECRUITER MESSAGE RULES:
- No specific recruiter name is known for this job. Do NOT invent a name and do NOT use a placeholder token like "[Recruiter Name]" or "[Name]".
- Use a professional generic greeting instead, such as "Dear Hiring Manager,".

NETWORKING MESSAGE RULES:
- No specific contact name is known. Do NOT invent one and do NOT use a placeholder token.
- Write a professional, generic networking introduction that references the company and role without addressing anyone by name.

COMPANY NAME FALLBACK:
- If the company name is known (see JOB below), use it naturally.
- If no company name is available, do not use a placeholder like "[Company Name]" — rewrite the sentence naturally without naming the company. For example, use "I am excited to apply for this opportunity." instead of "I am excited to join [Company Name]."

GENERAL RULE — applies to every field in the JSON: never output a bracketed placeholder token (e.g. "[Name]", "[Phone]", "[Email]", "[LinkedIn]", "[GitHub]", "[Portfolio]", "[Company Name]", "[Recruiter Name]"). If a detail is unknown, omit it rather than leaving a placeholder.

RESUME:
${resume}

JOB:
Title: ${job.title}
Company: ${job.company}${job.description ? `\nDescription: ${job.description.slice(0, 1200)}` : ""}`;
};

// Placeholder tokens the AI must never leave behind — bracket-enclosed spans like
// [Name], [Recruiter Name], [LinkedIn] indicate unresolved template content. Global
// flag is required: a field can contain more than one distinct unresolved token, and
// every one of them must be found, not just the first (see findSmartApplyPlaceholders).
const SMART_APPLY_PLACEHOLDER_RE = /\[[^\[\]]{1,40}\]/g;

// Required Contact Information is validated on the FINAL generated resume, never on the
// user's profile — a package passes as long as the resume itself contains a name, email,
// and phone number, regardless of whether that info came from the profile, an uploaded
// resume, or was carried over by the AI from source material. Detection is delegated
// entirely to the Contact Normalization Service (../contactNormalization) — Smart
// Apply never implements its own phone/email parsing, it only asks "is X present?".
const checkResumeContactInfo = (tailoredResume, country) => {
  const text = tailoredResume || "";
  const parsed = parseResumeDoc(text);
  return {
    hasFullName: !!parsed.name && parsed.name.trim().length > 0,
    hasEmail: isEmailPresent(text),
    hasPhone: isPhonePresent(text, country),
  };
};

// Recursively scans every string value anywhere in the generated package for placeholder
// tokens — not just the four primary documents — so missingSkills, applicationQuestions,
// salaryInsight, companyInsight, and any future generated field are covered automatically
// with no code change required when new fields are added.
const findSmartApplyPlaceholders = (value, path = "") => {
  const hits = [];
  if (typeof value === "string") {
    // .match() with the /g/ flag returns every distinct match in the string (not just
    // the first) — every one is pushed as its own hit so no unresolved token is ever
    // silently skipped, however many a single field happens to contain.
    const matches = value.match(SMART_APPLY_PLACEHOLDER_RE);
    if (matches) matches.forEach(token => hits.push({ path, token }));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findSmartApplyPlaceholders(v, path ? `${path}[${i}]` : `[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) hits.push(...findSmartApplyPlaceholders(v, path ? `${path}.${k}` : k));
  }
  return hits;
};

export const SMART_APPLY_DOC_FIELDS = ["tailoredResume", "coverLetter", "recruiterMessage", "networkingMessage"];

// Package Integrity Validation — the single gate for "ready" status and the source of
// truth for the per-document Needs Attention indicators in PackageView. Its scope is
// deliberately narrow: missing required information (contact info on the resume) and
// placeholder tokens, both of which the user can actually fix by editing. It does NOT
// check whether a document generated at all or how long it is — an empty or truncated
// document is an AI generation problem, not a package validation problem, and is handled
// upstream (askClaude/JSON-parse failure -> "failed" status) rather than here. Optional
// information (LinkedIn, GitHub, portfolio, recruiter/contact names, company name) is
// never checked here either — the prompt is responsible for omitting or falling back.
export const validateSmartApplyPackage = (result, country) => {
  const placeholderHits = findSmartApplyPlaceholders(result || {});
  const placeholderTokensByField = {};
  for (const h of placeholderHits) {
    const top = h.path.split(/[.[]/)[0];
    (placeholderTokensByField[top] ||= []).push(h.token);
  }

  const documents = {};
  for (const field of SMART_APPLY_DOC_FIELDS) {
    // Exact placeholder tokens found in this field's own text, exposed so the UI can
    // underline the specific offending span instead of showing a generic warning.
    // One "placeholder" issue per token (not capped at one) so the displayed issue
    // count always matches the true number of unresolved placeholders remaining.
    const placeholderTokens = placeholderTokensByField[field] || [];
    const issues = placeholderTokens.map(() => "placeholder");
    documents[field] = { ok: issues.length === 0, issues, placeholderTokens };
  }

  // Required Contact Information — checked directly on the resume text. An empty resume
  // naturally surfaces as all three fields missing, which is itself the correct "missing
  // required information" signal — no separate empty/failed-generation concept needed.
  const contact = checkResumeContactInfo(result?.tailoredResume, country);
  if (!contact.hasFullName) documents.tailoredResume.issues.push("missing_full_name");
  if (!contact.hasEmail) documents.tailoredResume.issues.push("missing_email");
  if (!contact.hasPhone) documents.tailoredResume.issues.push("missing_phone");
  documents.tailoredResume.ok = documents.tailoredResume.issues.length === 0;

  // Placeholders outside the four primary documents (e.g. inside salaryInsight or
  // companyInsight) still block Ready even though they have no dedicated document slot
  // in the review UI.
  const otherPlaceholders = placeholderHits.filter(h => !SMART_APPLY_DOC_FIELDS.includes(h.path.split(/[.[]/)[0]));

  const ok = Object.values(documents).every(d => d.ok) && otherPlaceholders.length === 0;
  return { ok, documents, otherPlaceholders };
};

// Flattens a Package Integrity Validation result into a short human-readable string —
// used for console logging only, not shown to the user (the UI reads .documents directly).
export const summarizeSmartApplyIntegrity = (integrity) => {
  const parts = Object.entries(integrity.documents)
    .filter(([, d]) => !d.ok)
    .map(([field, d]) => `${field}: ${d.issues.join(",")}`);
  if (integrity.otherPlaceholders.length) parts.push(`other placeholders: ${integrity.otherPlaceholders.map(h => h.path).join(",")}`);
  return parts.join("; ") || "ok";
};
