// ─────────────────────────────────────────────────────────────────────────
// Contact Normalization Service — the single source of truth for all
// personal contact information (name, phone, email, LinkedIn/GitHub/
// portfolio URLs) across CareerPersona AI.
//
// Every module that captures, stores, displays, or scans for contact
// information MUST use this service. No module — Profile, Networking,
// Smart Apply, Resume Builder, Job Search, Interview, Premium, or any
// future module — may implement its own phone/email/name/URL validation,
// normalization, or detection logic. This is the permanent architecture
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
// ─────────────────────────────────────────────────────────────────────────

// ─── Full Name ──────────────────────────────────────────────────────────
// Trim + collapse internal whitespace ONLY. Never touch letter casing —
// "McDonald", "O'Brien", "DeShawn", or a deliberate ALL-CAPS legal name
// must pass through byte-for-byte in casing.
export function normalizeFullName(raw) {
  if (raw == null) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}

// ─── Email ──────────────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const EMAIL_FULL_RE = new RegExp(`^${EMAIL_RE.source}$`);

export function normalizeEmail(raw) {
  if (raw == null) return "";
  return String(raw).trim().toLowerCase();
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
// normalizePhone canonicalizes a STRUCTURED field (Profile) to one display
// standard, so "5551234567", "555-123-4567", "(555)123-4567",
// "555 123 4567", and "+1 555 123 4567" all collapse to the same string.
export function normalizePhone(raw) {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  // Pull off an extension suffix first so it survives normalization
  // instead of being eaten as extra digits.
  const extMatch = trimmed.match(/\s*(?:ext\.?|x|#)\s*(\d{1,6})\s*$/i);
  const ext = extMatch ? extMatch[1] : "";
  const base = extMatch ? trimmed.slice(0, extMatch.index) : trimmed;

  let digits = base.replace(/\D/g, "");
  if (!digits) return trimmed; // nothing numeric at all — hand back untouched

  // A redundant NANP country code (11 digits starting with "1") is the
  // same number as the bare 10-digit form.
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);

  let formatted;
  if (digits.length === 10) {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (digits.length >= 8 && digits.length <= 15) {
    // Non-NANP international number: conservative generic "+cc grouped in
    // 3s" rendering rather than real per-country phone formatting.
    formatted = "+" + digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  } else {
    // Too short/long to be confident this is a phone number — leave the
    // trimmed original as-is; isPhoneValid is what flags this as invalid.
    formatted = trimmed;
  }
  return ext ? `${formatted} ext. ${ext}` : formatted;
}

// Structured single-field check, mirrors isEmailValid: empty is fine,
// otherwise the digit count must be in a plausible phone range.
export function isPhoneValid(raw) {
  if (raw == null) return true;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  const extMatch = trimmed.match(/\s*(?:ext\.?|x|#)\s*(\d{1,6})\s*$/i);
  const base = extMatch ? trimmed.slice(0, extMatch.index) : trimmed;
  const digits = base.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Free-text detector — finds a phone-shaped digit run anywhere in prose,
// bounded so it never matches a substring of a longer run (e.g. inside a
// longer ID number). Counts total digits rather than judging punctuation
// shape, so any grouping (or none at all) is recognized.
//
// The line drawn: an unmarked (no leading +/00) run must have exactly 10
// digits (a full NANP number, matching every format in the reported bug);
// a marked run (+cc or 00cc) needs 8-15 digits. This deliberately excludes
// unmarked 8-9 digit runs (e.g. a zip+4) and unmarked runs of 11+ digits
// (e.g. account/tracking numbers), at the accepted cost of an occasional
// false positive on a stray unlabeled 10-digit number elsewhere in a
// resume — a far smaller cost than the reported blocking bug.
const PHONE_CANDIDATE_RE = /(?<!\d)(?:\+|00)?\d(?:[\d\s().-]{5,18})?\d(?!\d)/g;
function isPhoneLikeCandidate(candidate) {
  const hasCountryMarker = /^\s*(\+|00)/.test(candidate);
  const digits = candidate.replace(/\D/g, "");
  if (hasCountryMarker) return digits.length >= 8 && digits.length <= 15;
  return digits.length === 10;
}
export function isPhonePresent(text) {
  if (!text) return false;
  const candidates = String(text).match(PHONE_CANDIDATE_RE) || [];
  return candidates.some(isPhoneLikeCandidate);
}

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

// Moved here from src/App.jsx (was a standalone function with its own
// inline regexes) — contact-type classification for a resume header line
// is contact-detection logic, so it belongs in the service. Reuses the
// same detectors as everything else, so there is exactly one phone/email
// pattern in the codebase.
export function detectContactType(text) {
  if (isEmailPresent(text)) return "email";
  if (isPhonePresent(text)) return "phone";
  if (/linkedin/i.test(text)) return "linkedin";
  if (/github/i.test(text)) return "github";
  if (/portfolio|website/i.test(text) || /^https?:\/\/|\.(io|dev|me|co|org|net|app|site)\b/i.test(text)) return "portfolio";
  return "location";
}
