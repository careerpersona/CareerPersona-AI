// Shared skill-keyword extraction + normalization for the Career Compatibility
// Engine. Pure, dependency-free module -- imported by both the client (resume
// text) and the Cloudflare Worker (job descriptions), so the keyword list can
// never drift into two different copies.
//
// extractSkillKeywords keeps the original substring-match approach (no fuzzy
// matching, no stemming) -- this refactor relocates and broadens the list, it
// does not change the matching algorithm itself.

export const SKILL_KEYWORDS = [
  // Original engineering-focused list
  "JavaScript", "TypeScript", "React", "Vue", "Angular", "Node.js", "Python", "Java",
  "Go", "Rust", "C++", "C#", "PHP", "Ruby", "Swift", "Kotlin", "SQL", "PostgreSQL",
  "MySQL", "MongoDB", "Redis", "AWS", "Azure", "GCP", "Docker", "Kubernetes", "Git",
  "GraphQL", "REST", "API", "CSS", "HTML", "Tailwind", "Next.js", "Express", "Django",
  "FastAPI", "Spring", "Terraform", "CI/CD", "Linux", "Agile", "Scrum",
  // Broadened non-technical coverage -- Skills is the highest-weighted component,
  // so a purely SWE list makes the engine unusable for most job seekers. Static
  // content addition only, not a new algorithm.
  "Sales", "Marketing", "SEO", "Project Management", "Product Management",
  "Customer Service", "Account Management", "Business Development",
  "Accounting", "Bookkeeping", "Finance", "Financial Analysis", "Budgeting",
  "Human Resources", "Recruiting", "Onboarding", "Payroll",
  "Nursing", "Patient Care", "Healthcare", "Clinical",
  "Graphic Design", "UX Design", "UI Design", "Adobe Photoshop", "Figma",
  "Operations", "Logistics", "Supply Chain", "Inventory Management",
  "Data Analysis", "Excel", "PowerPoint", "Salesforce",
  "Content Writing", "Copywriting", "Social Media",
  "Teaching", "Curriculum Development", "Public Speaking",
  "Negotiation", "Leadership", "Team Management",
];

// text -> matched skill labels. `limit` caps the result (used for UI chip
// display, where the original 8-item cap still applies); omit it for scoring,
// where truncating would silently understate overlap.
export function extractSkillKeywords(text, { limit } = {}) {
  const lower = String(text || "").toLowerCase();
  const matches = SKILL_KEYWORDS.filter(s => lower.includes(s.toLowerCase()));
  return typeof limit === "number" ? matches.slice(0, limit) : matches;
}

// dictionary: plain { alias: canonical } object, e.g. { "react.js": "React" }.
// Falls back to the raw token when no entry exists (or dictionary is empty/not
// yet loaded), so callers degrade gracefully to today's plain-match behavior.
export function normalizeSkill(token, dictionary = {}) {
  const key = String(token || "").trim().toLowerCase();
  return dictionary[key] || token;
}

export function normalizeSkillSet(tokens, dictionary = {}) {
  return new Set((tokens || []).map(t => normalizeSkill(t, dictionary)));
}
