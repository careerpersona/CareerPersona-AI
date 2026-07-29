import { parsePhoneNumberFromString, isValidPhoneNumber, getCountries } from "libphonenumber-js/min";

// ─────────────────────────────────────────────────────────────────────────
// Contact Normalization Service — the single source of truth for all
// personal contact information (name, phone, email, LinkedIn/GitHub/
// portfolio URLs, postal code) across CareerPersona AI, and the permanent
// field validation/normalization engine (FIELD_TYPES + validateFields)
// every editable structured field in the app registers with.
//
// Every module that captures, stores, displays, or scans for contact
// information MUST use this service. No module — Profile, Networking,
// Smart Apply, Resume Builder, Job Search, Interview, Premium, or any
// future module — may implement its own phone/email/name/URL/postal-code
// validation, normalization, or detection logic, and no module writes its
// own field-by-field validation chain: register the field's type(s) with
// FIELD_TYPES and call validateFields(). This is the permanent architecture
// standard for this project, not a convention scoped to one bug fix.
//
// Two families of exports:
//   - normalize* / is*Valid  — for structured fields (Profile, Networking):
//     silently fix formatting; validity only fails on genuinely
//     unparseable input. Empty is always valid — "required" is each
//     caller's own concern.
//   - is*Present             — free-text detectors (Smart Apply resume
//     scanning, parseResumeDoc, detectContactType): existence only, never
//     a formatting judgment.
//
// Phone and postal-code functions take an optional `country` (ISO 3166-1
// alpha-2, e.g. "US", "DE", "TR") for country-aware validation/formatting.
// The service never decides which country to use — see resolveCountry()
// below — and every function degrades gracefully when no country is known
// (e.g. existing users who haven't set one yet).
// ─────────────────────────────────────────────────────────────────────────

// ─── Generic safe text ──────────────────────────────────────────────────
// Trim + collapse internal whitespace ONLY. Never touches letter casing or
// punctuation — "McDonald", "O'Brien", "Senior UX/UI Designer" must pass
// through byte-for-byte beyond spacing. This is the one shared engine for
// every free-text field that has no format of its own to validate (name,
// location, job title, industry, ...) — see FIELD_TYPES.text below.
export function normalizeText(raw) {
  if (raw == null) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}

// Kept as its own export for existing call sites and for semantic clarity
// at the point of use — identical behavior to normalizeText.
export const normalizeFullName = normalizeText;

// ─── Email ──────────────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const EMAIL_FULL_RE = new RegExp(`^${EMAIL_RE.source}$`);

// Trims, lowercases, and removes whitespace that landed directly against an
// "@" or "." — e.g. "John.Doe @ Gmail . com" -> "john.doe@gmail.com". Never
// touches whitespace anywhere else in the string (e.g. a stray space inside
// the local part is left alone), so a genuinely broken address still fails
// isEmailValid and falls through to manual correction rather than being
// guessed at.
export function normalizeEmail(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase()
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".");
}

// Structured single-field check: empty is fine (presence is the caller's
// own "required" concern), otherwise the value must be a well-formed email.
export function isEmailValid(raw) {
  const v = normalizeEmail(raw);
  return v === "" || EMAIL_FULL_RE.test(v);
}

// Free-text detector: does any email address appear anywhere in this text?
export function isEmailPresent(text) {
  return !!text && EMAIL_RE.test(String(text));
}

// ─── Phone ──────────────────────────────────────────────────────────────
// Real per-country parsing/validation/formatting via libphonenumber-js
// (hand-rolling ~200 countries' numbering rules is not credible for an
// international platform). `country` is an ISO 3166-1 alpha-2 code; every
// function here degrades to a generic, permissive check when it's absent
// so a user with no home country set yet (e.g. pre-migration) never
// regresses to a previously-fine save being rejected.
function splitExtension(trimmed) {
  const extMatch = trimmed.match(/\s*(?:ext\.?|x|#)\s*(\d{1,6})\s*$/i);
  return { ext: extMatch ? extMatch[1] : "", base: extMatch ? trimmed.slice(0, extMatch.index) : trimmed };
}

// Generic digit-grouping fallback, used only when no country is known at
// all (so libphonenumber-js has no basis to parse a bare national-format
// number) — keeps pre-migration users' numbers formatting exactly as they
// did before country-aware validation existed, instead of suddenly being
// left raw.
function legacyFormat(base) {
  let digits = base.replace(/\D/g, "");
  if (!digits) return base.trim();
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length >= 8 && digits.length <= 15) return "+" + digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  return base.trim();
}

export function normalizePhone(raw, country) {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const { ext, base } = splitExtension(trimmed);

  const parsed = parsePhoneNumberFromString(base, country || undefined);
  let formatted;
  if (parsed && parsed.isValid()) {
    // International format if the input already carried a country code (or
    // belongs to a different country than the user's home country);
    // national format otherwise — mirrors "don't force a country code the
    // user doesn't need."
    const hasExplicitCountryMarker = /^\s*(\+|00)/.test(base);
    formatted = (hasExplicitCountryMarker || (country && parsed.country && parsed.country !== country))
      ? parsed.formatInternational()
      : parsed.formatNational();
  } else if (!country) {
    formatted = legacyFormat(base);
  } else {
    formatted = base.trim(); // country known but number incomplete/invalid — don't fabricate a format, isPhoneValid flags it
  }
  return ext ? `${formatted} ext. ${ext}` : formatted;
}

// Structured single-field check, mirrors isEmailValid: empty is fine,
// otherwise the number must be a genuinely complete number for `country`
// (fixes the reported gap where e.g. a 9-digit US number was accepted).
export function isPhoneValid(raw, country) {
  if (raw == null) return true;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  const { base } = splitExtension(trimmed);
  if (country) return isValidPhoneNumber(base, country) || isValidPhoneNumber(base);
  // No home country known yet — fall back to the permissive generic range
  // so we never regress a previously-fine save.
  const digits = base.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Free-text detector — finds a phone-shaped digit run anywhere in prose,
// bounded so it never matches a substring of a longer run (e.g. inside a
// longer ID number). When `country` is known, each candidate is confirmed
// with real per-country validation; otherwise falls back to the generic
// digit-count heuristic (unmarked 10-digit run, or 8-15 digits with a
// leading +/00 marker).
const PHONE_CANDIDATE_RE = /(?<!\d)(?:\+|00)?\d(?:[\d\s().-]{5,18})?\d(?!\d)/g;
function isPhoneLikeCandidate(candidate) {
  const hasCountryMarker = /^\s*(\+|00)/.test(candidate);
  const digits = candidate.replace(/\D/g, "");
  if (hasCountryMarker) return digits.length >= 8 && digits.length <= 15;
  return digits.length === 10;
}
export function isPhonePresent(text, country) {
  if (!text) return false;
  const candidates = String(text).match(PHONE_CANDIDATE_RE) || [];
  return candidates.some(c => country ? isPhoneValid(c, country) : isPhoneLikeCandidate(c));
}

// Finds phone-shaped candidates in a block of free text (e.g. a Smart
// Apply resume/cover letter document) and replaces only the ones that are
// genuinely valid with their normalized form, leaving everything else
// (dates, zip codes, surrounding prose) untouched. This is what keeps a
// freeform document editor's auto-correction behavior identical to a
// structured phone field's.
export function normalizePhonesInText(text, country) {
  if (!text) return text || "";
  return String(text).replace(PHONE_CANDIDATE_RE, (candidate) => {
    const valid = country ? isPhoneValid(candidate, country) : isPhoneLikeCandidate(candidate);
    return valid ? normalizePhone(candidate, country) : candidate;
  });
}

export { getCountries }; // ISO country list, powers country dropdowns

// ─── URLs (LinkedIn / GitHub / Portfolio) ──────────────────────────────
// Exported per the general service requirement; no UI field consumes this
// yet (Profile has no linkedin/github/portfolio columns today).
export function normalizeUrl(raw) {
  if (!raw) return "";
  let value = String(raw).trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "https://" + value.replace(/^\/+/, "");
  try {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.origin + url.pathname.replace(/\/+$/, "") + (url.search || "");
  } catch {
    return value; // not parseable even with a scheme added; no consumer today
  }
}

// ─── Postal code ────────────────────────────────────────────────────────
// Exported per the general service requirement; no UI field consumes this
// yet. Small built-in table for the countries this app's dropdowns already
// reference; a permissive length check covers everyone else rather than
// hand-maintaining all ~190 national formats.
const POSTAL_PATTERNS = {
  US: /^\d{5}(-\d{4})?$/, CA: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/, GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/,
  DE: /^\d{5}$/, TR: /^\d{5}$/, FR: /^\d{5}$/, NL: /^\d{4} ?[A-Za-z]{2}$/, AU: /^\d{4}$/,
};
export function isPostalCodeValid(raw, country) {
  const v = String(raw || "").trim();
  if (!v) return true;
  const pattern = POSTAL_PATTERNS[country];
  return pattern ? pattern.test(v) : v.length >= 2 && v.length <= 12; // generic fallback for uncovered countries
}

// Moved here from src/App.jsx (was a standalone function with its own
// inline regexes) — contact-type classification for a resume header line
// is contact-detection logic, so it belongs in the service. Reuses the
// same detectors as everything else, so there is exactly one phone/email
// pattern in the codebase.
export function detectContactType(text, country) {
  if (isEmailPresent(text)) return "email";
  if (isPhonePresent(text, country)) return "phone";
  if (/linkedin/i.test(text)) return "linkedin";
  if (/github/i.test(text)) return "github";
  if (/portfolio|website/i.test(text) || /^https?:\/\/|\.(io|dev|me|co|org|net|app|site)\b/i.test(text)) return "portfolio";
  return "location";
}

// ─── Country resolution ─────────────────────────────────────────────────
// Country is always an INPUT to this service, never something it sources
// itself. This is the one place that decides which candidate wins when
// more than one is available — callers list candidates most-specific-first
// (e.g. resolveCountry(jobDestinationCountry, userOverride, profile?.country)).
// Most call sites today only have one real candidate, but the precedence
// chain is real code, so adding a better signal later is a one-line change
// at the call site, never a change to this service.
export function resolveCountry(...candidates) {
  return candidates.find(c => !!c) || undefined;
}

// ─── Field registration engine ──────────────────────────────────────────
// The permanent "one central validation service." A field TYPE is just
// { normalize, validate }; registering a new structured field anywhere in
// the app (Certifications, Licenses, Recruiter contacts, References,
// future Premium/Smart Apply/Resume fields, ...) means adding one schema
// entry at the call site — never new validation logic on the page. A
// genuinely new field type (not covered below) is the only thing that
// would ever require a change to this file, and it's a single new entry.
export const FIELD_TYPES = {
  fullName: { normalize: (v) => normalizeFullName(v), validate: () => true },
  // Generic safe-text field: trims/collapses spacing only, no format to
  // validate. Use for any free-text field with no structure of its own
  // (location, job title, industry, ...) instead of writing a new type.
  text: { normalize: (v) => normalizeText(v), validate: () => true },
  email: { normalize: (v) => normalizeEmail(v), validate: (v) => isEmailValid(v) },
  phone: { normalize: (v, ctx) => normalizePhone(v, ctx?.country), validate: (v, ctx) => isPhoneValid(v, ctx?.country) },
  url: { normalize: (v) => normalizeUrl(v), validate: () => true },
  postalCode: { normalize: (v) => String(v || "").trim(), validate: (v, ctx) => isPostalCodeValid(v, ctx?.country) },
};

// schema: { formFieldName: fieldTypeKey }. ctx: passed to every type's
// normalize/validate (e.g. { country }). Returns { values, errors } —
// values has every field normalized (Rule 1, even the valid ones), errors
// has one entry per field that failed (Rule 2), keyed by type name so the
// caller maps it to its own existing i18n message.
export function validateFields(form, schema, ctx = {}) {
  const values = { ...form };
  const errors = {};
  for (const [field, typeKey] of Object.entries(schema)) {
    const type = FIELD_TYPES[typeKey];
    const clean = type.normalize(form[field], ctx);
    values[field] = clean;
    if (!type.validate(clean, ctx)) errors[field] = typeKey;
  }
  return { values, errors };
}
