// ─── CareerPersona AI — Cloudflare Worker ────────────────────────────────────
// Blueprint #1 auth chain: JWT verify → KV lookup → Supabase fallback
//   → Layer 1 getCapabilities() → Layer 2 check_and_consume_quota → execute
//
// Routes (no auth):
//   GET  /health                       → health + connectivity check
//   POST /api/jobs                     → job search (Adzuna + JSearch, unchanged)
//
// Routes (JWT auth required):
//   POST /                             → Claude AI proxy + entitlement + quota
//   POST /api/trial/activate           → stamp trial_started_at on first login
//   POST /api/billing/checkout-session → create Stripe Checkout session
//   POST /api/billing/confirm-session  → optimistic upgrade after checkout
//   POST /api/billing/cancel           → set cancel_at_period_end (FTC)
//   POST /api/billing/resume           → clear cancel_at_period_end
//   POST /api/billing/portal-session   → Stripe Customer Portal session
//
// Routes (Stripe HMAC — no JWT):
//   POST /webhooks/stripe              → process billing events, invalidate KV

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5180",
  "https://careerpersonaai.com",
];

// KV TTL in seconds, keyed by subscription_status.
// More volatile states get shorter TTLs to pick up changes faster.
const KV_TTL = {
  trial_active:    900,   // 15 min — trial_ends_at matters
  trial_expired:   3600,  // 1 hr  — stable terminal state
  pro_active:      1800,  // 30 min
  pro_past_due:    300,   // 5 min  — needs fast resolution
  pro_cancelled:   3600,  // 1 hr  — wait for current_period_end
  premium_active:  1800,  // 30 min
  admin:           3600,  // 1 hr  — rarely changes
  no_subscription: 3600,  // 1 hr  — stable until trial activation
};
const CONFIG_KV_TTL = 3600; // platform_config values change rarely

// ─── CORS ─────────────────────────────────────────────────────────────────────

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
  const isLanDev = /^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(origin);
  if (ALLOWED_ORIGINS.includes(origin) || isLanDev) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function corsResponse(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) },
  });
}

// ─── JWKS CACHE ───────────────────────────────────────────────────────────────
// Supabase user JWTs use ES256 (ECDSA P-256 asymmetric). The JWKS endpoint
// provides the EC public key needed for verification. Cached in KV 1 hour —
// Supabase rotates keys rarely and announces rotation in advance.

const JWKS_KV_KEY = "supabase_jwks";
const JWKS_TTL = 3600;

async function getJWKS(env) {
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get(JWKS_KV_KEY, "json");
    if (cached) return cached;
  } catch (_) {}

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  if (!r.ok) throw new Error("jwks_fetch_failed");
  const jwks = await r.json();

  try {
    await env.SUBSCRIPTION_CACHE.put(JWKS_KV_KEY, JSON.stringify(jwks), {
      expirationTtl: JWKS_TTL,
    });
  } catch (_) {}

  return jwks;
}

// ─── JWT VERIFICATION ─────────────────────────────────────────────────────────
// Supports ES256 (Supabase user tokens, verified via JWKS) and HS256 (legacy,
// verified via SUPABASE_JWT_SECRET). Header alg field determines the path.
// JWT ECDSA signatures are P1363 format (r||s, 64 bytes) — matches crypto.subtle directly.

function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function verifyJWT(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token_format");
  const [hdr, pay, sig] = parts;
  const dec = new TextDecoder();

  const header  = JSON.parse(dec.decode(b64urlToBuffer(hdr)));
  const payload = JSON.parse(dec.decode(b64urlToBuffer(pay)));
  const signedData = new TextEncoder().encode(`${hdr}.${pay}`);
  const { alg, kid } = header;

  if (alg === "ES256") {
    const jwks = await getJWKS(env);
    const jwk = jwks.keys?.find(k => !kid || k.kid === kid);
    if (!jwk) throw new Error("jwk_not_found");
    const key = await crypto.subtle.importKey(
      "jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, b64urlToBuffer(sig), signedData
    );
    if (!valid) throw new Error("invalid_signature");
  } else if (alg === "HS256") {
    if (!env.SUPABASE_JWT_SECRET) throw new Error("hs256_secret_not_configured");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, b64urlToBuffer(sig), signedData);
    if (!valid) throw new Error("invalid_signature");
  } else {
    throw new Error("unsupported_algorithm");
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("token_expired");
  }
  return payload;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

async function requireAuth(request, env) {
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
  if (!token) return { ok: false, error: "unauthorized", status: 401 };
  try {
    const payload = await verifyJWT(token, env);
    const userId = payload.sub;
    if (!userId) return { ok: false, error: "unauthorized", status: 401 };
    return { ok: true, userId };
  } catch (_) {
    return { ok: false, error: "unauthorized", status: 401 };
  }
}

// ─── SUPABASE REST HELPERS ────────────────────────────────────────────────────
// All calls use service_role — bypasses RLS for billing writes.

function sbHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function supabaseGet(table, params, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`supabase_get_${r.status}`);
  return r.json();
}

async function supabasePatch(table, match, data, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: "PATCH",
    headers: { ...sbHeaders(env), "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`supabase_patch_${r.status}`);
  return r.json();
}

async function supabasePost(table, data, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(env), "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  const body = await r.text();
  if (!r.ok) {
    const err = Object.assign(new Error(`supabase_post_${r.status}`), { status: r.status, body });
    throw err;
  }
  return JSON.parse(body);
}

async function supabaseRPC(fn, args, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase_rpc_${r.status}`);
  return r.json();
}

// ─── KV SUBSCRIPTION CACHE ────────────────────────────────────────────────────
// Blueprint #1: try KV first, fall back to Supabase, cache result.
// Key pattern: sub:{userId}

async function getSubscription(userId, env) {
  // KV read wrapped in try-catch: if KV is unavailable, fall through to Supabase.
  // Blueprint #1: KV → Supabase fallback; both failing must deny authorization safely.
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get(`sub:${userId}`, "json");
    if (cached) return cached;
  } catch (_) { /* KV unavailable — fall through */ }

  const rows = await supabaseGet("profiles", {
    id: `eq.${userId}`,
    select: "subscription_status,trial_started_at,trial_ends_at,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,cancel_at_period_end,grace_period_ends_at",
  }, env);
  // If supabaseGet throws here, the error propagates to the top-level catch → 500,
  // which denies authorization safely (no entitlements granted without verification).
  const sub = rows?.[0] ?? { subscription_status: "no_subscription" };

  // KV write is best-effort: failure is non-fatal (next request will re-query Supabase).
  try {
    const ttl = KV_TTL[sub.subscription_status] ?? 900;
    await env.SUBSCRIPTION_CACHE.put(`sub:${userId}`, JSON.stringify(sub), { expirationTtl: ttl });
  } catch (_) { /* non-fatal */ }

  return sub;
}

async function invalidateSubscription(userId, env) {
  // Non-fatal: if KV is unavailable, the stale entry will expire via TTL.
  try {
    await env.SUBSCRIPTION_CACHE.delete(`sub:${userId}`);
  } catch (_) { /* non-fatal */ }
}

// ─── PLATFORM CONFIG CACHE ────────────────────────────────────────────────────

async function getConfig(env) {
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get("platform_config", "json");
    if (cached) return cached;
  } catch (_) { /* KV unavailable — fall through */ }

  const rows = await supabaseGet("platform_config", { select: "key,value" }, env);
  const config = Object.fromEntries((rows ?? []).map(r => [r.key, r.value]));

  try {
    await env.SUBSCRIPTION_CACHE.put("platform_config", JSON.stringify(config), { expirationTtl: CONFIG_KV_TTL });
  } catch (_) { /* non-fatal */ }

  return config;
}

// ─── ENTITLEMENT — LAYER 1 ───────────────────────────────────────────────────
// Pure function — no I/O. Computes capabilities from subscription state + config.
// Blueprint #1: getCapabilities(subscription, config) → capabilities object.

function getCapabilities(sub, config) {
  const status = sub.subscription_status ?? "no_subscription";
  const now = Date.now();
  const proLimits = {
    aiRequestLimit:       parseInt(config.pro_ai_requests_monthly ?? "500"),
    resumeAnalysisLimit:  Infinity,
    interviewSessionLimit: Infinity,
    salaryAnalysisLimit:  Infinity,
  };
  switch (status) {
    case "trial_active": {
      const ends = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : 0;
      if (ends <= now) {
        return { plan: "trial_expired", canUseAI: false, canUseJobs: true,
          aiRequestLimit: 0, resumeAnalysisLimit: 0, interviewSessionLimit: 0, salaryAnalysisLimit: 0 };
      }
      return {
        plan: "trial", canUseAI: true, canUseJobs: true,
        aiRequestLimit:       parseInt(config.trial_ai_requests ?? "10"),
        resumeAnalysisLimit:  parseInt(config.trial_resume_analyses ?? "3"),
        interviewSessionLimit: parseInt(config.trial_interview_sessions ?? "3"),
        salaryAnalysisLimit:  parseInt(config.trial_salary_analyses ?? "2"),
      };
    }
    case "trial_expired":
      return { plan: "trial_expired", canUseAI: false, canUseJobs: true,
        aiRequestLimit: 0, resumeAnalysisLimit: 0, interviewSessionLimit: 0, salaryAnalysisLimit: 0 };
    case "pro_active":
      return { plan: "pro", canUseAI: true, canUseJobs: true, ...proLimits };
    case "premium_active":
      return { plan: "premium", canUseAI: true, canUseJobs: true, ...proLimits };
    case "pro_past_due": {
      const grace = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
      const inGrace = grace > now;
      return {
        plan: "pro_past_due", canUseAI: inGrace, canUseJobs: true,
        aiRequestLimit:       inGrace ? proLimits.aiRequestLimit : 0,
        resumeAnalysisLimit:  inGrace ? Infinity : 0,
        interviewSessionLimit: inGrace ? Infinity : 0,
        salaryAnalysisLimit:  inGrace ? Infinity : 0,
      };
    }
    case "pro_cancelled": {
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
      const active = end > now;
      return {
        plan: "pro_cancelled", canUseAI: active, canUseJobs: true,
        aiRequestLimit:       active ? proLimits.aiRequestLimit : 0,
        resumeAnalysisLimit:  active ? Infinity : 0,
        interviewSessionLimit: active ? Infinity : 0,
        salaryAnalysisLimit:  active ? Infinity : 0,
      };
    }
    case "admin":
      return {
        plan: "admin", canUseAI: true, canUseJobs: true,
        aiRequestLimit: Infinity, resumeAnalysisLimit: Infinity,
        interviewSessionLimit: Infinity, salaryAnalysisLimit: Infinity,
      };
    default: // no_subscription
      return { plan: "none", canUseAI: false, canUseJobs: true,
        aiRequestLimit: 0, resumeAnalysisLimit: 0, interviewSessionLimit: 0, salaryAnalysisLimit: 0 };
  }
}

function getPeriodKey(sub) {
  const s = sub.subscription_status ?? "no_subscription";
  if (s === "trial_active" || s === "trial_expired" || s === "no_subscription") return "trial";
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getFeatureLimit(feature, caps) {
  switch (feature) {
    case "resume_analysis":  return caps.resumeAnalysisLimit;
    case "interview_prep":   return caps.interviewSessionLimit;
    case "salary_analysis":  return caps.salaryAnalysisLimit;
    default:                 return caps.aiRequestLimit;
  }
}

// ─── CANONICAL BILLING STATE ─────────────────────────────────────────────────
// Single source of truth. Frontend renders billing UI exclusively from this
// enum + the accompanying billing state object — no scattered sub-field checks.

function computeBillingState(sub) {
  const status = sub.subscription_status ?? "no_subscription";
  const cancelAtPeriodEnd = sub.cancel_at_period_end ?? false;
  const now = Date.now();
  const trialEnd  = sub.trial_ends_at        ? new Date(sub.trial_ends_at).getTime()        : 0;
  const periodEnd = sub.current_period_end   ? new Date(sub.current_period_end).getTime()   : 0;
  const graceEnd  = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
  switch (status) {
    case "trial_active":   return trialEnd > now ? "TRIAL" : "PRO_EXPIRED";
    case "trial_expired":  return "PRO_EXPIRED";
    case "pro_active":     return cancelAtPeriodEnd ? "PRO_CANCELING" : "PRO_ACTIVE";
    case "pro_past_due":   return graceEnd > now ? "PRO_PAST_DUE" : "PRO_EXPIRED";
    case "pro_cancelled":  return periodEnd > now ? "PRO_CANCELING" : "PRO_EXPIRED";
    case "premium_active": return cancelAtPeriodEnd ? "PREMIUM_CANCELING" : "PREMIUM_ACTIVE";
    case "admin":          return "ADMIN";
    default:               return "FREE";
  }
}

async function getUsage(userId, periodKey, env) {
  try {
    const rows = await supabaseGet("feature_usage", {
      user_id: `eq.${userId}`,
      period_key: `eq.${periodKey}`,
      select: "feature,usage_count",
    }, env);
    const map = {};
    for (const row of rows ?? []) map[row.feature] = row.usage_count;
    return map;
  } catch {
    return {};
  }
}

function computeQuotas(caps, usage) {
  const features = [
    { key: "ai_request",      limit: caps.aiRequestLimit },
    { key: "resume_analysis", limit: caps.resumeAnalysisLimit },
    { key: "interview_prep",  limit: caps.interviewSessionLimit },
    { key: "salary_analysis", limit: caps.salaryAnalysisLimit },
  ];
  const quotas = {};
  for (const { key, limit } of features) {
    const used = usage[key] ?? 0;
    const unlimited = limit === Infinity;
    quotas[key] = { used, limit: unlimited ? null : limit, remaining: unlimited ? null : Math.max(0, limit - used), unlimited };
  }
  return quotas;
}

const BILLING_STATE_PLAN = {
  FREE: "Free", TRIAL: "Free Trial",
  PRO_ACTIVE: "Pro", PRO_CANCELING: "Pro", PRO_PAST_DUE: "Pro", PRO_EXPIRED: "Pro",
  PREMIUM_ACTIVE: "Premium", PREMIUM_CANCELING: "Premium", ADMIN: "Admin",
};

// ─── STRIPE REST HELPERS ──────────────────────────────────────────────────────
// No SDK — native fetch() only. Stripe REST uses form-encoded bodies.

async function stripeRequest(method, path, body, env) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body && method !== "GET") opts.body = new URLSearchParams(body).toString();
  const r = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error?.message ?? "stripe_error"), { stripeCode: data.error?.code });
  return data;
}

// Blueprint #4: HMAC-SHA256 Stripe webhook signature verification.
// Rejects events older than 5 minutes to prevent replay attacks.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  for (const seg of sigHeader.split(",")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  if (!parts.t || !parts.v1) throw new Error("missing_sig_components");
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) throw new Error("timestamp_too_old");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${rawBody}`));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (computed !== parts.v1) throw new Error("invalid_webhook_signature");
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
// Fire-and-forget via ctx.waitUntil — does not block the AI response.

async function logAIRequest(userId, feature, period, tokensIn, tokensOut, env) {
  await supabasePost("ai_request_log", {
    user_id: userId, feature,
    model: "claude-sonnet-4-6",
    tokens_in: tokensIn ?? null,
    tokens_out: tokensOut ?? null,
    period_key: period,
  }, env);
}

// ─── JOB SEARCH (PRESERVED EXACTLY) ─────────────────────────────────────────
// POST /api/jobs — no auth, unchanged from pre-billing version.

const COUNTRY_MAP = {
  "United States": "us",
  "United Kingdom": "gb",
  "Canada": "ca",
  "Australia": "au",
  "Germany": "de",
  "France": "fr",
  "Netherlands": "nl",
  "Remote Worldwide": "us",
};

const EMP_TYPE_MAP = {
  "Full-time": "full_time",
  "Part-time": "part_time",
  "Contract": "contract",
  "Internship": "internship",
  "Freelance": "contract",
  "Any": null,
};

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
  };
}

function normalizeRapid(job) {
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
    skills: job.job_required_skills || extractSkills(job.job_description || ""),
  };
}

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

function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = `${job.title?.toLowerCase().trim()}|${job.company?.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchAdzuna(params, env, page = 1) {
  const { title, keywords, country, city, remote, employmentType, salaryMin } = params;
  const countryCode = COUNTRY_MAP[country] || "us";
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

async function fetchRapid(params, env, page = 1) {
  const { title, keywords, country, city, remote, employmentType, experienceLevel, salaryMin } = params;
  const rapidKey = env.RAPIDAPI_KEY;
  if (!rapidKey) {
    return { jobs: [], debug: { url: null, status: null, body: "RAPIDAPI_KEY missing" } };
  }
  let query = title;
  if (keywords && keywords.trim()) query += ` ${keywords.trim()}`;
  if (city) query += ` in ${city}`;
  else if (country && country !== "Remote Worldwide") query += ` in ${country}`;
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

async function handleJobSearch(request, env) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 200_000) return corsResponse(request, { error: "Request too large" }, 413);
  const params = await request.json();
  if (!params.title || typeof params.title !== "string" || !params.title.trim()) {
    return corsResponse(request, { error: "title is required" }, 400);
  }
  const safeParams = {
    ...params,
    title: params.title.slice(0, 200),
    keywords: typeof params.keywords === "string" ? params.keywords.slice(0, 200) : "",
    city: typeof params.city === "string" ? params.city.slice(0, 200) : "",
    page: Math.min(Math.max(parseInt(params.page, 10) || 1, 1), 20),
  };
  const page = safeParams.page;
  const [adzunaResult, rapidResult] = await Promise.all([
    fetchAdzuna(safeParams, env, page),
    fetchRapid(safeParams, env, page),
  ]);
  const merged = deduplicate([...(adzunaResult.jobs || []), ...(rapidResult.jobs || [])]);
  const sorted = merged.sort((a, b) => {
    if (params.remote && a.remote !== b.remote) return a.remote ? -1 : 1;
    const da = a.datePosted ? new Date(a.datePosted) : new Date(0);
    const db = b.datePosted ? new Date(b.datePosted) : new Date(0);
    return db - da;
  });
  return corsResponse(request, {
    jobs: sorted, total: sorted.length, page,
    sources: { adzuna: (adzunaResult.jobs || []).length, rapidapi: (rapidResult.jobs || []).length },
    _debug: { adzuna: adzunaResult.debug, rapidapi: rapidResult.debug },
  });
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────────────────────

async function handleHealth(request, env) {
  let dbOk = false;
  try {
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      const rows = await supabaseGet("platform_config", { select: "key", limit: "1" }, env);
      dbOk = Array.isArray(rows);
    }
  } catch (_) { /* connectivity failure — report in response */ }
  return corsResponse(request, {
    status: "ok",
    ts: new Date().toISOString(),
    db: !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ? "unconfigured" : dbOk ? "ok" : "error",
    kv: "ok",
  }, 200);
}

// Blueprint #3: trial activation — stamps trial_started_at on first verified login.
// Idempotent: returns current state if already activated.
async function handleTrialActivate(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;
  const rows = await supabaseGet("profiles", {
    id: `eq.${userId}`,
    select: "subscription_status,trial_started_at,trial_ends_at",
  }, env);
  const profile = rows?.[0];
  if (!profile) return corsResponse(request, { error: "user_not_found" }, 404);
  if (profile.trial_started_at) {
    return corsResponse(request, {
      activated: false,
      subscription_status: profile.subscription_status,
      trial_started_at: profile.trial_started_at,
      trial_ends_at: profile.trial_ends_at,
    });
  }
  const config = await getConfig(env);
  const trialDays = parseInt(config.trial_days ?? "7");
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + trialDays * 86400 * 1000);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    subscription_status: "trial_active",
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
  }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, {
    activated: true,
    subscription_status: "trial_active",
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
  });
}

// Blueprint #1 + #3: JWT auth → KV → Supabase → Layer 1 → Layer 2 → execute.
// `feature` field in body routes to the correct quota bucket; stripped before
// forwarding so Claude never sees it.
async function handleClaude(request, env, ctx) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 200_000) return corsResponse(request, { error: { message: "Request too large" } }, 413);

  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;

  const b = await request.json();
  const { feature = "ai_request", ...claudeBody } = b;

  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);

  // Layer 1: entitlement check
  if (!caps.canUseAI) {
    const s = sub.subscription_status;
    const error = s === "trial_expired" || s === "no_subscription" ? "trial_expired" : "not_entitled";
    return corsResponse(request, { error, upgradeRequired: true }, 403);
  }

  // Layer 2: quota check (skip for unlimited capabilities like admin)
  const limit = getFeatureLimit(feature, caps);
  const period = getPeriodKey(sub);
  if (limit !== Infinity) {
    const quota = await supabaseRPC("check_and_consume_quota", {
      p_user_id: userId,
      p_feature: feature,
      p_limit: limit,
      p_period: period,
    }, env);
    if (!quota.allowed) {
      return corsResponse(request, { error: "quota_exhausted", upgradeRequired: true }, 429);
    }
  }

  const model = "claude-sonnet-4-6";
  const max_tokens = Math.min(Number(claudeBody.max_tokens) || 1000, 8000);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...claudeBody, model, max_tokens }),
  });
  const d = await r.json();

  if (r.ok && ctx?.waitUntil) {
    ctx.waitUntil(logAIRequest(userId, feature, period, d.usage?.input_tokens, d.usage?.output_tokens, env));
  }

  return corsResponse(request, d, r.status);
}

// Blueprint #3: create Stripe Checkout session. Get-or-create Stripe customer,
// then create a subscription checkout. Returns { url } for frontend redirect.
async function handleCheckoutSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const config = await getConfig(env);
  const priceId = config.stripe_price_id_pro;
  if (!priceId) return corsResponse(request, { error: "stripe_price_not_configured" }, 503);
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  const profile = rows?.[0];
  if (!profile) return corsResponse(request, { error: "user_not_found" }, 404);
  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const userR = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const user = await userR.json();
    const customer = await stripeRequest("POST", "/customers", {
      email: user.email ?? "",
      "metadata[supabase_user_id]": userId,
    }, env);
    customerId = customer.id;
    await supabasePatch("profiles", { id: `eq.${userId}` }, { stripe_customer_id: customerId }, env);
    await invalidateSubscription(userId, env);
  }
  const appUrl = "https://careerpersonaai.com";
  const session = await stripeRequest("POST", "/checkout/sessions", {
    customer: customerId,
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${appUrl}/#pricing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/#pricing`,
    "subscription_data[metadata][supabase_user_id]": userId,
  }, env);
  return corsResponse(request, { url: session.url });
}

// Blueprint #3: optimistic upgrade — called by frontend after Stripe success redirect.
// Updates profiles immediately without waiting for the webhook, so UI feels instant.
async function handleConfirmSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const { session_id } = await request.json();
  if (!session_id) return corsResponse(request, { error: "missing_session_id" }, 400);
  const session = await stripeRequest("GET", `/checkout/sessions/${session_id}`, null, env);
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  if (session.customer !== rows?.[0]?.stripe_customer_id) {
    return corsResponse(request, { error: "session_not_owned" }, 403);
  }
  if (session.payment_status !== "paid") {
    return corsResponse(request, { success: false, status: session.status, payment_status: session.payment_status });
  }
  const stripeSub = await stripeRequest("GET", `/subscriptions/${session.subscription}`, null, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    subscription_status: "pro_active",
    stripe_subscription_id: stripeSub.id,
    current_period_start: new Date(stripeSub.current_period_start * 1000).toISOString(),
    current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: stripeSub.cancel_at_period_end,
  }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, { success: true, subscription_status: "pro_active" });
}

// Blueprint #3 + FTC compliance: cancel at period end — never immediate.
async function handleCancelSubscription(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return corsResponse(request, { error: "no_active_subscription" }, 400);
  await stripeRequest("POST", `/subscriptions/${subId}`, { cancel_at_period_end: "true" }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, { cancel_at_period_end: true }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, { success: true, cancel_at_period_end: true });
}

async function handleResumeSubscription(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return corsResponse(request, { error: "no_active_subscription" }, 400);
  await stripeRequest("POST", `/subscriptions/${subId}`, { cancel_at_period_end: "false" }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, { cancel_at_period_end: false }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, { success: true, cancel_at_period_end: false });
}

async function handlePortalSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  const customerId = rows?.[0]?.stripe_customer_id;
  if (!customerId) return corsResponse(request, { error: "no_stripe_customer" }, 400);
  const session = await stripeRequest("POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: "https://careerpersonaai.com/#settings",
  }, env);
  return corsResponse(request, { url: session.url });
}

// Blueprint #3 extension: single billing state endpoint — Worker is the sole
// source of truth for billing data. Returns canonical state + quotas so the
// frontend never queries billing-related Supabase tables directly.
async function handleBillingState(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;
  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  const periodKey = getPeriodKey(sub);
  const usage = await getUsage(userId, periodKey, env);
  const billingState = computeBillingState(sub);
  const now = Date.now();
  const trialEnd = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
  const daysRemaining = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - now) / 86400000)) : null;
  return corsResponse(request, {
    billingState,
    subscriptionStatus: sub.subscription_status ?? "no_subscription",
    planDisplayName: BILLING_STATE_PLAN[billingState] ?? "Free",
    canUseAI: caps.canUseAI,
    canUseJobs: caps.canUseJobs,
    trialEndsAt: sub.trial_ends_at ?? null,
    daysRemaining,
    periodEnd: sub.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    paymentMethodOnFile: !!sub.stripe_customer_id,
    quotas: computeQuotas(caps, usage),
  });
}

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Blueprint #4: HMAC verify → idempotency dedup → process → invalidate KV.
// Returns 200 to Stripe in all cases (after dedup) to prevent re-delivery.

async function processStripeEvent(event, env) {
  const { type, data } = event;
  const obj = data.object;
  const customerId = obj.customer;
  if (!customerId) return;
  const rows = await supabaseGet("profiles", { stripe_customer_id: `eq.${customerId}`, select: "id" }, env);
  const userId = rows?.[0]?.id;
  if (userId) {
    supabasePost("stripe_events", {
      stripe_event_id: event.id,
      event_type: type,
      user_id: userId,
      amount_cents: obj.amount_paid ?? obj.amount ?? null,
      currency: obj.currency ?? null,
      payload: event,
    }, env).catch(() => {});
  }
  if (!userId) return;
  switch (type) {
    case "invoice.paid": {
      const sub = await stripeRequest("GET", `/subscriptions/${obj.subscription}`, null, env);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: "pro_active",
        stripe_subscription_id: sub.id,
        current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
        grace_period_ends_at: null,
      }, env);
      break;
    }
    case "invoice.payment_failed": {
      const config = await getConfig(env);
      const graceDays = parseInt(config.grace_period_days ?? "14");
      const graceEnds = new Date(Date.now() + graceDays * 86400 * 1000).toISOString();
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: "pro_past_due",
        grace_period_ends_at: graceEnds,
      }, env);
      break;
    }
    case "customer.subscription.deleted":
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: "pro_cancelled",
        stripe_subscription_id: null,
      }, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        status: "canceled",
        canceled_at: obj.canceled_at ? new Date(obj.canceled_at * 1000).toISOString() : new Date().toISOString(),
        ended_at: obj.ended_at ? new Date(obj.ended_at * 1000).toISOString() : new Date().toISOString(),
      }, env).catch(() => {});
      break;
    case "customer.subscription.updated":
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        cancel_at_period_end: obj.cancel_at_period_end,
        current_period_start: new Date(obj.current_period_start * 1000).toISOString(),
        current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
      }, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        cancel_at_period_end: obj.cancel_at_period_end,
        current_period_start: new Date(obj.current_period_start * 1000).toISOString(),
        current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
        status: obj.status,
      }, env).catch(() => {});
      break;
  }
  await invalidateSubscription(userId, env);
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "webhook_not_configured" }), { status: 503 });
  }
  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature") ?? "";
  try {
    await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const event = JSON.parse(rawBody);
  // Idempotency: INSERT to webhook_dedup; 409 = already processed
  const dedupR = await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_dedup`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify({ stripe_event_id: event.id }),
  });
  if (dedupR.status === 409) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    await processStripeEvent(event, env);
  } catch (e) {
    console.error("webhook_processing_error", event.type, e.message);
  }
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getCorsHeaders(request) });
      }

      if (method === "GET" && path === "/health")             return handleHealth(request, env);
      if (method === "GET" && path === "/api/billing/state") return handleBillingState(request, env);

      if (method === "POST") {
        if (path === "/api/jobs")                    return handleJobSearch(request, env);
        if (path === "/api/trial/activate")          return handleTrialActivate(request, env);
        if (path === "/api/billing/checkout-session") return handleCheckoutSession(request, env);
        if (path === "/api/billing/confirm-session") return handleConfirmSession(request, env);
        if (path === "/api/billing/cancel")          return handleCancelSubscription(request, env);
        if (path === "/api/billing/resume")          return handleResumeSubscription(request, env);
        if (path === "/api/billing/portal-session")  return handlePortalSession(request, env);
        if (path === "/webhooks/stripe")             return handleStripeWebhook(request, env);
        return handleClaude(request, env, ctx); // POST / — Claude proxy (catch-all)
      }

      return corsResponse(request, { error: "not_found" }, 404);
    } catch (e) {
      console.error("worker_error", e.message);
      return corsResponse(request, { error: "internal_error" }, 500);
    }
  },
};
