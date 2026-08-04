// Shared platform infrastructure -- server-side Job Discovery. Relocated from
// worker.js (2026-08-06) where it previously lived as private helpers used
// only by Proactive Job Alerts' scheduled cadences, even though it already
// had a second consumer (the interactive Job Search HTTP endpoint,
// `handleJobSearch`) all along -- this extraction formalizes what was already
// true, it does not change what's shared.
//
// Pre-extraction verification performed against every function moved here:
// no Proactive Job Alerts-only configuration, no Proactive Job Alerts state
// (no alert_candidates/alerts table reference anywhere below), no alert
// tier/urgency/confidence business rules (those remain entirely in
// src/lib/proactiveJobAlerts/discoveryEngine.js, untouched), no
// alert-specific filtering or scheduling assumption, no feature-specific
// side effects -- every function here is a pure fetch-and-normalize
// operation with no writes to any table. The one coupling found --
// `PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE` -- has been generalized to a plain
// parameter (see fetchFreshPostings) rather than moved in as a hidden
// Proactive-Job-Alerts assumption.
//
// Behavior-preserving relocation, same discipline as the parseResumeDoc
// extraction in LinkedIn Intelligence Phase 1 -- no logic change from the
// original worker.js versions, verified by diff.
//
// Ownership: this module owns job-source fetching, normalization, and
// deduplication for the platform. It owns no qualification, scoring,
// ranking, or feature-specific business logic of any kind -- those remain
// owned by the Career Compatibility Engine and by each consuming feature.

import { extractSkillKeywords } from "../compatibility/skills.js";

export const EMP_TYPE_MAP = {
  "Full-time": "full_time",
  "Part-time": "part_time",
  "Contract": "contract",
  "Internship": "internship",
  "Freelance": "contract",
  "Any": null,
};

export function normalizeAdzuna(job) {
  const isRemote =
    job.title?.toLowerCase().includes("remote") ||
    job.description?.toLowerCase().includes("remote") ||
    job.location?.area?.join(" ")?.toLowerCase().includes("remote") || false;
  return {
    id: `adzuna_${job.id}`,
    source: "Adzuna",
    title: job.title || "",
    company: job.company?.display_name || "Unknown Company",
    location: job.location?.display_name || "",
    description: job.description || "",
    salaryMin: job.salary_min || null,
    salaryMax: job.salary_max || null,
    employmentType: job.contract_time === "full_time" ? "Full-time" : job.contract_time === "part_time" ? "Part-time" : "Full-time",
    experienceLevel: "",
    remote: isRemote,
    applyUrl: job.redirect_url || "#",
    datePosted: job.created || null,
    skills: extractSkillKeywords(job.description || "", { limit: 8 }),
  };
}

export function normalizeRapid(job) {
  return {
    id: `rapid_${job.job_id}`,
    source: "JSearch",
    title: job.job_title || "",
    company: job.employer_name || "Unknown Company",
    location: job.job_city && job.job_state ? `${job.job_city}, ${job.job_state}` : job.job_country || "",
    description: job.job_description || "",
    salaryMin: job.job_min_salary || null,
    salaryMax: job.job_max_salary || null,
    employmentType: job.job_employment_type
      ? job.job_employment_type.charAt(0).toUpperCase() + job.job_employment_type.slice(1).toLowerCase()
      : "Full-time",
    experienceLevel: job.job_required_experience?.required_experience_in_months
      ? job.job_required_experience.required_experience_in_months >= 60 ? "Senior"
        : job.job_required_experience.required_experience_in_months >= 24 ? "Mid Level" : "Entry Level"
      : "",
    remote: job.job_is_remote || false,
    applyUrl: job.job_apply_link || job.job_google_link || "#",
    datePosted: job.job_posted_at_datetime_utc || null,
    skills: job.job_required_skills || extractSkillKeywords(job.job_description || "", { limit: 8 }),
  };
}

export function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = `${job.title?.toLowerCase().trim()}|${job.company?.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function fetchAdzuna(params, env, page = 1) {
  const { title, keywords, country, city, remote, employmentType, salaryMin } = params;
  // country is an ISO 3166-1 alpha-2 code (e.g. "US", "DE") or the "REMOTE"
  // sentinel — Adzuna's URL path segment already is the lowercased ISO code.
  const countryCode = (country && country !== "REMOTE") ? country.toLowerCase() : "us";
  const appId = env.ADZUNA_APP_ID;
  const appKey = env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    return { jobs: [], debug: { url: null, status: null, body: "Adzuna keys missing" } };
  }
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}`);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("what", title.trim());
  url.searchParams.set("results_per_page", "20");
  if (city && city.trim()) url.searchParams.set("where", city.trim());
  const whatAnd = [remote ? "remote" : null, keywords?.trim() || null].filter(Boolean).join(" ");
  if (whatAnd) url.searchParams.set("what_and", whatAnd);
  if (salaryMin && !isNaN(Number(salaryMin))) url.searchParams.set("salary_min", String(Math.floor(Number(salaryMin))));
  const empType = EMP_TYPE_MAP[employmentType];
  if (empType) url.searchParams.set("contract_time", empType);
  const debug = { url: url.toString().replace(appKey, "***").replace(appId, "***"), status: null, body: null };
  try {
    const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
    debug.status = res.status;
    const text = await res.text();
    debug.body = text.slice(0, 500);
    if (!res.ok) return { jobs: [], debug };
    const data = JSON.parse(text);
    const resultsArray = Array.isArray(data.results) ? data.results : [];
    return { jobs: resultsArray.map(normalizeAdzuna), debug };
  } catch (e) {
    debug.body = "EXCEPTION: " + e.message;
    return { jobs: [], debug };
  }
}

export async function fetchRapid(params, env, page = 1) {
  const { title, keywords, country, city, remote, employmentType, experienceLevel, salaryMin } = params;
  const rapidKey = env.RAPIDAPI_KEY;
  if (!rapidKey) {
    return { jobs: [], debug: { url: null, status: null, body: "RAPIDAPI_KEY missing" } };
  }
  let query = title;
  if (keywords && keywords.trim()) query += ` ${keywords.trim()}`;
  if (city) query += ` in ${city}`;
  // JSearch takes a natural-language query, which genuinely needs a country
  // NAME ("Germany"), not a code — the one legitimate third-party-API
  // exception to ISO codes end-to-end. Derived here rather than kept as a
  // second hardcoded table.
  else if (country && country !== "REMOTE") query += ` in ${new Intl.DisplayNames(["en"], { type: "region" }).of(country)}`;
  if (remote) query += " remote";
  const url = new URL("https://jsearch.p.rapidapi.com/search-v2");
  url.searchParams.set("query", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("num_pages", "1");
  url.searchParams.set("date_posted", "all");
  if (remote) url.searchParams.set("remote_jobs_only", "true");
  if (employmentType && employmentType !== "Any") {
    const typeMap = { "Full-time": "FULLTIME", "Part-time": "PARTTIME", "Contract": "CONTRACTOR", "Internship": "INTERN", "Freelance": "CONTRACTOR" };
    if (typeMap[employmentType]) url.searchParams.set("employment_types", typeMap[employmentType]);
  }
  if (experienceLevel && experienceLevel !== "Any") {
    const expMap = { "Entry Level": "no_experience,under_3_years_experience", "Mid Level": "more_than_3_years_experience", "Senior": "more_than_3_years_experience", "Lead": "more_than_3_years_experience", "Executive": "more_than_3_years_experience" };
    if (expMap[experienceLevel]) url.searchParams.set("job_requirements", expMap[experienceLevel]);
  }
  const debug = { url: url.toString(), status: null, body: null };
  try {
    const res = await fetch(url.toString(), { headers: { "X-RapidAPI-Key": rapidKey, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" } });
    debug.status = res.status;
    const responseText = await res.text();
    debug.body = responseText.slice(0, 500);
    if (!res.ok) return { jobs: [], debug };
    const data = JSON.parse(responseText);
    const jobsArray =
      Array.isArray(data.data?.jobs) ? data.data.jobs :
      Array.isArray(data.data) ? data.data :
      Array.isArray(data.jobs) ? data.jobs : [];
    let jobs = jobsArray.map(normalizeRapid);
    if (salaryMin && !isNaN(Number(salaryMin))) {
      const min = Number(salaryMin);
      jobs = jobs.filter(j => !j.salaryMin || j.salaryMin >= min);
    }
    return { jobs, debug };
  } catch (e) {
    debug.body = "EXCEPTION: " + e.message;
    return { jobs: [], debug };
  }
}

// Raw Adzuna/RapidAPI rows are already normalized to a consistent shape
// (title/company/skills/salaryMin/salaryMax/location/remote) by
// normalizeAdzuna/normalizeRapid above. Neither source supplies industry,
// companySizeEstimate, or a real closing date; those stay undefined, and
// every consumer already treats missing fields as "unavailable," not zero.
//
// `resultsPage` is a plain parameter (default 1), not an implicit
// per-feature assumption -- each consumer supplies its own value (or the
// default) rather than this function encoding any one feature's cadence.
// Deliberately does NOT deduplicate (unlike the interactive Job Search
// endpoint, which calls `deduplicate` itself) -- preserves each existing
// consumer's exact prior behavior; a consumer that wants deduplication
// applies it itself, same as before this extraction.
export async function fetchFreshPostings(profile, env, resultsPage = 1) {
  if (!profile.preferred_job_title) return [];
  const params = {
    title: profile.preferred_job_title,
    city: profile.location,
    remote: profile.work_type === "Remote",
    salaryMin: profile.desired_salary,
  };
  const [adzuna, rapid] = await Promise.all([
    fetchAdzuna(params, env, resultsPage),
    fetchRapid(params, env, resultsPage),
  ]);
  return [...adzuna.jobs, ...rapid.jobs];
}
