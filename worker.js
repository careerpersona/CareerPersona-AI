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
//   POST /api/billing/checkout-session → create Stripe Checkout session
//   POST /api/billing/confirm-session  → optimistic upgrade after checkout
//   POST /api/billing/cancel           → set cancel_at_period_end (FTC)
//   POST /api/billing/resume           → clear cancel_at_period_end
//   POST /api/billing/portal-session   → Stripe Customer Portal session
//   POST /api/account/request-deletion → schedule 30-day account deletion, cancel Stripe immediately
//   POST /api/account/cancel-deletion  → revert a scheduled (not yet started) deletion
//
// Routes (Stripe HMAC — no JWT):
//   POST /webhooks/stripe              → process billing events, invalidate KV

import { extractSkillKeywords } from "./src/lib/compatibility/skills.js";
// Shared platform infrastructure (2026-08-06) -- extracted from this file's
// own former private helpers, which already served two consumers
// (handleJobSearch + Proactive Job Alerts) before the extraction. Smart
// Apply Auto Prep is the third consumer. See the module's own header for the
// pre-extraction verification performed before moving this code.
import { fetchAdzuna, fetchRapid, fetchFreshPostings, deduplicate } from "./src/lib/platform/jobDiscoveryService.js";
// Smart Apply Auto Prep (2026-08-06) -- reuses three existing pure engines
// unchanged: the Career Compatibility Engine (qualification), its own
// Qualification/Selection module (ranking), and the same generation/
// validation functions manual Smart Apply uses (relocated from App.jsx
// today so both callers share one implementation, per the locked
// blueprint's §7). getDailyPeriodKey/getMonthlyPeriodKey/combineBudgetResults
// are the pure halves of the AI Budget Manager -- the atomic RPC-calling half
// (checkAndConsumeAutomationBudget) must live in this file; see aiBudget.js's
// own header comment for why.
import { buildCompatibilityRecord } from "./src/lib/compatibility/index.js";
import { selectJobsForAutoPrep } from "./src/lib/smartApplyAutoPrep/selection.js";
import { buildSmartApplyPrompt, validateSmartApplyPackage } from "./src/lib/smartApply/generation.js";
import { getDailyPeriodKey, getMonthlyPeriodKey, combineBudgetResults } from "./src/lib/platform/aiBudget.js";
// Proactive Job Alerts -- Discovery Engine + AI Layer are pure src/lib/
// modules, imported directly, same pattern already proven above by
// extractSkillKeywords. Never reimplemented here -- see the "PROACTIVE JOB
// ALERTS" section below for the Scheduler/Delivery Pipeline code that calls
// these.
import {
  deduplicateOpportunities, filterAlreadyApplied, evaluateOpportunity,
  applyDiversityConstraint, applyBalanceConstraint, enforceDeliveryCaps,
} from "./src/lib/proactiveJobAlerts/discoveryEngine.js";
import {
  computeVolumeTrend, detectHiringFreeze, computeSalarySignal, computeSpeedOfFill,
  computeApplicationWindowStats, computePersonalOutcomeTiming, computeSeasonalPattern,
} from "./src/lib/proactiveJobAlerts/marketSignals.js";
import {
  computeAlertTrustScore, findMissedOpportunities, computeOpportunityEngagementTrends, computeDiscoveryCoverage,
} from "./src/lib/proactiveJobAlerts/effectivenessMetrics.js";
import {
  buildCriticalOpportunityPrompt, parseCriticalOpportunityResponse,
  buildWatchlistActivityPrompt, parseWatchlistActivityResponse,
  computeWeeklyAvailability, buildWeeklyAnalysesPrompt, parseWeeklyAnalysesResponse,
} from "./src/lib/proactiveJobAlerts/aiPrompts.js";
import { groupCandidatesByCompany, computeWatchlistActivityStates } from "./src/lib/proactiveJobAlerts/watchlistActivity.js";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5180",
  "https://careerpersonaai.com",
];

// KV TTL in seconds, keyed by subscription_status.
// More volatile states get shorter TTLs to pick up changes faster.
const KV_TTL = {
  pro_active:      1800,  // 30 min
  pro_past_due:    300,   // 5 min  — needs fast resolution
  pro_cancelled:   3600,  // 1 hr  — wait for current_period_end
  premium_active:  1800,  // 30 min
  admin:           3600,  // 1 hr  — rarely changes
  no_subscription: 3600,  // 1 hr  — stable until checkout
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

  // Phase 8, C6 — explicit claim hardening, additive to the signature/expiry
  // checks above. Every caller of requireAuth() is invoked by the browser
  // with the user's own Supabase session access_token (never the
  // service_role key, which this Worker only ever uses server-side as a
  // REST API header via sbHeaders() -- it's never presented back to this
  // Worker as a Bearer token), and a real Supabase user session token always
  // carries aud="authenticated" and role="authenticated". Rejecting anything
  // else is a safe, exact-match check against the actual shape of every
  // legitimate token this function receives, not a guessed value.
  if (payload.aud !== "authenticated" || payload.role !== "authenticated") {
    throw new Error("invalid_claims");
  }

  return payload;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

// Phase 8, Finding C3 — server-side account-deletion lockout. Every caller of
// requireAuth() is protected by default: once profiles.deletion_status is
// 'scheduled' or 'in_progress', the request is rejected here, before the
// handler's own logic runs, so a new endpoint added later inherits the lock
// automatically instead of requiring every developer to remember to add a
// check. The two legitimate exceptions (request-deletion, cancel-deletion)
// opt out explicitly via { allowDeletionLocked: true } -- opt-out, not
// opt-in, so the safe behavior is the default one.
//
// The deletion_status read here is deliberately uncached (unlike
// getSubscription()'s KV-backed billing read) -- this is a security boundary,
// and a stale cached value could let a locked account slip through for the
// length of a cache TTL. If the read itself fails, the request is denied
// (fail closed), matching the same "both failing must deny, never grant"
// principle getSubscription() already documents for billing state.
async function requireAuth(request, env, options = {}) {
  const { allowDeletionLocked = false } = options;
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
  if (!token) return { ok: false, error: "unauthorized", status: 401 };
  let userId;
  try {
    const payload = await verifyJWT(token, env);
    userId = payload.sub;
    if (!userId) return { ok: false, error: "unauthorized", status: 401 };
  } catch (_) {
    return { ok: false, error: "unauthorized", status: 401 };
  }
  if (!allowDeletionLocked) {
    try {
      const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "deletion_status" }, env);
      const status = rows?.[0]?.deletion_status;
      if (status === "scheduled" || status === "in_progress") {
        return { ok: false, error: "account_scheduled_for_deletion", status: 423 };
      }
    } catch (_) {
      return { ok: false, error: "unauthorized", status: 401 };
    }
  }
  return { ok: true, userId };
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

async function supabaseDelete(table, match, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { method: "DELETE", headers: sbHeaders(env) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw Object.assign(new Error(`supabase_delete_${r.status}`), { status: r.status, body });
  }
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
  // Launch V1 frozen quota ceilings (Unit Economics decision, locked -- not derived
  // or re-proposed here). Each of these four features tracks its own independent
  // feature_usage row (user_id+feature+period_key), so none can consume another's
  // budget. aiRequestLimit is unrelated and untouched -- still config-driven, still
  // shared identically between Pro and Premium as before.
  // interviewSessionLimit is a RAW AI-call count, not a session count -- one
  // interview_prep session fires multiple calls (question gen, feedback scoring,
  // mock summary), so 100/120 raw calls corresponds to ~10/~12 sessions.
  const proFeatureLimits = {
    resumeAnalysisLimit: 10, interviewSessionLimit: 100, salaryAnalysisLimit: 10, linkedinIntelligenceLimit: 10, networkingOutreachLimit: 20, smartApplyLimit: 20, jobIntelligenceLimit: 20, opportunityIntelligenceLimit: 20,
  };
  const premiumFeatureLimits = {
    resumeAnalysisLimit: 10, interviewSessionLimit: 120, salaryAnalysisLimit: 10, linkedinIntelligenceLimit: 10, networkingOutreachLimit: 20, smartApplyLimit: 30, jobIntelligenceLimit: 30, opportunityIntelligenceLimit: 30,
  };
  const adminFeatureLimits = {
    resumeAnalysisLimit: 2000, interviewSessionLimit: 2000, salaryAnalysisLimit: 2000, linkedinIntelligenceLimit: 2000, networkingOutreachLimit: 2000, smartApplyLimit: 2000, jobIntelligenceLimit: 2000, opportunityIntelligenceLimit: 2000,
  };
  const aiRequestLimit = parseInt(config.pro_ai_requests_monthly ?? "500");
  switch (status) {
    case "pro_active":
      return { plan: "pro", canUseAI: true, canUseJobs: true, aiRequestLimit, ...proFeatureLimits };
    case "premium_active":
      return { plan: "premium", canUseAI: true, canUseJobs: true, aiRequestLimit, ...premiumFeatureLimits };
    case "pro_past_due": {
      const grace = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
      const inGrace = grace > now;
      return {
        plan: "pro_past_due", canUseAI: inGrace, canUseJobs: true,
        aiRequestLimit:            inGrace ? aiRequestLimit : 0,
        resumeAnalysisLimit:       inGrace ? proFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     inGrace ? proFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       inGrace ? proFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: inGrace ? proFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   inGrace ? proFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           inGrace ? proFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      inGrace ? proFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: inGrace ? proFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "pro_cancelled": {
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
      const active = end > now;
      return {
        plan: "pro_cancelled", canUseAI: active, canUseJobs: true,
        aiRequestLimit:            active ? aiRequestLimit : 0,
        resumeAnalysisLimit:       active ? proFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     active ? proFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       active ? proFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: active ? proFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   active ? proFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           active ? proFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      active ? proFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: active ? proFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "premium_past_due": {
      const grace = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
      const inGrace = grace > now;
      return {
        plan: "premium_past_due", canUseAI: inGrace, canUseJobs: true,
        aiRequestLimit:            inGrace ? aiRequestLimit : 0,
        resumeAnalysisLimit:       inGrace ? premiumFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     inGrace ? premiumFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       inGrace ? premiumFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: inGrace ? premiumFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   inGrace ? premiumFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           inGrace ? premiumFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      inGrace ? premiumFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: inGrace ? premiumFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "premium_cancelled": {
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
      const active = end > now;
      return {
        plan: "premium_cancelled", canUseAI: active, canUseJobs: true,
        aiRequestLimit:            active ? aiRequestLimit : 0,
        resumeAnalysisLimit:       active ? premiumFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     active ? premiumFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       active ? premiumFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: active ? premiumFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   active ? premiumFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           active ? premiumFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      active ? premiumFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: active ? premiumFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "admin":
      return {
        plan: "admin", canUseAI: true, canUseJobs: true,
        aiRequestLimit: Infinity, ...adminFeatureLimits,
      };
    default: // no_subscription
      return { plan: "none", canUseAI: false, canUseJobs: true,
        aiRequestLimit: 0, resumeAnalysisLimit: 0, interviewSessionLimit: 0, salaryAnalysisLimit: 0, linkedinIntelligenceLimit: 0, networkingOutreachLimit: 0, smartApplyLimit: 0, jobIntelligenceLimit: 0, opportunityIntelligenceLimit: 0 };
  }
}

function getPeriodKey(sub) {
  const s = sub.subscription_status ?? "no_subscription";
  if (s === "no_subscription") return "free";
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getFeatureLimit(feature, caps) {
  switch (feature) {
    case "resume_analysis":  return caps.resumeAnalysisLimit;
    case "interview_prep":   return caps.interviewSessionLimit;
    case "salary_analysis":  return caps.salaryAnalysisLimit;
    // Own explicit Launch V1 ceiling (no longer inherits Resume Analysis's limit) --
    // still a distinct feature tracked under its own feature_usage key.
    case "linkedin_intelligence": return caps.linkedinIntelligenceLimit;
    // 20/month Pro and Premium, per the confirmed Network Outreach pricing decision --
    // own dedicated ceiling, previously fell through to the generic aiRequestLimit.
    case "networking_outreach": return caps.networkingOutreachLimit;
    // 20/month Pro, 30/month Premium, per the locked Smart Apply quota decision --
    // own dedicated ceiling, previously fell through to the generic aiRequestLimit.
    // Manual generation only -- Smart Apply Auto Prep is a separate automation
    // budget (checkAndConsumeAutomationBudget / automation_preferences), untouched.
    case "smart_apply": return caps.smartApplyLimit;
    // 20/month Pro, 30/month Premium, per the locked Job Intelligence / Opportunity
    // Intelligence quota decision -- own dedicated ceilings, previously fell through
    // to the generic aiRequestLimit.
    case "job_intelligence": return caps.jobIntelligenceLimit;
    case "opportunity_intelligence": return caps.opportunityIntelligenceLimit;
    // Automatic continuations of an already-authorized primary action (a parallel
    // insights call, a post-improve re-score, a cover-letter refresh, a mock
    // interview's closing summary) -- never an independent customer request, so
    // never separately capped. Blocking these would leave a paid-for action
    // half-completed.
    case "resume_analysis_followup":
    case "interview_prep_followup":
      return Infinity;
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
  const periodEnd = sub.current_period_end   ? new Date(sub.current_period_end).getTime()   : 0;
  const graceEnd  = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
  switch (status) {
    case "pro_active":     return cancelAtPeriodEnd ? "PRO_CANCELING" : "PRO_ACTIVE";
    case "pro_past_due":   return graceEnd > now ? "PRO_PAST_DUE" : "PRO_EXPIRED";
    case "pro_cancelled":  return periodEnd > now ? "PRO_CANCELING" : "PRO_EXPIRED";
    case "premium_active": return cancelAtPeriodEnd ? "PREMIUM_CANCELING" : "PREMIUM_ACTIVE";
    case "premium_past_due":  return graceEnd > now ? "PREMIUM_PAST_DUE" : "PREMIUM_EXPIRED";
    case "premium_cancelled": return periodEnd > now ? "PREMIUM_CANCELING" : "PREMIUM_EXPIRED";
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
    { key: "linkedin_intelligence", limit: caps.linkedinIntelligenceLimit },
    { key: "networking_outreach", limit: caps.networkingOutreachLimit },
    { key: "smart_apply",     limit: caps.smartApplyLimit },
    { key: "job_intelligence", limit: caps.jobIntelligenceLimit },
    { key: "opportunity_intelligence", limit: caps.opportunityIntelligenceLimit },
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
  FREE: "Free",
  PRO_ACTIVE: "Pro", PRO_CANCELING: "Pro", PRO_PAST_DUE: "Pro", PRO_EXPIRED: "Pro",
  PREMIUM_ACTIVE: "Premium", PREMIUM_CANCELING: "Premium", PREMIUM_PAST_DUE: "Premium", PREMIUM_EXPIRED: "Premium",
  ADMIN: "Admin",
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

// Stripe moved current_period_start/current_period_end off the top-level
// Subscription object onto each SubscriptionItem (API change supporting
// multiple/flexible-billed items per subscription) -- confirmed directly
// against a live GET /subscriptions/{id} response during Phase 7 testing,
// where both fields were absent at the top level and present under
// items.data[0] instead. Every subscription this app creates has exactly
// one item (one price per subscription -- see handleCheckoutSession/
// handleChangePlan, both single-price), so item[0]'s period is simply the
// subscription's period. Applies uniformly everywhere a Subscription object
// is read, regardless of source (a direct GET/POST response or a webhook
// event's embedded data.object) -- it's the resource's current schema, not
// an endpoint-specific quirk.
function getSubscriptionPeriod(stripeSub) {
  const item = stripeSub.items?.data?.[0];
  return { start: item?.current_period_start ?? null, end: item?.current_period_end ?? null };
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

// ─── JOB SEARCH ──────────────────────────────────────────────────────────────
// POST /api/jobs — no auth. EMP_TYPE_MAP/normalizeAdzuna/normalizeRapid/
// deduplicate/fetchAdzuna/fetchRapid relocated (2026-08-06) to the shared
// src/lib/platform/jobDiscoveryService.js -- imported above -- since they
// already served this endpoint AND Proactive Job Alerts before the
// extraction; Smart Apply Auto Prep is the third consumer. Behavior-preserving
// relocation, verified by direct diff against the pre-extraction source.

async function handleJobSearch(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);

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
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1b: Application Outcome Intelligence is Premium/Admin only, per its
  // locked blueprint -- canUseAI alone is too broad (also true for Pro). Reuses
  // caps.plan, already computed by getCapabilities() above; no second
  // entitlement system, no new config, no quota/pricing change.
  if (feature === "outcome_intelligence" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1c: Referral Intelligence is Premium/Admin only, per its locked ADR and
  // client-side isPremium gate -- canUseAI alone is too broad (also true for Pro),
  // and getFeatureLimit has no dedicated case for this feature so quota alone
  // wouldn't block it either (falls through to the generic aiRequestLimit, which
  // Pro also has). Same pattern as the outcome_intelligence check above -- reuses
  // caps.plan, no second entitlement system, no config or quota/pricing change.
  if (feature === "referral_intelligence" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1d: LinkedIn Intelligence's Premium interpretive layer (Profile Strategy
  // Analysis, Recruiter Visibility Intelligence, Profile Evolution Tracking) is
  // Premium/Admin only -- the base content generation stays on the plain
  // "linkedin_intelligence" feature key, Pro-allowed, unaffected by this check.
  // Same pattern as Layer 1b/1c -- reuses caps.plan, no second entitlement system,
  // no config or quota/pricing change.
  if (feature === "linkedin_intelligence_premium" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
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

  if (!r.ok) {
    console.error('[handleClaude] Anthropic error', r.status, JSON.stringify(d));
  }

  if (r.ok && ctx?.waitUntil) {
    ctx.waitUntil(logAIRequest(userId, feature, period, d.usage?.input_tokens, d.usage?.output_tokens, env));
  }

  return corsResponse(request, d, r.status);
}

// Authoritative server-side tier detection -- the ONLY thing that decides
// pro_active vs premium_active (and their past_due/cancelled equivalents) is
// the actual Stripe Price ID attached to the actual Stripe Subscription
// object, compared against the two configured Price IDs. Never reads a
// client-supplied plan; a Checkout Session's requested `plan` only picks
// which price to charge, it never bypasses this check. Defaults to "pro" for
// any subscription whose price doesn't match the configured Premium Price ID
// (including when Premium isn't configured yet) -- matches today's existing
// behavior exactly and never silently grants Premium entitlement.
function determineTierFromStripeSubscription(stripeSub, config) {
  const priceId = stripeSub?.items?.data?.[0]?.price?.id;
  if (priceId && config.stripe_price_id_premium && priceId === config.stripe_price_id_premium) {
    return "premium";
  }
  return "pro";
}

// Blueprint #3: create Stripe Checkout session. Get-or-create Stripe customer,
// then create a subscription checkout. Returns { url } for frontend redirect.
// `plan` ("pro" | "premium", body param, defaults to "pro" so the existing
// no-body Pro call keeps working unchanged) only selects which Price ID this
// Checkout Session is created for -- it never establishes entitlement itself.
// The actual tier a user is granted is always re-derived server-side from the
// real Stripe subscription object once payment completes (see
// determineTierFromStripeSubscription), never trusted from this request.
async function handleCheckoutSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  let plan = "pro";
  try {
    const body = await request.json();
    if (body?.plan === "premium") plan = "premium";
  } catch (_) { /* no body / not JSON — default to "pro", preserves the existing call shape */ }
  const config = await getConfig(env);
  const priceId = plan === "premium" ? config.stripe_price_id_premium : config.stripe_price_id_pro;
  // Fails safely rather than attempting checkout with a placeholder: until a
  // real Premium Price ID is set in platform_config, Premium checkout is
  // simply unavailable, same 503 shape Pro already uses when unconfigured.
  if (!priceId) return corsResponse(request, { error: plan === "premium" ? "premium_price_not_configured" : "stripe_price_not_configured" }, 503);
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
  // International currency: Stripe's own Adaptive Pricing, not a currency
  // system of our own. The Price stays USD (the $29.99/$39.99 reference
  // price, untouched) -- Stripe detects the customer's location, presents
  // and charges an equivalent local-currency amount using a Stripe-guaranteed
  // exchange rate, and reports the real charged amount back via
  // presentment_details on the Checkout Session / PaymentIntent events. We
  // never compute, store, or branch on a currency or exchange rate anywhere
  // in this codebase. `adaptive_pricing[enabled]: true` is passed explicitly
  // per-session (rather than relying silently on the Dashboard default) so
  // this stays correct even if that account-level default is ever changed --
  // it still requires Adaptive Pricing to be enabled for the account (see
  // the Dashboard action noted at this function's top).
  //
  // This is a Checkout Session-only parameter -- once a subscription is
  // created this way, Stripe continues billing every subsequent invoice for
  // that subscription (renewals, and the proration/next-cycle invoices from
  // handleChangePlan's upgrade/downgrade below) in the same established
  // presentment currency automatically. Neither the Subscription Update API
  // nor the Subscription Schedule API used by handleChangePlan has an
  // adaptive-pricing parameter of its own -- none is needed, since currency
  // presentment is a property of the subscription's off-session payment
  // setup from checkout time, not of each individual price change.
  const session = await stripeRequest("POST", "/checkout/sessions", {
    customer: customerId,
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "adaptive_pricing[enabled]": "true",
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
  const config = await getConfig(env);
  const tier = determineTierFromStripeSubscription(stripeSub, config);
  const newStatus = tier === "premium" ? "premium_active" : "pro_active";
  const period = getSubscriptionPeriod(stripeSub);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    subscription_status: newStatus,
    stripe_subscription_id: stripeSub.id,
    current_period_start: new Date(period.start * 1000).toISOString(),
    current_period_end: new Date(period.end * 1000).toISOString(),
    cancel_at_period_end: stripeSub.cancel_at_period_end,
  }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, { success: true, subscription_status: newStatus });
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

// Account Deletion (Phase 7, Part A). Two-step lifecycle: request sets a
// 30-day grace period and cancels billing immediately; the purge cron
// (runAccountDeletionPurge, below) does the actual data erasure once
// deletion_scheduled_purge_at arrives. Only "scheduled" data lives on
// profiles until then -- no other table is touched by this endpoint.
//
// Immediate cancellation (DELETE, not cancel_at_period_end) is used here
// deliberately, unlike handleCancelSubscription above: that endpoint is for
// a user who cancels but keeps using the app, so billing them through the
// period they already paid for is fair. Here the whole account -- including
// the subscription's own record -- is being erased within 30 days regardless,
// so continuing to bill (or leave a subscription active) through a period
// the account won't survive to finish makes no sense; stopping billing right
// away is the correct behavior for this specific flow.
async function handleRequestAccountDeletion(request, env) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true });
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;

  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id,deletion_status" }, env);
  const profileRow = rows?.[0];
  if (!profileRow) return corsResponse(request, { error: "profile_not_found" }, 404);
  if (profileRow.deletion_status === "scheduled" || profileRow.deletion_status === "in_progress") {
    return corsResponse(request, { error: "deletion_already_scheduled" }, 400);
  }

  // Cancel billing first -- if this throws, the account is never marked for
  // deletion with an active subscription still running.
  if (profileRow.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
    try {
      await stripeRequest("DELETE", `/subscriptions/${profileRow.stripe_subscription_id}`, null, env);
    } catch (e) {
      // Already-canceled/missing subscription on Stripe's side is not fatal --
      // the account should still be able to schedule deletion.
      if (e.stripeCode !== "resource_missing") {
        return corsResponse(request, { error: "stripe_cancel_failed" }, 502);
      }
    }
  }

  const now = new Date();
  const purgeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  // account_deletion_log first: it's the durable record the purge scheduler
  // actually drives off (see runAccountDeletionPurgeSchedule below) and the
  // only thing that survives profiles being deleted mid-purge -- if this
  // insert fails, nothing has been marked locked yet, so the request simply
  // fails and the client can retry cleanly. profiles is patched second,
  // purely for the client-facing lock (App.jsx reads this via fetchProfile).
  await supabasePost("account_deletion_log", {
    user_id: userId,
    requested_at: now.toISOString(),
    scheduled_purge_at: purgeAt.toISOString(),
    status: "scheduled",
  }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    deletion_status: "scheduled",
    deletion_requested_at: now.toISOString(),
    deletion_scheduled_purge_at: purgeAt.toISOString(),
    subscription_status: "no_subscription",
    cancel_at_period_end: false,
  }, env);
  await invalidateSubscription(userId, env);

  return corsResponse(request, { success: true, deletion_scheduled_purge_at: purgeAt.toISOString() });
}

async function handleCancelAccountDeletion(request, env) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true });
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;

  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "deletion_status" }, env);
  const status = rows?.[0]?.deletion_status;
  if (status !== "scheduled") {
    // Nothing to cancel (null), or the purge has already started ("in_progress"/
    // "completed") -- once the purge cron has picked it up, cancellation is no
    // longer safe to honor here.
    return corsResponse(request, { error: status ? "deletion_already_in_progress" : "no_deletion_scheduled" }, 400);
  }

  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    deletion_status: null,
    deletion_requested_at: null,
    deletion_scheduled_purge_at: null,
  }, env);
  // Remove the tracking row too -- "no residual deletion flags" applies to
  // account_deletion_log as much as to profiles. Nothing depends on this row
  // existing once the scheduled deletion itself no longer does.
  await supabaseDelete("account_deletion_log", { user_id: `eq.${userId}` }, env);

  return corsResponse(request, { success: true });
}

// App-controlled plan changes (Pro <-> Premium) -- replaces reliance on
// Customer Portal's native "update subscription" feature, which only offers
// one portal-wide proration policy and can't express this app's asymmetric
// per-direction rules (immediate+prorated upgrade, deferred+unprorated
// downgrade). Portal plan-switching must be disabled in the Stripe Dashboard
// (one-time account configuration, not code) so this endpoint is the only
// path that changes a paid tier once a subscription exists.
//
// Ownership: identical pattern to handleCancelSubscription/
// handleResumeSubscription above -- stripe_subscription_id is always looked
// up from the authenticated user's own profiles row, never accepted from the
// client, so a user can never target another user's subscription by
// supplying a different customer/subscription ID.
//
// Tier authority: determineTierFromStripeSubscription() is consulted both
// before (to validate the requested transition) and after (to confirm what
// was actually granted) every change -- the client's requested `plan` only
// selects which Stripe operation to perform, it never itself grants
// entitlement.
async function handleChangePlan(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;

  let plan;
  try {
    const body = await request.json();
    plan = body?.plan;
  } catch (_) { /* falls through to the validation below */ }
  if (plan !== "pro" && plan !== "premium") {
    return corsResponse(request, { error: "invalid_plan" }, 400);
  }

  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return corsResponse(request, { error: "no_active_subscription" }, 400);

  const [stripeSub, config] = await Promise.all([
    stripeRequest("GET", `/subscriptions/${subId}`, null, env),
    getConfig(env),
  ]);
  // Only a currently-active Stripe subscription is eligible -- past_due,
  // canceled, or any other status resolves through the existing
  // grace-period/checkout paths, not this endpoint.
  if (stripeSub.status !== "active") {
    return corsResponse(request, { error: "subscription_not_active" }, 400);
  }
  const currentTier = determineTierFromStripeSubscription(stripeSub, config);
  if (currentTier === plan) {
    return corsResponse(request, { error: "already_on_plan" }, 400);
  }

  if (plan === "premium") {
    // Pro -> Premium: immediate upgrade. Stripe computes the exact prorated
    // amount from the actual time remaining in the billing period -- no
    // day-based math here, no assumed fixed amount. always_invoice charges
    // that proration right away rather than silently deferring it to the
    // next cycle, matching the locked "immediate upgrade" rule.
    const premiumPriceId = config.stripe_price_id_premium;
    if (!premiumPriceId) return corsResponse(request, { error: "premium_price_not_configured" }, 503);
    const itemId = stripeSub.items?.data?.[0]?.id;
    const updated = await stripeRequest("POST", `/subscriptions/${subId}`, {
      "items[0][id]": itemId,
      "items[0][price]": premiumPriceId,
      proration_behavior: "always_invoice",
    }, env);
    const newTier = determineTierFromStripeSubscription(updated, config);
    const newStatus = newTier === "premium" ? "premium_active" : "pro_active";
    const updatedPeriod = getSubscriptionPeriod(updated);
    await supabasePatch("profiles", { id: `eq.${userId}` }, {
      subscription_status: newStatus,
      current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
      current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
      cancel_at_period_end: updated.cancel_at_period_end,
    }, env);
    await invalidateSubscription(userId, env);
    return corsResponse(request, { success: true, subscription_status: newStatus });
  }

  // Premium -> Pro: schedule the downgrade for the end of the current
  // billing period via a native Stripe Subscription Schedule -- no custom
  // day-based calculation, no cron job. Nothing changes in our own DB now;
  // the account keeps premium_active and Premium-tier quotas until the
  // scheduled phase actually transitions. When it does, Stripe applies the
  // new price to the subscription and fires customer.subscription.updated,
  // which re-derives and writes the new tier (see processStripeEvent) --
  // that's the single sync point, not this endpoint.
  const proPriceId = config.stripe_price_id_pro;
  if (!proPriceId) return corsResponse(request, { error: "stripe_price_not_configured" }, 503);
  const schedule = await stripeRequest("POST", "/subscription_schedules", { from_subscription: subId }, env);
  const currentPhase = schedule.phases?.[0];
  const currentPhaseItem = currentPhase?.items?.[0];
  const currentPhasePriceId = typeof currentPhaseItem?.price === "string" ? currentPhaseItem.price : currentPhaseItem?.price?.id;
  await stripeRequest("POST", `/subscription_schedules/${schedule.id}`, {
    "phases[0][items][0][price]": currentPhasePriceId,
    "phases[0][items][0][quantity]": String(currentPhaseItem?.quantity ?? 1),
    "phases[0][start_date]": String(currentPhase.start_date),
    "phases[0][end_date]": String(currentPhase.end_date),
    "phases[1][items][0][price]": proPriceId,
    "phases[1][items][0][quantity]": "1",
    "phases[1][proration_behavior]": "none",
  }, env);
  return corsResponse(request, {
    success: true,
    subscription_status: "premium_active",
    scheduled_downgrade_to: "pro",
    effective_at: new Date(currentPhase.end_date * 1000).toISOString(),
  });
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
  // Always invalidate the per-user KV cache before reading so any DB change
  // (e.g. admin promotion, checkout completion) is visible immediately rather
  // than after the KV TTL expires.
  await invalidateSubscription(userId, env);
  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  const periodKey = getPeriodKey(sub);
  const usage = await getUsage(userId, periodKey, env);
  const billingState = computeBillingState(sub);
  return corsResponse(request, {
    billingState,
    subscriptionStatus: sub.subscription_status ?? "no_subscription",
    planDisplayName: BILLING_STATE_PLAN[billingState] ?? "Free",
    canUseAI: caps.canUseAI,
    canUseJobs: caps.canUseJobs,
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
      const config = await getConfig(env);
      const tier = determineTierFromStripeSubscription(sub, config);
      const period = getSubscriptionPeriod(sub);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_active" : "pro_active",
        stripe_subscription_id: sub.id,
        current_period_start: new Date(period.start * 1000).toISOString(),
        current_period_end: new Date(period.end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
        grace_period_ends_at: null,
      }, env);
      break;
    }
    case "invoice.payment_failed": {
      const config = await getConfig(env);
      const graceDays = parseInt(config.grace_period_days ?? "14");
      const graceEnds = new Date(Date.now() + graceDays * 86400 * 1000).toISOString();
      // Same tier-detection as invoice.paid -- a failed invoice still carries
      // a subscription reference, so the actual Price/Product on that
      // subscription (not the previously-stored status) decides which
      // past_due variant this account returns to at the end of its grace
      // period.
      const sub = await stripeRequest("GET", `/subscriptions/${obj.subscription}`, null, env);
      const tier = determineTierFromStripeSubscription(sub, config);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_past_due" : "pro_past_due",
        grace_period_ends_at: graceEnds,
      }, env);
      break;
    }
    case "customer.subscription.deleted": {
      // event.data.object for a subscription.* event IS the Subscription
      // itself -- items/price already embedded, no extra fetch needed.
      const config = await getConfig(env);
      const tier = determineTierFromStripeSubscription(obj, config);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_cancelled" : "pro_cancelled",
        stripe_subscription_id: null,
      }, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        status: "canceled",
        canceled_at: obj.canceled_at ? new Date(obj.canceled_at * 1000).toISOString() : new Date().toISOString(),
        ended_at: obj.ended_at ? new Date(obj.ended_at * 1000).toISOString() : new Date().toISOString(),
      }, env).catch(() => {});
      break;
    }
    case "customer.subscription.updated": {
      const updatedPeriod = getSubscriptionPeriod(obj);
      const patch = {
        cancel_at_period_end: obj.cancel_at_period_end,
        current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
        current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
      };
      // Sync entitlement to whatever tier the subscription's actual price now
      // reflects -- covers both an immediate handleChangePlan upgrade's own
      // confirming webhook (already-correct, idempotent) and, critically, a
      // scheduled Premium->Pro downgrade's phase transition actually landing
      // (the only place that transition gets written -- handleChangePlan
      // itself never touches subscription_status for a scheduled downgrade).
      // Scoped to accounts currently pro_active/premium_active only: a
      // past_due or cancelled account's status is owned exclusively by
      // invoice.payment_failed / customer.subscription.deleted, so an
      // unrelated subscription.updated event (e.g. Stripe's own retry
      // bookkeeping) must never bounce it back to *_active on its own.
      const profileRows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "subscription_status" }, env);
      const currentStatus = profileRows?.[0]?.subscription_status;
      if (currentStatus === "pro_active" || currentStatus === "premium_active") {
        const config = await getConfig(env);
        const tier = determineTierFromStripeSubscription(obj, config);
        patch.subscription_status = tier === "premium" ? "premium_active" : "pro_active";
      }
      await supabasePatch("profiles", { id: `eq.${userId}` }, patch, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        cancel_at_period_end: obj.cancel_at_period_end,
        current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
        current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
        status: obj.status,
      }, env).catch(() => {});
      break;
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// PROACTIVE JOB ALERTS — SCHEDULED PIPELINE
// Locked blueprint: https://claude.ai/code/artifact/779890b3-2265-42d7-b86f-94e78d2d56db
//
// Four strict responsibility boundaries for this section:
//  - Scheduler (runProactiveJobAlertsSchedule + the per-cadence run* functions'
//    top-level loop): timing, triggering, per-user orchestration only. Never
//    computes a tier, score, or narrative itself.
//  - Discovery Engine (imported above from src/lib/proactiveJobAlerts/ --
//    the SAME pure functions the frontend will use in Phase 5/6, not
//    reimplemented): candidate generation, deterministic discovery.
//  - AI Layer (imported prompt-builders/parsers above + callClaudeServerSide
//    below, which mirrors handleClaude's exact Anthropic-call mechanics):
//    interpretation, guidance, narrative generation only. Never decides a
//    tier or which candidates are delivered.
//  - Delivery Pipeline (the persist*/fetchUserAlertContext functions below):
//    persistence, notification preparation (i.e. writing alert rows the
//    Phase 5 UI will read as a digest -- this app has no push/email channel
//    to reuse or build here), and lifecycle_status/tier-change tracking.
//
// Cron schedule (see wrangler.toml):
//   "0 */6 * * *"  -> Analysis 01, Critical Opportunity Engine (every 6h)
//   "0 */12 * * *" -> Analysis 04, Watchlist Activity Monitor (every 12h)
//   "0 6 * * 1"    -> Analyses 02+03+05+06, weekly (Monday 06:00 UTC)
//
// Known v1 limitations (flagged, not silently hidden):
//  - No source supplies a real posting close date, so "closing_soon" urgency
//    factors will not fire against live data until a source with deadline
//    data is added -- pre-existing gap in the job APIs, not introduced here.
//  - Market Intelligence's volume trend is derived from this platform's own
//    alert_candidates history, which is empty at launch and thin for the
//    first several weeks ("cold start") -- computeVolumeTrend already
//    returns trend:null gracefully until enough history exists.
// ═══════════════════════════════════════════════════════════════════════════

const CLAUDE_MODEL = "claude-sonnet-4-6";
const PROACTIVE_ALERTS_TIME_BUDGET_MS = 20_000; // leaves headroom under Workers' CPU limit; remaining users roll to the next scheduled run
const PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE = 1;

// AI Layer's execution primitive -- mirrors handleClaude's exact Anthropic
// call (same model, same message shape), minus the request-specific
// auth/quota wrapper (the scheduler checks quota itself, per-user, before
// calling this -- see checkAndConsumeAIQuota).
async function callClaudeServerSide(prompt, maxTokens, env) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: Math.min(maxTokens, 8000), messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) {
    console.error("[proactiveAlerts] Claude error", r.status, JSON.stringify(d));
    return { text: null, usage: null };
  }
  const text = (d.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
  return { text, usage: d.usage };
}

// Delivery Pipeline needs upsert semantics (alert_candidates is re-evaluated
// across cadences via unique(user_id, job_id)) -- supabasePost alone is
// insert-only. Mirrors the REST-level shape of the upsert the frontend's
// Supabase client already performs elsewhere (e.g. company_watchlist), just
// expressed as a raw fetch call since worker.js talks to PostgREST directly.
async function supabaseUpsert(table, data, onConflict, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("on_conflict", onConflict);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { ...sbHeaders(env), "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(data),
  });
  const body = await r.text();
  if (!r.ok) throw Object.assign(new Error(`supabase_upsert_${r.status}`), { status: r.status, body });
  return JSON.parse(body);
}

// ── Scheduler: eligible users ────────────────────────────────────────────────
// Proactive Job Alerts is Premium Feature #4 -- same premium-only gate
// already established for Referral Intelligence (isPremium = premium_active
// or admin), not the broader "canUseAI" set that also includes pro.
async function getPremiumUserIds(env) {
  const rows = await supabaseGet("profiles", { select: "id", subscription_status: "in.(premium_active,admin)" }, env);
  return rows.map(r => r.id);
}

// Reuses the exact Layer 1 + Layer 2 entitlement/quota chain handleClaude
// already uses for interactive requests, applied per-user in the background
// loop instead of per-HTTP-request. Deterministic discovery work always
// proceeds regardless (it costs no AI budget); only the AI narrative call is
// gated here.
async function checkAndConsumeAIQuota(userId, feature, env) {
  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  if (!caps.canUseAI) return false;
  const limit = getFeatureLimit(feature, caps);
  if (limit === Infinity) return true;
  const period = getPeriodKey(sub);
  const quota = await supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: feature, p_limit: limit, p_period: period }, env);
  return !!quota.allowed;
}

// ── Delivery Pipeline: per-user context ──────────────────────────────────────
async function fetchUserAlertContext(userId, env) {
  const [profileRows, detailRows, contacts, watchlist, savedJobRows, outcomePatterns, existingCandidates, recentAlerts, applicationRows] = await Promise.all([
    supabaseGet("profiles", { select: "*", id: `eq.${userId}` }, env),
    supabaseGet("profile_details", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("networking_contacts", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("company_watchlist", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("saved_jobs", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("outcome_patterns", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("alert_candidates", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("alerts", { select: "*", user_id: `eq.${userId}`, order: "delivered_at.desc", limit: "200" }, env),
    // Cross-Feature Integration (Phase 6): Application Outcome Intelligence
    // owns this data (applications table + its own patternEngine.js) --
    // Proactive Job Alerts only READS it, via marketSignals.js's
    // computeApplicationWindowStats/computePersonalOutcomeTiming (Analysis
    // 06, Timing Intelligence). Never recomputes an outcome pattern itself.
    supabaseGet("applications", { select: "response_status,days_since_posted", user_id: `eq.${userId}` }, env),
  ]);
  const base = profileRows[0] || {};
  const details = detailRows[0] || {};
  return {
    profile: {
      preferred_job_title: details.preferred_job_title || base.job_title || "",
      location: base.location || "",
      work_type: details.work_type || "",
      desired_salary: details.desired_salary || "",
    },
    contacts, watchlist,
    // Only saved_jobs.job_id maps to an external posting ID -- applications
    // are logged as free-text company/title with no comparable ID, so they
    // are not a valid input to filterAlreadyApplied's exact-ID matching.
    appliedJobIds: savedJobRows.map(j => j.job_id).filter(Boolean),
    outcomePatterns, existingCandidates, recentAlerts,
    applications: applicationRows.map(a => ({ status: a.status, daysSincePosted: a.days_since_posted })),
  };
}

// fetchFreshPostings relocated (2026-08-06) to the shared
// src/lib/platform/jobDiscoveryService.js -- imported above. Proactive Job
// Alerts keeps its own named PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE constant
// for readability and passes it explicitly below, rather than relying on the
// now-generic function's default parameter value.

// Persists Discovery Engine's evaluated output. Tracks tier CHANGES
// (previous_tier/tier_change_reason) as plain persistence-layer bookkeeping
// -- comparing an old field to a new field on write, not a business
// decision -- powering §18's "Explain Why Priority Changed" in a later phase.
async function persistAlertCandidates(userId, evaluatedResults, env) {
  // Each item already carries its own matching `existing` row (looked up by
  // the caller -- see runCriticalOpportunityCadence's existingByJobId map).
  const rows = evaluatedResults.map(({ result, existing }) => {
    const tierChanged = existing && existing.alert_tier !== result.tier;
    return {
      user_id: userId,
      job_id: result.job.id,
      job_title: result.job.title,
      company: result.job.company,
      source: result.job.source || "unknown",
      match_score: result.matchScore,
      alert_tier: result.tier,
      confidence_tier: result.confidenceTier,
      lifecycle_status: existing?.lifecycle_status && existing.lifecycle_status !== "discovered" ? existing.lifecycle_status : "evaluated",
      discard_reason: result.tier === "discarded" ? result.tierReason : null,
      urgency_factors: result.urgencyFactors,
      signal_enrichments: { hasNetworkContact: result.signals.hasNetworkContact, isWatchlisted: result.signals.isWatchlisted, isDreamCompany: result.signals.isDreamCompany, outcomePatternPositive: result.signals.outcomePatternPositive },
      previous_tier: tierChanged ? existing.alert_tier : (existing?.previous_tier ?? null),
      tier_change_reason: tierChanged ? `Re-evaluated: ${existing.alert_tier} -> ${result.tier} (${result.tierReason})` : (existing?.tier_change_reason ?? null),
      estimated_close_date: result.job.estimatedCloseDate || null,
      posted_at: result.job.datePosted || null,
    };
  });
  if (!rows.length) return [];
  return supabaseUpsert("alert_candidates", rows, "user_id,job_id", env);
}

// explanationsByJobId (optional) carries the AI Layer's own narrative,
// keyed by the candidate's job.id -- stored verbatim, exactly as the AI Layer
// produced it (aiPrompts.js), never edited, summarized, or regenerated here.
// The Delivery Pipeline's only job is writing it down against the right row.
async function markAlertsDelivered(userId, deliverCandidates, persistedRows, digestType, env, explanationsByJobId = new Map()) {
  if (!deliverCandidates.length) return;
  const byJobId = new Map(persistedRows.map(r => [r.job_id, r]));
  const alertRows = deliverCandidates
    .map(c => ({ row: byJobId.get(c.job.id), jobId: c.job.id }))
    .filter(x => x.row)
    .map(({ row, jobId }) => ({ user_id: userId, candidate_id: row.id, digest_type: digestType, explanation: explanationsByJobId.get(jobId) || null }));
  if (alertRows.length) await supabasePost("alerts", alertRows, env);
  const alertedIds = deliverCandidates.map(c => byJobId.get(c.job.id)?.id).filter(Boolean);
  if (alertedIds.length) {
    await Promise.all(alertedIds.map(id => supabasePatch("alert_candidates", { id: `eq.${id}` }, { lifecycle_status: "alerted" }, env)));
  }
}

// ── Cadence 1: Critical Opportunity Engine (every 6h) ────────────────────────
async function runCriticalOpportunityCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  const rawPostings = await fetchFreshPostings(ctxData.profile, env, PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE);
  const deduped = deduplicateOpportunities(rawPostings);
  const unapplied = filterAlreadyApplied(deduped, ctxData.appliedJobIds);

  const existingByJobId = new Map(ctxData.existingCandidates.map(c => [c.job_id, c]));
  const evaluated = unapplied.map(job => ({
    result: evaluateOpportunity({ job, profile: ctxData.profile, contacts: ctxData.contacts, watchlist: ctxData.watchlist, outcomePatterns: ctxData.outcomePatterns }),
    existing: existingByJobId.get(job.id) || null,
  }));

  const persisted = await persistAlertCandidates(userId, evaluated, env);

  const alreadyToday = ctxData.recentAlerts.filter(a => a.delivered_at && (Date.now() - new Date(a.delivered_at).getTime()) < 86400000);
  const tieredForCaps = evaluated.map(e => e.result);
  const capResult = enforceDeliveryCaps(tieredForCaps, {
    alreadyDeliveredToday: {
      critical: alreadyToday.filter(a => persisted.find(p => p.id === a.candidate_id)?.alert_tier === "critical").length,
      high: alreadyToday.filter(a => persisted.find(p => p.id === a.candidate_id)?.alert_tier === "high").length,
    },
  });

  if (!capResult.deliver.length) return { userId, delivered: 0, aiCalled: false };

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  const explanationsByJobId = new Map();
  if (allowed) {
    const built = buildCriticalOpportunityPrompt(capResult.deliver);
    if (built) {
      const { text, usage } = await callClaudeServerSide(built.prompt, 900, env);
      if (text) {
        const parsed = parseCriticalOpportunityResponse(text, capResult.deliver);
        if (parsed) {
          for (const p of parsed) {
            // Deterministic facts (urgencyFactors/matchScore/confidenceTier/tier)
            // are stored alongside the AI's own text so the UI can render them
            // side by side -- the evidence pairing, not just the narrative alone.
            explanationsByJobId.set(p.candidate.job.id, {
              whyUrgent: p.whyUrgent,
              displayRank: p.displayRank,
              basedOn: { tier: p.candidate.tier, tierReason: p.candidate.tierReason, urgencyFactors: p.candidate.urgencyFactors, matchScore: p.candidate.matchScore, confidenceTier: p.candidate.confidenceTier },
            });
          }
        }
        if (usage) await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage.input_tokens, usage.output_tokens, env);
      }
    }
  }

  await markAlertsDelivered(userId, capResult.deliver, persisted, "daily_critical", env, explanationsByJobId);
  return { userId, delivered: capResult.deliver.length, aiCalled: allowed };
}

// ── Cadence 2: Watchlist Activity Monitor (every 12h) ────────────────────────
// Deliberately reads already-persisted alert_candidates (populated by the 6h
// Critical cadence) rather than re-fetching from Adzuna/RapidAPI a second
// time -- avoids a redundant third ingestion pipeline for the same job
// sources; this cadence's job is monitoring + narrative, not discovery.
async function runWatchlistActivityCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  if (!ctxData.watchlist.length) return { userId, ranAnalysis: false };

  const byCompany = groupCandidatesByCompany(ctxData.existingCandidates);
  const states = computeWatchlistActivityStates({ watchlist: ctxData.watchlist, alertCandidatesByCompany: byCompany });

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  if (!allowed) return { userId, ranAnalysis: false, reason: "quota_exhausted" };

  const built = buildWatchlistActivityPrompt(states);
  if (!built) return { userId, ranAnalysis: false, reason: "nothing_active" };

  const { text, usage } = await callClaudeServerSide(built.prompt, 500, env);
  const summary = text ? parseWatchlistActivityResponse(text) : null;
  if (usage) await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage.input_tokens, usage.output_tokens, env);
  if (summary) {
    // The exact deterministic states given to the AI travel with its output --
    // the UI renders them side by side, so "which companies/signals produced
    // this text" is never left to trust the narrative alone.
    await supabasePost("market_signals", [{ user_id: userId, signal_type: "watchlist_summary", scope: "user_specific", value: { ...summary, basedOn: states.filter(s => s.signal !== "quiet") } }], env);
  }
  return { userId, ranAnalysis: !!summary };
}

// ── Cadence 3: Weekly (Analyses 02 + 03 + 05 + 06) ───────────────────────────
async function runWeeklyCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000);

  const curatedCandidates = ctxData.existingCandidates
    .filter(c => c.alert_tier === "curated" && c.lifecycle_status !== "alerted")
    .map(c => ({ job: { id: c.job_id, title: c.job_title, company: c.company }, tier: c.alert_tier, matchScore: c.match_score, industry: null, isStretch: false }));
  const balanceResult = applyBalanceConstraint(curatedCandidates);
  const diversityResult = applyDiversityConstraint(balanceResult.candidates.map(c => ({ ...c, tier: "curated" })));

  // Cold-start-aware: volume trend is derived from this platform's own
  // ingestion history (posted_at timestamps already recorded in
  // alert_candidates), which is thin for the first several weeks after
  // launch -- computeVolumeTrend degrades to trend:null gracefully, it is
  // never fabricated from too little history.
  const thisWeekCount = ctxData.existingCandidates.filter(c => c.posted_at && new Date(c.posted_at) >= weekAgo).length;
  const priorPeriodCandidates = ctxData.existingCandidates.filter(c => c.posted_at && new Date(c.posted_at) >= fourWeeksAgo && new Date(c.posted_at) < weekAgo);
  const priorPeriodAvg = priorPeriodCandidates.length / 3;
  const volumeTrend = computeVolumeTrend({ currentPeriodCount: thisWeekCount, priorPeriodAvg: priorPeriodCandidates.length ? priorPeriodAvg : null });
  const hiringFreeze = detectHiringFreeze({ overall: volumeTrend });
  const salarySignal = computeSalarySignal({ currentAvgSalary: null, priorAvgSalary: null });
  const speedOfFill = computeSpeedOfFill([]);

  const trustScore = computeAlertTrustScore(ctxData.recentAlerts, { now });
  const missedOpportunities = findMissedOpportunities(ctxData.existingCandidates, ctxData.recentAlerts)
    .map(c => ({ job_title: c.job_title, company: c.company }));
  const engagementTrends = computeOpportunityEngagementTrends(ctxData.existingCandidates.map(c => ({ industry: null, companySizeEstimate: null, tier: c.alert_tier, lifecycle_status: c.lifecycle_status })));
  const discoveryCoverage = computeDiscoveryCoverage(ctxData.existingCandidates.map(c => ({ lifecycle_status: c.lifecycle_status, alert_tier: c.alert_tier })));

  // Application Outcome Intelligence owns `applications` and the concept of
  // a "positive outcome" (patternEngine.js's own isPositiveOutcome/
  // hasResponse) -- Timing Intelligence reuses that same eligibility
  // definition inside marketSignals.js's computeApplicationWindowStats,
  // never redefining what counts as a response independently.
  const applicationWindowStats = computeApplicationWindowStats(ctxData.applications);
  const personalOutcomeTiming = computePersonalOutcomeTiming(ctxData.applications);
  const seasonalPattern = computeSeasonalPattern({});

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  if (!allowed) return { userId, ranAnalysis: false, reason: "quota_exhausted" };

  const built = buildWeeklyAnalysesPrompt({
    curatedCandidates: diversityResult.included, balanceResult, volumeTrend, salarySignal, hiringFreeze, speedOfFill,
    trustScore, missedOpportunities, engagementTrends, discoveryCoverage,
    applicationWindowStats, personalOutcomeTiming, seasonalPattern,
    availability: computeWeeklyAvailability({ curatedCandidates: diversityResult.included, volumeTrend, discoveryCoverage, personalOutcomeTiming }),
  });
  if (!built) return { userId, ranAnalysis: false, reason: "nothing_available" };

  const { text, usage } = await callClaudeServerSide(built.prompt, 2200, env);
  const analyses = text ? parseWeeklyAnalysesResponse(text, built) : null;
  if (usage) await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage.input_tokens, usage.output_tokens, env);
  if (analyses) {
    // Same evidence-pairing discipline as the other two cadences: each
    // section's own deterministic input travels alongside its AI text, keyed
    // to match the section it explains, so the UI never has to trust an AI
    // finding without its cited facts alongside it.
    const basedOn = {
      marketIntelligence: analyses.marketIntelligence ? { volumeTrend, salarySignal, hiringFreeze, speedOfFill } : undefined,
      alertEffectiveness: analyses.alertEffectiveness ? { trustScore, discoveryCoverage, missedOpportunities, engagementTrends } : undefined,
      timingIntelligence: analyses.timingIntelligence ? { applicationWindowStats, personalOutcomeTiming, seasonalPattern } : undefined,
    };
    await supabasePost("market_signals", [{ user_id: userId, signal_type: "weekly_analysis", scope: "user_specific", value: { ...analyses, basedOn } }], env);
  }
  // Curated pipeline candidates already exist as alert_candidates rows (from
  // an earlier Critical-cadence run) -- only their alerts row + lifecycle
  // transition needs writing here, using the AI's own narrated subset as the
  // source of truth for what was actually delivered (never the full
  // pre-narrative set, in case parsing returned a partial result).
  if (analyses?.curatedPipeline?.length) {
    const deliverCandidates = analyses.curatedPipeline.map(p => p.candidate);
    const explanationsByJobId = new Map(
      analyses.curatedPipeline.map(p => [p.candidate.job.id, { whyThisWeek: p.whyThisWeek, basedOn: { tier: p.candidate.tier, matchScore: p.candidate.matchScore, isStretch: p.candidate.isStretch, industry: p.candidate.industry } }])
    );
    await markAlertsDelivered(userId, deliverCandidates, ctxData.existingCandidates, "weekly_curated", env, explanationsByJobId);
  }
  if (trustScore.needsSelfCorrection) {
    await supabaseUpsert("alert_learning_weights", [{ user_id: userId, weight_type: "confidence_floor", category: "global", weight_value: 1, data_points: trustScore.totalAlerts }], "user_id,weight_type,category", env);
  }
  return { userId, ranAnalysis: !!analyses };
}

// ── Scheduler: dispatch + time-budget-guarded user loop ─────────────────────
// The only thing this function decides is timing/ordering across users --
// zero business logic. A user is skipped only for eligibility (premium) or
// wall-clock budget, never for a Discovery Engine or AI Layer reason (those
// decisions happen inside the cadence functions above, called unchanged).
async function runProactiveJobAlertsSchedule(cronExpr, env) {
  const startedAt = Date.now();
  const userIds = await getPremiumUserIds(env);
  const runner =
    cronExpr === "0 */6 * * *" ? runCriticalOpportunityCadence :
    cronExpr === "0 */12 * * *" ? runWatchlistActivityCadence :
    cronExpr === "0 6 * * 1" ? runWeeklyCadence : null;
  if (!runner) {
    console.error("[proactiveAlerts] Unrecognized cron expression", cronExpr);
    return;
  }
  let processed = 0;
  for (const userId of userIds) {
    if (Date.now() - startedAt > PROACTIVE_ALERTS_TIME_BUDGET_MS) {
      console.log(`[proactiveAlerts] Time budget reached after ${processed}/${userIds.length} users; remainder rolls to the next scheduled run.`);
      break;
    }
    try {
      await runner(userId, env);
      processed++;
    } catch (e) {
      console.error("[proactiveAlerts] user_processing_error", cronExpr, userId, e.message);
    }
  }
  console.log(`[proactiveAlerts] Cadence "${cronExpr}" processed ${processed}/${userIds.length} eligible users.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART APPLY AUTO PREP -- Premium Feature #5. Cron schedule (see
// wrangler.toml): "0 13 * * *" (once daily).
//
// Per the locked blueprint's §2 Ownership table, this section owns exactly
// one thing: automatic selection, budget enforcement, and queue placement.
// Everything else is reused, unmodified, from an existing single-owner
// module:
//   - Job discovery            -> src/lib/platform/jobDiscoveryService.js
//     (fetchFreshPostings, already imported above)
//   - Qualification/scoring    -> Career Compatibility Engine
//     (buildCompatibilityRecord, already imported above)
//   - Ranking/qualification    -> src/lib/smartApplyAutoPrep/selection.js
//     (isJobQualifiedForAutoPrep is applied internally by selectJobsForAutoPrep)
//   - Package generation/validation -> src/lib/smartApply/generation.js,
//     the exact same functions manual Smart Apply calls (App.jsx)
//   - Claude execution         -> callClaudeServerSide, already defined above
//     for Proactive Job Alerts' AI Layer -- reused as-is, its second caller
// ═══════════════════════════════════════════════════════════════════════════

const SMART_APPLY_AUTO_PREP_RESULTS_PAGE = 1;
const SMART_APPLY_AUTO_PREP_MONTHLY_CAP = 20; // §6: fixed, never scaled by the daily setting
const SMART_APPLY_AUTO_PREP_FEATURE_KEY = "smart_apply_auto_prep";
const SMART_APPLY_AUTO_PREP_TIME_BUDGET_MS = 20_000; // same headroom rationale as PROACTIVE_ALERTS_TIME_BUDGET_MS

// Mirrors src/data/profile.js's fetchProfile merge exactly (same field
// names, same base/details precedence, only the subset buildSmartApplyPrompt/
// buildCompatibilityRecord/validateSmartApplyPackage actually read). Not a
// shared import -- that module uses the browser's RLS-scoped Supabase client,
// which has no server-cron equivalent; this reimplements the same flat shape
// service-role, same discipline as the persistence functions below.
async function fetchProfileForAutoPrep(userId, env) {
  const [baseRows, detailRows] = await Promise.all([
    supabaseGet("profiles", { select: "*", id: `eq.${userId}` }, env),
    supabaseGet("profile_details", { select: "*", user_id: `eq.${userId}` }, env),
  ]);
  const base = baseRows[0] || {};
  const details = detailRows[0] || {};
  return {
    full_name: base.full_name || "",
    email_address: details.email_address || "",
    phone: base.phone || "",
    country: base.country || "",
    location: base.location || "",
    preferred_job_title: details.preferred_job_title || base.job_title || "",
    work_type: details.work_type || "",
    desired_salary: details.desired_salary || "",
  };
}

// Locked decision: skip users with no explicit default resume set -- no
// most-recently-analyzed fallback. Automatic preparation only ever acts on a
// resume the user explicitly chose, since there is no browser-side
// activeResumeId for a server cron to read (that value is pure client React
// state, never persisted -- confirmed by reading App.jsx directly).
async function fetchDefaultResumeForUser(userId, env) {
  const rows = await supabaseGet("user_resumes", { select: "id,content", user_id: `eq.${userId}`, is_default: "eq.true", limit: "1" }, env);
  return rows[0] || null;
}

// Mirrors src/data/skillSynonyms.js's loadSkillSynonyms shape exactly (same
// { alias: canonical } object) -- service-role instead of RLS, fetched once
// per cadence run (not per user), since it's small, read-only reference data.
async function fetchSkillDictionary(env) {
  const rows = await supabaseGet("skill_synonyms", { select: "alias,canonical" }, env);
  return Object.fromEntries((rows || []).map(r => [r.alias, r.canonical]));
}

// Atomic dual-cap budget check: daily leg (the user's stored Daily
// Preparation Setting) and monthly leg (§6's fixed 20). Each leg is its own
// independent check_and_consume_quota counter (keyed by user_id+feature+
// period -- see that RPC's own definition), combined by aiBudget.js's pure
// combineBudgetResults.
//
// Known, accepted limitation: the two legs are not one atomic transaction.
// If one leg allows but the other then denies, the allowed leg's counter is
// still incremented for a job that won't be prepared. Only possible on the
// exact day/month a user sits at the boundary of one cap while exhausting
// the other -- self-corrects at the next period rollover, not a correctness
// problem for the fixed, small caps this feature uses (§6). Not worth a
// two-phase commit for a 1-2/day cap.
async function checkAndConsumeAutomationBudget({ userId, featureKey, dailyCap, monthlyCap, env }) {
  const [dailyResult, monthlyResult] = await Promise.all([
    supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: `${featureKey}_daily`, p_limit: dailyCap, p_period: getDailyPeriodKey() }, env),
    supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: `${featureKey}_monthly`, p_limit: monthlyCap, p_period: getMonthlyPeriodKey() }, env),
  ]);
  return combineBudgetResults(dailyResult, monthlyResult);
}

// Persistence -- mirrors src/data/smartApply.js's enqueue/markReady/
// markNeedsReview/markFailed status semantics exactly (same non-terminal-row
// dedup rule in enqueueAutoPrepRow, same status vocabulary), necessarily
// reimplemented service-role since that module is a React hook bound to a
// browser session and a client-local orphan-recovery Set with no server-cron
// equivalent (a cron invocation either finishes a row or marks it failed in
// the same pass -- there is no "orphaned by a closed tab" case to recover
// from).
async function enqueueAutoPrepRow(userId, job, resumeId, env) {
  const rows = await supabaseGet("smart_apply_queue", { select: "*", user_id: `eq.${userId}`, job_id: `eq.${job.id}`, order: "created_at.desc" }, env);
  const existing = (rows || []).find(r => !["applied", "skipped"].includes(r.status));
  if (existing) return null; // §8: existing dedup rule, unchanged -- any non-terminal row skips automatic preparation for this job
  try {
    const inserted = await supabasePost("smart_apply_queue", {
      user_id: userId, job_id: job.id, job_title: job.title, company: job.company,
      job_description: (job.description || "").slice(0, 1200), resume_id: resumeId || null,
      status: "queued", generation_source: "automatic",
    }, env);
    return inserted[0];
  } catch (e) {
    // smart_apply_queue_active_job_uidx (2026-08-06) makes the dedup rule a DB-level
    // invariant -- closes the read-then-write race this SELECT-then-INSERT pair would
    // otherwise have under a redelivered/duplicate cron invocation. A 409 here means a
    // concurrent caller (this same race, or a manual Smart Apply click) won it first --
    // treat exactly like the existing-row case above, not a real failure.
    if (e.status === 409) return null;
    throw e;
  }
}

async function markAutoPrepResult(id, aiResult, ok, env) {
  await supabasePatch("smart_apply_queue", { id: `eq.${id}` }, {
    tailored_resume: aiResult.tailoredResume || null,
    cover_letter: aiResult.coverLetter || null,
    recruiter_message: aiResult.recruiterMessage || null,
    networking_message: aiResult.networkingMessage || null,
    missing_skills: aiResult.missingSkills || null,
    interview_probability: aiResult.interviewProbability ?? null,
    hiring_probability: aiResult.hiringProbability ?? null,
    application_questions: aiResult.applicationQuestions || null,
    salary_insight: aiResult.salaryInsight || null,
    company_insight: aiResult.companyInsight || null,
    status: ok ? "ready" : "needs_review",
  }, env);
}

// §9: technical generation failure -> "Ready for Manual Preparation",
// generalizing the existing markFailed path manual generation already uses
// -- same "failed" status, no second failure vocabulary. retry_count starts
// at 1 unconditionally since this row was created moments earlier in this
// same cadence run (never a pre-existing row with prior failures).
async function markAutoPrepFailed(id, env) {
  await supabasePatch("smart_apply_queue", { id: `eq.${id}` }, { status: "failed", retry_count: 1 }, env);
}

// ── Per-user orchestration ───────────────────────────────────────────────
async function runSmartApplyAutoPrepForUser(userId, skillDictionary, env) {
  const preferenceRows = await supabaseGet("automation_preferences", { select: "value", user_id: `eq.${userId}`, feature_key: `eq.${SMART_APPLY_AUTO_PREP_FEATURE_KEY}` }, env);
  const dailyCap = preferenceRows[0]?.value || 0;
  if (dailyCap <= 0) return { userId, prepared: 0, reason: "automation_off" };

  const resume = await fetchDefaultResumeForUser(userId, env);
  if (!resume?.content?.trim()) return { userId, prepared: 0, reason: "no_default_resume" };

  const profile = await fetchProfileForAutoPrep(userId, env);
  if (!profile.preferred_job_title) return { userId, prepared: 0, reason: "no_preferred_job_title" };

  const rawPostings = await fetchFreshPostings(profile, env, SMART_APPLY_AUTO_PREP_RESULTS_PAGE);
  const postings = deduplicate(rawPostings);
  const resumeSkills = extractSkillKeywords(resume.content);

  const entries = postings.map(job => ({ job, compatibility: buildCompatibilityRecord({ job, profile, resumeSkills, skillDictionary }) }));
  // §4: an unbounded budget here on purpose -- this only establishes
  // qualification + rank order. The real budget gate is enforced per-job
  // below via checkAndConsumeAutomationBudget, atomically, immediately
  // before each preparation.
  const ranked = selectJobsForAutoPrep(entries, entries.length);

  let prepared = 0;
  for (const entry of ranked) {
    const budget = await checkAndConsumeAutomationBudget({
      userId, featureKey: SMART_APPLY_AUTO_PREP_FEATURE_KEY, dailyCap, monthlyCap: SMART_APPLY_AUTO_PREP_MONTHLY_CAP, env,
    });
    if (!budget.allowed) break; // §9: Cost Boundary reached -- remaining qualifying jobs stay untouched, available for manual Smart Apply

    const queued = await enqueueAutoPrepRow(userId, entry.job, resume.id, env);
    if (!queued) continue; // §8: already has a non-terminal row -- skip without spending generation

    try {
      // No browser UserContext session exists to build a ctx block from --
      // buildSmartApplyPrompt already degrades gracefully with an empty one.
      const prompt = buildSmartApplyPrompt("", resume.content, entry.job, profile);
      const { text } = await callClaudeServerSide(prompt, 8000, env);
      if (!text) throw new Error("empty_claude_response");
      const braceStart = text.indexOf("{"), braceEnd = text.lastIndexOf("}");
      const clean = (braceStart >= 0 && braceEnd > braceStart) ? text.slice(braceStart, braceEnd + 1) : text;
      const result = JSON.parse(clean);
      const integrity = validateSmartApplyPackage(result, profile.country || undefined);
      await markAutoPrepResult(queued.id, result, integrity.ok, env);
      prepared++;
    } catch (e) {
      console.error("[smartApplyAutoPrep] generation_error", userId, entry.job.id, e.message);
      await markAutoPrepFailed(queued.id, env);
    }
  }
  return { userId, prepared };
}

// ── Scheduler: same premium-eligibility gate + time-budget-guarded loop
// pattern already established by runProactiveJobAlertsSchedule above ───────
async function runSmartApplyAutoPrepSchedule(env) {
  const startedAt = Date.now();
  const userIds = await getPremiumUserIds(env);
  const skillDictionary = await fetchSkillDictionary(env);
  let processed = 0, totalPrepared = 0;
  for (const userId of userIds) {
    if (Date.now() - startedAt > SMART_APPLY_AUTO_PREP_TIME_BUDGET_MS) {
      console.log(`[smartApplyAutoPrep] Time budget reached after ${processed}/${userIds.length} users; remainder rolls to tomorrow's run.`);
      break;
    }
    try {
      const result = await runSmartApplyAutoPrepForUser(userId, skillDictionary, env);
      totalPrepared += result.prepared || 0;
      processed++;
    } catch (e) {
      console.error("[smartApplyAutoPrep] user_processing_error", userId, e.message);
    }
  }
  console.log(`[smartApplyAutoPrep] Processed ${processed}/${userIds.length} eligible users, prepared ${totalPrepared} packages.`);
}

// ── Account Deletion Purge (Phase 7, Part A) ──────────────────────────────────
// Every table found to hold personal data in the Phase 7 schema cross-check,
// keyed by its own `user_id` column. `assistant_messages` is deliberately
// omitted: it has no user_id column of its own and is guaranteed to cascade
// (a real DB-level ON DELETE CASCADE FK) when its parent
// assistant_conversations row is deleted below -- the one table in this list
// that's safe to rely on a cascade for. `profiles` itself is handled
// separately, last, since every other table's user_id references it.
const ACCOUNT_DELETION_TABLES = [
  "activity_log", "ai_action_plans", "ai_briefings", "ai_request_log",
  "alert_candidates", "alert_learning_weights", "alerts", "applications",
  "assistant_conversations", "automation_preferences", "career_progress_analysis",
  "company_watchlist", "feature_usage", "interview_sessions", "job_intelligence_analysis",
  "job_matches", "job_watchlist", "linkedin_profile_analyses", "market_signals",
  "networking_contacts", "networking_sessions", "notifications", "opportunity_snapshots",
  "outcome_analyses", "outcome_patterns", "profile_details", "recommendation_evaluations",
  "referral_analyses", "resume_analysis_history", "salary_offers", "salary_research",
  "saved_jobs", "smart_apply_queue", "stripe_events", "subscriptions",
  "subscriptions_legacy", "usage_daily_summary", "user_resumes",
];

// Deletes every Storage object for this user's uploaded resume files (not
// just the DB rows referencing them). Uploaded resume files are required
// user data like any table row -- a failure here must throw (not just log)
// so deletion_status is never marked "completed" while a file is still
// sitting in Storage. Safe to resume: re-querying user_resumes for file_url
// paths and re-issuing the same bulk delete is a no-op for anything already
// removed (Supabase Storage's bulk delete does not error on missing paths).
async function purgeResumeFiles(userId, env) {
  const rows = await supabaseGet("user_resumes", { user_id: `eq.${userId}`, select: "file_url" }, env);
  const paths = (rows || []).map(r => r.file_url).filter(Boolean);
  if (!paths.length) return;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/resumes`, {
    method: "DELETE",
    headers: sbHeaders(env),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!r.ok) throw new Error(`storage_purge_failed_${r.status}`);
}

// Deletes the Supabase Auth user via the Admin API. Treats "already gone"
// (404) as success -- makes this step idempotent across resumed runs.
async function purgeAuthUser(userId, env) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: sbHeaders(env),
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`auth_user_delete_${r.status}`);
  }
}

// Strict variant of invalidateSubscription (defined earlier, near the KV
// cache helpers) for the purge only: that function is deliberately
// best-effort/non-fatal for its other callers (handleCancelSubscription,
// handleChangePlan, etc.) where a stale KV entry just self-heals via TTL.
// The purge needs the opposite guarantee -- KV invalidation is one of the
// five required stages, so a failure here must throw, not log and move on.
async function purgeSubscriptionCache(userId, env) {
  await env.SUBSCRIPTION_CACHE.delete(`sub:${userId}`);
}

// Full purge for one user, in the required order: Storage -> 38 tables ->
// Auth user -> profiles -> KV. "completed" is written to account_deletion_log
// -- never to profiles, which is already gone by the time every stage has
// succeeded -- and only as the very last statement, after all five stages
// have each individually succeeded (every helper here throws on real
// failure; nothing swallows an error that should block completion). Every
// step is independently idempotent (deleting zero matching rows twice, an
// already-gone Auth user, or an already-deleted profiles row, is a no-op),
// so a crash anywhere is always safe to resume on the next cron run.
async function purgeUserAccount(userId, env) {
  await purgeResumeFiles(userId, env);
  for (const table of ACCOUNT_DELETION_TABLES) {
    await supabaseDelete(table, { user_id: `eq.${userId}` }, env);
  }
  await purgeAuthUser(userId, env);
  await supabaseDelete("profiles", { id: `eq.${userId}` }, env);
  await purgeSubscriptionCache(userId, env);
  // Single atomic UPDATE -- not a DELETE+INSERT -- so the record is never
  // absent between "identifiable" and "anonymized". crypto.randomUUID() is
  // freshly generated here with no mathematical or deterministic
  // relationship to userId (not a hash of it, not derived from it in any
  // way); user_id is nulled in the same statement that sets it, so a reader
  // (including a crashed-and-resumed run of this same function) only ever
  // sees either the pre-anonymization row (user_id present, status
  // in_progress) or the fully anonymized one (user_id null, status
  // completed) -- never a state in between.
  await supabasePatch("account_deletion_log", { user_id: `eq.${userId}` }, {
    user_id: null,
    deletion_event_id: crypto.randomUUID(),
    status: "completed",
    completed_at: new Date().toISOString(),
  }, env);
}

// 12-month retention cleanup for anonymized deletion records. Runs inside
// the same daily purge schedule (0 3 * * *) rather than a separate cron --
// reusing the existing scheduled infrastructure instead of standing up a
// second scheduler for what is, functionally, another cleanup pass over the
// same table. Targets only status='completed' rows (anonymized, no user_id
// left to look up) past the retention window; naturally idempotent/resumable
// since a row not reached this run is simply picked up by the next one --
// the qualifying condition (completed_at older than 12 months) only becomes
// more true over time, never less.
//
// The 12-month window is an operational product decision for now, not a
// legal conclusion -- it requires legal review before being reflected in any
// published Privacy Policy / retention policy.
async function cleanupExpiredDeletionLogs(env) {
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const expired = await supabaseGet("account_deletion_log", {
    select: "id",
    status: "eq.completed",
    completed_at: `lte.${cutoff}`,
  }, env);
  let removed = 0;
  for (const row of expired || []) {
    try {
      await supabaseDelete("account_deletion_log", { id: `eq.${row.id}` }, env);
      removed++;
    } catch (e) {
      console.error("[accountDeletion] retention_cleanup_error", row.id, e.message);
    }
  }
  console.log(`[accountDeletion] Removed ${removed}/${(expired || []).length} expired anonymized deletion records.`);
}

// Scheduler: drives entirely off account_deletion_log, not profiles --
// profiles is deleted partway through purgeUserAccount, so it cannot be what
// determines whether a purge is still outstanding. Finds every account whose
// grace period has arrived (or whose purge was already started and needs
// resuming after a prior partial failure) and purges each independently --
// one user's failure never blocks another's, matching the per-user
// try/catch pattern already established by
// runSmartApplyAutoPrepSchedule/runProactiveJobAlertsSchedule above.
async function runAccountDeletionPurgeSchedule(env) {
  const candidates = await supabaseGet("account_deletion_log", {
    select: "user_id,status,scheduled_purge_at",
    status: "in.(scheduled,in_progress)",
  }, env);
  const now = Date.now();
  const due = (candidates || []).filter(c =>
    c.status === "in_progress" || new Date(c.scheduled_purge_at).getTime() <= now
  );
  let purged = 0;
  for (const c of due) {
    try {
      if (c.status === "scheduled") {
        await supabasePatch("account_deletion_log", { user_id: `eq.${c.user_id}` }, { status: "in_progress" }, env);
        await supabasePatch("profiles", { id: `eq.${c.user_id}` }, { deletion_status: "in_progress" }, env);
      }
      await purgeUserAccount(c.user_id, env);
      purged++;
    } catch (e) {
      console.error("[accountDeletion] purge_error", c.user_id, e.message);
    }
  }
  console.log(`[accountDeletion] Purged ${purged}/${due.length} due accounts.`);

  // Same daily run also sweeps expired anonymized records -- see
  // cleanupExpiredDeletionLogs' own header for why this isn't a separate cron.
  await cleanupExpiredDeletionLogs(env);
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
        if (path === "/api/billing/checkout-session") return handleCheckoutSession(request, env);
        if (path === "/api/billing/confirm-session") return handleConfirmSession(request, env);
        if (path === "/api/billing/cancel")          return handleCancelSubscription(request, env);
        if (path === "/api/billing/resume")          return handleResumeSubscription(request, env);
        if (path === "/api/billing/change-plan")     return handleChangePlan(request, env);
        if (path === "/api/billing/portal-session")  return handlePortalSession(request, env);
        if (path === "/api/account/request-deletion") return handleRequestAccountDeletion(request, env);
        if (path === "/api/account/cancel-deletion")  return handleCancelAccountDeletion(request, env);
        if (path === "/webhooks/stripe")             return handleStripeWebhook(request, env);
        return handleClaude(request, env, ctx); // POST / — Claude proxy (catch-all)
      }

      return corsResponse(request, { error: "not_found" }, 404);
    } catch (e) {
      console.error("worker_error", e.message);
      return corsResponse(request, { error: "internal_error" }, 500);
    }
  },

  // Scheduler entry point (Cron Triggers, see wrangler.toml). event.cron
  // identifies which of the 4 registered schedules fired; ctx.waitUntil keeps
  // the invocation alive until the full user loop (bounded by
  // PROACTIVE_ALERTS_TIME_BUDGET_MS) finishes.
  async scheduled(event, env, ctx) {
    if (event.cron === "0 13 * * *") {
      ctx.waitUntil(
        runSmartApplyAutoPrepSchedule(env).catch(e => console.error("[smartApplyAutoPrep] schedule_error", e.message))
      );
      return;
    }
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(
        runAccountDeletionPurgeSchedule(env).catch(e => console.error("[accountDeletion] schedule_error", e.message))
      );
      return;
    }
    ctx.waitUntil(
      runProactiveJobAlertsSchedule(event.cron, env).catch(e => console.error("[proactiveAlerts] schedule_error", event.cron, e.message))
    );
  },
};
