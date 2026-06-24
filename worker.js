// ─── CareerPersona AI — Cloudflare Worker ───────────────────────────────────
// Routes:
//   POST /          → Claude AI proxy (unchanged)
//   POST /api/jobs  → Job search (Adzuna + RapidAPI, merged & deduped)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Country code mapping for Adzuna ──────────────────────────────────────────
const COUNTRY_MAP = {
  "United States": "us",
  "United Kingdom": "gb",
  "Canada": "ca",
  "Australia": "au",
  "Germany": "de",
  "France": "fr",
  "Netherlands": "nl",
  "Remote Worldwide": "us", // fallback to US, remote flag handles filter
};

// ── Employment type mapping for Adzuna ───────────────────────────────────────
const EMP_TYPE_MAP = {
  "Full-time": "full_time",
  "Part-time": "part_time",
  "Contract": "contract",
  "Internship": "internship",
  "Freelance": "contract",
  "Any": null,
};

// ── Normalize Adzuna job to unified format ───────────────────────────────────
function normalizeAdzuna(job) {
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
    skills: extractSkills(job.description || ""),
    matchScore: 70, // default, overridden by AI match
  };
}

// ── Normalize RapidAPI (JSearch) job to unified format ───────────────────────
function normalizeRapid(job) {
  return {
    id: `rapid_${job.job_id}`,
    source: "JSearch",
    title: job.job_title || "",
    company: job.employer_name || "Unknown Company",
    location: job.job_city && job.job_state
      ? `${job.job_city}, ${job.job_state}`
      : job.job_country || "",
    description: job.job_description || "",
    salaryMin: job.job_min_salary || null,
    salaryMax: job.job_max_salary || null,
    employmentType: job.job_employment_type
      ? job.job_employment_type.charAt(0).toUpperCase() + job.job_employment_type.slice(1).toLowerCase()
      : "Full-time",
    experienceLevel: job.job_required_experience?.required_experience_in_months
      ? job.job_required_experience.required_experience_in_months >= 60
        ? "Senior"
        : job.job_required_experience.required_experience_in_months >= 24
        ? "Mid Level"
        : "Entry Level"
      : "",
    remote: job.job_is_remote || false,
    applyUrl: job.job_apply_link || job.job_google_link || "#",
    datePosted: job.job_posted_at_datetime_utc || null,
    skills: job.job_required_skills || extractSkills(job.job_description || ""),
    matchScore: 70,
  };
}

// ── Extract skills from description text ─────────────────────────────────────
function extractSkills(text) {
  const SKILLS = [
    "JavaScript","TypeScript","React","Vue","Angular","Node.js","Python","Java",
    "Go","Rust","C++","C#","PHP","Ruby","Swift","Kotlin","SQL","PostgreSQL",
    "MySQL","MongoDB","Redis","AWS","Azure","GCP","Docker","Kubernetes","Git",
    "GraphQL","REST","API","CSS","HTML","Tailwind","Next.js","Express","Django",
    "FastAPI","Spring","Terraform","CI/CD","Linux","Agile","Scrum",
  ];
  const lower = text.toLowerCase();
  return SKILLS.filter(s => lower.includes(s.toLowerCase())).slice(0, 8);
}

// ── Deduplicate jobs by title+company ────────────────────────────────────────
function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = `${job.title?.toLowerCase().trim()}|${job.company?.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Fetch from Adzuna ─────────────────────────────────────────────────────────
async function fetchAdzuna(params, env, page = 1) {
  const { title, country, city, remote, employmentType, salaryMin } = params;
  const countryCode = COUNTRY_MAP[country] || "us";
  const appId = env.ADZUNA_APP_ID;
  const appKey = env.ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    console.log("Adzuna keys missing");
    return [];
  }

  const url = new URL(
    `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}`
  );
  url.searchParams.set("app_id", appId);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("what", title);
  url.searchParams.set("results_per_page", "20");
  url.searchParams.set("content-type", "application/json");

  if (city) url.searchParams.set("where", city);
  if (remote) url.searchParams.set("what_and", "remote");
  if (salaryMin) url.searchParams.set("salary_min", salaryMin);

  const empType = EMP_TYPE_MAP[employmentType];
  if (empType) url.searchParams.set("contract_time", empType);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.log("Adzuna error:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    return (data.results || []).map(normalizeAdzuna);
  } catch (e) {
    console.log("Adzuna fetch failed:", e.message);
    return [];
  }
}

// ── Fetch from RapidAPI JSearch ───────────────────────────────────────────────
async function fetchRapid(params, env, page = 1) {
  const { title, country, city, remote, employmentType, experienceLevel, salaryMin } = params;
  const rapidKey = env.RAPIDAPI_KEY;

  if (!rapidKey) {
    console.log("RapidAPI key missing");
    return [];
  }

  // Build query string
  let query = title;
  if (city) query += ` in ${city}`;
  else if (country && country !== "Remote Worldwide") query += ` in ${country}`;
  if (remote) query += " remote";

  const url = new URL("https://jsearch.p.rapidapi.com/search");
  url.searchParams.set("query", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("num_pages", "1");
  url.searchParams.set("date_posted", "all");

  if (remote) url.searchParams.set("remote_jobs_only", "true");

  // Employment type filter
  if (employmentType && employmentType !== "Any") {
    const typeMap = {
      "Full-time": "FULLTIME",
      "Part-time": "PARTTIME",
      "Contract": "CONTRACTOR",
      "Internship": "INTERN",
      "Freelance": "CONTRACTOR",
    };
    if (typeMap[employmentType]) {
      url.searchParams.set("employment_types", typeMap[employmentType]);
    }
  }

  // Experience level
  if (experienceLevel && experienceLevel !== "Any") {
    const expMap = {
      "Entry Level": "no_experience,under_3_years_experience",
      "Mid Level": "more_than_3_years_experience",
      "Senior": "more_than_3_years_experience",
      "Lead": "more_than_3_years_experience",
      "Executive": "more_than_3_years_experience",
    };
    if (expMap[experienceLevel]) {
      url.searchParams.set("job_requirements", expMap[experienceLevel]);
    }
  }

  try {
    const res = await fetch(url.toString(), {
      headers: {
        "X-RapidAPI-Key": rapidKey,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });
    if (!res.ok) {
      console.log("RapidAPI error:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    let jobs = (data.data || []).map(normalizeRapid);

    // Client-side salary filter (JSearch doesn't support server-side min salary)
    if (salaryMin) {
      const min = Number(salaryMin);
      jobs = jobs.filter(j => !j.salaryMin || j.salaryMin >= min);
    }

    return jobs;
  } catch (e) {
    console.log("RapidAPI fetch failed:", e.message);
    return [];
  }
}

// ── Main job search handler ───────────────────────────────────────────────────
async function handleJobSearch(request, env) {
  const params = await request.json();
  const page = params.page || 1;

  console.log("Job search params:", JSON.stringify(params));

  // Fetch from both sources in parallel
  const [adzunaJobs, rapidJobs] = await Promise.all([
    fetchAdzuna(params, env, page),
    fetchRapid(params, env, page),
  ]);

  console.log(`Adzuna: ${adzunaJobs.length} jobs, RapidAPI: ${rapidJobs.length} jobs`);

  // Merge and deduplicate
  const merged = deduplicate([...adzunaJobs, ...rapidJobs]);

  // Sort: remote first if filter active, then by date
  const sorted = merged.sort((a, b) => {
    if (params.remote && a.remote !== b.remote) return a.remote ? -1 : 1;
    const da = a.datePosted ? new Date(a.datePosted) : new Date(0);
    const db = b.datePosted ? new Date(b.datePosted) : new Date(0);
    return db - da;
  });

  return corsResponse({
    jobs: sorted,
    total: sorted.length,
    page,
    sources: {
      adzuna: adzunaJobs.length,
      rapidapi: rapidJobs.length,
    },
  });
}

// ── Claude AI proxy handler ───────────────────────────────────────────────────
async function handleClaude(request, env) {
  const b = await request.json();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(b),
  });
  const d = await r.json();
  return new Response(JSON.stringify(d), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Only handle POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Route: /api/jobs → job search
    if (path === "/api/jobs") {
      return handleJobSearch(request, env);
    }

    // Route: / or anything else → Claude proxy (existing behavior)
    return handleClaude(request, env);
  },
};
